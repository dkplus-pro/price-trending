// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMarketScheduler, fetchArrayBuffer, fetchJson } from "../../src/api/market/throttle";

// 调度器:并发闸门(≤2)、域名轮换、退避重试、最终失败语义;fetch 封装:超时/非 2xx/坏 JSON。
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

type Resolver = (value: string) => void;

describe("createMarketScheduler 并发闸门", () => {
  it("同时执行的任务不超过 concurrency(队列补位)", async () => {
    const scheduler = createMarketScheduler({ concurrency: 2 });
    let active = 0;
    let maxActive = 0;
    const resolvers: Resolver[] = [];
    const task = (host: string): Promise<string> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<string>((resolve) => {
        resolvers.push((value) => {
          active -= 1;
          resolve(`${host}:${value}`);
        });
      });
    };

    const pending = ["a", "b", "c", "d"].map(() =>
      scheduler.schedule(task, { hosts: ["push2.eastmoney.com"] })
    );
    await flush();
    expect(maxActive).toBe(2);
    expect(resolvers).toHaveLength(2);

    resolvers[0]("1");
    await flush();
    expect(maxActive).toBe(2);
    expect(resolvers).toHaveLength(3);

    resolvers[1]("2");
    resolvers[2]("3");
    await flush();
    expect(resolvers).toHaveLength(4);

    resolvers[3]("4");
    await expect(Promise.all(pending)).resolves.toEqual([
      "push2.eastmoney.com:1",
      "push2.eastmoney.com:2",
      "push2.eastmoney.com:3",
      "push2.eastmoney.com:4"
    ]);
    expect(maxActive).toBe(2);
  });

  it("concurrency 缺省为 2", async () => {
    const scheduler = createMarketScheduler();
    let active = 0;
    let maxActive = 0;
    const resolvers: Resolver[] = [];
    const task = (): Promise<string> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<string>((resolve) => {
        resolvers.push((value) => {
          active -= 1;
          resolve(value);
        });
      });
    };
    const pending = ["a", "b", "c"].map(() => scheduler.schedule(task, { hosts: ["h1"] }));
    await flush();
    expect(maxActive).toBe(2);
    expect(resolvers).toHaveLength(2);

    resolvers[0]("0");
    await flush();
    resolvers[1]("1");
    await flush();
    expect(resolvers).toHaveLength(3);

    resolvers[2]("2");
    await expect(Promise.all(pending)).resolves.toEqual(["0", "1", "2"]);
    expect(maxActive).toBe(2);
  });
});

describe("createMarketScheduler 重试与域名轮换", () => {
  it("按 hosts 顺序轮换(第 i 次尝试用 hosts[i % len])", async () => {
    const scheduler = createMarketScheduler({ concurrency: 2 });
    const usedHosts: string[] = [];
    const task = async (host: string): Promise<string> => {
      usedHosts.push(host);
      if (usedHosts.length < 4) {
        throw new Error(`尝试 ${usedHosts.length} 被限流`);
      }
      return "ok";
    };
    await expect(
      scheduler.schedule(task, { hosts: ["h1", "h2"], retries: 3, backoffMs: [0, 0] })
    ).resolves.toBe("ok");
    expect(usedHosts).toEqual(["h1", "h2", "h1", "h2"]);
  });

  it("第 3 次成功:前两次退避间隔为 backoffMs(800 / 2000)", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createMarketScheduler();
      const attemptTimes: number[] = [];
      const task = async (): Promise<string> => {
        attemptTimes.push(Date.now());
        if (attemptTimes.length < 3) {
          throw new Error("HTTP 000");
        }
        return "ok";
      };
      const pending = scheduler.schedule(task, { hosts: ["h1"], backoffMs: [800, 2000] });
      await vi.advanceTimersByTimeAsync(0);
      expect(attemptTimes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(800);
      expect(attemptTimes).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(pending).resolves.toBe("ok");
      expect(attemptTimes[1] - attemptTimes[0]).toBe(800);
      expect(attemptTimes[2] - attemptTimes[1]).toBe(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries 缺省 2(共 3 次尝试),全部失败抛最后一次错误", async () => {
    const scheduler = createMarketScheduler();
    const errors = [new Error("第一次"), new Error("第二次"), new Error("第三次")];
    const task = vi.fn(async (): Promise<string> => {
      throw errors[task.mock.calls.length - 1];
    });
    await expect(scheduler.schedule(task, { hosts: ["h1"], backoffMs: [0, 0] })).rejects.toBe(
      errors[2]
    );
    expect(task).toHaveBeenCalledTimes(3);
  });

  it("retries 为 0 时只试一次", async () => {
    const scheduler = createMarketScheduler();
    const task = vi.fn(async (): Promise<string> => {
      throw new Error("一次即失败");
    });
    await expect(scheduler.schedule(task, { hosts: ["h1"], retries: 0 })).rejects.toThrow(
      "一次即失败"
    );
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("非 Error 抛出物包装为带重试次数的错误", async () => {
    const scheduler = createMarketScheduler();
    await expect(
      scheduler.schedule(
        async () => {
          throw "boom";
        },
        { hosts: ["h1"], retries: 0 }
      )
    ).rejects.toThrow(/重试 0 次后仍失败/);
  });

  it("hosts 为空拒绝执行", async () => {
    const scheduler = createMarketScheduler();
    const task = vi.fn();
    await expect(scheduler.schedule(task, { hosts: [] })).rejects.toThrow(/hosts 不能为空/);
    expect(task).not.toHaveBeenCalled();
  });

  it("背压释放后新任务可立即执行(不残留占位)", async () => {
    const scheduler = createMarketScheduler({ concurrency: 1 });
    await expect(scheduler.schedule(async () => "first", { hosts: ["h1"] })).resolves.toBe("first");
    await expect(scheduler.schedule(async () => "second", { hosts: ["h1"] })).resolves.toBe(
      "second"
    );
  });
});

interface FetchStub {
  (input: string, init?: RequestInit): Promise<Response>;
}

function stubFetch(impl: FetchStub): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

describe("fetchJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("2xx 返回解析后的 JSON,并带 credentials/signal 选项", async () => {
    const mock = stubFetch(async () => jsonResponse({ data: { price: 1 } }));
    await expect(fetchJson<{ data: { price: number } }>("https://example.com/a")).resolves.toEqual({
      data: { price: 1 }
    });
    expect(mock).toHaveBeenCalledWith(
      "https://example.com/a",
      expect.objectContaining({ credentials: "omit", signal: expect.anything() })
    );
  });

  it("超时经 AbortController 中止并抛超时错误", async () => {
    stubFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        })
    );
    await expect(fetchJson("https://example.com/slow", 5)).rejects.toThrow(/请求超时\(5ms\)/);
  });

  it("网络错误(未超时)原样抛出", async () => {
    const networkError = new Error("network down");
    stubFetch(async () => {
      throw networkError;
    });
    await expect(fetchJson("https://example.com/down")).rejects.toBe(networkError);
  });

  it("非 2xx 抛 HTTP 状态错误", async () => {
    stubFetch(async () => jsonResponse({}, 500));
    await expect(fetchJson("https://example.com/500")).rejects.toThrow(/HTTP 500/);
  });

  it("响应体不是合法 JSON 抛解析错误", async () => {
    stubFetch(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token");
          }
        }) as unknown as Response
    );
    await expect(fetchJson("https://example.com/bad-json")).rejects.toThrow(/不是合法 JSON/);
  });
});

describe("fetchArrayBuffer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("2xx 返回二进制体(腾讯 GBK 快照通道)", async () => {
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    stubFetch(
      async () =>
        ({
          ok: true,
          status: 200,
          arrayBuffer: async () => buffer
        }) as unknown as Response
    );
    await expect(fetchArrayBuffer("https://qt.gtimg.cn/q=hf_XAU")).resolves.toBe(buffer);
  });

  it("非 2xx 抛 HTTP 状态错误", async () => {
    stubFetch(
      async () =>
        ({
          ok: false,
          status: 403,
          arrayBuffer: async () => new ArrayBuffer(0)
        }) as unknown as Response
    );
    await expect(fetchArrayBuffer("https://qt.gtimg.cn/q=hf_XAU")).rejects.toThrow(/HTTP 403/);
  });
});
