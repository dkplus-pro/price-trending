// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getInstrument } from "../../src/api/market/config";
import { fetchQuote } from "../../src/api/market/sources/gold-api";
import type { InstrumentConfig } from "../../src/api/market/types";
import { MarketError } from "../../src/api/market/types";

// gold-api 源单测(无网络):fixtures/gold-api/price-xau.json 是真实 curl 响应
// (`curl -s https://api.gold-api.com/price/XAU`);HTTP 层用 vi.stubGlobal("fetch", ...) 打桩。
function fixtureJson(name: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/gold-api/${name}`, import.meta.url)), "utf8")
  );
}

function inst(id: string): InstrumentConfig {
  const found = getInstrument(id);
  if (found === undefined) {
    throw new Error(`测试引用了不存在的标的: ${id}`);
  }
  return found;
}

type FetchStub = (input: string, init?: RequestInit) => Promise<Response>;

function stubFetch(impl: FetchStub): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function urlOf(mock: ReturnType<typeof vi.fn>, call = 0): string {
  return String(mock.mock.calls[call][0]);
}

const XAU = inst("xau");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gold-api fetchQuote", () => {
  it("正常响应:price 与 updatedAt(ISO → unix 秒),其余字段全 null,source 记 gold-api", async () => {
    const mock = stubFetch(async () => jsonResponse(fixtureJson("price-xau.json")));
    const quote = await fetchQuote(XAU);

    expect(urlOf(mock)).toBe("https://api.gold-api.com/price/XAU");
    expect(quote).toEqual({
      instrumentId: "xau",
      price: 4193.799805,
      change: null,
      changePct: null,
      amplitudePct: null,
      open: null,
      high: null,
      low: null,
      prevClose: null,
      volume: null,
      amount: null,
      // updatedAt "2026-10-09T07:50:10Z"。
      time: Date.parse("2026-10-09T07:50:10Z") / 1000,
      source: "gold-api"
    });
  });

  it("缺 price → price null(缺数据不当 0),其余字段照旧", async () => {
    stubFetch(async () => jsonResponse({ updatedAt: "2026-10-09T07:50:10Z" }));
    const quote = await fetchQuote(XAU);
    expect(quote).toMatchObject({ instrumentId: "xau", price: null, source: "gold-api" });
    expect(quote.time).toBe(Date.parse("2026-10-09T07:50:10Z") / 1000);
  });

  it("price 非数 / 响应整体变形 → price null 且不抛错(越界与非法状态边界)", async () => {
    stubFetch(async () => jsonResponse({ price: "abc" }));
    await expect(fetchQuote(XAU)).resolves.toMatchObject({ price: null });

    stubFetch(async () => jsonResponse(null));
    await expect(fetchQuote(XAU)).resolves.toMatchObject({ price: null, time: null });

    stubFetch(async () => jsonResponse([]));
    await expect(fetchQuote(XAU)).resolves.toMatchObject({ price: null });
  });

  it("price 为 0 是合法行情(零值边界)", async () => {
    stubFetch(async () => jsonResponse({ price: 0, updatedAt: "2026-10-09T07:50:10Z" }));
    await expect(fetchQuote(XAU)).resolves.toMatchObject({ price: 0 });
  });

  it("updatedAt 缺失 / 非法 → time null", async () => {
    stubFetch(async () => jsonResponse({ price: 4193.8 }));
    await expect(fetchQuote(XAU)).resolves.toMatchObject({ price: 4193.8, time: null });

    stubFetch(async () => jsonResponse({ price: 4193.8, updatedAt: "not-a-date" }));
    await expect(fetchQuote(XAU)).resolves.toMatchObject({ price: 4193.8, time: null });
  });

  it("无 goldApiSymbol 的标的 → 抛 MarketError 且不发请求(配置缺失边界)", async () => {
    const mock = stubFetch(async () => jsonResponse({ price: 1 }));
    await expect(fetchQuote(inst("au9999"))).rejects.toMatchObject({
      name: "MarketError",
      source: "gold-api",
      message: expect.stringContaining("黄金9999")
    });
    await expect(fetchQuote(inst("sh000001"))).rejects.toBeInstanceOf(MarketError);
    expect(mock).not.toHaveBeenCalled();
  });

  it("host 为裸域名时换掉默认前缀的 host;为完整 URL 前缀时原样拼接;空串按缺省", async () => {
    const mock = stubFetch(async () => jsonResponse(fixtureJson("price-xau.json")));
    await fetchQuote(XAU, "api.gold-api.com");
    expect(urlOf(mock, 0)).toBe("https://api.gold-api.com/price/XAU");

    await fetchQuote(XAU, "https://backup.example.com/price/");
    expect(urlOf(mock, 1)).toBe("https://backup.example.com/price/XAU");

    await fetchQuote(XAU, "");
    expect(urlOf(mock, 2)).toBe("https://api.gold-api.com/price/XAU");
  });

  it("网络失败原样抛出(reject 透传,不做源内兜底)", async () => {
    const networkError = new Error("network down");
    stubFetch(async () => {
      throw networkError;
    });
    await expect(fetchQuote(XAU)).rejects.toBe(networkError);
  });

  it("非 2xx 抛出 HTTP 状态错误", async () => {
    stubFetch(async () => ({ ok: false, status: 503 }) as unknown as Response);
    await expect(fetchQuote(XAU)).rejects.toThrow(/HTTP 503/);
  });
});
