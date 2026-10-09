// usePageQuotes(页面级批量快照编排)用例:mock facade 的 getQuotes,只验证编排语义。
//
// 六类边界覆盖:空值(首轮 quotes 为 undefined、行情缺失 id 的 quoteMap 无项)、
// 零值(price=0 是合法行情,不进错误态)、越界/配置缺失(ids 含未注册 id 被跳过)、
// 网络失败(getQuotes 整体 reject → 页面级 error + refresh 可恢复)、
// 非法状态(刷新与首轮并发、刷新期间不置 loading);数据源跟随全局筛选栏(中央 store)。
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetQuotes, requestOptions } = vi.hoisted(() => ({
  mockGetQuotes: vi.fn(),
  // useRequest 入参回放:断言轮询参数与 refreshDeps 的引用稳定性。
  requestOptions: [] as Record<string, unknown>[]
}));

// 只 mock 用到的能力,其余导出(facade 的兜底链)不进本用例。
vi.mock("../../src/api/market/index", () => ({ getQuotes: mockGetQuotes }));

// 部分 mock ahooks:useRequest 仍走真实实现,只额外记录每次渲染的 options。
vi.mock("ahooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ahooks")>();
  const useRequestSpy = (service: unknown, options?: unknown): unknown => {
    requestOptions.push((options ?? {}) as Record<string, unknown>);
    return (actual.useRequest as unknown as (s: unknown, o?: unknown) => unknown)(service, options);
  };
  return { ...actual, useRequest: useRequestSpy };
});

import { GOLD_IDS, INDEX_IDS } from "../../src/api/market/config";
import { MarketError } from "../../src/api/market/types";
import type { InstrumentConfig, Quote } from "../../src/api/market/types";
import { QUOTE_POLL_INTERVAL_MS, usePageQuotes } from "../../src/components/market/use-page-quotes";
import type { MarketSource } from "../../src/store/market-filter";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function quoteOf(instrumentId: string, price: number | null, patch: Partial<Quote> = {}): Quote {
  return {
    instrumentId,
    price,
    change: 1,
    changePct: 1,
    amplitudePct: 1,
    open: 1,
    high: 1,
    low: 1,
    prevClose: 1,
    volume: 1,
    amount: 1,
    time: 1_700_000_000,
    source: "eastmoney",
    ...patch
  };
}

function lastRequestOptions(): Record<string, unknown> {
  const options = requestOptions[requestOptions.length - 1];
  if (options === undefined) {
    throw new Error("useRequest 尚未被调用");
  }
  return options;
}

beforeEach(() => {
  vi.clearAllMocks();
  requestOptions.length = 0;
});

describe("usePageQuotes 轮询参数", () => {
  it("15s 轮询 + 页面隐藏暂停,refreshDeps 绑定稳定的 instruments 引用与 source", async () => {
    mockGetQuotes.mockResolvedValue([]);
    const { rerender } = renderHook(() => usePageQuotes(INDEX_IDS, "auto"));
    // 先让首轮取数落地,避免断言期间仍有未包裹 act 的状态更新。
    await act(async () => {});

    expect(QUOTE_POLL_INTERVAL_MS).toBe(15_000);
    expect(lastRequestOptions().pollingInterval).toBe(15_000);
    expect(lastRequestOptions().pollingWhenHidden).toBe(false);

    const firstDeps = lastRequestOptions().refreshDeps as unknown[];
    expect(firstDeps).toEqual([expect.anything(), "auto"]);
    // 重渲染(未改 ids / source):instruments 引用必须不变,否则轮询会被重置。
    rerender();
    await act(async () => {});
    expect((lastRequestOptions().refreshDeps as unknown[])[0]).toBe(firstDeps[0]);
  });

  it("数据源跟随选择:auto 传 undefined,指定源透传 { source };source 变化立即重取", async () => {
    mockGetQuotes.mockResolvedValue([]);
    const { rerender } = renderHook(
      ({ source }: { source: MarketSource }) => usePageQuotes(INDEX_IDS, source),
      { initialProps: { source: "auto" as MarketSource } }
    );
    await waitFor(() => expect(mockGetQuotes).toHaveBeenCalledTimes(1));
    expect(mockGetQuotes.mock.calls[0][1]).toBeUndefined();

    rerender({ source: "tencent" });
    await waitFor(() => expect(mockGetQuotes).toHaveBeenCalledTimes(2));
    expect(mockGetQuotes.mock.calls[1][1]).toEqual({ source: "tencent" });
    expect((lastRequestOptions().refreshDeps as unknown[])[1]).toBe("tencent");

    rerender({ source: "eastmoney" });
    await waitFor(() => expect(mockGetQuotes).toHaveBeenCalledTimes(3));
    expect(mockGetQuotes.mock.calls[2][1]).toEqual({ source: "eastmoney" });
  });

  it("ids 传字面量数组(每次渲染新引用)也不重复取数:instruments 按内容记忆化", async () => {
    mockGetQuotes.mockResolvedValue([]);
    const { result, rerender } = renderHook(() => usePageQuotes(["sh000001", "sz399006"], "auto"));
    await waitFor(() => expect(mockGetQuotes).toHaveBeenCalledTimes(1));

    // 无内容记忆化时,字面量数组会让 refreshDeps 每帧变化 → 取数/渲染死循环(实测 OOM)。
    rerender();
    rerender();
    expect(mockGetQuotes).toHaveBeenCalledTimes(1);
    expect(result.current.instruments.map((instrument) => instrument.id)).toEqual([
      "sh000001",
      "sz399006"
    ]);
  });
});

describe("usePageQuotes 快照分发", () => {
  it("按 GOLD_IDS 派生三标的,quoteMap 按 instrumentId 分发;首轮响应前 loading 为 true", async () => {
    const deferred = createDeferred<Quote[]>();
    mockGetQuotes.mockReturnValue(deferred.promise);
    const { result } = renderHook(() => usePageQuotes(GOLD_IDS, "auto"));

    // 空值边界:首轮未回来时 quotes 为 undefined,错误为 null,loading 才为 true。
    expect(result.current.instruments.map((instrument) => instrument.id)).toEqual([...GOLD_IDS]);
    expect(result.current.quotes).toBeUndefined();
    expect(result.current.quoteMap.size).toBe(0);
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    // 取数入参 = 派生后的配置数组(顺序与 GOLD_IDS 一致)。
    expect((mockGetQuotes.mock.calls[0][0] as InstrumentConfig[]).map((i) => i.id)).toEqual([
      ...GOLD_IDS
    ]);

    await act(async () => {
      deferred.resolve([
        quoteOf("au9999", 782.5),
        quoteOf("xau", 2652.4, { source: "gold-api" }),
        quoteOf("gc", 2698)
      ]);
      await deferred.promise;
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.quoteMap.get("au9999")?.price).toBe(782.5);
    expect(result.current.quoteMap.get("xau")?.source).toBe("gold-api");
    expect(result.current.quotes).toHaveLength(3);
  });

  it("ids 含未注册 id:配置缺失项被跳过,取数只带有效标的(不炸)", async () => {
    mockGetQuotes.mockResolvedValue([quoteOf("sh000001", 3047.35)]);
    const { result } = renderHook(() => usePageQuotes(["sh000001", "not-registered"], "eastmoney"));

    expect(result.current.instruments.map((instrument) => instrument.id)).toEqual(["sh000001"]);
    await waitFor(() => expect(result.current.quoteMap.size).toBe(1));
    expect((mockGetQuotes.mock.calls[0][0] as InstrumentConfig[]).map((i) => i.id)).toEqual([
      "sh000001"
    ]);
    // 指定源同样透传到 facade(不受「配置缺失项被跳过」影响)。
    expect(mockGetQuotes.mock.calls[0][1]).toEqual({ source: "eastmoney" });
    expect(result.current.error).toBeNull();
  });
});

describe("usePageQuotes 错误与刷新", () => {
  it("getQuotes 整体失败:页面级 error + 可刷新恢复(price 0 不被误判为缺失)", async () => {
    mockGetQuotes.mockRejectedValueOnce(new MarketError("tencent", "行情获取失败(全部来源不可用)"));
    const { result } = renderHook(() => usePageQuotes(GOLD_IDS, "auto"));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toContain("全部来源不可用");
    expect(result.current.loading).toBe(false);
    expect(result.current.quotes).toBeUndefined();

    // 零值边界:price=0 是合法行情,facade 也用它区分「缺失(price=null)」。
    mockGetQuotes.mockResolvedValueOnce([quoteOf("au9999", 0)]);
    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.quoteMap.get("au9999")?.price).toBe(0));
    expect(result.current.error).toBeNull();
  });

  it("刷新期间 loading 保持 false(轮询不闪骨架),新数据落地后覆盖旧值", async () => {
    mockGetQuotes.mockResolvedValueOnce([quoteOf("au9999", 782.5)]);
    const { result } = renderHook(() => usePageQuotes(GOLD_IDS, "auto"));
    await waitFor(() => expect(result.current.quoteMap.size).toBe(1));

    const deferred = createDeferred<Quote[]>();
    mockGetQuotes.mockReturnValueOnce(deferred.promise);
    act(() => {
      result.current.refresh();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.quoteMap.get("au9999")?.price).toBe(782.5);

    await act(async () => {
      deferred.resolve([quoteOf("au9999", 790.25)]);
      await deferred.promise;
    });
    expect(result.current.quoteMap.get("au9999")?.price).toBe(790.25);
    expect(mockGetQuotes).toHaveBeenCalledTimes(2);
  });
});
