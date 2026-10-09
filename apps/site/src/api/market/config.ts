// 行情标的静态配置(API 实测结论固化,勿凭印象改动):
// secid / tencentCode / decimals / 量额与均价线标志均对齐各源真实响应,改动前先核对源返回。
//
// 扩展约定:新增指数只需在 INSTRUMENTS 追加一项,并把 id 加进 INDEX_IDS(黄金同理加 GOLD_IDS);
// 其余页面逻辑(分组筛选、列表顺序、兜底链)全部按 INSTRUMENTS 派生的 id 常量驱动,无需改动。
import type { InstrumentConfig } from "./types";

/** K 线单页默认条数(源与 facade 共用,避免魔数漂移)。 */
export const DEFAULT_KLINE_LIMIT = 200;

/** 黄金分组 id(顺序即展示顺序)。 */
export const GOLD_IDS: readonly string[] = ["au9999", "xau", "gc"];

/** 指数分组 id(顺序即展示顺序)。 */
export const INDEX_IDS: readonly string[] = ["sh000001", "sz399006", "sh000688"];

/** 六标的配置(id 唯一;顺序即页面展示顺序)。 */
export const INSTRUMENTS: InstrumentConfig[] = [
  {
    id: "au9999",
    name: "黄金9999",
    category: "gold",
    secid: "118.AU9999",
    priceDecimals: 2,
    hasVolume: true,
    hasAmount: true,
    hasAvgLine: false,
    sessionHint: "上金所，夜盘 20:00–02:30"
  },
  {
    id: "xau",
    name: "伦敦金",
    category: "gold",
    secid: "122.XAU",
    tencentCode: "hf_XAU",
    goldApiSymbol: "XAU",
    priceDecimals: 2,
    hasVolume: false,
    hasAmount: false,
    hasAvgLine: false,
    sessionHint: "国际现货，近 24h"
  },
  {
    id: "gc",
    name: "COMEX黄金",
    category: "gold",
    secid: "101.GC00Y",
    tencentCode: "hf_GC",
    priceDecimals: 1,
    hasVolume: true,
    hasAmount: false,
    hasAvgLine: false,
    sessionHint: "COMEX 期金主连"
  },
  {
    id: "sh000001",
    name: "上证指数",
    category: "index",
    secid: "1.000001",
    tencentCode: "sh000001",
    priceDecimals: 2,
    hasVolume: true,
    hasAmount: true,
    volumeUnit: "手",
    hasAvgLine: true,
    sessionHint: "9:30–15:00"
  },
  {
    id: "sz399006",
    name: "创业板指",
    category: "index",
    secid: "0.399006",
    tencentCode: "sz399006",
    priceDecimals: 2,
    hasVolume: true,
    hasAmount: true,
    volumeUnit: "手",
    hasAvgLine: true,
    sessionHint: "9:30–15:00"
  },
  {
    id: "sh000688",
    name: "科创50",
    category: "index",
    secid: "1.000688",
    tencentCode: "sh000688",
    priceDecimals: 2,
    hasVolume: true,
    hasAmount: true,
    volumeUnit: "手",
    hasAvgLine: true,
    sessionHint: "9:30–15:00"
  }
];

/** 按 id 取标的配置;id 不存在返回 undefined(调用方自行处理非法 id)。 */
export function getInstrument(id: string): InstrumentConfig | undefined {
  return INSTRUMENTS.find((instrument) => instrument.id === id);
}
