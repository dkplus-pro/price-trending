// 行情请求闸门与原生 fetch 封装。
//
// 背景(为什么需要它):东财的 kline / stock 端点连续快发会被限流,表现为连接被断(HTTP 000),
// 约 40–60s 才恢复;因此所有真实请求都经本模块的调度器:并发闸门限制同时在飞的数量,
// 失败按退避间隔重试,并在重试时轮换域名(降低同一域名连续命中限流的概率)。
// 腾讯快照为 GBK 编码,故另提供 arrayBuffer 通道,由源实现交给 TextDecoder("gbk") 解码。
//
// 超时:一律用 AbortController(timeoutMs 缺省 10s),超时与网络错误都拒绝该次尝试,
// 由调度器的退避重试决定是否再试。

/** 单个任务的调度参数。 */
export interface ScheduleOptions {
  /** 可用域名列表(至少一个);第 i 次尝试用 hosts[i % hosts.length] 轮换。 */
  hosts: string[];
  /** 重试次数(不含首次);缺省 2,即最多 3 次尝试。 */
  retries?: number;
  /** 退避间隔(毫秒):第 i 次失败后等待 backoffMs[min(i, 长度-1)];缺省 [800, 2000]。 */
  backoffMs?: readonly [number, number];
}

/** 行情调度器:并发闸门 + 域名轮换 + 退避重试。 */
export interface MarketScheduler {
  /** 执行一次取数任务(含重试);task 收到本轮应使用的域名,最终失败抛最后一次错误。 */
  schedule<T>(task: (host: string) => Promise<T>, options: ScheduleOptions): Promise<T>;
}

/** 调度器配置。 */
export interface MarketSchedulerOptions {
  /** 同时执行的任务数上限;缺省 2。 */
  concurrency?: number;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS: readonly [number, number] = [800, 2000];
const DEFAULT_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 创建调度器:并发闸门按队列 FIFO 放行,同一时刻最多 concurrency 个任务在执行;
 * 每个「尝试」单独占用闸门(退避等待不占坑,重试也不长期霸占名额)。
 */
export function createMarketScheduler(options: MarketSchedulerOptions = {}): MarketScheduler {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
  let active = 0;
  const waiters: Array<() => void> = [];

  const release = (): void => {
    const next = waiters.shift();
    if (next) {
      // 名额直接移交给队首等待者(active 不减,由被移交方继续持有)。
      next();
      return;
    }
    active -= 1;
  };

  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (active < concurrency) {
        active += 1;
        resolve();
        return;
      }
      waiters.push(() => {
        resolve();
      });
    });

  return {
    async schedule<T>(task: (host: string) => Promise<T>, opts: ScheduleOptions): Promise<T> {
      const { hosts } = opts;
      if (hosts.length === 0) {
        throw new Error("schedule: hosts 不能为空(轮换列表至少需要一个域名)");
      }
      const retries = Math.max(0, opts.retries ?? DEFAULT_RETRIES);
      const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
      let lastError: unknown;

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const host = hosts[attempt % hosts.length];
        await acquire();
        try {
          return await task(host);
        } catch (error) {
          lastError = error;
        } finally {
          release();
        }
        if (attempt < retries) {
          await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(`schedule: 重试 ${retries} 次后仍失败(${readErrorMessage(lastError)})`);
    }
  };
}

/** 带超时的原生 fetch(共用入口):超时经 AbortController 中止,信号已中止时抛超时错误。 */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, credentials: "omit" });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`请求超时(${timeoutMs}ms): ${url}`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 取 JSON(东财接口):非 2xx 或响应体非合法 JSON 都抛错,由调用方决定兜底。 */
export async function fetchJson<T = unknown>(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const response = await fetchWithTimeout(url, timeoutMs);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`响应不是合法 JSON: ${url}`);
  }
}

/** 取二进制(腾讯 GBK 快照):非 2xx 抛错;解码由调用方处理。 */
export async function fetchArrayBuffer(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ArrayBuffer> {
  const response = await fetchWithTimeout(url, timeoutMs);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  return response.arrayBuffer();
}
