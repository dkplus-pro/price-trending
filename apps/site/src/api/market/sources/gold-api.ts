// gold-api 行情源(伦敦金最后兜底):仅提供现货金单标的快照(XAU)。
//
// 实现约束:
// - 仅 config.ts 中配置了 goldApiSymbol 的标的可用(当前只有 xau/伦敦金);该源无 K 线/分时;
// - 所有真实请求走 src/api/market/throttle.ts 的封装(或直接接收调用方轮换后的 host);
// - 返回的 price 为美元/盎司现价,缺少的量、额、昨收等字段一律填 null(不要用 0 冒充缺失);
// - 请求层失败原样抛出(由调度器重试 / facade 兜底);响应缺 price / updatedAt 只降级为对应字段 null。
import { fetchJson } from "../throttle";
import { MarketError } from "../types";
import type { InstrumentConfig, Quote } from "../types";

/** 默认 URL 前缀(卡片冻结;host 语义与腾讯源一致:缺省用主前缀,含 "://" 的完整前缀原样用)。 */
const DEFAULT_PRICE_URL_PREFIX = "https://api.gold-api.com/price/";

/**
 * 把 host 参数归一成「完整 URL 前缀」:
 * - 缺省 → 默认前缀;
 * - 含 "://" → 原样使用(契约语义);
 * - 裸域名(facade 调度器当前的轮换值)→ 换掉默认前缀的 host,保留其路径。
 */
function resolveUrlPrefix(host: string | undefined): string {
  if (host === undefined || host === "") {
    return DEFAULT_PRICE_URL_PREFIX;
  }
  if (host.includes("://")) {
    return host;
  }
  const base = new URL(DEFAULT_PRICE_URL_PREFIX);
  return `${base.protocol}//${host}${base.pathname}`;
}

/** 单值转数值:数字原样,字符串非空且可解析才返回,其余一律 null。 */
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

/** updatedAt(ISO 串)→ unix 秒;缺失 / 非法 → null。 */
function toUnixSeconds(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }
  const milliseconds = Date.parse(raw);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
}

/**
 * 单标的快照(现货金)。
 * @param inst 仅 goldApiSymbol 非空的标的
 * @param host 调度器轮换出的域名 / 完整 URL 前缀;缺省用源内默认前缀
 */
export async function fetchQuote(inst: InstrumentConfig, host?: string): Promise<Quote> {
  const symbol = inst.goldApiSymbol;
  if (symbol === undefined || symbol === "") {
    throw new MarketError("gold-api", `${inst.name} 无 gold-api 符号(该源仅支持现货金)`);
  }
  const payload = await fetchJson(`${resolveUrlPrefix(host)}${symbol}`);
  const body =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  return {
    instrumentId: inst.id,
    // 缺 price 视为无数据(price 为 0 是合法行情,normalize 只认「缺失 / 非法」为 null)。
    price: toNumber(body.price),
    change: null,
    changePct: null,
    amplitudePct: null,
    open: null,
    high: null,
    low: null,
    prevClose: null,
    volume: null,
    amount: null,
    time: toUnixSeconds(body.updatedAt),
    source: "gold-api"
  };
}
