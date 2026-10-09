// 腾讯行情源(兜底源):批量快照 / K 线 / 分时。
//
// 实现约束:
// - 所有真实请求走 src/api/market/throttle.ts 的封装(或直接接收调用方轮换后的 host),
//   不要在源内自建并发/重试;
// - 快照编码为 GBK:用 fetchArrayBuffer 取字节后 `new TextDecoder("gbk").decode(buf)`;
// - 响应体两种体例,按 tencentCode 的 hf_ 前缀推导(不新增配置字段):
//   内盘(如 sh000001)`v_sh000001="1~上证指数~..."`,~ 分隔;
//   外盘(如 hf_XAU)`v_hf_XAU="4192.61,1.43,..."`,逗号分隔;
// - K 线 / 分时端点仅支持非 hf_ 代码,外盘没有对应数据(hf_ / 缺 tencentCode 一律抛 MarketError,
//   facade 已据此决定是否回落);
// - K 线范围查询(range.beg 存在):param 用 `{code},{period},{start},{end},{count},` 按区间取数,
//   不按 limit 截断且 hasMore 恒 false(见 types.ts 的 KlineRange);count 的取值受源上限约束,
//   见 RANGE_KLINE_COUNT 注释;
// - 请求层失败原样抛出(由调度器重试 / facade 兜底);只有「解析结果变形」才降级为空结果,
//   不把坏数据当异常(见 T1b 卡片第 5 条)。
//
// 导出说明:除卡片冻结的三个取数函数外,另导出三个纯解析函数(parseSnapshot / parseKlines /
// parseTrends),把「HTTP 层」与「解析层」分开,便于单测直接喂解码后的 GBK 文本或 fixture JSON
// (GBK 字节 → ArrayBuffer → TextDecoder("gbk"))。取数函数只负责拼 URL 与转发解析结果。
import { DEFAULT_KLINE_LIMIT } from "../config";
import { fetchArrayBuffer, fetchJson } from "../throttle";
import { MarketError } from "../types";
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

/**
 * 腾讯各端点的默认 URL 前缀(卡片冻结)。
 * 实测结论:域名由端点决定,不是可自由轮换的维度——qt.gtimg.cn 只服务快照,
 * K 线 / 分时在 web.ifzq.gtimg.cn(分时同 ifzq.gtimg.cn),拿快照域名请求 K 线只得到 "bad request"。
 */
const DEFAULT_URL_PREFIXES = {
  quote: "https://qt.gtimg.cn/q=",
  kline: "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=",
  minute: "https://ifzq.gtimg.cn/appstock/app/minute/query?code=",
  fiveday: "https://ifzq.gtimg.cn/appstock/app/day/query?code="
} as const;

/** 腾讯自有域名:facade 的轮换值恰是这些裸域名(见 resolveUrlPrefix)。 */
const TENCENT_BARE_HOSTS = new Set(["qt.gtimg.cn", "web.ifzq.gtimg.cn", "ifzq.gtimg.cn"]);

/**
 * 范围查询(beg 存在)时的 count:区间取数时它是「返回条数上限」,需要足够大以覆盖任意区间。
 * 取值受源校验约束:实测(2026-10-09,sh000001)count=2000 正常返回区间数据,2500 及以上返回
 * `{"code":0,"msg":"param error"}` 且无 data(表现为解析后「无数据」,K 线图上显示暂无数据),
 * 故取源可接受的实测上限 2000(约 8 年日线 / 38 年周线,足够覆盖可选区间)。
 */
const RANGE_KLINE_COUNT = 2000;

/** 北京时间相对 UTC 的偏移(腾讯响应里的时间戳均为北京时间)。 */
const BEIJING_OFFSET_SECONDS = 8 * 60 * 60;

/**
 * 把 host 参数归一成「完整 URL 前缀」。
 * 契约里 host 是完整 URL 前缀(备用域名路径与主域不同,如 kline 备用前缀
 * `https://proxy.finance.qq.com/ifzqgtimg/kline/kline?param=`),但 facade 的调度器目前轮换的是
 * 裸域名(`TENCENT_HOSTS = ["qt.gtimg.cn", "web.ifzq.gtimg.cn"]`),故三种形态都要能用:
 * - 缺省 / 腾讯自有裸域名 → 本端点默认前缀(端点决定域名,见 DEFAULT_URL_PREFIXES);
 * - 其它裸域名 → 换掉默认前缀的 host,保留其路径与查询段;
 * - 含 "://" → 原样当前缀(备用域名自带路径的场景)。
 */
function resolveUrlPrefix(host: string | undefined, fallback: string): string {
  if (host === undefined || host === "" || TENCENT_BARE_HOSTS.has(host)) {
    return fallback;
  }
  if (host.includes("://")) {
    return host;
  }
  const base = new URL(fallback);
  return `${base.protocol}//${host}${base.pathname}${base.search}`;
}

/** 外盘代码(hf_ 前缀):快照为逗号分隔体例,且无 K 线 / 分时。 */
function isForeignCode(code: string): boolean {
  return code.startsWith("hf_");
}

/** 单值转数值:数字原样,字符串非空且可解析才返回,其余(null/空串/NaN/Infinity)一律 null。 */
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

/** 定点四舍五入(推导值补齐用):消化二进制浮点尾差(如 59.150000000000006 → 59.15)。 */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** YYYYMMDD → YYYY-MM-DD;非法返回 null(调用方决定缺省行为)。 */
function toDashDate(yyyymmdd: string): string | null {
  if (!/^\d{8}$/.test(yyyymmdd)) {
    return null;
  }
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** "YYYYMMDDHHmmss"(北京时间)→ unix 秒;格式不符返回 null。 */
function beijingStampToUnix(stamp: string | undefined): number | null {
  if (stamp === undefined || !/^\d{14}$/.test(stamp)) {
    return null;
  }
  const seconds =
    Date.UTC(
      Number(stamp.slice(0, 4)),
      Number(stamp.slice(4, 6)) - 1,
      Number(stamp.slice(6, 8)),
      Number(stamp.slice(8, 10)),
      Number(stamp.slice(10, 12)),
      Number(stamp.slice(12, 14))
    ) / 1000;
  return Number.isFinite(seconds) ? seconds - BEIJING_OFFSET_SECONDS : null;
}

/** 今日(北京时间)YYYY-MM-DD:外盘响应缺日期字段时兜底用。 */
function beijingToday(): string {
  const now = new Date(Date.now() + BEIJING_OFFSET_SECONDS * 1000);
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
}

/** 外盘时间:日期字段(YYYY-MM-DD,缺省取北京时间当日)+ "HH:mm:ss" → unix 秒;时间非法返回 null。 */
function foreignTimeToUnix(time: string | undefined, date: string | undefined): number | null {
  if (time === undefined) {
    return null;
  }
  const matched = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
  if (matched === null) {
    return null;
  }
  const day = date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : beijingToday();
  const seconds =
    Date.UTC(
      Number(day.slice(0, 4)),
      Number(day.slice(5, 7)) - 1,
      Number(day.slice(8, 10)),
      Number(matched[1]),
      Number(matched[2]),
      Number(matched[3] ?? "0")
    ) / 1000;
  return Number.isFinite(seconds) ? seconds - BEIJING_OFFSET_SECONDS : null;
}

/** "HHMM" → "HH:mm";非法返回 null。 */
function minuteLabel(raw: string | undefined): string | null {
  if (raw === undefined || !/^\d{4}$/.test(raw)) {
    return null;
  }
  return `${raw.slice(0, 2)}:${raw.slice(2, 4)}`;
}

/** 快照赋值串 `v_code="...";` 的提取(内盘与外盘都是这种封装)。 */
const SNAPSHOT_ASSIGNMENT = /v_([A-Za-z0-9_]+)="([^"]*)"/g;

/** 解析快照文本(已解码的 GBK 文本)→ 赋值串按 code 分组。 */
function parseSnapshotAssignments(text: string): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const matched of text.matchAll(SNAPSHOT_ASSIGNMENT)) {
    bodies.set(matched[1], matched[2]);
  }
  return bodies;
}

/**
 * 内盘指数体例(~ 分隔):3 最新价、4 昨收、5 今开、31 涨跌额、32 涨跌幅%、33 最高、34 最低、
 * 36 成交量(手)、37 成交额(万元)。
 * 量额下标为 36 / 37(非卡片的 37 / 38):2026-10-09 实测 sh000001/sz399006/sh000688 三码
 * 36 与复合字段 35 的「价/量/额」中段一致(如 535149921),37 与末段的万元口径一致
 * (如 88856120 万元 ≈ 888561198264 元),38 实为换手率;卡片此处多算了一位。
 */
function parseIndexQuoteBody(inst: InstrumentConfig, fields: string[]): Quote | null {
  const price = toNumber(fields[3]);
  if (price === null) {
    // 最新价都取不到 → 视为该标的无数据(与「无 v_ 段」同语义),facade 继续兜底。
    return null;
  }
  const amount = toNumber(fields[37]);
  return {
    instrumentId: inst.id,
    price,
    change: toNumber(fields[31]),
    changePct: toNumber(fields[32]),
    // 腾讯快照不提供振幅(卡片结论),固定 null;缺失字段由 deriveMissingQuoteFields 推导补齐。
    amplitudePct: null,
    open: toNumber(fields[5]),
    high: toNumber(fields[33]),
    low: toNumber(fields[34]),
    prevClose: toNumber(fields[4]),
    volume: toNumber(fields[36]),
    // 成交额单位为万元,统一换算成元。
    amount: amount === null ? null : amount * 1e4,
    time: beijingStampToUnix(fields[30]),
    source: "tencent"
  };
}

/** 外盘体例(逗号分隔):0 最新价、1 涨跌幅%、4 最高、5 最低、6 时间、7 昨收、8 今开、12 日期。 */
function parseForeignQuoteBody(inst: InstrumentConfig, fields: string[]): Quote | null {
  const price = toNumber(fields[0]);
  if (price === null) {
    return null;
  }
  return {
    instrumentId: inst.id,
    price,
    // 外盘响应没有涨跌额字段,也不由源内反推;缺失字段由 deriveMissingQuoteFields 推导补齐。
    change: null,
    changePct: toNumber(fields[1]),
    amplitudePct: null,
    open: toNumber(fields[8]),
    high: toNumber(fields[4]),
    low: toNumber(fields[5]),
    prevClose: toNumber(fields[7]),
    volume: null,
    amount: null,
    time: foreignTimeToUnix(fields[6], fields[12]),
    source: "tencent"
  };
}

/** 是否为可参与推导的有限数(推导只认有限数,null / NaN / Infinity 都不推导)。 */
function isFiniteNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

/**
 * 腾讯体例缺字段，推导补齐(只补 null,不覆盖已解析到的值):
 * - change 缺失:price、prevClose 均可得 → change = price - prevClose;
 * - changePct 缺失:change 可得且 prevClose 非 0 → changePct = change / prevClose × 100;
 * - amplitudePct 缺失:high、low、prevClose 均可得且 prevClose 非 0 → amplitudePct = (high - low) / prevClose × 100。
 * 推导值按标的 priceDecimals 四舍五入(change)/ 保留 2 位(changePct、amplitudePct)。
 */
function deriveMissingQuoteFields(inst: InstrumentConfig, quote: Quote): Quote {
  let { change, changePct, amplitudePct } = quote;
  if (change === null && isFiniteNumber(quote.price) && isFiniteNumber(quote.prevClose)) {
    change = roundTo(quote.price - quote.prevClose, inst.priceDecimals);
  }
  if (
    changePct === null &&
    isFiniteNumber(change) &&
    isFiniteNumber(quote.prevClose) &&
    quote.prevClose !== 0
  ) {
    changePct = roundTo((change / quote.prevClose) * 100, 2);
  }
  if (
    amplitudePct === null &&
    isFiniteNumber(quote.high) &&
    isFiniteNumber(quote.low) &&
    isFiniteNumber(quote.prevClose) &&
    quote.prevClose !== 0
  ) {
    amplitudePct = roundTo(((quote.high - quote.low) / quote.prevClose) * 100, 2);
  }
  return { ...quote, change, changePct, amplitudePct };
}

/**
 * 解析批量快照(入参为已解码的 GBK 文本)。
 * 只返回解析成功的标的:无 v_ 段、最新价缺失 / 非法的标的都不出现在结果里(调用方判缺兜底)。
 * 解析完成后统一做一轮「腾讯体例缺字段，推导补齐」(见 deriveMissingQuoteFields)。
 */
export function parseSnapshot(text: string, insts: InstrumentConfig[]): Quote[] {
  const bodies = parseSnapshotAssignments(text);
  const quotes: Quote[] = [];
  for (const inst of insts) {
    const code = inst.tencentCode;
    if (code === undefined) {
      continue;
    }
    const body = bodies.get(code);
    if (body === undefined) {
      continue;
    }
    const fields = isForeignCode(code) ? body.split(",") : body.split("~");
    const quote = isForeignCode(code)
      ? parseForeignQuoteBody(inst, fields)
      : parseIndexQuoteBody(inst, fields);
    if (quote !== null) {
      quotes.push(deriveMissingQuoteFields(inst, quote));
    }
  }
  return quotes;
}

/**
 * 批量快照(单请求多代码)。
 * @param insts 待取标的;按 tencentCode 拼代码列表(如 "sh000001,hf_XAU"),无 tencentCode 的跳过
 * @param host 调度器轮换出的域名 / 完整 URL 前缀;缺省用源内默认前缀
 */
export async function fetchQuotes(insts: InstrumentConfig[], host?: string): Promise<Quote[]> {
  const codes = insts
    .map((inst) => inst.tencentCode)
    .filter((code): code is string => code !== undefined);
  if (codes.length === 0) {
    return [];
  }
  const url = `${resolveUrlPrefix(host, DEFAULT_URL_PREFIXES.quote)}${codes.join(",")}`;
  const buffer = await fetchArrayBuffer(url);
  return parseSnapshot(new TextDecoder("gbk").decode(buffer), insts);
}

/**
 * K 线 param 段:
 * - 范围查询(beg 非空):`{code},{period},{start},{end},{count},`(start / end 为 YYYY-MM-DD);
 * - 非范围查询:`{code},{period},,{end},{limit},`(第 3 段空 = 不复权,按最近 limit 根取)。
 * beg / end 的非法值一律留空(与既有 end 处理同义,不拼坏日期)。
 */
function buildKlineParam(
  code: string,
  period: KlinePeriod,
  range: KlineRange,
  limit: number
): string {
  // amount 缺失恒 null;end 由 range.end(YYYYMMDD)转 YYYY-MM-DD,非法与缺省同义(留空)。
  const end = range.end === undefined ? "" : (toDashDate(range.end) ?? "");
  const beg = range.beg;
  if (beg !== undefined && beg.length > 0) {
    return `${code},${period},${toDashDate(beg) ?? ""},${end},${RANGE_KLINE_COUNT},`;
  }
  return `${code},${period},,${end},${limit},`;
}

/** 是否启用范围查询:beg 非空即启用(空串 / 缺省视为未启用,与 end 缺省同义)。 */
function hasRangeStart(range: KlineRange): boolean {
  return range.beg !== undefined && range.beg.length > 0;
}

/** 取 data[code][period] 行数组;层级缺失 / 类型不符返回空数组(整体变形降级为空结果)。 */
function readKlineRows(payload: unknown, code: string, period: KlinePeriod): unknown[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const data = (payload as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) {
    return [];
  }
  const entry = (data as Record<string, unknown>)[code];
  if (typeof entry !== "object" || entry === null) {
    return [];
  }
  const rows = (entry as Record<string, unknown>)[period];
  return Array.isArray(rows) ? rows : [];
}

/** 腾讯 K 线行解析出的中间形态:振幅要按相邻收盘推导,构造时先不带该字段。 */
type KlineBarDraft = Omit<KlineBar, "amplitudePct">;

/**
 * 振幅补齐:腾讯 K 线行无振幅字段,按「(高 - 低) / 前一根收盘 × 100」推导,保留 2 位小数。
 * 入参须为升序序列(源返回即升序,见 parseKlines)。首根没有前收 → null;
 * 前收为 0(非有限数不会出现,open/close 已由 toNumber 保证有限)也 → null,不产生 Infinity。
 * 非范围模式在截断后调用:截断使新的首根丢失前收 → 振幅 null,可接受(仅影响首根)。
 */
function withAmplitude(bars: KlineBarDraft[]): KlineBar[] {
  return bars.map((bar, index) => {
    const prevClose = index === 0 ? null : bars[index - 1].close;
    const amplitudePct =
      isFiniteNumber(prevClose) && prevClose !== 0
        ? roundTo(((bar.high - bar.low) / prevClose) * 100, 2)
        : null;
    return { ...bar, amplitudePct };
  });
}

/**
 * 解析 K 线响应。
 * 行结构 [日期,开,收,高,低,成交量手],无成交额 → amount null;open/close/high/low 任一非法的行丢弃
 * (KlineBar 的这四个字段不可为 null);响应升序原样保留。amplitudePct 由序列内前一根收盘推导
 * (见 withAmplitude),首根恒 null。
 * 非范围查询:端点会多返回一条(limit+1,用于判断还有更早数据),故按最新 limit 条截断——hasMore 的
 * 「条数 === limit」判定与 facade 保持一致;范围查询(ranged,见 types.ts 的 KlineRange)原样返回、
 * 不截断且 hasMore 恒 false。
 */
export function parseKlines(
  payload: unknown,
  code: string,
  period: KlinePeriod,
  limit: number,
  ranged = false
): KlinePage {
  const rows = readKlineRows(payload, code, period);
  const bars: KlineBarDraft[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || typeof row[0] !== "string" || row[0] === "") {
      continue;
    }
    const open = toNumber(row[1]);
    const close = toNumber(row[2]);
    const high = toNumber(row[3]);
    const low = toNumber(row[4]);
    if (open === null || close === null || high === null || low === null) {
      continue;
    }
    bars.push({ time: row[0], open, close, high, low, volume: toNumber(row[5]), amount: null });
  }
  if (ranged) {
    return { bars: withAmplitude(bars), hasMore: false };
  }
  const page = bars.length > limit ? bars.slice(bars.length - limit) : bars;
  const withAmp = withAmplitude(page);
  return { bars: withAmp, hasMore: withAmp.length === limit };
}

/**
 * 日/周/月 K 线(腾讯 kline 端点;仅非 hf_ 代码可用)。
 * @param range beg 存在时按 [beg, end] 范围取数(param 第 3 段为 YYYY-MM-DD 的 start、count 固定
 *              RANGE_KLINE_COUNT,不按 limit 截断、hasMore 恒 false);否则维持 `,,{end},{limit},`
 *              的最近 N 根语义
 * @param host 调度器轮换出的域名 / 完整 URL 前缀;缺省用源内默认前缀
 */
export async function fetchKlines(
  inst: InstrumentConfig,
  period: KlinePeriod,
  range: KlineRange,
  host?: string
): Promise<KlinePage> {
  const code = inst.tencentCode;
  if (code === undefined || isForeignCode(code)) {
    throw new MarketError("tencent", `${inst.name} 无腾讯 K 线代码(该端点仅支持内盘指数)`);
  }
  const limit = range.limit ?? DEFAULT_KLINE_LIMIT;
  const url = `${resolveUrlPrefix(host, DEFAULT_URL_PREFIXES.kline)}${buildKlineParam(code, period, range, limit)}`;
  const payload = await fetchJson(url);
  return parseKlines(payload, code, period, limit, hasRangeStart(range));
}

/** 取 data[code](快照与分时的公共容器);层级缺失 / 类型不符返回 null。 */
function readCodeEntry(payload: unknown, code: string): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const data = (payload as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const entry = (data as Record<string, unknown>)[code];
  return typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : null;
}

/** 分时基准昨收:qt 快照块(~ 分隔)下标 4;qt 可能是裸数组,也可能是 {code: [...]},缺失 / 非法 → null。 */
function readPrevClose(qt: unknown, code: string): number | null {
  const block = Array.isArray(qt)
    ? qt
    : typeof qt === "object" && qt !== null
      ? (qt as Record<string, unknown>)[code]
      : undefined;
  return Array.isArray(block) ? toNumber(block[4]) : null;
}

/**
 * 追加一个交易日的分时点(1 日块 / 5 日里的单个日块)到 target。
 * 每项格式 "HHMM 价格 累计量 累计额":量为当日累计值,首根保留原值、其后按相邻累计量差分;
 * 差分基准是函数内局部变量,故 5 日分时的各日块各自从累计量重新起算(跨块不差分)。
 * 时间拼 "YYYY-MM-DD HH:mm";日期 / 时刻非法的项丢弃;腾讯分时不提供分钟 OHLC 与均价线,
 * 故 open/high/low/avgPrice 恒 null。
 */
function appendTrendPoints(target: TrendPoint[], rawDate: unknown, rawPoints: unknown): void {
  if (typeof rawDate !== "string" || !Array.isArray(rawPoints)) {
    return;
  }
  const date = toDashDate(rawDate);
  if (date === null) {
    return;
  }
  let previousCumulative: number | null = null;
  for (const item of rawPoints) {
    if (typeof item !== "string") {
      continue;
    }
    const fields = item.trim().split(/\s+/);
    const label = minuteLabel(fields[0]);
    const price = toNumber(fields[1]);
    if (label === null || price === null) {
      continue;
    }
    const cumulative = toNumber(fields[2]);
    const volume =
      cumulative === null
        ? null
        : previousCumulative === null
          ? cumulative
          : cumulative - previousCumulative;
    if (cumulative !== null) {
      // 累计量缺失时保留上一有效累计量为基准,后续差分仍以累计量序列为准。
      previousCumulative = cumulative;
    }
    target.push({
      time: `${date} ${label}`,
      price,
      avgPrice: null,
      volume,
      open: null,
      high: null,
      low: null
    });
  }
}

/**
 * 解析分时响应。
 * ndays=1:`data[code].data` 为 {date, data[]} 单日块;
 * ndays=5:`data[code].data` 为 5 个日块数组,最新在前,反转成时间升序。
 * prevClose 取 qt 块的昨收;整体变形 → {points: [], prevClose: null}。
 */
export function parseTrends(payload: unknown, code: string, ndays: TrendDays): TrendSet {
  const entry = readCodeEntry(payload, code);
  if (entry === null) {
    return { points: [], prevClose: null };
  }
  const prevClose = readPrevClose(entry.qt, code);
  const points: TrendPoint[] = [];
  if (ndays === 1) {
    const day = entry.data;
    if (typeof day === "object" && day !== null) {
      const block = day as Record<string, unknown>;
      appendTrendPoints(points, block.date, block.data);
    }
  } else {
    const blocks = Array.isArray(entry.data) ? entry.data : [];
    for (const block of [...blocks].reverse()) {
      if (typeof block === "object" && block !== null) {
        const day = block as Record<string, unknown>;
        appendTrendPoints(points, day.date, day.data);
      }
    }
  }
  return { points, prevClose };
}

/**
 * 分时(1 日 / 5 日;仅非 hf_ 代码可用)。
 * @param ndays 1=当日分时,5=五日分时
 * @param host 调度器轮换出的域名 / 完整 URL 前缀;缺省用源内默认前缀
 */
export async function fetchTrends(
  inst: InstrumentConfig,
  ndays: TrendDays,
  host?: string
): Promise<TrendSet> {
  const code = inst.tencentCode;
  if (code === undefined || isForeignCode(code)) {
    throw new MarketError("tencent", `${inst.name} 无腾讯分时代码(该端点仅支持内盘指数)`);
  }
  const fallback = ndays === 1 ? DEFAULT_URL_PREFIXES.minute : DEFAULT_URL_PREFIXES.fiveday;
  const url = `${resolveUrlPrefix(host, fallback)}${code}`;
  const payload = await fetchJson(url);
  return parseTrends(payload, code, ndays);
}
