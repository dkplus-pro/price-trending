// market_sge_test.go:上金所日线转发服务测试(httptest 假上游,风格对齐 market_test.go)。
// 六类边界覆盖:空值(空 body/缺 time)、零值(数据行全 0=无效 instid)、网络失败(连接拒绝/非 200)、
// 非法输入(非 JSON 对象体)、缓存(同 instid 命中不打上游/不同 instid 各打各的)。
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

// sgeFakeUpstream 假上金所上游:记录命中数与最后一次请求(方法/路径/form/头),响应可动态改。
type sgeFakeUpstream struct {
	mu     sync.Mutex
	hits   int
	method string
	path   string
	form   url.Values
	header http.Header
	status int
	body   string
}

func (f *sgeFakeUpstream) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hits++
	f.method = r.Method
	f.path = r.URL.Path
	_ = r.ParseForm() // POST form:POST 表单体在 PostForm,query 在 URL
	f.form = url.Values{}
	for k, vs := range r.PostForm {
		f.form[k] = append([]string(nil), vs...)
	}
	f.header = r.Header.Clone()
	w.WriteHeader(f.status)
	_, _ = w.Write([]byte(f.body))
}

// lastRequest 读最近一次请求快照。
func (f *sgeFakeUpstream) lastRequest() (int, string, string, url.Values, http.Header) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hits, f.method, f.path, f.form, f.header
}

// setUpstream 改写后续响应。
func (f *sgeFakeUpstream) setUpstream(status int, body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.status, f.body = status, body
}

// newSGEFakeUpstream 起假上游并注入 service(SGEDailyBaseURL 指向假上游)。
func newSGEFakeUpstream(t *testing.T) (*MarketService, *sgeFakeUpstream) {
	t.Helper()
	up := &sgeFakeUpstream{status: http.StatusOK, body: `{"time":[["2026-10-09",892,904.48,888,909]]}`}
	ts := httptest.NewServer(http.HandlerFunc(up.serve))
	t.Cleanup(ts.Close)
	svc := NewMarketService(MarketServiceConfig{
		HTTPClient:      ts.Client(),
		SGEDailyBaseURL: ts.URL,
	})
	return svc, up
}

// TestMarketSGEDailyRequestShape 请求形态:POST + 固定路径 + form 参数 instid + 浏览器 UA。
func TestMarketSGEDailyRequestShape(t *testing.T) {
	svc, up := newSGEFakeUpstream(t)
	body, err := svc.SGEDaily(context.Background(), "Au99.99")
	if err != nil {
		t.Fatalf("sge daily: %v", err)
	}
	if string(body) != `{"time":[["2026-10-09",892,904.48,888,909]]}` {
		t.Fatalf("body = %q, want raw upstream body", body)
	}

	hits, method, path, form, header := up.lastRequest()
	if hits != 1 {
		t.Fatalf("upstream hits = %d, want 1", hits)
	}
	if method != http.MethodPost {
		t.Fatalf("method = %q, want POST", method)
	}
	if path != "/graph/Dailyhq" {
		t.Fatalf("path = %q, want /graph/Dailyhq", path)
	}
	if form.Get("instid") != "Au99.99" || len(form) != 1 {
		t.Fatalf("form = %v, want exactly instid=Au99.99", form)
	}
	if !strings.Contains(header.Get("User-Agent"), "Mozilla/5.0") {
		t.Fatalf("User-Agent = %q, want browser UA", header.Get("User-Agent"))
	}
	if ct := header.Get("Content-Type"); !strings.HasPrefix(ct, "application/x-www-form-urlencoded") {
		t.Fatalf("Content-Type = %q, want form-urlencoded", ct)
	}
}

// TestMarketSGEDailyCache 缓存:同 instid 第二次命中不打上游;不同 instid 各打各的。
func TestMarketSGEDailyCache(t *testing.T) {
	svc, up := newSGEFakeUpstream(t)
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		if _, err := svc.SGEDaily(ctx, "Au99.99"); err != nil {
			t.Fatalf("sge daily #%d: %v", i, err)
		}
	}
	hits, _, _, _, _ := up.lastRequest()
	if hits != 1 {
		t.Fatalf("hits after 3 identical requests = %d, want 1 (cache)", hits)
	}

	if _, err := svc.SGEDaily(ctx, "Au99.95"); err != nil {
		t.Fatalf("sge daily other instid: %v", err)
	}
	hits, _, _, _, _ = up.lastRequest()
	if hits != 2 {
		t.Fatalf("hits = %d, want 2 (different instid hits upstream)", hits)
	}
}

// TestMarketSGEDailyAllZeroRows 无效 instid 形态:上游 200 但数据行全 0 → 哨兵转译,失败不缓存。
func TestMarketSGEDailyAllZeroRows(t *testing.T) {
	svc, up := newSGEFakeUpstream(t)
	up.setUpstream(http.StatusOK, `{"time":[["2026-10-09",0,0,0,0],["2026-10-08",0,0,0,0]]}`)

	if _, err := svc.SGEDaily(context.Background(), "Au00.00"); !errors.Is(err, ErrMarketUpstreamUnavailable) {
		t.Fatalf("err = %v, want ErrMarketUpstreamUnavailable", err)
	}

	// 失败不缓存:修正上游后重试应打到上游(第 2 次命中)并成功。
	up.setUpstream(http.StatusOK, `{"time":[["2026-10-09",892,904.48,888,909]]}`)
	if _, err := svc.SGEDaily(context.Background(), "Au00.00"); err != nil {
		t.Fatalf("retry after fix: %v", err)
	}
	if hits, _, _, _, _ := up.lastRequest(); hits != 2 {
		t.Fatalf("upstream hits = %d, want 2 (failed result not cached)", hits)
	}
}

// TestMarketSGEDailyPartialZeroRows 零星 0 行混在有效行中:不判失败,原样透传。
func TestMarketSGEDailyPartialZeroRows(t *testing.T) {
	svc, up := newSGEFakeUpstream(t)
	raw := `{"time":[["2026-10-09",0,0,0,0],["2026-10-08",892,904.48,888,909]]}`
	up.setUpstream(http.StatusOK, raw)

	body, err := svc.SGEDaily(context.Background(), "Au99.99")
	if err != nil {
		t.Fatalf("sge daily: %v", err)
	}
	if string(body) != raw {
		t.Fatalf("body = %q, want raw upstream body", body)
	}
}

// TestMarketSGEDailyInvalidPayload 结构校验:缺 time/空 time/无可解析行 → 哨兵。
func TestMarketSGEDailyInvalidPayload(t *testing.T) {
	cases := map[string]string{
		"missing time":   `{}`,
		"empty time":     `{"time":[]}`,
		"time not array": `{"time":"oops"}`,
		"rows too short": `{"time":[["2026-10-09",892]]}`,
		"rows not array": `{"time":["2026-10-09"]}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			svc, up := newSGEFakeUpstream(t)
			up.setUpstream(http.StatusOK, body)
			_, err := svc.SGEDaily(context.Background(), "Au99.99")
			if !errors.Is(err, ErrMarketUpstreamUnavailable) {
				t.Fatalf("err = %v, want ErrMarketUpstreamUnavailable", err)
			}
		})
	}
}

// TestMarketSGEDailyUpstreamFailure 上游失败转译:非 200/空体/非 JSON 对象/网络失败 → 哨兵。
func TestMarketSGEDailyUpstreamFailure(t *testing.T) {
	ctx := context.Background()

	cases := map[string]struct {
		status   int
		body     string
		fragment string
	}{
		"upstream 500":    {status: http.StatusInternalServerError, body: `{"error":"boom"}`, fragment: "status 500"},
		"empty body":      {status: http.StatusOK, body: "", fragment: "not a json object"},
		"html body":       {status: http.StatusOK, body: "<html>blocked</html>", fragment: "not a json object"},
		"json array body": {status: http.StatusOK, body: `[[1,2,3,4,5]]`, fragment: "not a json object"},
		"truncated json":  {status: http.StatusOK, body: `{"time":`, fragment: "not a json object"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			svc, up := newSGEFakeUpstream(t)
			up.setUpstream(tc.status, tc.body)
			_, err := svc.SGEDaily(ctx, "Au99.99")
			if !errors.Is(err, ErrMarketUpstreamUnavailable) {
				t.Fatalf("err = %v, want ErrMarketUpstreamUnavailable", err)
			}
			if tc.fragment != "" && !strings.Contains(err.Error(), tc.fragment) {
				t.Fatalf("err = %q, want fragment %q (internal detail for logs)", err, tc.fragment)
			}
		})
	}

	// 网络失败:上游连接拒绝。
	svc, _ := newSGEFakeUpstream(t)
	svc.client = &http.Client{Timeout: time.Second}
	svc.sgeBaseURL = "http://127.0.0.1:1"
	if _, err := svc.SGEDaily(ctx, "Au99.99"); !errors.Is(err, ErrMarketUpstreamUnavailable) {
		t.Fatalf("conn refused err = %v, want ErrMarketUpstreamUnavailable", err)
	}
}

// TestMarketSGEParseInstID 参数校验 helper:与契约 pattern 同口径(保守 Au 前缀数字合约)。
func TestMarketSGEParseInstID(t *testing.T) {
	for _, instid := range []string{"Au99.99", "Au99.95", "Au01.01"} {
		if got, ok := ParseMarketSGEInstID(instid); !ok || got != instid {
			t.Fatalf("ParseMarketSGEInstID(%q) = %q/%v, want valid", instid, got, ok)
		}
	}
	for _, instid := range []string{"", "Au99;drop", "au99.99", "AU99.99", "Au999.9", "Au99.9", "Au(T+D)", "Au100g", "Au 99.99", "Au99.99.", "1.Au99.99"} {
		if _, ok := ParseMarketSGEInstID(instid); ok {
			t.Fatalf("ParseMarketSGEInstID(%q) = valid, want invalid", instid)
		}
	}
}
