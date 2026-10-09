// 行情层纯函数:格式化 / 均线 / 日期位移 / 涨跌分类。
// 全部无副作用、不触网,便于单测;数值缺失(null / 非有限数)统一显示 "--"。

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
