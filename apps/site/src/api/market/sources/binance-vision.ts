// PAXG 兜底源(binance.vision 浏览器直连;xau/gc 的 K 线兜底)。
//
// 背景(2026-10 调研实测结论固化,勿凭印象改动):黄金三标的的 K 线此前只有东财上游,
// 东财全域不可达(本机 WAF 限流 HTTP 000)且 server 转发源离线(静态托管)时无兜底可落。
// PAXG(Paxos Gold)是 1:1 锚定实物金的代币化黄金,Binance 现货交易对 PAXGUSDT 跟踪国际金价:
// 与现货偏差约 0.15%、与 COMEX 期金约 0.6%,data-api.binance.vision 是 Binance 官方公开行情
// 镜像域,浏览器直连可用(CORS `*`、无需 API Key),1d/1w/1M 原生 K 线,日线深度到 2024 年。
// 故作为伦敦金(xau)/ COMEX 期金(gc)的 K 线兜底源;国内上金所合约(au9999)有精确同标的
// 的 SGE 源(sources/sge.ts),不走本源(近似标注见 use-chart-data.ts 的 chartNote 映射)。
//
// 实现约束:
// - 端点:GET /api/v3/klines?symbol=PAXGUSDT&interval={1d|1w|1M}&limit=1000;范围查询
//   (range.beg 存在)追加 startTime={beg 当日 UTC 零点毫秒}——上游按 openTime ≥ startTime
//   升序返回;end 不传上游参数(上游无 end 语义可白嫖,解析后按 end 过滤 ≤end 的行即可);
// - limit 固定 1000(上游单页上限 1000):非范围查询返回「最近 1000 根」,再按 KlineRange.limit
//   保留最近 limit 根切片(与东财 parseKlinePayload 同口径);范围查询按区间返回、不切片;
// - host 参数忽略:本源单域名(data-api.binance.vision),无域名轮换语义;但签名与东财源
//   fetchKlines(inst, period, range, host?) 对齐——facade 的调度器 task 统一注入 host,
//   保持「直连源同形」让兜底链插拔时无需特判(task 回调签名一致),host 收下不用即可;
// - 请求走 throttle.fetchJson(10s 超时):网络层失败(超时 / 非 2xx / 坏 JSON)原样透传,
//   由 facade 兜底链决定下一步;解析防御:响应结构变形(非数组 / 行非数组 / 段数不足 /
//   OHLC 非数值)的行跳过、整体变形返回空 page(不抛异常,与东财/腾讯源风格一致,
//   让 facade 按「无数据」继续兜底);
// - 时间口径:Binance 周期按 UTC 对齐,bar.time 取 openTime 的 UTC 日历日
//   (Date 的 getUTC* 方法,勿用本地时区,否则 UTC 0 点附近的 openTime 会偏一天);
// - 振幅:源无振幅字段,按「(高 - 低) / 前一根收盘 × 100」推导保留两位(与腾讯源同口径),
//   首根无前收 → null;前收 0 / 非有限数 → null,不产生 Infinity。
import { DEFAULT_KLINE_LIMIT } from "../config";
import { fetchJson } from "../throttle";
import { MarketError } from "../types";
import type { InstrumentConfig, KlineBar, KlinePage, KlinePeriod, KlineRange } from "../types";

/** 默认主域(单域名,Binance 官方公开行情镜像,浏览器直连可用)。 */
const DEFAULT_HOST = "https://data-api.binance.vision";

/** PAXG 代币化黄金对 USDT 的现货交易对(xau/gc 共用同一近似上游)。 */
const PAXG_SYMBOL = "PAXGUSDT";

/** K 线周期 → Binance interval(day/week 原生,month 为大写 M)。 */
const INTERVAL_BY_PERIOD: Record<KlinePeriod, string> = { day: "1d", week: "1w", month: "1M" };

/** 上游单页条数上限(PAXG 日线深度到 2024 年,1000 根足够覆盖页面可选区间)。 */
const UPSTREAM_LIMIT = 1000;

/** 单根 K 线最少段数:0 openTime、1 open、2 high、3 low、4 close、5 volume、7 quoteVolume。 */
const KLINE_MIN_SEGMENTS = 8;

/** 支持本源的标的:PAXG 跟踪国际金价,适配伦敦金现货与 COMEX 期金;上金所合约走 SGE 源。 */
const PAXG_SUPPORTED_INSTRUMENT_IDS: ReadonlySet<string> = new Set(["xau", "gc"]);

/** 该标的能否走 PAXG 兜底(facade 据此决定是否进兜底链;源内亦作防御校验)。 */
export function supportsPaxg(inst: InstrumentConfig): boolean {
  return PAXG_SUPPORTED_INSTRUMENT_IDS.has(inst.id);
}

/** 单值转数值:数字原样,字符串可解析才返回,其余(空串 / NaN / Infinity)一律 null。 */
function toNumber(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** openTime(UTC 毫秒)→ "YYYY-MM-DD":用 getUTC* 读回(Binance 周期按 UTC 对齐,勿用本地时区)。 */
function openTimeToDashDate(ms: number): string {
  const date = new Date(ms);
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** range.end(YYYYMMDD)→ "YYYY-MM-DD";非法(格式不符)返回 null(不过滤,与腾讯源同语义)。 */
function yyyymmddToDashDate(yyyymmdd: string): string | null {
  if (!/^\d{8}$/.test(yyyymmdd)) {
    return null;
  }
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** range.beg(YYYYMMDD)→ 当日 UTC 零点毫秒;非法返回 null(不拼 startTime,取最近页)。 */
function yyyymmddToUtcMs(yyyymmdd: string): number | null {
  if (!/^\d{8}$/.test(yyyymmdd)) {
    return null;
  }
  return Date.UTC(
    Number(yyyymmdd.slice(0, 4)),
    Number(yyyymmdd.slice(4, 6)) - 1,
    Number(yyyymmdd.slice(6, 8))
  );
}

/** 是否启用范围查询:beg 非空即启用(空串 / 缺省视为未启用,与东财/腾讯源同判定)。 */
function hasRangeStart(range: KlineRange): boolean {
  return range.beg !== undefined && range.beg.length > 0;
}

/** 单根行 [openTime, open, high, low, close, volume, closeTime, quoteVolume, ...] → KlineBar 草稿。 */
type KlineBarDraft = Omit<KlineBar, "amplitudePct">;

function parseRow(row: unknown): KlineBarDraft | null {
  if (!Array.isArray(row) || row.length < KLINE_MIN_SEGMENTS) {
    return null;
  }
  const openTime = toNumber(row[0]);
  const open = toNumber(row[1]);
  const high = toNumber(row[2]);
  const low = toNumber(row[3]);
  const close = toNumber(row[4]);
  // time / 开收高低为必需(缺一即整根不可用);量 / 额缺失或非法 → null。
  if (openTime === null || open === null || close === null || high === null || low === null) {
    return null;
  }
  return {
    time: openTimeToDashDate(openTime),
    open,
    close,
    high,
    low,
    volume: toNumber(row[5]),
    amount: toNumber(row[7])
  };
}

/** 振幅补齐:(高 - 低) / 前一根收盘 × 100,保留两位;首根 / 前收 0 或非有限数 → null。 */
function withAmplitude(bars: KlineBarDraft[]): KlineBar[] {
  return bars.map((bar, index) => {
    const prevClose = index === 0 ? null : bars[index - 1].close;
    const amplitudePct =
      prevClose !== null && Number.isFinite(prevClose) && prevClose !== 0
        ? Math.round(((bar.high - bar.low) / prevClose) * 10000) / 100
        : null;
    return { ...bar, amplitudePct };
  });
}

/**
 * K 线响应解析(行数组的数组 → KlinePage):升序原样保留(上游按 openTime 升序);
 * 结构变形(非数组)→ 空 page。导出便于单测直接喂响应体。
 */
export function parseKlinePayload(payload: unknown, limit: number, ranged: boolean): KlinePage {
  if (!Array.isArray(payload)) {
    return { bars: [], hasMore: false, source: "paxg" };
  }
  const bars = withAmplitude(
    payload.map(parseRow).filter((bar): bar is KlineBarDraft => bar !== null)
  );
  if (ranged) {
    return { bars, hasMore: false, source: "paxg" };
  }
  const sliced = bars.length > limit ? bars.slice(bars.length - limit) : bars;
  return { bars: sliced, hasMore: false, source: "paxg" };
}

/**
 * 日/周/月 K 线(PAXGUSDT,binance.vision 公开行情镜像)。
 * @param range beg 存在时按 [beg, end] 范围取数(startTime={beg 的 UTC 毫秒} + 解析后过滤
 *              ≤end,不按 limit 截断、hasMore 恒 false);否则取「最近 limit 根」
 * @param host 忽略(单域名无轮换语义;保留参数与东财源签名对齐,见文件头)
 * @throws inst 不在本源支持范围时抛 MarketError(facade 只对 xau/gc 调用,防御性保留)
 */
export async function fetchKlines(
  inst: InstrumentConfig,
  period: KlinePeriod,
  range: KlineRange,
  host?: string
): Promise<KlinePage> {
  // host 收下即弃(单域名源,无轮换语义;占位以满足调度器 task 的统一签名)。
  void host;
  if (!supportsPaxg(inst)) {
    throw new MarketError("binance-vision", `${inst.name} 无 PAXG 兜底源(仅伦敦金/COMEX 期金)`);
  }
  const limit = range.limit ?? DEFAULT_KLINE_LIMIT;
  const ranged = hasRangeStart(range);
  const startTime = ranged ? yyyymmddToUtcMs(range.beg ?? "") : null;
  const params = new URLSearchParams({
    symbol: PAXG_SYMBOL,
    interval: INTERVAL_BY_PERIOD[period],
    limit: String(UPSTREAM_LIMIT)
  });
  if (startTime !== null) {
    params.set("startTime", String(startTime));
  }
  // host 忽略:单域名源,调度器注入的轮换域名不参与(参数仅为与东财源签名对齐)。
  const payload = await fetchJson<unknown>(`${DEFAULT_HOST}/api/v3/klines?${params.toString()}`);
  const page = parseKlinePayload(payload, limit, ranged);
  // end 过滤(仅范围查询语义需要;非范围查询取「最近」本就以今日为界):上游不收 end,
  // 解析后按 openTime 落在 end 当日及以前过滤(end 非法视为未启用,不拼坏条件)。
  const end = ranged ? yyyymmddToDashDate(range.end ?? "") : null;
  if (end !== null) {
    page.bars = page.bars.filter((bar) => bar.time <= end);
  }
  return page;
}
