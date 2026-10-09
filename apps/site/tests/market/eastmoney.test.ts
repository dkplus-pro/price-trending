// 东财源适配器单测:mock 全局 fetch(fetchJson 的底层),用真实响应 fixture 驱动解析,
// 覆盖六类边界:空值(空数组/空 secids)、零值(price=0 保留、量/均价为 0、振幅 0 保留)、
// 越界(段数不足跳过、振幅段缺失/非法 → null)、配置缺失(入参为空不发请求)、
// 网络失败(fetchJson reject 透传)、非法状态(结构变形 → 空数据;代理返回 HTML 错误页 → 非 JSON 抛错)。
// 公共 CORS 代理 host("proxy:" 前缀):URL 构建(完整东财 URL 编码进 {url} 模板)、响应同解析、
// 15s 超时(直连 10s)见文末「公共 CORS 代理 host」一组。
//
// fixture 说明(见 fixtures/eastmoney/ 各文件头的 _note):
// - 实测响应(2026-10-09 curl):ulist-secid-echo / trends-1d / trends-5d-boundary / trends-data-null;
// - K 线端点(push2his kline path)在本环境被源拒绝(HTTP 000,同 host 的 trends2/details 正常),
//   kline-day-lmt5 按卡片固化的 11 段格式构造(其中 10-09 一根为同日实测值);
// - 手工构造的异常响应:ulist-dash-fields / ulist-secid-mismatch / ulist-data-null /
//   kline-day-lmt5 / kline-malformed-rows / kline-data-null / trends-invalid-rows。
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_KLINE_LIMIT, getInstrument } from "../../src/api/market/config";
import { fetchKlines, fetchQuotes, fetchTrends } from "../../src/api/market/sources/eastmoney";
import type { InstrumentConfig } from "../../src/api/market/types";
import klineDataNull from "./fixtures/eastmoney/kline-data-null.json";
import klineDayLmt5 from "./fixtures/eastmoney/kline-day-lmt5.json";
import klineMalformedRows from "./fixtures/eastmoney/kline-malformed-rows.json";
import trends1d from "./fixtures/eastmoney/trends-1d.json";
import trends5dBoundary from "./fixtures/eastmoney/trends-5d-boundary.json";
import trendsDataNull from "./fixtures/eastmoney/trends-data-null.json";
import trendsInvalidRows from "./fixtures/eastmoney/trends-invalid-rows.json";
import ulistDashFields from "./fixtures/eastmoney/ulist-dash-fields.json";
import ulistDataNull from "./fixtures/eastmoney/ulist-data-null.json";
import ulistSecidEcho from "./fixtures/eastmoney/ulist-secid-echo.json";
import ulistSecidMismatch from "./fixtures/eastmoney/ulist-secid-mismatch.json";

function instOf(...ids: string[]): InstrumentConfig[] {
  return ids.map((id) => {
    const inst = getInstrument(id);
    if (!inst) {
      throw new Error(`测试引用了不存在的标的: ${id}`);
    }
    return inst;
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

/** 用固定响应体打桩 fetch,返回 mock 以便断言请求 URL(calls[i][0])。 */
function stubJsonFetch(body: unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => jsonResponse(body));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function firstUrl(mock: ReturnType<typeof vi.fn>): string {
  return String(mock.mock.calls[0][0]);
}

/** 真实响应的实测域名(默认主域)。 */
const QUOTE_HOST = "https://push2.eastmoney.com";
const KLINE_HOST = "https://push2his.eastmoney.com";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchQuotes 快照", () => {
  it("实测响应:按 f13+f12 对账回 instrumentId,价格/涨跌/量额/时间字段映射正确", async () => {
    const insts = instOf("au9999", "sh000001", "xau", "gc");
    stubJsonFetch(ulistSecidEcho);

    const quotes = await fetchQuotes(insts, QUOTE_HOST);

    expect(quotes.map((quote) => quote.instrumentId)).toEqual(["sh000001", "au9999", "xau", "gc"]);
    expect(quotes[0]).toEqual({
      instrumentId: "sh000001",
      price: 3813.79,
      change: 1.89,
      changePct: 0.05,
      amplitudePct: 1.85,
      open: 3804.09,
      high: 3824.71,
      low: 3754.14,
      prevClose: 3811.9,
      volume: 535149921,
      amount: 888561198263.9,
      time: 1791531840,
      source: "eastmoney"
    });
    // 实测:XAU 的 f5 为 0(合法零值,保留),f6 为字符串 "-"(无值,转 null)。
    expect(quotes[2]).toMatchObject({ price: 4191.93, volume: 0, amount: null });
  });

  it('字符串 "-" 与缺失字段一律 null,字符串数字可解析', async () => {
    stubJsonFetch(ulistDashFields);

    const quotes = await fetchQuotes(instOf("au9999", "sh000001"), QUOTE_HOST);

    // 第 1 条:全字段 "-"(f6 为 null)且无 f124 → 全 null。
    expect(quotes[0]).toEqual({
      instrumentId: "au9999",
      price: null,
      change: null,
      changePct: null,
      amplitudePct: null,
      open: null,
      high: null,
      low: null,
      prevClose: null,
      volume: null,
      amount: null,
      time: null,
      source: "eastmoney"
    });
    // 第 2 条:f2 为字符串数字 → 解析为数字;无 f124 → time null。
    expect(quotes[1]).toMatchObject({ instrumentId: "sh000001", price: 3813.79, time: null });
  });

  it("secid 对不上时按请求顺序兜底", async () => {
    stubJsonFetch(ulistSecidMismatch);

    const quotes = await fetchQuotes(instOf("au9999", "sh000001"), QUOTE_HOST);

    expect(quotes.map((quote) => [quote.instrumentId, quote.price])).toEqual([
      ["au9999", 904.48],
      ["sh000001", 3813.79]
    ]);
  });

  it("data 为 null → 返回空数组,不抛异常(交给 facade 兜底)", async () => {
    stubJsonFetch(ulistDataNull);

    await expect(fetchQuotes(instOf("au9999"), QUOTE_HOST)).resolves.toEqual([]);
  });

  it("入参空数组 → 直接返回 [],不发请求", async () => {
    const mock = stubJsonFetch(ulistSecidEcho);

    await expect(fetchQuotes([])).resolves.toEqual([]);
    expect(mock).not.toHaveBeenCalled();
  });

  it("请求 URL 拼装:逗号分隔 secid + 实测字段表 + fltt=2/invt=2", async () => {
    const mock = stubJsonFetch(ulistSecidEcho);

    await fetchQuotes(instOf("au9999", "sh000001"), QUOTE_HOST);

    expect(firstUrl(mock)).toBe(
      `${QUOTE_HOST}/api/qt/ulist.np/get?secids=118.AU9999,1.000001` +
        "&fields=f2,f3,f4,f5,f6,f7,f8,f10,f12,f13,f14,f15,f16,f17,f18,f124&fltt=2&invt=2"
    );
  });

  it("host 缺省用默认主域,传入裸域名自动补 https://", async () => {
    const defaultMock = stubJsonFetch(ulistSecidEcho);
    await fetchQuotes(instOf("au9999"));
    expect(firstUrl(defaultMock)).toContain(`${QUOTE_HOST}/api/qt/ulist.np/get?`);

    const hostMock = stubJsonFetch(ulistSecidEcho);
    await fetchQuotes(instOf("au9999"), "82.push2.eastmoney.com");
    expect(firstUrl(hostMock)).toContain("https://82.push2.eastmoney.com/api/qt/ulist.np/get?");
  });

  it("网络失败(fetchJson reject)原样透传,不吞错", async () => {
    const networkError = new Error("network down");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw networkError;
      })
    );

    await expect(fetchQuotes(instOf("au9999"))).rejects.toBe(networkError);
  });
});

describe("fetchKlines K 线", () => {
  it("K 线响应:每根 11 段取前 7 段 + 第 8 段振幅映射 KlineBar,含 10-09 实测值那根", async () => {
    stubJsonFetch(klineDayLmt5);

    const page = await fetchKlines(instOf("sh000001")[0], "day", { limit: 5 }, KLINE_HOST);

    expect(page.bars).toHaveLength(5);
    expect(page.bars[0]).toEqual({
      time: "2026-09-28",
      open: 3795,
      close: 3799.5,
      high: 3805,
      low: 3782,
      volume: 482_000_000,
      amount: 691_000_000_000,
      amplitudePct: 0.61
    });
    // 10-09:开/收/高/低/量/额为同日 ulist + trends2 实测值;振幅取源第 8 段。
    expect(page.bars[4]).toEqual({
      time: "2026-10-09",
      open: 3804.09,
      close: 3813.79,
      high: 3815.91,
      low: 3787.32,
      volume: 535_149_921,
      amount: 888_561_198_263.9,
      amplitudePct: 0.75
    });
    expect(page.hasMore).toBe(true);
  });

  it('振幅段:非数字 / "-" → null,缺段(仅 7 段)→ null,不拖累该根其余字段', async () => {
    stubJsonFetch({
      data: {
        klines: [
          // 振幅为 0 是合法零值,保留。
          "2026-10-06,1,2,3,0.5,6,7,0",
          // 仅 7 段:振幅段缺失 → null,其余照常解析。
          "2026-10-07,1,2,3,0.5,6,7",
          // 8 段、振幅为 "-"(无值)。
          "2026-10-08,1,2,3,0.5,6,7,-",
          // 8 段但振幅非数字。
          "2026-10-09,1,2,3,0.5,6,7,abc"
        ]
      }
    });

    const page = await fetchKlines(instOf("sh000001")[0], "day", { limit: 4 }, KLINE_HOST);

    expect(page.bars.map((bar) => bar.amplitudePct)).toEqual([0, null, null, null]);
    expect(page.bars[0]).toEqual({
      time: "2026-10-06",
      open: 1,
      close: 2,
      high: 3,
      low: 0.5,
      volume: 6,
      amount: 7,
      amplitudePct: 0
    });
  });

  it("lmt 兜底:响应条数超过 limit 时只保留最近 limit 根并按此判定 hasMore", async () => {
    stubJsonFetch(klineDayLmt5);

    const page = await fetchKlines(instOf("sh000001")[0], "day", { limit: 2 }, KLINE_HOST);

    expect(page.bars.map((bar) => bar.time)).toEqual(["2026-10-08", "2026-10-09"]);
    expect(page.hasMore).toBe(true);
  });

  it('段数不足的根跳过、量为 "-" → null、乱序输入升序输出', async () => {
    stubJsonFetch(klineMalformedRows);

    const page = await fetchKlines(instOf("sh000001")[0], "day", { limit: 4 }, KLINE_HOST);

    expect(page.bars.map((bar) => bar.time)).toEqual([
      "2026-09-30",
      "2026-10-02",
      "2026-10-03",
      "2026-10-06"
    ]);
    // 09-30 这根的量额为 "-" → null,振幅取源第 8 段;10-02 仅 7 段 → 振幅 null。
    expect(page.bars[0]).toEqual({
      time: "2026-09-30",
      open: 3830,
      close: 3845,
      high: 3850,
      low: 3820,
      volume: null,
      amount: null,
      amplitudePct: 0.78
    });
    expect(page.bars[1].amplitudePct).toBeNull();
    expect(page.hasMore).toBe(true);
  });

  it("hasMore:条数 === limit 为 true,条数 < limit 为 false", async () => {
    stubJsonFetch(klineMalformedRows);

    const exact = await fetchKlines(instOf("sh000001")[0], "day", { limit: 4 }, KLINE_HOST);
    const larger = await fetchKlines(instOf("sh000001")[0], "day", { limit: 5 }, KLINE_HOST);

    expect(exact.hasMore).toBe(true);
    expect(larger.hasMore).toBe(false);
  });

  it("limit 缺省用 DEFAULT_KLINE_LIMIT(200)拼 lmt 并按 200 判定 hasMore", async () => {
    const mock = stubJsonFetch(klineMalformedRows);

    const page = await fetchKlines(instOf("sh000001")[0], "day", {}, KLINE_HOST);

    expect(firstUrl(mock)).toContain(`&lmt=${DEFAULT_KLINE_LIMIT}`);
    expect(DEFAULT_KLINE_LIMIT).toBe(200);
    expect(page.hasMore).toBe(false);
  });

  it("data 为 null(结构变形)→ { bars: [], hasMore: false },不抛异常", async () => {
    stubJsonFetch(klineDataNull);

    await expect(
      fetchKlines(instOf("sh000001")[0], "day", { limit: 5 }, KLINE_HOST)
    ).resolves.toEqual({ bars: [], hasMore: false });
  });

  it("请求 URL 拼装:周期 → klt(101/102/103)、fqt=0、end 缺省哨兵与覆盖", async () => {
    const dayMock = stubJsonFetch(klineMalformedRows);
    await fetchKlines(instOf("sh000001")[0], "day", { limit: 3 }, KLINE_HOST);
    expect(firstUrl(dayMock)).toBe(
      `${KLINE_HOST}/api/qt/stock/kline/get?secid=1.000001` +
        "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
        "&klt=101&fqt=0&beg=0&end=20500101&lmt=3"
    );

    const weekMock = stubJsonFetch(klineMalformedRows);
    await fetchKlines(instOf("sz399006")[0], "week", { limit: 3, end: "20260101" }, KLINE_HOST);
    expect(firstUrl(weekMock)).toContain("&klt=102&");
    expect(firstUrl(weekMock)).toContain("&end=20260101&");
    expect(firstUrl(weekMock)).toContain("secid=0.399006");

    const monthMock = stubJsonFetch(klineMalformedRows);
    await fetchKlines(instOf("sh000688")[0], "month", { limit: 3 }, KLINE_HOST);
    expect(firstUrl(monthMock)).toContain("&klt=103&");
  });

  it("host 传入时替换域名(缺省为 push2his 历史行情域)", async () => {
    const defaultMock = stubJsonFetch(klineMalformedRows);
    await fetchKlines(instOf("sh000001")[0], "day", { limit: 3 });
    expect(firstUrl(defaultMock)).toContain(`${KLINE_HOST}/api/qt/stock/kline/get?`);

    const hostMock = stubJsonFetch(klineMalformedRows);
    await fetchKlines(instOf("sh000001")[0], "day", { limit: 3 }, "http://127.0.0.1:8080");
    expect(firstUrl(hostMock)).toContain("http://127.0.0.1:8080/api/qt/stock/kline/get?");
  });

  it("网络失败(fetchJson reject)原样透传", async () => {
    const networkError = new Error("HTTP 000");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw networkError;
      })
    );

    await expect(fetchKlines(instOf("sh000001")[0], "day", {})).rejects.toBe(networkError);
  });
});

describe("fetchKlines 范围查询(beg)", () => {
  it("带 beg:URL 拼 beg={beg} 且 lmt=5000;范围模式不按 limit 截断、hasMore 恒 false", async () => {
    const mock = stubJsonFetch(klineDayLmt5);

    const page = await fetchKlines(
      instOf("sh000001")[0],
      "day",
      { beg: "20250901", end: "20260901", limit: 2 },
      KLINE_HOST
    );

    // fixture 共 5 根(> limit 2):范围模式不切片,条数与 hasMore 都不受 limit 影响。
    expect(firstUrl(mock)).toContain("&beg=20250901&");
    expect(firstUrl(mock)).toContain("&end=20260901&");
    expect(firstUrl(mock)).toContain("&lmt=5000");
    expect(page.bars).toHaveLength(5);
    expect(page.hasMore).toBe(false);
  });

  it("范围模式 limit 缺省时 lmt 同样为 5000(与 limit 无关)", async () => {
    const mock = stubJsonFetch(klineDayLmt5);

    await fetchKlines(instOf("sh000001")[0], "week", { beg: "20250901" }, KLINE_HOST);

    expect(firstUrl(mock)).toContain("&beg=20250901&end=20500101&lmt=5000");
  });

  it("beg 为空串视为未启用范围查询:维持 beg=0 + lmt=limit 与切片(空值边界/回归)", async () => {
    const mock = stubJsonFetch(klineDayLmt5);

    const page = await fetchKlines(instOf("sh000001")[0], "day", { beg: "", limit: 2 }, KLINE_HOST);

    expect(firstUrl(mock)).toContain("&beg=0&");
    expect(firstUrl(mock)).toContain("&lmt=2");
    expect(page.bars.map((bar) => bar.time)).toEqual(["2026-10-08", "2026-10-09"]);
    expect(page.hasMore).toBe(true);
  });

  it("范围模式遇结构变形(data 为 null)→ { bars: [], hasMore: false }", async () => {
    stubJsonFetch(klineDataNull);

    await expect(
      fetchKlines(instOf("sh000001")[0], "day", { beg: "20250901" }, KLINE_HOST)
    ).resolves.toEqual({ bars: [], hasMore: false });
  });
});

describe("fetchTrends 分时", () => {
  it("实测 1 日响应:取 time/close(price)/开高低/volume/avg,分钟 OHLC 按段映射", async () => {
    stubJsonFetch(trends1d);

    const trends = await fetchTrends(instOf("sh000001")[0], 1, KLINE_HOST);

    expect(trends.prevClose).toBe(3811.9);
    expect(trends.points).toHaveLength(10);
    expect(trends.points[0]).toEqual({
      time: "2026-10-09 09:30",
      price: 3804.09,
      avgPrice: 3806.883,
      volume: 3_600_224,
      open: 3804.09,
      high: 3804.09,
      low: 3804.09
    });
    expect(trends.points[1]).toEqual({
      time: "2026-10-09 09:31",
      price: 3806.44,
      avgPrice: 3797.77,
      volume: 18_965_589,
      open: 3805.07,
      high: 3809.6,
      low: 3804.64
    });
  });

  it("实测五日响应:原顺序保留(不排序),跨日边界首根(open=0/量额=0)不被误剔", async () => {
    stubJsonFetch(trends5dBoundary);

    const trends = await fetchTrends(instOf("au9999")[0], 5, KLINE_HOST);

    expect(trends.prevClose).toBe(892);
    // 源首根为填充根:open=0.00 但 close=926.01 > 0(实测坑;仅 close≤0 才剔除),量/额 0 是合法零值。
    expect(trends.points[0]).toEqual({
      time: "2026-09-25 23:56",
      price: 926.01,
      avgPrice: 0,
      volume: 0,
      open: 0,
      high: 926.01,
      low: 926.01
    });
    // 十根跨 09-25 → 09-26 两个交易日,顺序与源一致(分组交给渲染层)。
    expect(trends.points).toHaveLength(10);
    expect(trends.points.map((point) => point.time)).toEqual([
      "2026-09-25 23:56",
      "2026-09-25 23:57",
      "2026-09-25 23:58",
      "2026-09-25 23:59",
      "2026-09-26 00:00",
      "2026-09-26 00:01",
      "2026-09-26 00:02",
      "2026-09-26 00:03",
      "2026-09-26 00:04",
      "2026-09-26 00:05"
    ]);
  });

  it("异常行:close≤0 与取不到 close 的短行剔除、avg 非法 → null、缺段字段 → null", async () => {
    stubJsonFetch(trendsInvalidRows);

    const trends = await fetchTrends(instOf("au9999")[0], 5, KLINE_HOST);

    expect(trends.points).toEqual([
      // 填充根:close>0、量 0、均价 0.000(实测同形)保留;open=0 合法保留。
      {
        time: "2026-09-25 20:00",
        price: 926.01,
        avgPrice: 0,
        volume: 0,
        open: 0,
        high: 926.01,
        low: 926.01
      },
      // 4 段:close 有效保留,高/低/量/均价取不到 → null(open 段仍在)。
      {
        time: "2026-09-25 20:02",
        price: 926.05,
        avgPrice: null,
        volume: null,
        open: 0,
        high: null,
        low: null
      },
      // 均价为 "-" → null;高/低照常映射。
      {
        time: "2026-09-25 20:03",
        price: 926.1,
        avgPrice: null,
        volume: 120,
        open: 0,
        high: 926.1,
        low: 926.05
      },
      {
        time: "2026-09-25 20:04",
        price: 926.2,
        avgPrice: 926.15,
        volume: 300,
        open: 0,
        high: 926.2,
        low: 926.1
      }
    ]);
  });

  it("close=0 的根(实测坑)即使其余字段完整也被剔除", async () => {
    stubJsonFetch(trendsInvalidRows);

    const trends = await fetchTrends(instOf("au9999")[0], 5, KLINE_HOST);

    expect(trends.points.some((point) => point.time === "2026-09-25 20:01")).toBe(false);
  });

  it("data 为 null → { points: [], prevClose: null },不抛异常", async () => {
    stubJsonFetch(trendsDataNull);

    await expect(fetchTrends(instOf("sh000001")[0], 1, KLINE_HOST)).resolves.toEqual({
      points: [],
      prevClose: null
    });
  });

  it('preClose 非法(字符串 "-" / 缺失)→ null,points 仍正常解析', async () => {
    stubJsonFetch({
      rc: 0,
      data: {
        preClose: "-",
        trends: ["2026-10-09 09:30,3804.09,3804.09,3804.09,3804.09,3600224,5970630912.00,3806.883"]
      }
    });

    const trends = await fetchTrends(instOf("sh000001")[0], 1, KLINE_HOST);

    expect(trends.prevClose).toBeNull();
    expect(trends.points).toHaveLength(1);
  });

  it("请求 URL 拼装:ndays 传入、iscr=0 与实测字段表", async () => {
    const mock = stubJsonFetch(trends1d);

    await fetchTrends(instOf("sh000001")[0], 5, KLINE_HOST);

    expect(firstUrl(mock)).toBe(
      `${KLINE_HOST}/api/qt/stock/trends2/get?secid=1.000001` +
        "&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=5&iscr=0"
    );
  });

  it("host 传入时替换域名(缺省为 push2his 历史行情域)", async () => {
    const defaultMock = stubJsonFetch(trends1d);
    await fetchTrends(instOf("sh000001")[0], 1);
    expect(firstUrl(defaultMock)).toContain(`${KLINE_HOST}/api/qt/stock/trends2/get?`);

    const hostMock = stubJsonFetch(trends1d);
    await fetchTrends(instOf("sh000001")[0], 1, "push2his.example.com");
    expect(firstUrl(hostMock)).toContain("https://push2his.example.com/api/qt/stock/trends2/get?");
  });

  it("网络失败(fetchJson reject)原样透传", async () => {
    const networkError = new Error("HTTP 502");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw networkError;
      })
    );

    await expect(fetchTrends(instOf("sh000001")[0], 1)).rejects.toBe(networkError);
  });
});

describe("公共 CORS 代理 host(proxy: 前缀)", () => {
  const ALLORIGINS_TEMPLATE = "proxy:https://api.allorigins.win/raw?url={url}";
  const CODETABS_TEMPLATE = "proxy:https://api.codetabs.com/v1/proxy?quest={url}";

  it("fetchQuotes:目标为完整东财快照 URL(push2 主域),encodeURIComponent 后填入 {url}", async () => {
    // 先取直连 URL 作对照:代理的目标就是同一串完整 URL(响应体即东财原 JSON)。
    const directMock = stubJsonFetch(ulistSecidEcho);
    await fetchQuotes(instOf("au9999"), QUOTE_HOST);
    const directUrl = firstUrl(directMock);
    vi.unstubAllGlobals();

    const proxyMock = stubJsonFetch(ulistSecidEcho);
    await fetchQuotes(instOf("au9999"), ALLORIGINS_TEMPLATE);

    expect(firstUrl(proxyMock)).toBe(
      `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`
    );
    // 整串被编码:目标里的参数分隔符不能裸出现在代理 URL 中(? → %3F,& → %26)。
    expect(firstUrl(proxyMock)).not.toContain("&secids=");
    expect(firstUrl(proxyMock)).not.toContain("/api/qt/ulist.np/get?");
  });

  it("fetchKlines / fetchTrends:代理目标用 push2his 历史行情域,换模板(quest=)同样替换", async () => {
    const klineDirect = stubJsonFetch(klineDayLmt5);
    await fetchKlines(instOf("au9999")[0], "day", { limit: 5 }, KLINE_HOST);
    const klineUrl = firstUrl(klineDirect);
    vi.unstubAllGlobals();

    const klineProxy = stubJsonFetch(klineDayLmt5);
    await fetchKlines(instOf("au9999")[0], "day", { limit: 5 }, CODETABS_TEMPLATE);
    expect(firstUrl(klineProxy)).toBe(
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(klineUrl)}`
    );
    expect(klineUrl.startsWith(`${KLINE_HOST}/api/qt/stock/kline/get?`)).toBe(true);

    const trendsDirect = stubJsonFetch(trends1d);
    await fetchTrends(instOf("au9999")[0], 5, KLINE_HOST);
    const trendsUrl = firstUrl(trendsDirect);
    vi.unstubAllGlobals();

    const trendsProxy = stubJsonFetch(trends1d);
    await fetchTrends(instOf("au9999")[0], 5, ALLORIGINS_TEMPLATE);
    expect(firstUrl(trendsProxy)).toBe(
      `https://api.allorigins.win/raw?url=${encodeURIComponent(trendsUrl)}`
    );
  });

  it("代理响应正常解析:实测响应对解析结果与直连完全一致", async () => {
    const insts = instOf("au9999", "sh000001", "xau", "gc");
    stubJsonFetch(ulistSecidEcho);
    const viaDirect = await fetchQuotes(insts, QUOTE_HOST);
    vi.unstubAllGlobals();

    stubJsonFetch(ulistSecidEcho);
    const viaProxy = await fetchQuotes(insts, ALLORIGINS_TEMPLATE);

    expect(viaProxy).toEqual(viaDirect);
    expect(viaProxy[0]).toMatchObject({ instrumentId: "sh000001", price: 3813.79 });
    expect(viaProxy[2]).toMatchObject({ instrumentId: "xau", price: 4191.93 });
  });

  it("代理返回 HTML 错误页(响应体非 JSON)→ 抛「响应不是合法 JSON」原样透传", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token '<'");
          }
        } as unknown as Response;
      })
    );

    await expect(fetchKlines(instOf("au9999")[0], "day", {}, ALLORIGINS_TEMPLATE)).rejects.toThrow(
      /响应不是合法 JSON/
    );
  });

  it("代理 host 超时给到 15s(直连 10s):10s 时未中止、15s 时中止并抛超时", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init.signal as AbortSignal;
            signals.push(signal);
            signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          })
      )
    );

    const settled = fetchTrends(instOf("au9999")[0], 1, ALLORIGINS_TEMPLATE).then(
      () => null,
      (error: unknown) => error as Error
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signals[0].aborted).toBe(true);

    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("请求超时(15000ms)");
    vi.useRealTimers();
  });
});

describe("结构变形防御(fetchJson 已成功但响应形状不可用)", () => {
  it("非对象 / data 缺失 / 数组字段类型错误 → 各自返回空数据", async () => {
    const malformedPayloads = [
      "not-json-object",
      {},
      { data: {} },
      { data: { diff: {} } },
      { data: { klines: "2026-09-30,1,2,3,4,5,6" } },
      { data: { trends: 42 } }
    ];
    for (const payload of malformedPayloads) {
      stubJsonFetch(payload);
      await expect(fetchQuotes(instOf("au9999"))).resolves.toEqual([]);
      await expect(fetchKlines(instOf("au9999")[0], "day", {})).resolves.toEqual({
        bars: [],
        hasMore: false
      });
      await expect(fetchTrends(instOf("au9999")[0], 1)).resolves.toEqual({
        points: [],
        prevClose: null
      });
      vi.unstubAllGlobals();
    }
  });

  it("K 线数组内非字符串元素被跳过,其余正常解析", async () => {
    stubJsonFetch({
      data: {
        klines: [42, null, { time: "x" }, "2026-09-30,1,2,3,4,5,6"]
      }
    });

    const page = await fetchKlines(instOf("au9999")[0], "day", { limit: 1 });

    expect(page.bars).toEqual([
      {
        time: "2026-09-30",
        open: 1,
        close: 2,
        high: 3,
        low: 4,
        volume: 5,
        amount: 6,
        amplitudePct: null
      }
    ]);
    expect(page.hasMore).toBe(true);
  });
});
