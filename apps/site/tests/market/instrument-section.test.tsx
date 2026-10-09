// InstrumentSection 组件用例:
// KlineChart 一律 vi.mock("../../src/components/market/kline-chart")(图表由并行卡交付,这里只断言收到的 props);
// 取数 mock 掉 facade 模块(src/api/market/index 的 getKlines / getTrends),用受控 promise
// 复现 loading / 错误 / 竞态三类时序(组件只经 use-chart-data 调 facade,不碰具体数据源)。
// 周期 / 日期范围 / 数据源来自全局筛选栏 store(src/store/market-filter.ts):用例通过
// useMarketFilterStore.setState 预置或切换(区块内已无周期控件)。
//
// 六类边界覆盖:空值(quote 全 null)、零值(price=0,见 quote-header 用例)、
// 越界(非法 period 由 TS 的 ChartPeriod 联合类型在编译期挡住,运行期不再防御,故无用例)、
// 配置缺失(xau 无 sessionHint / volumeUnit)、网络失败(取数 reject → 图表区错误态)、
// 非法状态(快速连切周期的竞态)。
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { chartProps, mockGetKlines, mockGetTrends } = vi.hoisted(() => ({
  // KlineChart 替身:记录每次收到的 props(最新一次即当前渲染的入参)。
  chartProps: vi.fn(),
  mockGetKlines: vi.fn(),
  mockGetTrends: vi.fn()
}));

vi.mock("../../src/components/market/kline-chart", async () => {
  const { createElement } = await import("react");
  return {
    KlineChart: (props: Record<string, unknown>) => {
      chartProps(props);
      return createElement("div", { "data-testid": "kline-chart" });
    }
  };
});

// facade 模块替身:只暴露组件用到的两个能力(签名与真实 facade 一致)。
vi.mock("../../src/api/market/index", () => ({
  getKlines: mockGetKlines,
  getTrends: mockGetTrends
}));

import { getInstrument } from "../../src/api/market/config";
import { MarketError } from "../../src/api/market/types";
import type { InstrumentConfig, KlineBar, Quote, TrendSet } from "../../src/api/market/types";
import InstrumentSection from "../../src/components/market/instrument-section";
import { useMarketFilterStore } from "../../src/store/market-filter";
import type { MarketFilterState } from "../../src/store/market-filter";

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

function makeQuote(instrumentId: string, patch: Partial<Quote> = {}): Quote {
  return {
    instrumentId,
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
    source: "eastmoney",
    ...patch
  };
}

/** 生成 count 根升序 K 线(收盘价 100 起递增)。 */
function makeBars(count: number): KlineBar[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index;
    return {
      time: `2026-08-${String(index + 1).padStart(2, "0")}`,
      open: close - 1,
      close,
      high: close + 1,
      low: close - 2,
      volume: 1000 + index,
      amount: 100000 + index
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

/** 图表替身最近一次收到的 props(断言取数编排结果的唯一入口)。 */
function latestChartProps(): Record<string, unknown> {
  const calls = chartProps.mock.calls;
  if (calls.length === 0) {
    throw new Error("KlineChart 尚未渲染");
  }
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

/** 均线图例取值:标签 span 的下一个兄弟节点(值 span)。 */
function maValue(label: string): string {
  return screen.getByText(label).nextElementSibling?.textContent ?? "";
}

function mockMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false
      }) as MediaQueryList
  });
}

// 会话内 K 线缓存是模块级 Map(见 use-chart-data.ts),key 含日期范围;每个用例发一个
// 唯一范围,保证缓存不会跨用例串数据。
let rangeSeq = 0;
function resetMarketFilter(patch: Partial<MarketFilterState> = {}): void {
  rangeSeq += 1;
  const year = 2000 + rangeSeq;
  useMarketFilterStore.setState({
    period: "minute",
    source: "auto",
    dateRange: [`${year}-01-01`, `${year}-12-31`],
    ...patch
  });
}

function renderSection(
  options: { instrument?: InstrumentConfig; quote?: Quote | null; onRetryQuote?: () => void } = {}
): void {
  const instrument = options.instrument ?? instrumentOf("sh000001");
  const quote =
    options.quote === undefined
      ? makeQuote(instrument.id, {
          price: 3047.35,
          change: 10.7,
          changePct: 0.35,
          amplitudePct: 1.2,
          open: 3040.1,
          high: 3060.2,
          low: 3030.5,
          prevClose: 3036.65,
          volume: 164000000,
          amount: 422800000000,
          source: "eastmoney"
        })
      : options.quote;
  render(
    <InstrumentSection
      instrument={instrument}
      quote={quote}
      quoteLoading={false}
      onRetryQuote={options.onRetryQuote ?? vi.fn()}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMatchMedia(false);
  resetMarketFilter();
});

describe("InstrumentSection 结构与快照区", () => {
  it("标题行渲染名称、时段提示与来源角标", async () => {
    mockGetTrends.mockResolvedValue(makeTrendSet());
    renderSection();
    await waitFor(() => expect(latestChartProps().loading).toBe(false));
    expect(screen.getByRole("heading", { name: "上证指数" })).toBeInTheDocument();
    expect(screen.getByText("9:30–15:00")).toBeInTheDocument();
    expect(screen.getByText("源:东方财富")).toBeInTheDocument();
    expect(screen.getByText("今开")).toBeInTheDocument();
  });

  it("来源角标按 quote.source 映射文案(腾讯)", async () => {
    mockGetTrends.mockResolvedValue(makeTrendSet());
    renderSection({
      quote: makeQuote("sh000001", {
        price: 3047.35,
        change: 1,
        changePct: 0.03,
        source: "tencent"
      })
    });
    await waitFor(() => expect(latestChartProps().loading).toBe(false));
    expect(screen.getByText("源:腾讯")).toBeInTheDocument();
  });

  it("quote 为空且非 loading:快照区显示错误文案,重试按钮回调父级(空值边界)", async () => {
    mockGetTrends.mockResolvedValue(makeTrendSet());
    const onRetryQuote = vi.fn();
    renderSection({ quote: null, onRetryQuote });
    expect(screen.getByRole("alert")).toHaveTextContent("行情加载失败");
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetryQuote).toHaveBeenCalledTimes(1);
  });

  it("配置缺失(无 sessionHint / 无 volumeUnit / 无量额):不渲染提示与量额两项", async () => {
    mockGetTrends.mockResolvedValue(makeTrendSet());
    // 六个内置标的都配了 sessionHint,这里用「可选配置缺失」的标的自证分支。
    const bareInstrument: InstrumentConfig = {
      id: "xau",
      name: "伦敦金",
      category: "gold",
      secid: "122.XAU",
      priceDecimals: 2,
      hasVolume: false,
      hasAmount: false,
      hasAvgLine: false
    };
    renderSection({ instrument: bareInstrument });
    expect(document.querySelector(".market-instrument-session-hint")).toBeNull();
    expect(screen.queryByText("成交量")).not.toBeInTheDocument();
    expect(screen.queryByText("成交额")).not.toBeInTheDocument();
    await waitFor(() => expect(latestChartProps().hasVolume).toBe(false));
    expect(latestChartProps().hasAvgLine).toBe(false);
  });
});

describe("InstrumentSection 周期与图表(周期来自全局筛选栏 store)", () => {
  it("区块内不再渲染周期 Radio.Group(周期 UI 已上移到全局筛选栏)", async () => {
    mockGetTrends.mockResolvedValue(makeTrendSet());
    renderSection();
    await waitFor(() => expect(latestChartProps().loading).toBe(false));
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByText("五日")).not.toBeInTheDocument();
  });

  it("默认走分时:请求当日 trends,mode=trend + prevClose + 桌面高度 420,分时无 MA 图例", async () => {
    const deferred = createDeferred<TrendSet>();
    mockGetTrends.mockReturnValue(deferred.promise);
    renderSection();

    expect(latestChartProps().mode).toBe("trend");
    expect(latestChartProps().loading).toBe(true);

    await waitFor(() => expect(mockGetTrends).toHaveBeenCalledTimes(1));
    expect(mockGetTrends.mock.calls[0][0]).toMatchObject({ id: "sh000001" });
    expect(mockGetTrends.mock.calls[0][1]).toBe(1);
    // auto 数据源:options 传 undefined 走 facade 兜底链。
    expect(mockGetTrends.mock.calls[0][2]).toBeUndefined();

    await act(async () => {
      deferred.resolve(makeTrendSet());
      await deferred.promise;
    });
    await waitFor(() => expect(latestChartProps().loading).toBe(false));
    expect(latestChartProps().trendPoints).toHaveLength(2);
    expect(latestChartProps().prevClose).toBe(99);
    expect(latestChartProps().height).toBe(420);
    expect(latestChartProps().hasVolume).toBe(true);
    expect(latestChartProps().hasAvgLine).toBe(true);
    expect(screen.queryByText("MA5")).not.toBeInTheDocument();
  });

  it("store 预置 fiveday:请求 ndays=5,不传 prevClose(日期范围不消费)", async () => {
    mockGetTrends.mockResolvedValue(makeTrendSet());
    resetMarketFilter({ period: "fiveday" });
    renderSection();
    await waitFor(() => expect(mockGetTrends).toHaveBeenCalledTimes(1));
    expect(mockGetTrends.mock.calls[0][1]).toBe(5);
    await waitFor(() => expect(latestChartProps().trendPoints).toHaveLength(2));
    expect(latestChartProps().prevClose).toBeUndefined();
    expect(latestChartProps().mode).toBe("trend");
  });

  it("数据源来自 store:source=tencent 时取数带 { source: tencent }", async () => {
    mockGetTrends.mockResolvedValue(makeTrendSet());
    resetMarketFilter({ source: "tencent" });
    renderSection();
    await waitFor(() => expect(mockGetTrends).toHaveBeenCalledTimes(1));
    expect(mockGetTrends.mock.calls[0][2]).toEqual({ source: "tencent" });
  });

  it("store 预置 day:按日期范围请求 K 线(limit 5000)、mode=kline、出现 MA 图例,且不再传分页 props", async () => {
    const bars = makeBars(30);
    mockGetTrends.mockResolvedValue(makeTrendSet());
    mockGetKlines.mockResolvedValue({ bars, hasMore: false });
    resetMarketFilter({ period: "day" });
    renderSection({ instrument: instrumentOf("sh000688") });

    await waitFor(() => expect(mockGetKlines).toHaveBeenCalledTimes(1));
    const [instrument, period, range, options] = mockGetKlines.mock.calls[0];
    expect(instrument).toMatchObject({ id: "sh000688" });
    expect(period).toBe("day");
    // 日期范围按 store 值去连字符成 YYYYMMDD。
    const { dateRange } = useMarketFilterStore.getState();
    expect(range).toEqual({
      beg: dateRange[0].replace(/-/g, ""),
      end: dateRange[1].replace(/-/g, ""),
      limit: 5000
    });
    expect(options).toBeUndefined();

    await waitFor(() => expect(latestChartProps().mode).toBe("kline"));
    expect(latestChartProps().bars).toBe(bars);
    expect(latestChartProps().prevClose).toBeUndefined();
    expect(latestChartProps().height).toBe(420);
    // 滚轮 / 加载更多已移除:KlineChart 只收冻结接口的 8 个 props。
    expect(latestChartProps()).not.toHaveProperty("onNeedMore");
    expect(latestChartProps()).not.toHaveProperty("hasMore");
    expect(latestChartProps()).not.toHaveProperty("loadingMore");

    // MA5 = 最近 5 根收盘均值(最近一根可视数据)
    const expectedMa5 = (bars.slice(-5).reduce((sum, bar) => sum + bar.close, 0) / 5).toFixed(2);
    expect(screen.getByText("MA5")).toBeInTheDocument();
    expect(maValue("MA5")).toBe(expectedMa5);
    expect(screen.getByText("MA10")).toBeInTheDocument();
    expect(screen.getByText("MA20")).toBeInTheDocument();
  });

  it("周期由 store 驱动:store 切到日K 后区块按新周期重取(区块内无控件)", async () => {
    mockGetTrends.mockResolvedValue(makeTrendSet());
    mockGetKlines.mockResolvedValue({ bars: makeBars(30), hasMore: false });
    renderSection();
    await waitFor(() => expect(latestChartProps().loading).toBe(false));
    expect(mockGetKlines).not.toHaveBeenCalled();

    act(() => {
      useMarketFilterStore.setState({ period: "day" });
    });
    await waitFor(() => expect(latestChartProps().mode).toBe("kline"));
    expect(mockGetKlines).toHaveBeenCalledTimes(1);
    expect(mockGetKlines.mock.calls[0][1]).toBe("day");
    expect(screen.getByText("MA5")).toBeInTheDocument();
  });

  it("切回已看过的周期:命中会话缓存立即渲染(不闪骨架)并后台刷新", async () => {
    const bars = makeBars(30);
    mockGetTrends.mockResolvedValue(makeTrendSet());
    mockGetKlines.mockResolvedValue({ bars, hasMore: false });
    renderSection({ instrument: instrumentOf("sz399006") });

    await waitFor(() => expect(latestChartProps().loading).toBe(false));
    act(() => {
      useMarketFilterStore.setState({ period: "day" });
    });
    await waitFor(() => expect(latestChartProps().bars).toBe(bars));

    act(() => {
      useMarketFilterStore.setState({ period: "minute" });
    });
    await waitFor(() => expect(latestChartProps().mode).toBe("trend"));

    // 回到日K:刷新请求挂着不落地,缓存数据仍应立即渲染且不显示 loading
    mockGetKlines.mockReturnValue(new Promise(() => undefined));
    act(() => {
      useMarketFilterStore.setState({ period: "day" });
    });
    await waitFor(() => expect(latestChartProps().bars).toBe(bars));
    expect(latestChartProps().loading).toBe(false);
    expect(latestChartProps().mode).toBe("kline");
    // 后台刷新确实发出(第 1 次首次取数 + 第 2 次缓存命中后的刷新)
    expect(mockGetKlines).toHaveBeenCalledTimes(2);
  });

  it("移动端(< 768px)图表高度传 300", async () => {
    mockMatchMedia(true);
    mockGetTrends.mockResolvedValue(makeTrendSet());
    renderSection();
    await waitFor(() => expect(latestChartProps().height).toBe(300));
  });
});

describe("InstrumentSection 错误态", () => {
  it("周期取数失败:图表区显示错误与重试,点击重试重新取数并恢复图表,快照区不受影响", async () => {
    mockGetTrends
      .mockRejectedValueOnce(
        new MarketError("eastmoney", "上证指数当日分时获取失败(东财:请求超时)")
      )
      .mockResolvedValueOnce(makeTrendSet());
    renderSection();

    expect(await screen.findByText("该周期暂无数据或加载失败")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("上证指数当日分时获取失败");
    // 周期级错误独立:快照区照常渲染
    expect(screen.getByText("今开")).toBeInTheDocument();
    expect(screen.queryByTestId("kline-chart")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(mockGetTrends).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(latestChartProps().trendPoints).toHaveLength(2));
    expect(screen.queryByText("该周期暂无数据或加载失败")).not.toBeInTheDocument();
    expect(screen.getByTestId("kline-chart")).toBeInTheDocument();
  });

  it("配置缺失(指定腾讯源 + 无 tencentCode 的标的):facade 抛错 → 图表区错误态", async () => {
    mockGetKlines.mockRejectedValueOnce(
      new MarketError("tencent", "黄金9999日 K 线获取失败(腾讯仅支持内盘指数代码)")
    );
    resetMarketFilter({ period: "day", source: "tencent" });
    renderSection({ instrument: instrumentOf("au9999") });

    expect(await screen.findByText("该周期暂无数据或加载失败")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("腾讯仅支持内盘指数代码");
    expect(mockGetKlines.mock.calls[0][3]).toEqual({ source: "tencent" });
    expect(screen.queryByTestId("kline-chart")).not.toBeInTheDocument();
  });
});

describe("InstrumentSection 竞态守卫", () => {
  it("快速连切周期:旧周期(含已放弃的中间周期)的迟到响应不覆盖新周期数据", async () => {
    const minuteDeferred = createDeferred<TrendSet>();
    const dayDeferred = createDeferred<{ bars: KlineBar[]; hasMore: boolean }>();
    const weekDeferred = createDeferred<{ bars: KlineBar[]; hasMore: boolean }>();
    mockGetTrends.mockReturnValue(minuteDeferred.promise);
    mockGetKlines.mockImplementation((_instrument: InstrumentConfig, period: string) =>
      period === "day" ? dayDeferred.promise : weekDeferred.promise
    );

    renderSection();
    await waitFor(() => expect(mockGetTrends).toHaveBeenCalledTimes(1));

    // 连切两次:日K(会被放弃) → 周K(目标周期)
    act(() => {
      useMarketFilterStore.setState({ period: "day" });
    });
    await waitFor(() => expect(mockGetKlines).toHaveBeenCalledTimes(1));
    act(() => {
      useMarketFilterStore.setState({ period: "week" });
    });
    await waitFor(() => expect(mockGetKlines).toHaveBeenCalledTimes(2));

    // 中间周期(日K)迟到返回:必须被丢弃,不落到图表上
    const dayBars = makeBars(25);
    await act(async () => {
      dayDeferred.resolve({ bars: dayBars, hasMore: false });
      await dayDeferred.promise;
    });
    expect(latestChartProps().bars).not.toBe(dayBars);
    expect(latestChartProps().loading).toBe(true);

    // 目标周期(周K)返回:正常渲染
    const weekBars = makeBars(20);
    await act(async () => {
      weekDeferred.resolve({ bars: weekBars, hasMore: false });
      await weekDeferred.promise;
    });
    await waitFor(() => expect(latestChartProps().bars).toBe(weekBars));
    expect(latestChartProps().mode).toBe("kline");

    // 首个周期(分时)最后迟到:仍不能覆盖周K
    await act(async () => {
      minuteDeferred.resolve(makeTrendSet());
      await minuteDeferred.promise;
    });
    expect(latestChartProps().mode).toBe("kline");
    expect(latestChartProps().bars).toBe(weekBars);
    expect(latestChartProps().trendPoints).toBeUndefined();
  });
});
