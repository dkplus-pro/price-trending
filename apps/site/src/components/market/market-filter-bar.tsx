import "@arco-design/web-react/es/_util/react-19-adapter";
import { DatePicker, Radio, Select, Tooltip } from "@arco-design/web-react";
import { useCallback, useId } from "react";

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

/**
 * 行情页全局筛选栏(黄金价格 / 国内指数两页共用):周期 + 日期范围(含快捷跨度)+ 数据源,吸顶固定。
 * 状态自读写 useMarketFilterStore(无 props),两页跨页保持筛选态。
 * 注意:全部为客户端交互态,SSR 首帧按 store 创建时的默认值渲染(不做当天日期重算)。
 */
export default function MarketFilterBar() {
  const period = useMarketFilterStore((state) => state.period);
  const source = useMarketFilterStore((state) => state.source);
  const dateRange = useMarketFilterStore((state) => state.dateRange);
  const setPeriod = useMarketFilterStore((state) => state.setPeriod);
  const setSource = useMarketFilterStore((state) => state.setSource);
  const setDateRange = useMarketFilterStore((state) => state.setDateRange);

  // 三组控件的可见 label 与控件组关联(Arco 的 Group/Select 不透传 aria-label)。
  const labelIdBase = useId();
  const periodLabelId = `${labelIdBase}-period`;
  const dateRangeLabelId = `${labelIdBase}-date-range`;
  const sourceLabelId = `${labelIdBase}-source`;

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

  const handleQuickRangeClick = useCallback(
    (value: QuickRangeKey): void => setDateRange(computeQuickRange(value)),
    [setDateRange]
  );

  return (
    <section className="market-filter-bar" aria-label="行情筛选">
      <div className="market-filter-field" role="group" aria-labelledby={periodLabelId}>
        <span className="market-filter-label" id={periodLabelId}>
          周期
        </span>
        <Radio.Group
          className="market-filter-periods"
          type="button"
          size="small"
          options={PERIOD_OPTIONS}
          value={period}
          onChange={handlePeriodChange}
        />
      </div>

      <div className="market-filter-field" role="group" aria-labelledby={dateRangeLabelId}>
        <span className="market-filter-label" id={dateRangeLabelId}>
          日期范围
        </span>
        {/* Tooltip 的触发节点用包裹层承担:Arco Trigger 解析不到 RangePicker 自身 DOM
            (React 19 下 ref 走 props),且禁用控件吞指针事件,故禁用态让包裹层收事件。
            快捷按钮排同处一个包裹层:共用同一禁用提示,并让两者在窄屏一起折行。 */}
        <Tooltip content="分时/五日不支持日期范围" disabled={!dateRangeDisabled}>
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
              value={dateRange}
              disabled={dateRangeDisabled}
              allowClear={false}
              disabledDate={isFutureDate}
              onChange={handleDateRangeChange}
            />
            <Radio.Group
              className="market-filter-quick"
              type="button"
              size="mini"
              options={QUICK_SELECT_OPTIONS}
              value={matchedQuickKey}
              disabled={dateRangeDisabled}
              onChange={handleQuickRangeClick}
            />
          </span>
        </Tooltip>
      </div>

      <div className="market-filter-field" role="group" aria-labelledby={sourceLabelId}>
        <span className="market-filter-label" id={sourceLabelId}>
          数据源
        </span>
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
