// @vitest-environment node
import { AxiosError, type AxiosResponse } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getInstrument } from "../../src/api/market/config";
import { getKlines, getQuotes, getTrends } from "../../src/api/market/index";
import { resetServerUnavailableForTests } from "../../src/api/market/sources/server";
import type {
  InstrumentConfig,
  KlineBar,
  KlinePage,
  KlinePeriod,
  KlineRange,
  Quote,
  TrendDays,
  TrendSet
} from "../../src/api/market/types";
import { MarketError } from "../../src/api/market/types";
import klineDayLmt5 from "./fixtures/eastmoney/kline-day-lmt5.json";
import trends1d from "./fixtures/eastmoney/trends-1d.json";
import ulistSecidEcho from "./fixtures/eastmoney/ulist-secid-echo.json";

// facade 兜底链(依赖注入 mock 四个源 + mock 埋点 facade):
// server 转发(主源)→ 东财直连 → 腾讯 → gold-api,缺失语义(price 0 合法)、null 化占位、
// 顺序对齐、并发隔离。东财直连域名池的轮换与「指定 source 不经 server」见文末两组。
const h = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../../src/tracking", () => ({ track: h.track }));

// server 转发源真实实现在链路用例中运行(验证 facade → server 源 → controller 全链),
// MarketController 替身按「无 server 环境」缺省拒绝 404(axios 形态);需要 server 出数的
// 用例再 mockResolvedValue 东财上游 JSON 夹具。
const marketApi = vi.hoisted(() => ({
  getMarketQuote: vi.fn(),
  getMarketKline: vi.fn(),
  getMarketTrends: vi.fn(),
  getMarketSgeDaily: vi.fn()
}));
vi.mock("../../src/api/controllers.gen", () => ({ MarketController: marketApi }));

/** axios 形态的错误:模拟指定状态码的 HTTP 失败(404 = 静态托管无 server,5xx = 上游限流)。 */
function axiosErrorWithStatus(status: number): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    AxiosError.ERR_BAD_REQUEST,
    undefined,
    undefined,
    { status } as unknown as AxiosResponse
  );
}

// 兜底链内含退避重试(默认 800/2000ms):假时钟推进到结束,避免真实等待拖慢套件。
// 结果 Promise 立即挂上处理器,避免 runAllTimersAsync 期间被判定为 unhandled rejection。
async function withFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  type Outcome = { ok: true; value: T } | { ok: false; error: unknown };
  const outcome: Promise<Outcome> = run().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
  try {
    await vi.runAllTimersAsync();
    const settled = await outcome;
    if (!settled.ok) {
      throw settled.error;
    }
    return settled.value;
  } finally {
    vi.useRealTimers();
  }
}

function instsOf(...ids: string[]): InstrumentConfig[] {
  return ids.map((id) => {
    const inst = getInstrument(id);
    if (!inst) {
      throw new Error(`测试引用了不存在的标的: ${id}`);
    }
    return inst;
  });
}

function quoteOf(
  instrumentId: string,
  price: number | null,
  source: Quote["source"] = "eastmoney"
): Quote {
  return {
    instrumentId,
    price,
    change: 1,
    changePct: 1,
    amplitudePct: 1,
    open: 1,
    high: 1,
    low: 1,
    prevClose: 1,
    volume: 1,
    amount: 1,
    time: 1_700_000_000,
    source
  };
}

function bars(count: number): KlineBar[] {
  return Array.from({ length: count }, (_unused, index) => ({
    time: `2024-01-${String(index + 1).padStart(2, "0")}`,
    open: 1,
    close: 2,
    high: 3,
    low: 0.5,
    volume: 10,
    amount: 20
  }));
}

function klinePage(count: number): KlinePage {
  return { bars: bars(count), hasMore: false };
}

function trendSet(): TrendSet {
  return { points: [{ time: "09:30", price: 1, avgPrice: 1, volume: 2 }], prevClose: 0.9 };
}

const rejectWith = (message: string) => async (): Promise<never> => {
  throw new Error(message);
};

beforeEach(() => {
  h.track.mockReset();
  // server 源的会话级可用性记忆是模块级状态,逐用例重置;controller 替身缺省按
  // 「无 server 环境」拒绝 404(server 源首调置位禁用,后续调用快速跳过),
  // sge-daily 端点同口径拒绝(sge 源无会话禁用记忆,但 auto 链只在其前的步骤都失败后触达)。
  resetServerUnavailableForTests();
  marketApi.getMarketQuote.mockReset();
  marketApi.getMarketKline.mockReset();
  marketApi.getMarketTrends.mockReset();
  marketApi.getMarketSgeDaily.mockReset();
  marketApi.getMarketQuote.mockRejectedValue(axiosErrorWithStatus(404));
  marketApi.getMarketKline.mockRejectedValue(axiosErrorWithStatus(404));
  marketApi.getMarketTrends.mockRejectedValue(axiosErrorWithStatus(404));
  marketApi.getMarketSgeDaily.mockRejectedValue(axiosErrorWithStatus(404));
});

describe("getQuotes 兜底链", () => {
  it("server 批量成功:一次请求覆盖全部 secid,不请求东财/腾讯,无埋点", async () => {
    const insts = instsOf("au9999", "sh000001");
    const serverFetchQuotes = vi.fn(async (batch: InstrumentConfig[]) =>
      batch.map((inst) => quoteOf(inst.id, 500))
    );
    const eastmoneyFetchQuotes = vi.fn();
    const tencentFetchQuotes = vi.fn();
    const result = await getQuotes(insts, undefined, {
      server: { fetchQuotes: serverFetchQuotes },
      eastmoney: { fetchQuotes: eastmoneyFetchQuotes },
      tencent: { fetchQuotes: tencentFetchQuotes }
    });
    expect(serverFetchQuotes.mock.calls[0][0]).toBe(insts);
    expect(eastmoneyFetchQuotes).not.toHaveBeenCalled();
    expect(tencentFetchQuotes).not.toHaveBeenCalled();
    expect(result.map((quote) => [quote.instrumentId, quote.price])).toEqual([
      ["au9999", 500],
      ["sh000001", 500]
    ]);
    expect(h.track).not.toHaveBeenCalled();
  });

  it("server 失败 → 东财直连批量兜底,逐个缺失标的发 market_source_fallback(server→eastmoney)", async () => {
    const serverFetchQuotes = vi.fn(rejectWith("HTTP 000"));
    const eastmoneyFetchQuotes = vi.fn(rejectWith("HTTP 000"));
    const tencentFetchQuotes = vi.fn(async (batch: InstrumentConfig[]) =>
      batch.map((inst) => quoteOf(inst.id, 300, "tencent"))
    );
    const result = await withFakeTimers(() =>
      getQuotes(instsOf("xau", "sh000001"), undefined, {
        server: { fetchQuotes: serverFetchQuotes },
        eastmoney: { fetchQuotes: eastmoneyFetchQuotes },
        tencent: { fetchQuotes: tencentFetchQuotes }
      })
    );
    expect(serverFetchQuotes).toHaveBeenCalledTimes(1);
    expect(eastmoneyFetchQuotes).toHaveBeenCalledTimes(2); // 直连池 2 个域名:每个各试一次
    expect(eastmoneyFetchQuotes.mock.calls[0][0].map((inst) => inst.id)).toEqual([
      "xau",
      "sh000001"
    ]);
    expect(tencentFetchQuotes.mock.calls[0][0].map((inst) => inst.id)).toEqual(["xau", "sh000001"]);
    expect(result.every((quote) => quote.source === "tencent" && quote.price === 300)).toBe(true);
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "xau",
      kind: "quote",
      from: "server",
      to: "eastmoney"
    });
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "xau",
      kind: "quote",
      from: "eastmoney",
      to: "tencent"
    });
    expect(h.track).toHaveBeenCalledTimes(4); // 每个缺失标的 2 条:server→eastmoney、eastmoney→tencent
  });

  it("server 部分成功:只把缺失标的交给东财直连,顺序与入参对齐", async () => {
    const insts = instsOf("sh000001", "xau", "au9999");
    const serverFetchQuotes = vi.fn(async () => [quoteOf("xau", 500)]);
    const eastmoneyFetchQuotes = vi.fn(async (batch: InstrumentConfig[]) =>
      batch.filter((inst) => inst.id === "sh000001").map((inst) => quoteOf(inst.id, 300))
    );
    const result = await withFakeTimers(() =>
      getQuotes(insts, undefined, {
        server: { fetchQuotes: serverFetchQuotes },
        eastmoney: { fetchQuotes: eastmoneyFetchQuotes }
      })
    );
    // xau 已由 server 取到:东财只收缺失的 sh000001 与 au9999(保持入参序);
    // au9999 无 tencentCode / goldApiSymbol,东财也未出数 → null 化。
    expect(eastmoneyFetchQuotes.mock.calls[0][0].map((inst) => inst.id)).toEqual([
      "sh000001",
      "au9999"
    ]);
    expect(result.map((quote) => [quote.instrumentId, quote.price, quote.source])).toEqual([
      ["sh000001", 300, "eastmoney"],
      ["xau", 500, "eastmoney"],
      ["au9999", null, "eastmoney"]
    ]);
    expect(h.track).toHaveBeenCalledWith("market_data_error", {
      instrument_id: "au9999",
      kind: "quote",
      source: "eastmoney",
      message: expect.stringContaining("黄金9999")
    });
  });

  it("东财部分缺失:只把缺失且有 tencentCode 的标的交给腾讯", async () => {
    const insts = instsOf("sh000001", "xau", "au9999");
    const eastmoneyFetchQuotes = vi.fn(async () => [quoteOf("xau", 500)]);
    const tencentFetchQuotes = vi.fn(async (batch: InstrumentConfig[]) =>
      batch.map((inst) => quoteOf(inst.id, 300, "tencent"))
    );
    const result = await withFakeTimers(() =>
      getQuotes(insts, undefined, {
        server: { fetchQuotes: vi.fn(rejectWith("HTTP 000")) },
        eastmoney: { fetchQuotes: eastmoneyFetchQuotes },
        tencent: { fetchQuotes: tencentFetchQuotes }
      })
    );
    // au9999 无 tencentCode → 跳过腾讯,最终 null 化;其余走腾讯。
    expect(tencentFetchQuotes.mock.calls[0][0].map((inst) => inst.id)).toEqual(["sh000001"]);
    expect(result.map((quote) => [quote.instrumentId, quote.price, quote.source])).toEqual([
      ["sh000001", 300, "tencent"],
      ["xau", 500, "eastmoney"],
      ["au9999", null, "eastmoney"]
    ]);
    expect(h.track).toHaveBeenCalledWith("market_data_error", {
      instrument_id: "au9999",
      kind: "quote",
      source: "eastmoney",
      message: expect.stringContaining("黄金9999")
    });
  });

  it("server 与东财、腾讯都失败 → xau 走 gold-api 兜底", async () => {
    const goldApiFetchQuote = vi.fn(async (inst: InstrumentConfig) =>
      quoteOf(inst.id, 2000, "gold-api")
    );
    const result = await withFakeTimers(() =>
      getQuotes(instsOf("xau"), undefined, {
        server: { fetchQuotes: vi.fn(rejectWith("HTTP 000")) },
        eastmoney: { fetchQuotes: vi.fn(rejectWith("HTTP 000")) },
        tencent: { fetchQuotes: vi.fn(rejectWith("HTTP 502")) },
        goldApi: { fetchQuote: goldApiFetchQuote }
      })
    );
    expect(goldApiFetchQuote).toHaveBeenCalledTimes(1);
    expect(result[0]).toMatchObject({ instrumentId: "xau", price: 2000, source: "gold-api" });
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "xau",
      kind: "quote",
      from: "server",
      to: "eastmoney"
    });
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "xau",
      kind: "quote",
      from: "eastmoney",
      to: "tencent"
    });
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "xau",
      kind: "quote",
      from: "tencent",
      to: "gold-api"
    });
    expect(h.track).toHaveBeenCalledTimes(3);
  });

  it("全链失败 → null 化占位(price 全 null)并发 market_data_error", async () => {
    const result = await withFakeTimers(() =>
      getQuotes(instsOf("xau"), undefined, {
        server: { fetchQuotes: vi.fn(rejectWith("HTTP 000")) },
        eastmoney: { fetchQuotes: vi.fn(rejectWith("HTTP 000")) },
        tencent: { fetchQuotes: vi.fn(rejectWith("HTTP 502")) },
        goldApi: { fetchQuote: vi.fn(rejectWith("HTTP 503")) }
      })
    );
    expect(result).toEqual([
      {
        instrumentId: "xau",
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
        source: "gold-api"
      }
    ]);
    expect(h.track).toHaveBeenCalledWith("market_data_error", {
      instrument_id: "xau",
      kind: "quote",
      source: "gold-api",
      message: expect.stringContaining("伦敦金")
    });
  });

  it("有 tencentCode 但无 gold-api 兜底(gc):server/东财/腾讯都失败时归属腾讯,且不调用 gold-api", async () => {
    const goldApiFetchQuote = vi.fn();
    const result = await withFakeTimers(() =>
      getQuotes(instsOf("gc"), undefined, {
        server: { fetchQuotes: vi.fn(rejectWith("HTTP 000")) },
        eastmoney: { fetchQuotes: vi.fn(rejectWith("HTTP 000")) },
        tencent: { fetchQuotes: vi.fn(rejectWith("HTTP 502")) },
        goldApi: { fetchQuote: goldApiFetchQuote }
      })
    );
    expect(goldApiFetchQuote).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ instrumentId: "gc", price: null, source: "tencent" });
    expect(h.track).toHaveBeenCalledWith("market_data_error", {
      instrument_id: "gc",
      kind: "quote",
      source: "tencent",
      message: expect.stringContaining("COMEX黄金")
    });
  });

  it("price 为 0 是合法行情,不视为缺失(不再兜底)", async () => {
    const tencentFetchQuotes = vi.fn();
    const result = await withFakeTimers(() =>
      getQuotes(instsOf("sh000001"), undefined, {
        server: { fetchQuotes: vi.fn(rejectWith("HTTP 000")) },
        eastmoney: { fetchQuotes: vi.fn(async () => [quoteOf("sh000001", 0)]) },
        tencent: { fetchQuotes: tencentFetchQuotes }
      })
    );
    expect(result[0].price).toBe(0);
    expect(tencentFetchQuotes).not.toHaveBeenCalled();
  });

  it("空标的数组:直接返回空数组,不发任何请求与埋点", async () => {
    const serverFetchQuotes = vi.fn();
    const eastmoneyFetchQuotes = vi.fn();
    await expect(
      getQuotes([], undefined, {
        server: { fetchQuotes: serverFetchQuotes },
        eastmoney: { fetchQuotes: eastmoneyFetchQuotes }
      })
    ).resolves.toEqual([]);
    expect(serverFetchQuotes).not.toHaveBeenCalled();
    expect(eastmoneyFetchQuotes).not.toHaveBeenCalled();
    expect(h.track).not.toHaveBeenCalled();
  });

  it("并发两个 getQuotes 互不串结果", async () => {
    const gold = instsOf("au9999");
    const index = instsOf("sh000001");
    const [goldQuotes, indexQuotes] = await Promise.all([
      getQuotes(gold, undefined, {
        server: { fetchQuotes: vi.fn(rejectWith("HTTP 000")) },
        eastmoney: {
          fetchQuotes: vi.fn(async (batch: InstrumentConfig[]) =>
            batch.map((inst) => quoteOf(inst.id, 111))
          )
        }
      }),
      getQuotes(index, undefined, {
        server: { fetchQuotes: vi.fn(rejectWith("HTTP 000")) },
        eastmoney: {
          fetchQuotes: vi.fn(async (batch: InstrumentConfig[]) =>
            batch.map((inst) => quoteOf(inst.id, 222))
          )
        }
      })
    ]);
    expect(goldQuotes.map((quote) => [quote.instrumentId, quote.price])).toEqual([["au9999", 111]]);
    expect(indexQuotes.map((quote) => [quote.instrumentId, quote.price])).toEqual([
      ["sh000001", 222]
    ]);
    // server 失败 → 直连接管:每个标的各发一条 server→eastmoney 回退埋点。
    expect(h.track).toHaveBeenCalledTimes(2);
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "au9999",
      kind: "quote",
      from: "server",
      to: "eastmoney"
    });
  });
});

describe("getKlines 兜底链", () => {
  it("server 成功:hasMore 由「条数 === limit」判定,东财不被调用", async () => {
    const one = instsOf("au9999")[0];
    const eastmoneyFetchKlines = vi.fn();
    const page = await getKlines(one, "day", { limit: 1 }, undefined, {
      server: { fetchKlines: vi.fn(async () => klinePage(1)) },
      eastmoney: { fetchKlines: eastmoneyFetchKlines }
    });
    expect(page.bars).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(eastmoneyFetchKlines).not.toHaveBeenCalled();
    expect(h.track).not.toHaveBeenCalled();
  });

  it("limit 缺省按 200 判定 hasMore", async () => {
    const one = instsOf("au9999")[0];
    const eastmoneyFetchKlines = vi.fn(async () => klinePage(1));
    const page = await getKlines(one, "week", {}, undefined, {
      server: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
      eastmoney: { fetchKlines: eastmoneyFetchKlines }
    });
    expect(page.hasMore).toBe(false);
    expect(eastmoneyFetchKlines.mock.calls[0][2]).toEqual({});
  });

  it("server 失败、东财无数据(空 bars)→ 有非 hf_ tencentCode 时回落腾讯并发 kline 埋点", async () => {
    const one = instsOf("sh000001")[0];
    const page = await withFakeTimers(() =>
      getKlines(one, "day", { limit: 2 }, undefined, {
        server: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
        eastmoney: { fetchKlines: vi.fn(async () => klinePage(0)) },
        tencent: { fetchKlines: vi.fn(async () => klinePage(2)) }
      })
    );
    expect(page.bars).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "sh000001",
      kind: "kline",
      from: "server",
      to: "eastmoney"
    });
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "sh000001",
      kind: "kline",
      from: "eastmoney",
      to: "tencent"
    });
  });

  it("无 tencentCode 且 server 与东财都失败 → 落上金所兜底;上金所也失败 → 抛 MarketError(不回落腾讯)", async () => {
    const one = instsOf("au9999")[0];
    const tencentFetchKlines = vi.fn();
    await expect(
      withFakeTimers(() =>
        getKlines(one, "day", {}, undefined, {
          server: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
          eastmoney: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
          tencent: { fetchKlines: tencentFetchKlines },
          sge: { fetchKlines: vi.fn(rejectWith("HTTP 502")) }
        })
      )
    ).rejects.toBeInstanceOf(MarketError);
    expect(tencentFetchKlines).not.toHaveBeenCalled();
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "au9999",
      kind: "kline",
      from: "eastmoney",
      to: "sge"
    });
    expect(h.track).toHaveBeenCalledWith("market_data_error", {
      instrument_id: "au9999",
      kind: "kline",
      source: "sge",
      message: expect.stringContaining("黄金9999日 K 线获取失败")
    });
  });

  it("hf_ 外盘(xau)server 与东财都失败 → 不回落腾讯,落 PAXG 兜底且 source=paxg", async () => {
    const one = instsOf("xau")[0];
    const tencentFetchKlines = vi.fn();
    const page = await withFakeTimers(() =>
      getKlines(one, "month", {}, undefined, {
        server: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
        eastmoney: { fetchKlines: vi.fn(rejectWith("HTTP 502")) },
        tencent: { fetchKlines: tencentFetchKlines },
        binanceVision: { fetchKlines: vi.fn(async () => ({ ...klinePage(3), source: "paxg" })) }
      })
    );
    expect(tencentFetchKlines).not.toHaveBeenCalled();
    expect(page.bars).toHaveLength(3);
    expect(page.source).toBe("paxg");
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "xau",
      kind: "kline",
      from: "eastmoney",
      to: "paxg"
    });
  });

  it("三级都无数据(空 bars)→ 抛 MarketError", async () => {
    const one = instsOf("sh000001")[0];
    await expect(
      withFakeTimers(() =>
        getKlines(one, "week", {}, undefined, {
          server: { fetchKlines: vi.fn(async () => klinePage(0)) },
          eastmoney: { fetchKlines: vi.fn(async () => klinePage(0)) },
          tencent: { fetchKlines: vi.fn(async () => klinePage(0)) }
        })
      )
    ).rejects.toMatchObject({
      source: "tencent",
      message: expect.stringContaining("上证指数周 K 线获取失败")
    });
  });

  it("server 与东财、腾讯都请求失败 → MarketError 归属腾讯并带上失败摘要", async () => {
    const one = instsOf("sz399006")[0];
    await expect(
      withFakeTimers(() =>
        getKlines(one, "month", {}, undefined, {
          server: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
          eastmoney: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
          tencent: { fetchKlines: vi.fn(rejectWith("HTTP 502")) }
        })
      )
    ).rejects.toMatchObject({
      source: "tencent",
      message: expect.stringContaining("server 转发:HTTP 000;东财:HTTP 000;腾讯:HTTP 502")
    });
  });
});

describe("黄金 K 线专属兜底(au9999 → 上金所 / xau·gc → PAXG)", () => {
  // 指数标的(sh000001 等)无映射、不进专属兜底:既有「三级都失败归属腾讯」用例即其回归
  // (若指数误入专属兜底,错误归属会变成 sge / binance-vision 而非 tencent)。

  it("au9999 day:server 与东财都失败 → 上金所兜底成功,source=sge 透传,PAXG 不被调用", async () => {
    const sgeFetchKlines = vi.fn(async () => ({
      bars: [
        {
          time: "2026-10-09",
          open: 900,
          close: 904.48,
          high: 912,
          low: 884,
          volume: 0,
          amount: 0,
          amplitudePct: null
        }
      ],
      hasMore: false,
      source: "sge" as const
    }));
    const binanceVisionFetchKlines = vi.fn();
    const page = await withFakeTimers(() =>
      getKlines(
        instsOf("au9999")[0],
        "day",
        { beg: "20261001", end: "20261031", limit: 5000 },
        undefined,
        {
          server: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
          eastmoney: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
          sge: { fetchKlines: sgeFetchKlines },
          binanceVision: { fetchKlines: binanceVisionFetchKlines }
        }
      )
    );
    // 周期与 range 原样透传给 sge 源;专属兜底互斥(au9999 不落 PAXG)。
    expect(sgeFetchKlines.mock.calls[0][1]).toBe("day");
    expect(sgeFetchKlines.mock.calls[0][2]).toEqual({
      beg: "20261001",
      end: "20261031",
      limit: 5000
    });
    expect(binanceVisionFetchKlines).not.toHaveBeenCalled();
    expect(page.bars.map((bar) => bar.close)).toEqual([904.48]);
    expect(page.source).toBe("sge");
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "au9999",
      kind: "kline",
      from: "eastmoney",
      to: "sge"
    });
  });

  it("au9999 month:上金所兜底同样生效(周/月由源内聚合,facade 只透传周期)", async () => {
    const sgeFetchKlines = vi.fn(async () => ({
      bars: [
        {
          time: "2026-09-01",
          open: 880,
          close: 900,
          high: 905,
          low: 875,
          volume: 0,
          amount: 0,
          amplitudePct: null
        }
      ],
      hasMore: false,
      source: "sge" as const
    }));
    const page = await withFakeTimers(() =>
      getKlines(instsOf("au9999")[0], "month", {}, undefined, {
        server: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
        eastmoney: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
        sge: { fetchKlines: sgeFetchKlines }
      })
    );
    expect(sgeFetchKlines.mock.calls[0][1]).toBe("month");
    expect(page.source).toBe("sge");
  });

  it("gc:东财失败 → PAXG 兜底成功(hf_ 外盘跳过腾讯,source=paxg)", async () => {
    const binanceVisionFetchKlines = vi.fn(async () => ({
      ...klinePage(2),
      source: "paxg" as const
    }));
    const page = await withFakeTimers(() =>
      getKlines(instsOf("gc")[0], "week", {}, undefined, {
        server: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
        eastmoney: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
        binanceVision: { fetchKlines: binanceVisionFetchKlines }
      })
    );
    expect(page.bars).toHaveLength(2);
    expect(page.source).toBe("paxg");
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "gc",
      kind: "kline",
      from: "eastmoney",
      to: "paxg"
    });
  });

  it("上金所返回空数据:视为无数据、无更下一级 → MarketError(上金所无数据)", async () => {
    await expect(
      withFakeTimers(() =>
        getKlines(instsOf("au9999")[0], "day", {}, undefined, {
          server: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
          eastmoney: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
          sge: { fetchKlines: vi.fn(async () => klinePage(0)) }
        })
      )
    ).rejects.toMatchObject({
      source: "sge",
      message: expect.stringContaining("上金所无数据")
    });
  });

  it("真实 sge 模块接入链路:controller 404 透传为兜底失败,instid 固定 Au99.99", async () => {
    await expect(
      withFakeTimers(() =>
        getKlines(instsOf("au9999")[0], "day", {}, undefined, {
          server: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
          eastmoney: { fetchKlines: vi.fn(rejectWith("HTTP 000")) }
        })
      )
    ).rejects.toMatchObject({
      source: "sge",
      message: expect.stringContaining("上金所:Request failed with status code 404")
    });
    expect(marketApi.getMarketSgeDaily).toHaveBeenCalledWith({ instid: "Au99.99" });
  });
});

describe("getTrends 兜底链", () => {
  it("server 成功:结果原样透传,东财不被调用", async () => {
    const one = instsOf("sh000001")[0];
    const trends = trendSet();
    const eastmoneyFetchTrends = vi.fn();
    const result = await getTrends(one, 5, undefined, {
      server: { fetchTrends: vi.fn(async () => trends) },
      eastmoney: { fetchTrends: eastmoneyFetchTrends }
    });
    expect(result).toBe(trends);
    expect(eastmoneyFetchTrends).not.toHaveBeenCalled();
    expect(h.track).not.toHaveBeenCalled();
  });

  it("server 失败、东财失败 → 腾讯兜底(内盘指数可回落)", async () => {
    const one = instsOf("sz399006")[0];
    const result = await withFakeTimers(() =>
      getTrends(one, 1, undefined, {
        server: { fetchTrends: vi.fn(rejectWith("HTTP 000")) },
        eastmoney: { fetchTrends: vi.fn(rejectWith("HTTP 000")) },
        tencent: { fetchTrends: vi.fn(async () => trendSet()) }
      })
    );
    expect(result.points).toHaveLength(1);
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "sz399006",
      kind: "trends",
      from: "server",
      to: "eastmoney"
    });
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "sz399006",
      kind: "trends",
      from: "eastmoney",
      to: "tencent"
    });
  });

  it("server 失败、东财失败且腾讯无数据(空 points)→ 抛 MarketError", async () => {
    const one = instsOf("sh000001")[0];
    await expect(
      withFakeTimers(() =>
        getTrends(one, 1, undefined, {
          server: { fetchTrends: vi.fn(rejectWith("HTTP 000")) },
          eastmoney: { fetchTrends: vi.fn(rejectWith("HTTP 000")) },
          tencent: { fetchTrends: vi.fn(async () => ({ points: [], prevClose: null })) }
        })
      )
    ).rejects.toMatchObject({ source: "tencent" });
  });

  it("server 失败、东财无数据(空 points)且无内盘兜底(xau)→ 抛 MarketError", async () => {
    const one = instsOf("xau")[0];
    const tencentFetchTrends = vi.fn();
    await expect(
      getTrends(one, 1, undefined, {
        server: { fetchTrends: vi.fn(rejectWith("HTTP 000")) },
        eastmoney: { fetchTrends: vi.fn(async () => ({ points: [], prevClose: null })) },
        tencent: { fetchTrends: tencentFetchTrends }
      })
    ).rejects.toBeInstanceOf(MarketError);
    expect(tencentFetchTrends).not.toHaveBeenCalled();
    expect(h.track).toHaveBeenCalledWith("market_data_error", {
      instrument_id: "xau",
      kind: "trends",
      source: "eastmoney",
      message: expect.stringContaining("伦敦金当日分时获取失败")
    });
  });

  it("三级都失败(内盘指数)→ 抛 MarketError 且来源归属腾讯", async () => {
    const one = instsOf("sh000688")[0];
    await expect(
      withFakeTimers(() =>
        getTrends(one, 5, undefined, {
          server: { fetchTrends: vi.fn(rejectWith("HTTP 000")) },
          eastmoney: { fetchTrends: vi.fn(rejectWith("HTTP 000")) },
          tencent: { fetchTrends: vi.fn(rejectWith("HTTP 504")) }
        })
      )
    ).rejects.toMatchObject({ source: "tencent", name: "MarketError" });
  });
});

describe("数据源选项(options.source)", () => {
  it("source=eastmoney:只请求东财,腾讯与 gold-api 都不被调用", async () => {
    const insts = instsOf("xau", "sh000001");
    const tencentFetchQuotes = vi.fn();
    const goldApiFetchQuote = vi.fn();
    const result = await getQuotes(
      insts,
      { source: "eastmoney" },
      {
        eastmoney: {
          fetchQuotes: vi.fn(async (batch: InstrumentConfig[]) =>
            batch.map((inst) => quoteOf(inst.id, 500))
          )
        },
        tencent: { fetchQuotes: tencentFetchQuotes },
        goldApi: { fetchQuote: goldApiFetchQuote }
      }
    );

    expect(result.map((quote) => [quote.instrumentId, quote.price, quote.source])).toEqual([
      ["xau", 500, "eastmoney"],
      ["sh000001", 500, "eastmoney"]
    ]);
    expect(tencentFetchQuotes).not.toHaveBeenCalled();
    expect(goldApiFetchQuote).not.toHaveBeenCalled();
    expect(h.track).not.toHaveBeenCalled();
  });

  it("source=eastmoney 失败:缺失标的 null 占位(来源归属东财),不回落腾讯 / gold-api", async () => {
    const tencentFetchQuotes = vi.fn();
    const goldApiFetchQuote = vi.fn();
    const result = await withFakeTimers(() =>
      getQuotes(
        instsOf("xau"),
        { source: "eastmoney" },
        {
          eastmoney: { fetchQuotes: vi.fn(rejectWith("HTTP 000")) },
          tencent: { fetchQuotes: tencentFetchQuotes },
          goldApi: { fetchQuote: goldApiFetchQuote }
        }
      )
    );

    expect(result[0]).toMatchObject({ instrumentId: "xau", price: null, source: "eastmoney" });
    expect(tencentFetchQuotes).not.toHaveBeenCalled();
    expect(goldApiFetchQuote).not.toHaveBeenCalled();
    // 指定源模式没有回退发生:不发 market_source_fallback,只发最终失败埋点。
    expect(h.track).toHaveBeenCalledTimes(1);
    expect(h.track).toHaveBeenCalledWith("market_data_error", {
      instrument_id: "xau",
      kind: "quote",
      source: "eastmoney",
      message: expect.stringContaining("伦敦金")
    });
  });

  it("source=tencent:无 tencentCode 的标的(au9999)不参与请求、null 占位;有代码的只走腾讯", async () => {
    const eastmoneyFetchQuotes = vi.fn();
    const tencentFetchQuotes = vi.fn(async (batch: InstrumentConfig[]) =>
      batch.map((inst) => quoteOf(inst.id, 300, "tencent"))
    );
    const result = await getQuotes(
      instsOf("au9999", "sh000001"),
      { source: "tencent" },
      {
        eastmoney: { fetchQuotes: eastmoneyFetchQuotes },
        tencent: { fetchQuotes: tencentFetchQuotes }
      }
    );

    expect(eastmoneyFetchQuotes).not.toHaveBeenCalled();
    expect(tencentFetchQuotes.mock.calls[0][0].map((inst) => inst.id)).toEqual(["sh000001"]);
    expect(result.map((quote) => [quote.instrumentId, quote.price, quote.source])).toEqual([
      ["au9999", null, "tencent"],
      ["sh000001", 300, "tencent"]
    ]);
    expect(h.track).toHaveBeenCalledWith("market_data_error", {
      instrument_id: "au9999",
      kind: "quote",
      source: "tencent",
      message: expect.stringContaining("黄金9999")
    });
  });

  it("source=tencent 且入参全无 tencentCode:一次请求都不发,全部 null 占位", async () => {
    const tencentFetchQuotes = vi.fn();
    const result = await getQuotes(
      instsOf("au9999"),
      { source: "tencent" },
      {
        tencent: { fetchQuotes: tencentFetchQuotes }
      }
    );

    expect(tencentFetchQuotes).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ instrumentId: "au9999", price: null, source: "tencent" });
  });

  it("getKlines source=eastmoney:东财无数据即抛 MarketError(腾讯不被调用)", async () => {
    const tencentFetchKlines = vi.fn();
    await expect(
      getKlines(
        instsOf("sh000001")[0],
        "day",
        {},
        { source: "eastmoney" },
        {
          eastmoney: { fetchKlines: vi.fn(async () => klinePage(0)) },
          tencent: { fetchKlines: tencentFetchKlines }
        }
      )
    ).rejects.toMatchObject({
      name: "MarketError",
      source: "eastmoney",
      message: expect.stringContaining("上证指数日 K 线获取失败")
    });
    expect(tencentFetchKlines).not.toHaveBeenCalled();
    expect(h.track).toHaveBeenCalledWith("market_data_error", {
      instrument_id: "sh000001",
      kind: "kline",
      source: "eastmoney",
      message: expect.stringContaining("东财无数据")
    });
  });

  it("getKlines source=eastmoney 请求失败:MarketError 归属东财并带失败摘要", async () => {
    await expect(
      withFakeTimers(() =>
        getKlines(
          instsOf("sh000001")[0],
          "day",
          {},
          { source: "eastmoney" },
          { eastmoney: { fetchKlines: vi.fn(rejectWith("HTTP 000")) } }
        )
      )
    ).rejects.toMatchObject({
      source: "eastmoney",
      message: expect.stringContaining("东财:HTTP 000")
    });
  });

  it("getKlines source=tencent:只走腾讯并成功返回(东财不被调用)", async () => {
    const eastmoneyFetchKlines = vi.fn();
    const page = await getKlines(
      instsOf("sh000001")[0],
      "day",
      { limit: 2 },
      { source: "tencent" },
      {
        eastmoney: { fetchKlines: eastmoneyFetchKlines },
        tencent: { fetchKlines: vi.fn(async () => klinePage(2)) }
      }
    );

    expect(page.bars).toHaveLength(2);
    expect(eastmoneyFetchKlines).not.toHaveBeenCalled();
  });

  it.each(["au9999", "xau"] as const)(
    "getKlines source=tencent 且标的(%s)无内盘代码:直接抛 MarketError,不发请求",
    async (id) => {
      const tencentFetchKlines = vi.fn();
      await expect(
        getKlines(
          instsOf(id)[0],
          "day",
          {},
          { source: "tencent" },
          { tencent: { fetchKlines: tencentFetchKlines } }
        )
      ).rejects.toMatchObject({
        name: "MarketError",
        source: "tencent",
        message: expect.stringContaining("腾讯仅支持内盘指数代码")
      });
      expect(tencentFetchKlines).not.toHaveBeenCalled();
      expect(h.track).toHaveBeenCalledWith("market_data_error", {
        instrument_id: id,
        kind: "kline",
        source: "tencent",
        message: expect.any(String)
      });
    }
  );

  it("getTrends source=tencent:只走腾讯并成功返回(东财不被调用)", async () => {
    const eastmoneyFetchTrends = vi.fn();
    const result = await getTrends(
      instsOf("sz399006")[0],
      1,
      { source: "tencent" },
      {
        eastmoney: { fetchTrends: eastmoneyFetchTrends },
        tencent: { fetchTrends: vi.fn(async () => trendSet()) }
      }
    );

    expect(result.points).toHaveLength(1);
    expect(eastmoneyFetchTrends).not.toHaveBeenCalled();
  });

  it("getTrends source=tencent 且腾讯无数据(空 points):抛 MarketError 并带失败摘要", async () => {
    await expect(
      getTrends(
        instsOf("sh000001")[0],
        1,
        { source: "tencent" },
        {
          tencent: { fetchTrends: vi.fn(async () => ({ points: [], prevClose: null })) }
        }
      )
    ).rejects.toMatchObject({
      name: "MarketError",
      source: "tencent",
      message: expect.stringContaining("腾讯无数据")
    });
  });

  it("getTrends source=eastmoney 失败:抛 MarketError,不回落腾讯", async () => {
    const tencentFetchTrends = vi.fn();
    await expect(
      withFakeTimers(() =>
        getTrends(
          instsOf("sh000001")[0],
          5,
          { source: "eastmoney" },
          {
            eastmoney: { fetchTrends: vi.fn(rejectWith("HTTP 000")) },
            tencent: { fetchTrends: tencentFetchTrends }
          }
        )
      )
    ).rejects.toMatchObject({ source: "eastmoney" });
    expect(tencentFetchTrends).not.toHaveBeenCalled();
  });

  it("getTrends source=tencent 且 xau 为 hf_ 外盘:抛 MarketError,不发请求", async () => {
    const tencentFetchTrends = vi.fn();
    await expect(
      getTrends(
        instsOf("xau")[0],
        1,
        { source: "tencent" },
        {
          tencent: { fetchTrends: tencentFetchTrends }
        }
      )
    ).rejects.toMatchObject({ source: "tencent", name: "MarketError" });
    expect(tencentFetchTrends).not.toHaveBeenCalled();
  });

  it("options 与 overrides 共存:options 决定来源,overrides 决定实现", async () => {
    const eastmoneyFetchQuotes = vi.fn(async (batch: InstrumentConfig[]) =>
      batch.map((inst) => quoteOf(inst.id, 500))
    );
    const tencentFetchQuotes = vi.fn();
    const result = await getQuotes(
      instsOf("sh000001"),
      { source: "eastmoney" },
      {
        eastmoney: { fetchQuotes: eastmoneyFetchQuotes },
        tencent: { fetchQuotes: tencentFetchQuotes }
      }
    );

    expect(eastmoneyFetchQuotes).toHaveBeenCalledTimes(1);
    expect(tencentFetchQuotes).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ price: 500, source: "eastmoney" });
  });
});

describe("getKlines 范围查询(beg)", () => {
  it("range.beg 原样透传给适配器,范围模式 hasMore 恒 false(不受条数影响)", async () => {
    const eastmoneyFetchKlines = vi.fn(async () => klinePage(3));
    const range = { beg: "20250901", end: "20260901", limit: 2 };
    const page = await getKlines(instsOf("sh000001")[0], "day", range, undefined, {
      server: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
      eastmoney: { fetchKlines: eastmoneyFetchKlines }
    });

    expect(eastmoneyFetchKlines.mock.calls[0][2]).toBe(range);
    expect(page.bars).toHaveLength(3);
    expect(page.hasMore).toBe(false);
  });

  it("范围查询下东财无数据仍回落腾讯(beg 原样透传,hasMore 仍恒 false)", async () => {
    const tencentFetchKlines = vi.fn(async () => klinePage(2));
    const page = await getKlines(instsOf("sh000001")[0], "week", { beg: "20250101" }, undefined, {
      server: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
      eastmoney: { fetchKlines: vi.fn(async () => klinePage(0)) },
      tencent: { fetchKlines: tencentFetchKlines }
    });

    expect(tencentFetchKlines.mock.calls[0][2]).toEqual({ beg: "20250101" });
    expect(page.bars).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });

  it("beg 为空串等同未启用范围查询(空值边界,维持「条数 === limit」判定)", async () => {
    const eastmoneyFetchKlines = vi.fn(async () => klinePage(1));
    const page = await getKlines(instsOf("sh000001")[0], "day", { beg: "", limit: 1 }, undefined, {
      server: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
      eastmoney: { fetchKlines: eastmoneyFetchKlines }
    });

    expect(page.hasMore).toBe(true);
  });
});

describe("东财直连域名池(auto 链第二站)", () => {
  // 与 index.ts 的域名池一一对应(直连域名按端点分组;公共 CORS 代理传输层已移除,
  // 池内仅直连域名,东财全域不可达的场景由 server 转发主源承接)。
  const DIRECT_QUOTE_HOSTS = ["push2.eastmoney.com", "82.push2.eastmoney.com"];
  const DIRECT_HIS_HOSTS = ["push2his.eastmoney.com", "82.push2his.eastmoney.com"];

  it("auto 快照:server 失败后直连池按序轮换,第二个域名成功", async () => {
    const hostCalls: string[] = [];
    const eastmoneyFetchQuotes = vi.fn(async (batch: InstrumentConfig[], host?: string) => {
      hostCalls.push(String(host));
      if (host !== DIRECT_QUOTE_HOSTS[1]) {
        throw new Error("HTTP 000");
      }
      return batch.map((inst) => quoteOf(inst.id, 904.48));
    });

    const result = await withFakeTimers(() =>
      getQuotes(instsOf("au9999"), undefined, {
        server: { fetchQuotes: vi.fn(rejectWith("HTTP 000")) },
        eastmoney: { fetchQuotes: eastmoneyFetchQuotes }
      })
    );

    expect(hostCalls).toEqual(DIRECT_QUOTE_HOSTS);
    expect(result[0]).toMatchObject({ instrumentId: "au9999", price: 904.48, source: "eastmoney" });
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "au9999",
      kind: "quote",
      from: "server",
      to: "eastmoney"
    });
    expect(h.track).toHaveBeenCalledTimes(1);
  });

  it("auto K 线:server 失败后直连 push2his 域名池轮换取到数据", async () => {
    const hostCalls: string[] = [];
    const eastmoneyFetchKlines = vi.fn(
      async (
        _inst: InstrumentConfig,
        _period: KlinePeriod,
        _range: KlineRange,
        host?: string
      ): Promise<KlinePage> => {
        hostCalls.push(String(host));
        if (host !== DIRECT_HIS_HOSTS[1]) {
          throw new Error("HTTP 000");
        }
        return klinePage(2);
      }
    );

    const page = await withFakeTimers(() =>
      getKlines(instsOf("au9999")[0], "day", { limit: 2 }, undefined, {
        server: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
        eastmoney: { fetchKlines: eastmoneyFetchKlines }
      })
    );

    expect(hostCalls).toEqual(DIRECT_HIS_HOSTS);
    expect(page.bars).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });

  it("auto 分时:server 失败后直连池轮换取到分时", async () => {
    const hostCalls: string[] = [];
    const eastmoneyFetchTrends = vi.fn(
      async (_inst: InstrumentConfig, _ndays: TrendDays, host?: string): Promise<TrendSet> => {
        hostCalls.push(String(host));
        if (host !== DIRECT_HIS_HOSTS[1]) {
          throw new Error("HTTP 000");
        }
        return trendSet();
      }
    );

    const result = await withFakeTimers(() =>
      getTrends(instsOf("au9999")[0], 1, undefined, {
        server: { fetchTrends: vi.fn(rejectWith("HTTP 000")) },
        eastmoney: { fetchTrends: eastmoneyFetchTrends }
      })
    );

    expect(hostCalls).toEqual(DIRECT_HIS_HOSTS);
    expect(result.points).toHaveLength(1);
  });

  it("source=eastmoney:只用直连域名池(重试回首位,不经过 server)", async () => {
    const hostCalls: string[] = [];
    const eastmoneyFetchQuotes = vi.fn(async (_batch: InstrumentConfig[], host?: string) => {
      hostCalls.push(String(host));
      throw new Error("HTTP 000");
    });

    const result = await withFakeTimers(() =>
      getQuotes(
        instsOf("au9999"),
        { source: "eastmoney" },
        {
          eastmoney: { fetchQuotes: eastmoneyFetchQuotes }
        }
      )
    );

    expect(hostCalls).toEqual([...DIRECT_QUOTE_HOSTS, DIRECT_QUOTE_HOSTS[0]]);
    expect(result[0]).toMatchObject({ instrumentId: "au9999", price: null, source: "eastmoney" });
    expect(h.track).toHaveBeenCalledTimes(1);
    expect(h.track).toHaveBeenCalledWith("market_data_error", {
      instrument_id: "au9999",
      kind: "quote",
      source: "eastmoney",
      message: expect.stringContaining("黄金9999")
    });
  });

  it("getKlines source=eastmoney:host 池为 push2his 直连组", async () => {
    const hostCalls: string[] = [];
    const eastmoneyFetchKlines = vi.fn(
      async (
        _inst: InstrumentConfig,
        _period: KlinePeriod,
        _range: KlineRange,
        host?: string
      ): Promise<KlinePage> => {
        hostCalls.push(String(host));
        return klinePage(1);
      }
    );

    await getKlines(
      instsOf("au9999")[0],
      "day",
      { limit: 1 },
      { source: "eastmoney" },
      { eastmoney: { fetchKlines: eastmoneyFetchKlines } }
    );

    expect(hostCalls).toEqual([DIRECT_HIS_HOSTS[0]]);
  });

  it("直连全失败 + PAXG 也失败:xau 抛 MarketError(归属 PAXG 兜底源)并上报 market_data_error", async () => {
    const hostCalls: string[] = [];
    const eastmoneyFetchKlines = vi.fn(
      async (
        _inst: InstrumentConfig,
        _period: KlinePeriod,
        _range: KlineRange,
        host?: string
      ): Promise<KlinePage> => {
        hostCalls.push(String(host));
        throw new Error("HTTP 000");
      }
    );

    await expect(
      withFakeTimers(() =>
        getKlines(instsOf("xau")[0], "day", {}, undefined, {
          server: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
          eastmoney: { fetchKlines: eastmoneyFetchKlines },
          binanceVision: { fetchKlines: vi.fn(rejectWith("HTTP 503")) }
        })
      )
    ).rejects.toMatchObject({
      name: "MarketError",
      source: "binance-vision",
      message: expect.stringContaining("伦敦金日 K 线获取失败")
    });
    expect(hostCalls).toEqual(DIRECT_HIS_HOSTS);
    expect(h.track).toHaveBeenCalledWith("market_data_error", {
      instrument_id: "xau",
      kind: "kline",
      source: "binance-vision",
      message: expect.stringContaining("东财:HTTP 000;PAXG:HTTP 503")
    });
  });

  it("直连池无数据(bars 为空)不视为成功 → 落上金所兜底;上金所也无数据进错误态(空值边界)", async () => {
    const hostCalls: string[] = [];
    const eastmoneyFetchKlines = vi.fn(
      async (
        _inst: InstrumentConfig,
        _period: KlinePeriod,
        _range: KlineRange,
        host?: string
      ): Promise<KlinePage> => {
        hostCalls.push(String(host));
        if (host === DIRECT_HIS_HOSTS[0]) {
          throw new Error("HTTP 000");
        }
        // 第二个域名连通但无数据:调度器视为成功,facade 视为「无数据」继续兜底。
        return klinePage(0);
      }
    );

    await expect(
      withFakeTimers(() =>
        getKlines(instsOf("au9999")[0], "week", {}, undefined, {
          server: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
          eastmoney: { fetchKlines: eastmoneyFetchKlines },
          sge: { fetchKlines: vi.fn(async () => klinePage(0)) }
        })
      )
    ).rejects.toBeInstanceOf(MarketError);
    expect(hostCalls).toEqual(DIRECT_HIS_HOSTS);
    expect(h.track).toHaveBeenCalledWith("market_data_error", {
      instrument_id: "au9999",
      kind: "kline",
      source: "sge",
      message: expect.stringContaining("东财无数据;上金所无数据")
    });
  });
});

describe("server 转发源主源(auto 链首站)", () => {
  // server 源是 auto 链第 1 站(手动选源不经过);用例跑真实 server 源模块(经 MarketController
  // 替身供上游 JSON 夹具),SourceOverrides.server 注入单列一例。beforeEach 已把 controller
  // 替身置为「无 server 环境」缺省 404、重置会话级可用性记忆。

  it("getQuotes server 成功:全部标的一次批量,东财/腾讯/gold 都不被调用、无回退埋点", async () => {
    const insts = instsOf("xau", "sh000001");
    marketApi.getMarketQuote.mockResolvedValue(ulistSecidEcho);
    const eastmoneyFetchQuotes = vi.fn();
    const tencentFetchQuotes = vi.fn();
    const goldApiFetchQuote = vi.fn();

    const result = await getQuotes(insts, undefined, {
      eastmoney: { fetchQuotes: eastmoneyFetchQuotes },
      tencent: { fetchQuotes: tencentFetchQuotes },
      goldApi: { fetchQuote: goldApiFetchQuote }
    });

    // 批量一次、secids 按入参顺序拼接;数据来自东财上游 JSON,Quote.source 仍记 eastmoney。
    expect(marketApi.getMarketQuote).toHaveBeenCalledTimes(1);
    expect(marketApi.getMarketQuote.mock.calls[0][0]).toEqual({ secids: "122.XAU,1.000001" });
    expect(eastmoneyFetchQuotes).not.toHaveBeenCalled();
    expect(tencentFetchQuotes).not.toHaveBeenCalled();
    expect(goldApiFetchQuote).not.toHaveBeenCalled();
    expect(result.map((quote) => [quote.instrumentId, quote.price, quote.source])).toEqual([
      ["xau", 4191.93, "eastmoney"],
      ["sh000001", 3813.79, "eastmoney"]
    ]);
    expect(h.track).not.toHaveBeenCalled();
  });

  it("getQuotes server 禁用(404)→ 直连接管用,且同会话内后续调用不再打 controller", async () => {
    const overrides = {
      eastmoney: {
        fetchQuotes: vi.fn(async (batch: InstrumentConfig[]) =>
          batch.map((inst) => quoteOf(inst.id, 500))
        )
      }
    };

    const first = await getQuotes(instsOf("xau"), undefined, overrides);
    expect(first[0]).toMatchObject({ instrumentId: "xau", price: 500, source: "eastmoney" });
    expect(marketApi.getMarketQuote).toHaveBeenCalledTimes(1);
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "xau",
      kind: "quote",
      from: "server",
      to: "eastmoney"
    });

    // 同会话第二次:server 源已禁用,快速跳过(controller 调用数不增长),直连链照常。
    h.track.mockReset();
    const second = await getQuotes(instsOf("sh000001"), undefined, overrides);
    expect(second[0]).toMatchObject({ instrumentId: "sh000001", price: 500, source: "eastmoney" });
    expect(marketApi.getMarketQuote).toHaveBeenCalledTimes(1);
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "sh000001",
      kind: "quote",
      from: "server",
      to: "eastmoney"
    });
  });

  it("getQuotes server 5xx(上游限流)→ 不禁用、当次穿透到直连,下次轮询仍打 controller", async () => {
    marketApi.getMarketQuote
      .mockRejectedValueOnce(axiosErrorWithStatus(502))
      .mockResolvedValueOnce(ulistSecidEcho);
    const overrides = {
      eastmoney: {
        fetchQuotes: vi.fn(async (batch: InstrumentConfig[]) =>
          batch.map((inst) => quoteOf(inst.id, 500))
        )
      }
    };

    // 当次:server 5xx 失败穿透到东财直连。
    const first = await getQuotes(instsOf("xau"), undefined, overrides);
    expect(first[0]).toMatchObject({ instrumentId: "xau", price: 500, source: "eastmoney" });
    expect(marketApi.getMarketQuote).toHaveBeenCalledTimes(1);

    // 下次轮询:5xx 未禁用,server 源再次被打并成功(可恢复)。
    const second = await getQuotes(instsOf("xau"), undefined, overrides);
    expect(second[0]).toMatchObject({ instrumentId: "xau", price: 4191.93, source: "eastmoney" });
    expect(marketApi.getMarketQuote).toHaveBeenCalledTimes(2);
  });

  it("server 返回空数据(无该标的记录)→ 不视为成功,直连接管(空值边界)", async () => {
    const eastmoneyFetchQuotes = vi.fn(async (batch: InstrumentConfig[]) =>
      batch.map((inst) => quoteOf(inst.id, 500))
    );
    const result = await getQuotes(instsOf("xau"), undefined, {
      server: { fetchQuotes: vi.fn(async () => []) },
      eastmoney: { fetchQuotes: eastmoneyFetchQuotes }
    });

    expect(eastmoneyFetchQuotes).toHaveBeenCalledTimes(1);
    expect(result[0]).toMatchObject({ instrumentId: "xau", price: 500, source: "eastmoney" });
  });

  it("SourceOverrides.server 注入生效:auto 链首站收全部标的,成功时不进直连", async () => {
    const serverFetchQuotes = vi.fn(async (batch: InstrumentConfig[]) =>
      batch.map((inst) => quoteOf(inst.id, 700, "eastmoney"))
    );
    const eastmoneyFetchQuotes = vi.fn();

    const result = await getQuotes(instsOf("au9999"), undefined, {
      server: { fetchQuotes: serverFetchQuotes },
      eastmoney: { fetchQuotes: eastmoneyFetchQuotes }
    });

    expect(serverFetchQuotes.mock.calls[0][0].map((inst) => inst.id)).toEqual(["au9999"]);
    expect(eastmoneyFetchQuotes).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ instrumentId: "au9999", price: 700, source: "eastmoney" });
    expect(h.track).not.toHaveBeenCalled();
  });

  it("getKlines server 主源成功(xau 为 hf_ 外盘):东财/腾讯不被调用,无回退埋点", async () => {
    marketApi.getMarketKline.mockResolvedValue(klineDayLmt5);

    const page = await getKlines(instsOf("xau")[0], "day", { limit: 2 }, undefined, {
      eastmoney: { fetchKlines: vi.fn() },
      tencent: { fetchKlines: vi.fn() }
    });

    expect(marketApi.getMarketKline).toHaveBeenCalledTimes(1);
    expect(marketApi.getMarketKline.mock.calls[0][0]).toEqual({
      secid: "122.XAU",
      klt: 101,
      fqt: 0,
      lmt: 2
    });
    expect(page.bars.map((bar) => bar.time)).toEqual(["2026-10-08", "2026-10-09"]);
    expect(page.hasMore).toBe(true);
    expect(h.track).not.toHaveBeenCalled();
  });

  it("getKlines server 也失败 → MarketError 摘要含 server 转发一级,错误归属维持原口径", async () => {
    await expect(
      withFakeTimers(() =>
        getKlines(instsOf("sh000001")[0], "day", {}, undefined, {
          server: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
          eastmoney: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
          tencent: { fetchKlines: vi.fn(rejectWith("HTTP 502")) }
        })
      )
    ).rejects.toMatchObject({
      source: "tencent",
      message: expect.stringContaining("server 转发:HTTP 000;东财:HTTP 000;腾讯:HTTP 502")
    });
  });

  it("getTrends server 主源成功(内盘指数):东财/腾讯不被调用", async () => {
    marketApi.getMarketTrends.mockResolvedValue(trends1d);

    const result = await getTrends(instsOf("sh000001")[0], 1, undefined, {
      eastmoney: { fetchTrends: vi.fn() },
      tencent: { fetchTrends: vi.fn() }
    });

    expect(marketApi.getMarketTrends).toHaveBeenCalledTimes(1);
    expect(marketApi.getMarketTrends.mock.calls[0][0]).toEqual({ secid: "1.000001", ndays: 1 });
    expect(result.points).toHaveLength(10);
    expect(h.track).not.toHaveBeenCalled();
  });

  it("getTrends xau(腾讯分时不可用)→ server 主源成功(hf_ 外盘也能走)", async () => {
    marketApi.getMarketTrends.mockResolvedValue(trends1d);

    const result = await getTrends(instsOf("xau")[0], 5, undefined, {
      eastmoney: { fetchTrends: vi.fn() }
    });

    expect(result.points).toHaveLength(10);
    expect(h.track).not.toHaveBeenCalled();
  });

  it("手动选源不经过 server:source=eastmoney 成功 / 失败都不打 MarketController", async () => {
    const quotes = await getQuotes(
      instsOf("xau"),
      { source: "eastmoney" },
      {
        eastmoney: {
          fetchQuotes: vi.fn(async (batch: InstrumentConfig[]) =>
            batch.map((inst) => quoteOf(inst.id, 500))
          )
        }
      }
    );
    expect(quotes[0]).toMatchObject({ price: 500, source: "eastmoney" });
    expect(marketApi.getMarketQuote).not.toHaveBeenCalled();

    await expect(
      withFakeTimers(() =>
        getKlines(
          instsOf("sh000001")[0],
          "day",
          {},
          { source: "eastmoney" },
          { eastmoney: { fetchKlines: vi.fn(rejectWith("HTTP 000")) } }
        )
      )
    ).rejects.toMatchObject({ source: "eastmoney" });
    expect(marketApi.getMarketKline).not.toHaveBeenCalled();
  });
});
