// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
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
