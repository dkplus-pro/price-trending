// useChartData(图表取数编排)用例:mock facade 的 getKlines / getTrends,只验证编排语义。
// (InstrumentSection 的组件级交互由 instrument-section.test.tsx 覆盖,这里直接跑 hook。)
//
// 六类边界覆盖:空值(首轮无数据 → loading)、零值(无数据周期不误判)、
// 越界(非法 period 由 ChartPeriod 联合类型编译期挡住;范围模式无分页语义)、
// 配置缺失(指定腾讯源 + 无 tencentCode 的标的 → facade 抛错落图表错误态)、
// 网络失败(MarketError → error 态;有缓存数据时的刷新失败静默)、
// 非法状态(快速切周期 / 切范围 / 切数据源的迟到响应竞态守卫)。
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetKlines, mockGetTrends, requestOptions } = vi.hoisted(() => ({
  mockGetKlines: vi.fn(),
  mockGetTrends: vi.fn(),
  // useRequest 入参回放:断言分时轮询参数与 K 线不轮询。
  requestOptions: [] as Record<string, unknown>[]
}));

// facade 替身:签名与真实 facade 一致(getKlines(inst, period, range, options) / getTrends(inst, ndays, options))。
vi.mock("../../src/api/market/index", () => ({
  getKlines: mockGetKlines,
  getTrends: mockGetTrends
}));

// 部分 mock ahooks:useRequest 仍走真实实现,只额外记录每次渲染的 options。
vi.mock("ahooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ahooks")>();
  const useRequestSpy = (service: unknown, options?: unknown): unknown => {
    requestOptions.push((options ?? {}) as Record<string, unknown>);
    return (actual.useRequest as unknown as (s: unknown, o?: unknown) => unknown)(service, options);
  };
  return { ...actual, useRequest: useRequestSpy };
});

import { getInstrument } from "../../src/api/market/config";
import { MarketError } from "../../src/api/market/types";
import type {
  ChartPeriod,
  InstrumentConfig,
  KlineBar,
  KlinePage,
  KlineRange,
  TrendSet
} from "../../src/api/market/types";
import { shiftYyyymmdd } from "../../src/api/market/utils";
import { useChartData } from "../../src/components/market/use-chart-data";
import type { MarketSource } from "../../src/store/market-filter";

/** 范围 A(默认)与范围 B:切范围用例按这两个值区分取数。 */
const RANGE_A: [string, string] = ["2026-01-01", "2026-12-31"];
const RANGE_B: [string, string] = ["2025-01-01", "2025-12-31"];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function instrumentOf(id: string): InstrumentConfig {
  const found = getInstrument(id);
  if (found === undefined) {
    throw new Error(`测试标的配置缺失:${id}`);
  }
  return found;
}

// 会话内 K 线缓存是模块级 Map(见 use-chart-data.ts),用例之间必须用不同的
// `${id}:...` 键,否则前一个用例的缓存会串进下一个用例;这里给每个用例发唯一 id。
let uniqueInstrumentSeq = 0;
function uniqueInstrument(base = "sh000001"): InstrumentConfig {
  uniqueInstrumentSeq += 1;
  return { ...instrumentOf(base), id: `probe-${uniqueInstrumentSeq}` };
}

/** 自 start("YYYYMMDD")起连续 count 根日线(time 为 "YYYY-MM-DD",与源格式一致)。 */
function makeBars(start: string, count: number): KlineBar[] {
  return Array.from({ length: count }, (_unused, index) => {
    const ymd = shiftYyyymmdd(start, index);
    const close = 100 + index;
    return {
      time: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
      open: close - 1,
      close,
      high: close + 1,
      low: close - 2,
      volume: 1000 + index,
      amount: 100_000 + index
    };
  });
}

function makeTrendSet(): TrendSet {
  return {
    points: [
      { time: "2026-10-09 09:30", price: 100, avgPrice: 100, volume: 10 },
      { time: "2026-10-09 09:31", price: 101, avgPrice: 100.5, volume: 12 }
    ],
    prevClose: 99
  };
}

function pageOf(bars: KlineBar[], hasMore: boolean): KlinePage {
  return { bars, hasMore };
}

function lastRequestOptions(): Record<string, unknown> {
  const options = requestOptions[requestOptions.length - 1];
  if (options === undefined) {
    throw new Error("useRequest 尚未被调用");
  }
  return options;
}

beforeEach(() => {
  vi.clearAllMocks();
  requestOptions.length = 0;
});

describe("useChartData K 线范围取数", () => {
  it("日K:按日期范围取数(beg/end 去连字符 + limit 5000),auto 不传 options", async () => {
    const bars = makeBars("20260801", 30);
    mockGetKlines.mockResolvedValue(pageOf(bars, false));
    const instrument = uniqueInstrument("sh000001");
    const { result } = renderHook(() => useChartData(instrument, "day", RANGE_A, "auto"));

    expect(result.current.mode).toBe("kline");
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetKlines).toHaveBeenCalledWith(
      instrument,
      "day",
      { beg: "20260101", end: "20261231", limit: 5000 },
      undefined
    );
    expect(result.current.bars).toBe(bars);
    expect(result.current.error).toBeNull();
    // K 线三档不轮询(只有分时两档 60s 轮询)。
    expect(lastRequestOptions().pollingInterval).toBe(0);
  });

  it("周K / 月K 同样走范围查询(period 原样透传)", async () => {
    mockGetKlines.mockResolvedValue(pageOf(makeBars("20260105", 4), false));
    const instrument = uniqueInstrument("sz399006");
    const { rerender } = renderHook(
      ({ period }: { period: ChartPeriod }) =>
        useChartData(instrument, period, RANGE_A, "eastmoney"),
      { initialProps: { period: "week" as ChartPeriod } }
    );
    await waitFor(() => expect(mockGetKlines).toHaveBeenCalledTimes(1));
    expect(mockGetKlines.mock.calls[0][1]).toBe("week");
    expect(mockGetKlines.mock.calls[0][2]).toEqual({
      beg: "20260101",
      end: "20261231",
      limit: 5000
    });

    rerender({ period: "month" });
    await waitFor(() => expect(mockGetKlines).toHaveBeenCalledTimes(2));
    expect(mockGetKlines.mock.calls[1][1]).toBe("month");
    expect(mockGetKlines.mock.calls[1][3]).toEqual({ source: "eastmoney" });
  });

  it("数据源选择透传:指定源传 { source },auto 传 undefined;切源触发重新取数", async () => {
    mockGetKlines.mockResolvedValue(pageOf(makeBars("20260801", 5), false));
    const instrument = uniqueInstrument("sh000001");
    const { rerender } = renderHook(
      ({ source }: { source: MarketSource }) => useChartData(instrument, "day", RANGE_A, source),
      { initialProps: { source: "eastmoney" as MarketSource } }
    );
    await waitFor(() => expect(mockGetKlines).toHaveBeenCalledTimes(1));
    expect(mockGetKlines.mock.calls[0][3]).toEqual({ source: "eastmoney" });

    rerender({ source: "tencent" });
    await waitFor(() => expect(mockGetKlines).toHaveBeenCalledTimes(2));
    expect(mockGetKlines.mock.calls[1][3]).toEqual({ source: "tencent" });

    rerender({ source: "auto" });
    await waitFor(() => expect(mockGetKlines).toHaveBeenCalledTimes(3));
    expect(mockGetKlines.mock.calls[2][3]).toBeUndefined();
  });
});

describe("useChartData 分时两档", () => {
  it("minute → getTrends(1) 带 prevClose 与数据源,60s 轮询;fiveday → getTrends(5) 不传 prevClose", async () => {
    mockGetTrends.mockResolvedValue(makeTrendSet());
    const instrument = uniqueInstrument("sz399006");
    const { result, rerender } = renderHook(
      ({ period }: { period: ChartPeriod }) => useChartData(instrument, period, RANGE_A, "tencent"),
      { initialProps: { period: "minute" as ChartPeriod } }
    );

    await waitFor(() => expect(result.current.trendPoints).toHaveLength(2));
    expect(mockGetTrends).toHaveBeenCalledWith(instrument, 1, { source: "tencent" });
    expect(result.current.mode).toBe("trend");
    expect(result.current.prevClose).toBe(99);
    expect(lastRequestOptions().pollingInterval).toBe(60_000);
    expect(lastRequestOptions().pollingWhenHidden).toBe(false);

    rerender({ period: "fiveday" });
    await waitFor(() => expect(mockGetTrends).toHaveBeenCalledTimes(2));
    expect(mockGetTrends.mock.calls[1][1]).toBe(5);
    await waitFor(() => expect(result.current.prevClose).toBeUndefined());
    expect(result.current.mode).toBe("trend");
  });

  it("分时忽略日期范围:切范围不重取(60s 轮询不被打断)", async () => {
    mockGetTrends.mockResolvedValue(makeTrendSet());
    const instrument = uniqueInstrument("sh000001");
    const { rerender } = renderHook(
      ({ dateRange }: { dateRange: [string, string] }) =>
        useChartData(instrument, "minute", dateRange, "auto"),
      { initialProps: { dateRange: RANGE_A } }
    );
    await waitFor(() => expect(mockGetTrends).toHaveBeenCalledTimes(1));

    rerender({ dateRange: RANGE_B });
    rerender({ dateRange: RANGE_A });
    expect(mockGetTrends).toHaveBeenCalledTimes(1);
    expect(mockGetTrends.mock.calls[0][2]).toBeUndefined();
  });
});

describe("useChartData 会话缓存", () => {
  it("切走再切回同范围同源:命中缓存立即渲染(不 loading)并后台刷新", async () => {
    const bars = makeBars("20260801", 30);
    mockGetTrends.mockResolvedValue(makeTrendSet());
    mockGetKlines.mockResolvedValue(pageOf(bars, false));
    const instrument = uniqueInstrument("sh000688");
    const { result, rerender } = renderHook(
      ({ period }: { period: ChartPeriod }) => useChartData(instrument, period, RANGE_A, "auto"),
      { initialProps: { period: "day" as ChartPeriod } }
    );
    await waitFor(() => expect(result.current.bars).toBe(bars));

    rerender({ period: "minute" });
    await waitFor(() => expect(result.current.mode).toBe("trend"));

    // 回到日K:刷新请求挂着不落地,缓存数据仍立即渲染且不显示 loading。
    mockGetKlines.mockReturnValue(createDeferred<KlinePage>().promise);
    rerender({ period: "day" });
    await waitFor(() => expect(result.current.bars).toBe(bars));
    expect(result.current.loading).toBe(false);
    expect(result.current.mode).toBe("kline");
    expect(mockGetKlines).toHaveBeenCalledTimes(2);
  });

  it("缓存 key 区分范围与数据源:换了范围 / 数据源一律重新取数(不显示旧组合数据)", async () => {
    const barsA = makeBars("20260801", 10);
    mockGetKlines
      .mockResolvedValueOnce(pageOf(barsA, false))
      .mockReturnValue(createDeferred<KlinePage>().promise);
    const instrument = uniqueInstrument("au9999");
    const { result, rerender } = renderHook(
      ({ dateRange, source }: { dateRange: [string, string]; source: MarketSource }) =>
        useChartData(instrument, "day", dateRange, source),
      { initialProps: { dateRange: RANGE_A, source: "auto" as MarketSource } }
    );
    await waitFor(() => expect(result.current.bars).toBe(barsA));

    // 换范围:key 不同 → 不命中缓存,新数据未回来前保持骨架态(不闪旧范围数据)。
    rerender({ dateRange: RANGE_B, source: "auto" });
    await waitFor(() => expect(mockGetKlines).toHaveBeenCalledTimes(2));
    expect(result.current.loading).toBe(true);
    expect(result.current.bars).toBeUndefined();

    // 范围切回 A 但换数据源:同样不命中缓存(A 的缓存 key 带 auto)。
    rerender({ dateRange: RANGE_A, source: "tencent" });
    await waitFor(() => expect(mockGetKlines).toHaveBeenCalledTimes(3));
    expect(result.current.loading).toBe(true);
    expect(result.current.bars).toBeUndefined();
    expect(mockGetKlines.mock.calls[2][2]).toEqual({
      beg: "20260101",
      end: "20261231",
      limit: 5000
    });
    expect(mockGetKlines.mock.calls[2][3]).toEqual({ source: "tencent" });
  });
});

describe("useChartData 错误态", () => {
  it("MarketError → error 态(不带数据),retry 重新取数并恢复", async () => {
    const instrument = uniqueInstrument("xau");
    mockGetKlines.mockRejectedValueOnce(
      new MarketError("eastmoney", "伦敦金日 K 线获取失败(东财:请求超时)")
    );
    const { result } = renderHook(() => useChartData(instrument, "day", RANGE_A, "auto"));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toContain("伦敦金日 K 线获取失败");
    expect(result.current.loading).toBe(false);
    expect(result.current.bars).toBeUndefined();

    const bars = makeBars("20260801", 5);
    mockGetKlines.mockResolvedValueOnce(pageOf(bars, false));
    act(() => {
      result.current.retry();
    });
    // retry 会同步清错,这里必须等数据落地再断言(否则会读到清错后的空数据)。
    await waitFor(() => expect(result.current.bars).toBe(bars));
    expect(result.current.error).toBeNull();
  });

  it("配置缺失(无 tencentCode 的标的 + 指定腾讯源):facade 抛错 → 图表错误态", async () => {
    const instrument = instrumentOf("au9999");
    mockGetKlines.mockRejectedValueOnce(
      new MarketError("tencent", "黄金9999日 K 线获取失败(腾讯仅支持内盘指数代码)")
    );
    const { result } = renderHook(() => useChartData(instrument, "day", RANGE_A, "tencent"));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toContain("腾讯仅支持内盘指数代码");
    expect(mockGetKlines.mock.calls[0][3]).toEqual({ source: "tencent" });
    expect(result.current.loading).toBe(false);
  });

  it("已有可展示数据(缓存命中)时的刷新失败静默:保留旧数据且不置错", async () => {
    const instrument = uniqueInstrument("sh000001");
    const bars = makeBars("20260301", 20);
    mockGetTrends.mockResolvedValue(makeTrendSet());
    mockGetKlines.mockResolvedValueOnce(pageOf(bars, false));
    const { result, rerender } = renderHook(
      ({ period }: { period: ChartPeriod }) => useChartData(instrument, period, RANGE_A, "auto"),
      { initialProps: { period: "day" as ChartPeriod } }
    );
    await waitFor(() => expect(result.current.bars).toBe(bars));

    rerender({ period: "minute" });
    await waitFor(() => expect(result.current.mode).toBe("trend"));

    mockGetKlines.mockRejectedValueOnce(new MarketError("eastmoney", "刷新失败"));
    rerender({ period: "day" });
    await waitFor(() => expect(mockGetKlines).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.bars).toBe(bars));
    expect(result.current.error).toBeNull();
  });
});

describe("useChartData 竞态守卫", () => {
  it("快速切周期:被放弃周期(含首轮分时)的迟到响应不覆盖当前周期数据", async () => {
    const minuteDeferred = createDeferred<TrendSet>();
    const dayDeferred = createDeferred<KlinePage>();
    const weekDeferred = createDeferred<KlinePage>();
    mockGetTrends.mockReturnValue(minuteDeferred.promise);
    mockGetKlines.mockImplementation((_instrument: InstrumentConfig, period: ChartPeriod) =>
      period === "day" ? dayDeferred.promise : weekDeferred.promise
    );

    const instrument = uniqueInstrument("sz399006");
    const { result, rerender } = renderHook(
      ({ period }: { period: ChartPeriod }) => useChartData(instrument, period, RANGE_A, "auto"),
      { initialProps: { period: "minute" as ChartPeriod } }
    );
    await waitFor(() => expect(mockGetTrends).toHaveBeenCalledTimes(1));

    rerender({ period: "day" });
    await waitFor(() => expect(mockGetKlines).toHaveBeenCalledTimes(1));
    rerender({ period: "week" });
    await waitFor(() => expect(mockGetKlines).toHaveBeenCalledTimes(2));

    // 中间周期(日K)先返回:必须被丢弃,图表保持骨架态。
    const dayBars = makeBars("20260601", 12);
    await act(async () => {
      dayDeferred.resolve(pageOf(dayBars, false));
      await dayDeferred.promise;
    });
    expect(result.current.bars).toBeUndefined();
    expect(result.current.loading).toBe(true);

    // 目标周期(周K)返回:正常渲染。
    const weekBars = makeBars("20260105", 9);
    await act(async () => {
      weekDeferred.resolve(pageOf(weekBars, false));
      await weekDeferred.promise;
    });
    await waitFor(() => expect(result.current.bars).toBe(weekBars));
    expect(result.current.loading).toBe(false);

    // 首轮分时最后迟到:仍不能覆盖周K。
    await act(async () => {
      minuteDeferred.resolve(makeTrendSet());
      await minuteDeferred.promise;
    });
    expect(result.current.mode).toBe("kline");
    expect(result.current.bars).toBe(weekBars);
    expect(result.current.trendPoints).toBeUndefined();
  });

  it("快速切范围(同一周期):被放弃范围的迟到响应不覆盖当前范围数据", async () => {
    const rangeADeferred = createDeferred<KlinePage>();
    const rangeBDeferred = createDeferred<KlinePage>();
    mockGetKlines.mockImplementation(
      (_instrument: InstrumentConfig, _period: ChartPeriod, range: KlineRange) =>
        range.beg === "20260101" ? rangeADeferred.promise : rangeBDeferred.promise
    );

    const instrument = uniqueInstrument("sh000001");
    const { result, rerender } = renderHook(
      ({ dateRange }: { dateRange: [string, string] }) =>
        useChartData(instrument, "day", dateRange, "auto"),
      { initialProps: { dateRange: RANGE_A } }
    );
    await waitFor(() => expect(mockGetKlines).toHaveBeenCalledTimes(1));

    rerender({ dateRange: RANGE_B });
    await waitFor(() => expect(mockGetKlines).toHaveBeenCalledTimes(2));

    // 旧范围迟到:丢弃,保持骨架态。
    await act(async () => {
      rangeADeferred.resolve(pageOf(makeBars("20260101", 5), false));
      await rangeADeferred.promise;
    });
    expect(result.current.bars).toBeUndefined();
    expect(result.current.loading).toBe(true);

    // 当前范围返回:正常渲染。
    const rangeBBars = makeBars("20250701", 3);
    await act(async () => {
      rangeBDeferred.resolve(pageOf(rangeBBars, false));
      await rangeBDeferred.promise;
    });
    await waitFor(() => expect(result.current.bars).toBe(rangeBBars));
    expect(result.current.loading).toBe(false);
  });

  it("手动 retry 与在飞取数并发:旧响应不覆盖重试结果", async () => {
    const stale = createDeferred<KlinePage>();
    mockGetKlines.mockReturnValueOnce(stale.promise);
    const instrument = uniqueInstrument("gc");
    const { result } = renderHook(() => useChartData(instrument, "week", RANGE_A, "auto"));
    await waitFor(() => expect(mockGetKlines).toHaveBeenCalledTimes(1));

    const freshBars = makeBars("20260701", 8);
    mockGetKlines.mockResolvedValueOnce(pageOf(freshBars, false));
    act(() => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.bars).toBe(freshBars));

    await act(async () => {
      stale.resolve(pageOf(makeBars("20200101", 3), false));
      await stale.promise;
    });
    expect(result.current.bars).toBe(freshBars);
    expect(result.current.error).toBeNull();
  });
});
