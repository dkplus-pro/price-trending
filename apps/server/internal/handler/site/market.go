// 本文件:行情转发端点(GET /api/site/market/*)——薄层:解析并校验 query → 调 service → 统一响应。
// 上游访问、URL 白名单拼装与 TTL 缓存在 service(见 internal/service/market.go);
// 查询接口不埋 oplog(AGENTS.md §5),HTTP 访问日志由既有中间件覆盖。
// 匿名公开只读;响应带 Cache-Control 供网关/CDN 短缓存(与服务端缓存 TTL 对齐)。
package site

import (
	"encoding/json"
	"errors"
	"net/http"

	sitegen "github.com/cms-template/server/gen/site"
	"github.com/cms-template/server/internal/httpapi"
	"github.com/cms-template/server/internal/service"
)

// marketUpstreamMessage 上游失败的固定客户端文案(前端据此提示「行情上游暂时不可用」;
// 上游状态码/错误摘要只进日志,不透给客户端)。
const marketUpstreamMessage = "行情上游暂时不可用,请稍后重试"

// writeMarketPayload 统一出口:上游失败哨兵 → 502 + 固定文案(warn 一条带 kind 与错误摘要),
// 其余内部错误 → 500;成功原样透传上游 JSON(json.RawMessage 不解构)并带 CDN 缓存头。
func (h *SiteHandler) writeMarketPayload(w http.ResponseWriter, kind string, body []byte, err error, cacheControl string) {
	if err != nil {
		if errors.Is(err, service.ErrMarketUpstreamUnavailable) {
			h.logger.Warn("market upstream failed", "kind", kind, "error", err)
			httpapi.WriteError(w, http.StatusBadGateway, marketUpstreamMessage)
			return
		}
		h.logger.Error("market query failed", "kind", kind, "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "internal server error")
		return
	}
	w.Header().Set("Cache-Control", cacheControl)
	httpapi.WriteJSON(w, http.StatusOK, json.RawMessage(body))
}

// GetMarketQuote GET /api/site/market/quote:行情快照批量查询。
func (h *SiteHandler) GetMarketQuote(w http.ResponseWriter, r *http.Request, params sitegen.GetMarketQuoteParams) {
	secids, ok := service.ParseMarketSecids(params.Secids)
	if !ok {
		httpapi.WriteError(w, http.StatusBadRequest, "secids 需为逗号分隔的 市场号.代码(如 1.000001,118.AU9999)")
		return
	}

	body, err := h.market.Quote(r.Context(), service.MarketQuoteParams{Secids: secids})
	h.writeMarketPayload(w, "quote", body, err, "public, max-age=15")
}

// GetMarketKline GET /api/site/market/kline:K 线查询(可选参数缺省值见 service 常量)。
func (h *SiteHandler) GetMarketKline(w http.ResponseWriter, r *http.Request, params sitegen.GetMarketKlineParams) {
	p, msg := parseMarketKlineParams(params)
	if msg != "" {
		httpapi.WriteError(w, http.StatusBadRequest, msg)
		return
	}

	body, err := h.market.Kline(r.Context(), p)
	h.writeMarketPayload(w, "kline", body, err, "public, max-age=60")
}

// parseMarketKlineParams 解析并校验 K 线 query(缺省值与契约描述一致);msg 非空即校验失败文案。
func parseMarketKlineParams(params sitegen.GetMarketKlineParams) (service.MarketKlineParams, string) {
	secid, ok := service.ParseMarketSecid(params.Secid)
	if !ok {
		return service.MarketKlineParams{}, "secid 需为 市场号.代码(如 1.000001)"
	}

	p := service.MarketKlineParams{
		Secid: secid,
		Klt:   service.MarketDefaultKlt,
		Fqt:   service.MarketDefaultFqt,
		Beg:   service.MarketDefaultBeg,
		End:   service.MarketDefaultEnd,
		Lmt:   service.MarketDefaultLmt,
	}
	if params.Klt != nil {
		if !service.ValidMarketKlt(int(*params.Klt)) {
			return service.MarketKlineParams{}, "klt 仅支持 101/102/103"
		}
		p.Klt = int(*params.Klt)
	}
	if params.Fqt != nil {
		if !service.ValidMarketFqt(int(*params.Fqt)) {
			return service.MarketKlineParams{}, "fqt 仅支持 0/1"
		}
		p.Fqt = int(*params.Fqt)
	}
	if params.Lmt != nil {
		if !service.ValidMarketLmt(*params.Lmt) {
			return service.MarketKlineParams{}, "lmt 需在 1..2000 内"
		}
		p.Lmt = *params.Lmt
	}
	if params.Beg != nil && *params.Beg != "" {
		if !service.ValidMarketDate(*params.Beg) {
			return service.MarketKlineParams{}, "beg 需为 YYYYMMDD"
		}
		p.Beg = *params.Beg
	}
	if params.End != nil && *params.End != "" {
		if !service.ValidMarketDate(*params.End) {
			return service.MarketKlineParams{}, "end 需为 YYYYMMDD"
		}
		p.End = *params.End
	}
	return p, ""
}

// GetMarketTrends GET /api/site/market/trends:分时/五日走势。
func (h *SiteHandler) GetMarketTrends(w http.ResponseWriter, r *http.Request, params sitegen.GetMarketTrendsParams) {
	secid, ok := service.ParseMarketSecid(params.Secid)
	if !ok {
		httpapi.WriteError(w, http.StatusBadRequest, "secid 需为 市场号.代码(如 1.000001)")
		return
	}
	ndays := service.MarketDefaultNdays
	if params.Ndays != nil {
		if !service.ValidMarketNdays(int(*params.Ndays)) {
			httpapi.WriteError(w, http.StatusBadRequest, "ndays 仅支持 1/5")
			return
		}
		ndays = int(*params.Ndays)
	}

	body, err := h.market.Trends(r.Context(), service.MarketTrendsParams{Secid: secid, Ndays: ndays})
	h.writeMarketPayload(w, "trends", body, err, "public, max-age=60")
}

// GetMarketSgeDaily GET /api/site/market/sge-daily:上金所日线(黄金现货合约权威源,仅日 K 无量额)。
func (h *SiteHandler) GetMarketSgeDaily(w http.ResponseWriter, r *http.Request, params sitegen.GetMarketSgeDailyParams) {
	instid, ok := service.ParseMarketSGEInstID(params.Instid)
	if !ok {
		httpapi.WriteError(w, http.StatusBadRequest, "instid 需为上金所 Au 合约代码(如 Au99.99)")
		return
	}

	body, err := h.market.SGEDaily(r.Context(), instid)
	h.writeMarketPayload(w, "sge-daily", body, err, "public, max-age=300")
}
