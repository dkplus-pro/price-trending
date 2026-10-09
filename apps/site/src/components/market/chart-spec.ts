// 行情图表 G2 v5 spec 构造:纯函数(无副作用、不在运行时引入 @antv/g2,node 环境可直接单测)。
//
// 结构决策与官方依据(G2 v5 官方文档检索结论,检索入口见 antv-g2-chart 技能文档):
// - K 线 = view + children [link(影线, encode.y = [min, max]) + interval(实体, encode.y = [start, end])],
//   color 编码 trend 字段、scale.color 用 domain/range 映射涨红跌绿 —— 与官方 K-Chart (Candlestick)
//   Mark 示例同构,结构逐项对齐,不自创;
// - 主图 + 量柱副图 = spaceFlex(direction 'col', ratio [3, 1]),子图不写 width/height —— 官方 spaceFlex
//   文档明确「子图单独设置宽高会覆盖 spaceFlex 的自动布局」;两子图各自算 auto padding,量柱图无 y 轴时
//   左右绘图区会错位,故横向 padding 显式钉死同值(官方无跨子图对齐开关,这是可验证的最小解法);
// - 昨收参考线 = lineY 标注(data 为 [prevClose] 数值数组,style.strokeDasharray 画虚线)—— 官方标注文档;
// - 分时 x 用索引等距轴(数值 idx + linear nice:false):A 股午休(11:30→13:01)、AU9999 夜盘跨自然日、
//   伦敦金 05:15–06:00 休市缺口都由索引轴天然抹平,严禁按连续分钟推算 x 坐标。
//
// 十字光标与浮标(tooltip)官方依据(G2 5.4.8 源码 src/interaction/tooltip.ts + 官方 Tooltip 文档):
// - 十字准线只由 tooltip 交互的 series tooltip 分支渲染(标记为 crosshairs 的准线在 seriesTooltip 内
//   updateRuleX/updateRuleY 绘制),即「准线 + 就近取 x 的浮标」两个能力都要求该 view 走 series 路径:
//   官方判定 hasSeries = view 内存在「interaction.seriesTooltip 且 tooltip 为真」的 mark(line/area 类型
//   标记的默认 interaction 带 seriesTooltip),故 K 线的隐形收盘价载体线(见 buildKlineSpec)承担两点:
//   提供 series 路径入口 + 提供准线锚点(收盘价),分时则直接由价格线承担;
// - 官方字段名(源码 TooltipInteraction 类型 + seriesTooltip 解构):crosshairs(总开关)、
//   crosshairsX = 横向准线(默认 false)、crosshairsY = 纵向准线(默认 true);
// - 线色/线宽/线型用扁平样式键下发:crosshairsStroke / crosshairsLineWidth / crosshairsXLineDash /
//   crosshairsYLineDash —— 源码 subObject 按前缀匹配后合并进规则线 style(横纵可分别定制线型),
//   故「横虚线」= X 方向 dash [4,4],「竖实线」= Y 方向 dash 空数组(空数组必须显式给:不声明时
//   规则线 style 里没有 lineDash,G2 画布不会重置 dash 状态,竖线会沿用上一根线的虚线状态);
// - filter/sort 为 TooltipInteraction 的官方选项(seriesTooltip 内对 items 先排序再过滤):
//   filter 丢弃缺值行(分时缺分钟 OHLC / 振幅不可算),sort 固定行序;
// - 准线锚点 = 最近的 series 元素数据点(源码 updateRuleX 取 minDistPoint 的 y、updateRuleY 取选中点 x 均值),
//   故横向准线吸附到「该时刻离光标最近的那个系列点」(K 线为收盘价载体线,分时为价格线),
//   竖向准线落在当前 x 上,符合「横向虚线定 y、竖向实线定 x」。
import type { G2Spec, Mark, TooltipInteraction, ViewComposition } from "@antv/g2";

import type { KlineBar } from "../../api/market/types";
import { MISSING_TEXT, classifyTrend, formatUnsignedPct } from "../../api/market/utils";

/** tooltip 价格类数值:两位小数裁尾零(各标的小数位 1–2 位,统一按 2 位裁尾,如 4216.10→4216.1;避免 MA 均值出现 3912.6179999999963 这类浮点尾数)。 */
export function formatTickPrice(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** tooltip 回调行值:非有限数(理论上不出现——空值段已从线数据剔除;含测试探测传空对象的场景)显示占位符。 */
function formatTickValue(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? formatTickPrice(value)
    : MISSING_TEXT;
}

/**
 * tooltip 展示串预计算:空值原样透传 null(由 interaction filter 丢行),非空返回格式化串。
 * 不用 G2 的 valueFormatter 处理可空字段:5.4.8 在 extractTooltip 阶段(早于 filter)就调用
 * formatter,空值会先崩(formatTickPrice 的 toFixed)/或先变成占位符导致 filter 判据失效
 * (浏览器实测取证:腾讯分时缺分钟 OHLC 时整图空白 + 未捕获异常)。故浮标行改读预格式化字段。
 */
function tickOrNull(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? formatTickPrice(value) : null;
}

/** 振幅展示串预计算:语义同 tickOrNull(两位定点、不带符号)。 */
function pctOrNull(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? formatUnsignedPct(value) : null;
}

/** 涨跌方向(与 api/market/utils 的 classifyTrend 返回值一致;flat = 平盘或数据无效)。 */
export type TrendDirection = "up" | "down" | "flat";

/** MA 字段名(ma5 / ma10 / ma20;周期集合来自调用方传入的 maColors 键)。 */
export type MaField = `ma${number}`;

/** K 线数据行:影线/实体/量柱/均线共用一个 x 域(time),MA 字段按 `ma${period}` 展开。 */
export type KlineDatum = {
  time: string;
  start: number;
  max: number;
  min: number;
  end: number;
  trend: TrendDirection;
  volume: number | null;
  amount: number | null;
  /** 振幅(%):来自源字段,缺失为 null(浮标行由 filter 丢弃)。 */
  amplitudePct: number | null;
  /** 浮标展示串(预格式化;空值 null 由 filter 丢行,避免 G2 在 filter 前调用 formatter 崩溃)。 */
  openF: string | null;
  highF: string | null;
  lowF: string | null;
  amplitudeF: string | null;
} & Record<MaField, number | null>;

/** 分时数据行:idx 为窗口内等距索引,volumeTrend 供量柱上色;amplitudePct 由 high/low 与昨收现算。 */
export interface TrendDatum {
  idx: number;
  label: string;
  price: number;
  open: number | null;
  high: number | null;
  low: number | null;
  avgPrice: number | null;
  amplitudePct: number | null;
  volume: number | null;
  volumeTrend: TrendDirection;
  /** 浮标展示串(预格式化;空值 null 由 filter 丢行,理由同 KlineDatum)。 */
  openF: string | null;
  closeF: string | null;
  highF: string | null;
  lowF: string | null;
  amplitudeF: string | null;
}

/** 涨红跌绿(东财系配色)+ 平盘灰;组件按冻结入参把这些色值传进 spec 构造器。 */
export const UP_COLOR = "#ef232a";
export const DOWN_COLOR = "#14b143";
export const FLAT_COLOR = "#8c8c8c";
/** MA5/10/20 线色(对齐参考图:MA5 深灰 / MA10 金 / MA20 蓝紫);键即周期集合。 */
export const MA_COLORS: Record<number, string> = { 5: "#595959", 10: "#ffb400", 20: "#7c6cf6" };

/** 分时价格线颜色:按昨收上下分段上色在手机端噪声大(参考图为单线),故统一单色蓝。 */
export const TREND_PRICE_COLOR = "#165dff";
/** 分时均价线颜色(参考图 MA/均价线用金色)。 */
export const TREND_AVG_COLOR = "#ffb400";
/** 昨收参考线颜色(灰色虚线)。 */
export const PREV_CLOSE_COLOR = "#8c8c8c";
/** 分时量柱平盘色(首根无昨收可比较时用;冻结签名未开放 flatColor,故在此钉死中性灰)。 */
export const VOLUME_FLAT_COLOR = "#8c8c8c";

/** 横向留白:主图与量柱图同值,保证两图绘图区左右对齐(理由见文件头)。 */
const PLOT_PADDING_LEFT = 52;
const PLOT_PADDING_RIGHT = 32;
/** 主图与量柱图之间的间距。 */
const SUB_VIEW_GAP = 8;
/** 蜡烛/量柱占 band 宽度比例(0.4 → 实体占 60%,留出视觉间隙)。 */
const CANDLE_BAND_PADDING = 0.4;
const VOLUME_BAND_PADDING = 0.2;

/** 十字准线颜色(灰系,与参考图的定位线一致)。 */
export const CROSSHAIR_COLOR = "#86909c";
/** 十字准线线宽。 */
const CROSSHAIR_LINE_WIDTH = 1;
/** 横向准线虚线间隔;竖向准线用空数组显式声明实线(不显式声明会沿用画布上一次 dash 状态,依据见文件头)。 */
const CROSSHAIR_X_LINE_DASH = [4, 4];
const CROSSHAIR_Y_LINE_DASH: number[] = [];

/** tooltip 行:字段名 + 中文名(G2 自动用 mark 颜色作为行首色标)。
 * 行读的是数据行里预格式化好的展示串字段(*F):空值为 null,由 interaction filter 丢行。 */
type TooltipRow = { field: string; name: string };

/** K 线 tooltip 行(挂在实体 mark;收盘价由隐形载体线提供,振幅取源字段)。 */
const KLINE_PRICE_ROWS: TooltipRow[] = [
  { field: "openF", name: "开盘" },
  { field: "highF", name: "最高" },
  { field: "lowF", name: "最低" },
  { field: "amplitudeF", name: "振幅" }
];

/** 分时 tooltip 行(挂在价格线 mark;open/high/low 为 null 的行由 filter 丢弃)。 */
const TREND_PRICE_ROWS: TooltipRow[] = [
  { field: "openF", name: "开盘" },
  { field: "closeF", name: "收盘" },
  { field: "highF", name: "最高" },
  { field: "lowF", name: "最低" },
  { field: "amplitudeF", name: "振幅" }
];

/** K 线 tooltip 行序(开盘 → 收盘 → 最高 → 最低 → 振幅;未列出的行排在末尾)。 */
const KLINE_TOOLTIP_ORDER = ["开盘", "收盘", "最高", "最低", "振幅"];
/** 分时 tooltip 行序(与 K 线同一套五项)。 */
const TREND_TOOLTIP_ORDER = ["开盘", "收盘", "最高", "最低", "振幅"];

/**
 * 主图 view 的 tooltip 交互配置:shared(按 x 聚合该位置全部系列值)+ 十字准线 + 缺值行过滤 + 固定行序。
 * 行序表由调用方传入(各图表字段不同)。
 */
function tooltipInteraction(order: string[]): { tooltip: TooltipInteraction } {
  const rank = (name: unknown): number => {
    const index = order.indexOf(String(name));
    return index === -1 ? order.length : index;
  };
  return {
    tooltip: {
      shared: true,
      // crosshairsX = 横向准线(默认 false)、crosshairsY = 纵向准线(默认 true),都是官方字段。
      crosshairs: true,
      crosshairsStroke: CROSSHAIR_COLOR,
      crosshairsLineWidth: CROSSHAIR_LINE_WIDTH,
      crosshairsXLineDash: CROSSHAIR_X_LINE_DASH,
      crosshairsYLineDash: CROSSHAIR_Y_LINE_DASH,
      // 值缺失的行(分时缺分钟 OHLC / 振幅不可算)不展示;值为 0 的行照常展示。
      filter: (item) => item.value !== null && item.value !== undefined,
      sort: (item) => rank(item.name)
    }
  };
}

/** K 线 x 轴标签:源日期串 "YYYY-MM-DD ..." → "MM-DD"(日/周/月 K 共用,标签更密)。 */
export function formatKlineLabel(time: string): string {
  return time.length >= 10 ? time.slice(5, 10) : time;
}

/** K 线 x 轴标签抽样步长:可视根数再多也只保留约 8 个标签(参考图的稀疏日期轴)。 */
export function klineLabelStep(barCount: number): number {
  return Math.max(1, Math.ceil(barCount / 8));
}

/** 分时 x 轴标签:源时间串 "YYYY-MM-DD HH:mm" → "MM-DD HH:mm"。 */
export function formatTrendLabel(time: string): string {
  return time.length >= 16 ? time.slice(5, 16) : time;
}

/** 分时量柱方向:与前一根比较(≥ 算涨);首根传昨收,缺昨收或数值无效为 flat。 */
export function resolveVolumeTrend(price: number, previous: number | null): TrendDirection {
  if (previous === null || !Number.isFinite(previous) || !Number.isFinite(price)) {
    return "flat";
  }
  return price >= previous ? "up" : "down";
}

/**
 * 分时振幅(%):(最高 - 最低) / 昨收 × 100,保留两位;最高/最低缺任一项或昨收缺失/为 0 时为 null。
 * (分时源多为「均价 + 最新价」序列,没有分钟 OHLC,此时振幅恒 null,浮标该行由 filter 丢弃。)
 */
function resolveTrendAmplitudePct(
  high: number | null,
  low: number | null,
  prevClose: number | null
): number | null {
  if (
    typeof high !== "number" ||
    !Number.isFinite(high) ||
    typeof low !== "number" ||
    !Number.isFinite(low) ||
    typeof prevClose !== "number" ||
    !Number.isFinite(prevClose) ||
    prevClose === 0
  ) {
    return null;
  }
  return Number((((high - low) / prevClose) * 100).toFixed(2));
}

/** 按数据里实际出现的方向裁剪 color domain(固定 down/up/flat 顺序,保证 domain↔range 一一对应)。 */
function buildTrendColorScale(
  trends: TrendDirection[],
  downColor: string,
  upColor: string,
  flatColor: string
): { domain: TrendDirection[]; range: string[] } {
  const colors: Record<TrendDirection, string> = {
    down: downColor,
    up: upColor,
    flat: flatColor
  };
  const domain = (["down", "up", "flat"] as TrendDirection[]).filter((trend) =>
    trends.includes(trend)
  );
  return { domain, range: domain.map((trend) => colors[trend]) };
}

/** 主图/量柱图共用的横向留白(每次调用返回新对象:G2 会就地改写 mark 的 scale 配置)。 */
function viewLayout(): { paddingLeft: number; paddingRight: number } {
  return { paddingLeft: PLOT_PADDING_LEFT, paddingRight: PLOT_PADDING_RIGHT };
}

/** 主图 + 量柱副图组合:spaceFlex 纵向 3:1;子图不写宽高,由父级按 ratio 分配。 */
function stackViews(mainView: ViewComposition, volumeView: ViewComposition): G2Spec {
  return {
    type: "spaceFlex",
    direction: "col",
    ratio: [3, 1],
    padding: SUB_VIEW_GAP,
    children: [mainView, volumeView]
  };
}

export interface KlineSpecArgs {
  bars: KlineBar[];
  ma: Record<number, (number | null)[]>;
  hasVolume: boolean;
  upColor: string;
  downColor: string;
  flatColor: string;
  maColors: Record<number, string>;
}

/**
 * K 线 spec(bars 已是可视窗口切片,ma 与 bars 同长且逐点对齐)。
 * hasVolume=false(伦敦金)时退化为单个主图 view,不输出量柱图。
 */
export function buildKlineSpec(args: KlineSpecArgs): G2Spec {
  const periods = Object.keys(args.maColors)
    .map((key) => Number(key))
    .filter((period) => Number.isInteger(period) && period > 0)
    .sort((left, right) => left - right);

  const data = args.bars.map((bar, index) => {
    const datum = {
      time: bar.time,
      start: bar.open,
      max: bar.high,
      min: bar.low,
      end: bar.close,
      trend: classifyTrend(bar.open, bar.close),
      volume: bar.volume,
      amount: bar.amount,
      amplitudePct: bar.amplitudePct,
      openF: tickOrNull(bar.open),
      highF: tickOrNull(bar.high),
      lowF: tickOrNull(bar.low),
      amplitudeF: pctOrNull(bar.amplitudePct)
    } as KlineDatum;
    for (const period of periods) {
      datum[`ma${period}`] = args.ma[period]?.[index] ?? null;
    }
    return datum;
  });

  // 色阶每次新建:两个 mark 各自持有一份(G2 会就地改写 mark 的 scale 配置,共享同一对象不安全)。
  const candleColor = (): { domain: TrendDirection[]; range: string[] } =>
    buildTrendColorScale(
      data.map((datum) => datum.trend),
      args.downColor,
      args.upColor,
      args.flatColor
    );

  // 浮标行序:开盘 → 收盘(载体线)→ 最高 → 最低 → 振幅,由共用配置的 sort 固定。
  const tooltipInteractionConfig = tooltipInteraction(KLINE_TOOLTIP_ORDER);

  const trendColors: Record<TrendDirection, string> = {
    up: args.upColor,
    down: args.downColor,
    flat: args.flatColor
  };

  const candleChildren: Mark[] = [
    // 影线(最高/最低):link 的 y 用两字段数组连成一条竖线。
    {
      type: "link",
      encode: { x: "time", y: ["min", "max"], color: "trend" },
      scale: { color: candleColor(), x: { padding: CANDLE_BAND_PADDING } },
      style: { lineWidth: 1 },
      tooltip: false,
      // 涨红跌绿自解释,关掉 G2 自动生成的 down/up 图例(参考图无图例)。
      legend: false
    },
    // 实体(开盘/收盘):y 区间 + 涨跌色。tooltip 行给开/高/低/振幅;收盘行由下面的载体线给(见该注释)。
    {
      type: "interval",
      encode: { x: "time", y: ["start", "end"], color: "trend" },
      scale: { color: candleColor(), x: { padding: CANDLE_BAND_PADDING } },
      style: { fillOpacity: 1 },
      tooltip: { title: "time", items: KLINE_PRICE_ROWS },
      legend: false
    }
  ];

  // MA5/10/20 各一条线:null 段(窗口不足)不进 data,避免断线前的假零点。
  for (const period of periods) {
    const field: MaField = `ma${period}`;
    candleChildren.push({
      type: "line",
      data: data.filter((datum) => datum[field] !== null),
      encode: { x: "time", y: field },
      style: { stroke: args.maColors[period], lineWidth: 1 },
      // MA 线只负责绘制,不再出浮标行(浮标五项里没有 MA):关掉 tooltip 后它不参与 series 行收集;
      // series tooltip 入口与十字准线锚点全部由下面的隐形收盘价载体线承担(官方判定依据见文件头)。
      tooltip: false
    });
  }

  // 隐形收盘价载体线:官方十字准线锚定「最近的 series 元素点」,蜡烛实体是 interval(非 series 元素),
  // MA 线已关 tooltip,故 series 入口唯一由这条不可见的 line(收盘价)承担,它同时满足两点 ——
  // ① series tooltip 的 series 几何来源(有数据即非空,窗口只有 1 根 bar 时准线仍可用);
  // ② 横向准线吸附到该时刻收盘价。行序由 sort 固定到实体内。
  candleChildren.push({
    type: "line",
    data,
    encode: { x: "time", y: "end" },
    style: { lineWidth: 0, strokeOpacity: 0 },
    tooltip: {
      items: [
        (datum: KlineDatum) => ({
          name: "收盘",
          value: formatTickValue(datum.end),
          color: trendColors[datum.trend]
        })
      ]
    }
  });

  const mainView: ViewComposition = {
    type: "view",
    data,
    ...viewLayout(),
    // 浮标 + 十字光标(横虚线定 y / 竖实线定 x)挂在主图 view 上,K 线与分时两个图表共用同一套配置。
    interaction: tooltipInteractionConfig,
    axis: {
      // 与参考图一致:不显示 "time" 轴标题;标签按步长抽样,避免密集日期互相遮挡。
      x: {
        labelFormatter: formatKlineLabel,
        title: false,
        tickFilter: (_datum: string, index: number) => index % klineLabelStep(data.length) === 0
      },
      y: { title: false }
    },
    children: candleChildren
  };

  if (!args.hasVolume) {
    return mainView;
  }

  const volumeView: ViewComposition = {
    type: "view",
    data,
    ...viewLayout(),
    // 只留主图 x 轴:量柱图轴一并关掉,避免两套刻度与额外留白。
    // 副图不挂 tooltip 交互:官方 crosshairs 按 view 渲染、不跨子图联动(与分时副图处理一致,需求允许主图有即可)。
    axis: { x: false, y: false },
    children: [
      {
        type: "interval",
        encode: { x: "time", y: "volume", color: "trend" },
        scale: { color: candleColor(), x: { padding: VOLUME_BAND_PADDING } },
        style: { fillOpacity: 0.9 },
        tooltip: false,
        legend: false
      }
    ]
  };

  return stackViews(mainView, volumeView);
}

export interface TrendSpecArgs {
  points: {
    idx: number;
    label: string;
    price: number;
    open: number | null;
    high: number | null;
    low: number | null;
    avgPrice: number | null;
    volume: number | null;
  }[];
  prevClose: number | null;
  showAvg: boolean;
  hasVolume: boolean;
  upColor: string;
  downColor: string;
  tickCount: number;
}

/** 分时 spec(1 日 / 五日):x 为索引等距轴,label 由 idx 查表得出。 */
export function buildTrendSpec(args: TrendSpecArgs): G2Spec {
  const data: TrendDatum[] = args.points.map((point, index) => {
    const amplitudePct = resolveTrendAmplitudePct(point.high, point.low, args.prevClose);
    return {
      idx: point.idx,
      label: point.label,
      price: point.price,
      open: point.open,
      high: point.high,
      low: point.low,
      avgPrice: point.avgPrice,
      amplitudePct,
      volume: point.volume,
      volumeTrend: resolveVolumeTrend(
        point.price,
        index === 0 ? args.prevClose : args.points[index - 1].price
      ),
      openF: tickOrNull(point.open),
      closeF: tickOrNull(point.price),
      highF: tickOrNull(point.high),
      lowF: tickOrNull(point.low),
      amplitudeF: pctOrNull(amplitudePct)
    };
  });

  // 轴标签查表:linear 轴的刻度值可能带小数,四舍五入后查不到则留空。
  const labelByIndex = new Map(data.map((datum) => [datum.idx, datum.label]));
  const labelFormatter = (value: number): string => labelByIndex.get(Math.round(value)) ?? "";

  const children: Mark[] = [
    {
      type: "line",
      data,
      encode: { x: "idx", y: "price" },
      scale: { x: { type: "linear", nice: false } },
      style: { stroke: TREND_PRICE_COLOR, lineWidth: 1.5 },
      // 价格线同时是十字准线的 series 锚点(官方 crosshairs 依赖 series 元素,依据见文件头);
      // 浮标五项(开/收/高/低/振幅)全挂本条线,缺值行(open/high/low/振幅为 null)由 filter 丢弃。
      tooltip: { title: "label", items: TREND_PRICE_ROWS }
    }
  ];

  if (args.showAvg) {
    const avgData = data.filter((datum) => datum.avgPrice !== null);
    if (avgData.length > 0) {
      children.push({
        type: "line",
        data: avgData,
        encode: { x: "idx", y: "avgPrice" },
        scale: { x: { type: "linear", nice: false } },
        style: { stroke: TREND_AVG_COLOR, lineWidth: 1 },
        // 均价线只负责绘制,不再出浮标行(浮标五项里没有均价);series 入口与准线锚点由价格线承担。
        tooltip: false
      });
    }
  }

  if (args.prevClose !== null && Number.isFinite(args.prevClose)) {
    children.push({
      type: "lineY",
      data: [args.prevClose],
      style: { stroke: PREV_CLOSE_COLOR, strokeDasharray: "4 4", lineWidth: 1 },
      tooltip: false
    });
  }

  const mainView: ViewComposition = {
    type: "view",
    ...viewLayout(),
    // 浮标 + 十字光标(横虚线定 y / 竖实线定 x)挂主图;量柱副图是独立 view,官方 crosshairs 按 view
    // 渲染、不跨子图联动,故准线与浮标只在主图(与 K 线主图一致,需求允许「主图有即可」)。
    interaction: tooltipInteraction(TREND_TOOLTIP_ORDER),
    axis: {
      // x 是来源不可见的索引轴,不显示 "idx" 轴标题(参考图无标题)。
      x: { tickCount: args.tickCount, labelFormatter, title: false },
      y: { title: false }
    },
    children
  };

  if (!args.hasVolume) {
    return mainView;
  }

  // 量柱:interval 的 x 需要 band scale(其形状函数依赖 getBandWidth),故这一子图用索引 band 轴,
  // 与主图 linear 轴的位置差最多半个 band(≈1px),视觉上仍对齐。
  const volumeColor = buildTrendColorScale(
    data.map((datum) => datum.volumeTrend),
    args.downColor,
    args.upColor,
    VOLUME_FLAT_COLOR
  );

  const volumeView: ViewComposition = {
    type: "view",
    data,
    ...viewLayout(),
    axis: { x: false, y: false },
    children: [
      {
        type: "interval",
        encode: { x: "idx", y: "volume", color: "volumeTrend" },
        scale: { color: volumeColor, x: { padding: VOLUME_BAND_PADDING } },
        style: { fillOpacity: 0.9 },
        tooltip: false,
        // 量柱图同样不显示自动图例(涨跌色自解释,与 K 线量柱一致)。
        legend: false
      }
    ]
  };

  return stackViews(mainView, volumeView);
}
