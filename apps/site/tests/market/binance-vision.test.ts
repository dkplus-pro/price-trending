// PAXG 兜底源(sources/binance-vision.ts)单测:mock 全局 fetch(fetchJson 的底层)驱动
// 「拼 URL → 请求 → 行映射」全链路,纯解析函数 parseKlinePayload 单独直喂响应体。
//
// 六类边界覆盖:空值(空数组 payload → 空 page、量额字段缺失 → null)、零值(volume 0 保留)、
// 越界(非范围模式按 limit 保留最近根、行段数不足跳过)、配置缺失(au9999 不支持本源 → MarketError)、
// 网络失败(fetchJson reject 透传)、非法状态(非数组响应 / OHLC 非数值 → 跳过 / 空 page)。
// 另覆盖:interval 映射(1d/1w/1M)、startTime 范围参数、UTC 日期转换、振幅现算、
// source="paxg" 回填与 hasMore 恒 false。
import { afterEach, describe, expect, it, vi } from "vitest";

import { getInstrument } from "../../src/api/market/config";
import {
  fetchKlines,
  parseKlinePayload,
  supportsPaxg
} from "../../src/api/market/sources/binance-vision";
import type { InstrumentConfig, KlinePeriod } from "../../src/api/market/types";
import { MarketError } from "../../src/api/market/types";

function instOf(id: string): InstrumentConfig {
  const inst = getInstrument(id);
  if (!inst) {
    throw new Error(`测试引用了不存在的标的: ${id}`);
  }
  return inst;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

/** 用固定响应体打桩 fetch,返回 mock 以便断言请求 URL(calls[i][0])。 */
function stubJsonFetch(body: unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => jsonResponse(body));
  vi.stubGlobal("fetch", mock);
  return mock;
}

/**
 * 构造 Binance klines 行:[openTime, open, high, low, close, volume, closeTime, quoteVolume, ...]。
 * 全字符串体例与上游一致;末尾 4 段为上游固定填充字段(本源不消费)。
 */
function row(
  openTime: string,
  open: string,
  high: string,
  low: string,
  close: string,
  volume: string,
  quoteVolume: string
): string[] {
  return [openTime, open, high, low, close, volume, "0", quoteVolume, "0", "0", "0", "0"];
}

/** 2024-01-01T00:00:00Z / 2024-01-02T00:00:00Z 的 openTime(毫秒,UTC)。 */
const T_20240101 = 1_704_067_200_000;
const T_20240102 = 1_704_153_600_000;
const T_20240103 = 1_704_240_000_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchKlines 请求参数", () => {
  it("interval 映射:day→1d / week→1w / month→1M;symbol=PAXGUSDT、limit=1000 固定", async () => {
    const mock = stubJsonFetch([]);
    const periods: KlinePeriod[] = ["day", "week", "month"];
    for (const period of periods) {
      await fetchKlines(instOf("xau"), period, {});
    }
    const urls = mock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toContain("https://data-api.binance.vision/api/v3/klines?");
    expect(new URL(urls[0]).searchParams.get("interval")).toBe("1d");
    expect(new URL(urls[1]).searchParams.get("interval")).toBe("1w");
    expect(new URL(urls[2]).searchParams.get("interval")).toBe("1M");
    for (const url of urls) {
      expect(new URL(url).searchParams.get("symbol")).toBe("PAXGUSDT");
      expect(new URL(url).searchParams.get("limit")).toBe("1000");
    }
  });

  it("范围查询:beg 转当日 UTC 零点毫秒拼 startTime;end 不拼上游参数(解析后过滤)", async () => {
    const mock = stubJsonFetch([]);
    await fetchKlines(instOf("gc"), "day", { beg: "20250901", end: "20250910", limit: 5000 });
    const url = new URL(String(mock.mock.calls[0][0]));
    // 2025-09-01T00:00:00Z = 1756684800000。
    expect(url.searchParams.get("startTime")).toBe("1756684800000");
    expect(url.searchParams.get("endTime")).toBeNull();
  });

  it("非范围查询:不拼 startTime(取「最近 1000 根」由解析侧按 limit 切片)", async () => {
    const mock = stubJsonFetch([]);
    await fetchKlines(instOf("xau"), "day", { limit: 50 });
    expect(new URL(String(mock.mock.calls[0][0])).searchParams.get("startTime")).toBeNull();
  });

  it("配置缺失:au9999(上金所合约)不支持本源 → 抛 MarketError,不发请求(也不应调用)", async () => {
    const mock = stubJsonFetch([]);
    await expect(fetchKlines(instOf("au9999"), "day", {})).rejects.toBeInstanceOf(MarketError);
    expect(mock).not.toHaveBeenCalled();
    expect(supportsPaxg(instOf("au9999"))).toBe(false);
    expect(supportsPaxg(instOf("xau"))).toBe(true);
    expect(supportsPaxg(instOf("gc"))).toBe(true);
    expect(supportsPaxg(instOf("sh000001"))).toBe(false);
  });

  it("host 参数忽略:传入也仍打默认单域名(无轮换语义,签名与东财源对齐)", async () => {
    const mock = stubJsonFetch([]);
    await fetchKlines(instOf("xau"), "day", {}, "https://mirror.example.com");
    expect(String(mock.mock.calls[0][0])).toMatch(/^https:\/\/data-api\.binance\.vision\//);
  });

  it("网络失败:fetchJson reject(超时 / 非 2xx)原样透传,由 facade 兜底", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "x" }, 503))
    );
    await expect(fetchKlines(instOf("xau"), "day", {})).rejects.toThrow("HTTP 503");
  });
});

describe("行映射与解析", () => {
  it("实测体例:全字符串数值 → Number;time 取 openTime 的 UTC 日历日;quoteVolume → amount", async () => {
    stubJsonFetch([
      row(String(T_20240101), "2035.20", "2040.00", "2030.10", "2038.50", "12.34", "25151.79")
    ]);
    const page = await fetchKlines(instOf("xau"), "day", {});
    expect(page.bars[0]).toEqual({
      time: "2024-01-01",
      open: 2035.2,
      close: 2038.5,
      high: 2040,
      low: 2030.1,
      volume: 12.34,
      amount: 25151.79,
      amplitudePct: null
    });
    expect(page.source).toBe("paxg");
    expect(page.hasMore).toBe(false);
  });

  it("UTC 日期转换:UTC 23:59:59.999 的 openTime 仍归 UTC 当日(本地时区 +8 会错成次日)", () => {
    // 1756771199999 = 2025-09-01T23:59:59.999Z:UTC 日历日为 2025-09-01,
    // 北京时间已是 09-02 07:59:59.999 —— 若误用本地 getFullYear/Month/Date 会得 "2025-09-02"。
    const page = parseKlinePayload(
      [row("1756771199999", "1", "1", "1", "1", "0", "0")],
      200,
      false
    );
    expect(page.bars[0]?.time).toBe("2025-09-01");
  });

  it("振幅现算:(高-低)/前收×100 保留两位;首根 null;前收 0 → null(不产生 Infinity)", () => {
    const page = parseKlinePayload(
      [
        row(String(T_20240101), "100", "102", "98", "101", "1", "1"),
        row(String(T_20240102), "101", "105", "100", "103", "1", "1"),
        row(String(T_20240103), "0", "0", "0", "0", "1", "1"),
        row(String(T_20240103 + 86_400_000), "0", "6", "0", "0", "1", "1")
      ],
      200,
      false
    );
    // 第 2 根:(105-100)/101×100 = 4.95;第 3 根高低相等 → 0(合法零值);
    // 第 4 根前收(第 3 根 close)为 0 → null(不产生 Infinity)。
    expect(page.bars.map((bar) => bar.amplitudePct)).toEqual([null, 4.95, 0, null]);
  });

  it("量额缺失 / 非法 → null;volume 与 amount 为 0 是合法零值保留", () => {
    const page = parseKlinePayload(
      [
        row(String(T_20240101), "1", "1", "1", "1", "0", "0"),
        row(String(T_20240102), "1", "1", "1", "1", "-", "")
      ],
      200,
      false
    );
    expect(page.bars[0]).toMatchObject({ volume: 0, amount: 0 });
    expect(page.bars[1]).toMatchObject({ volume: null, amount: null });
  });

  it("非法状态:非数组响应 → 空 page;行非数组 / 段数不足 / openTime 非数值的行跳过", async () => {
    stubJsonFetch({ code: -1121, msg: "Invalid symbol." });
    await expect(fetchKlines(instOf("xau"), "day", {})).resolves.toEqual({
      bars: [],
      hasMore: false,
      source: "paxg"
    });

    const page = parseKlinePayload(
      [
        "not-an-array",
        ["1704067200000", "1", "1"],
        row("bad-time", "1", "1", "1", "1", "0", "0"),
        row(String(T_20240101), "1", "1", "1", "1", "0", "0")
      ],
      200,
      false
    );
    expect(page.bars).toHaveLength(1);
    expect(page.bars[0]?.time).toBe("2024-01-01");
  });

  it("非范围查询:按 KlineRange.limit 保留最近根(limit 2 → 末 2 根)", async () => {
    stubJsonFetch([
      row(String(T_20240101), "1", "1", "1", "1", "0", "0"),
      row(String(T_20240102), "1", "1", "1", "1", "0", "0"),
      row(String(T_20240103), "1", "1", "1", "1", "0", "0")
    ]);
    const page = await fetchKlines(instOf("xau"), "day", { limit: 2 });
    expect(page.bars.map((bar) => bar.time)).toEqual(["2024-01-02", "2024-01-03"]);
  });

  it("范围查询:不按 limit 切片(beg 存在即按区间返回),并按 end 过滤 ≤end 的行", async () => {
    stubJsonFetch([
      row(String(T_20240101), "1", "1", "1", "1", "0", "0"),
      row(String(T_20240102), "1", "1", "1", "1", "0", "0"),
      row(String(T_20240103), "1", "1", "1", "1", "0", "0"),
      row(String(T_20240103 + 86_400_000), "1", "1", "1", "1", "0", "0")
    ]);
    const page = await fetchKlines(instOf("xau"), "day", {
      beg: "20240101",
      end: "20240103",
      limit: 2
    });
    expect(page.bars.map((bar) => bar.time)).toEqual(["2024-01-01", "2024-01-02", "2024-01-03"]);
    expect(page.hasMore).toBe(false);
  });
});
