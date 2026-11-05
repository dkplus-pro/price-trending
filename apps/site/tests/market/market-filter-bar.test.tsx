// MarketFilterBar 组件用例(行情页全局筛选栏:周期 / 日期范围 / 数据源,吸顶固定):
// 三组控件渲染与受控回显、写 store 入口(周期按钮 / 日期面板点选 / 数据源下拉)、
// 快捷跨度收在日期面板 extra 区(面板打开才渲染、点档写 store 并收起面板、命中档高亮、自定义范围不高亮)、
// 分时两档禁用日期范围(面板打不开、extra 档位整体禁用)、跨组件共享、SSR 首帧一致性回归。
// 六类边界:空值(外部注入非法 dateRange)、零值(月首/年首见 store 用例)、
// 越界(未来日期禁选、月末溢出见 store 用例)、配置缺失(N/A,组件无配置入参)、网络失败(N/A,组件不发请求)、
// 非法状态(周期为分时时改 dateRange 仍写 store;面板内依次点两档取最终态)。
// SSR 首帧一致性(hydration 回归,两端首帧必须一致):
// ① 时间依赖值不上首帧——store 默认 dateRange 按当前时间计算(SSR 进程启动日 ≠ 浏览器当天),
//    首帧 HTML 不得含任何日期串,挂载后才回填真实范围;
// ② 无位置派生 id——useId 在 dev 下随客户端树结构错位(SSR/客户端包裹层级不同,实测必现),
//    控件组可访问名用静态 aria-label,首帧 HTML 不得含 aria-labelledby / React useId 形态的 id。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import MarketFilterBar, {
  isFutureDate,
  MarketQuickRange
} from "../../src/components/market/market-filter-bar";
import {
  computeQuickRange,
  getDefaultDateRange,
  QUICK_RANGE_OPTIONS,
  useMarketFilterStore
} from "../../src/store/market-filter";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 非锚定的日期串形态(用于断言首帧 HTML 不含任何具体日期)。 */
const DATE_STRING_PATTERN = /\d{4}-\d{2}-\d{2}/;

/** 日期范围禁用原因文案(行内 Tooltip 与面板内 title 同值)。 */
const DISABLED_HINT = "分时/五日不支持日期范围";

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

/** 面板 extra 区内的快捷档位单选组(面板未打开时抛错,让用例尽早暴露)。 */
function quickGroup(): HTMLElement {
  const group = document.querySelector<HTMLElement>(".market-filter-quick");
  if (group === null) {
    throw new Error("未找到日期面板 extra 区内的快捷档位组");
  }
  return group;
}

/** 面板内全部快捷档位单选项(顺序即渲染顺序;数量与 label 均由 store 决定,用例不硬编码)。 */
function quickOptions(): HTMLInputElement[] {
  return within(quickGroup()).getAllByRole("radio") as HTMLInputElement[];
}

/** 面板内某档位是否高亮(受控比对命中时选中态落在内部 input 上)。 */
function isQuickChecked(label: string): boolean {
  return (within(quickGroup()).getByRole("radio", { name: label }) as HTMLInputElement).checked;
}

/** 单元格是否被 Arco 标为禁用(disabledDate 命中)。 */
function isCellDisabled(cell: HTMLElement): boolean {
  return cell.className.includes("arco-picker-cell-disabled");
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

  it("筛选栏行内不再渲染快捷档位:只剩周期 / 日期范围 / 数据源三组", () => {
    const { container } = render(<MarketFilterBar />);
    const bar = container.querySelector<HTMLElement>(".market-filter-bar");
    const barNode = bar as HTMLElement;

    // 快捷档位只随日期面板挂载:面板未打开时筛选栏内既没有新的快捷组,也没有旧的行内按钮排。
    expect(barNode.querySelector(".market-filter-quick")).toBeNull();
    expect(barNode.querySelector(".market-filter-quick-panel")).toBeNull();
    expect(within(barNode).getAllByRole("group")).toHaveLength(3);
    expect(
      within(barNode)
        .getAllByRole("radio")
        .map((radio) => (radio as HTMLInputElement).value)
    ).toEqual(["minute", "fiveday", "day", "week", "month"]);
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

describe("MarketFilterBar 快捷日期范围(日期面板 extra 区)", () => {
  it("打开日期面板后 extra 区渲染 store 的全部档位(数量与顺序同 QUICK_RANGE_OPTIONS)", () => {
    useMarketFilterStore.setState({ period: "day" });
    const { container } = render(<MarketFilterBar />);
    expect(document.querySelector(".market-filter-quick")).toBeNull();

    openDatePanel(container);

    // 落位在 Arco 的 extra 容器里(日期面板页脚),而非筛选栏行内。
    expect(quickGroup().closest(".arco-picker-footer-extra-wrapper")).not.toBeNull();
    const options = quickOptions();
    expect(options).toHaveLength(QUICK_RANGE_OPTIONS.length);
    expect(options.map((option) => option.value)).toEqual(
      QUICK_RANGE_OPTIONS.map(({ key }) => key)
    );
    expect(options.map((option) => option.closest("label")?.textContent)).toEqual(
      QUICK_RANGE_OPTIONS.map(({ label }) => label)
    );
  });

  it("点面板内「5天」写 store.dateRange 并收起面板,再点输入框可重新打开", async () => {
    useMarketFilterStore.setState({ period: "day" });
    const { container } = render(<MarketFilterBar />);
    const initialRange = getDefaultDateRange();

    // 「5天」是 store 新增档位;若 store 在途尚未合入(六档版),回退到最后一档(跨度最大,必偏离默认范围)。
    const target =
      QUICK_RANGE_OPTIONS.find(({ label }) => label === "5天") ??
      QUICK_RANGE_OPTIONS[QUICK_RANGE_OPTIONS.length - 1];
    const expected = computeQuickRange(target.key);
    expect(expected).not.toEqual(initialRange);

    openDatePanel(container);
    fireEvent.click(within(quickGroup()).getByRole("radio", { name: target.label }));

    expect(useMarketFilterStore.getState().dateRange).toEqual(expected);
    // 其余筛选字段不动。
    expect(useMarketFilterStore.getState().period).toBe("day");
    expect(useMarketFilterStore.getState().source).toBe("auto");
    expect(dateInputs(container).map((input) => input.value)).toEqual(expected);

    // 面板收起(受控 popupVisible 置 false,退场动画后弹层节点卸载),受控态未卡死:还能再打开。
    await waitFor(() => expect(document.querySelector(".market-filter-quick")).toBeNull());
    openDatePanel(container);
    expect(quickOptions()).toHaveLength(QUICK_RANGE_OPTIONS.length);
  });

  it("面板内当前范围命中的档位高亮,自定义范围整排不高亮", () => {
    const target = QUICK_RANGE_OPTIONS[QUICK_RANGE_OPTIONS.length - 1];
    useMarketFilterStore.setState({ period: "day", dateRange: computeQuickRange(target.key) });
    const { container } = render(<MarketFilterBar />);

    openDatePanel(container);

    expect(isQuickChecked(target.label)).toBe(true);
    for (const { key, label } of QUICK_RANGE_OPTIONS) {
      if (key !== target.key) {
        expect(isQuickChecked(label)).toBe(false);
      }
    }

    // 手选 / 外部置入的自定义范围:起止都不等于任何档位(档位终点恒为今天),整排都不高亮。
    act(() => {
      useMarketFilterStore.getState().setDateRange(["2020-01-01", "2020-01-31"]);
    });

    expect(QUICK_RANGE_OPTIONS.every(({ label }) => !isQuickChecked(label))).toBe(true);
    expect(dateInputs(container).map((input) => input.value)).toEqual(["2020-01-01", "2020-01-31"]);
  });

  it("面板内依次点两档:最终态为最后一次点击的档位,且只有该档高亮(非法状态)", async () => {
    // 起点为自定义范围(不命中任何档):两次点击都真正改值,避开「点中已选档位」时 radio 无 change 事件的语义干扰。
    useMarketFilterStore.setState({ period: "day", dateRange: ["2020-01-01", "2020-01-31"] });
    const { container } = render(<MarketFilterBar />);

    const first = QUICK_RANGE_OPTIONS[0];
    const last = QUICK_RANGE_OPTIONS[QUICK_RANGE_OPTIONS.length - 1];
    expect(first.key).not.toBe(last.key);

    openDatePanel(container);
    fireEvent.click(within(quickGroup()).getByRole("radio", { name: first.label }));
    expect(useMarketFilterStore.getState().dateRange).toEqual(computeQuickRange(first.key));

    // 点档即收起面板,故第二次点击前需重新打开(受控开合不卡死)。
    await waitFor(() => expect(document.querySelector(".market-filter-quick")).toBeNull());
    openDatePanel(container);
    fireEvent.click(within(quickGroup()).getByRole("radio", { name: last.label }));

    expect(useMarketFilterStore.getState().dateRange).toEqual(computeQuickRange(last.key));
    await waitFor(() => expect(document.querySelector(".market-filter-quick")).toBeNull());
    openDatePanel(container);
    expect(isQuickChecked(last.label)).toBe(true);
    expect(isQuickChecked(first.label)).toBe(false);
  });

  it("分时 / 五日档面板打不开且 extra 档位整体禁用,切到日K 后恢复", () => {
    const { container } = render(<MarketFilterBar />);

    // 禁用态下 RangePicker 的 Trigger 被 disabled:点输入框不渲染面板,extra 也就无从挂载。
    fireEvent.click(dateInputs(container)[0]);
    expect(document.querySelector(".market-filter-quick")).toBeNull();

    // extra 档位与 RangePicker 同禁用:面板在禁用态本就打不开,故直接单测 extra 组件本身
    // (与上面 RangePicker 的禁用断言合起来构成覆盖);禁用提示走包裹层原生 title。
    const disabledExtra = render(
      <MarketQuickRange disabled matchedKey={undefined} onSelect={() => undefined} />
    );
    const disabledOptions = within(disabledExtra.container).getAllByRole(
      "radio"
    ) as HTMLInputElement[];
    expect(disabledOptions).toHaveLength(QUICK_RANGE_OPTIONS.length);
    expect(disabledOptions.every((option) => option.disabled)).toBe(true);
    expect(disabledExtra.container.querySelector(".market-filter-quick-panel")).toHaveAttribute(
      "title",
      DISABLED_HINT
    );
    disabledExtra.unmount();

    // 日K 档恢复:面板可打开,extra 档位可点。
    fireEvent.click(screen.getByRole("radio", { name: "日K" }));
    openDatePanel(container);
    expect(quickOptions().every((option) => !option.disabled)).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: "五日" }));
    expect(dateInputs(container).every((input) => input.disabled)).toBe(true);
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

    expect(await screen.findByText(DISABLED_HINT)).toBeInTheDocument();
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
  it("store 被外部置入非法 dateRange 时组件不炸,面板内整排不高亮(空值边界)", () => {
    const initialRange = getDefaultDateRange();
    const illegalValues: unknown[] = [null, [], ["2026-01-01"]];
    useMarketFilterStore.setState({ period: "day" });

    for (const illegal of illegalValues) {
      useMarketFilterStore.setState({ dateRange: illegal as [string, string] });
      const { container, unmount } = render(<MarketFilterBar />);

      // 不抛错即可:非法值由 Arco 自行降级为空/半空展示,组件不做额外校验。
      expect(container.querySelector(".market-filter-bar")).toBeInTheDocument();
      expect(dateInputs(container)).toHaveLength(2);

      openDatePanel(container);
      // 快捷档位照常全量渲染,但高亮比对容错(null / 半截数组都不命中)。
      expect(quickOptions()).toHaveLength(QUICK_RANGE_OPTIONS.length);
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
    // 面板内的快捷档位不受 disabledDate 影响(档位终点恒为今天,永远合法)。
    expect(quickOptions().every((option) => !option.disabled)).toBe(true);
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

  it("SSR 首帧不渲染具体日期、不含位置派生 id(hydration 回归:两端首帧一致)", () => {
    const html = renderToString(<MarketFilterBar />);

    expect(html).toContain("行情筛选");
    for (const label of ["周期", "日期范围", "数据源"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("分时");
    expect(html).toContain("自动(多源兜底)");
    // 快捷档位随日期面板挂载:SSR 不渲染弹层,故不出现在首帧 HTML。
    for (const { label } of QUICK_RANGE_OPTIONS) {
      expect(html).not.toContain(label);
    }
    // ① 时间依赖值不上首帧:store 默认 dateRange 按当前时间计算(SSR 进程启动日 ≠ 浏览器当天),
    //    首帧 HTML 含日期串即构成 SSR/客户端 hydration 错配 → 挂载前一律为空输入框。
    expect(html).not.toMatch(DATE_STRING_PATTERN);
    // ② 无位置派生 id:useId 的 id 随树位置推导,dev 下客户端树包裹层级与 SSR 不同必错位,
    //    控件组可访问名由静态 aria-label 提供(首帧 HTML 里不应再出现 labelledby 关联形态)。
    expect(html).not.toContain("aria-labelledby");
    expect(html).not.toContain("_modern-js-R_");
    // 可访问名仍与可见文案一致(静态 aria-label)。
    expect(html).toContain('aria-label="周期"');
    expect(html).toContain('aria-label="日期范围"');
    expect(html).toContain('aria-label="数据源"');
  });

  it("客户端挂载后回填真实日期范围(首帧为空 → mounted 后含 store 默认范围)", () => {
    const { container } = render(<MarketFilterBar />);

    // 挂载后(测试环境 effect 已冲刷)输入框回填浏览器当天范围;交互语义与修复前一致。
    expect(dateInputs(container).map((input) => input.value)).toEqual(getDefaultDateRange());
    // 首帧(等价 SSR 输出)不含该日期串,证明回填确实发生在挂载之后。
    expect(renderToString(<MarketFilterBar />)).not.toMatch(DATE_STRING_PATTERN);
  });
});
