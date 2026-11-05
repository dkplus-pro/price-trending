// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { KlineBar } from "../../src/api/market/types";
import {
  aggregateDailyBars,
  classifyTrend,
  computeMA,
  formatAmountCn,
  formatPct,
  formatUnsignedPct,
  formatPrice,
  formatQuoteTime,
  formatSigned,
  formatVolumeCn,
  shiftYyyymmdd,
  MISSING_TEXT
} from "../../src/api/market/utils";

// 行情层纯函数(边界:空值 null / 零值 / 精度进位 / 闰年与跨年)。
describe("formatPrice", () => {
  it("null / NaN / Infinity 都显示占位符", () => {
    expect(formatPrice(null, 2)).toBe(MISSING_TEXT);
    expect(formatPrice(Number.NaN, 2)).toBe(MISSING_TEXT);
    expect(formatPrice(Number.POSITIVE_INFINITY, 2)).toBe(MISSING_TEXT);
  });

  it("零值按精度输出(0 是合法行情)", () => {
    expect(formatPrice(0, 2)).toBe("0.00");
  });

  it("负数保留负号", () => {
    expect(formatPrice(-1.23, 2)).toBe("-1.23");
  });

  it("按标的小数位截断", () => {
    expect(formatPrice(1.23456, 2)).toBe("1.23");
    expect(formatPrice(1.23456, 3)).toBe("1.235");
    expect(formatPrice(2718.4, 1)).toBe("2718.4");
  });
});

describe("formatSigned", () => {
  it("正数补 +,负数保留 -,零不带符号", () => {
    expect(formatSigned(2.5, 2)).toBe("+2.50");
    expect(formatSigned(-3.456, 2)).toBe("-3.46");
    expect(formatSigned(0, 2)).toBe("0.00");
    expect(formatSigned(-0, 2)).toBe("0.00");
  });

  it("缺失显示占位符", () => {
    expect(formatSigned(null, 2)).toBe(MISSING_TEXT);
  });
});

describe("formatPct", () => {
  it("带符号百分比", () => {
    expect(formatPct(1.234)).toBe("+1.23%");
    expect(formatPct(-1.234)).toBe("-1.23%");
    expect(formatPct(0)).toBe("0.00%");
  });

  it("缺失显示占位符", () => {
    expect(formatPct(null)).toBe(MISSING_TEXT);
  });
});

describe("formatUnsignedPct", () => {
  it("恒正不带符号", () => {
    expect(formatUnsignedPct(1.234)).toBe("1.23%");
    expect(formatUnsignedPct(0)).toBe("0.00%");
  });

  it("缺失显示占位符", () => {
    expect(formatUnsignedPct(null)).toBe(MISSING_TEXT);
  });
});

describe("formatAmountCn / formatVolumeCn", () => {
  it("中文单位阈值边界", () => {
    expect(formatAmountCn(9999)).toBe("9999");
    expect(formatAmountCn(10000)).toBe("1.00万");
    expect(formatAmountCn(15000)).toBe("1.50万");
    expect(formatAmountCn(1e8)).toBe("1.00亿");
    expect(formatAmountCn(123456789)).toBe("1.23亿");
  });

  it("贴近亿阈值的进位(toFixed 造成,显示精度取舍)", () => {
    expect(formatAmountCn(99999999)).toBe("10000.00万");
  });

  it("绝对值判定阈值,负数同理换算", () => {
    expect(formatAmountCn(-1.5e8)).toBe("-1.50亿");
  });

  it("缺失显示占位符", () => {
    expect(formatAmountCn(null)).toBe(MISSING_TEXT);
    expect(formatAmountCn(Number.NaN)).toBe(MISSING_TEXT);
  });

  it("成交量与成交额同规则", () => {
    expect(formatVolumeCn(9999)).toBe("9999");
    expect(formatVolumeCn(1e8)).toBe("1.00亿");
    expect(formatVolumeCn(null)).toBe(MISSING_TEXT);
  });
});

describe("formatQuoteTime", () => {
  it("unix 秒转本地 HH:mm:ss(补零)", () => {
    const date = new Date(2024, 0, 2, 9, 5, 7);
    expect(formatQuoteTime(Math.floor(date.getTime() / 1000))).toBe("09:05:07");
  });

  it("缺失与非法时间显示占位符", () => {
    expect(formatQuoteTime(null)).toBe(MISSING_TEXT);
    expect(formatQuoteTime(Number.NaN)).toBe(MISSING_TEXT);
    expect(formatQuoteTime(Number.MAX_VALUE)).toBe(MISSING_TEXT);
  });
});

describe("computeMA", () => {
  it("空数组返回空均线", () => {
    expect(computeMA([], [5])).toEqual({ 5: [] });
  });

  it("点数不足 period 时全为 null", () => {
    expect(computeMA([1, 2], [5])).toEqual({ 5: [null, null] });
  });

  it("标准序列手算值(前 period-1 位为 null)", () => {
    expect(computeMA([1, 2, 3, 4, 5], [3])).toEqual({ 3: [null, null, 2, 3, 4] });
    expect(computeMA([1, 2, 3, 4, 5], [2])).toEqual({ 2: [null, 1.5, 2.5, 3.5, 4.5] });
  });

  it("一次计算多条均线", () => {
    expect(computeMA([1, 2, 3, 4, 5], [2, 3])).toEqual({
      2: [null, 1.5, 2.5, 3.5, 4.5],
      3: [null, null, 2, 3, 4]
    });
  });

  it("窗口内含 null 时该点为 null,null 滑出窗口后恢复", () => {
    expect(computeMA([null, 1, 2, 3], [2])).toEqual({ 2: [null, null, 1.5, 2.5] });
    expect(computeMA([1, 2, null, 4, 5], [3])).toEqual({ 3: [null, null, null, null, null] });
  });

  it("非法周期(0 / 负 / 非整数)输出全 null", () => {
    expect(computeMA([1, 2, 3], [0])).toEqual({ 0: [null, null, null] });
    expect(computeMA([1, 2, 3], [-2])).toEqual({ "-2": [null, null, null] });
    expect(computeMA([1, 2, 3], [2.5])).toEqual({ "2.5": [null, null, null] });
  });
});

describe("shiftYyyymmdd", () => {
  it("跨月且命中闰年(20240301 -1 → 20240229)", () => {
    expect(shiftYyyymmdd("20240301", -1)).toBe("20240229");
  });

  it("跨年(20240101 -1 → 20231231)", () => {
    expect(shiftYyyymmdd("20240101", -1)).toBe("20231231");
  });

  it("平年 3 月 1 日回退到 2 月 28 日", () => {
    expect(shiftYyyymmdd("20230301", -1)).toBe("20230228");
  });

  it("向前位移", () => {
    expect(shiftYyyymmdd("20240101", 1)).toBe("20240102");
    expect(shiftYyyymmdd("20240229", 1)).toBe("20240301");
  });

  it("非法输入抛错(格式 / 不存在的日期 / 非整数位移)", () => {
    expect(() => shiftYyyymmdd("2024-03-01", -1)).toThrow(/非法日期/);
    expect(() => shiftYyyymmdd("", -1)).toThrow(/非法日期/);
    expect(() => shiftYyyymmdd("20240230", -1)).toThrow(/日期不存在/);
    expect(() => shiftYyyymmdd("20241301", -1)).toThrow(/日期不存在/);
    expect(() => shiftYyyymmdd("20240301", 1.5)).toThrow(/必须为整数/);
    expect(() => shiftYyyymmdd("20240301", Number.NaN)).toThrow(/必须为整数/);
  });
});

describe("classifyTrend", () => {
  it("三态分类", () => {
    expect(classifyTrend(1, 2)).toBe("up");
    expect(classifyTrend(2, 1)).toBe("down");
    expect(classifyTrend(1, 1)).toBe("flat");
  });

  it("数据无效归为 flat", () => {
    expect(classifyTrend(Number.NaN, 2)).toBe("flat");
    expect(classifyTrend(1, Number.POSITIVE_INFINITY)).toBe("flat");
  });
});

/** 构造聚合用日 K(amplitudePct 为输出字段,入参不消费)。 */
function barOf(time: string, patch: Partial<KlineBar> = {}): KlineBar {
  return {
    time,
    open: 1,
    close: 1,
    high: 1,
    low: 1,
    volume: 0,
    amount: 0,
    amplitudePct: null,
    ...patch
  };
}

// aggregateDailyBars(日 K → 周/月 K 客户端聚合,SGE 源的周/月线由此派生):
// 桶边界(ISO 周一界 / 自然月)、桶内归并(open 首 / close 末 / high max / low min / 量额求和)、
// 振幅按前桶 close 现算。六类边界:空数组、单条、跨年周界、月末月界、量额 null、非法 time 跳过。
describe("aggregateDailyBars", () => {
  it("空数组 → [](空值边界)", () => {
    expect(aggregateDailyBars([], "week")).toEqual([]);
    expect(aggregateDailyBars([], "month")).toEqual([]);
  });

  it("单条:自身一桶,振幅首桶 null,量额原样保留", () => {
    const bars = [
      barOf("2026-10-07", { open: 100, close: 104, high: 106, low: 95, volume: 12, amount: 34 })
    ];
    expect(aggregateDailyBars(bars, "week")).toEqual([
      {
        time: "2026-10-07",
        open: 100,
        close: 104,
        high: 106,
        low: 95,
        volume: 12,
        amount: 34,
        amplitudePct: null
      }
    ]);
  });

  it("同周归并:open 首根 / close 末根 / high max / low min / time 首根 / 量额求和", () => {
    const bars = [
      barOf("2026-10-05", { open: 100, close: 101, high: 103, low: 98, volume: 1, amount: 10 }),
      barOf("2026-10-06", { open: 101, close: 102, high: 106, low: 97, volume: 2, amount: 20 }),
      barOf("2026-10-07", { open: 102, close: 104, high: 104, low: 95, volume: 3, amount: 30 }),
      barOf("2026-10-08", { open: 104, close: 103, high: 105, low: 99, volume: 4, amount: 40 }),
      barOf("2026-10-09", { open: 103, close: 104, high: 104, low: 100, volume: 5, amount: 50 })
    ];
    // 2026-10-05 为周一:五根同属一个 ISO 周(桶键 2026-10-05)。
    expect(aggregateDailyBars(bars, "week")).toEqual([
      {
        time: "2026-10-05",
        open: 100,
        close: 104,
        high: 106,
        low: 95,
        volume: 15,
        amount: 150,
        amplitudePct: null
      }
    ]);
  });

  it("跨年周界:周日收前一周、周一起新一周;12-30(周一)与次年 01-03(周五)同桶", () => {
    const bars = [
      barOf("2024-12-29", { open: 10, close: 11, high: 12, low: 9, volume: 1, amount: 1 }),
      barOf("2024-12-30", { open: 20, close: 21, high: 25, low: 18, volume: 2, amount: 2 }),
      barOf("2025-01-03", { open: 21, close: 22, high: 23, low: 19, volume: 3, amount: 3 })
    ];
    const weeks = aggregateDailyBars(bars, "week");
    expect(weeks).toHaveLength(2);
    // 2024-12-29 是周日:归 2024-12-23 起始的 ISO 周,单独一桶。
    expect(weeks[0]).toMatchObject({ time: "2024-12-29", open: 10, close: 11 });
    // 2024-12-30(周一)与 2025-01-03(周五)跨年同周:time 取桶首根(2024-12-30)。
    expect(weeks[1]).toMatchObject({
      time: "2024-12-30",
      open: 20,
      close: 22,
      high: 25,
      low: 18,
      volume: 5
    });
    // 第 2 桶振幅按第 1 桶 close 现算:(25-18)/11×100 ≈ 63.64。
    expect(weeks[1]?.amplitudePct).toBeCloseTo(63.64, 2);
  });

  it("月末月界:01-31 与 02-01 分属两桶;月桶 time 取桶内首个交易日,close 取末根", () => {
    const bars = [
      barOf("2026-01-30", { open: 80, close: 81, high: 82, low: 79, volume: 1, amount: 1 }),
      barOf("2026-01-31", { open: 81, close: 83, high: 84, low: 80, volume: 2, amount: 2 }),
      barOf("2026-02-01", { open: 83, close: 85, high: 86, low: 82, volume: 4, amount: 4 }),
      barOf("2026-02-02", { open: 85, close: 84, high: 85, low: 81, volume: 8, amount: 8 })
    ];
    const months = aggregateDailyBars(bars, "month");
    expect(months).toHaveLength(2);
    expect(months[0]).toMatchObject({ time: "2026-01-30", open: 80, close: 83, volume: 3 });
    expect(months[1]).toMatchObject({ time: "2026-02-01", open: 83, close: 84, volume: 12 });
  });

  it("振幅:首桶 null;前桶 close 为 0 → null(不产生 Infinity);非首桶按前桶 close 现算", () => {
    const bars = [
      barOf("2026-03-02", { open: 0, close: 0, high: 0, low: 0 }),
      barOf("2026-03-03", { open: 0, close: 0, high: 0, low: 0 }),
      barOf("2026-03-09", { open: 1, close: 3, high: 6, low: 0, volume: 1, amount: 1 }),
      barOf("2026-03-10", { open: 3, close: 3, high: 3, low: 1, volume: 1, amount: 1 }),
      barOf("2026-03-16", { open: 3, close: 4, high: 4.5, low: 0, volume: 1, amount: 1 })
    ];
    // 2026-03-02 / 03-09 / 03-16 均为周一:三个 ISO 周桶。
    // 桶 1 首桶 → null;桶 2 前桶 close 为 0 → null;桶 3 前桶 close 3:(4.5-0)/3×100 = 150。
    const weeks = aggregateDailyBars(bars, "week");
    expect(weeks.map((bar) => bar.amplitudePct)).toEqual([null, null, 150]);
  });

  it("量额:null / 非有限数不进和;全缺失 → null(不冒充 0);time 非法的行跳过", () => {
    const bars = [
      barOf("2026-04-06", { volume: null, amount: null }),
      barOf("2026-04-07", { volume: Number.NaN, amount: Number.POSITIVE_INFINITY }),
      barOf("2026-04-08", { volume: 5, amount: 7 }),
      // 周(周一为界)与月都命中不了合法桶键:整行跳过,不影响相邻桶。
      barOf("2026/04/09", { volume: 100, amount: 100 }),
      barOf("2026-04-10", { volume: 2, amount: 3 })
    ];
    const weeks = aggregateDailyBars(bars, "week");
    expect(weeks).toHaveLength(1);
    expect(weeks[0]).toMatchObject({ time: "2026-04-06", volume: 7, amount: 10 });
    expect(
      aggregateDailyBars([barOf("2026-04-06", { volume: null, amount: null })], "month")
    ).toEqual([
      {
        time: "2026-04-06",
        open: 1,
        close: 1,
        high: 1,
        low: 1,
        volume: null,
        amount: null,
        amplitudePct: null
      }
    ]);
  });
});
