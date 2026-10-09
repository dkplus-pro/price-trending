// 东方财富行情源(主源):批量快照 / K 线 / 分时。
//
// 接口参数与字段映射为 2026-10-09 curl 实测固化(勿凭印象改动):
// - 端口分工:快照在实时行情域(push2),K 线 / 分时在历史行情域(push2his),两者不互通;
// - 快照 `ulist.np/get`:`fltt=2` 时数值已按小数位缩放,直接当数字用;无值字段为字符串 "-";
//   `data.diff[]` 按入参 secid 顺序返回,但仍以 f13(市场)+f12(代码) 与 secid 对账为主;
// - K 线 `stock/kline/get`:`data.klines[]` 每根 11 段逗号分隔,取
//   "日期,开,收,高,低,成交量,成交额"(价格与量额同为已缩放数值)与第 8 段振幅%;其余 3 段
//   (涨跌幅%/涨跌额/换手%)本层不取;`lmt` 按东财网页版语义传「最近 N 根」——
//   注意:2026-10-09 本环境该端点被源拒绝(同 host 的 trends2/details 正常,kline path 一律空响应
//   HTTP 000,含 IP 直连与多域名变体),lmt 截断未能二次实测,故解析后再按「保留最近 limit 根」切片兜底;
//   范围查询(range.beg 存在)时以 beg 透传区间、lmt 放宽到 RANGE_KLINE_LMT,不做切片与分页判定;
// - 分时 `stock/trends2/get`:`data.trends[]` 每根 8 段 "YYYY-MM-DD HH:mm,开,收,高,低,量,额,均价",
//   取 time/close(price)/开/高/低/volume/avg;`data.preClose` 为分时基准昨收。
//
// 实现约束:
// - 所有真实请求由调用方(facade 经调度器)注入 host,源内不自建并发 / 重试 / 轮换;
// - host 可能是裸域名(facade 的直连域名池即 "push2.eastmoney.com" 形式)或带 scheme 的完整前缀,
//   一律经 resolveBaseUrl 归一(缺 scheme 补 https://),缺省用源内默认主域;
// - host 还可能是公共 CORS 代理项:以 "proxy:" 前缀 + 带 {url} 占位符的模板标记(facade 域名池
//   垫底项),本层把「默认主域 + path + query」拼成完整东财 URL 后 encodeURIComponent 替换进模板;
// - 请求一律走 throttle.fetchJson(直连 10s / 代理 15s 超时);网络层失败(fetchJson reject:
//   超时 / 非 2xx / 坏 JSON,含代理返回 HTML 错误页)原样透传,由 facade 的兜底链决定下一步;
// - 解析防御:响应整体结构变形视为「无数据」返回空结果(不抛异常,让 facade 继续兜底);
//   可空字段非法一律 null,不抛错。
import { DEFAULT_KLINE_LIMIT } from "../config";
import { fetchJson } from "../throttle";
import type {
  InstrumentConfig,
  KlineBar,
  KlinePage,
  KlinePeriod,
  KlineRange,
  Quote,
  TrendDays,
  TrendPoint,
  TrendSet
} from "../types";

/** 快照默认主域(实时行情域)。 */
const DEFAULT_QUOTE_HOST = "https://push2.eastmoney.com";
/** K 线 / 分时默认主域(历史行情域)。 */
const DEFAULT_KLINE_HOST = "https://push2his.eastmoney.com";

/** 公共 CORS 代理 host 的前缀标记:其后是带 {url} 占位符的模板(域名池见 facade 的 index.ts)。 */
const PROXY_HOST_PREFIX = "proxy:";
/** 代理请求超时:公共代理多一跳转发,给足 15s(直连沿用 fetchJson 缺省的 10s)。 */
const PROXY_TIMEOUT_MS = 15_000;

/** K 线周期 → 东财 klt(101 日 / 102 周 / 103 月)。 */
const KLT_BY_PERIOD: Record<KlinePeriod, number> = { day: 101, week: 102, month: 103 };

/** K 线 end 缺省值:东财约定的「取到最新」哨兵日期。 */
const KLINE_END_TODAY = 20500101;

/** 范围查询(beg 存在)时的 lmt:足够大以覆盖任意区间,避免区间被源的「最近 N 根」上限截断。 */
const RANGE_KLINE_LMT = 5000;

/** 快照请求字段(本层用 f2–f7/f12/f13/f15–f18/f124;f8/f10 与网页版保持一致一并请求)。 */
const QUOTE_FIELDS = "f2,f3,f4,f5,f6,f7,f8,f10,f12,f13,f14,f15,f16,f17,f18,f124";
/** K 线请求字段:fields2 的 f51–f58 即前 7 段所需;f59–f61 为振幅/涨跌幅/涨跌额,一并请求以便与网页版一致。 */
const KLINE_FIELDS1 = "f1,f2,f3,f4,f5,f6";
const KLINE_FIELDS2 = "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61";
/** 分时请求字段:f51–f58 对应 8 段。 */
const TRENDS_FIELDS1 = "f1,f2,f3,f4,f5,f6,f7,f8";
const TRENDS_FIELDS2 = "f51,f52,f53,f54,f55,f56,f57,f58";

/** K 线单根最少段数(时间,开,收,高,低,量,额)。 */
const KLINE_MIN_SEGMENTS = 7;
/** 分时单根最少段数(时间,开,收)。 */
const TRENDS_MIN_SEGMENTS = 3;

/** host 归一为 base URL:裸域名补 https://,去尾部斜杠;缺省用 fallback。 */
function resolveBaseUrl(host: string | undefined, fallback: string): string {
  const raw = host === undefined || host.length === 0 ? fallback : host;
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  return withScheme.endsWith("/") ? withScheme.slice(0, -1) : withScheme;
}

/** 是否公共 CORS 代理 host("proxy:" 前缀,见文件头);类型谓词收窄后可直接降级。 */
function isProxyHost(host: string | undefined): host is string {
  return host !== undefined && host.startsWith(PROXY_HOST_PREFIX);
}

/**
 * host + 端点 → 请求 URL。
 * - 直连 host:归一为 base URL 后拼 path + query(缺省用 defaultHost);
 * - 代理 host("proxy:" + 模板):先把「defaultHost + path + query」拼成完整东财 URL,
 *   再 encodeURIComponent 后替换进模板的 {url} 占位符(响应体即东财原 JSON,解析路径相同)。
 */
function buildRequestUrl(
  host: string | undefined,
  defaultHost: string,
  path: string,
  query: string
): string {
  if (isProxyHost(host)) {
    const template = host.slice(PROXY_HOST_PREFIX.length);
    const target = `${resolveBaseUrl(undefined, defaultHost)}${path}?${query}`;
    return template.replace("{url}", encodeURIComponent(target));
  }
  return `${resolveBaseUrl(host, defaultHost)}${path}?${query}`;
}

/** 请求超时:代理 host 多一跳转发给足 15s;直连返回 undefined 用 fetchJson 缺省 10s。 */
function requestTimeoutMs(host: string | undefined): number | undefined {
  return isProxyHost(host) ? PROXY_TIMEOUT_MS : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 取 data 下的数组字段;结构变形(非对象 / 非数组)返回 null。 */
function readDataArray(payload: unknown, key: string): unknown[] | null {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    return null;
  }
  const value = payload.data[key];
  return Array.isArray(value) ? value : null;
}

/** 东财数值字段:数字直接用;字符串 "-" / 空串 / 非有限数一律 null(缺失统一 null,不用 0 冒充)。 */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "-") {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

interface DiffMatch {
  inst: InstrumentConfig;
  entry: Record<string, unknown>;
}

/**
 * diff[] 逐条对账回入参标的:优先按 f13(市场)+f12(代码) 与 secid 精确匹配,
 * 对不上的条目按入参顺序吃余下标的(东财偶发返回代码 / 市场号变体时不至于整批丢失);
 * 条目比入参多时多余的丢弃,非对象的条目跳过。
 */
function matchDiffToInstruments(diff: unknown[], insts: InstrumentConfig[]): DiffMatch[] {
  const bySecid = new Map(insts.map((inst) => [inst.secid, inst]));
  const takenIds = new Set<string>();
  const matched = diff.map((raw) => {
    if (!isRecord(raw)) {
      return undefined;
    }
    const inst = bySecid.get(`${raw.f13}.${raw.f12}`);
    if (inst === undefined || takenIds.has(inst.id)) {
      return undefined;
    }
    takenIds.add(inst.id);
    return inst;
  });

  const remaining = insts.filter((inst) => !takenIds.has(inst.id));
  const result: DiffMatch[] = [];
  let cursor = 0;
  diff.forEach((raw, index) => {
    if (!isRecord(raw)) {
      return;
    }
    const matchedInst = matched[index];
    const inst = matchedInst ?? remaining[cursor];
    if (inst === undefined) {
      return;
    }
    if (matchedInst === undefined) {
      cursor += 1;
    }
    result.push({ inst, entry: raw });
  });
  return result;
}

function toQuote(instrumentId: string, entry: Record<string, unknown>): Quote {
  return {
    instrumentId,
    price: toNumber(entry.f2),
    change: toNumber(entry.f4),
    changePct: toNumber(entry.f3),
    amplitudePct: toNumber(entry.f7),
    open: toNumber(entry.f17),
    high: toNumber(entry.f15),
    low: toNumber(entry.f16),
    prevClose: toNumber(entry.f18),
    volume: toNumber(entry.f5),
    amount: toNumber(entry.f6),
    time: toNumber(entry.f124),
    source: "eastmoney"
  };
}

/**
 * 批量快照(单请求多 secid)。
 * @param insts 待取标的;实现可自行拼 secid 列表(如 "118.AU9999,1.000001")
 * @param host 调度器轮换出的域名;缺省用源内默认域名
 */
export async function fetchQuotes(insts: InstrumentConfig[], host?: string): Promise<Quote[]> {
  if (insts.length === 0) {
    return [];
  }
  const secids = insts.map((inst) => inst.secid).join(",");
  const url = buildRequestUrl(
    host,
    DEFAULT_QUOTE_HOST,
    "/api/qt/ulist.np/get",
    `secids=${secids}&fields=${QUOTE_FIELDS}&fltt=2&invt=2`
  );
  const payload = await fetchJson<unknown>(url, requestTimeoutMs(host));
  const diff = readDataArray(payload, "diff");
  if (diff === null) {
    return [];
  }
  return matchDiffToInstruments(diff, insts).map(({ inst, entry }) => toQuote(inst.id, entry));
}

/**
 * 单根 K 线:"日期,开,收,高,低,量,额,振幅%,涨跌幅%,涨跌额,换手%"。
 * 时间 + 开收高低为必需(缺一即整根不可用),量 / 额 / 振幅缺失或非法 → null。
 */
function parseKlineBar(raw: unknown): KlineBar | null {
  if (typeof raw !== "string") {
    return null;
  }
  const segments = raw.split(",");
  if (segments.length < KLINE_MIN_SEGMENTS) {
    return null;
  }
  const time = segments[0];
  const open = toNumber(segments[1]);
  const close = toNumber(segments[2]);
  const high = toNumber(segments[3]);
  const low = toNumber(segments[4]);
  // KlineBar 的开收高低为非空数值:任一缺失即整根不可用,跳过。
  if (time.length === 0 || open === null || close === null || high === null || low === null) {
    return null;
  }
  return {
    time,
    open,
    close,
    high,
    low,
    volume: toNumber(segments[5]),
    amount: toNumber(segments[6]),
    // 第 8 段振幅%:缺段 / "-" / 非数字一律 null(不影响该根其余字段)。
    amplitudePct: toNumber(segments[7])
  };
}

/**
 * 日/周/月 K 线(东财 kline 端点)。
 * @param range beg 存在时按 [beg, end] 范围取数(beg 原样透传、lmt 固定 5000,不按 limit 截断、
 *              hasMore 恒 false);否则维持 beg=0 + lmt=limit 的「最近 limit 根」语义
 * @param host 调度器轮换出的域名;缺省用源内默认域名
 */
export async function fetchKlines(
  inst: InstrumentConfig,
  period: KlinePeriod,
  range: KlineRange,
  host?: string
): Promise<KlinePage> {
  const limit = range.limit ?? DEFAULT_KLINE_LIMIT;
  const end = range.end ?? KLINE_END_TODAY;
  // 范围查询起点:beg 非空即启用(空串 / 缺省视为未启用,与 end 缺省同义)。
  const rangeBeg = range.beg === undefined || range.beg.length === 0 ? null : range.beg;
  const url = buildRequestUrl(
    host,
    DEFAULT_KLINE_HOST,
    "/api/qt/stock/kline/get",
    `secid=${inst.secid}&fields1=${KLINE_FIELDS1}&fields2=${KLINE_FIELDS2}&klt=${KLT_BY_PERIOD[period]}` +
      `&fqt=0&beg=${rangeBeg ?? "0"}&end=${end}&lmt=${rangeBeg === null ? limit : RANGE_KLINE_LMT}`
  );
  const payload = await fetchJson<unknown>(url, requestTimeoutMs(host));
  const klines = readDataArray(payload, "klines");
  if (klines === null) {
    return { bars: [], hasMore: false };
  }
  const parsed = klines.map(parseKlineBar).filter((bar): bar is KlineBar => bar !== null);
  // 源按日期升序返回,但契约要求升序,这里显式排序以防乱序输入。
  parsed.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  // 范围查询:请求已按区间限定(见 types.ts 的 KlineRange),原样返回、不判分页。
  if (rangeBeg !== null) {
    return { bars: parsed, hasMore: false };
  }
  // 条数兜底:lmt 语义为「最近 N 根」,但本环境该端点被源拒绝(HTTP 000),无法二次实测确认;
  // 若源忽略 lmt(或忽略 end 之后的截断),这里按「保留最近 limit 根」切片,保证 hasMore 与分页语义一致。
  const bars =
    Number.isInteger(limit) && limit > 0 && parsed.length > limit
      ? parsed.slice(parsed.length - limit)
      : parsed;
  return { bars, hasMore: bars.length === limit };
}

/**
 * 单个分时点:"YYYY-MM-DD HH:mm,开,收,高,低,量,额,均价",取 time/close(price)/开/高/低/量/均价。
 * 段数不足时缺的字段为 null(如 5 日跨日填充根的 open 为 0 是合法零值,照常保留)。
 */
function parseTrendPoint(raw: unknown): TrendPoint | null {
  if (typeof raw !== "string") {
    return null;
  }
  const segments = raw.split(",");
  if (segments.length < TRENDS_MIN_SEGMENTS) {
    return null;
  }
  const time = segments[0];
  const close = toNumber(segments[2]);
  // 实测坑:跨日分时的非当日交易日首根 close 可能为 0(open 为 0.00),这类点直接丢弃;
  // 同时 price 为非空数值,close 非有限数也整点丢弃。
  if (time.length === 0 || close === null || close <= 0) {
    return null;
  }
  return {
    time,
    price: close,
    volume: segments.length > 5 ? toNumber(segments[5]) : null,
    avgPrice: segments.length > 7 ? toNumber(segments[7]) : null,
    open: toNumber(segments[1]),
    high: segments.length > 3 ? toNumber(segments[3]) : null,
    low: segments.length > 4 ? toNumber(segments[4]) : null
  };
}

/**
 * 分时(1 日 / 5 日,东财 trends 端点)。
 * @param ndays 1=当日分时,5=五日分时
 * @param host 调度器轮换出的域名;缺省用源内默认域名
 */
export async function fetchTrends(
  inst: InstrumentConfig,
  ndays: TrendDays,
  host?: string
): Promise<TrendSet> {
  const url = buildRequestUrl(
    host,
    DEFAULT_KLINE_HOST,
    "/api/qt/stock/trends2/get",
    `secid=${inst.secid}&fields1=${TRENDS_FIELDS1}&fields2=${TRENDS_FIELDS2}&ndays=${ndays}&iscr=0`
  );
  const payload = await fetchJson<unknown>(url, requestTimeoutMs(host));
  const prevClose =
    isRecord(payload) && isRecord(payload.data) ? toNumber(payload.data.preClose) : null;
  const trends = readDataArray(payload, "trends");
  if (trends === null) {
    return { points: [], prevClose };
  }
  const points = trends.map(parseTrendPoint).filter((point): point is TrendPoint => point !== null);
  // 五日数据保持源返回顺序(跨日分组交给渲染层),此处不排序。
  return { points, prevClose };
}
