import "@arco-design/web-react/es/_util/react-19-adapter";
import { DatePicker, Radio, Select, Tooltip } from "@arco-design/web-react";
import { useCallback, useEffect, useState } from "react";

import type { ChartPeriod } from "../../api/market/types";
import type { MarketSource, QuickRangeKey } from "../../store/market-filter";
import {
  computeQuickRange,
  getDefaultDateRange,
  QUICK_RANGE_OPTIONS,
  useMarketFilterStore
} from "../../store/market-filter";

import "./market-filter-bar.css";

/** 周期切换项(顺序即展示顺序;与 store 默认「minute」对应)。 */
const PERIOD_OPTIONS: { label: string; value: ChartPeriod }[] = [
  { label: "分时", value: "minute" },
  { label: "五日", value: "fiveday" },
  { label: "日K", value: "day" },
  { label: "周K", value: "week" },
  { label: "月K", value: "month" }
];

/** 数据源选项:auto 走多源兜底链(东财 → 腾讯 → gold-api),指定源不兜底。 */
const SOURCE_OPTIONS: { label: string; value: MarketSource }[] = [
  { label: "自动(多源兜底)", value: "auto" },
  { label: "东方财富", value: "eastmoney" },
  { label: "腾讯", value: "tencent" }
];

/** 不支持日期范围的周期(分时两档走走势接口,无 K 线区间概念)。 */
const PERIODS_WITHOUT_DATE_RANGE: ChartPeriod[] = ["minute", "fiveday"];

/** 分时 / 五日不支持日期范围的原因文案(行内 Tooltip 与面板内禁用提示共用一份)。 */
const DATE_RANGE_DISABLED_HINT = "分时/五日不支持日期范围";

/** Arco Radio.Group 的 options 契约是 { label, value }:把快捷跨度的 key 映射成 value。 */
const QUICK_SELECT_OPTIONS = QUICK_RANGE_OPTIONS.map(({ key, label }) => ({ label, value: key }));

/**
 * 当前范围命中的快捷项:按今天重算各档起点做受控比对。
 * 手选的自定义范围(或外部置入的非法值)不命中任何档,返回 undefined 即全部不高亮。
 */
function matchQuickRange(range: readonly string[] | null | undefined): QuickRangeKey | undefined {
  const [beg, end] = range ?? [];
  return QUICK_RANGE_OPTIONS.find(({ key }) => {
    const [quickBeg, quickEnd] = computeQuickRange(key);
    return quickBeg === beg && quickEnd === end;
  })?.key;
}

/** Arco disabledDate 入参的结构子集(site 未声明 dayjs 依赖,不引其类型)。 */
interface DayjsLike {
  startOf: (unit: "day") => { valueOf: () => number };
}

/** 禁选未来日期:按自然日比较(今天可选,明天起禁选)。 */
export function isFutureDate(current: DayjsLike): boolean {
  return current.startOf("day").valueOf() > Date.now();
}

export interface MarketQuickRangeProps {
  /** 与 RangePicker 同步的禁用态(分时 / 五日两档)。 */
  disabled: boolean;
  /** 当前范围命中的档位:命中才高亮,自定义范围传 undefined(整排不高亮)。 */
  matchedKey?: QuickRangeKey;
  onSelect: (key: QuickRangeKey) => void;
}

/**
 * 日期面板 extra 区的快捷档位排:档位数量 / 顺序 / 禁用规则全部来自 store 的 QUICK_RANGE_OPTIONS,不硬编码。
 * mini 按钮组按内容折行 —— 日期面板宽度有限,档位多时一排放不下。
 * 单独导出供测试:面板在禁用态本就打不开(Arco Trigger 被 disabled),面板内的禁用态无法从外部门测到。
 */
export function MarketQuickRange({ disabled, matchedKey, onSelect }: MarketQuickRangeProps) {
  return (
    // 面板内的禁用提示走包裹层原生 title:Arco Tooltip 需要能收事件的触发层,而禁用按钮吞事件;
    // 行内提示仍由日期范围包裹层的 Tooltip 承担(见 MarketFilterBar),两处共用同一文案常量。
    <div
      className="market-filter-quick-panel"
      title={disabled ? DATE_RANGE_DISABLED_HINT : undefined}
    >
      <Radio.Group
        className="market-filter-quick"
        type="button"
        size="mini"
        options={QUICK_SELECT_OPTIONS}
        value={matchedKey}
        disabled={disabled}
        // 点档即写 store 并收起面板(由 onChange 驱动,键盘方向键切换同样生效);
        // 点中的恰是当前高亮档位时 radio 不产生 change 事件,面板保持打开(标准 radio 语义)。
        onChange={onSelect}
      />
    </div>
  );
}

/**
 * 行情页全局筛选栏(黄金价格 / 国内指数两页共用):周期 + 日期范围 + 数据源,吸顶固定。
 * 状态自读写 useMarketFilterStore(无 props),两页跨页保持筛选态。
 * 快捷跨度(1天 / 1周 / ...)收在日期面板 extra 区内,行内不再单独占位。
 *
 * hydration 纪律(两端首帧必须逐字节一致):
 * - 日期范围首帧不渲染具体日期:store 默认 dateRange 依赖当前时间(SSR 进程在启动时刻算一次并
 *   长期复用,浏览器在页面加载时刻另算),跨天 / 跨时区下两端值必然错开,属 React 19 明示的
 *   「Date.now() 类可变输入」错配源。故 RangePicker 的 value 在挂载前传 undefined(两端首帧
 *   输入框都为空),挂载后经 effect 置 mounted 触发重渲染再回填浏览器当前范围。
 * - 控件组的可访问名用静态 aria-label,不用 useId 派生的 aria-labelledby:id 由组件在树中的
 *   位置推导,SSR 与客户端树结构只要有差异(dev 下 Modern.js 客户端路由包裹层级与 SSR 不同,
 *   实测必现)id 就错位,直接构成属性级 hydration 错配。
 */
export default function MarketFilterBar() {
  const period = useMarketFilterStore((state) => state.period);
  const source = useMarketFilterStore((state) => state.source);
  const dateRange = useMarketFilterStore((state) => state.dateRange);
  const setPeriod = useMarketFilterStore((state) => state.setPeriod);
  const setSource = useMarketFilterStore((state) => state.setSource);
  const setDateRange = useMarketFilterStore((state) => state.setDateRange);

  // 挂载标记:SSR 为 false;客户端首次 effect 后为 true(仅用于回填首帧未渲染的时间依赖值)。
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // 分时 / 五日无日期范围概念:只禁用控件并给提示,不反向清空 store 值——
  // 周期为分时两档时若 dateRange 被改写,组件层不拦截,由图表侧按周期自行忽略(见 use-chart-data)。
  const dateRangeDisabled = PERIODS_WITHOUT_DATE_RANGE.includes(period);

  const handlePeriodChange = useCallback(
    (value: ChartPeriod): void => setPeriod(value),
    [setPeriod]
  );

  const handleSourceChange = useCallback(
    (value: MarketSource): void => setSource(value),
    [setSource]
  );

  const handleDateRangeChange = useCallback(
    (value: string[]): void => {
      // allowClear=false 下 UI 不会清空;空数组仍兜底回默认范围,保证 store 恒为两段非空字符串。
      setDateRange(value.length === 2 ? [value[0], value[1]] : getDefaultDateRange());
    },
    [setDateRange]
  );

  // 快捷项与当前范围受控比对:命中才高亮,自定义范围下整排都不高亮。
  const matchedQuickKey = matchQuickRange(dateRange);

  // 日期面板开合改为受控:面板内点快捷档位即完成筛选,直接收起,不必再点日期单元格。
  const [panelVisible, setPanelVisible] = useState(false);

  const handlePanelVisibleChange = useCallback((visible?: boolean): void => {
    setPanelVisible(Boolean(visible));
  }, []);

  const handleQuickRangeSelect = useCallback(
    (value: QuickRangeKey): void => {
      setDateRange(computeQuickRange(value));
      setPanelVisible(false);
    },
    [setDateRange]
  );

  return (
    <section className="market-filter-bar" aria-label="行情筛选">
      <div className="market-filter-field" role="group" aria-label="周期">
        <span className="market-filter-label">周期</span>
        <Radio.Group
          className="market-filter-periods"
          type="button"
          size="small"
          options={PERIOD_OPTIONS}
          value={period}
          onChange={handlePeriodChange}
        />
      </div>

      <div className="market-filter-field" role="group" aria-label="日期范围">
        <span className="market-filter-label">日期范围</span>
        {/* Tooltip 的触发节点用包裹层承担:Arco Trigger 解析不到 RangePicker 自身 DOM
            (React 19 下 ref 走 props),且禁用控件吞指针事件,故禁用态让包裹层收事件。
            快捷档位不再占行内位置,已移入日期面板 extra(见 MarketQuickRange)。 */}
        <Tooltip content={DATE_RANGE_DISABLED_HINT} disabled={!dateRangeDisabled}>
          <span
            className={
              dateRangeDisabled
                ? "market-filter-dates-wrap market-filter-dates-wrap-disabled"
                : "market-filter-dates-wrap"
            }
          >
            <DatePicker.RangePicker
              className="market-filter-dates"
              format="YYYY-MM-DD"
              size="small"
              // 首帧(mounted 前)两端都渲染空输入框,消除 SSR 进程启动日与浏览器当天的
              // 时间依赖错配;挂载后回填 store 当前范围(交互语义不变,见顶部 hydration 纪律)。
              value={isMounted ? dateRange : undefined}
              disabled={dateRangeDisabled}
              allowClear={false}
              disabledDate={isFutureDate}
              onChange={handleDateRangeChange}
              popupVisible={panelVisible}
              onVisibleChange={handlePanelVisibleChange}
              // extra 由 Arco 渲染在日期面板页脚(.arco-picker-footer-extra-wrapper):面板打开才挂载,SSR 不渲染。
              extra={
                <MarketQuickRange
                  disabled={dateRangeDisabled}
                  matchedKey={matchedQuickKey}
                  onSelect={handleQuickRangeSelect}
                />
              }
            />
          </span>
        </Tooltip>
      </div>

      <div className="market-filter-field" role="group" aria-label="数据源">
        <span className="market-filter-label">数据源</span>
        <Select
          className="market-filter-source"
          size="small"
          options={SOURCE_OPTIONS}
          value={source}
          onChange={handleSourceChange}
        />
      </div>
    </section>
  );
}
