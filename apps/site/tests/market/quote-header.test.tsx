// QuoteHeader 组件用例(参考图顶部快照区):
// 配色三分支(涨红/跌绿/平灰)、空值占位、量额两项的配置开关、loading 骨架与错误文案。
// 六类边界覆盖:空值(全 null)、零值(price=0 合法,不落错误态)、配置缺失(无 volumeUnit)。
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { getInstrument } from "../../src/api/market/config";
import type { InstrumentConfig, Quote } from "../../src/api/market/types";
import { MISSING_TEXT } from "../../src/api/market/utils";
import QuoteHeader from "../../src/components/market/quote-header";

function instrumentOf(id: string): InstrumentConfig {
  const found = getInstrument(id);
  if (found === undefined) {
    throw new Error(`测试标的配置缺失:${id}`);
  }
  return found;
}

function makeQuote(patch: Partial<Quote> = {}): Quote {
  return {
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
    source: "eastmoney",
    ...patch
  };
}

/** 统计项取值:标签(dt)的下一个兄弟节点(dd)。 */
function statValue(label: string): string {
  const term = screen.getByText(label);
  return term.nextElementSibling?.textContent ?? "";
}

function priceBlock(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".quote-header-price");
}

describe("QuoteHeader 涨跌配色", () => {
  it("change > 0 走 up(红)", () => {
    render(
      <QuoteHeader
        instrument={instrumentOf("au9999")}
        quote={makeQuote({ price: 782.5, change: 10.7, changePct: 1.39 })}
        loading={false}
      />
    );
    expect(priceBlock()).toHaveClass("quote-header-price-up");
    expect(priceBlock()).toHaveAttribute("data-trend", "up");
    expect(screen.getByText("+10.70")).toBeInTheDocument();
    expect(screen.getByText("+1.39%")).toBeInTheDocument();
  });

  it("change < 0 走 down(绿)", () => {
    render(
      <QuoteHeader
        instrument={instrumentOf("au9999")}
        quote={makeQuote({ price: 782.5, change: -10.7, changePct: -1.35 })}
        loading={false}
      />
    );
    expect(priceBlock()).toHaveClass("quote-header-price-down");
    expect(screen.getByText("-10.70")).toBeInTheDocument();
    expect(screen.getByText("-1.35%")).toBeInTheDocument();
  });

  it("change = 0 走 flat(灰),且不出现 -0.00", () => {
    render(
      <QuoteHeader
        instrument={instrumentOf("au9999")}
        quote={makeQuote({ price: 782.5, change: 0, changePct: 0 })}
        loading={false}
      />
    );
    expect(priceBlock()).toHaveClass("quote-header-price-flat");
    expect(screen.getByText("0.00")).toBeInTheDocument();
    expect(screen.queryByText("-0.00")).not.toBeInTheDocument();
  });

  it("change 缺失时用 price 与 prevClose 推导涨跌色", () => {
    const { unmount } = render(
      <QuoteHeader
        instrument={instrumentOf("au9999")}
        quote={makeQuote({ price: 100, prevClose: 90 })}
        loading={false}
      />
    );
    expect(priceBlock()).toHaveClass("quote-header-price-up");
    unmount();

    render(
      <QuoteHeader
        instrument={instrumentOf("au9999")}
        quote={makeQuote({ price: 90, prevClose: 100 })}
        loading={false}
      />
    );
    expect(priceBlock()).toHaveClass("quote-header-price-down");
  });

  it("price 与 change 都缺失按 flat,并渲染 --", () => {
    render(<QuoteHeader instrument={instrumentOf("au9999")} quote={makeQuote()} loading={false} />);
    expect(priceBlock()).toHaveClass("quote-header-price-flat");
    expect(priceBlock()?.querySelector(".quote-header-last")).toHaveTextContent(MISSING_TEXT);
  });
});

describe("QuoteHeader 统计区", () => {
  it("空值全渲染 --,不落错误态(空值边界)", () => {
    render(<QuoteHeader instrument={instrumentOf("au9999")} quote={makeQuote()} loading={false} />);
    for (const label of ["今开", "昨收", "最高", "最低", "振幅", "成交量", "成交额", "更新时间"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(statValue(label)).toBe(MISSING_TEXT);
    }
  });

  it("price = 0 是合法行情:显示 0.00 且不落错误态(零值边界)", () => {
    render(
      <QuoteHeader
        instrument={instrumentOf("au9999")}
        quote={makeQuote({ price: 0, change: 0, changePct: 0, open: 0, prevClose: 0 })}
        loading={false}
      />
    );
    expect(priceBlock()?.querySelector(".quote-header-last")).toHaveTextContent("0.00");
    expect(statValue("今开")).toBe("0.00");
    expect(screen.queryByText("行情加载失败")).not.toBeInTheDocument();
  });

  it("hasVolume / hasAmount 为 false 的标的(伦敦金)不渲染量额两项", () => {
    render(
      <QuoteHeader
        instrument={instrumentOf("xau")}
        quote={makeQuote({ instrumentId: "xau", price: 2652.4, volume: 100, amount: 100 })}
        loading={false}
      />
    );
    expect(screen.queryByText("成交量")).not.toBeInTheDocument();
    expect(screen.queryByText("成交额")).not.toBeInTheDocument();
    expect(screen.getByText("今开")).toBeInTheDocument();
  });

  it("volumeUnit 缺失不标单位(黄金9999),有单位则标(指数「手」)", () => {
    const { unmount } = render(
      <QuoteHeader
        instrument={instrumentOf("au9999")}
        quote={makeQuote({ price: 782.5, volume: 164000000 })}
        loading={false}
      />
    );
    expect(screen.getByText("1.64亿")).toBeInTheDocument();
    expect(screen.queryByText("1.64亿手")).not.toBeInTheDocument();
    unmount();

    render(
      <QuoteHeader
        instrument={instrumentOf("sh000001")}
        quote={makeQuote({ instrumentId: "sh000001", price: 3047.35, volume: 164000000 })}
        loading={false}
      />
    );
    expect(screen.getByText("1.64亿手")).toBeInTheDocument();
  });

  it("按标的小数位格式化,并按来源展示量额/更新时间", () => {
    const time = Math.floor(new Date(2026, 9, 9, 14, 15, 6).getTime() / 1000);
    render(
      <QuoteHeader
        instrument={instrumentOf("gc")}
        quote={makeQuote({
          instrumentId: "gc",
          price: 2698.4,
          open: 2680.5,
          prevClose: 2691.2,
          high: 2702.8,
          low: 2678.4,
          amplitudePct: 0.9,
          volume: 9999,
          time
        })}
        loading={false}
      />
    );
    expect(priceBlock()?.querySelector(".quote-header-last")).toHaveTextContent("2698.4");
    expect(statValue("今开")).toBe("2680.5");
    expect(statValue("振幅")).toBe("0.90%");
    expect(statValue("成交量")).toBe("9999");
    // COMEX 期金无成交额且无 volumeUnit:量值不带单位
    expect(statValue("成交量")).not.toContain("手");
    expect(screen.queryByText("成交额")).not.toBeInTheDocument();
    expect(statValue("更新时间")).toBe("14:15:06");
  });
});

describe("QuoteHeader 加载与错误态", () => {
  it("loading 渲染骨架屏", () => {
    render(<QuoteHeader instrument={instrumentOf("au9999")} quote={makeQuote()} loading />);
    expect(screen.getByRole("status")).toHaveAccessibleName("行情加载中");
    expect(screen.queryByText("今开")).not.toBeInTheDocument();
  });

  it("quote = null 且非 loading 渲染错误文案(重试按钮由父级提供)", () => {
    render(<QuoteHeader instrument={instrumentOf("au9999")} quote={null} loading={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent("行情加载失败");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
