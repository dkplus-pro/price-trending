// 行情页全局筛选状态(黄金价格 / 国内指数两页共享同一 store,「全局」即指跨页保持筛选态):
// 图表周期 + 数据源 + 日期范围(仅日 K / 周 K / 月 K 消费)。
// 纯客户端交互态,服务端数据不进 store(见 docs/site.md「状态管理」)。
import { create } from "zustand";

import type { ChartPeriod } from "../api/market/types";

/**
 * 数据源选择:auto = facade 兜底链(东财 → 腾讯 → gold-api);
 * eastmoney / tencent = 只走指定源(不兜底)。
 * 注意与 api/market/types.ts 的 MarketSource(单条行情的实际来源,含 gold-api)区分。
 */
export type MarketSource = "auto" | "eastmoney" | "tencent";

/** 默认日期范围跨度(近 365 天)。 */
const DEFAULT_RANGE_DAYS = 365;

/** Date → "YYYY-MM-DD"(本地时区,与页面展示口径一致)。 */
function formatDate(date: Date): string {
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 默认日期范围 [近 365 天, 今天],纯 Date 计算(本地时区):
 * 起止都用本地日期构造,跨月 / 跨年 / 闰年由 Date 自行进位。
 */
export function getDefaultDateRange(): [string, string] {
  const today = new Date();
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - DEFAULT_RANGE_DAYS
  );
  return [formatDate(start), formatDate(today)];
}

/** 快捷日期跨度键:周 / 月 / 年三档,键即跨度语义。 */
export type QuickRangeKey = "1w" | "2w" | "1m" | "3m" | "6m" | "1y";

/** 快捷跨度选项(顺序即筛选栏展示顺序)。 */
export const QUICK_RANGE_OPTIONS: { key: QuickRangeKey; label: string }[] = [
  { key: "1w", label: "一周" },
  { key: "2w", label: "2周" },
  { key: "1m", label: "1个月" },
  { key: "3m", label: "3个月" },
  { key: "6m", label: "半年" },
  { key: "1y", label: "1年" }
];

/** 目标年月的最后一天(处理 2 月 28/29 日):下月第 0 天即本月最后一天,Date 自行进位。 */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** 按自然日偏移(周档:7 / 14 天)。 */
function shiftDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * 按日历月偏移(月档):先算目标年月,再把日收回其最后一天。
 * 直接 setMonth 在目标月无该日时会自动进位(如 3-31 减 1 月 → 3-03),故必须显式收口(→ 2-28)。
 */
function shiftMonths(date: Date, months: number): Date {
  const totalMonths = date.getFullYear() * 12 + date.getMonth() + months;
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths - year * 12;
  const day = Math.min(date.getDate(), lastDayOfMonth(year, month));
  return new Date(year, month, day);
}

/** 按日历年偏移(年档):闰日 2-29 减 1 年落回平年同样溢出,收回当月最后一天(→ 2-28)。 */
function shiftYears(date: Date, years: number): Date {
  const year = date.getFullYear() + years;
  const day = Math.min(date.getDate(), lastDayOfMonth(year, date.getMonth()));
  return new Date(year, date.getMonth(), day);
}

/**
 * 快捷跨度的日期范围 [起点, 今天](均 "YYYY-MM-DD",本地时区,与 getDefaultDateRange 同口径):
 * 周档按自然日减(1w=-7 / 2w=-14 天),月档按日历月减(1m/3m/6m),年档按日历年减(1y=-1 年)。
 * today 可注入(测试用),缺省取当前时间。
 */
export function computeQuickRange(key: QuickRangeKey, today: Date = new Date()): [string, string] {
  let start: Date;
  switch (key) {
    case "1w":
      start = shiftDays(today, -7);
      break;
    case "2w":
      start = shiftDays(today, -14);
      break;
    case "1m":
      start = shiftMonths(today, -1);
      break;
    case "3m":
      start = shiftMonths(today, -3);
      break;
    case "6m":
      start = shiftMonths(today, -6);
      break;
    case "1y":
      start = shiftYears(today, -1);
      break;
  }
  return [formatDate(start), formatDate(today)];
}

export interface MarketFilterState {
  /** 图表周期(默认分时)。 */
  period: ChartPeriod;
  /** 数据源选择(默认自动兜底链)。 */
  source: MarketSource;
  /** 日期范围 [beg, end],均 "YYYY-MM-DD";仅日 K / 周 K / 月 K 消费。 */
  dateRange: [string, string];
  setPeriod: (period: ChartPeriod) => void;
  setSource: (source: MarketSource) => void;
  setDateRange: (range: [string, string]) => void;
}

// SSR 注意:store 创建在模块级,默认 dateRange 在 SSR 与浏览器各自计算——两者跨午夜边界(SSR 渲染与
// 客户端 hydrate 落在不同日期)可能差一天,属可接受的显示差异。
export const useMarketFilterStore = create<MarketFilterState>()((set) => ({
  period: "minute",
  source: "auto",
  dateRange: getDefaultDateRange(),
  setPeriod: (period) => set({ period }),
  setSource: (source) => set({ source }),
  setDateRange: (dateRange) => set({ dateRange })
}));
