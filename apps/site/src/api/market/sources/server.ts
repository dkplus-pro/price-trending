// server 转发源(auto 链主源):经站点契约端点 GET /api/site/market/* 取数。
//
// 背景:浏览器直连东财(push2/push2his)会被东财 WAF 按出口 IP 配额限流(连接被直接断开),
// 故 site 行情请求优先经同源 /api 由部署环境的 Go server 转发——server 带浏览器头请求东财并
// 原样透传上游 JSON,带 TTL 缓存(quote 15s / kline·trends 60s)收敛对上游的低频请求。
// 仅 auto 链使用:手动选源(东方财富/腾讯)的语义是「只请求该指定源」,不经过本源;
// GitHub Pages 纯静态托管下 /api/site/market/* 一律 404,本源快速失败并禁用(见下方会话级
// 可用性记忆),auto 链随即回退东财直连 → 腾讯 → gold-api,静态托管下行情页仍可用。
//
// 实现约束:
// - 取数走 orval 生成物 MarketController(src/api/controllers.gen.ts):client.ts 已解
//   {code,message,data} 信封(拿到的即东财上游原始 JSON)、自带 10s 超时与幂等 GET 重试;
// - 与东财源签名对齐但**不含 host 参数**:本源请求同源 /api(浏览器走 Modern.js dev 代理 /
//   生产网关同域转发),没有域名轮换语义,也不经过东财域名调度器(facade 直接调用);
// - 拿到上游 JSON 后复用东财源导出的纯解析函数(parseQuotePayload / parseKlinePayload /
//   parseTrendsPayload)得到 Quote[] / KlinePage / TrendSet;Quote.source 仍记 "eastmoney"
//   ——数据上游就是东财,本源只是不同的传输层;
// - 参数语义与东财源对齐:quote 的 secids 按入参顺序逗号拼接(与 ulist 一致);kline 的
//   klt 101/102/103 映射、fqt=0(不复权,server 契约缺省是 1,必须显式传)、非范围查询
//   beg/end 不传(server 缺省 19700101/20991231,即东财 beg=0 + 取到最新的语义)、
//   lmt=limit;范围查询透传 beg/end、lmt 取契约上限 2000(直连源用 5000,超限会被
//   server 400;2000 与腾讯源区间取数上限同级);trends 透传 ndays。
//
// 会话级可用性记忆(模块级 unavailable,设计依据):
// - 404(静态托管无 server)或无 response 的网络错误(dev 代理指向的 server 未起 / 连接被拒,
//   含 client.ts 超时)在本会话内不可能自行恢复,置位后后续调用直接抛 MarketError 快速跳过,
//   不再打 controller,避免行情轮询(快照 15s / 分时 60s)反复空转;
// - 5xx(server 在、上游被东财限流,映射为 502)不禁用:上游限流可能恢复,下次轮询再试;
// - 成功保持 false;非 axios 错误(不该出现,防御性保留)不改变状态。
// 模块级状态跨用例共享,测试用 resetServerUnavailableForTests 重置。
import { isAxiosError } from "axios";
import { MarketController } from "../../controllers.gen";
import type { GetMarketKlineParams } from "../../generated/cMSSiteAPI.schemas";
import { DEFAULT_KLINE_LIMIT } from "../config";
import { MarketError } from "../types";
import { parseKlinePayload, parseQuotePayload, parseTrendsPayload } from "./eastmoney";
import type {
  InstrumentConfig,
  KlinePage,
  KlinePeriod,
  KlineRange,
  Quote,
  TrendDays,
  TrendSet
} from "../types";

/** K 线周期 → 东财 klt(与东财源的 KLT_BY_PERIOD 一致:101 日 / 102 周 / 103 月)。 */
const KLT_BY_PERIOD: Record<KlinePeriod, 101 | 102 | 103> = { day: 101, week: 102, month: 103 };

/** server 契约 lmt 上限(1..2000):范围查询与超上限 limit 在此收敛,超限会被 server 400。 */
const SERVER_KLINE_MAX_LMT = 2000;

/** 会话级可用性记忆:true 后本会话内不再请求(设计依据见文件头)。 */
let unavailable = false;

/** 测试钩子:重置会话级可用性记忆(模块级状态,跨用例共享)。 */
export function resetServerUnavailableForTests(): void {
  unavailable = false;
}

/** 快速跳过:本会话已判定 server 不可用(静态托管 / server 离线)。 */
function assertAvailable(): void {
  if (unavailable) {
    throw new MarketError("server", "server 转发源本会话不可用(静态托管或 server 离线),已跳过");
  }
}

/**
 * 失败分类置位:axios 错误且「无 response(网络错误/超时,server 不可达)」或「404
 * (静态托管无 server)」→ 本会话禁用;5xx(server 在、上游被限流)与其他状态不禁用
 * ——上游限流可能恢复,下次轮询再试。非 axios 错误不改变状态。
 */
function rememberFailure(error: unknown): void {
  if (!isAxiosError(error)) {
    return;
  }
  const status = error.response?.status;
  if (status === undefined || status === 404) {
    unavailable = true;
  }
}

/**
 * 批量快照(全部缺失标的批量一次;secids 与东财 ulist 同序拼接)。
 * 失败原样透传(client.ts 已带超时与 GET 重试),由 facade 决定兜底。
 */
export async function fetchQuotes(insts: InstrumentConfig[]): Promise<Quote[]> {
  if (insts.length === 0) {
    return [];
  }
  assertAvailable();
  const secids = insts.map((inst) => inst.secid).join(",");
  try {
    const payload = await MarketController.getMarketQuote({ secids });
    return parseQuotePayload(payload, insts);
  } catch (error) {
    rememberFailure(error);
    throw error;
  }
}

/**
 * 日/周/月 K 线(参数语义与东财源对齐,见文件头;解析复用 parseKlinePayload,
 * 保留「最近 limit 根」切片与 hasMore 判定,limit 用未收敛的原值与 facade 口径一致)。
 */
export async function fetchKlines(
  inst: InstrumentConfig,
  period: KlinePeriod,
  range: KlineRange
): Promise<KlinePage> {
  assertAvailable();
  const limit = range.limit ?? DEFAULT_KLINE_LIMIT;
  // 范围查询起点:beg 非空即启用(空串 / 缺省视为未启用,与东财源同判定)。
  const rangeBeg = range.beg === undefined || range.beg.length === 0 ? null : range.beg;
  const params: GetMarketKlineParams = {
    secid: inst.secid,
    klt: KLT_BY_PERIOD[period],
    fqt: 0,
    // 范围查询取「尽量多」(与东财直连源 RANGE_KLINE_LMT=5000 的意图一致,收敛到契约上限
    // 2000);非范围查询取「最近 limit 根」,同样收敛到上限(超限会被 server 400)。
    lmt: rangeBeg !== null ? SERVER_KLINE_MAX_LMT : Math.min(limit, SERVER_KLINE_MAX_LMT)
  };
  if (rangeBeg !== null) {
    params.beg = rangeBeg;
  }
  if (range.end !== undefined && range.end.length > 0) {
    params.end = range.end;
  }
  try {
    const payload = await MarketController.getMarketKline(params);
    return parseKlinePayload(payload, rangeBeg, limit);
  } catch (error) {
    rememberFailure(error);
    throw error;
  }
}

/**
 * 分时 / 五日走势(伦敦金 / COMEX 等 hf_ 外盘也能走:server 端照请求东财 trends2)。
 */
export async function fetchTrends(inst: InstrumentConfig, ndays: TrendDays): Promise<TrendSet> {
  assertAvailable();
  try {
    const payload = await MarketController.getMarketTrends({ secid: inst.secid, ndays });
    return parseTrendsPayload(payload);
  } catch (error) {
    rememberFailure(error);
    throw error;
  }
}
