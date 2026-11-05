// server 转发源(sources/server.ts)单测:mock MarketController(orval 生成物的单例,
// 经 vi.mock 替换 controllers.gen),用东财上游 JSON 夹具(与 eastmoney.test.ts 同源)驱动
// 「controller 返回上游 JSON → 复用东财解析函数」全链路。
// server 源是行情 auto 链主源(链路顺序用例见 index.test.ts);本文件聚焦源内行为:
// 参数拼装、解析复用与会话级可用性记忆。
//
// 覆盖六类边界:空值(空 insts 不发请求、data null → 空数据)、零值(XAU volume 0 保留)、
// 越界(limit 超 server 契约上限 2000 收敛)、配置缺失(静态托管无 server = 404 → 会话禁用)、
// 网络失败(无 response 的 axios 错误 → 会话禁用;非 axios 错误不禁用)、
// 非法状态(上游结构变形 → 空数据不抛)。
// 另覆盖:参数拼装(secids 顺序 / klt 映射 / fqt=0 / beg·end / lmt 收敛 / ndays)、
// 5xx 不禁用(上游限流可恢复)、禁用对 kline/trends 同样生效。
import { AxiosError, type AxiosResponse } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_KLINE_LIMIT, getInstrument } from "../../src/api/market/config";
import {
  fetchKlines,
  fetchQuotes,
  fetchTrends,
  resetServerUnavailableForTests
} from "../../src/api/market/sources/server";
import type { InstrumentConfig } from "../../src/api/market/types";
import { MarketError } from "../../src/api/market/types";
import klineDataNull from "./fixtures/eastmoney/kline-data-null.json";
import klineDayLmt5 from "./fixtures/eastmoney/kline-day-lmt5.json";
import trends1d from "./fixtures/eastmoney/trends-1d.json";
import trendsDataNull from "./fixtures/eastmoney/trends-data-null.json";
import trendsXau1d from "./fixtures/eastmoney/trends-xau-1d.json";
import ulistDataNull from "./fixtures/eastmoney/ulist-data-null.json";
import ulistSecidEcho from "./fixtures/eastmoney/ulist-secid-echo.json";

// MarketController 替身:server 源只消费 getMarketQuote / getMarketKline / getMarketTrends。
const marketApi = vi.hoisted(() => ({
  getMarketQuote: vi.fn(),
  getMarketKline: vi.fn(),
  getMarketTrends: vi.fn()
}));
vi.mock("../../src/api/controllers.gen", () => ({ MarketController: marketApi }));

function instOf(...ids: string[]): InstrumentConfig[] {
  return ids.map((id) => {
    const inst = getInstrument(id);
    if (!inst) {
      throw new Error(`测试引用了不存在的标的: ${id}`);
    }
    return inst;
  });
}

/** axios 形态的错误:status 缺省即「无 response 的网络错误」(server 不可达)。 */
function axiosErrorWithStatus(status?: number): AxiosError {
  return new AxiosError(
    status === undefined ? "Network Error" : `Request failed with status code ${status}`,
    status === undefined ? AxiosError.ERR_NETWORK : AxiosError.ERR_BAD_REQUEST,
    undefined,
    undefined,
    status === undefined ? undefined : ({ status } as unknown as AxiosResponse)
  );
}

beforeEach(() => {
  resetServerUnavailableForTests();
  marketApi.getMarketQuote.mockReset();
  marketApi.getMarketKline.mockReset();
  marketApi.getMarketTrends.mockReset();
});

describe("fetchQuotes 快照", () => {
  it("实测上游 JSON 复用东财解析:字段映射正确,Quote.source 仍记 eastmoney", async () => {
    marketApi.getMarketQuote.mockResolvedValue(ulistSecidEcho);
    const insts = instOf("au9999", "sh000001", "xau", "gc");

    const quotes = await fetchQuotes(insts);

    expect(quotes.map((quote) => quote.instrumentId)).toEqual(["sh000001", "au9999", "xau", "gc"]);
    expect(quotes[0]).toEqual({
      instrumentId: "sh000001",
      price: 3813.79,
      change: 1.89,
      changePct: 0.05,
      amplitudePct: 1.85,
      open: 3804.09,
      high: 3824.71,
      low: 3754.14,
      prevClose: 3811.9,
      volume: 535149921,
      amount: 888561198263.9,
      time: 1791531840,
      source: "eastmoney"
    });
    // 零值边界:XAU 的 f5 为 0(合法零值保留),f6 为 "-"(无值 → null)。
    expect(quotes[2]).toMatchObject({ price: 4191.93, volume: 0, amount: null });
  });

  it("参数拼装:secids 按入参顺序逗号拼接(与东财 ulist 同序)", async () => {
    marketApi.getMarketQuote.mockResolvedValue(ulistSecidEcho);

    await fetchQuotes(instOf("sh000001", "au9999", "xau"));

    expect(marketApi.getMarketQuote).toHaveBeenCalledTimes(1);
    expect(marketApi.getMarketQuote.mock.calls[0][0]).toEqual({
      secids: "1.000001,118.AU9999,122.XAU"
    });
  });

  it("空标的数组:直接返回 [],不发请求(空值边界)", async () => {
    await expect(fetchQuotes([])).resolves.toEqual([]);
    expect(marketApi.getMarketQuote).not.toHaveBeenCalled();
  });

  it("上游结构变形(data 为 null)→ 空数组,不抛异常(交给 facade 兜底)", async () => {
    marketApi.getMarketQuote.mockResolvedValue(ulistDataNull);

    await expect(fetchQuotes(instOf("au9999"))).resolves.toEqual([]);
  });

  it("404(静态托管无 server)→ 置位禁用:后续调用直接抛 MarketError 且不再打 controller", async () => {
    marketApi.getMarketQuote.mockRejectedValue(axiosErrorWithStatus(404));
    const insts = instOf("au9999");

    // 首次:错误原样透传(axios 错误),同时置位。
    await expect(fetchQuotes(insts)).rejects.toMatchObject({
      message: "Request failed with status code 404"
    });
    // 后续:快速跳过,不再请求。
    await expect(fetchQuotes(insts)).rejects.toBeInstanceOf(MarketError);
    await expect(fetchQuotes(insts)).rejects.toMatchObject({ source: "server" });
    expect(marketApi.getMarketQuote).toHaveBeenCalledTimes(1);
  });

  it("无 response 的网络错误(server 离线)→ 同样置位禁用", async () => {
    marketApi.getMarketQuote.mockRejectedValue(axiosErrorWithStatus());
    const insts = instOf("au9999");

    await expect(fetchQuotes(insts)).rejects.toMatchObject({ message: "Network Error" });
    await expect(fetchQuotes(insts)).rejects.toBeInstanceOf(MarketError);
    expect(marketApi.getMarketQuote).toHaveBeenCalledTimes(1);
  });

  it("5xx(上游被限流)→ 不禁用:下次轮询仍打 controller 且可成功(配置缺失可恢复边界)", async () => {
    marketApi.getMarketQuote
      .mockRejectedValueOnce(axiosErrorWithStatus(502))
      .mockResolvedValueOnce(ulistSecidEcho);
    const insts = instOf("au9999");

    await expect(fetchQuotes(insts)).rejects.toMatchObject({
      message: "Request failed with status code 502"
    });
    const quotes = await fetchQuotes(insts);

    expect(marketApi.getMarketQuote).toHaveBeenCalledTimes(2);
    expect(quotes[0]).toMatchObject({ instrumentId: "au9999", price: 904.48, source: "eastmoney" });
  });

  it("成功后保持可用:连续调用都正常发请求", async () => {
    marketApi.getMarketQuote.mockResolvedValue(ulistSecidEcho);
    const insts = instOf("au9999");

    await fetchQuotes(insts);
    await fetchQuotes(insts);

    expect(marketApi.getMarketQuote).toHaveBeenCalledTimes(2);
  });

  it("非 axios 错误:原样透传且不禁用(防御性保留,下次仍尝试)", async () => {
    marketApi.getMarketQuote.mockRejectedValue(new Error("boom"));
    const insts = instOf("au9999");

    await expect(fetchQuotes(insts)).rejects.toThrow("boom");
    await expect(fetchQuotes(insts)).rejects.toThrow("boom");
    expect(marketApi.getMarketQuote).toHaveBeenCalledTimes(2);
  });
});

describe("fetchKlines K 线", () => {
  it("解析与东财源一致:11 段取前 7 段 + 第 8 段振幅", async () => {
    marketApi.getMarketKline.mockResolvedValue(klineDayLmt5);

    const page = await fetchKlines(instOf("sh000001")[0], "day", { limit: 5 });

    expect(page.bars[0]).toEqual({
      time: "2026-09-28",
      open: 3795,
      close: 3799.5,
      high: 3805,
      low: 3782,
      volume: 482_000_000,
      amount: 691_000_000_000,
      amplitudePct: 0.61
    });
    expect(page.bars).toHaveLength(5);
    expect(page.hasMore).toBe(true);
  });

  it("参数拼装:klt 映射 101/102/103、fqt=0、lmt=limit;beg/end 缺省不传(server 缺省即东财 beg=0 语义)", async () => {
    marketApi.getMarketKline.mockResolvedValue(klineDayLmt5);
    const sh = instOf("sh000001")[0];

    await fetchKlines(sh, "day", {});
    expect(marketApi.getMarketKline.mock.calls[0][0]).toEqual({
      secid: "1.000001",
      klt: 101,
      fqt: 0,
      lmt: DEFAULT_KLINE_LIMIT
    });

    await fetchKlines(sh, "week", { limit: 5, end: "20260101" });
    expect(marketApi.getMarketKline.mock.calls[1][0]).toEqual({
      secid: "1.000001",
      klt: 102,
      fqt: 0,
      lmt: 5,
      end: "20260101"
    });

    await fetchKlines(instOf("sz399006")[0], "month", { limit: 3 });
    expect(marketApi.getMarketKline.mock.calls[2][0]).toEqual({
      secid: "0.399006",
      klt: 103,
      fqt: 0,
      lmt: 3
    });
  });

  it("范围查询:beg/end 透传,lmt 收敛到 server 契约上限 2000,hasMore 恒 false(不切片)", async () => {
    marketApi.getMarketKline.mockResolvedValue(klineDayLmt5);

    const page = await fetchKlines(instOf("sh000001")[0], "day", {
      beg: "20250901",
      end: "20260901",
      limit: 2
    });

    expect(marketApi.getMarketKline.mock.calls[0][0]).toEqual({
      secid: "1.000001",
      klt: 101,
      fqt: 0,
      lmt: 2000,
      beg: "20250901",
      end: "20260901"
    });
    // 直连源范围查询 lmt=5000,server 契约上限 2000;响应 5 根不切片、hasMore 恒 false。
    expect(page.bars).toHaveLength(5);
    expect(page.hasMore).toBe(false);
  });

  it("limit 超上限(越界边界)收敛到 2000;hasMore 按原 limit 判定", async () => {
    marketApi.getMarketKline.mockResolvedValue(klineDayLmt5);

    const page = await fetchKlines(instOf("sh000001")[0], "day", { limit: 3000 });

    expect(marketApi.getMarketKline.mock.calls[0][0]).toMatchObject({ lmt: 2000 });
    expect(page.bars).toHaveLength(5);
    expect(page.hasMore).toBe(false);
  });

  it("lmt 兜底切片:响应条数超 limit 时保留最近 limit 根并判定 hasMore(与直连同口径)", async () => {
    marketApi.getMarketKline.mockResolvedValue(klineDayLmt5);

    const page = await fetchKlines(instOf("sh000001")[0], "day", { limit: 2 });

    expect(page.bars.map((bar) => bar.time)).toEqual(["2026-10-08", "2026-10-09"]);
    expect(page.hasMore).toBe(true);
  });

  it("上游结构变形(data 为 null)→ { bars: [], hasMore: false },不抛异常", async () => {
    marketApi.getMarketKline.mockResolvedValue(klineDataNull);

    await expect(fetchKlines(instOf("sh000001")[0], "day", { limit: 5 })).resolves.toEqual({
      bars: [],
      hasMore: false
    });
  });
});

describe("fetchTrends 分时", () => {
  it("解析与东财源一致:prevClose + points 按段映射", async () => {
    marketApi.getMarketTrends.mockResolvedValue(trends1d);

    const trends = await fetchTrends(instOf("sh000001")[0], 1);

    expect(trends.prevClose).toBe(3811.9);
    expect(trends.points).toHaveLength(10);
    expect(trends.points[0]).toEqual({
      time: "2026-10-09 09:30",
      price: 3804.09,
      avgPrice: 3806.883,
      volume: 3_600_224,
      open: 3804.09,
      high: 3804.09,
      low: 3804.09
    });
  });

  it("hf_ 外盘(伦敦金)也能走 server:secid/ndays 透传,解析与直连一致", async () => {
    marketApi.getMarketTrends.mockResolvedValue(trendsXau1d);

    const trends = await fetchTrends(instOf("xau")[0], 5);

    expect(marketApi.getMarketTrends.mock.calls[0][0]).toEqual({ secid: "122.XAU", ndays: 5 });
    expect(trends.points.length).toBeGreaterThan(0);
  });

  it("参数拼装:ndays 透传(1 / 5)", async () => {
    marketApi.getMarketTrends.mockResolvedValue(trendsDataNull);

    await fetchTrends(instOf("sh000001")[0], 1);
    expect(marketApi.getMarketTrends.mock.calls[0][0]).toEqual({ secid: "1.000001", ndays: 1 });

    await fetchTrends(instOf("sz399006")[0], 5);
    expect(marketApi.getMarketTrends.mock.calls[1][0]).toEqual({ secid: "0.399006", ndays: 5 });
  });

  it("上游结构变形(data 为 null)→ { points: [], prevClose: null },不抛异常", async () => {
    marketApi.getMarketTrends.mockResolvedValue(trendsDataNull);

    await expect(fetchTrends(instOf("sh000001")[0], 1)).resolves.toEqual({
      points: [],
      prevClose: null
    });
  });
});

describe("会话级可用性记忆(三能力共享)", () => {
  it("quote 404 置位后,kline / trends 也直接抛 MarketError,不再打各自 controller", async () => {
    marketApi.getMarketQuote.mockRejectedValue(axiosErrorWithStatus(404));

    await expect(fetchQuotes(instOf("au9999"))).rejects.toMatchObject({
      message: "Request failed with status code 404"
    });
    await expect(fetchKlines(instOf("sh000001")[0], "day", {})).rejects.toBeInstanceOf(MarketError);
    await expect(fetchTrends(instOf("sh000001")[0], 1)).rejects.toBeInstanceOf(MarketError);
    expect(marketApi.getMarketKline).not.toHaveBeenCalled();
    expect(marketApi.getMarketTrends).not.toHaveBeenCalled();
  });

  it("重置钩子恢复可用:reset 后重新发请求", async () => {
    marketApi.getMarketQuote.mockRejectedValueOnce(axiosErrorWithStatus(404));
    await expect(fetchQuotes(instOf("au9999"))).rejects.toThrow();
    await expect(fetchQuotes(instOf("au9999"))).rejects.toBeInstanceOf(MarketError);
    expect(marketApi.getMarketQuote).toHaveBeenCalledTimes(1); // 第二次已被会话禁用跳过

    resetServerUnavailableForTests();
    marketApi.getMarketQuote.mockResolvedValueOnce(ulistSecidEcho);
    await expect(fetchQuotes(instOf("au9999"))).resolves.toHaveLength(1);
    expect(marketApi.getMarketQuote).toHaveBeenCalledTimes(2);
  });
});
