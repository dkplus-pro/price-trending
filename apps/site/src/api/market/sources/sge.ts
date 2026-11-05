// 上金所(SGE)官网日线兜底源(au9999 专用;server 契约端点转发)。
//
// 背景(2026-10 调研实测结论固化):上金所官网 POST graph/Dailyhq 接口是黄金现货 Au99.99
// 的权威精确源(精确同标的),server 端已封装为契约端点 GET /api/site/market/sge-daily
// (R2a 交付,MarketController.getMarketSgeDaily):仅日 K、无成交量/成交额口径,上游无日期
// 过滤参数、返回上市以来全量(升序约 2377 条),由本源在客户端按 range 过滤截断;周/月 K 由
// aggregateDailyBars(api/market/utils.ts)在客户端聚合派生。上游对错误 instid 也返回 200
// 但数据行数值全 0,server 端已判定全 0 转译 502,本源再作同口径防御(双保险,见下)。
// 仅 auto 兜底链使用(au9999 的东财两步都失败后落此源);其他标的不应调用本源。
//
// 实现约束:
// - 取数走 orval 生成物 MarketController(与 server 转发源同范式):client.ts 已解
//   {code,message,data} 信封、自带 10s 超时与幂等 GET 重试;controller 失败原样透传
//   (facade 继续兜底 / 收口错误);
// - 不含 host 参数:本源请求同源 /api(经 client.ts),没有域名轮换语义;facade 直接调用、
//   不经东财域名调度器(与 sources/server.ts 同判定);
// - 解析防御:payload.time 缺失 / 非数组 → 空 page(整体变形按「无数据」处理,与东财/腾讯
//   源风格一致);单行不足 5 列 / OHLC 非数值的行跳过;
// - 上游行体例 [日期, 开, 收, 低, 高](注意:低在高之前,与东财「高在前低在后」相反,
//   映射时不得对调);volume/amount 无上游口径,按 0 填充(UI 量柱画 0,统计行显示 0);
// - 振幅:上游无振幅字段,按「(高 - 低) / 前一行收盘 × 100」对全量升序序列现算保留两位
//   (先算后过滤:截断后首根仍带真实振幅);首行无前收 → null,前收 0/非法 → null。
import { MarketController } from "../../controllers.gen";
import { DEFAULT_KLINE_LIMIT } from "../config";
import { aggregateDailyBars } from "../utils";
import { MarketError } from "../types";
import type { InstrumentConfig, KlineBar, KlinePage, KlinePeriod, KlineRange } from "../types";

/**
 * instrumentId → 上金所合约代码:SGE 只认 Au 合约,当前仅有 au9999(黄金9999 = Au99.99);
 * 新增上金所标的(如 Au99.95)时在 config.ts 加标的并在本表补映射。
 */
const SGE_INSTID_BY_INSTRUMENT_ID: Record<string, string> = {
  au9999: "Au99.99"
};

/** 该标的的 SGE 合约代码;无映射返回 undefined(facade 据此决定是否进兜底链)。 */
export function sgeInstIdFor(inst: InstrumentConfig): string | undefined {
  return SGE_INSTID_BY_INSTRUMENT_ID[inst.id];
}

/** 上游行 [日期, 开, 收, 低, 高] → KlineBar 草稿;列数不足 / OHLC 非数值的行跳过。 */
type SgeBarDraft = Omit<KlineBar, "amplitudePct">;

function parseRow(row: unknown): SgeBarDraft | null {
  if (!Array.isArray(row) || row.length < 5 || typeof row[0] !== "string" || row[0] === "") {
    return null;
  }
  const toNumber = (raw: unknown): number | null => {
    if (typeof raw === "number") {
      return Number.isFinite(raw) ? raw : null;
    }
    if (typeof raw !== "string" || raw.trim() === "") {
      return null;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const open = toNumber(row[1]);
  const close = toNumber(row[2]);
  const low = toNumber(row[3]);
  const high = toNumber(row[4]);
  if (open === null || close === null || low === null || high === null) {
    return null;
  }
  return { time: row[0], open, close, high, low, volume: 0, amount: 0 };
}

/** 振幅补齐:(高 - 低) / 前一行收盘 × 100,保留两位;首行 / 前收 0 或非有限数 → null。 */
function withAmplitude(bars: SgeBarDraft[]): KlineBar[] {
  return bars.map((bar, index) => {
    const prevClose = index === 0 ? null : bars[index - 1].close;
    const amplitudePct =
      prevClose !== null && Number.isFinite(prevClose) && prevClose !== 0
        ? Math.round(((bar.high - bar.low) / prevClose) * 10000) / 100
        : null;
    return { ...bar, amplitudePct };
  });
}

/** range 边界(YYYYMMDD)→ "YYYY-MM-DD";非法返回 null(该侧不过滤,与腾讯源同语义)。 */
function yyyymmddToDashDate(yyyymmdd: string | undefined): string | null {
  if (yyyymmdd === undefined || !/^\d{8}$/.test(yyyymmdd)) {
    return null;
  }
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/**
 * 日/周/月 K 线(au9999;day 直取,week/month 由日 K 客户端聚合)。
 * 上游全量升序返回:按 [beg, end] 过滤后取末 limit 根(「最近 limit 根」语义与其他源对齐;
 * 页面实际总是带 beg 的范围查询,limit 5000 > 全量 2377 条,不会被截断)。
 * hasMore 恒 false:本源一次给全量、无分页语义(非范围模式下 facade 会按
 * 「条数 === limit」统一重算,与东财/腾讯切片后的口径一致)。
 * @throws inst 无 SGE 映射(不该发生,facade 已判定)或上游数据全 0(无效数据)
 */
export async function fetchKlines(
  inst: InstrumentConfig,
  period: KlinePeriod,
  range: KlineRange
): Promise<KlinePage> {
  const instid = sgeInstIdFor(inst);
  if (instid === undefined) {
    throw new MarketError("sge", `${inst.name} 无上金所合约映射(仅黄金现货 Au 合约)`);
  }
  const payload = await MarketController.getMarketSgeDaily({ instid });
  const rows = (payload as { time?: unknown } | null | undefined)?.time;
  if (!Array.isArray(rows)) {
    // 结构变形(data 无 time 数组)按「无数据」处理,让 facade 继续兜底。
    return { bars: [], hasMore: false, source: "sge" };
  }
  const bars = withAmplitude(rows.map(parseRow).filter((bar): bar is SgeBarDraft => bar !== null));
  // 双保险:server 已把「全 0 数据行」转译 502,这里再拦一次(上游契约之外的新变形不穿透成图表)。
  if (
    bars.length > 0 &&
    bars.every((bar) => bar.open === 0 && bar.close === 0 && bar.high === 0 && bar.low === 0)
  ) {
    throw new MarketError("sge", "上金所返回无效数据");
  }
  const aggregated = period === "day" ? bars : aggregateDailyBars(bars, period);
  // 过滤 [beg, end](边界非法视为未启用)+ 取末 limit 根。
  const beg = yyyymmddToDashDate(range.beg);
  const end = yyyymmddToDashDate(range.end);
  let filtered = aggregated;
  if (beg !== null) {
    filtered = filtered.filter((bar) => bar.time >= beg);
  }
  if (end !== null) {
    filtered = filtered.filter((bar) => bar.time <= end);
  }
  const limit = range.limit ?? DEFAULT_KLINE_LIMIT;
  const sliced = filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered;
  return { bars: sliced, hasMore: false, source: "sge" };
}
