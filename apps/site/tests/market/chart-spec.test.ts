// @vitest-environment node
// chart-spec 纯函数用例:G2 spec 结构(K 线/分时/组合)、颜色映射、索引轴查表、量柱方向、浮标五项行表。
// 边界:空值(振幅 null / 无 bars/points)、零值(volume=0 / 振幅 0)、越界(窗口/标签索引/昨收 0)、
// 配置缺失(无昨收/无均价/无量柱)、网络失败(N/A 纯函数)、非法状态(spec 整份重建下发)。
import { describe, expect, it } from "vitest";

import type { KlineBar } from "../../src/api/market/types";
import {
  buildKlineSpec,
  buildTrendSpec,
  CROSSHAIR_COLOR,
  DOWN_COLOR,
  formatKlineLabel,
  formatTrendLabel,
  PREV_CLOSE_COLOR,
  resolveVolumeTrend,
  TREND_AVG_COLOR,
  TREND_PRICE_COLOR,
  UP_COLOR,
  VOLUME_FLAT_COLOR
} from "../../src/components/market/chart-spec";

/** spec 是 G2 的联合类型,单测按结构读字段(只覆盖用例需要的键)。 */
interface SpecNode {
  type?: string;
  data?: Record<string, unknown>[];
  encode?: Record<string, unknown>;
  scale?: Record<string, unknown>;
  style?: Record<string, unknown>;
  axis?: Record<string, unknown>;
  interaction?: Record<string, unknown>;
  tooltip?: unknown;
  legend?: unknown;
  children?: SpecNode[];
  direction?: string;
  ratio?: number[];
  padding?: number;
  paddingLeft?: number;
  paddingRight?: number;
  width?: number;
  height?: number;
}

const nodeOf = (spec: unknown): SpecNode => spec as SpecNode;
const childrenOf = (parent: SpecNode): SpecNode[] => parent.children ?? [];

/** 主图 view:有量柱副图时根为 spaceFlex(主图在前),无量柱时根即主图。 */
const mainViewOf = (spec: SpecNode): SpecNode =>
  spec.type === "spaceFlex" ? childrenOf(spec)[0] : spec;

function findMark(parent: SpecNode, type: string, yField?: string): SpecNode | undefined {
  return childrenOf(parent).find(
    (child) => child.type === type && (yField === undefined || child.encode?.y === yField)
  );
}

/** mark 的 tooltip 配置(title / items)。 */
function tooltipOf(mark: SpecNode | undefined): { title?: unknown; items?: unknown[] } {
  return (mark?.tooltip ?? {}) as { title?: unknown; items?: unknown[] };
}

/** tooltip 行名:字段写法读 name;回调写法调用一次读返回值(MA/均价/收盘行必须用回调写法)。 */
function itemNamesOf(mark: SpecNode | undefined, datum: Record<string, unknown> = {}): string[] {
  return (tooltipOf(mark).items ?? []).map((item) => {
    if (typeof item === "function") {
      const row = (item as (value: unknown) => { name?: string } | null)(datum);
      return String(row?.name ?? "");
    }
    return String((item as { name?: string }).name ?? "");
  });
}

/** 主图 view 的 tooltip 交互配置(十字光标 + 浮标行为的断言入口)。 */
function tooltipInteractionOf(view: SpecNode): Record<string, unknown> {
  return (view.interaction?.tooltip ?? {}) as Record<string, unknown>;
}

/** 隐形收盘价载体线(encode.y = "end" 的 line mark)。 */
function carrierOf(mainView: SpecNode): SpecNode | undefined {
  return findMark(mainView, "line", "end");
}

function axisXOf(view: SpecNode): {
  tickCount?: number;
  labelFormatter?: (value: number) => string;
  title?: unknown;
} {
  return ((view.axis ?? {}).x ?? {}) as {
    tickCount?: number;
    labelFormatter?: (value: number) => string;
    title?: unknown;
  };
}

function colorScaleOf(mark: SpecNode | undefined): { domain?: string[]; range?: string[] } {
  return (mark?.scale?.color ?? {}) as { domain?: string[]; range?: string[] };
}

function bar(
  time: string,
  open: number,
  close: number,
  high: number,
  low: number,
  volume: number | null,
  amplitudePct: number | null = null
): KlineBar {
  return { time, open, close, high, low, volume, amount: null, amplitudePct };
}

/** 涨 / 跌 / 平三根 bar(颜色映射与趋势字段的最小覆盖;振幅含数值与 null 两种形态)。 */
const THREE_BARS: KlineBar[] = [
  bar("2026-10-07", 10, 11, 11.5, 9.8, 100, 1.85),
  bar("2026-10-08", 11, 10, 11.2, 9.9, 200, 0),
  bar("2026-10-09", 10, 10, 10.4, 9.7, 0, null)
];

const KLINE_COLORS = {
  upColor: "c-up",
  downColor: "c-down",
  flatColor: "c-flat",
  maColors: { 5: "c-ma5", 10: "c-ma10", 20: "c-ma20" }
};

/** MA 数组与 bars 逐点对齐:ma5 首尾为 null(窗口不足),ma10/ma20 全 null。 */
const THREE_MA = {
  5: [null, 10.5, 10.2],
  10: [null, null, null],
  20: [null, null, null]
};

function klineSpecOf(bars: KlineBar[], hasVolume = true, ma = THREE_MA): SpecNode {
  return nodeOf(buildKlineSpec({ bars, ma, hasVolume, ...KLINE_COLORS }));
}

describe("buildKlineSpec", () => {
  it("三根 bar 的涨跌方向与颜色 domain/range 一一对应(涨红跌绿平灰)", () => {
    const root = klineSpecOf(THREE_BARS);
    const mainView = childrenOf(root)[0];
    expect(mainView.type).toBe("view");
    expect(mainView.data?.map((datum) => datum.trend)).toEqual(["up", "down", "flat"]);

    const body = findMark(mainView, "interval");
    expect(colorScaleOf(body)).toEqual({
      domain: ["down", "up", "flat"],
      range: ["c-down", "c-up", "c-flat"]
    });
    expect(body?.encode).toEqual({ x: "time", y: ["start", "end"], color: "trend" });
    // 影线用 link 的 y 两字段区间,颜色同 trend。
    expect(findMark(mainView, "link")?.encode).toEqual({
      x: "time",
      y: ["min", "max"],
      color: "trend"
    });
  });

  it("颜色 domain 只保留数据里出现过的方向(子集裁剪)", () => {
    const onlyUp = klineSpecOf([bar("2026-10-09", 10, 11, 11.2, 9.9, 10, 1.2)]);
    const body = findMark(childrenOf(onlyUp)[0], "interval");
    expect(colorScaleOf(body)).toEqual({ domain: ["up"], range: ["c-up"] });
  });

  it("MA null 段不进 line data(ma5 只留非空点,全 null 的 ma10 线为空)", () => {
    const mainView = mainViewOf(klineSpecOf(THREE_BARS));
    const ma5 = findMark(mainView, "line", "ma5");
    const ma10 = findMark(mainView, "line", "ma10");
    expect(ma5?.data?.map((datum) => datum.ma5)).toEqual([10.5, 10.2]);
    expect(ma10?.data).toEqual([]);
    expect(ma5?.style?.stroke).toBe("c-ma5");
    expect(mainView.data?.[0]?.ma5).toBeNull();
  });

  it("MA5/10/20 线只绘制不出浮标行(tooltip=false,series 入口由载体线承担)", () => {
    const mainView = mainViewOf(klineSpecOf(THREE_BARS));
    expect(findMark(mainView, "line", "ma5")?.tooltip).toBe(false);
    expect(findMark(mainView, "line", "ma10")?.tooltip).toBe(false);
    expect(findMark(mainView, "line", "ma20")?.tooltip).toBe(false);
  });

  it("hasVolume=false 退化为单个主图 view(伦敦金无量柱)", () => {
    const root = klineSpecOf(THREE_BARS, false);
    expect(root.type).toBe("view");
    expect(
      root.children?.some((child) => child.type === "interval" && child.encode?.y === "volume")
    ).toBe(false);
  });

  it("hasVolume=true 用 spaceFlex ratio [3,1],子图不写宽高且横向留白一致", () => {
    const root = klineSpecOf(THREE_BARS, true);
    expect(root.type).toBe("spaceFlex");
    expect(root.direction).toBe("col");
    expect(root.ratio).toEqual([3, 1]);
    expect(childrenOf(root)).toHaveLength(2);

    const [mainView, volumeView] = childrenOf(root);
    for (const view of [mainView, volumeView]) {
      expect(view.width).toBeUndefined();
      expect(view.height).toBeUndefined();
      expect(view.paddingLeft).toBe(mainView.paddingLeft);
      expect(view.paddingRight).toBe(mainView.paddingRight);
    }
    expect(volumeView.axis).toEqual({ x: false, y: false });
    expect(findMark(volumeView, "interval")?.encode).toEqual({
      x: "time",
      y: "volume",
      color: "trend"
    });
  });

  it("x 轴用 MM-DD 标签;实体带开/高/低/振幅行,影线/量柱不带 tooltip", () => {
    const root = klineSpecOf(THREE_BARS);
    const mainView = childrenOf(root)[0];
    expect(axisXOf(mainView).labelFormatter?.("2026-10-09")).toBe("10-09");
    expect(tooltipOf(findMark(mainView, "interval")).title).toBe("time");
    expect(itemNamesOf(findMark(mainView, "interval"))).toEqual(["开盘", "最高", "最低", "振幅"]);
    expect(findMark(mainView, "link")?.tooltip).toBe(false);
    expect(findMark(childrenOf(root)[1], "interval")?.tooltip).toBe(false);
  });

  it("工具条行为挂在主图 view:shared + 十字准线(横虚线 / 竖实线)+ 缺值过滤 + 行序", () => {
    const mainView = mainViewOf(klineSpecOf(THREE_BARS));
    const tooltip = tooltipInteractionOf(mainView);
    expect(tooltip.shared).toBe(true);
    expect(tooltip.crosshairs).toBe(true);
    expect(tooltip.crosshairsStroke).toBe(CROSSHAIR_COLOR);
    expect(tooltip.crosshairsLineWidth).toBe(1);
    // 横向准线虚线、纵向准线空 dash(实线;不显式声明会沿用画布上一次 dash 状态)。
    expect(tooltip.crosshairsXLineDash).toEqual([4, 4]);
    expect(tooltip.crosshairsYLineDash).toEqual([]);

    // 缺值行(振幅缺失等)被过滤,0 值行保留。
    const filter = tooltip.filter as (item: { value?: unknown }) => boolean;
    expect(filter({ value: null })).toBe(false);
    expect(filter({ value: undefined })).toBe(false);
    expect(filter({ value: 0 })).toBe(true);
    expect(filter({ value: 10.5 })).toBe(true);

    // 行序:开/收/高/低/振幅五项按序,未登记的行排到末尾。
    const sort = tooltip.sort as (item: { name?: string }) => number;
    const ranks = ["开盘", "收盘", "最高", "最低", "振幅", "其他"].map((name) => sort({ name }));
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...ranks].sort((left, right) => left - right)).toEqual(ranks);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("隐形收盘价载体线:不可见、跟在实体后,收盘行按涨跌取色", () => {
    const mainView = mainViewOf(klineSpecOf(THREE_BARS));
    const carrier = carrierOf(mainView);
    expect(carrier?.encode).toEqual({ x: "time", y: "end" });
    expect(carrier?.style).toMatchObject({ lineWidth: 0, strokeOpacity: 0 });
    // 载体线承担 series tooltip 入口(官方 crosshairs 只在 series 路径渲染),必须带 tooltip 配置。
    expect(itemNamesOf(carrier, { end: 11, trend: "up" })).toEqual(["收盘"]);

    const rowOf = (trend: string) => {
      const callback = (tooltipOf(carrier).items ?? [])[0] as (datum: unknown) => {
        name: string;
        value: string;
        color: string;
      };
      return callback({ end: 11, trend });
    };
    expect(rowOf("up")).toEqual({ name: "收盘", value: "11", color: KLINE_COLORS.upColor });
    expect(rowOf("down")).toEqual({ name: "收盘", value: "11", color: KLINE_COLORS.downColor });
    expect(rowOf("flat")).toEqual({ name: "收盘", value: "11", color: KLINE_COLORS.flatColor });
  });

  it("hasVolume 开关不再影响浮标行(量/额行已移除,开关只决定量柱副图)", () => {
    const withVolume = itemNamesOf(findMark(mainViewOf(klineSpecOf(THREE_BARS, true)), "interval"));
    const withoutVolume = mainViewOf(klineSpecOf(THREE_BARS, false));
    expect(itemNamesOf(findMark(withoutVolume, "interval"))).toEqual([
      "开盘",
      "最高",
      "最低",
      "振幅"
    ]);
    expect(itemNamesOf(findMark(withoutVolume, "interval"))).toEqual(withVolume);
    // 载体线不受量柱开关影响。
    expect(carrierOf(withoutVolume)).toBeDefined();
  });

  it("浮标行读预格式化展示串:价格两位裁尾零、振幅两位百分比;空值行值为 null 交 filter 丢弃", () => {
    const mainView = mainViewOf(klineSpecOf(THREE_BARS));
    const rows = (tooltipOf(findMark(mainView, "interval")).items ?? []) as {
      field: string;
      name: string;
      valueFormatter?: unknown;
    }[];
    // 成交量/成交额/MA 行已从浮标移除。
    expect(rows.map((row) => row.name)).toEqual(["开盘", "最高", "最低", "振幅"]);
    expect(rows.map((row) => row.field)).toEqual(["openF", "highF", "lowF", "amplitudeF"]);
    // 展示串在数据行内预格式化:第三根 bar 振幅 null → null(行被丢弃),第二根零值振幅保留。
    expect(
      mainView.data?.map((datum) => [datum.openF, datum.highF, datum.lowF, datum.amplitudeF])
    ).toEqual([
      ["10", "11.5", "9.8", "1.85%"],
      ["11", "11.2", "9.9", "0.00%"],
      ["10", "10.4", "9.7", null]
    ]);
    // 回归:可空字段不再挂 valueFormatter(G2 5.4.8 在 filter 丢弃空值行之前就调用 formatter,会崩)。
    expect(rows.every((row) => row.valueFormatter === undefined)).toBe(true);
  });

  it("K 线主图与量柱的 color 通道关闭 G2 自动图例(涨红跌绿自解释)", () => {
    const root = klineSpecOf(THREE_BARS);
    const [mainView, volumeView] = childrenOf(root);
    expect(findMark(mainView, "interval")?.legend).toBe(false);
    expect(findMark(mainView, "link")?.legend).toBe(false);
    expect(findMark(volumeView, "interval")?.legend).toBe(false);
  });

  it("空数据与缺失量都不抛错(零值 volume=0 原样保留)", () => {
    const empty = klineSpecOf([], true);
    const emptyMain = mainViewOf(empty);
    expect(emptyMain.data).toEqual([]);
    // 空数据时浮标/十字光标配置照常构造(不在渲染期抛错),载体线以空数据存在。
    expect(tooltipInteractionOf(emptyMain).crosshairs).toBe(true);
    expect(carrierOf(emptyMain)?.data).toEqual([]);
    const root = klineSpecOf(THREE_BARS);
    expect(childrenOf(root)[0].data?.map((datum) => datum.volume)).toEqual([100, 200, 0]);
    expect(childrenOf(root)[0].data?.[0]?.volume).toBe(100);
  });

  it("成交额仍随 bar 进数据行(量柱副图共用同一份 data;浮标已无额行)", () => {
    const bars: KlineBar[] = [
      bar("2026-10-08", 10, 11, 11.5, 9.8, 100, 1.2),
      { ...bar("2026-10-09", 11, 10, 11.2, 9.9, 200, 1.1), amount: 123456 }
    ];
    const mainView = mainViewOf(klineSpecOf(bars));
    expect(mainView.data?.map((datum) => datum.amount)).toEqual([null, 123456]);
  });

  it("振幅源字段原样进数据行:null 行由 filter 丢弃,0 值行保留(空值 / 零值边界)", () => {
    const mainView = mainViewOf(klineSpecOf(THREE_BARS));
    expect(mainView.data?.map((datum) => datum.amplitudePct)).toEqual([1.85, 0, null]);
    const filter = tooltipInteractionOf(mainView).filter as (item: { value?: unknown }) => boolean;
    expect(filter({ value: mainView.data?.[1]?.amplitudePct })).toBe(true);
    expect(filter({ value: mainView.data?.[2]?.amplitudePct })).toBe(false);
  });
});

describe("buildTrendSpec", () => {
  const POINTS = [
    {
      idx: 0,
      label: "09-30 15:00",
      price: 100,
      open: 99,
      high: 100.5,
      low: 98.8,
      avgPrice: null,
      volume: 10
    },
    {
      idx: 1,
      label: "10-08 09:31",
      price: 101,
      open: 100,
      high: 101.2,
      low: 99.9,
      avgPrice: 100.5,
      volume: 20
    },
    {
      idx: 2,
      label: "10-08 09:32",
      price: 100,
      open: 101,
      high: 100.9,
      low: 99.7,
      avgPrice: 100.2,
      volume: 30
    }
  ];

  function trendSpecOf(overrides: Partial<Parameters<typeof buildTrendSpec>[0]> = {}): SpecNode {
    return nodeOf(
      buildTrendSpec({
        points: POINTS,
        prevClose: null,
        showAvg: false,
        hasVolume: true,
        upColor: UP_COLOR,
        downColor: DOWN_COLOR,
        tickCount: 6,
        ...overrides
      })
    );
  }

  it("x 用索引等距轴(数值 idx + linear nice:false)", () => {
    const priceLine = childrenOf(childrenOf(trendSpecOf())[0])[0];
    expect(priceLine.encode).toEqual({ x: "idx", y: "price" });
    expect(priceLine.scale?.x).toEqual({ type: "linear", nice: false });
    expect(priceLine.style?.stroke).toBe(TREND_PRICE_COLOR);
  });

  it("浮标 + 十字光标挂在分时主图 view(与 K 线同一套官方配置)", () => {
    const tooltip = tooltipInteractionOf(mainViewOf(trendSpecOf()));
    expect(tooltip.shared).toBe(true);
    expect(tooltip.crosshairs).toBe(true);
    expect(tooltip.crosshairsStroke).toBe(CROSSHAIR_COLOR);
    expect(tooltip.crosshairsXLineDash).toEqual([4, 4]);
    expect(tooltip.crosshairsYLineDash).toEqual([]);
  });

  it("价格线出开/收/高/低/振幅五个浮标行;均价线只绘制不出浮标行", () => {
    const mainView = mainViewOf(trendSpecOf({ showAvg: true }));
    const priceLine = findMark(mainView, "line", "price");
    expect(tooltipOf(priceLine).title).toBe("label");
    expect(itemNamesOf(priceLine)).toEqual(["开盘", "收盘", "最高", "最低", "振幅"]);
    // 行序与 K 线同一套五项(未登记行排到末尾)。
    const sort = tooltipInteractionOf(mainView).sort as (item: { name?: string }) => number;
    expect(["开盘", "收盘", "最高", "最低", "振幅", "其他"].map((name) => sort({ name }))).toEqual([
      0, 1, 2, 3, 4, 5
    ]);

    const avgLine = findMark(mainView, "line", "avgPrice");
    expect(avgLine?.tooltip).toBe(false);
  });

  it("分时浮标行读预格式化展示串;分钟 OHLC 缺失(腾讯源)时对应行为 null 交 filter 丢弃", () => {
    const priceLine = findMark(mainViewOf(trendSpecOf({})), "line", "price");
    const rows = (tooltipOf(priceLine).items ?? []) as {
      field: string;
      name: string;
      valueFormatter?: unknown;
    }[];
    expect(rows.map((row) => row.name)).toEqual(["开盘", "收盘", "最高", "最低", "振幅"]);
    expect(rows.map((row) => row.field)).toEqual([
      "openF",
      "closeF",
      "highF",
      "lowF",
      "amplitudeF"
    ]);
    // 回归:可空字段不再挂 valueFormatter(G2 5.4.8 在 filter 之前调用,空值会先崩)。
    expect(rows.every((row) => row.valueFormatter === undefined)).toBe(true);
    const first = priceLine?.data?.[0];
    expect([first?.openF, first?.closeF, first?.highF, first?.lowF, first?.amplitudeF]).toEqual([
      "99",
      "100",
      "100.5",
      "98.8",
      null
    ]);
    // 分钟 OHLC 全 null + 昨收 0:展示串全 null(浮标只剩非空行),收盘行仍正常。
    const nullOhlc = trendSpecOf({
      points: POINTS.map((point) => ({ ...point, open: null, high: null, low: null })),
      prevClose: 0
    });
    const nullDatum = findMark(mainViewOf(nullOhlc), "line", "price")?.data?.[0];
    expect([nullDatum?.openF, nullDatum?.highF, nullDatum?.lowF, nullDatum?.amplitudeF]).toEqual([
      null,
      null,
      null,
      null
    ]);
    expect(nullDatum?.closeF).toBe("100");
  });

  it("振幅由 high/low 与昨收现算保留两位;昨收缺失 / 为 0 一律 null(空值 / 越界边界)", () => {
    const amplitudesOf = (overrides: Partial<Parameters<typeof buildTrendSpec>[0]>) =>
      findMark(mainViewOf(trendSpecOf(overrides)), "line", "price")?.data?.map(
        (datum) => datum.amplitudePct
      );
    // (100.5-98.8)/100×100 现算并保留两位(1.7000000000000028 → 1.7)。
    expect(amplitudesOf({ prevClose: 100 })).toEqual([1.7, 1.3, 1.2]);
    // 越界:昨收为 0 不可作分母 → null。
    expect(amplitudesOf({ prevClose: 0 })).toEqual([null, null, null]);
    // 缺昨收 → null(与量柱方向同样降级)。
    expect(amplitudesOf({ prevClose: null })).toEqual([null, null, null]);
    // 保留两位:原始浮点 1.2300000000000039 → 1.23。
    expect(
      amplitudesOf({
        prevClose: 10,
        points: [
          {
            idx: 0,
            label: "10-09 09:31",
            price: 10,
            open: 10,
            high: 10.123,
            low: 10,
            avgPrice: null,
            volume: null
          }
        ]
      })
    ).toEqual([1.23]);
  });

  it("分时缺分钟 OHLC:开/高/低/振幅行值均 null 被 filter 丢弃,浮标只剩收盘(空值边界)", () => {
    const mainView = mainViewOf(
      trendSpecOf({
        prevClose: 100,
        points: [
          {
            idx: 0,
            label: "10-09 09:31",
            price: 100.2,
            open: null,
            high: null,
            low: null,
            avgPrice: 100.1,
            volume: 5
          }
        ]
      })
    );
    const priceLine = findMark(mainView, "line", "price");
    const datum = priceLine?.data?.[0] ?? {};
    expect(priceLine?.data?.map((row) => [row.open, row.high, row.low, row.amplitudePct])).toEqual([
      [null, null, null, null]
    ]);

    const filter = tooltipInteractionOf(mainView).filter as (item: { value?: unknown }) => boolean;
    for (const value of [datum.open, datum.high, datum.low, datum.amplitudePct]) {
      expect(filter({ value })).toBe(false);
    }
    expect(filter({ value: datum.price })).toBe(true);
    // 行表本身仍是五项(丢弃发生在 interaction filter,不在行表构造)。
    expect(itemNamesOf(priceLine)).toEqual(["开盘", "收盘", "最高", "最低", "振幅"]);
  });

  it("x 轴不显示「idx」轴标题(索引轴仅是内部实现,参考图无标题)", () => {
    expect(axisXOf(childrenOf(trendSpecOf())[0]).title).toBe(false);
  });

  it("量柱图同样关闭 G2 自动图例(与 K 线量柱一致)", () => {
    const volumeView = childrenOf(trendSpecOf())[1];
    expect(findMark(volumeView, "interval")?.legend).toBe(false);
  });

  it("labelFormatter 按 idx 查表(含五日跨日标签),越界返回空串", () => {
    const mainView = childrenOf(trendSpecOf())[0];
    const formatter = axisXOf(mainView).labelFormatter;
    expect(formatter?.(0)).toBe("09-30 15:00");
    expect(formatter?.(1)).toBe("10-08 09:31");
    expect(formatter?.(2)).toBe("10-08 09:32");
    expect(formatter?.(99)).toBe("");
    expect(formatter?.(-1)).toBe("");
  });

  it("tickCount 由调用方传入生效(桌面 6 / 移动 4)", () => {
    expect(axisXOf(childrenOf(trendSpecOf({ tickCount: 6 }))[0]).tickCount).toBe(6);
    expect(axisXOf(childrenOf(trendSpecOf({ tickCount: 4 }))[0]).tickCount).toBe(4);
  });

  it("prevClose 缺失不画参考线,有昨收时画灰色虚线 lineY", () => {
    const withoutPrev = childrenOf(trendSpecOf())[0];
    expect(findMark(withoutPrev, "lineY")).toBeUndefined();

    const withPrev = childrenOf(trendSpecOf({ prevClose: 99.5 }))[0];
    const lineY = findMark(withPrev, "lineY");
    expect(lineY?.data).toEqual([99.5]);
    expect(lineY?.style).toMatchObject({ stroke: PREV_CLOSE_COLOR, strokeDasharray: "4 4" });
  });

  it("showAvg=false 无均价线;true 时均价线只含非空点且为金色", () => {
    expect(
      findMark(childrenOf(trendSpecOf({ showAvg: false }))[0], "line", "avgPrice")
    ).toBeUndefined();

    const mainView = mainViewOf(trendSpecOf({ showAvg: true }));
    const avgLine = findMark(mainView, "line", "avgPrice");
    expect(avgLine?.data).toHaveLength(2);
    expect(avgLine?.style?.stroke).toBe(TREND_AVG_COLOR);
  });

  it("量柱:涨跌按与前一根比较(首根按昨收,缺昨收为 flat),颜色用同一套红绿", () => {
    const volumeView = childrenOf(trendSpecOf({ prevClose: null }))[1];
    expect(volumeView.data?.map((datum) => datum.volumeTrend)).toEqual(["flat", "up", "down"]);
    expect(colorScaleOf(findMark(volumeView, "interval"))).toEqual({
      domain: ["down", "up", "flat"],
      range: [DOWN_COLOR, UP_COLOR, VOLUME_FLAT_COLOR]
    });

    const withPrevView = childrenOf(trendSpecOf({ prevClose: 100 }))[1];
    expect(withPrevView.data?.map((datum) => datum.volumeTrend)).toEqual(["up", "up", "down"]);
    expect(colorScaleOf(findMark(withPrevView, "interval"))?.domain).toEqual(["down", "up"]);
  });

  it("hasVolume=false 退化为单个主图 view", () => {
    const root = trendSpecOf({ hasVolume: false });
    expect(root.type).toBe("view");
    expect(root.axis).toBeDefined();
  });

  it("空 points 不抛错且查表返回空串(空值边界)", () => {
    const root = trendSpecOf({ points: [], tickCount: 4 });
    const mainView = childrenOf(root)[0];
    expect(childrenOf(mainView)[0].data).toEqual([]);
    expect(axisXOf(mainView).labelFormatter?.(0)).toBe("");
    expect(findMark(mainView, "lineY")).toBeUndefined();
  });
});

describe("轴标签与量柱方向", () => {
  it("formatKlineLabel / formatTrendLabel 按源串截取,异常短串原样返回", () => {
    expect(formatKlineLabel("2026-10-09")).toBe("10-09");
    expect(formatKlineLabel("2026-10-09 09:31")).toBe("10-09");
    expect(formatKlineLabel("bad")).toBe("bad");
    expect(formatTrendLabel("2026-10-09 09:31")).toBe("10-09 09:31");
    expect(formatTrendLabel("short")).toBe("short");
  });

  it("resolveVolumeTrend:≥ 前值为涨,低于为跌,缺失/非法为平", () => {
    expect(resolveVolumeTrend(10, 10)).toBe("up");
    expect(resolveVolumeTrend(10, 9.9)).toBe("up");
    expect(resolveVolumeTrend(10, 10.1)).toBe("down");
    expect(resolveVolumeTrend(10, null)).toBe("flat");
    expect(resolveVolumeTrend(10, Number.NaN)).toBe("flat");
    expect(resolveVolumeTrend(Number.NaN, 10)).toBe("flat");
  });
});
