// GoldPage(黄金价格页)装配用例:mock 掉 usePageQuotes 与 InstrumentSection,
// 页面只负责「全局筛选栏 + 按配置平铺区块 + 分发 quote + 页面级错误条」。
// MarketFilterBar 同样 mock(并行卡交付,页面只需保证渲染它并让快照跟随 store 的数据源)。
//
// 六类边界覆盖:空值(quote 缺失 → 传 null)、零值(价格 0 照常传下去)、
// 越界/配置缺失(instruments 少项时只渲染给出项,不炸)、网络失败(页面级 error → 提示条 + 重试)、
// 非法状态(首轮 loading 全部区块进骨架态;数据源切换触发重取)。
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPageQuotes, sectionProps } = vi.hoisted(() => ({
  mockPageQuotes: vi.fn(),
  sectionProps: vi.fn()
}));

vi.mock("../../src/components/market/use-page-quotes", () => ({
  usePageQuotes: mockPageQuotes
}));

vi.mock("../../src/components/market/instrument-section", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      sectionProps(props);
      return createElement("section", {
        "data-testid": `section-${String((props.instrument as { id: string }).id)}`
      });
    }
  };
});

vi.mock("../../src/components/market/market-filter-bar", async () => {
  const { createElement } = await import("react");
  return {
    default: () => createElement("div", { "data-testid": "market-filter-bar" })
  };
});

import { GOLD_IDS, getInstrument } from "../../src/api/market/config";
import type { InstrumentConfig, Quote } from "../../src/api/market/types";
import GoldPage from "../../src/routes/gold/page";
import { getDefaultDateRange, useMarketFilterStore } from "../../src/store/market-filter";

function instrumentOf(id: string): InstrumentConfig {
  const found = getInstrument(id);
  if (found === undefined) {
    throw new Error(`测试标的配置缺失:${id}`);
  }
  return found;
}

function quoteOf(instrumentId: string, price: number | null): Quote {
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
    source: "eastmoney"
  };
}

/** 页面入参的默认装配:三标的全量快照 + 无错误。 */
function pageQuotesOf(
  patch: Partial<{
    instruments: InstrumentConfig[];
    quoteMap: Map<string, Quote>;
    loading: boolean;
    error: string | null;
  }> = {}
): Record<string, unknown> {
  return {
    instruments: GOLD_IDS.map((id) => instrumentOf(id)),
    quotes: [quoteOf("au9999", 782.5)],
    quoteMap: new Map<string, Quote>([["au9999", quoteOf("au9999", 782.5)]]),
    loading: false,
    error: null,
    refresh: vi.fn(),
    ...patch
  };
}

/** 区块替身最近一次收到的 props(按标的 id 定位)。 */
function propsOf(id: string): Record<string, unknown> {
  const call = sectionProps.mock.calls.find(
    ([props]) => (props as { instrument: InstrumentConfig }).instrument.id === id
  );
  if (call === undefined) {
    throw new Error(`区块未渲染:${id}`);
  }
  return call[0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  useMarketFilterStore.setState({
    period: "minute",
    source: "auto",
    dateRange: getDefaultDateRange()
  });
});

describe("GoldPage 页面装配", () => {
  it("按 GOLD_IDS 平铺三区块,quote 按 id 分发(缺失项传 null),带说明小字与全局筛选栏", () => {
    mockPageQuotes.mockReturnValue(pageQuotesOf());
    render(<GoldPage />);

    expect(screen.getByTestId("section-au9999")).toBeInTheDocument();
    expect(screen.getByTestId("section-xau")).toBeInTheDocument();
    expect(screen.getByTestId("section-gc")).toBeInTheDocument();
    expect(screen.getByText("数据来源于公开行情接口,仅供参考")).toBeInTheDocument();
    // 全局筛选栏(周期 / 日期范围 / 数据源)在区块之上渲染一次。
    expect(screen.getByTestId("market-filter-bar")).toBeInTheDocument();

    expect(propsOf("au9999").quote).toMatchObject({ instrumentId: "au9999", price: 782.5 });
    // 空值边界:quoteMap 缺项(单标的取不到)按 null 传给区块,由区块自己渲染缺失态。
    expect(propsOf("xau").quote).toBeNull();
    expect(propsOf("gc").quote).toBeNull();
    // 快照跟随 store 的数据源(默认 auto)。
    expect(mockPageQuotes).toHaveBeenCalledWith(GOLD_IDS, "auto");
  });

  it("首轮 loading:所有区块 quoteLoading 为 true(快照区骨架)", () => {
    mockPageQuotes.mockReturnValue(
      pageQuotesOf({ quoteMap: new Map<string, Quote>(), loading: true })
    );
    render(<GoldPage />);

    expect(propsOf("au9999").quoteLoading).toBe(true);
    expect(propsOf("au9999").quote).toBeNull();
  });

  it("零值/缺失配置:price 0 照常传下去;instruments 少项时只渲染给出项", () => {
    mockPageQuotes.mockReturnValue(
      pageQuotesOf({
        instruments: [instrumentOf("gc")],
        quoteMap: new Map<string, Quote>([["gc", quoteOf("gc", 0)]])
      })
    );
    render(<GoldPage />);

    expect(screen.getAllByTestId(/^section-/)).toHaveLength(1);
    expect(propsOf("gc").quote).toMatchObject({ price: 0 });
  });

  it("页面级失败:渲染可重试错误条,区块照常渲染,点击重试触发 refresh", async () => {
    const refresh = vi.fn();
    mockPageQuotes.mockReturnValue(
      pageQuotesOf({ error: "行情获取失败(全部来源不可用)", refresh })
    );
    render(<GoldPage />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("行情加载失败:行情获取失败(全部来源不可用)");
    expect(screen.getAllByTestId(/^section-/)).toHaveLength(3);

    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("数据源来自 store:切换数据源后 usePageQuotes 立即收到新的 source", () => {
    mockPageQuotes.mockReturnValue(pageQuotesOf());
    render(<GoldPage />);
    expect(mockPageQuotes).toHaveBeenLastCalledWith(GOLD_IDS, "auto");

    act(() => {
      useMarketFilterStore.setState({ source: "tencent" });
    });
    expect(mockPageQuotes).toHaveBeenLastCalledWith(GOLD_IDS, "tencent");
  });
});
