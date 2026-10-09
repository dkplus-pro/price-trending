// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getInstrument } from "../../src/api/market/config";
import { getKlines, getQuotes, getTrends } from "../../src/api/market/index";
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

// facade 兜底链(依赖注入 mock 三个源 + mock 埋点 facade):
// 东财 → 腾讯 → gold-api,缺失语义(price 0 合法)、null 化占位、顺序对齐、并发隔离。
// 东财 auto 链的域名池(直连 → 公共 CORS 代理)与「指定 source 不试代理」见文末一组。
const h = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../../src/tracking", () => ({ track: h.track }));

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
});

describe("getQuotes 兜底链", () => {
  it("东财批量成功:一次请求覆盖全部 secid,不请求腾讯、无埋点", async () => {
    const insts = instsOf("au9999", "sh000001");
    const eastmoneyFetchQuotes = vi.fn(async (batch: InstrumentConfig[]) =>
      batch.map((inst) => quoteOf(inst.id, 500))
    );
    const tencentFetchQuotes = vi.fn();
    const result = await withFakeTimers(() =>
      getQuotes(insts, undefined, {
        eastmoney: { fetchQuotes: eastmoneyFetchQuotes },
        tencent: { fetchQuotes: tencentFetchQuotes }
      })
    );
    expect(eastmoneyFetchQuotes.mock.calls[0][0]).toBe(insts);
    expect(tencentFetchQuotes).not.toHaveBeenCalled();
    expect(result.map((quote) => [quote.instrumentId, quote.price])).toEqual([
      ["au9999", 500],
      ["sh000001", 500]
    ]);
    expect(h.track).not.toHaveBeenCalled();
  });

  it("东财失败 → 腾讯批量兜底,逐个缺失标的发 market_source_fallback", async () => {
    const eastmoneyFetchQuotes = vi.fn(rejectWith("HTTP 000"));
    const tencentFetchQuotes = vi.fn(async (batch: InstrumentConfig[]) =>
      batch.map((inst) => quoteOf(inst.id, 300, "tencent"))
    );
    const result = await withFakeTimers(() =>
      getQuotes(instsOf("xau", "sh000001"), undefined, {
        eastmoney: { fetchQuotes: eastmoneyFetchQuotes },
        tencent: { fetchQuotes: tencentFetchQuotes }
      })
    );
    expect(eastmoneyFetchQuotes).toHaveBeenCalledTimes(4); // auto 域名池 4 个(直连 2 + 代理 2):每个各试一次
    expect(tencentFetchQuotes.mock.calls[0][0].map((inst) => inst.id)).toEqual(["xau", "sh000001"]);
    expect(result.every((quote) => quote.source === "tencent" && quote.price === 300)).toBe(true);
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "xau",
      kind: "quote",
      from: "eastmoney",
      to: "tencent"
    });
    expect(h.track).toHaveBeenCalledTimes(2);
  });

  it("东财部分缺失:只把缺失且有 tencentCode 的标的交给腾讯,顺序与入参对齐", async () => {
    const insts = instsOf("sh000001", "xau", "au9999");
    const eastmoneyFetchQuotes = vi.fn(async () => [quoteOf("xau", 500)]);
    const tencentFetchQuotes = vi.fn(async (batch: InstrumentConfig[]) =>
      batch.map((inst) => quoteOf(inst.id, 300, "tencent"))
    );
    const result = await withFakeTimers(() =>
      getQuotes(insts, undefined, {
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

  it("东财与腾讯都失败 → xau 走 gold-api 兜底", async () => {
    const goldApiFetchQuote = vi.fn(async (inst: InstrumentConfig) =>
      quoteOf(inst.id, 2000, "gold-api")
    );
    const result = await withFakeTimers(() =>
      getQuotes(instsOf("xau"), undefined, {
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
      from: "tencent",
      to: "gold-api"
    });
    expect(h.track).toHaveBeenCalledTimes(2); // eastmoney→tencent、tencent→gold-api
  });

  it("三级全失败 → null 化占位(price 全 null)并发 market_data_error", async () => {
    const result = await withFakeTimers(() =>
      getQuotes(instsOf("xau"), undefined, {
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

  it("有 tencentCode 但无 gold-api 兜底(gc):两级都失败时归属腾讯,且不调用 gold-api", async () => {
    const goldApiFetchQuote = vi.fn();
    const result = await withFakeTimers(() =>
      getQuotes(instsOf("gc"), undefined, {
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
        eastmoney: { fetchQuotes: vi.fn(async () => [quoteOf("sh000001", 0)]) },
        tencent: { fetchQuotes: tencentFetchQuotes }
      })
    );
    expect(result[0].price).toBe(0);
    expect(tencentFetchQuotes).not.toHaveBeenCalled();
  });

  it("空标的数组:直接返回空数组,不发任何请求与埋点", async () => {
    const eastmoneyFetchQuotes = vi.fn();
    await expect(
      getQuotes([], undefined, { eastmoney: { fetchQuotes: eastmoneyFetchQuotes } })
    ).resolves.toEqual([]);
    expect(eastmoneyFetchQuotes).not.toHaveBeenCalled();
    expect(h.track).not.toHaveBeenCalled();
  });

  it("并发两个 getQuotes 互不串结果", async () => {
    const gold = instsOf("au9999");
    const index = instsOf("sh000001");
    const [goldQuotes, indexQuotes] = await withFakeTimers(() =>
      Promise.all([
        getQuotes(gold, undefined, {
          eastmoney: {
            fetchQuotes: vi.fn(async (batch: InstrumentConfig[]) =>
              batch.map((inst) => quoteOf(inst.id, 111))
            )
          }
        }),
        getQuotes(index, undefined, {
          eastmoney: {
            fetchQuotes: vi.fn(async (batch: InstrumentConfig[]) =>
              batch.map((inst) => quoteOf(inst.id, 222))
            )
          }
        })
      ])
    );
    expect(goldQuotes.map((quote) => [quote.instrumentId, quote.price])).toEqual([["au9999", 111]]);
    expect(indexQuotes.map((quote) => [quote.instrumentId, quote.price])).toEqual([
      ["sh000001", 222]
    ]);
    expect(h.track).not.toHaveBeenCalled();
  });
});

describe("getKlines 兜底链", () => {
  it("东财成功:hasMore 由「条数 === limit」判定", async () => {
    const one = instsOf("au9999")[0];
    const page = await getKlines(one, "day", { limit: 1 }, undefined, {
      eastmoney: { fetchKlines: vi.fn(async () => klinePage(1)) }
    });
    expect(page.bars).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });

  it("limit 缺省按 200 判定 hasMore", async () => {
    const one = instsOf("au9999")[0];
    const eastmoneyFetchKlines = vi.fn(async () => klinePage(1));
    const page = await getKlines(one, "week", {}, undefined, {
      eastmoney: { fetchKlines: eastmoneyFetchKlines }
    });
    expect(page.hasMore).toBe(false);
    expect(eastmoneyFetchKlines.mock.calls[0][2]).toEqual({});
  });

  it("东财无数据(空 bars)→ 有非 hf_ tencentCode 时回落腾讯并发 kline 埋点", async () => {
    const one = instsOf("sh000001")[0];
    const page = await getKlines(one, "day", { limit: 2 }, undefined, {
      eastmoney: { fetchKlines: vi.fn(async () => klinePage(0)) },
      tencent: { fetchKlines: vi.fn(async () => klinePage(2)) }
    });
    expect(page.bars).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "sh000001",
      kind: "kline",
      from: "eastmoney",
      to: "tencent"
    });
  });

  it("无 tencentCode 且东财失败 → 抛 MarketError(不发兜底埋点)", async () => {
    const one = instsOf("au9999")[0];
    const tencentFetchKlines = vi.fn();
    await expect(
      withFakeTimers(() =>
        getKlines(one, "day", {}, undefined, {
          eastmoney: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
          tencent: { fetchKlines: tencentFetchKlines }
        })
      )
    ).rejects.toBeInstanceOf(MarketError);
    expect(tencentFetchKlines).not.toHaveBeenCalled();
    expect(h.track).toHaveBeenCalledWith("market_data_error", {
      instrument_id: "au9999",
      kind: "kline",
      source: "eastmoney",
      message: expect.stringContaining("黄金9999日 K 线获取失败")
    });
  });

  it("hf_ 外盘(xau)东财失败 → 不回落腾讯,直接抛 MarketError", async () => {
    const one = instsOf("xau")[0];
    const tencentFetchKlines = vi.fn();
    await expect(
      withFakeTimers(() =>
        getKlines(one, "month", {}, undefined, {
          eastmoney: { fetchKlines: vi.fn(rejectWith("HTTP 502")) },
          tencent: { fetchKlines: tencentFetchKlines }
        })
      )
    ).rejects.toMatchObject({ source: "eastmoney" });
    expect(tencentFetchKlines).not.toHaveBeenCalled();
  });

  it("两级都无数据(空 bars)→ 抛 MarketError", async () => {
    const one = instsOf("sh000001")[0];
    await expect(
      getKlines(one, "week", {}, undefined, {
        eastmoney: { fetchKlines: vi.fn(async () => klinePage(0)) },
        tencent: { fetchKlines: vi.fn(async () => klinePage(0)) }
      })
    ).rejects.toMatchObject({
      source: "tencent",
      message: expect.stringContaining("上证指数周 K 线获取失败")
    });
  });

  it("东财与腾讯都请求失败 → MarketError 归属腾讯并带上失败摘要", async () => {
    const one = instsOf("sz399006")[0];
    await expect(
      withFakeTimers(() =>
        getKlines(one, "month", {}, undefined, {
          eastmoney: { fetchKlines: vi.fn(rejectWith("HTTP 000")) },
          tencent: { fetchKlines: vi.fn(rejectWith("HTTP 502")) }
        })
      )
    ).rejects.toMatchObject({
      source: "tencent",
      message: expect.stringContaining("东财:HTTP 000;腾讯:HTTP 502")
    });
  });
});

describe("getTrends 兜底链", () => {
  it("东财成功:结果原样透传", async () => {
    const one = instsOf("sh000001")[0];
    const trends = trendSet();
    const result = await getTrends(one, 5, undefined, {
      eastmoney: { fetchTrends: vi.fn(async () => trends) }
    });
    expect(result).toBe(trends);
    expect(h.track).not.toHaveBeenCalled();
  });

  it("东财失败 → 腾讯兜底(内盘指数可回落)", async () => {
    const one = instsOf("sz399006")[0];
    const result = await withFakeTimers(() =>
      getTrends(one, 1, undefined, {
        eastmoney: { fetchTrends: vi.fn(rejectWith("HTTP 000")) },
        tencent: { fetchTrends: vi.fn(async () => trendSet()) }
      })
    );
    expect(result.points).toHaveLength(1);
    expect(h.track).toHaveBeenCalledWith("market_source_fallback", {
      instrument_id: "sz399006",
      kind: "trends",
      from: "eastmoney",
      to: "tencent"
    });
  });

  it("东财失败且腾讯无数据(空 points)→ 抛 MarketError", async () => {
    const one = instsOf("sh000001")[0];
    await expect(
      withFakeTimers(() =>
        getTrends(one, 1, undefined, {
          eastmoney: { fetchTrends: vi.fn(rejectWith("HTTP 000")) },
          tencent: { fetchTrends: vi.fn(async () => ({ points: [], prevClose: null })) }
        })
      )
    ).rejects.toMatchObject({ source: "tencent" });
  });

  it("东财无数据(空 points)且无内盘兜底(xau)→ 抛 MarketError", async () => {
    const one = instsOf("xau")[0];
    const tencentFetchTrends = vi.fn();
    await expect(
      getTrends(one, 1, undefined, {
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

  it("两级都失败(内盘指数)→ 抛 MarketError 且来源归属腾讯", async () => {
    const one = instsOf("sh000688")[0];
    await expect(
      withFakeTimers(() =>
        getTrends(one, 5, undefined, {
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
      eastmoney: { fetchKlines: eastmoneyFetchKlines }
    });

    expect(eastmoneyFetchKlines.mock.calls[0][2]).toBe(range);
    expect(page.bars).toHaveLength(3);
    expect(page.hasMore).toBe(false);
  });

  it("范围查询下东财无数据仍回落腾讯(beg 原样透传,hasMore 仍恒 false)", async () => {
    const tencentFetchKlines = vi.fn(async () => klinePage(2));
    const page = await getKlines(instsOf("sh000001")[0], "week", { beg: "20250101" }, undefined, {
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
      eastmoney: { fetchKlines: eastmoneyFetchKlines }
    });

    expect(page.hasMore).toBe(true);
  });
});

describe("东财公共 CORS 代理兜底(auto 链末端)", () => {
  // 与 index.ts 的域名池一一对应(直连域名按端点分组,代理垫底)。
  const DIRECT_QUOTE_HOSTS = ["push2.eastmoney.com", "82.push2.eastmoney.com"];
  const DIRECT_HIS_HOSTS = ["push2his.eastmoney.com", "82.push2his.eastmoney.com"];
  const PROXY_HOSTS = [
    "proxy:https://api.allorigins.win/raw?url={url}",
    "proxy:https://api.codetabs.com/v1/proxy?quest={url}"
  ];

  const isProxy = (host: string): boolean => host.startsWith("proxy:");

  it("auto 快照:直连域名全失败 → 代理 host 按序兜底成功(直连在前、代理垫底)", async () => {
    const hostCalls: string[] = [];
    const eastmoneyFetchQuotes = vi.fn(async (batch: InstrumentConfig[], host?: string) => {
      hostCalls.push(String(host));
      if (host === undefined || !isProxy(host)) {
        throw new Error("HTTP 000");
      }
      return batch.map((inst) => quoteOf(inst.id, 904.48));
    });

    const result = await withFakeTimers(() =>
      getQuotes(instsOf("au9999"), undefined, { eastmoney: { fetchQuotes: eastmoneyFetchQuotes } })
    );

    expect(hostCalls).toEqual([...DIRECT_QUOTE_HOSTS, PROXY_HOSTS[0]]);
    expect(result[0]).toMatchObject({ instrumentId: "au9999", price: 904.48, source: "eastmoney" });
    expect(h.track).not.toHaveBeenCalled();
  });

  it("auto K 线:直连 push2his 域名全失败 → 代理 host 取到数据", async () => {
    const hostCalls: string[] = [];
    const eastmoneyFetchKlines = vi.fn(
      async (
        _inst: InstrumentConfig,
        _period: KlinePeriod,
        _range: KlineRange,
        host?: string
      ): Promise<KlinePage> => {
        hostCalls.push(String(host));
        if (host === undefined || !isProxy(host)) {
          throw new Error("HTTP 000");
        }
        return klinePage(2);
      }
    );

    const page = await withFakeTimers(() =>
      getKlines(instsOf("au9999")[0], "day", { limit: 2 }, undefined, {
        eastmoney: { fetchKlines: eastmoneyFetchKlines }
      })
    );

    expect(hostCalls).toEqual([...DIRECT_HIS_HOSTS, PROXY_HOSTS[0]]);
    expect(page.bars).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(h.track).not.toHaveBeenCalled();
  });

  it("auto 分时:直连全失败 → 代理 host 取到分时", async () => {
    const hostCalls: string[] = [];
    const eastmoneyFetchTrends = vi.fn(
      async (_inst: InstrumentConfig, _ndays: TrendDays, host?: string): Promise<TrendSet> => {
        hostCalls.push(String(host));
        if (host === undefined || !isProxy(host)) {
          throw new Error("HTTP 000");
        }
        return trendSet();
      }
    );

    const result = await withFakeTimers(() =>
      getTrends(instsOf("au9999")[0], 1, undefined, {
        eastmoney: { fetchTrends: eastmoneyFetchTrends }
      })
    );

    expect(hostCalls).toEqual([...DIRECT_HIS_HOSTS, PROXY_HOSTS[0]]);
    expect(result.points).toHaveLength(1);
    expect(h.track).not.toHaveBeenCalled();
  });

  it("source=eastmoney:只用直连域名池(重试回首位),代理 host 不被调用(单源语义不变)", async () => {
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
    expect(hostCalls.some(isProxy)).toBe(false);
    expect(result[0]).toMatchObject({ instrumentId: "au9999", price: null, source: "eastmoney" });
    expect(h.track).toHaveBeenCalledTimes(1);
    expect(h.track).toHaveBeenCalledWith("market_data_error", {
      instrument_id: "au9999",
      kind: "quote",
      source: "eastmoney",
      message: expect.stringContaining("黄金9999")
    });
  });

  it("getKlines source=eastmoney:host 池为 push2his 直连组,代理不参与", async () => {
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
    expect(hostCalls.some(isProxy)).toBe(false);
  });

  it("直连与代理全失败:xau 抛 MarketError 并上报 market_data_error(归属东财)", async () => {
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
          eastmoney: { fetchKlines: eastmoneyFetchKlines }
        })
      )
    ).rejects.toMatchObject({
      name: "MarketError",
      source: "eastmoney",
      message: expect.stringContaining("伦敦金日 K 线获取失败")
    });
    expect(hostCalls).toEqual([...DIRECT_HIS_HOSTS, ...PROXY_HOSTS]);
    expect(h.track).toHaveBeenCalledWith("market_data_error", {
      instrument_id: "xau",
      kind: "kline",
      source: "eastmoney",
      message: expect.stringContaining("东财:HTTP 000")
    });
  });

  it("代理返回空数据(bars 为空)不视为成功:走完直连后代理仍无数据 → 进错误态(空值边界)", async () => {
    const hostCalls: string[] = [];
    const eastmoneyFetchKlines = vi.fn(
      async (
        _inst: InstrumentConfig,
        _period: KlinePeriod,
        _range: KlineRange,
        host?: string
      ): Promise<KlinePage> => {
        hostCalls.push(String(host));
        if (host === undefined || !isProxy(host)) {
          throw new Error("HTTP 000");
        }
        return klinePage(0);
      }
    );

    await expect(
      getKlines(instsOf("au9999")[0], "week", {}, undefined, {
        eastmoney: { fetchKlines: eastmoneyFetchKlines }
      })
    ).rejects.toBeInstanceOf(MarketError);
    expect(hostCalls).toEqual([...DIRECT_HIS_HOSTS, PROXY_HOSTS[0]]);
    expect(h.track).toHaveBeenCalledWith("market_data_error", {
      instrument_id: "au9999",
      kind: "kline",
      source: "eastmoney",
      message: expect.stringContaining("东财无数据")
    });
  });
});
