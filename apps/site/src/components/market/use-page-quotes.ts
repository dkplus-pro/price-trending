// 页面级快照编排(黄金价格 / 国内指数两页共用):标的配置派生 + 批量快照 + 15s 轮询。
//
// 设计要点:
// - instruments 由 ids 派生并 useMemo 稳定引用:ahooks useRequest 的 refreshDeps 按引用判定,
//   每次渲染新建数组会把轮询反复重置(取数节奏被打乱);
// - getQuotes 是批量接口(facade 一次请求覆盖全部 secid,内部自带东财 → 腾讯 → gold-api 兜底):
//   整体失败时由 error 暴露给页面级提示条,单标的缺失由 facade 返回 price=null 的占位,
//   UI 按 price 渲染 "--",不进错误态;
// - 数据源跟随全局筛选栏 store(页面把 source 传进来):"auto" 传 undefined 走兜底链,
//   指定源透传 { source }(单源不兜底);source 变化经 refreshDeps 立即重取;
// - loading 只在「首轮尚未拿到数据」时为 true:轮询与手动刷新的 loading 不置骨架,
//   否则每个轮询周期快照区都会闪一次骨架;
// - 轮询 15s,页面隐藏时暂停(pollingWhenHidden:false);getQuotes 整体 reject 时轮询不停,
//   错误条的重试按钮复用手动刷新(refresh)。
import { useRequest } from "ahooks";
import { useCallback, useMemo } from "react";

import { getInstrument } from "../../api/market/config";
import { getQuotes } from "../../api/market/index";
import type { InstrumentConfig, MarketQueryOptions, Quote } from "../../api/market/types";
import type { MarketSource } from "../../store/market-filter";

/** 快照轮询间隔(ms)。 */
export const QUOTE_POLL_INTERVAL_MS = 15_000;

export interface PageQuotesResult {
  /** 由 ids 派生的标的配置(顺序即展示顺序;配置缺失的 id 被跳过)。 */
  instruments: InstrumentConfig[];
  /** 最新一轮批量快照(首轮未回来为 undefined);顺序与 instruments 对齐。 */
  quotes: Quote[] | undefined;
  /** 按 instrumentId 索引的快照(页面按标的分发,缺项为 undefined)。 */
  quoteMap: Map<string, Quote>;
  /** 首轮取数中(轮询/手动刷新期间为 false,避免快照区反复闪骨架)。 */
  loading: boolean;
  /** 页面级错误文案(getQuotes 整体失败;null = 无错误)。 */
  error: string | null;
  /** 手动刷新(错误条重试与单标的重试共用)。 */
  refresh: () => void;
}

/** 取数失败文案(facade 抛出的 MarketError 也是 Error,message 已是人话)。 */
function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 数据源选择 → facade options:auto 走兜底链(undefined),指定源只请求该源。 */
function toQueryOptions(source: MarketSource): MarketQueryOptions | undefined {
  return source === "auto" ? undefined : { source };
}

/**
 * 页面级批量快照:入参为标的 id 列表(页面常量)与数据源选择(来自全局筛选栏 store),
 * 出参供平铺渲染 InstrumentSection。
 * 轮询与手动刷新并发时由 useRequest 的请求序号保证旧响应不覆盖新数据。
 */
export function usePageQuotes(ids: readonly string[], source: MarketSource): PageQuotesResult {
  // 依赖用「内容键」而非 ids 引用:调用方传常量数组(页面传 GOLD_IDS / INDEX_IDS)时引用本就稳定,
  // 传字面量数组时若按引用记忆化,每次渲染都会产出新的 instruments → refreshDeps 抖动 →
  // 「取数 → setState → 重渲染 → 再取数」死循环(实测)。按内容键记忆化后两者都只派生一次。
  const idsKey = ids.join(",");
  const instruments = useMemo(
    () =>
      ids
        .map((id) => getInstrument(id))
        .filter((instrument): instrument is InstrumentConfig => instrument !== undefined),
    [idsKey]
  );

  const { data, loading, error, refresh } = useRequest(
    () => getQuotes(instruments, toQueryOptions(source)),
    {
      refreshDeps: [instruments, source],
      pollingInterval: QUOTE_POLL_INTERVAL_MS,
      pollingWhenHidden: false
    }
  );

  const quoteMap = useMemo(() => {
    const map = new Map<string, Quote>();
    for (const quote of data ?? []) {
      map.set(quote.instrumentId, quote);
    }
    return map;
  }, [data]);

  const handleRefresh = useCallback((): void => {
    refresh();
  }, [refresh]);

  return {
    instruments,
    quotes: data,
    quoteMap,
    loading: loading && data === undefined,
    error: error === undefined ? null : readErrorMessage(error),
    refresh: handleRefresh
  };
}
