// 行情层纯函数:格式化 / 均线 / 日期位移 / 涨跌分类 / 日 K 周·月聚合。
// 全部无副作用、不触网,便于单测;数值缺失(null / 非有限数)统一显示 "--"。
import type { KlineBar } from "./types";

/** 缺失值占位文案(UI 统一口径)。 */
export const MISSING_TEXT = "--";

/** 一亿 / 一万(中文单位换算阈值)。 */
const YI = 1e8;
const WAN = 1e4;

/** 是否为有效数值(null 与 NaN / Infinity 都算缺失)。 */
function isValidNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

/** 价格:按标的小数位定点显示;缺失显示 "--"。 */
export function formatPrice(value: number | null, decimals: number): string {
  if (!isValidNumber(value)) {
    return MISSING_TEXT;
  }
  return value.toFixed(decimals);
}

/** 带符号数值(涨跌额 / 涨跌幅主体):正数补 "+",缺失显示 "--"。 */
export function formatSigned(value: number | null, decimals: number): string {
  if (!isValidNumber(value)) {
    return MISSING_TEXT;
  }
  // 归零:避免 -0 显示成 "-0.00"。
  const normalized = value === 0 ? 0 : value;
  const sign = normalized > 0 ? "+" : "";
  return `${sign}${normalized.toFixed(decimals)}`;
}

/** 涨跌幅:带符号百分比,如 "+1.23%" / "-0.45%";缺失显示 "--"。 */
export function formatPct(value: number | null): string {
  if (!isValidNumber(value)) {
    return MISSING_TEXT;
  }
  return `${formatSigned(value, 2)}%`;
}

/** 振幅等恒正百分比:不带符号,如 "1.85%";缺失显示 "--"。 */
export function formatUnsignedPct(value: number | null): string {
  if (!isValidNumber(value)) {
    return MISSING_TEXT;
  }
  return `${value.toFixed(2)}%`;
}

// 中文数量换算(成交额与成交量同规则):≥1e8 用「亿」,≥1e4 用「万」,否则原样输出。
// 注:99999999 这类贴近阈值的值经 toFixed(2) 会进位为 "10000.00万",属可接受的显示精度取舍。
function formatCnMagnitude(value: number | null): string {
  if (!isValidNumber(value)) {
    return MISSING_TEXT;
  }
  const abs = Math.abs(value);
  if (abs >= YI) {
    return `${(value / YI).toFixed(2)}亿`;
  }
  if (abs >= WAN) {
    return `${(value / WAN).toFixed(2)}万`;
  }
  return `${value}`;
}

/** 成交额:中文单位换算;缺失显示 "--"。 */
export function formatAmountCn(value: number | null): string {
  return formatCnMagnitude(value);
}

/** 成交量:中文单位换算(与成交额同规则);缺失显示 "--"。 */
export function formatVolumeCn(value: number | null): string {
  return formatCnMagnitude(value);
}

/** 行情时间(unix 秒 → 本地时区 HH:mm:ss);缺失显示 "--"。 */
export function formatQuoteTime(unixSec: number | null): string {
  if (!isValidNumber(unixSec)) {
    return MISSING_TEXT;
  }
  const date = new Date(unixSec * 1000);
  if (Number.isNaN(date.getTime())) {
    return MISSING_TEXT;
  }
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 移动均线:对 closes 逐点求 period 窗口均值;窗口内出现任何缺失(或点数不足)即为 null。
 * 返回值为「周期 → 与 closes 等长的均线数组」,便于一次算多条线。
 */
export function computeMA(
  closes: (number | null)[],
  periods: number[]
): Record<number, (number | null)[]> {
  const result: Record<number, (number | null)[]> = {};
  for (const period of periods) {
    const line: (number | null)[] = new Array<number | null>(closes.length).fill(null);
    if (!Number.isInteger(period) || period < 1) {
      result[period] = line;
      continue;
    }
    let sum = 0;
    let missing = 0;
    for (let index = 0; index < closes.length; index += 1) {
      const value = closes[index];
      if (isValidNumber(value)) {
        sum += value;
      } else {
        missing += 1;
      }
      // 滑出窗口的左端一并移出统计。
      if (index >= period) {
        const dropped = closes[index - period];
        if (isValidNumber(dropped)) {
          sum -= dropped;
        } else {
          missing -= 1;
        }
      }
      if (index >= period - 1 && missing === 0) {
        line[index] = sum / period;
      }
    }
    result[period] = line;
  }
  return result;
}

const YYYYMMDD = /^\d{8}$/;
const MS_PER_DAY = 86_400_000;

/**
 * YYYYMMDD 日期位移(纯 UTC 运算,跨月/跨年/闰年天然正确);当前调用方为测试夹具。
 * 非法输入(格式不符、日期不存在如 20240230、deltaDays 非整数)一律抛错,不做静默兜底。
 */
export function shiftYyyymmdd(date: string, deltaDays: number): string {
  if (!YYYYMMDD.test(date)) {
    throw new Error(`shiftYyyymmdd: 非法日期「${date}」(要求 YYYYMMDD)`);
  }
  if (!Number.isInteger(deltaDays)) {
    throw new Error(`shiftYyyymmdd: deltaDays 必须为整数(收到 ${deltaDays})`);
  }
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const base = Date.UTC(year, month - 1, day);
  const probe = new Date(base);
  // 回读校验:Date.UTC 会把 20240230 这类不存在 (或月/日为 0) 的日期静默滚动,这里显式拦截。
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`shiftYyyymmdd: 日期不存在「${date}」`);
  }
  const shifted = new Date(base + deltaDays * MS_PER_DAY);
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${shifted.getUTCFullYear()}${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}`;
}

/** 涨跌分类(UI 红绿/flat 色):close 高于 open 为 up,低于为 down,相等或数据无效为 flat。 */
export function classifyTrend(open: number, close: number): "up" | "down" | "flat" {
  if (!Number.isFinite(open) || !Number.isFinite(close)) {
    return "flat";
  }
  if (close > open) {
    return "up";
  }
  if (close < open) {
    return "down";
  }
  return "flat";
}

/** "YYYY-MM-DD"(新源 PAXG / SGE 的 bar.time 体例);旧源东财为 "YYYY-MM-DD HH:mm"。 */
const DASH_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" → 当日 UTC 零点毫秒;格式不符返回 null(调用方跳过该根,不静默造桶)。 */
function dashDateToUtcMs(time: string): number | null {
  const matched = DASH_DATE.exec(time);
  if (matched === null) {
    return null;
  }
  return Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
}

/** UTC 毫秒 → "YYYY-MM-DD"(getUTC* 读回,勿用本地时区,与桶键口径一致)。 */
function utcMsToDashDate(ms: number): string {
  const date = new Date(ms);
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 桶内聚合的中间形态:volume/amount 逐行收集后统一求和(首根行也要进桶)。 */
interface DailyBarBucket {
  key: string;
  /** 桶首根的 time(桶的展示时间,取首根而非周一/月初)。 */
  time: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volumes: (number | null)[];
  amounts: (number | null)[];
}

/** 聚合求和:只累加有限数,null / NaN 不进和;全缺失返回 null(不冒充 0)。 */
function sumNullable(values: (number | null)[]): number | null {
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (value !== null && Number.isFinite(value)) {
      sum += value;
      count += 1;
    }
  }
  return count === 0 ? null : sum;
}

/** 定点两位四舍五入(振幅推导值用):消化二进制浮点尾差(如 1.6500000000000001 → 1.65)。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** bar.time → 桶键:week 为本周周一的 "YYYY-MM-DD"(ISO 周,周一为界);month 为 "YYYY-MM"。 */
function bucketKey(time: string, period: "week" | "month"): string | null {
  const utcMs = dashDateToUtcMs(time);
  if (utcMs === null) {
    return null;
  }
  if (period === "month") {
    return time.slice(0, 7);
  }
  // ISO 周:回退到本周周一(周一为界;周日 getUTCDay()=6 → 偏移 6 天回退),
  // UTC 毫秒运算跨月/跨年由 Date 进位保证正确,不用本地时区避免周界漂移。
  const offsetDays = (new Date(utcMs).getUTCDay() + 6) % 7;
  return utcMsToDashDate(utcMs - offsetDays * MS_PER_DAY);
}

/**
 * 日 K → 周/月 K 客户端聚合(上金所源仅提供日 K,周/月线由此派生)。
 *
 * 桶边界:week 按 ISO 周(周一为界,UTC 安全计算,见 bucketKey);month 按自然月(YYYY-MM)。
 * 桶内归并:open=首根 open、close=末根 close、high=max、low=min、volume/amount=求和
 * (null/非有限数不进和,全缺失为 null)、time=桶首根的 time(非周一/月初,保留桶内首个交易日);
 * amplitudePct=按前桶 close 现算((high-low)/prevClose×100,保留两位;首桶无前收 → null,
 * 前收 0/非有限数 → null,不产生 Infinity)。
 *
 * 假定入参按时间升序(调用方——SGE 源返回升序全量——满足;升序下同桶行必然连续);
 * time 非 "YYYY-MM-DD" 的行跳过(防御:不静默造桶)。空数组 → []。
 */
export function aggregateDailyBars(bars: KlineBar[], period: "week" | "month"): KlineBar[] {
  const buckets: DailyBarBucket[] = [];
  let current: DailyBarBucket | null = null;
  for (const bar of bars) {
    const key = bucketKey(bar.time, period);
    if (key === null) {
      continue;
    }
    if (current === null || current.key !== key) {
      current = {
        key,
        time: bar.time,
        open: bar.open,
        close: bar.close,
        high: bar.high,
        low: bar.low,
        volumes: [],
        amounts: []
      };
      buckets.push(current);
    } else {
      current.close = bar.close;
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
    }
    current.volumes.push(bar.volume);
    current.amounts.push(bar.amount);
  }
  return buckets.map((bucket, index) => {
    const prevClose = index === 0 ? null : buckets[index - 1].close;
    const amplitudePct =
      prevClose !== null && Number.isFinite(prevClose) && prevClose !== 0
        ? round2(((bucket.high - bucket.low) / prevClose) * 100)
        : null;
    return {
      time: bucket.time,
      open: bucket.open,
      close: bucket.close,
      high: bucket.high,
      low: bucket.low,
      volume: sumNullable(bucket.volumes),
      amount: sumNullable(bucket.amounts),
      amplitudePct
    };
  });
}
