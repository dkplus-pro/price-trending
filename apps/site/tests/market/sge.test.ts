// 上金所兜底源(sources/sge.ts)单测:mock MarketController(orval 生成物,经 vi.mock 替换
// controllers.gen),驱动「controller 返回上游 JSON → 行映射 → 过滤截断 / 聚合」全链路。
// (源是行情 auto 链的 au9999 专属兜底,链路顺序用例见 index.test.ts;本文件聚焦源内行为。)
//
// 上游行体例(实测固化):payload.time = [[日期, 开, 收, 低, 高], ...],升序全量;
// 注意低在高之前(与东财相反),映射不得对调。仅日 K、无量额(volume/amount 按 0 填充);
// 周/月由 aggregateDailyBars 客户端聚合。
//
// 六类边界覆盖:空值(payload.time 缺失 / 行数组为空 → 空 page)、零值(volume/amount 0、
// 振幅 0 保留)、越界(行不足 5 列 / 非数值跳过、beg/end 过滤与末 limit 根截断)、
// 配置缺失(非 Au 合约标的 → MarketError)、网络失败(controller reject 透传)、
// 非法状态(全 0 数据行 → MarketError「上金所返回无效数据」)。
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getInstrument } from "../../src/api/market/config";
import { fetchKlines, sgeInstIdFor } from "../../src/api/market/sources/sge";
import type { InstrumentConfig } from "../../src/api/market/types";
import { MarketError } from "../../src/api/market/types";

// MarketController 替身:sge 源只消费 getMarketSgeDaily。
const marketApi = vi.hoisted(() => ({
  getMarketQuote: vi.fn(),
  getMarketKline: vi.fn(),
  getMarketTrends: vi.fn(),
  getMarketSgeDaily: vi.fn()
}));
vi.mock("../../src/api/controllers.gen", () => ({ MarketController: marketApi }));

function instOf(id: string): InstrumentConfig {
  const inst = getInstrument(id);
  if (!inst) {
    throw new Error(`测试引用了不存在的标的: ${id}`);
  }
  return inst;
}

/** 上游行 [日期, 开, 收, 低, 高](字符串数值体例)。 */
function row(time: string, open: string, close: string, low: string, high: string): string[] {
  return [time, open, close, low, high];
}

/** 2026-10-05 是周一:构造连续两周的交易日行(周一至周五 + 下周一)。 */
function twoWeekRows(): string[][] {
  return [
    row("2026-10-05", "900", "910", "880", "920"),
    row("2026-10-06", "910", "915", "895", "925"),
    row("2026-10-07", "915", "905", "890", "930"),
    row("2026-10-08", "905", "900", "870", "910"),
    row("2026-10-09", "900", "904.48", "884", "912"),
    row("2026-10-12", "904", "908", "880", "915")
  ];
}

beforeEach(() => {
  marketApi.getMarketSgeDaily.mockReset();
});

describe("fetchKlines 请求参数", () => {
  it("instid 固定映射:au9999 → Au99.99(SGE 只认 Au 合约)", async () => {
    marketApi.getMarketSgeDaily.mockResolvedValue({ time: [] });
    await fetchKlines(instOf("au9999"), "day", {});
    expect(marketApi.getMarketSgeDaily).toHaveBeenCalledTimes(1);
    expect(marketApi.getMarketSgeDaily.mock.calls[0][0]).toEqual({ instid: "Au99.99" });
    expect(sgeInstIdFor(instOf("au9999"))).toBe("Au99.99");
  });

  it("配置缺失:非 Au 合约标的(xau)无映射 → 抛 MarketError,不发请求", async () => {
    await expect(fetchKlines(instOf("xau"), "day", {})).rejects.toBeInstanceOf(MarketError);
    expect(marketApi.getMarketSgeDaily).not.toHaveBeenCalled();
    expect(sgeInstIdFor(instOf("xau"))).toBeUndefined();
  });

  it("网络失败:controller reject 原样透传(facade 继续兜底 / 收口错误)", async () => {
    marketApi.getMarketSgeDaily.mockRejectedValue(new Error("Request failed with status code 502"));
    await expect(fetchKlines(instOf("au9999"), "day", {})).rejects.toThrow(
      "Request failed with status code 502"
    );
  });
});

describe("行映射(day)", () => {
  it("上游体例:[日期, 开, 收, 低, 高] 且低在高之前;volume/amount 按 0 填充;source=sge", async () => {
    marketApi.getMarketSgeDaily.mockResolvedValue({
      time: [row("2026-10-08", "900.00", "904.48", "880.00", "910.20")]
    });
    const page = await fetchKlines(instOf("au9999"), "day", {});
    // 低(880)在高(910.2)之前:映射不可对调。
    expect(page.bars[0]).toEqual({
      time: "2026-10-08",
      open: 900,
      close: 904.48,
      high: 910.2,
      low: 880,
      volume: 0,
      amount: 0,
      amplitudePct: null
    });
    expect(page.source).toBe("sge");
    expect(page.hasMore).toBe(false);
  });

  it("振幅按前一行收盘现算:保留两位;前收 0 → null;数值行也可解析(数字体例兼容)", async () => {
    marketApi.getMarketSgeDaily.mockResolvedValue({
      time: [
        ["2026-10-08", 900, 900, 900, 900],
        ["2026-10-09", "900", "904", "884", "914"]
      ]
    });
    const page = await fetchKlines(instOf("au9999"), "day", {});
    // 第 2 行:(914-884)/900×100 = 3.333… → 3.33。
    expect(page.bars.map((bar) => bar.amplitudePct)).toEqual([null, 3.33]);
  });

  it("非法行防御:不足 5 列 / 日期为空 / OHLC 非数值的行跳过,前收链不断", async () => {
    marketApi.getMarketSgeDaily.mockResolvedValue({
      time: [
        ["2026-10-08", "900", "900", "890", "910"],
        ["2026-10-09"],
        [null, "1", "1", "1", "1"],
        ["", "1", "1", "1", "1"],
        ["2026-10-10", "900", "900", "x", "910"],
        ["2026-10-13", "900", "906", "880", "912"]
      ]
    });
    const page = await fetchKlines(instOf("au9999"), "day", {});
    expect(page.bars.map((bar) => bar.time)).toEqual(["2026-10-08", "2026-10-13"]);
    expect(page.bars[1]).toMatchObject({ low: 880, high: 912 });
  });

  it("空值边界:payload.time 缺失 / 非数组 → 空 page 不抛;空行数组 → 空 page", async () => {
    marketApi.getMarketSgeDaily.mockResolvedValueOnce({ code: 0 });
    marketApi.getMarketSgeDaily.mockResolvedValueOnce({ time: [] });
    await expect(fetchKlines(instOf("au9999"), "day", {})).resolves.toEqual({
      bars: [],
      hasMore: false,
      source: "sge"
    });
    await expect(fetchKlines(instOf("au9999"), "day", {})).resolves.toEqual({
      bars: [],
      hasMore: false,
      source: "sge"
    });
  });

  it("非法状态:全部行 OHLC 为 0(错误 instid 的上游体例)→ 抛 MarketError「上金所返回无效数据」", async () => {
    marketApi.getMarketSgeDaily.mockResolvedValue({
      time: [row("2026-10-08", "0", "0", "0", "0"), row("2026-10-09", "0", "0", "0", "0")]
    });
    await expect(fetchKlines(instOf("au9999"), "day", {})).rejects.toMatchObject({
      source: "sge",
      message: "上金所返回无效数据"
    });
  });

  it("day 过滤截断:beg/end(YYYYMMDD)过滤区间后取末 limit 根;hasMore 恒 false", async () => {
    marketApi.getMarketSgeDaily.mockResolvedValue({
      time: twoWeekRows()
    });
    const page = await fetchKlines(instOf("au9999"), "day", {
      beg: "20261006",
      end: "20261009",
      limit: 2
    });
    expect(page.bars.map((bar) => bar.time)).toEqual(["2026-10-08", "2026-10-09"]);
    expect(page.hasMore).toBe(false);
  });
});

describe("周/月聚合(day → aggregateDailyBars)", () => {
  it("week:同 ISO 周归并为一根,time 取桶首根,量额按 0 求和,振幅按前桶 close 现算", async () => {
    marketApi.getMarketSgeDaily.mockResolvedValue({ time: twoWeekRows() });
    const page = await fetchKlines(instOf("au9999"), "week", {});
    expect(page.bars).toHaveLength(2);
    // 第 1 周(10-05 周一 ~ 10-09 周五):open=首根 900、close=末根 904.48、
    // high=max(920,925,930,910,912)=930、low=min(880,895,890,870,884)=870。
    expect(page.bars[0]).toEqual({
      time: "2026-10-05",
      open: 900,
      close: 904.48,
      high: 930,
      low: 870,
      volume: 0,
      amount: 0,
      amplitudePct: null
    });
    // 第 2 周(10-12 周一):振幅 = (915-880)/904.48×100 ≈ 3.87。
    expect(page.bars[1]).toMatchObject({ time: "2026-10-12", high: 915, low: 880 });
    expect(page.bars[1]?.amplitudePct).toBeCloseTo(3.87, 2);
  });

  it("month:跨月行按自然月分桶(月末月界),月桶 time 取桶内首个交易日", async () => {
    marketApi.getMarketSgeDaily.mockResolvedValue({
      time: [
        row("2026-01-30", "800", "810", "790", "820"),
        row("2026-01-31", "810", "815", "800", "818"),
        row("2026-02-02", "815", "820", "805", "825")
      ]
    });
    const page = await fetchKlines(instOf("au9999"), "month", {});
    expect(page.bars).toHaveLength(2);
    expect(page.bars[0]).toMatchObject({ time: "2026-01-30", open: 800, close: 815 });
    expect(page.bars[1]).toMatchObject({ time: "2026-02-02", open: 815, close: 820 });
    // 月桶振幅:第 2 桶 (825-805)/815×100 ≈ 2.45。
    expect(page.bars[0]?.amplitudePct).toBeNull();
    expect(page.bars[1]?.amplitudePct).toBeCloseTo(2.45, 2);
  });

  it("week 同样消费 beg/end 过滤与末 limit 根截断", async () => {
    marketApi.getMarketSgeDaily.mockResolvedValue({ time: twoWeekRows() });
    const page = await fetchKlines(instOf("au9999"), "week", {
      beg: "20261001",
      end: "20261031",
      limit: 1
    });
    expect(page.bars.map((bar) => bar.time)).toEqual(["2026-10-12"]);
  });
});
