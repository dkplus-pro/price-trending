// 行情数据层:纯静态行情页(黄金价格/国内指数)的契约与骨架。
//
// 目录职责与豁免说明(根 AGENTS.md §19 / apps/site/AGENTS.md §2「服务端数据走路由 loader」的
// 适用边界):
// - 该约束约束的是本仓库 server 契约数据(openapi/site.yaml 生成物);本目录数据来自
//   东财 / 腾讯 / gold-api 的公开只读行情接口,由浏览器直连,不经过本仓库 server;
// - 纯静态部署(SITE_STATIC_EXPORT=true)下没有服务端,loader 无法承载(且行情需客户端轮询刷新),
//   故此处按客户端 useRequest + 轮询取数,不走 loader;
// - 因此本模块不进 orval 管线、不改 openapi/site.yaml、不使用 src/api/client.ts(契约 mutator),
//   网络统一用原生 fetch(腾讯快照为 GBK 编码,按 arrayBuffer 解码后交给 TextDecoder)。
//
// 分层与依赖方向(types ← config / utils / throttle ← sources ← index):
//   types.ts     契约类型(本卡冻结:Wave 1 各源实现按此对齐)
//   config.ts    六标的静态配置(INSTRUMENTS)+ 分组 id 常量 + K 线默认条数
//   utils.ts     纯格式化 / 计算函数(无副作用,全部可单测)
//   throttle.ts  并发闸门 + 域名轮换 + 退避重试 + 带超时的原生 fetch 封装
//   sources/*    各第三方源的取数实现(Wave 1 只填充函数体,签名不得改动)
//   index.ts     facade:能力别名 / 兜底链 / 缺失态 / 埋点

/** 图表周期:分时(1 日)/ 五日分时 / 日 K / 周 K / 月 K。 */
export type ChartPeriod = "minute" | "fiveday" | "day" | "week" | "month";

/** K 线周期(ChartPeriod 中走 K 线接口的三档;分时两档走 getTrends)。 */
export type KlinePeriod = Extract<ChartPeriod, "day" | "week" | "month">;

/** 分时天数:1 日 / 5 日。 */
export type TrendDays = 1 | 5;

/** 标的大类:黄金 / 国内指数(UI 分组与「全部/黄金/指数」筛选用)。 */
export type InstrumentCategory = "gold" | "index";

/** 行情来源标识(Quote.source 与埋点字段共用)。 */
export type MarketSource = "eastmoney" | "tencent" | "gold-api";

/**
 * 可被用户显式选择的数据源名(数据源选择器用);
 * gold-api 仅 auto 兜底链内部使用,不暴露给选择器。
 */
export type MarketSourceName = "eastmoney" | "tencent";

/**
 * 取数选项:source 缺省 / "auto" 走 facade 兜底链,指定源则只请求该源(失败不兜底,
 * 各能力的降级形态见 index.ts 头部注释)。
 */
export interface MarketQueryOptions {
  source?: MarketSourceName | "auto";
}

/** 单一标的全量静态配置:新增标的只改 config.ts 的 INSTRUMENTS(见该文件扩展约定)。 */
export interface InstrumentConfig {
  /** 稳定标识:"au9999" | "xau" | "gc" | "sh000001" | "sz399006" | "sh000688"。 */
  id: string;
  /** 展示名(如「黄金9999」)。 */
  name: string;
  category: InstrumentCategory;
  /** 东财 secid(如 "118.AU9999")。 */
  secid: string;
  /**
   * 腾讯代码(如 "hf_XAU" / "sh000001");
   * hf_ 前缀的是外盘:快照响应体为逗号分隔(非 v_ 变量赋值),由适配器按前缀推导解析方式。
   */
  tencentCode?: string;
  /** gold-api 符号(仅 "XAU" 使用;其余标的无此兜底源)。 */
  goldApiSymbol?: string;
  /** 价格小数位。 */
  priceDecimals: number;
  /** 是否有量(图表量柱 + 统计行成交量)。 */
  hasVolume: boolean;
  /** 是否有成交额(统计行成交额;外盘/期金无)。 */
  hasAmount: boolean;
  /** 成交量单位;缺省则不标注单位。 */
  volumeUnit?: string;
  /** 分时均价线(指数 true;黄金/外盘 false)。 */
  hasAvgLine: boolean;
  /** 交易时段提示(UI 角标用)。 */
  sessionHint?: string;
}

/**
 * 单标的实时快照。
 * 缺失语义:price 为 null 表示该标的本轮没取到行情(price 为 0 是合法行情,不视为缺失);
 * 其余字段任一来源未提供即为 null。
 */
export interface Quote {
  instrumentId: string;
  /** 最新价;null = 本轮未取到(见 facade 的 null 化占位)。 */
  price: number | null;
  /** 涨跌额。 */
  change: number | null;
  /** 涨跌幅(%)。 */
  changePct: number | null;
  /** 振幅(%)。 */
  amplitudePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  /** 昨收。 */
  prevClose: number | null;
  volume: number | null;
  amount: number | null;
  /** 行情时间(unix 秒)。 */
  time: number | null;
  /** 实际取到该行情的来源。 */
  source: MarketSource;
}

/** 单根 K 线;time 为源返回的日期串(东财 "YYYY-MM-DD HH:mm" / 腾讯 "YYYY-MM-DD")。 */
export interface KlineBar {
  time: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number | null;
  amount: number | null;
  /** 该根振幅(%):东财取源第 8 段,腾讯按前收推导;取不到为 null。 */
  amplitudePct: number | null;
}

/** 分时点(1 日 / 5 日);avgPrice 为均价线(标的 hasAvgLine 为 false 时恒 null)。 */
export interface TrendPoint {
  time: string;
  price: number;
  avgPrice: number | null;
  volume: number | null;
  /** 分钟级 OHLC 的开 / 高 / 低(price 即收);源未提供为 null。 */
  open: number | null;
  high: number | null;
  low: number | null;
}

/**
 * K 线分页入参:end=YYYYMMDD(含当日),缺省为今天;limit 默认 200。
 * beg 存在即「范围查询」:源按 [beg, end] 区间取数、不按「最近 limit 根」截断,hasMore 恒 false。
 */
export interface KlineRange {
  /** 范围查询起点(含当日,YYYYMMDD);缺省 / 空串 = 不启用范围查询。 */
  beg?: string;
  /** 末条 K 线的日期(含当日);缺省由源取今天。 */
  end?: string;
  /** 单页条数;缺省 200(见 config.ts 的 DEFAULT_KLINE_LIMIT)。 */
  limit?: number;
}

/** K 线单页结果:hasMore 由「返回条数 === limit」判定。 */
export interface KlinePage {
  bars: KlineBar[];
  hasMore: boolean;
}

/** 分时结果集:points 按时间升序;prevClose 为分时基准昨收(源未提供为 null)。 */
export interface TrendSet {
  points: TrendPoint[];
  prevClose: number | null;
}

/** 行情层错误:source 标明最后失败/放弃的来源,便于埋点与界面诊断。 */
export class MarketError extends Error {
  /** 语义化来源名("eastmoney" | "tencent" | "gold-api" 或具体域名)。 */
  source: string;

  constructor(source: string, message: string) {
    super(message);
    this.name = "MarketError";
    this.source = source;
  }
}
