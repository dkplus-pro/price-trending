// Package service 承载业务规则。本文件:行情转发(服务端代理东方财富行情接口,GET 查询不埋 oplog)。
//
// 背景诊断(行情页浏览器直连东财行情 API push2/push2his):东财 WAF 对出口 IP 做配额型限流——
// TCP/TLS 正常、HTTP 请求发出后服务端直接断开(Empty reply/EOF,无状态码);同 IP 东财主站
// 200 正常、腾讯/gold-api 正常;配额窗口内偶发单次成功。服务端转发把「每个访客各自直连」
// 收敛为「服务器单点低频请求 + 内存 TTL 缓存」,在干净出口 IP 的部署环境可用。配套手段:
//   - 请求头带浏览器 UA + Referer(https://quote.eastmoney.com/,WAF 对无浏览器特征的请求更严);
//   - 上游 URL 一律由白名单参数在服务端拼装,绝不透传外部传入的 URL/域名(防 SSRF);
//   - 以完整上游 URL 为 key 的 TTL 缓存(quote 15s,kline/trends 60s),命中不打上游;
//   - 上游响应体原样透传(不解构),仅校验「非空且为 JSON 对象」后整包返回。
package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// 上游访问参数与预算(诊断结论 + 东财 web 页面公开用法)。
const (
	// MarketUpstreamTimeout 上游请求超时:WAF 限流表现为请求挂起后被断开,10s 足够判失败。
	MarketUpstreamTimeout = 10 * time.Second
	// MarketQuoteTTL 快照缓存:盘中实时数据,短缓存。
	MarketQuoteTTL = 15 * time.Second
	// MarketHistoryTTL K 线/分时缓存:同一请求在分钟级内重复率高,长缓存。
	MarketHistoryTTL = 60 * time.Second
	// MarketCacheMaxEntries 缓存条目上限,超出淘汰最早过期条目,防长驻进程内存膨胀。
	MarketCacheMaxEntries = 512
	// MarketBodyLimit 上游响应体读取上限,防上游异常大响应拖垮内存(全量 A 股快照亦远小于此)。
	MarketBodyLimit = 4 << 20 // 4MiB

	// marketUserAgent / marketReferer 浏览器特征头:WAF 对无浏览器特征的请求更严
	// (诊断依据:同 IP 带浏览器特征的主站请求 200,行情接口则被断连)。
	marketUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
	marketReferer   = "https://quote.eastmoney.com/"
	// marketPublicUT 东财 web 页面通用的公开 ut 参数(非密钥,页面源码可见),带上以贴近浏览器请求特征。
	marketPublicUT = "fa5fd1943c7b386f172d6893dbfba10b"

	// K 线/分时缺省参数(契约中 klt/fqt/beg/end/lmt/ndays 均可选,缺省值在此收敛,与契约描述一致)。
	MarketDefaultKlt   = 101        // 日线
	MarketDefaultFqt   = 1          // 前复权
	MarketDefaultBeg   = "19700101" // 不限起点
	MarketDefaultEnd   = "20991231" // 不限终点
	MarketDefaultLmt   = 120        // 条数上限
	MarketDefaultNdays = 1          // 分时
)

// 上游基地址默认值(生产);测试经 MarketServiceConfig 注入 httptest 地址。
// 上游另有 1./82. 等编号变体域名,但缓存 key 为完整上游 URL,轮换域名会打散缓存,故固定主域;
// 如需故障转移,后续可按 kind 维护域名池顺序探测(见 AGENTS.md server 章节「先复用再新建」)。
const (
	marketDefaultQuoteBaseURL   = "https://push2.eastmoney.com"
	marketDefaultHistoryBaseURL = "https://push2his.eastmoney.com"
)

// ErrMarketUpstreamUnavailable 行情上游失败哨兵:网络错误/超时、非 200、空响应体、
// 非 JSON 对象体一律转译为该哨兵(handler 映射 502 并输出固定文案,前端据此区分
// 「上游限流/失败」;状态码与错误摘要留在 wrapped error 里只进日志,不透给客户端)。
var ErrMarketUpstreamUnavailable = errors.New("market upstream unavailable")

// MarketServiceConfig 行情转发服务配置:纯值构造(service 禁止 import config,由 main.go 映射),
// base URL / client 可注入以支撑 httptest 假上游;零值即生产默认。
type MarketServiceConfig struct {
	// HTTPClient 上游 HTTP 客户端,nil 时用默认客户端(10s 超时)。
	HTTPClient *http.Client
	// QuoteBaseURL 快照上游基地址,空 → marketDefaultQuoteBaseURL。
	QuoteBaseURL string
	// HistoryBaseURL K 线/分时上游基地址,空 → marketDefaultHistoryBaseURL。
	HistoryBaseURL string
	// SGEDailyBaseURL 上金所日线转发上游基地址,空 → marketDefaultSgeBaseURL(测试注入 httptest 地址)。
	SGEDailyBaseURL string
	// CacheMaxEntries 缓存条目上限,<=0 → MarketCacheMaxEntries(测试注入小值验证淘汰)。
	CacheMaxEntries int
}

// MarketService 行情转发:校验后的参数构造上游 URL → 带浏览器头请求 → 校验响应 → TTL 缓存 → 原样透传。
type MarketService struct {
	client         *http.Client
	quoteBaseURL   string
	historyBaseURL string
	sgeBaseURL     string
	cache          *marketCache
}

// NewMarketService 构造行情转发服务(缺省 10s 超时客户端与默认上游域名)。
func NewMarketService(cfg MarketServiceConfig) *MarketService {
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: MarketUpstreamTimeout}
	}
	quoteBase := cfg.QuoteBaseURL
	if quoteBase == "" {
		quoteBase = marketDefaultQuoteBaseURL
	}
	historyBase := cfg.HistoryBaseURL
	if historyBase == "" {
		historyBase = marketDefaultHistoryBaseURL
	}
	sgeBase := cfg.SGEDailyBaseURL
	if sgeBase == "" {
		sgeBase = marketDefaultSgeBaseURL
	}
	maxEntries := cfg.CacheMaxEntries
	if maxEntries <= 0 {
		maxEntries = MarketCacheMaxEntries
	}
	return &MarketService{
		client:         client,
		quoteBaseURL:   quoteBase,
		historyBaseURL: historyBase,
		sgeBaseURL:     sgeBase,
		cache:          newMarketCache(maxEntries),
	}
}

// marketKind 查询类别(日志区分 quote/kline/trends)。
type marketKind string

const (
	marketKindQuote  marketKind = "quote"
	marketKindKline  marketKind = "kline"
	marketKindTrends marketKind = "trends"
)

// MarketQuoteParams 批量快照查询参数(handler 已按 ParseMarketSecids 校验)。
type MarketQuoteParams struct {
	Secids []string
}

// MarketKlineParams K 线查询参数(取值域与契约 klt/fqt/beg/end/lmt 约束同口径)。
type MarketKlineParams struct {
	Secid string
	Klt   int
	Fqt   int
	Beg   string
	End   string
	Lmt   int
}

// MarketTrendsParams 分时/五日查询参数(ndays 取值域与契约 enum 同口径)。
type MarketTrendsParams struct {
	Secid string
	Ndays int
}

// Quote 批量快照:返回上游原始 JSON 对象体;命中缓存不打上游。
func (s *MarketService) Quote(ctx context.Context, p MarketQuoteParams) ([]byte, error) {
	return s.fetch(ctx, marketKindQuote, s.quoteURL(p), MarketQuoteTTL)
}

// Kline K 线:返回上游原始 JSON 对象体;命中缓存不打上游。
func (s *MarketService) Kline(ctx context.Context, p MarketKlineParams) ([]byte, error) {
	return s.fetch(ctx, marketKindKline, s.klineURL(p), MarketHistoryTTL)
}

// Trends 分时/五日:返回上游原始 JSON 对象体;命中缓存不打上游。
func (s *MarketService) Trends(ctx context.Context, p MarketTrendsParams) ([]byte, error) {
	return s.fetch(ctx, marketKindTrends, s.trendsURL(p), MarketHistoryTTL)
}

// fetch 缓存 → 请求上游 → 校验(非 200/空体/非 JSON 对象)→ 回填缓存。
// 失败一律转译 ErrMarketUpstreamUnavailable;上游细节(状态码/错误摘要)留在 wrapped error
// 里进日志,不透给客户端(handler 只判哨兵,见 apps/server/AGENTS.md §3)。
func (s *MarketService) fetch(ctx context.Context, kind marketKind, target string, ttl time.Duration) ([]byte, error) {
	if body, ok := s.cache.get(target); ok {
		return body, nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %s build request: %w", ErrMarketUpstreamUnavailable, kind, err)
	}
	req.Header.Set("User-Agent", marketUserAgent)
	req.Header.Set("Referer", marketReferer)
	req.Header.Set("Accept", "application/json, text/plain, */*")

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %s request: %w", ErrMarketUpstreamUnavailable, kind, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: %s status %d", ErrMarketUpstreamUnavailable, kind, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, MarketBodyLimit))
	if err != nil {
		return nil, fmt.Errorf("%w: %s read body: %w", ErrMarketUpstreamUnavailable, kind, err)
	}
	if !isJSONObject(body) {
		// 空 body(WAF 断连后读到 EOF 的常见形态)与非 JSON 对象体同判为上游失败。
		return nil, fmt.Errorf("%w: %s body is not a json object (len=%d)", ErrMarketUpstreamUnavailable, kind, len(body))
	}

	s.cache.set(target, body, ttl)
	return body, nil
}

// isJSONObject 判定响应体为非空 JSON 对象(契约 data = 上游原始 JSON 对象,数组/标量不透传)。
func isJSONObject(body []byte) bool {
	trimmed := bytes.TrimSpace(body)
	return len(trimmed) > 0 && trimmed[0] == '{' && json.Valid(trimmed)
}

// marketQuoteFields 快照字段白名单(东财 ulist 常用快照字段:现价/涨跌/涨跌幅/量额/买卖档等固定集合)。
const marketQuoteFields = "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23"

// quoteURL 构造快照上游 URL:仅白名单参数,secids 来自已校验入参,不接受任何外部 URL 片段。
func (s *MarketService) quoteURL(p MarketQuoteParams) string {
	q := url.Values{}
	q.Set("secids", strings.Join(p.Secids, ","))
	q.Set("fields", marketQuoteFields)
	q.Set("fltt", "2") // 浮点格式化
	q.Set("invt", "2")
	q.Set("pn", "1")
	q.Set("pz", strconv.Itoa(len(p.Secids))) // 单页即全量
	q.Set("fid", "f3")
	q.Set("po", "1")
	q.Set("ut", marketPublicUT)
	return s.quoteBaseURL + "/api/qt/ulist.np/get?" + q.Encode()
}

// klineURL 构造 K 线上游 URL:klt/fqt/beg/end/lmt 均为契约约束内取值,fields 固定白名单。
func (s *MarketService) klineURL(p MarketKlineParams) string {
	q := url.Values{}
	q.Set("secid", p.Secid)
	q.Set("klt", strconv.Itoa(p.Klt))
	q.Set("fqt", strconv.Itoa(p.Fqt))
	q.Set("beg", p.Beg)
	q.Set("end", p.End)
	q.Set("lmt", strconv.Itoa(p.Lmt))
	q.Set("fields1", "f1,f2,f3,f4,f5,f6")
	q.Set("fields2", "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61")
	q.Set("ut", marketPublicUT)
	return s.historyBaseURL + "/api/qt/stock/kline/get?" + q.Encode()
}

// trendsURL 构造分时/五日上游 URL。
func (s *MarketService) trendsURL(p MarketTrendsParams) string {
	q := url.Values{}
	q.Set("secid", p.Secid)
	q.Set("ndays", strconv.Itoa(p.Ndays))
	q.Set("iscr", "0")
	q.Set("fields1", "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13")
	q.Set("fields2", "f51,f52,f53,f54,f55,f56,f57,f58")
	q.Set("ut", marketPublicUT)
	return s.historyBaseURL + "/api/qt/stock/trends2/get?" + q.Encode()
}

// marketSecidPattern 证券代码「市场号.代码」:市场号 1~3 位数字,代码 1~16 位字母数字
// (如 1.000001 沪 A、0.000002 深 A、118.AU9999 上金所黄金),与契约 pattern 同口径。
var marketSecidPattern = regexp.MustCompile(`^[0-9]{1,3}\.[A-Za-z0-9]{1,16}$`)

// ParseMarketSecid 校验单个证券代码;非法返回 false(handler 映射 400)。
func ParseMarketSecid(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	return raw, marketSecidPattern.MatchString(raw)
}

// ParseMarketSecids 校验逗号分隔的证券代码列表:逐项合法即通过(空串/空项均非法)。
func ParseMarketSecids(raw string) ([]string, bool) {
	parts := strings.Split(raw, ",")
	secids := make([]string, 0, len(parts))
	for _, part := range parts {
		secid, ok := ParseMarketSecid(part)
		if !ok {
			return nil, false
		}
		secids = append(secids, secid)
	}
	if len(secids) == 0 {
		return nil, false
	}
	return secids, true
}

// ValidMarketKlt K 线周期取值域(与契约 enum 同口径)。
func ValidMarketKlt(v int) bool { return v == 101 || v == 102 || v == 103 }

// ValidMarketFqt 复权方式取值域(与契约 enum 同口径)。
func ValidMarketFqt(v int) bool { return v == 0 || v == 1 }

// ValidMarketNdays 走势天数取值域(与契约 enum 同口径)。
func ValidMarketNdays(v int) bool { return v == 1 || v == 5 }

// ValidMarketLmt 条数上限取值域(与契约 minimum/maximum 同口径)。
func ValidMarketLmt(v int) bool { return v >= 1 && v <= 2000 }

// ValidMarketDate YYYYMMDD 日期串(与契约 pattern 同口径)。
func ValidMarketDate(raw string) bool {
	if len(raw) != 8 {
		return false
	}
	for _, r := range raw {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
