// kline-chart 组件用例(RTL + @antv/g2 替身:替身 Chart 记录 options/render/destroy 调用)。
// 组件为纯展示:全部传入数据进 spec(不切片)、不注册滚轮/触屏平移、无「加载更早」交互;
// 悬停红虚线是组件层 overlay(原生 pointermove/pointerleave 只定位,不进 G2 spec)。
// 边界六类映射:空值(空数组 → Empty;未悬停无虚线)、零值(price/volume=0 不炸;悬停 y=0 线在容器顶)、
// 越界(指针离开容器即清除虚线;数据侧无可视窗口,不适用)、配置缺失(prevClose=null 不画昨收线;onNeedMore 已删)、
// 网络失败(数据经 props,不适用)、非法状态(loading 与空数据同时时 loading 优先;遮罩 z-index 高于悬停线)。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { act, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { KlineBar, TrendPoint } from "../../src/api/market/types";
import { KlineChart } from "../../src/components/market/kline-chart";
import type { KlineChartProps } from "../../src/components/market/kline-chart";

/** G2 替身:记录每次 options 的完整 spec(断言「整份 spec 覆盖更新」的依据)。 */
const g2Mock = vi.hoisted(() => {
  class FakeChart {
    config: Record<string, unknown>;
    specs: Record<string, unknown>[] = [];
    renderCount = 0;
    destroyed = false;

    constructor(config: Record<string, unknown>) {
      this.config = config;
      g2Mock.instances.push(this);
    }

    options = (spec: Record<string, unknown>): void => {
      this.specs.push(spec);
    };

    render = (): void => {
      this.renderCount += 1;
    };

    destroy = (): void => {
      this.destroyed = true;
    };
  }

  return { FakeChart, instances: [] as FakeChart[] };
});

vi.mock("@antv/g2", () => ({ Chart: g2Mock.FakeChart }));

interface SpecNode {
  type?: string;
  data?: Record<string, unknown>[];
  encode?: Record<string, unknown>;
  interaction?: Record<string, unknown>;
  children?: SpecNode[];
  height?: number;
}

/** tooltip 交互配置(断言十字光标字段用)。 */
type TooltipConfig = Record<string, unknown>;

const lastChart = (): (typeof g2Mock.instances)[number] =>
  g2Mock.instances[g2Mock.instances.length - 1];

const lastSpec = (): SpecNode => {
  const specs = lastChart().specs;
  return specs[specs.length - 1] as SpecNode;
};

/** 主图 view:有量柱时根为 spaceFlex(主图在前),无量柱时根即主图。 */
function mainViewOf(spec: SpecNode): SpecNode {
  const children = spec.children ?? [];
  return spec.type === "spaceFlex" ? children[0] : spec;
}

/** 进 spec 的主图 K 线 time 序列(= 传入 bars 全量,组件不再切片)。 */
function specTimes(): string[] {
  return (mainViewOf(lastSpec()).data ?? []).map((datum) => String(datum.time));
}

/** 进 spec 的分时价格线 label 序列。 */
function trendLabels(): string[] {
  const priceLine = (mainViewOf(lastSpec()).children ?? [])[0];
  return (priceLine.data ?? []).map((datum) => String(datum.label));
}

function pad(value: number): string {
  return String(value).padStart(6, "0");
}

function makeBars(count: number, offset = 0): KlineBar[] {
  return Array.from({ length: count }, (_, index) => ({
    time: `t${pad(index + offset)}`,
    open: 100 + index,
    close: 100 + index + (index % 2 === 0 ? 1 : -1),
    high: 110 + index,
    low: 90 + index,
    volume: index % 5 === 0 ? 0 : 1000 + index,
    amount: null
  }));
}

/** 340 根可排序 K 线(超过 120:验证无窗口后全量进 spec)。 */
const ALL_BARS = makeBars(340);
const FIRST_PAGE = ALL_BARS.slice(40);

const BASE_PROPS: KlineChartProps = {
  mode: "kline",
  hasVolume: true,
  hasAvgLine: false,
  height: 420,
  loading: false
};

function renderChart(props: Partial<KlineChartProps> = {}) {
  return render(<KlineChart {...BASE_PROPS} {...props} />);
}

function chartCanvas(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>(".market-chart-canvas");
  if (!element) throw new Error("图表容器未渲染");
  return element;
}

/** 读取 CSS 源文本并压缩空白:jsdom 不做样式/布局计算,圆角、阴影、层级契约只能对源文件断言
 * (与 tests/routes/layout.test.tsx 同款写法)。 */
function readStyle(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8").replace(
    /\s+/g,
    " "
  );
}

/** 取首个「选择器 { ... }」规则块的源文本(压缩空白后;多选择器规则返回整段前导选择器 + 声明)。 */
function ruleBody(css: string, selector: string): string {
  const hits = [`${selector} {`, `${selector},`]
    .map((pattern) => css.indexOf(pattern))
    .filter((index) => index >= 0);
  if (hits.length === 0) throw new Error(`CSS 中未找到规则:${selector}`);
  const start = Math.min(...hits);
  return css.slice(start, css.indexOf("}", start));
}

/** 悬停:派发原生 pointermove/pointerleave(组件只在这两个事件上做 overlay 定位)。 */
function hoverChart(canvas: HTMLElement, type: "pointermove" | "pointerleave", clientY = 0): void {
  act(() => {
    canvas.dispatchEvent(new PointerEvent(type, { clientY, bubbles: type === "pointermove" }));
  });
}

/** 悬停虚线当前的内联 top(未渲染时为 null)。 */
function hoverLineTop(container: HTMLElement): string | null {
  return container.querySelector<HTMLElement>(".market-chart-hoverline")?.style.top ?? null;
}

beforeEach(() => {
  g2Mock.instances.length = 0;
});

describe("KlineChart 渲染", () => {
  it("挂载后创建图表并渲染整份 spec:全部 bars 进 spec(不切片、尾部对齐最新)", async () => {
    const { container } = renderChart({ bars: FIRST_PAGE });
    await waitFor(() => expect(lastChart().specs.length).toBeGreaterThan(0));

    expect(g2Mock.instances).toHaveLength(1);
    expect(lastChart().config).toMatchObject({ autoFit: true, height: 420 });
    expect(lastChart().renderCount).toBeGreaterThan(0);
    expect(lastSpec().height).toBe(420);
    expect(chartCanvas(container)).toBeInTheDocument();

    const times = specTimes();
    expect(times).toHaveLength(FIRST_PAGE.length);
    expect(times[0]).toBe(FIRST_PAGE[0].time);
    expect(times[times.length - 1]).toBe(FIRST_PAGE[FIRST_PAGE.length - 1].time);
  });

  it("500 根 bars 全量进 spec(远大于旧可视窗口 120,确认不切片)", async () => {
    const bars = makeBars(500);
    renderChart({ bars });
    await waitFor(() => expect(lastChart().specs.length).toBe(1));

    const times = specTimes();
    expect(times).toHaveLength(500);
    expect(times[0]).toBe(bars[0].time);
    expect(times[499]).toBe(bars[499].time);
  });

  it("props 变化整份 spec 覆盖更新:数据变多后长度跟着变", async () => {
    const { container, rerender } = renderChart({ bars: FIRST_PAGE });
    await waitFor(() => expect(lastChart().specs.length).toBe(1));
    expect(specTimes()).toHaveLength(300);

    rerender(<KlineChart {...BASE_PROPS} bars={ALL_BARS} />);
    await waitFor(() => expect(lastChart().specs.length).toBe(2));

    expect(specTimes()).toHaveLength(340);
    expect(chartCanvas(container)).toBeInTheDocument();
  });

  it("卸载时销毁图表实例", async () => {
    const { unmount } = renderChart({ bars: FIRST_PAGE });
    await waitFor(() => expect(lastChart().specs.length).toBe(1));

    unmount();
    expect(lastChart().destroyed).toBe(true);
  });
});

describe("KlineChart 无平移交互", () => {
  it("不注册 wheel/touch 监听:派发滚轮与触屏事件不触发重渲(越界边界不适用)", async () => {
    const addSpy = vi.spyOn(HTMLElement.prototype, "addEventListener");
    const { container } = renderChart({ bars: ALL_BARS });
    await waitFor(() => expect(lastChart().specs.length).toBe(1));
    const canvas = chartCanvas(container);

    // 只统计挂在图表画布自身上的监听(React 根容器的委托监听挂在别处,不计入)。
    const canvasTypes = addSpy.mock.calls
      .map((call, index) => ({
        type: String(call[0]),
        target: addSpy.mock.contexts[index] as HTMLElement | undefined
      }))
      .filter((entry) => entry.target === canvas)
      .map((entry) => entry.type);
    expect(canvasTypes).not.toContain("wheel");
    expect(canvasTypes.filter((type) => type.startsWith("touch"))).toEqual([]);
    // 悬停红虚线只挂定位用的 pointermove/pointerleave,不挂按下手势(平移未恢复)。
    expect([...new Set(canvasTypes.filter((type) => type.startsWith("pointer")))].sort()).toEqual([
      "pointerleave",
      "pointermove"
    ]);

    const specsBefore = lastChart().specs.length;
    canvas.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true })
    );
    canvas.dispatchEvent(new Event("touchstart", { bubbles: true, cancelable: true }));
    canvas.dispatchEvent(new Event("touchmove", { bubbles: true, cancelable: true }));
    canvas.dispatchEvent(new Event("touchend", { bubbles: true, cancelable: true }));

    expect(lastChart().specs.length).toBe(specsBefore);
    expect(specTimes()).toHaveLength(ALL_BARS.length);
    addSpy.mockRestore();
  });
});

describe("KlineChart 状态与分时模式", () => {
  it("空数据渲染 Empty 且不创建图表(空值边界)", () => {
    renderChart({ bars: [] });
    expect(screen.getByText("暂无数据")).toBeInTheDocument();
    expect(g2Mock.instances).toHaveLength(0);
  });

  it("loading 显示 Spin;loading 与空数据同时时 loading 优先(非法状态边界)", () => {
    const { rerender } = renderChart({ bars: FIRST_PAGE, loading: true });
    expect(screen.getByLabelText("图表加载中")).toBeInTheDocument();
    expect(screen.queryByText("暂无数据")).not.toBeInTheDocument();

    rerender(<KlineChart {...BASE_PROPS} bars={[]} loading />);
    expect(screen.getByLabelText("图表加载中")).toBeInTheDocument();
    expect(screen.queryByText("暂无数据")).not.toBeInTheDocument();

    rerender(<KlineChart {...BASE_PROPS} bars={[]} />);
    expect(screen.queryByLabelText("图表加载中")).not.toBeInTheDocument();
    expect(screen.getByText("暂无数据")).toBeInTheDocument();
  });

  it("零值数据(open/close/high/low/volume 均为 0)进 spec 不报错(零值边界)", async () => {
    const bars: KlineBar[] = [
      { time: "t000000", open: 0, close: 0, high: 0, low: 0, volume: 0, amount: null },
      { time: "t000001", open: 0, close: 0, high: 0, low: 0, volume: 0, amount: null }
    ];
    renderChart({ bars });
    await waitFor(() => expect(lastChart().specs.length).toBe(1));

    expect(specTimes()).toEqual(["t000000", "t000001"]);
    expect((mainViewOf(lastSpec()).data ?? [])[0]).toMatchObject({
      start: 0,
      end: 0,
      max: 0,
      min: 0,
      volume: 0
    });
  });

  it("分时模式渲染全部 trendPoints 的价格线(零值 price=0 不报错)", async () => {
    const points: TrendPoint[] = Array.from({ length: 200 }, (_, index) => ({
      time: `2026-10-09 ${pad(Math.floor(index / 2))}:${index % 2 === 0 ? "00" : "30"}`,
      price: index === 0 ? 0 : 3000 + index,
      avgPrice: index % 2 === 0 ? null : 3000 + index / 2,
      volume: index,
      open: null,
      high: null,
      low: null
    }));
    renderChart({ mode: "trend", trendPoints: points, hasAvgLine: true });
    await waitFor(() => expect(lastChart().specs.length).toBeGreaterThan(0));

    const labels = trendLabels();
    expect(labels).toHaveLength(points.length);
    expect(labels[0]).toBe(points[0].time.slice(5, 16));
    expect(labels[labels.length - 1]).toBe(points[199].time.slice(5, 16));
    // 趋势模式不画蜡烛,主图首个 mark 是价格线。
    expect((mainViewOf(lastSpec()).children ?? [])[0].encode).toMatchObject({
      x: "idx",
      y: "price"
    });
  });

  it("分时无数据时同样渲染 Empty(空值边界)", () => {
    renderChart({ mode: "trend", trendPoints: [], hasAvgLine: true });
    expect(screen.getByText("暂无数据")).toBeInTheDocument();
    expect(g2Mock.instances).toHaveLength(0);
  });

  it("prevClose=null 时不画昨收线(配置缺失边界)", async () => {
    const points: TrendPoint[] = [
      {
        time: "2026-10-09 09:31",
        price: 3000,
        avgPrice: 3000,
        volume: 5,
        open: null,
        high: null,
        low: null
      }
    ];
    renderChart({ mode: "trend", trendPoints: points, hasAvgLine: true, prevClose: null });
    await waitFor(() => expect(lastChart().specs.length).toBe(1));

    const types = (mainViewOf(lastSpec()).children ?? []).map((child) => child.type);
    expect(types).toEqual(["line", "line"]);
  });

  it("伦敦金(hasVolume=false)不出量柱副图:根 spec 退化为单个 view", async () => {
    renderChart({ bars: FIRST_PAGE, hasVolume: false });
    await waitFor(() => expect(lastChart().specs.length).toBeGreaterThan(0));

    expect(lastSpec().type).toBe("view");
    expect((lastSpec().children ?? []).some((child) => child.encode?.y === "volume")).toBe(false);
  });

  it("周期切换(spec 形状变化)销毁旧实例重建,趋势 spec 含均价线与昨收线", async () => {
    const { rerender } = renderChart({ bars: FIRST_PAGE });
    await waitFor(() => expect(lastChart().specs.length).toBe(1));
    const previousChart = lastChart();
    // K 线主图挂有浮标 + 十字光标配置(横虚线 / 竖实线)。
    const klineTooltip = (mainViewOf(lastSpec()).interaction?.tooltip ?? {}) as TooltipConfig;
    expect(klineTooltip.crosshairs).toBe(true);
    expect(klineTooltip.shared).toBe(true);
    expect(klineTooltip.crosshairsXLineDash).toEqual([4, 4]);
    expect(klineTooltip.crosshairsYLineDash).toEqual([]);

    const points: TrendPoint[] = [
      {
        time: "2026-10-09 09:31",
        price: 3000,
        avgPrice: 3000,
        volume: 5,
        open: null,
        high: null,
        low: null
      }
    ];
    rerender(
      <KlineChart {...BASE_PROPS} mode="trend" trendPoints={points} hasAvgLine prevClose={2999} />
    );
    await waitFor(() => expect(g2Mock.instances).toHaveLength(2));

    expect(previousChart.destroyed).toBe(true);
    const rebuilt = mainViewOf(lastSpec());
    expect((rebuilt.children ?? []).map((child) => child.type)).toEqual(["line", "line", "lineY"]);
    // 重建后整份 spec 再次下发(含浮标/十字光标),不在旧实例上残留、也不丢失。
    const trendTooltip = (rebuilt.interaction?.tooltip ?? {}) as TooltipConfig;
    expect(trendTooltip.crosshairs).toBe(true);
    expect(trendTooltip.crosshairsXLineDash).toEqual([4, 4]);
  });
});

// 悬停红虚线(需求:鼠标指向处额外一条贯穿图表宽度的红色虚线,与 G2 灰色十字光标共存)。
// 组件层 overlay:只做定位,不 preventDefault、不进 G2 spec(十字光标仍由 chart-spec 的 tooltip 配置负责)。
describe("KlineChart 悬停红虚线", () => {
  it("pointermove 在鼠标 y 处出现虚线、pointerleave 清除(空值/零值/越界边界)", async () => {
    const { container } = renderChart({ bars: FIRST_PAGE });
    await waitFor(() => expect(lastChart().specs.length).toBe(1));
    const canvas = chartCanvas(container);

    // 空值边界:未悬停时不渲染虚线(SSR/客户端首帧同构的依据)。
    expect(container.querySelector(".market-chart-hoverline")).not.toBeInTheDocument();

    // 零值边界:y=0 时虚线贴在容器顶(仍渲染,不被 0 当空值吞掉)。
    hoverChart(canvas, "pointermove", 0);
    expect(container.querySelector(".market-chart-hoverline")).toBeInTheDocument();
    expect(hoverLineTop(container)).toBe("0px");

    // 定位口径 = 鼠标相对容器顶部的 px(jsdom 的 rect 全 0,这里显式给顶部偏移验证是相对值)。
    canvas.getBoundingClientRect = (): DOMRect => ({ top: 100 }) as DOMRect;
    hoverChart(canvas, "pointermove", 137);
    expect(hoverLineTop(container)).toBe("37px");

    // 小数坐标取整(px 整数,避免亚像素抖动)。
    canvas.getBoundingClientRect = (): DOMRect => ({ top: 0.6 }) as DOMRect;
    hoverChart(canvas, "pointermove", 100.4);
    expect(hoverLineTop(container)).toBe("100px");

    // 越界边界:指针离开容器即清除。
    hoverChart(canvas, "pointerleave");
    expect(container.querySelector(".market-chart-hoverline")).not.toBeInTheDocument();
  });

  it("虚线只做 overlay:不改 G2 spec、不触发重建、不改动进 spec 的数据", async () => {
    const { container } = renderChart({ bars: FIRST_PAGE });
    await waitFor(() => expect(lastChart().specs.length).toBe(1));
    const canvas = chartCanvas(container);
    const specsBefore = lastChart().specs.length;

    hoverChart(canvas, "pointermove", 210);
    expect(container.querySelector(".market-chart-hoverline")).toBeInTheDocument();
    expect(lastChart().specs.length).toBe(specsBefore);
    expect(g2Mock.instances).toHaveLength(1);
    expect(specTimes()).toHaveLength(FIRST_PAGE.length);
  });

  it("SSR 直出不含虚线:hoverY 初值 null,首帧结构一致(水合不因悬停态分歧)", () => {
    const html = renderToString(<KlineChart {...BASE_PROPS} bars={FIRST_PAGE} />);
    expect(html).toContain("market-chart-canvas");
    expect(html).not.toContain("market-chart-hoverline");
  });

  it("loading 遮罩在虚线之上(非法状态边界:遮罩期间不露出悬停线)", async () => {
    const { container } = renderChart({ bars: FIRST_PAGE, loading: true });
    const canvas = chartCanvas(container);
    hoverChart(canvas, "pointermove", 120);

    const line = container.querySelector<HTMLElement>(".market-chart-hoverline");
    const mask = screen.getByLabelText("图表加载中");
    expect(line).toBeInTheDocument();
    // jsdom 不算层叠:层级由 kline-chart.css 的 z-index 契约保证(见下方 CSS 用例)。
    expect(mask).toBeInTheDocument();
    expect(line?.style.top).toBe("120px");
  });
});

// 圆角/阴影契约(需求:卡片边框与筛选栏/筛选控件一律直角无阴影)。
// jsdom 不计算样式,故对 CSS 源文本断言(与 layout 用例同款)。
describe("行情页直角无阴影(CSS 契约)", () => {
  it("悬停虚线:贯穿宽度 + 红色虚线 + 不吃指针事件 + 层级低于遮罩", () => {
    const css = readStyle("../../src/components/market/kline-chart.css");
    const line = ruleBody(css, ".market-chart-hoverline");
    expect(line).toContain("position: absolute");
    expect(line).toContain("left: 0; right: 0");
    expect(line).toContain("height: 0");
    // 涨色复用 instrument-section 的定稿变量(无该变量时兜底同值)。
    expect(line).toContain("border-top: 1px dashed var(--market-instrument-up, #f53f3f)");
    expect(line).toContain("pointer-events: none");

    const lineZ = Number(/z-index: (\d+)/.exec(line)?.[1]);
    const maskZ = Number(
      /z-index: (\d+)/.exec(ruleBody(css, ".market-chart-loading, .market-chart-empty"))?.[1]
    );
    expect(lineZ).toBeGreaterThan(0);
    expect(maskZ).toBeGreaterThan(lineZ);
  });

  it("标的卡片:保留 1px 边框,圆角与投影全清", () => {
    const css = readStyle("../../src/components/market/instrument-section.css");
    const card = ruleBody(css, ".market-instrument");
    expect(card).toContain("border: 1px solid var(--color-border-2, #e5e6eb)");
    expect(card).not.toContain("border-radius");
    expect(card).not.toContain("box-shadow");
    // 卡片内其余圆角来源(来源角标 / 图表区错误块 / 均线图例色点 / Arco「重试」按钮)一并归零。
    expect(ruleBody(css, ".market-instrument-source")).not.toContain("border-radius");
    expect(ruleBody(css, ".market-instrument-error")).not.toContain("border-radius");
    expect(ruleBody(css, ".market-instrument-ma-dot")).toContain("border-radius: 0");
    expect(ruleBody(css, ".market-instrument .arco-btn")).toContain("border-radius: 0");
    expect(css).not.toContain("box-shadow");
  });

  it("筛选栏:直角 + 1px 下边框分隔(阴影移除),吸顶定位与层级维持原值", () => {
    const css = readStyle("../../src/components/market/market-filter-bar.css");
    const bar = ruleBody(css, ".market-filter-bar");
    expect(bar).toContain("border-bottom: 1px solid var(--color-border-2, #e5e6eb)");
    expect(bar).not.toContain("border-radius");
    expect(bar).not.toContain("box-shadow");
    expect(bar).toContain("position: sticky");
    expect(bar).toContain("top: var(--site-header-h, 0px)");
    expect(bar).toContain("z-index: 10");
  });

  it("筛选控件与 Portal 弹层直角化(实测 Arco 类名:arco-picker / arco-select-view / arco-radio-button)", () => {
    const css = readStyle("../../src/components/market/market-filter-bar.css");
    const controls = ruleBody(css, ".market-filter-bar .arco-picker");
    expect(controls).toContain("border-radius: 0");
    expect(controls).toContain(".market-filter-bar .arco-select-view");
    expect(controls).toContain(".market-filter-bar .arco-input");
    // Radio.Group type=button 的圆角落在项自身与首尾项的 ::after 边框上,须一并覆盖。
    expect(controls).toContain(".market-filter-bar .arco-radio-group .arco-radio-button");
    expect(controls).toContain(".market-filter-bar .arco-radio-group .arco-radio-button::after");

    // 下拉/日期面板挂在 body(Portal),不在筛选栏作用域内,用全局选择器去圆角去阴影。
    const popup = ruleBody(css, "body .arco-select-popup");
    expect(popup).toContain("border-radius: 0");
    expect(popup).toContain("box-shadow: none");
    expect(popup).toContain("body .arco-picker-container");
    expect(popup).toContain("body .arco-picker-range-container");
  });
});
