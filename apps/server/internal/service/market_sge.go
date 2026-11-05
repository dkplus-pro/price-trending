// 本文件:行情转发之上金所日线(服务端代理上金所官网 graph/Dailyhq 接口,GET 查询不埋 oplog)。
//
// 背景:黄金 Au99.99 的 K 线此前只有东财一个上游(push2his,本机/部分网络被其 WAF 限流);
// 上金所官网接口是 Au99.99 等黄金现货合约的权威精确源,server 侧可直连(无 WAF 白名单问题)。
// 上游形态(2026-10 实测):POST https://www.sge.com.cn/graph/Dailyhq,form 参数 instid=Au99.99,
// 响应 {"time":[["2016-12-19",262.45,262.76,262.02,263.5],...]}——数组序为 日期,开,收,低,高(低在高之前),
// 升序,仅日 K,无成交量/成交额,无日期过滤参数(全量返回,由调用方截断)。
//
// 坑:错误 instid 也返回 200,但数据行数值全 0——服务端必须校验「解析出的数据行全部 OHLC 为 0」
// 视为上游无效数据,转译 ErrMarketUpstreamUnavailable(否则前端会把 0 值当真实行情画进 K 线)。
// 缓存与东财端点同构:key=完整上游 URL(instid 以 query 形式进 key,与 POST form 请求体解耦),
// TTL 5 分钟(日线数据日内不变,远长于东财端点);其余失败(网络/非 200/空体/非 JSON/全 0)不缓存。
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// 上游访问参数(上金所官网无 WAF 白名单问题,仍带常规浏览器 UA 稳妥)。
const (
	// MarketSGEDailyTTL 上金所日线缓存 TTL:日线收盘后不变,5 分钟远收敛上游请求。
	MarketSGEDailyTTL = 5 * time.Minute
	// marketSGEDailyPath 上金所日线上游路径(固定;基地址可注入以便 httptest)。
	marketSGEDailyPath = "/graph/Dailyhq"
	// marketDefaultSgeBaseURL 上游基地址默认值(生产);测试经 MarketServiceConfig 注入 httptest 地址。
	marketDefaultSgeBaseURL = "https://www.sge.com.cn"
)

// marketSGEKind 错误摘要里的类别标识(handler 日志与 wrapped error 用)。
const marketSGEKind = "sge-daily"

// sgeInstIDPattern 上金所合约代码:保守限定 Au 前缀数字合约(如 Au99.99/Au99.95,与契约 pattern 同口径)。
// 上金所另有 Au(T+D)、Au100g 等命名风格,确有需要再放宽,避免把任意外部串透传进上游表单。
var sgeInstIDPattern = regexp.MustCompile(`^Au[0-9]{2}\.[0-9]{2}$`)

// ParseMarketSGEInstID 校验上金所合约代码;非法返回 false(handler 映射 400)。
func ParseMarketSGEInstID(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	return raw, sgeInstIDPattern.MatchString(raw)
}

// sgeDailyResponse 上游响应体的最小解析形态:仅校验用,透传仍是原始字节。
type sgeDailyResponse struct {
	Time [][]any `json:"time"`
}

// SGEDaily 上金所日线:返回上游原始 JSON 对象体;命中缓存不打上游。
func (s *MarketService) SGEDaily(ctx context.Context, instid string) ([]byte, error) {
	// 缓存 key=完整上游 URL,instid 以 query 形式进 key(复用现有 marketCache 按 key 隔离 TTL 的结构)。
	key := s.sgeBaseURL + marketSGEDailyPath + "?" + url.Values{"instid": {instid}}.Encode()
	if body, ok := s.cache.get(key); ok {
		return body, nil
	}

	body, err := s.fetchSGEDaily(ctx, instid)
	if err != nil {
		return nil, err
	}
	s.cache.set(key, body, MarketSGEDailyTTL)
	return body, nil
}

// fetchSGEDaily 请求上金所上游并校验:POST form(instid)→ 非 200/空体/非 JSON 对象/缺 time 数组/
// 数据行全 0 一律转译 ErrMarketUpstreamUnavailable(细节进 wrapped error 只给日志,不透给客户端)。
func (s *MarketService) fetchSGEDaily(ctx context.Context, instid string) ([]byte, error) {
	form := url.Values{"instid": {instid}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.sgeBaseURL+marketSGEDailyPath, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("%w: %s build request: %w", ErrMarketUpstreamUnavailable, marketSGEKind, err)
	}
	req.Header.Set("User-Agent", marketUserAgent)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json, text/plain, */*")

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %s request: %w", ErrMarketUpstreamUnavailable, marketSGEKind, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: %s status %d", ErrMarketUpstreamUnavailable, marketSGEKind, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, MarketBodyLimit))
	if err != nil {
		return nil, fmt.Errorf("%w: %s read body: %w", ErrMarketUpstreamUnavailable, marketSGEKind, err)
	}
	if !isJSONObject(body) {
		return nil, fmt.Errorf("%w: %s body is not a json object (len=%d)", ErrMarketUpstreamUnavailable, marketSGEKind, len(body))
	}
	if msg := validateSGEDaily(body); msg != "" {
		return nil, fmt.Errorf("%w: %s %s", ErrMarketUpstreamUnavailable, marketSGEKind, msg)
	}
	return body, nil
}

// validateSGEDaily 校验上游数据有效性,空串=有效,否则返回失败摘要:
// time 须为非空数组,且解析出的数据行(≥5 列)不全为 OHLC 0(上金所对错误 instid 返回全 0 行)。
// 零星 0 行混在有效行中不判失败——原样透传由调用方感知,仅「全部为 0」判定上游无效。
func validateSGEDaily(body []byte) string {
	var payload sgeDailyResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return "decode payload: " + err.Error()
	}
	if len(payload.Time) == 0 {
		return "time is empty or missing"
	}
	rows, allZero := 0, true
	for _, row := range payload.Time {
		if len(row) < 5 {
			continue
		}
		rows++
		if !sgeRowOHLCZero(row) {
			allZero = false
		}
	}
	if rows == 0 {
		return "no parseable data rows"
	}
	if allZero {
		return "all data rows are zero (invalid instid?)"
	}
	return ""
}

// sgeRowOHLCZero 判定单个数据行的 OHLC(第 2~5 列)是否全为 0;数值容忍数字或数字串形态,
// 解析不了的取值视为非 0(只针对实测的「全 0 行」失败模式,不因异常形态误判有效数据无效)。
func sgeRowOHLCZero(row []any) bool {
	for _, v := range row[1:5] {
		switch n := v.(type) {
		case float64:
			if n != 0 {
				return false
			}
		case string:
			if f, err := strconv.ParseFloat(strings.TrimSpace(n), 64); err != nil || f != 0 {
				return false
			}
		default:
			return false
		}
	}
	return true
}
