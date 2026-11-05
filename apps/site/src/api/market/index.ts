// 行情数据 facade:页面只需调用这里的三个能力(getQuotes / getKlines / getTrends),
// 兜底链、缺失态与埋点都收口在本文件。
//
// 兜底链(每步「失败」或「无数据」都进下一步;东财/腾讯/gold-api 的真实请求一律经
// scheduler.schedule,见 throttle.ts;server 转发源请求同源 /api,不经调度器、直接调用):
//   getQuotes  server 转发(全部标的批量一次)→ 东财直连批量(一次请求所有 secid)
//              → 腾讯批量快照 → gold-api
//   getKlines  server 转发(所有标的)→ 东财直连 → 腾讯(仅缺失且有非 hf_ 的 tencentCode)
//              → 黄金标的专属兜底:au9999 → SGE 上金所官网日线(sources/sge.ts,周/月由
//              客户端聚合);xau/gc → PAXG 代币化黄金(binance.vision,sources/binance-vision.ts,
//              近似报价)→ 抛 MarketError
//   getTrends  server 转发(所有标的,含伦敦金/COMEX 的 hf_ 外盘——server 端照请求东财
//              trends2)→ 东财直连 → 腾讯(同上)→ 抛 MarketError
//
// server 转发源(sources/server.ts)是主源:Go server(/api/site/market/*)带浏览器头请求
// 东财并原样透传上游 JSON,带 TTL 缓存;浏览器直连被东财 WAF 限流时由服务器出口 IP 代取。
// 静态托管(GitHub Pages)下这些路径 404,源内会话级禁用快速跳过、整链回退直连源;
// 手动选源(东方财富/腾讯)语义不变,不经过 server 源。
//
// 东财域名池按端点分两组(快照走实时行情域 push2,K 线 / 分时走历史行情域 push2his),仅保留
// 直连域名:本机 / 部分网络对 eastmoney 全域不可达(HTTP 000)的场景由 server 转发主源承接,
// 曾经垫底的公共 CORS 代理传输层已整体移除(公共免费服务可用性不由本仓库保证,2026-10-09 实测
// 候选全部不可用,见 docs/site.md)。auto 链的 retries = 直连域名池长度 - 1,池内每个域名各试一次。
//
// 缺失语义:price 为 0 是合法行情,只有「无记录或 price 为 null」才算缺;最终仍缺的标的返回
// null 化占位 Quote(nullQuote),调用方按 price === null 判定并渲染「--」。
//
// 数据源选择(三个函数的 options.source):
// - 缺省 / "auto":维持上面的兜底链;
// - "eastmoney" / "tencent":只请求指定源、不兜底——getQuotes 该标的 null 化占位并上报
//   market_data_error,getKlines / getTrends 抛 MarketError;指定 tencent 时,无 tencentCode 或
//   hf_ 外盘代码的标的直接不可用(quotes 跳过请求,K 线 / 分时抛错);指定 eastmoney 时只用
//   直连域名池;
// - 指定源模式不会发生回退,故不发 market_source_fallback(仍发最终失败埋点)。
//
// 埋点:回退一次上报一次 market_source_fallback,最终无数据上报 market_data_error(事件定义见
// src/config/tracking-events.ts);埋点失败静默,不影响取数。
import { track } from "../../tracking";
import { DEFAULT_KLINE_LIMIT } from "./config";
import * as binanceVision from "./sources/binance-vision";
import * as eastmoney from "./sources/eastmoney";
import * as goldApi from "./sources/gold-api";
import * as server from "./sources/server";
import * as sge from "./sources/sge";
import * as tencent from "./sources/tencent";
import { createMarketScheduler } from "./throttle";
import type { ScheduleOptions } from "./throttle";
import { MarketError } from "./types";
import type {
  InstrumentConfig,
  KlinePage,
  KlinePeriod,
  KlineRange,
  MarketQueryOptions,
  MarketSource,
  Quote,
  TrendDays,
  TrendSet
} from "./types";

/** 埋点 kind:兜底与失败事件按能力区分。 */
export type MarketDataKind = "quote" | "kline" | "trends";

export type EastmoneySource = typeof eastmoney;
export type TencentSource = typeof tencent;
export type GoldApiSource = typeof goldApi;
export type ServerSource = typeof server;
export type BinanceVisionSource = typeof binanceVision;
export type SgeSource = typeof sge;

/** 源注入点(单测用):按需替换某个源模块的函数,未提供者仍走真实实现。 */
export interface SourceOverrides {
  eastmoney?: Partial<EastmoneySource>;
  tencent?: Partial<TencentSource>;
  goldApi?: Partial<GoldApiSource>;
  server?: Partial<ServerSource>;
  binanceVision?: Partial<BinanceVisionSource>;
  sge?: Partial<SgeSource>;
}

// 重试时轮换的域名池(东财连续快发会被限流,HTTP 000 约 40–60s 恢复;轮换降低同域名再次被限流的概率):
// 直连域名按端点分两组(快照 push2 / K 线·分时 push2his);东财全域不可达的场景由 server 转发
// 主源承接,不再有公共 CORS 代理传输层(已整体移除,见文件头与 docs/site.md)。
const EASTMONEY_DIRECT_QUOTE_HOSTS = ["push2.eastmoney.com", "82.push2.eastmoney.com"];
const EASTMONEY_DIRECT_HIS_HOSTS = ["push2his.eastmoney.com", "82.push2his.eastmoney.com"];
const TENCENT_HOSTS = ["qt.gtimg.cn", "web.ifzq.gtimg.cn"];
const GOLD_API_HOSTS = ["api.gold-api.com"];

// 失败文案里的周期人话标签(埋点 message 与 MarketError.message 共用)。
const KLINE_PERIOD_LABELS: Record<KlinePeriod, string> = { day: "日", week: "周", month: "月" };

// 进程内单例调度器:同页多个卡片并发取数时共享同一并发闸门(同时最多 2 个请求在飞)。
const scheduler = createMarketScheduler({ concurrency: 2 });

function resolveSources(overrides?: SourceOverrides): {
  eastmoney: EastmoneySource;
  tencent: TencentSource;
  goldApi: GoldApiSource;
  server: ServerSource;
  binanceVision: BinanceVisionSource;
  sge: SgeSource;
} {
  return {
    eastmoney: { ...eastmoney, ...overrides?.eastmoney },
    tencent: { ...tencent, ...overrides?.tencent },
    goldApi: { ...goldApi, ...overrides?.goldApi },
    server: { ...server, ...overrides?.server },
    binanceVision: { ...binanceVision, ...overrides?.binanceVision },
    sge: { ...sge, ...overrides?.sge }
  };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** auto 链的东财直连域名池调度参数:池内每个域名各试一次(retries = 池长 - 1)。 */
function eastmoneyPoolOptions(hosts: string[]): ScheduleOptions {
  return { hosts, retries: hosts.length - 1 };
}

/** 是否拿到有效行情:无记录或 price 为 null 都算缺(price 为 0 合法)。 */
function hasQuote(quote: Quote | undefined): quote is Quote {
  return quote !== undefined && quote.price !== null;
}

function collectQuotes(target: Map<string, Quote>, batch: Quote[]): void {
  for (const quote of batch) {
    if (hasQuote(quote)) {
      target.set(quote.instrumentId, quote);
    }
  }
}

/** 入参中仍未取到行情的标的(保持入参顺序)。 */
function missingInstruments(
  insts: InstrumentConfig[],
  collected: Map<string, Quote>
): InstrumentConfig[] {
  return insts.filter((inst) => !hasQuote(collected.get(inst.id)));
}

/**
 * 该标的后三级(东财直连/腾讯/gold-api)中实际会尝试的最后一个来源(用于失败埋点与错误归属)。
 * auto 链首站是 server 转发源,但 Quote.source 与最终错误归属仍取后三级口径
 * (server 只是传输层,数据上游仍是东财,见 sources/server.ts)。
 */
function lastAttemptedSource(inst: InstrumentConfig): MarketSource {
  if (inst.goldApiSymbol !== undefined) {
    return "gold-api";
  }
  if (inst.tencentCode !== undefined) {
    return "tencent";
  }
  return "eastmoney";
}

/** K 线/分时能否回落腾讯:需有 tencentCode 且非 hf_ 外盘(腾讯 K 线/分时仅支持内盘代码)。 */
function canUseTencentKlineOrTrends(inst: InstrumentConfig): boolean {
  return inst.tencentCode !== undefined && !inst.tencentCode.startsWith("hf_");
}

/** 缺失标的的 null 化占位:除 id/source 外全 null,顺序与入参对齐(见 types.ts 的 Quote 注释)。 */
function nullQuote(inst: InstrumentConfig, source: MarketSource): Quote {
  return {
    instrumentId: inst.id,
    price: null,
    change: null,
    changePct: null,
    amplitudePct: null,
    open: null,
    high: null,
    low: null,
    prevClose: null,
    volume: null,
    amount: null,
    time: null,
    source
  };
}

/** 源返回的 K 线页转 facade 输出:空 bars 视为无数据(返回 null 让调用方继续兜底);
 *  范围查询(beg 存在)没有分页语义,hasMore 恒 false,也不按「条数 === limit」重新判定;
 *  source 透传(UI 据此渲染近似标注,缺省视为 eastmoney,见 types.ts 的 KlinePage.source)。 */
function toKlinePage(page: KlinePage, limit: number, ranged: boolean): KlinePage | null {
  if (page.bars.length === 0) {
    return null;
  }
  if (ranged) {
    return { bars: page.bars, hasMore: false, source: page.source };
  }
  return { bars: page.bars, hasMore: page.bars.length === limit, source: page.source };
}

/** 缺失标的收尾:已取到的原样返回;仍缺的 null 化占位并上报 market_data_error(sourceOf 给出归属来源)。 */
function finalizeQuotes(
  insts: InstrumentConfig[],
  collected: Map<string, Quote>,
  sourceOf: (inst: InstrumentConfig) => MarketSource
): Quote[] {
  return insts.map((inst) => {
    const quote = collected.get(inst.id);
    if (quote !== undefined) {
      return quote;
    }
    const source = sourceOf(inst);
    reportDataError(inst, "quote", source, `${inst.name} 行情获取失败(最后尝试来源:${source})`);
    return nullQuote(inst, source);
  });
}

/** 回退埋点:每回退一级上报一条(kind 标明能力,from → to 标明方向;from/to 为来源标签,
 *  含 "server" 这类非 Quote.source 的传输层来源,故用 string 而非 MarketSource)。 */
function reportFallback(
  inst: InstrumentConfig,
  kind: MarketDataKind,
  from: string,
  to: string
): void {
  track("market_source_fallback", { instrument_id: inst.id, kind, from, to });
}

/** 最终失败埋点:兜底链走完仍无数据时上报(message 为人话失败摘要)。
 *  source 为来源标签字符串:除 MarketSource 外,黄金 K 线专属兜底还会落到
 *  "sge"(上金所)与 "binance-vision"(PAXG),埋点载荷口径是 string(见 tracking-events.ts)。 */
function reportDataError(
  inst: InstrumentConfig,
  kind: MarketDataKind,
  source: string,
  message: string
): void {
  track("market_data_error", { instrument_id: inst.id, kind, source, message });
}

/**
 * 批量快照(兜底链:server 转发 → 东财直连 → 腾讯 → gold-api;options.source 指定单源时不兜底)。
 * @param options source="eastmoney" | "tencent" 只走指定源;缺省 / "auto" 走完整兜底链
 * @returns 与 insts 等长、顺序一致的 Quote[];仍缺的标的为 null 化占位(price === null)
 */
export async function getQuotes(
  insts: InstrumentConfig[],
  options?: MarketQueryOptions,
  overrides?: SourceOverrides
): Promise<Quote[]> {
  if (insts.length === 0) {
    return [];
  }
  const sources = resolveSources(overrides);
  const mode = options?.source ?? "auto";
  const collected = new Map<string, Quote>();

  // 指定东财:只发一次批量请求,失败 / 缺失即 null 化(无兜底);只用直连域名池,不试代理。
  if (mode === "eastmoney") {
    try {
      const batch = await scheduler.schedule((host) => sources.eastmoney.fetchQuotes(insts, host), {
        hosts: EASTMONEY_DIRECT_QUOTE_HOSTS
      });
      collectQuotes(collected, batch);
    } catch {
      // 指定源模式没有兜底:缺失标的最末统一 null 化。
    }
    return finalizeQuotes(insts, collected, () => "eastmoney");
  }

  // 指定腾讯:只请求有 tencentCode 的标的(无代码的标的连请求都无法发,直接 null 化)。
  if (mode === "tencent") {
    const targets = insts.filter((inst) => inst.tencentCode !== undefined);
    if (targets.length > 0) {
      try {
        const batch = await scheduler.schedule(
          (host) => sources.tencent.fetchQuotes(targets, host),
          { hosts: TENCENT_HOSTS }
        );
        collectQuotes(collected, batch);
      } catch {
        // 同上:指定源模式失败即缺失。
      }
    }
    return finalizeQuotes(insts, collected, () => "tencent");
  }

  // 以下为 auto 兜底链(server 优先,静态托管下回退直连源)。
  // 第 1 步:server 转发源(全部标的批量一次;请求同源 /api,Go server 带浏览器头 + TTL 缓存
  // 代取东财,不经东财域名轮换调度器,client.ts 自带超时与 GET 重试)。静态托管 404 / server
  // 离线时源内会话级禁用、快速跳过;上游被东财限流(5xx)不禁用、当次失败进直连链。
  try {
    const batch = await sources.server.fetchQuotes(insts);
    collectQuotes(collected, batch);
  } catch {
    // server 不可用(禁用 / 离线 / 5xx):进东财直连。
  }

  // 第 2 步:东财直连批量快照(单请求覆盖全部缺失 secid;直连域名池轮换见域名池注释);
  // 整体失败则所有标的一起进下一级。
  const eastTargets = missingInstruments(insts, collected);
  if (eastTargets.length > 0) {
    for (const inst of eastTargets) {
      reportFallback(inst, "quote", "server", "eastmoney");
    }
    try {
      const batch = await scheduler.schedule(
        (host) => sources.eastmoney.fetchQuotes(eastTargets, host),
        eastmoneyPoolOptions(EASTMONEY_DIRECT_QUOTE_HOSTS)
      );
      collectQuotes(collected, batch);
    } catch {
      // 东财不可用(限流/网络):进腾讯 / gold-api,缺失标的最末统一 null 化。
    }
  }

  // 第 3 步:腾讯批量快照(仅东财缺失且有 tencentCode 的标的)。
  const tencentTargets = missingInstruments(insts, collected).filter(
    (inst) => inst.tencentCode !== undefined
  );
  if (tencentTargets.length > 0) {
    for (const inst of tencentTargets) {
      reportFallback(inst, "quote", "eastmoney", "tencent");
    }
    try {
      const batch = await scheduler.schedule(
        (host) => sources.tencent.fetchQuotes(tencentTargets, host),
        { hosts: TENCENT_HOSTS }
      );
      collectQuotes(collected, batch);
    } catch {
      // 腾讯不可用:进 gold-api / null 化。
    }
  }

  // 第 4 步:gold-api 逐标的兜底(仅缺失且配了 goldApiSymbol 的标的)。
  const goldTargets = missingInstruments(insts, collected).filter(
    (inst) => inst.goldApiSymbol !== undefined
  );
  for (const inst of goldTargets) {
    reportFallback(inst, "quote", tencentTargets.length > 0 ? "tencent" : "eastmoney", "gold-api");
    try {
      const quote = await scheduler.schedule((host) => sources.goldApi.fetchQuote(inst, host), {
        hosts: GOLD_API_HOSTS
      });
      if (hasQuote(quote)) {
        collected.set(inst.id, quote);
      }
    } catch {
      // 兜底也失败:落到 null 化占位。
    }
  }

  // 输出顺序与入参严格对齐;仍未取到的标的 null 化并上报数据错误。
  return finalizeQuotes(insts, collected, lastAttemptedSource);
}

/**
 * 日/周/月 K 线(兜底链:server 转发 → 东财直连 → 腾讯 → 黄金标的专属兜底
 * (au9999 → 上金所 / xau·gc → PAXG);都没有则抛 MarketError)。
 * @param range beg=YYYYMMDD 时按 [beg, end] 范围取数(不按 limit 截断、hasMore 恒 false);
 *              否则 end=YYYYMMDD(含当日)、limit 缺省 200、hasMore 由「条数 === limit」判定
 * @param options source="eastmoney" | "tencent" 只走指定源(不兜底,专属兜底源不暴露给
 *                选择器);缺省 / "auto" 走完整兜底链
 */
export async function getKlines(
  inst: InstrumentConfig,
  period: KlinePeriod,
  range: KlineRange,
  options?: MarketQueryOptions,
  overrides?: SourceOverrides
): Promise<KlinePage> {
  const sources = resolveSources(overrides);
  const mode = options?.source ?? "auto";
  const limit = range.limit ?? DEFAULT_KLINE_LIMIT;
  const ranged = range.beg !== undefined && range.beg.length > 0;
  const failures: string[] = [];

  // 指定单源:只请求该源,失败 / 无数据即抛错(无兜底)。
  if (mode !== "auto") {
    // 腾讯 K 线仅支持内盘指数代码:无 tencentCode / hf_ 外盘直接不可用,不发请求。
    if (mode === "tencent" && !canUseTencentKlineOrTrends(inst)) {
      const message = `${inst.name}${KLINE_PERIOD_LABELS[period]} K 线获取失败(腾讯仅支持内盘指数代码)`;
      reportDataError(inst, "kline", "tencent", message);
      throw new MarketError("tencent", message);
    }
    const label = mode === "eastmoney" ? "东财" : "腾讯";
    try {
      const page = await scheduler.schedule(
        mode === "eastmoney"
          ? (host) => sources.eastmoney.fetchKlines(inst, period, range, host)
          : (host) => sources.tencent.fetchKlines(inst, period, range, host),
        { hosts: mode === "eastmoney" ? EASTMONEY_DIRECT_HIS_HOSTS : TENCENT_HOSTS }
      );
      const result = toKlinePage(page, limit, ranged);
      if (result !== null) {
        return result;
      }
      failures.push(`${label}无数据`);
    } catch (error) {
      failures.push(`${label}:${readErrorMessage(error)}`);
    }
    const message = `${inst.name}${KLINE_PERIOD_LABELS[period]} K 线获取失败(${failures.join(";")})`;
    reportDataError(inst, "kline", mode, message);
    throw new MarketError(mode, message);
  }

  // 第 1 步:server 转发源(所有标的,含 hf_ 外盘;请求同源 /api,不经东财域名轮换调度器)。
  // 静态托管 404 / server 离线时源内会话级禁用、快速跳过;5xx 当次失败穿透到直连;
  // 错误摘要并入最终 MarketError。
  try {
    const page = await sources.server.fetchKlines(inst, period, range);
    const result = toKlinePage(page, limit, ranged);
    if (result !== null) {
      return result;
    }
    failures.push("server 转发无数据");
  } catch (error) {
    failures.push(`server 转发:${readErrorMessage(error)}`);
  }

  // 第 2 步:东财直连(push2his 域名池轮换,见域名池注释)。
  reportFallback(inst, "kline", "server", "eastmoney");
  try {
    const page = await scheduler.schedule(
      (host) => sources.eastmoney.fetchKlines(inst, period, range, host),
      eastmoneyPoolOptions(EASTMONEY_DIRECT_HIS_HOSTS)
    );
    const result = toKlinePage(page, limit, ranged);
    if (result !== null) {
      return result;
    }
    failures.push("东财无数据");
  } catch (error) {
    failures.push(`东财:${readErrorMessage(error)}`);
  }

  // 第 3 步:腾讯(仅非 hf_ 外盘)。
  if (canUseTencentKlineOrTrends(inst)) {
    reportFallback(inst, "kline", "eastmoney", "tencent");
    try {
      const page = await scheduler.schedule(
        (host) => sources.tencent.fetchKlines(inst, period, range, host),
        { hosts: TENCENT_HOSTS }
      );
      const result = toKlinePage(page, limit, ranged);
      if (result !== null) {
        return result;
      }
      failures.push("腾讯无数据");
    } catch (error) {
      failures.push(`腾讯:${readErrorMessage(error)}`);
    }
  }

  // 第 4 步:黄金标的的专属兜底(指数链路到此为止,直接收口):
  // - au9999(上金所现货)→ SGE 官网日线:精确同标的、权威,server 契约端点直调
  //   (不经东财调度器);仅日 K,周/月由源内客户端聚合,无量额口径;
  // - xau/gc(伦敦金/COMEX 期金)→ PAXG 代币化黄金:binance.vision 浏览器直连,
  //   跟踪国际金价的近似报价(与现货 ~0.15% / 期金 ~0.6% 偏差,UI 有近似标注)。
  // 两者都在东财两步(腾讯对黄金不可用)之后兜底;从哪一步回退而来按「上一个实际尝试的来源」记。
  const lastAttemptedKlineSource = canUseTencentKlineOrTrends(inst) ? "tencent" : "eastmoney";
  if (sources.sge.sgeInstIdFor(inst) !== undefined) {
    reportFallback(inst, "kline", lastAttemptedKlineSource, "sge");
    try {
      const page = await sources.sge.fetchKlines(inst, period, range);
      const result = toKlinePage(page, limit, ranged);
      if (result !== null) {
        return result;
      }
      failures.push("上金所无数据");
    } catch (error) {
      failures.push(`上金所:${readErrorMessage(error)}`);
    }
  }
  if (sources.binanceVision.supportsPaxg(inst)) {
    reportFallback(inst, "kline", lastAttemptedKlineSource, "paxg");
    try {
      const page = await sources.binanceVision.fetchKlines(inst, period, range);
      const result = toKlinePage(page, limit, ranged);
      if (result !== null) {
        return result;
      }
      failures.push("PAXG 无数据");
    } catch (error) {
      failures.push(`PAXG:${readErrorMessage(error)}`);
    }
  }

  // 最终归属:最后一个实际尝试的来源(黄金标的为专属兜底源,指数维持原口径)。
  const source: string = sources.binanceVision.supportsPaxg(inst)
    ? "binance-vision"
    : sources.sge.sgeInstIdFor(inst) !== undefined
      ? "sge"
      : lastAttemptedKlineSource;
  const message = `${inst.name}${KLINE_PERIOD_LABELS[period]} K 线获取失败(${failures.join(";")})`;
  reportDataError(inst, "kline", source, message);
  throw new MarketError(source, message);
}

/**
 * 分时(兜底链:server 转发 → 东财直连 → 腾讯;都没有则抛 MarketError)。
 * 伦敦金(xau)/COMEX(gc)是 hf_ 外盘、无腾讯分时,但主源 server 转发可直取
 * (server 端照请求东财 trends2);全链失败后由 UI 显示「该周期暂无数据」。
 * @param ndays 1=当日分时,5=五日分时
 * @param options source="eastmoney" | "tencent" 只走指定源(不兜底);缺省 / "auto" 走完整兜底链
 */
export async function getTrends(
  inst: InstrumentConfig,
  ndays: TrendDays,
  options?: MarketQueryOptions,
  overrides?: SourceOverrides
): Promise<TrendSet> {
  const sources = resolveSources(overrides);
  const mode = options?.source ?? "auto";
  const labels = ndays === 1 ? "当日" : "五日";
  const failures: string[] = [];

  // 指定单源:只请求该源,失败 / 无数据即抛错(无兜底)。
  if (mode !== "auto") {
    // 腾讯分时仅支持内盘指数代码:无 tencentCode / hf_ 外盘直接不可用,不发请求。
    if (mode === "tencent" && !canUseTencentKlineOrTrends(inst)) {
      const message = `${inst.name}${labels}分时获取失败(腾讯仅支持内盘指数代码)`;
      reportDataError(inst, "trends", "tencent", message);
      throw new MarketError("tencent", message);
    }
    const label = mode === "eastmoney" ? "东财" : "腾讯";
    try {
      const trends = await scheduler.schedule(
        mode === "eastmoney"
          ? (host) => sources.eastmoney.fetchTrends(inst, ndays, host)
          : (host) => sources.tencent.fetchTrends(inst, ndays, host),
        { hosts: mode === "eastmoney" ? EASTMONEY_DIRECT_HIS_HOSTS : TENCENT_HOSTS }
      );
      if (trends.points.length > 0) {
        return trends;
      }
      failures.push(`${label}无数据`);
    } catch (error) {
      failures.push(`${label}:${readErrorMessage(error)}`);
    }
    const message = `${inst.name}${labels}分时获取失败(${failures.join(";")})`;
    reportDataError(inst, "trends", mode, message);
    throw new MarketError(mode, message);
  }

  // 第 1 步:server 转发源(所有标的,含伦敦金/COMEX 的 hf_ 外盘;请求同源 /api,
  // 不经东财域名轮换调度器)。静态托管 404 / server 离线时源内会话级禁用、快速跳过;
  // 5xx 当次失败穿透到直连;错误摘要并入最终 MarketError。
  try {
    const trends = await sources.server.fetchTrends(inst, ndays);
    if (trends.points.length > 0) {
      return trends;
    }
    failures.push("server 转发无数据");
  } catch (error) {
    failures.push(`server 转发:${readErrorMessage(error)}`);
  }

  // 第 2 步:东财直连(push2his 域名池轮换,见域名池注释)。
  reportFallback(inst, "trends", "server", "eastmoney");
  try {
    const trends = await scheduler.schedule(
      (host) => sources.eastmoney.fetchTrends(inst, ndays, host),
      eastmoneyPoolOptions(EASTMONEY_DIRECT_HIS_HOSTS)
    );
    if (trends.points.length > 0) {
      return trends;
    }
    failures.push("东财无数据");
  } catch (error) {
    failures.push(`东财:${readErrorMessage(error)}`);
  }

  // 第 3 步:腾讯(仅非 hf_ 外盘)。
  if (canUseTencentKlineOrTrends(inst)) {
    reportFallback(inst, "trends", "eastmoney", "tencent");
    try {
      const trends = await scheduler.schedule(
        (host) => sources.tencent.fetchTrends(inst, ndays, host),
        { hosts: TENCENT_HOSTS }
      );
      if (trends.points.length > 0) {
        return trends;
      }
      failures.push("腾讯无数据");
    } catch (error) {
      failures.push(`腾讯:${readErrorMessage(error)}`);
    }
  }

  const source: MarketSource = canUseTencentKlineOrTrends(inst) ? "tencent" : "eastmoney";
  const message = `${inst.name}${labels}分时获取失败(${failures.join(";")})`;
  reportDataError(inst, "trends", source, message);
  throw new MarketError(source, message);
}
