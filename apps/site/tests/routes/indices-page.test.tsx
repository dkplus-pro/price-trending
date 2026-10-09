// IndicesPage(国内指数页)装配用例:与黄金页同构(共享 usePageQuotes、InstrumentSection 与
// 全局筛选栏 MarketFilterBar),这里固定「配置驱动」这一验收点:GOLD/INDEX 分组 id 换成 INDEX_IDS
// 后区块数量与顺序随之变化,快照同样跟随 store 的数据源。
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

import { INDEX_IDS, getInstrument } from "../../src/api/market/config";
import type { InstrumentConfig, Quote } from "../../src/api/market/types";
import IndicesPage from "../../src/routes/indices/page";
import { getDefaultDateRange, useMarketFilterStore } from "../../src/store/market-filter";

function instrumentOf(id: string): InstrumentConfig {
  const found = getInstrument(id);
  if (found === undefined) {
    throw new Error(`测试标的配置缺失:${id}`);
  }
  return found;
}

function quoteOf(instrumentId: string, price: number, source: Quote["source"]): Quote {
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

describe("IndicesPage 页面装配", () => {
  it("按 INDEX_IDS 平铺三区块,顺序与配置一致,quote 按 id 分发,带全局筛选栏", () => {
    mockPageQuotes.mockReturnValue({
      instruments: INDEX_IDS.map((id) => instrumentOf(id)),
      quotes: [quoteOf("sh000001", 3047.35, "eastmoney")],
      quoteMap: new Map<string, Quote>([
        ["sh000001", quoteOf("sh000001", 3047.35, "eastmoney")],
        ["sz399006", quoteOf("sz399006", 1866.4, "tencent")]
      ]),
      loading: false,
      error: null,
      refresh: vi.fn()
    });
    render(<IndicesPage />);

    expect(screen.getAllByTestId(/^section-/)).toHaveLength(3);
    expect(
      sectionProps.mock.calls.map(
        ([props]) => (props as { instrument: InstrumentConfig }).instrument.id
      )
    ).toEqual([...INDEX_IDS]);
    expect(propsOf("sh000001").quote).toMatchObject({ price: 3047.35 });
    expect(propsOf("sz399006").quote).toMatchObject({ source: "tencent" });
    // 空值边界:未取到的标的一律传 null,由区块渲染缺失态。
    expect(propsOf("sh000688").quote).toBeNull();
    // 快照跟随 store 的数据源(默认 auto)。
    expect(mockPageQuotes).toHaveBeenCalledWith(INDEX_IDS, "auto");
    expect(screen.getByText("数据来源于公开行情接口,仅供参考")).toBeInTheDocument();
    expect(screen.getByTestId("market-filter-bar")).toBeInTheDocument();
  });

  it("配置缺失项被跳过:instruments 只有两项时渲染两个区块,页面不炸", () => {
    mockPageQuotes.mockReturnValue({
      instruments: [instrumentOf("sh000001"), instrumentOf("sh000688")],
      quotes: undefined,
      quoteMap: new Map<string, Quote>(),
      loading: true,
      error: null,
      refresh: vi.fn()
    });
    render(<IndicesPage />);

    expect(screen.getAllByTestId(/^section-/)).toHaveLength(2);
    expect(propsOf("sh000001").quoteLoading).toBe(true);
  });

  it("页面级失败:错误条可重试,且不阻断区块渲染", async () => {
    const refresh = vi.fn();
    mockPageQuotes.mockReturnValue({
      instruments: INDEX_IDS.map((id) => instrumentOf(id)),
      quotes: undefined,
      quoteMap: new Map<string, Quote>(),
      loading: false,
      error: "上证指数/创业板指/科创50 行情获取失败(最后尝试来源:tencent)",
      refresh
    });
    render(<IndicesPage />);

    expect(screen.getByRole("alert")).toHaveTextContent("最后尝试来源:tencent");
    expect(screen.getAllByTestId(/^section-/)).toHaveLength(3);

    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("数据源来自 store:切换数据源后 usePageQuotes 立即收到新的 source", () => {
    mockPageQuotes.mockReturnValue({
      instruments: INDEX_IDS.map((id) => instrumentOf(id)),
      quotes: undefined,
      quoteMap: new Map<string, Quote>(),
      loading: false,
      error: null,
      refresh: vi.fn()
    });
    render(<IndicesPage />);
    expect(mockPageQuotes).toHaveBeenLastCalledWith(INDEX_IDS, "auto");

    act(() => {
      useMarketFilterStore.setState({ source: "eastmoney" });
    });
    expect(mockPageQuotes).toHaveBeenLastCalledWith(INDEX_IDS, "eastmoney");
  });
});
