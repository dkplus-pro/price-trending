// market_test.go:行情转发端点测试——参数校验(400 映射)、缺省值、原样透传、上游失败转译(502)。
// 装配与 main.go 同款:sitegen.HandlerFromMux(New(...), mux),假上游经 service 配置注入。
package site

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"sync"
	"testing"

	sitegen "github.com/cms-template/server/gen/site"
	"github.com/cms-template/server/internal/service"
)

// marketFakeUpstream 假上游:记录命中数与最后一次请求(方法/query/POST form),响应可动态改
// (路径/头由 service 测试覆盖)。
type marketFakeUpstream struct {
	mu     sync.Mutex
	hits   int
	method string
	query  url.Values
	form   url.Values
	status int
	body   string
}

func (f *marketFakeUpstream) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hits++
	f.method = r.Method
	f.query = r.URL.Query()
	_ = r.ParseForm() // 上金所日线为 POST form 上游:表单体在 PostForm(GET 请求 PostForm 为空)
	f.form = url.Values{}
	for k, vs := range r.PostForm {
		f.form[k] = append([]string(nil), vs...)
	}
	w.WriteHeader(f.status)
	_, _ = w.Write([]byte(f.body))
}

func (f *marketFakeUpstream) lastRequest() (int, url.Values) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hits, f.query
}

// lastPostForm 读最近一次请求的命中数/方法/POST 表单(上金所日线上游为 POST form)。
func (f *marketFakeUpstream) lastPostForm() (int, string, url.Values) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hits, f.method, f.form
}

func (f *marketFakeUpstream) setUpstream(status int, body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.status, f.body = status, body
}

// marketTestMux 起完整路由:handler(日志丢弃 + 指向假上游的 market service)。
func marketTestMux(t *testing.T) (*http.ServeMux, *marketFakeUpstream) {
	t.Helper()
	up := &marketFakeUpstream{status: http.StatusOK, body: `{"rc":0,"data":{"diff":[]}}`}
	ts := httptest.NewServer(http.HandlerFunc(up.serve))
	t.Cleanup(ts.Close)

	svc := service.NewMarketService(service.MarketServiceConfig{
		HTTPClient:      ts.Client(),
		QuoteBaseURL:    ts.URL,
		HistoryBaseURL:  ts.URL,
		SGEDailyBaseURL: ts.URL,
	})
	mux := http.NewServeMux()
	sitegen.HandlerFromMux(New(slog.New(slog.NewTextHandler(io.Discard, nil)), nil, svc), mux)
	return mux, up
}

// marketGet 执行一次 GET 并返回响应。
func marketGet(t *testing.T, mux *http.ServeMux, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

// decodeMarketEnvelope 解析成功信封:data 为上游原始 JSON 对象。
func decodeMarketEnvelope(t *testing.T, body []byte) (int, map[string]any) {
	t.Helper()
	var envelope struct {
		Code    int            `json:"code"`
		Message string         `json:"message"`
		Data    map[string]any `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("decode response body: %v", err)
	}
	return envelope.Code, envelope.Data
}

// decodeMarketError 解析错误信封。
func decodeMarketError(t *testing.T, body []byte) (int, string) {
	t.Helper()
	var envelope struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return envelope.Code, envelope.Message
}

// TestGetMarketQuotePassthrough 快照:成功透传上游原始 JSON,带与服务端 TTL 对齐的缓存头。
func TestGetMarketQuotePassthrough(t *testing.T) {
	mux, up := marketTestMux(t)
	up.setUpstream(http.StatusOK, `{"rc":0,"data":{"diff":[{"f12":"000001","f14":"平安银行"}]}}`)

	rec := marketGet(t, mux, "/api/site/market/quote?secids=1.000001,118.AU9999")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "public, max-age=15" {
		t.Fatalf("Cache-Control = %q, want public, max-age=15", cc)
	}
	code, data := decodeMarketEnvelope(t, rec.Body.Bytes())
	if code != http.StatusOK {
		t.Fatalf("envelope code = %d, want %d", code, http.StatusOK)
	}
	want := map[string]any{
		"rc":   float64(0),
		"data": map[string]any{"diff": []any{map[string]any{"f12": "000001", "f14": "平安银行"}}},
	}
	if !reflect.DeepEqual(data, want) {
		t.Fatalf("data = %#v, want %#v", data, want)
	}
}

// TestGetMarketQuoteInvalidSecids 非法 secids → 400,且不打上游。
func TestGetMarketQuoteInvalidSecids(t *testing.T) {
	mux, up := marketTestMux(t)
	for name, secids := range map[string]string{
		"trailing comma": "1.000001,",
		"special chars":  "1.00<00>1",
		"space inside":   "1.00 001",
		"no dot":         "1000001",
		"two dots":       "1.0.0001",
		"not secid part": "1.000001,abc",
	} {
		t.Run(name, func(t *testing.T) {
			rec := marketGet(t, mux, "/api/site/market/quote?secids="+url.QueryEscape(secids))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
			}
			code, message := decodeMarketError(t, rec.Body.Bytes())
			if code != http.StatusBadRequest || message == "" {
				t.Fatalf("envelope = %d/%q, want 400 with message", code, message)
			}
		})
	}
	// 空值但参数在场:生成物 required 兜底直接 400(纯文本,无信封)。
	if rec := marketGet(t, mux, "/api/site/market/quote?secids="); rec.Code != http.StatusBadRequest {
		t.Fatalf("empty secids status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if hits, _ := up.lastRequest(); hits != 0 {
		t.Fatalf("upstream hits = %d, want 0 (rejected before upstream)", hits)
	}
}

// TestGetMarketQuoteMissingSecids secids 缺失 → 400(生成物 required query 兜底,纯文本)。
func TestGetMarketQuoteMissingSecids(t *testing.T) {
	mux, _ := marketTestMux(t)
	if rec := marketGet(t, mux, "/api/site/market/quote"); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

// TestGetMarketKlineDefaults K 线:可选参数缺省(101/1/19700101/20991231/120)。
func TestGetMarketKlineDefaults(t *testing.T) {
	mux, up := marketTestMux(t)
	rec := marketGet(t, mux, "/api/site/market/kline?secid=1.000001")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "public, max-age=60" {
		t.Fatalf("Cache-Control = %q, want public, max-age=60", cc)
	}
	_, query := up.lastRequest()
	if query.Get("klt") != "101" || query.Get("fqt") != "1" || query.Get("lmt") != "120" {
		t.Fatalf("klt/fqt/lmt = %s/%s/%s, want defaults 101/1/120", query.Get("klt"), query.Get("fqt"), query.Get("lmt"))
	}
	if query.Get("beg") != "19700101" || query.Get("end") != "20991231" {
		t.Fatalf("beg/end = %s/%s, want defaults", query.Get("beg"), query.Get("end"))
	}
}

// TestGetMarketKlineExplicitParams K 线:显式参数逐一透传上游。
func TestGetMarketKlineExplicitParams(t *testing.T) {
	mux, up := marketTestMux(t)
	rec := marketGet(t, mux, "/api/site/market/kline?secid=118.AU9999&klt=102&fqt=0&beg=20240101&end=20241231&lmt=200")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	_, query := up.lastRequest()
	if query.Get("secid") != "118.AU9999" || query.Get("klt") != "102" || query.Get("fqt") != "0" ||
		query.Get("beg") != "20240101" || query.Get("end") != "20241231" || query.Get("lmt") != "200" {
		t.Fatalf("query = %v", query)
	}
}

// TestGetMarketKlineInvalidParams 非法 K 线参数 → 400,且不打上游。
func TestGetMarketKlineInvalidParams(t *testing.T) {
	mux, up := marketTestMux(t)
	for name, rawQuery := range map[string]string{
		"klt out of enum":  "secid=1.000001&klt=999",
		"fqt out of enum":  "secid=1.000001&fqt=2",
		"lmt zero":         "secid=1.000001&lmt=0",
		"lmt over max":     "secid=1.000001&lmt=2001",
		"beg bad format":   "secid=1.000001&beg=2024-01-01",
		"end bad format":   "secid=1.000001&end=2024010a",
		"secid bad format": "secid=1.00%20001",
		"secid missing":    "",
	} {
		t.Run(name, func(t *testing.T) {
			rec := marketGet(t, mux, "/api/site/market/kline?"+rawQuery)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
			}
		})
	}
	if hits, _ := up.lastRequest(); hits != 0 {
		t.Fatalf("upstream hits = %d, want 0 (rejected before upstream)", hits)
	}
}

// TestGetMarketTrendsDefaultsAndInvalid 分时:缺省 ndays=1;ndays=3 → 400。
func TestGetMarketTrendsDefaultsAndInvalid(t *testing.T) {
	mux, up := marketTestMux(t)

	rec := marketGet(t, mux, "/api/site/market/trends?secid=1.000001")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	_, query := up.lastRequest()
	if query.Get("ndays") != "1" {
		t.Fatalf("ndays = %s, want default 1", query.Get("ndays"))
	}

	rec = marketGet(t, mux, "/api/site/market/trends?secid=1.000001&ndays=5")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	_, query = up.lastRequest()
	if query.Get("ndays") != "5" {
		t.Fatalf("ndays = %s, want 5", query.Get("ndays"))
	}

	rec = marketGet(t, mux, "/api/site/market/trends?secid=1.000001&ndays=3")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

// TestGetMarketUpstreamFailure 上游失败转译:非 200/空体 → 502 + 固定文案(前端可区分上游失败)。
func TestGetMarketUpstreamFailure(t *testing.T) {
	for name, tc := range map[string]struct {
		status int
		body   string
	}{
		"upstream 500": {status: http.StatusInternalServerError, body: `{"error":"boom"}`},
		"empty body":   {status: http.StatusOK, body: ""},
	} {
		t.Run(name, func(t *testing.T) {
			mux, up := marketTestMux(t)
			up.setUpstream(tc.status, tc.body)
			rec := marketGet(t, mux, "/api/site/market/kline?secid=1.000001")
			if rec.Code != http.StatusBadGateway {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadGateway)
			}
			code, message := decodeMarketError(t, rec.Body.Bytes())
			if code != http.StatusBadGateway {
				t.Fatalf("envelope code = %d, want %d", code, http.StatusBadGateway)
			}
			if message != "行情上游暂时不可用,请稍后重试" {
				t.Fatalf("message = %q, want fixed upstream-unavailable text", message)
			}
		})
	}
}

// TestGetMarketEndpointsCacheable 三个端点均带 Cache-Control(公开只读,网关/CDN 可短缓存)。
func TestGetMarketEndpointsCacheable(t *testing.T) {
	mux, _ := marketTestMux(t)
	for path, want := range map[string]string{
		"/api/site/market/quote?secids=1.000001": "public, max-age=15",
		"/api/site/market/kline?secid=1.000001":  "public, max-age=60",
		"/api/site/market/trends?secid=1.000001": "public, max-age=60",
	} {
		rec := marketGet(t, mux, path)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200", path, rec.Code)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != want {
			t.Fatalf("%s: Cache-Control = %q, want %q", path, cc, want)
		}
	}
}

// TestGetMarketSgeDailyPassthrough 上金所日线:成功透传上游原始 JSON,缓存头与服务端 5 分钟 TTL 对齐,
// 且 instid 以 POST form 送达上游(东财端点为 GET query,两种上游形态并存)。
func TestGetMarketSgeDailyPassthrough(t *testing.T) {
	mux, up := marketTestMux(t)
	up.setUpstream(http.StatusOK, `{"time":[["2026-10-09",892,904.48,888,909],["2026-10-08",896,892,885,901]]}`)

	rec := marketGet(t, mux, "/api/site/market/sge-daily?instid=Au99.99")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "public, max-age=300" {
		t.Fatalf("Cache-Control = %q, want public, max-age=300", cc)
	}
	code, data := decodeMarketEnvelope(t, rec.Body.Bytes())
	if code != http.StatusOK {
		t.Fatalf("envelope code = %d, want %d", code, http.StatusOK)
	}
	want := map[string]any{
		"time": []any{
			[]any{"2026-10-09", float64(892), float64(904.48), float64(888), float64(909)},
			[]any{"2026-10-08", float64(896), float64(892), float64(885), float64(901)},
		},
	}
	if !reflect.DeepEqual(data, want) {
		t.Fatalf("data = %#v, want %#v", data, want)
	}

	hits, method, form := up.lastPostForm()
	if hits != 1 || method != http.MethodPost {
		t.Fatalf("upstream hits/method = %d/%q, want 1/POST", hits, method)
	}
	if form.Get("instid") != "Au99.99" || len(form) != 1 {
		t.Fatalf("form = %v, want exactly instid=Au99.99", form)
	}
}

// TestGetMarketSgeDailyInvalidInstid 非法 instid → 400,且不打上游;缺失由生成物 required 兜底 400(纯文本)。
func TestGetMarketSgeDailyInvalidInstid(t *testing.T) {
	mux, up := marketTestMux(t)
	for name, instid := range map[string]string{
		"sql injection": "Au99;drop",
		"lowercase":     "au99.99",
		"prefix":        "XAU99.99",
		"three digits":  "Au999.9",
		"no dot":        "Au9999",
		"t+d style":     "Au(T+D)",
		"extra suffix":  "Au99.99.1",
	} {
		t.Run(name, func(t *testing.T) {
			rec := marketGet(t, mux, "/api/site/market/sge-daily?instid="+url.QueryEscape(instid))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
			}
			code, message := decodeMarketError(t, rec.Body.Bytes())
			if code != http.StatusBadRequest || message == "" {
				t.Fatalf("envelope = %d/%q, want 400 with message", code, message)
			}
		})
	}
	// 缺失/空值:生成物 required 兜底直接 400(纯文本,无信封)。
	if rec := marketGet(t, mux, "/api/site/market/sge-daily"); rec.Code != http.StatusBadRequest {
		t.Fatalf("missing instid status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if rec := marketGet(t, mux, "/api/site/market/sge-daily?instid="); rec.Code != http.StatusBadRequest {
		t.Fatalf("empty instid status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if hits, _, _ := up.lastPostForm(); hits != 0 {
		t.Fatalf("upstream hits = %d, want 0 (rejected before upstream)", hits)
	}
}

// TestGetMarketSgeDailyUpstreamFailure 上游失败转译:200 但全 0(上金所对错误 instid 的形态)/非 200/空体 → 502 固定文案。
func TestGetMarketSgeDailyUpstreamFailure(t *testing.T) {
	for name, tc := range map[string]struct {
		status int
		body   string
	}{
		"all zero rows": {status: http.StatusOK, body: `{"time":[["2026-10-09",0,0,0,0],["2026-10-08",0,0,0,0]]}`},
		"upstream 500":  {status: http.StatusInternalServerError, body: `{"error":"boom"}`},
		"empty body":    {status: http.StatusOK, body: ""},
	} {
		t.Run(name, func(t *testing.T) {
			mux, up := marketTestMux(t)
			up.setUpstream(tc.status, tc.body)
			rec := marketGet(t, mux, "/api/site/market/sge-daily?instid=Au99.99")
			if rec.Code != http.StatusBadGateway {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadGateway)
			}
			code, message := decodeMarketError(t, rec.Body.Bytes())
			if code != http.StatusBadGateway {
				t.Fatalf("envelope code = %d, want %d", code, http.StatusBadGateway)
			}
			if message != "行情上游暂时不可用,请稍后重试" {
				t.Fatalf("message = %q, want fixed upstream-unavailable text", message)
			}
		})
	}
}
