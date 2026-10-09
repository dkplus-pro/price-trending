// 图表数据编排(InstrumentSection 内部使用,本卡内聚实现)。
//
// 取数一律走 api/market 的 facade(getTrends / getKlines),兜底链与缺失态在 facade 内收口;
// 本文件只负责「周期 → 能力」的映射、会话缓存、日期范围与数据源透传、竞态。
//
// 编排规则(周期 / 数据源 / 日期范围均由全局筛选栏 store 提供,见 src/store/market-filter.ts):
// 1. minute / fiveday → getTrends(ndays = 1 | 5):激活期间 60s 轮询(ahooks useRequest 的
//    pollingInterval + pollingWhenHidden:false),页面隐藏时暂停;日期范围不消费;
// 2. day / week / month → getKlines({ beg, end, limit: 5000 }):范围查询(facade 按 [beg, end]
//    区间取数、不截断、hasMore 恒 false,故本文件不做分页),日期范围 "YYYY-MM-DD" 去连字符成
//    "YYYYMMDD";会话内 Map 缓存 key `${id}:${period}:${beg}:${end}:${source}`,
//    切回看过的组合命中缓存时立即渲染旧数据再后台静默刷新(不闪骨架屏);
// 3. 数据源:source === "auto" 时 options 传 undefined(走 facade 兜底链),其余透传 { source }(单源不兜底);
// 4. 竞态守卫:每次取数自增请求序号,序号过期(期间又切了周期 / 范围 / 数据源)的响应一律丢弃;
// 5. 错误:取数失败只落在「图表区」错误态(MarketError 的 message 已是人话),
//    不污染上方的 QuoteHeader;已有可展示数据时的刷新失败静默保留旧数据。
import { useRequest } from "ahooks";
import { useCallback, useRef, useState } from "react";

import { getKlines, getTrends } from "../../api/market/index";
import type {
  ChartPeriod,
  InstrumentConfig,
  KlineBar,
  MarketQueryOptions,
  TrendPoint
} from "../../api/market/types";
import type { MarketSource } from "../../store/market-filter";

/** 分时轮询间隔(ms)。 */
const TREND_POLL_INTERVAL_MS = 60_000;

/** 范围查询单次条数上限:条数由日期范围决定,这里只做防御性上限(见 api/market/config 的默认 200)。 */
const RANGE_KLINE_LIMIT = 5_000;

/** 会话内 K 线缓存(key `${instrumentId}:${period}:${beg}:${end}:${source}`):切回看过的组合立即渲染,再后台刷新。 */
const klineCache = new Map<string, KlineBar[]>();

/** 一次取数的完整载荷;key 用于判定载荷是否属于「当前周期 / 范围 / 数据源」。 */
interface ChartPayload {
  key: string;
  mode: "kline" | "trend";
  bars?: KlineBar[];
  trendPoints?: TrendPoint[];
  prevClose?: number | null;
}

/** useChartData 出参:图表所需数据 + 加载 / 错误态(error/retry 供图表区错误态使用)。 */
export interface ChartDataResult {
  mode: "kline" | "trend";
  bars?: KlineBar[];
  trendPoints?: TrendPoint[];
  prevClose?: number | null;
  loading: boolean;
  /** 周期级错误文案(null = 无错误);有数据时的刷新失败不置错。 */
  error: string | null;
  retry: () => void;
}

/**
 * 请求与载荷的 key:分时两档不消费日期范围,key 也不含范围(切范围不触发分时重取);
 * K 线三档的 key 含范围与数据源,四者任一变化都算另一次取数。
 */
function chartKey(
  instrumentId: string,
  period: ChartPeriod,
  dateRange: [string, string],
  source: MarketSource
): string {
  if (isTrendPeriod(period)) {
    return `${instrumentId}:${period}:${source}`;
  }
  return `${instrumentId}:${period}:${dateRange[0]}:${dateRange[1]}:${source}`;
}

/** 分时两档(走 trends)与 K 线三档(走 klines)的判定;类型谓词让调用处自动收窄。 */
function isTrendPeriod(period: ChartPeriod): period is Extract<ChartPeriod, "minute" | "fiveday"> {
  return period === "minute" || period === "fiveday";
}

/** 页面日期 "YYYY-MM-DD" → facade 入参 "YYYYMMDD"(去连字符)。 */
function toYyyymmdd(day: string): string {
  return day.replace(/-/g, "");
}

/** 数据源选择 → facade options:auto 走兜底链(undefined),指定源只请求该源。 */
function toQueryOptions(source: MarketSource): MarketQueryOptions | undefined {
  return source === "auto" ? undefined : { source };
}

/**
 * 单次取数(facade 调用点)。
 * 出参语义与 facade 一致:getKlines → KlinePage{ bars, hasMore } / getTrends → TrendSet{ points, prevClose }。
 */
async function requestChartData(
  instrument: InstrumentConfig,
  period: ChartPeriod,
  dateRange: [string, string],
  source: MarketSource
): Promise<ChartPayload> {
  const key = chartKey(instrument.id, period, dateRange, source);
  const options = toQueryOptions(source);
  if (isTrendPeriod(period)) {
    const ndays = period === "minute" ? 1 : 5;
    const trends = await getTrends(instrument, ndays, options);
    return { key, mode: "trend", trendPoints: trends.points, prevClose: trends.prevClose };
  }
  const [beg, end] = dateRange;
  const page = await getKlines(
    instrument,
    period,
    { beg: toYyyymmdd(beg), end: toYyyymmdd(end), limit: RANGE_KLINE_LIMIT },
    options
  );
  return { key, mode: "kline", bars: page.bars };
}

/** 取数失败 → 图表区文案(facade 抛出的 MarketError 也是 Error,message 已是人话)。 */
function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 行情图表的取数编排:返回图表所需的 mode / 数据 / loading / 错误态。
 * 调度交给 useRequest(挂载即取、周期 / 范围 / 数据源变化重取、分时 60s 轮询),
 * 竞态与缓存都在内部处理。
 */
export function useChartData(
  instrument: InstrumentConfig,
  period: ChartPeriod,
  dateRange: [string, string],
  source: MarketSource
): ChartDataResult {
  const [payload, setPayload] = useState<ChartPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 请求序号:只增不减;过期序号的响应直接丢弃(竞态守卫)。
  const requestSeqRef = useRef(0);
  // 载荷副本:回调里读取「当前已渲染数据」而不额外引入依赖。
  const payloadRef = useRef<ChartPayload | null>(null);
  // 范围与数据源按值参与依赖(元组引用变化不触发重取)。
  const [rangeBeg, rangeEnd] = dateRange;
  const key = chartKey(instrument.id, period, dateRange, source);

  const applyPayload = useCallback((next: ChartPayload | null): void => {
    payloadRef.current = next;
    setPayload(next);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    const targetKey = chartKey(instrument.id, period, [rangeBeg, rangeEnd], source);
    const cached = klineCache.get(targetKey);
    // 当前渲染的载荷是否属于本次请求(否则视为换周期 / 范围 / 数据源)。
    const switching = payloadRef.current?.key !== targetKey;
    if (switching) {
      // 换目标先清掉上一目标的错误态,避免它停在新目标上(无数据时回到骨架态)。
      setError(null);
    }
    // 已有可展示数据(缓存或当前目标载荷)时的请求视为「刷新」:失败不顶掉图表。
    const hasUsableData = cached !== undefined || !switching;
    if (cached !== undefined) {
      applyPayload({ key: targetKey, mode: "kline", bars: cached });
    }
    try {
      const next = await requestChartData(instrument, period, [rangeBeg, rangeEnd], source);
      if (seq !== requestSeqRef.current) {
        return;
      }
      if (next.mode === "kline") {
        klineCache.set(targetKey, next.bars ?? []);
      }
      applyPayload(next);
      setError(null);
    } catch (caught) {
      if (seq !== requestSeqRef.current) {
        return;
      }
      if (!hasUsableData) {
        setError(readErrorMessage(caught));
      }
    }
  }, [applyPayload, instrument, period, rangeBeg, rangeEnd, source]);

  // 取数调度:挂载即取数、周期 / 范围 / 数据源变化重取,分时两档额外 60s 轮询(页面隐藏时暂停)。
  // 依赖用单个 key 字符串:分时的 key 不含范围,故切范围不会重置分时轮询。
  useRequest(load, {
    refreshDeps: [key],
    pollingInterval: isTrendPeriod(period) ? TREND_POLL_INTERVAL_MS : 0,
    pollingWhenHidden: false
  });

  const retry = useCallback((): void => {
    // 清错以便图表区切回骨架态;失败会由 load 重新置错。
    setError(null);
    void load();
  }, [load]);

  const active = payload !== null && payload.key === key ? payload : null;

  return {
    mode: isTrendPeriod(period) ? "trend" : "kline",
    bars: active?.bars,
    trendPoints: active?.trendPoints,
    // 昨收基准线只在分时(尤其 minute)使用,其余周期不传。
    prevClose: period === "minute" ? (active?.prevClose ?? null) : undefined,
    loading: active === null && error === null,
    error,
    retry
  };
}
