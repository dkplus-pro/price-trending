// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

// 行情页全局筛选 store(周期 / 数据源 / 日期范围):默认值、三个 setter、跨页共享(模块级单例);
// 快捷跨度的纯计算(六档起点 / 日历减法溢出 / 月首年首边界)。纯客户端状态,node 环境即可。
import type { QuickRangeKey } from "../../src/store/market-filter";
import {
  computeQuickRange,
  getDefaultDateRange,
  QUICK_RANGE_OPTIONS,
  useMarketFilterStore
} from "../../src/store/market-filter";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** "YYYY-MM-DD" → UTC 毫秒(只用于算天数差,避开本地时区偏移)。 */
function utcMs(date: string): number {
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10))
  );
}

/** 本地时区的今天 "YYYY-MM-DD"(与 store 实现同口径)。 */
function today(): string {
  const now = new Date();
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

beforeEach(() => {
  useMarketFilterStore.setState({
    period: "minute",
    source: "auto",
    dateRange: getDefaultDateRange()
  });
});

describe("getDefaultDateRange", () => {
  it("返回 [近365天, 今天],均为 YYYY-MM-DD,beg 与 end 相差 365 天(±1 天容差)", () => {
    const [beg, end] = getDefaultDateRange();

    expect(beg).toMatch(DATE_PATTERN);
    expect(end).toMatch(DATE_PATTERN);
    expect(end).toBe(today());
    const days = (utcMs(end) - utcMs(beg)) / MS_PER_DAY;
    expect(Math.abs(days - 365)).toBeLessThanOrEqual(1);
  });

  it("每次调用都返回新的元组(beg 严格早于 end)", () => {
    const first = getDefaultDateRange();
    const second = getDefaultDateRange();

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(utcMs(first[0])).toBeLessThan(utcMs(first[1]));
  });
});

describe("computeQuickRange", () => {
  /** 本地 2026-10-09(用例统一注入的「今天」)。 */
  const today20261009 = new Date(2026, 9, 9);

  it("选项表为六档「一周/2周/1个月/3个月/半年/1年」,顺序即展示顺序", () => {
    expect(QUICK_RANGE_OPTIONS.map(({ key, label }) => [key, label])).toEqual([
      ["1w", "一周"],
      ["2w", "2周"],
      ["1m", "1个月"],
      ["3m", "3个月"],
      ["6m", "半年"],
      ["1y", "1年"]
    ]);
  });

  it("六档起点按跨度推算(end 恒为 today)", () => {
    const expected: [QuickRangeKey, string][] = [
      ["1w", "2026-10-02"],
      ["2w", "2026-09-25"],
      ["1m", "2026-09-09"],
      ["3m", "2026-07-09"],
      ["6m", "2026-04-09"],
      ["1y", "2025-10-09"]
    ];

    for (const [key, beg] of expected) {
      expect(computeQuickRange(key, today20261009)).toEqual([beg, "2026-10-09"]);
    }
  });

  it("月档跨月溢出收回目标月最后一天(2026-03-31 减 1 月 → 2026-02-28)", () => {
    expect(computeQuickRange("1m", new Date(2026, 2, 31))).toEqual(["2026-02-28", "2026-03-31"]);
    // 闰年 2 月同样收口(2024-02-29 存在)。
    expect(computeQuickRange("1m", new Date(2024, 2, 31))).toEqual(["2024-02-29", "2024-03-31"]);
    expect(computeQuickRange("3m", new Date(2026, 4, 31))).toEqual(["2026-02-28", "2026-05-31"]);
    expect(computeQuickRange("6m", new Date(2026, 4, 31))).toEqual(["2025-11-30", "2026-05-31"]);
  });

  it("年档闰日溢出收回 2-28(2024-02-29 减 1 年 → 2023-02-28)", () => {
    expect(computeQuickRange("1y", new Date(2024, 1, 29))).toEqual(["2023-02-28", "2024-02-29"]);
  });

  it("月首 / 年首边界:周档跨年、月档与年档落在上月与上年同日", () => {
    const janFirst = new Date(2026, 0, 1);
    expect(computeQuickRange("1w", janFirst)).toEqual(["2025-12-25", "2026-01-01"]);
    expect(computeQuickRange("1m", janFirst)).toEqual(["2025-12-01", "2026-01-01"]);
    expect(computeQuickRange("1y", janFirst)).toEqual(["2025-01-01", "2026-01-01"]);
    // 跨年但目标月同为 31 天:不发生收口。
    expect(computeQuickRange("1m", new Date(2026, 0, 31))).toEqual(["2025-12-31", "2026-01-31"]);
  });

  it("缺省 today 取当前时间:end 为今天、起点严格早于今天且均为 YYYY-MM-DD", () => {
    for (const { key } of QUICK_RANGE_OPTIONS) {
      const [beg, end] = computeQuickRange(key);

      expect(end).toBe(today());
      expect(beg).toMatch(DATE_PATTERN);
      expect(utcMs(beg)).toBeLessThan(utcMs(end));
    }
  });

  it("每次调用返回新的元组,不受后续调用影响", () => {
    const first = computeQuickRange("1m", today20261009);

    expect(first).not.toBe(computeQuickRange("1m", today20261009));
    computeQuickRange("1y", today20261009);
    expect(first).toEqual(["2026-09-09", "2026-10-09"]);
  });
});

describe("useMarketFilterStore", () => {
  it("默认值:period=minute、source=auto、dateRange=getDefaultDateRange()", () => {
    const state = useMarketFilterStore.getState();

    expect(state.period).toBe("minute");
    expect(state.source).toBe("auto");
    expect(state.dateRange).toEqual(getDefaultDateRange());
  });

  it("setPeriod 切换周期,其余字段不变", () => {
    useMarketFilterStore.getState().setPeriod("day");

    const state = useMarketFilterStore.getState();
    expect(state.period).toBe("day");
    expect(state.source).toBe("auto");
    expect(state.dateRange).toEqual(getDefaultDateRange());
  });

  it("setSource 切换数据源,其余字段不变", () => {
    useMarketFilterStore.getState().setSource("tencent");

    const state = useMarketFilterStore.getState();
    expect(state.source).toBe("tencent");
    expect(state.period).toBe("minute");
    expect(state.dateRange).toEqual(getDefaultDateRange());
  });

  it("setDateRange 原样保存(不校验 / 不规范化,合法性由调用方负责)", () => {
    const range: [string, string] = ["2026-01-01", "2026-01-31"];
    useMarketFilterStore.getState().setDateRange(range);

    expect(useMarketFilterStore.getState().dateRange).toBe(range);

    // 反向区间不抛错也不被改写(边界:非法状态原样保存)。
    useMarketFilterStore.getState().setDateRange(["2026-06-30", "2026-01-01"]);
    expect(useMarketFilterStore.getState().dateRange).toEqual(["2026-06-30", "2026-01-01"]);
    expect(useMarketFilterStore.getState().period).toBe("minute");
  });

  it("两个页面的订阅者共享同一 store:一处 setPeriod,两处读到同一值", () => {
    const seenByGoldPage: string[] = [];
    const seenByIndicesPage: string[] = [];
    const unsubscribeGold = useMarketFilterStore.subscribe((state) => {
      seenByGoldPage.push(state.period);
    });
    const unsubscribeIndices = useMarketFilterStore.subscribe((state) => {
      seenByIndicesPage.push(state.period);
    });

    try {
      useMarketFilterStore.getState().setPeriod("week");
    } finally {
      unsubscribeGold();
      unsubscribeIndices();
    }

    expect(seenByGoldPage).toEqual(["week"]);
    expect(seenByIndicesPage).toEqual(["week"]);
    // 模块级单例:两次 getState() 是同一份状态(跨页保持筛选态)。
    expect(useMarketFilterStore.getState()).toBe(useMarketFilterStore.getState());
  });
});
