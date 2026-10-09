// MarketFilterBar 组件用例(行情页全局筛选栏:周期 / 日期范围(含快捷跨度)/ 数据源,吸顶固定):
// 三组控件渲染与受控回显、写 store 入口(周期按钮 / 日期面板点选 / 数据源下拉 / 快捷跨度按钮)、
// 快捷跨度的高亮比对(命中才高亮、自定义范围不高亮)、分时两档禁用日期范围与快捷按钮、跨组件共享、SSR 直出。
// 六类边界:空值(外部注入非法 dateRange)、零值(月首/年首见 store 用例)、
// 越界(未来日期禁选、月末溢出见 store 用例)、配置缺失(N/A,组件无配置入参)、网络失败(N/A,组件不发请求)、
// 非法状态(周期为分时时改 dateRange 仍写 store;快速连点快捷项取最终态)。
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import MarketFilterBar, { isFutureDate } from "../../src/components/market/market-filter-bar";
import {
  computeQuickRange,
  getDefaultDateRange,
  QUICK_RANGE_OPTIONS,
  useMarketFilterStore
} from "../../src/store/market-filter";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 本地今天 "YYYY-MM-DD"(与 store 的 getDefaultDateRange 同口径)。 */
function today(): string {
  const now = new Date();
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 日期范围两个输入框(RangePicker 内部 input:禁用态与回显都看这里)。 */
function dateInputs(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>(".market-filter-dates input"));
}

/** 点开始输入框打开日期面板,返回面板内当月的日期单元格(顺序即 1 号起)。 */
function openDatePanel(container: HTMLElement): HTMLElement[] {
  const [startInput] = dateInputs(container);
  if (startInput === undefined) {
    throw new Error("未找到日期范围输入框");
  }
  fireEvent.click(startInput);
  return Array.from(document.querySelectorAll<HTMLElement>(".arco-picker-cell-in-view"));
}

/** 单元格是否被 Arco 标为禁用(disabledDate 命中)。 */
function isCellDisabled(cell: HTMLElement): boolean {
  return cell.className.includes("arco-picker-cell-disabled");
}

/** 某个快捷跨度项是否高亮(受控比对命中时选中态落在内部 input 上)。 */
function isQuickChecked(label: string): boolean {
  return (screen.getByRole("radio", { name: label }) as HTMLInputElement).checked;
}

/** 打开数据源下拉并返回选项节点(Arco Select 弹层渲染在 body)。 */
async function openSourceOptions(container: HTMLElement): Promise<HTMLElement[]> {
  const view = container.querySelector<HTMLElement>(".arco-select-view");
  if (view === null) {
    throw new Error("未找到数据源选择框");
  }
  fireEvent.click(view);
  await screen.findByText("腾讯", { selector: ".arco-select-option" });
  return Array.from(document.querySelectorAll<HTMLElement>(".arco-select-option"));
}

// store 是模块级单例:每个用例前复位(period/source/dateRange),避免用例间串味。
beforeEach(() => {
  useMarketFilterStore.setState({
    period: "minute",
    source: "auto",
    dateRange: getDefaultDateRange()
  });
});

describe("MarketFilterBar 渲染与受控回显", () => {
  it("三组控件齐备:周期五项、日期范围默认值、数据源默认自动", () => {
    const { container } = render(<MarketFilterBar />);

    const periodGroup = screen.getByRole("group", { name: "周期" });
    expect(
      within(periodGroup)
        .getAllByRole("radio")
        .map((radio) => (radio as HTMLInputElement).value)
    ).toEqual(["minute", "fiveday", "day", "week", "month"]);
    expect(within(periodGroup).getByRole("radio", { name: "分时" })).toBeChecked();

    const [beg, end] = getDefaultDateRange();
    const dateGroup = screen.getByRole("group", { name: "日期范围" });
    expect(dateInputs(dateGroup as HTMLElement).map((input) => input.value)).toEqual([beg, end]);

    const sourceGroup = screen.getByRole("group", { name: "数据源" });
    expect(within(sourceGroup).getByText("自动(多源兜底)")).toBeInTheDocument();
    expect(container.querySelector(".market-filter-bar")).toBeInTheDocument();
  });

  it("回显 store 当前值(周期与数据源受控)", () => {
    useMarketFilterStore.setState({ period: "week", source: "eastmoney" });
    render(<MarketFilterBar />);

    expect(screen.getByRole("radio", { name: "周K" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "分时" })).not.toBeChecked();
    expect(screen.getByText("东方财富")).toBeInTheDocument();
  });
});

describe("MarketFilterBar 写 store", () => {
  it("点「日K」写 store.period", () => {
    render(<MarketFilterBar />);

    fireEvent.click(screen.getByRole("radio", { name: "日K" }));

    expect(useMarketFilterStore.getState().period).toBe("day");
    expect(screen.getByRole("radio", { name: "日K" })).toBeChecked();
    // 周期是唯一被改动的字段。
    expect(useMarketFilterStore.getState().source).toBe("auto");
  });

  it("数据源下拉选「腾讯」写 store.source", async () => {
    const { container } = render(<MarketFilterBar />);

    const options = await openSourceOptions(container);
    const tencentOption = options.find((option) => option.textContent === "腾讯");
    expect(tencentOption).toBeDefined();
    fireEvent.click(tencentOption as HTMLElement);

    expect(useMarketFilterStore.getState().source).toBe("tencent");
    expect(useMarketFilterStore.getState().period).toBe("minute");
  });

  it("日期面板点选写 store.dateRange,并把新范围受控回显到输入框", () => {
    const initialRange = getDefaultDateRange();
    useMarketFilterStore.setState({ period: "day", dateRange: initialRange });
    const { container } = render(<MarketFilterBar />);

    const cells = openDatePanel(container);
    const firstSelectable = cells.find((cell) => !isCellDisabled(cell));
    expect(firstSelectable).toBeDefined();
    fireEvent.click(firstSelectable as HTMLElement);

    const nextRange = useMarketFilterStore.getState().dateRange;
    expect(nextRange).not.toEqual(initialRange);
    expect(nextRange[0]).toMatch(DATE_PATTERN);
    expect(nextRange[1]).toMatch(DATE_PATTERN);
    // 结束日期未动(只点了开始日期),两个输入框回显 store 当前范围。
    expect(nextRange[1]).toBe(initialRange[1]);
    expect(dateInputs(container).map((input) => input.value)).toEqual([nextRange[0], nextRange[1]]);
  });
});

describe("MarketFilterBar 快捷日期范围", () => {
  it("日期范围组内渲染六个快捷项(顺序 一周 / 2周 / 1个月 / 3个月 / 半年 / 1年)", () => {
    render(<MarketFilterBar />);

    const dateGroup = screen.getByRole("group", { name: "日期范围" });
    expect(
      within(dateGroup)
        .getAllByRole("radio")
        .map((radio) => (radio as HTMLInputElement).value)
    ).toEqual(QUICK_RANGE_OPTIONS.map(({ key }) => key));
  });

  it("点「1个月」写 store.dateRange 为对应区间,并把新范围回显到 RangePicker", () => {
    useMarketFilterStore.setState({ period: "day" });
    const { container } = render(<MarketFilterBar />);
    const initialRange = getDefaultDateRange();

    fireEvent.click(screen.getByRole("radio", { name: "1个月" }));

    const expected = computeQuickRange("1m");
    expect(expected[0]).not.toBe(initialRange[0]);
    expect(useMarketFilterStore.getState().dateRange).toEqual(expected);
    // 其余筛选字段不动。
    expect(useMarketFilterStore.getState().period).toBe("day");
    expect(useMarketFilterStore.getState().source).toBe("auto");
    expect(dateInputs(container).map((input) => input.value)).toEqual(expected);
  });

  it("当前范围恰为某快捷区间时只有该项高亮", () => {
    useMarketFilterStore.setState({ period: "day", dateRange: computeQuickRange("3m") });
    render(<MarketFilterBar />);

    expect(isQuickChecked("3个月")).toBe(true);
    expect(isQuickChecked("1个月")).toBe(false);
    expect(isQuickChecked("1年")).toBe(false);
  });

  it("手选自定义范围后无任何快捷项高亮(受控比对不命中)", () => {
    useMarketFilterStore.setState({ period: "day", dateRange: computeQuickRange("1w") });
    const { container } = render(<MarketFilterBar />);
    expect(isQuickChecked("一周")).toBe(true);

    act(() => {
      useMarketFilterStore.getState().setDateRange(["2026-01-01", "2026-01-31"]);
    });

    expect(QUICK_RANGE_OPTIONS.every(({ label }) => !isQuickChecked(label))).toBe(true);
    expect(dateInputs(container).map((input) => input.value)).toEqual(["2026-01-01", "2026-01-31"]);
  });

  it("分时 / 五日禁用快捷按钮(点击不写 store),切到日K 后恢复", () => {
    const initialRange = getDefaultDateRange();
    render(<MarketFilterBar />);

    expect(screen.getByRole("radio", { name: "1个月" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "1个月" }));
    expect(useMarketFilterStore.getState().dateRange).toEqual(initialRange);

    fireEvent.click(screen.getByRole("radio", { name: "日K" }));
    expect(screen.getByRole("radio", { name: "1个月" })).toBeEnabled();

    fireEvent.click(screen.getByRole("radio", { name: "五日" }));
    expect(screen.getByRole("radio", { name: "1个月" })).toBeDisabled();
  });

  it("快速连点快捷项:最终态为最后一次点击的区间,且只有该项高亮(非法状态)", () => {
    useMarketFilterStore.setState({ period: "day" });
    render(<MarketFilterBar />);

    fireEvent.click(screen.getByRole("radio", { name: "一周" }));
    fireEvent.click(screen.getByRole("radio", { name: "1年" }));
    fireEvent.click(screen.getByRole("radio", { name: "半年" }));

    expect(useMarketFilterStore.getState().dateRange).toEqual(computeQuickRange("6m"));
    expect(isQuickChecked("半年")).toBe(true);
    expect(isQuickChecked("一周")).toBe(false);
    expect(isQuickChecked("1年")).toBe(false);
  });
});

describe("MarketFilterBar 日期范围的启用与禁用", () => {
  it("分时 / 五日禁用日期范围,切到日K 后启用且保留当前范围", () => {
    const { container } = render(<MarketFilterBar />);

    expect(dateInputs(container).every((input) => input.disabled)).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: "日K" }));
    expect(dateInputs(container).every((input) => input.disabled)).toBe(false);
    // 禁用期间范围不被清空,启用后原样回显。
    expect(dateInputs(container).map((input) => input.value)).toEqual(getDefaultDateRange());

    fireEvent.click(screen.getByRole("radio", { name: "五日" }));
    expect(dateInputs(container).every((input) => input.disabled)).toBe(true);
  });

  it("分时档悬停日期范围给出 Tooltip 提示(禁用原因)", async () => {
    const { container } = render(<MarketFilterBar />);

    const wrap = container.querySelector(".market-filter-dates-wrap");
    expect(wrap).toBeInTheDocument();
    await userEvent.hover(wrap as Element);

    expect(await screen.findByText("分时/五日不支持日期范围")).toBeInTheDocument();
  });
});

describe("MarketFilterBar 跨组件共享", () => {
  it("两个筛选栏读同一个 store:改其一,另一同步联动", () => {
    const first = render(<MarketFilterBar />);
    const second = render(<MarketFilterBar />);

    fireEvent.click(within(first.container).getByRole("radio", { name: "月K" }));

    expect(useMarketFilterStore.getState().period).toBe("month");
    expect(within(second.container).getByRole("radio", { name: "月K" })).toBeChecked();
    expect(within(second.container).getByRole("radio", { name: "分时" })).not.toBeChecked();
  });
});

describe("MarketFilterBar 边界", () => {
  it("store 被外部置入非法 dateRange 时组件不炸(空值边界)", () => {
    const initialRange = getDefaultDateRange();
    const illegalValues: unknown[] = [null, [], ["2026-01-01"]];

    for (const illegal of illegalValues) {
      useMarketFilterStore.setState({ dateRange: illegal as [string, string] });
      const { container, unmount } = render(<MarketFilterBar />);

      // 不抛错即可:非法值由 Arco 自行降级为空/半空展示,组件不做额外校验;
      // 快捷项的高亮比对同样容错(null / 半截数组都不命中)。
      expect(container.querySelector(".market-filter-bar")).toBeInTheDocument();
      expect(dateInputs(container)).toHaveLength(2);
      expect(QUICK_RANGE_OPTIONS.every(({ label }) => !isQuickChecked(label))).toBe(true);
      unmount();
    }

    // 恢复合法值(后续用例与真实运行都依赖 store 恒为两段字符串)。
    useMarketFilterStore.getState().setDateRange(initialRange);
    expect(useMarketFilterStore.getState().dateRange).toEqual(initialRange);
  });

  it("禁选未来日期:今天可选、明天起禁选,面板内未来单元格为禁用态(越界边界)", () => {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    // 结构子集替身(测试侧不引 dayjs:site 未声明该依赖)。
    expect(isFutureDate({ startOf: () => ({ valueOf: () => now.getTime() }) })).toBe(false);
    expect(isFutureDate({ startOf: () => ({ valueOf: () => tomorrow.getTime() }) })).toBe(true);

    useMarketFilterStore.setState({ period: "day", dateRange: [today(), today()] });
    const { container } = render(<MarketFilterBar />);

    const cells = openDatePanel(container);
    // 左面板为开始日期所在月(本月):今天之后的日子禁用;右面板(下月)整月都是未来日期。
    const todayCell = cells[now.getDate() - 1];
    expect(todayCell).toBeDefined();
    expect(isCellDisabled(todayCell as HTMLElement)).toBe(false);
    expect(cells.some((cell) => cell !== todayCell && isCellDisabled(cell))).toBe(true);
  });

  it("周期为分时时改 dateRange:组件不拦(仍写 store 并灰态回显),由图表侧按周期忽略(非法状态)", () => {
    const { container } = render(<MarketFilterBar />);
    expect(useMarketFilterStore.getState().period).toBe("minute");

    // 组件层不做「不支持的周期就清空范围」的联动:写入直接落 store,图表消费方按周期自行忽略。
    act(() => {
      useMarketFilterStore.getState().setDateRange(["2026-01-01", "2026-01-31"]);
    });

    expect(useMarketFilterStore.getState().dateRange).toEqual(["2026-01-01", "2026-01-31"]);
    expect(useMarketFilterStore.getState().period).toBe("minute");
    expect(dateInputs(container).every((input) => input.disabled)).toBe(true);
    expect(dateInputs(container).map((input) => input.value)).toEqual(["2026-01-01", "2026-01-31"]);
  });

  it("SSR 直出默认筛选态(renderToString 不依赖 window)", () => {
    const html = renderToString(<MarketFilterBar />);

    expect(html).toContain("行情筛选");
    for (const label of ["周期", "日期范围", "数据源"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("分时");
    expect(html).toContain("自动(多源兜底)");
    // 快捷跨度按钮随 SSR 一并直出。
    for (const { label } of QUICK_RANGE_OPTIONS) {
      expect(html).toContain(label);
    }
    // 日期范围来自 store 创建时的默认值(组件内不重算当天日期)。
    expect(html).toContain(getDefaultDateRange()[0]);
  });
});
