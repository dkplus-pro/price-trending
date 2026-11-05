// market_test.go:行情转发服务测试(httptest 假上游)。
// 六类边界覆盖:空值(空 secids/空 body)、零值(lmt=0)、越界(lmt=2001/缓存条目超限)、
// 网络失败(连接拒绝/非 200)、非法输入(特殊字符 secid/非 JSON 对象体)。
package service

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// marketFakeUpstream 假上游:记录命中数与最后一次请求(路径/query/头),响应可动态改。
type marketFakeUpstream struct {
	mu     sync.Mutex
	hits   int
	path   string
	query  url.Values
	header http.Header
	status int
	body   string
}

func (f *marketFakeUpstream) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hits++
	f.path = r.URL.Path
	f.query = r.URL.Query()
	f.header = r.Header.Clone()
	w.WriteHeader(f.status)
	_, _ = w.Write([]byte(f.body))
}

// lastRequest 读最近一次请求快照。
func (f *marketFakeUpstream) lastRequest() (int, string, url.Values, http.Header) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hits, f.path, f.query, f.header
}

// setUpstream 改写后续响应。
func (f *marketFakeUpstream) setUpstream(status int, body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.status, f.body = status, body
}

// newMarketFakeUpstream 起假上游并注入 service(quote/history 基地址同指假上游)。
func newMarketFakeUpstream(t *testing.T) (*MarketService, *marketFakeUpstream) {
	t.Helper()
	up := &marketFakeUpstream{status: http.StatusOK, body: `{"data":{"diff":[]}}`}
	ts := httptest.NewServer(http.HandlerFunc(up.serve))
	t.Cleanup(ts.Close)
	svc := NewMarketService(MarketServiceConfig{
		HTTPClient:     ts.Client(),
		QuoteBaseURL:   ts.URL,
		HistoryBaseURL: ts.URL,
	})
	return svc, up
}

// TestMarketQuoteURLWhitelist 快照 URL:路径固定,query 只含白名单参数(键集合断言)。
func TestMarketQuoteURLWhitelist(t *testing.T) {
	svc, up := newMarketFakeUpstream(t)
	body, err := svc.Quote(context.Background(), MarketQuoteParams{Secids: []string{"1.000001", "118.AU9999"}})
	if err != nil {
		t.Fatalf("quote: %v", err)
	}
	if string(body) != `{"data":{"diff":[]}}` {
		t.Fatalf("body = %q, want raw upstream body", body)
	}

	hits, path, query, _ := up.lastRequest()
	if hits != 1 {
		t.Fatalf("upstream hits = %d, want 1", hits)
	}
	if path != "/api/qt/ulist.np/get" {
		t.Fatalf("path = %q, want /api/qt/ulist.np/get", path)
	}
	if query.Get("secids") != "1.000001,118.AU9999" {
		t.Fatalf("secids = %q, want joined secids", query.Get("secids"))
	}
	if query.Get("pz") != "2" || query.Get("pn") != "1" || query.Get("fltt") != "2" {
		t.Fatalf("pz/pn/fltt = %s/%s/%s, want 2/1/2", query.Get("pz"), query.Get("pn"), query.Get("fltt"))
	}
	if query.Get("fields") != marketQuoteFields || query.Get("ut") != marketPublicUT {
		t.Fatalf("fields/ut = %s/%s, want whitelist/ut", query.Get("fields"), query.Get("ut"))
	}
	// 白名单键集合:secids,fields,fltt,invt,pn,pz,fid,po,ut 共 9 键,不透传任何额外参数。
	if len(query) != 9 {
		t.Fatalf("query keys = %v (%d), want exactly 9 whitelisted keys", query, len(query))
	}
}

// TestMarketKlineTrendsURL K 线/分时 URL:路径与参数拼装、默认 fields 白名单。
func TestMarketKlineTrendsURL(t *testing.T) {
	svc, up := newMarketFakeUpstream(t)

	if _, err := svc.Kline(context.Background(), MarketKlineParams{
		Secid: "1.000001", Klt: MarketDefaultKlt, Fqt: MarketDefaultFqt,
		Beg: MarketDefaultBeg, End: MarketDefaultEnd, Lmt: MarketDefaultLmt,
	}); err != nil {
		t.Fatalf("kline: %v", err)
	}
	_, path, query, _ := up.lastRequest()
	if path != "/api/qt/stock/kline/get" {
		t.Fatalf("path = %q, want /api/qt/stock/kline/get", path)
	}
	if query.Get("secid") != "1.000001" || query.Get("klt") != "101" || query.Get("fqt") != "1" {
		t.Fatalf("secid/klt/fqt = %s/%s/%s", query.Get("secid"), query.Get("klt"), query.Get("fqt"))
	}
	if query.Get("beg") != "19700101" || query.Get("end") != "20991231" || query.Get("lmt") != "120" {
		t.Fatalf("beg/end/lmt = %s/%s/%s", query.Get("beg"), query.Get("end"), query.Get("lmt"))
	}
	if query.Get("fields2") == "" || query.Get("ut") != marketPublicUT {
		t.Fatalf("fields2/ut missing: %s/%s", query.Get("fields2"), query.Get("ut"))
	}

	if _, err := svc.Trends(context.Background(), MarketTrendsParams{Secid: "118.AU9999", Ndays: 5}); err != nil {
		t.Fatalf("trends: %v", err)
	}
	_, path, query, _ = up.lastRequest()
	if path != "/api/qt/stock/trends2/get" {
		t.Fatalf("path = %q, want /api/qt/stock/trends2/get", path)
	}
	if query.Get("secid") != "118.AU9999" || query.Get("ndays") != "5" || query.Get("iscr") != "0" {
		t.Fatalf("secid/ndays/iscr = %s/%s/%s", query.Get("secid"), query.Get("ndays"), query.Get("iscr"))
	}
}

// TestMarketRequestHeaders 请求头:带浏览器 UA 与 Referer(WAF 伪装特征,诊断依据见 market.go)。
func TestMarketRequestHeaders(t *testing.T) {
	svc, up := newMarketFakeUpstream(t)
	if _, err := svc.Quote(context.Background(), MarketQuoteParams{Secids: []string{"1.000001"}}); err != nil {
		t.Fatalf("quote: %v", err)
	}
	_, _, _, header := up.lastRequest()
	if !strings.Contains(header.Get("User-Agent"), "Mozilla/5.0") {
		t.Fatalf("User-Agent = %q, want browser UA", header.Get("User-Agent"))
	}
	if header.Get("Referer") != "https://quote.eastmoney.com/" {
		t.Fatalf("Referer = %q, want https://quote.eastmoney.com/", header.Get("Referer"))
	}
}

// TestMarketCacheHit 缓存:同参数第二次命中不打上游;不同参数各走一次上游。
func TestMarketCacheHit(t *testing.T) {
	svc, up := newMarketFakeUpstream(t)
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		if _, err := svc.Quote(ctx, MarketQuoteParams{Secids: []string{"1.000001"}}); err != nil {
			t.Fatalf("quote #%d: %v", i, err)
		}
	}
	hits, _, _, _ := up.lastRequest()
	if hits != 1 {
		t.Fatalf("hits after 3 identical quotes = %d, want 1 (cache)", hits)
	}

	if _, err := svc.Quote(ctx, MarketQuoteParams{Secids: []string{"1.000001", "0.000002"}}); err != nil {
		t.Fatalf("quote with other secids: %v", err)
	}
	if _, err := svc.Kline(ctx, MarketKlineParams{
		Secid: "1.000001", Klt: MarketDefaultKlt, Fqt: MarketDefaultFqt,
		Beg: MarketDefaultBeg, End: MarketDefaultEnd, Lmt: MarketDefaultLmt,
	}); err != nil {
		t.Fatalf("kline: %v", err)
	}
	hits, _, _, _ = up.lastRequest()
	if hits != 3 {
		t.Fatalf("hits = %d, want 3 (different params each hit upstream)", hits)
	}
}

// TestMarketCacheExpiryAndCapacity 缓存过期与条目上限淘汰(直接操作缓存,注入小容量)。
func TestMarketCacheExpiryAndCapacity(t *testing.T) {
	c := newMarketCache(2)
	c.set("a", []byte("1"), time.Minute)
	c.set("b", []byte("2"), time.Minute)

	// 过期:负 TTL 立即过期,get 判未命中。
	c.set("expired", []byte("x"), -time.Second)
	if _, ok := c.get("expired"); ok {
		t.Fatal("expired entry should miss")
	}

	// 容量淘汰:第 3 条写入时最早过期的 a 被逐出,b/c 保留。
	c.set("c", []byte("3"), time.Minute)
	if _, ok := c.get("a"); ok {
		t.Fatal("oldest entry should be evicted at capacity")
	}
	if _, ok := c.get("b"); !ok {
		t.Fatal("b should survive")
	}
	if _, ok := c.get("c"); !ok {
		t.Fatal("c should survive")
	}
	if len(c.entries) != 2 {
		t.Fatalf("entries = %d, want capped 2", len(c.entries))
	}
}

// TestMarketUpstreamFailureTranslation 上游失败转译:非 200/空体/非 JSON 对象/网络失败 → 哨兵。
func TestMarketUpstreamFailureTranslation(t *testing.T) {
	ctx := context.Background()
	params := MarketQuoteParams{Secids: []string{"1.000001"}}

	cases := map[string]struct {
		status   int
		body     string
		fragment string
	}{
		"upstream 500":    {status: http.StatusInternalServerError, body: `{"error":"boom"}`, fragment: "status 500"},
		"empty body":      {status: http.StatusOK, body: "", fragment: "not a json object"},
		"html body":       {status: http.StatusOK, body: "<html>blocked</html>", fragment: "not a json object"},
		"json array body": {status: http.StatusOK, body: `[1,2,3]`, fragment: "not a json object"},
		"truncated json":  {status: http.StatusOK, body: `{"data":`, fragment: "not a json object"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			svc, up := newMarketFakeUpstream(t)
			up.setUpstream(tc.status, tc.body)
			_, err := svc.Quote(ctx, params)
			if !errors.Is(err, ErrMarketUpstreamUnavailable) {
				t.Fatalf("err = %v, want ErrMarketUpstreamUnavailable", err)
			}
			if tc.fragment != "" && !strings.Contains(err.Error(), tc.fragment) {
				t.Fatalf("err = %q, want fragment %q (internal detail for logs)", err, tc.fragment)
			}
		})
	}

	// 网络失败:上游连接拒绝(诊断中 WAF 断连在 Go 侧即 EOF/连接错误,同语义)。
	svc, _ := newMarketFakeUpstream(t)
	svc.client = &http.Client{Timeout: time.Second}
	svc.quoteBaseURL = "http://127.0.0.1:1"
	if _, err := svc.Quote(ctx, params); !errors.Is(err, ErrMarketUpstreamUnavailable) {
		t.Fatalf("conn refused err = %v, want ErrMarketUpstreamUnavailable", err)
	}
}

// TestMarketParseHelpers 参数校验 helper:与契约 pattern/enum/minimum/maximum 同口径。
func TestMarketParseHelpers(t *testing.T) {
	validSecids := []string{"1.000001", "0.000002", "118.AU9999", "116.00700"}
	for _, secid := range validSecids {
		if _, ok := ParseMarketSecid(secid); !ok {
			t.Fatalf("ParseMarketSecid(%q) = invalid, want valid", secid)
		}
	}
	invalidSecids := []string{"", "1.000001.", ".000001", "1", "1.00 0001", "1.00<00>1", "abc.def", "1.00-01", "1.00+1", "1.0.0001"}
	for _, secid := range invalidSecids {
		if _, ok := ParseMarketSecid(secid); ok {
			t.Fatalf("ParseMarketSecid(%q) = valid, want invalid", secid)
		}
	}

	if secids, ok := ParseMarketSecids("1.000001,118.AU9999"); !ok || len(secids) != 2 {
		t.Fatalf("ParseMarketSecids list = %v/%v, want 2 valid", secids, ok)
	}
	for _, raw := range []string{"", "1.000001,", ",1.000001", "1.000001, abc", "abc"} {
		if _, ok := ParseMarketSecids(raw); ok {
			t.Fatalf("ParseMarketSecids(%q) = valid, want invalid", raw)
		}
	}

	if !ValidMarketKlt(101) || !ValidMarketKlt(102) || !ValidMarketKlt(103) {
		t.Fatal("klt 101/102/103 should be valid")
	}
	if ValidMarketKlt(100) || ValidMarketKlt(999) || ValidMarketKlt(0) {
		t.Fatal("klt out of enum should be invalid")
	}
	if !ValidMarketFqt(0) || !ValidMarketFqt(1) || ValidMarketFqt(2) {
		t.Fatal("fqt domain broken")
	}
	if !ValidMarketNdays(1) || !ValidMarketNdays(5) || ValidMarketNdays(3) {
		t.Fatal("ndays domain broken")
	}
	if !ValidMarketLmt(1) || !ValidMarketLmt(2000) || ValidMarketLmt(0) || ValidMarketLmt(2001) {
		t.Fatal("lmt bounds broken")
	}
	if !ValidMarketDate("20240101") || ValidMarketDate("2024-01-01") || ValidMarketDate("2024010") || ValidMarketDate("2024010a") || ValidMarketDate("") {
		t.Fatal("date pattern broken")
	}
}
