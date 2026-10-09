// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getInstrument } from "../../src/api/market/config";
import {
  fetchKlines,
  fetchQuotes,
  fetchTrends,
  parseKlines,
  parseSnapshot,
  parseTrends
} from "../../src/api/market/sources/tencent";
import type { InstrumentConfig, Quote } from "../../src/api/market/types";
import { MarketError } from "../../src/api/market/types";

// 腾讯源单测(无网络):fixture 全部是真实 curl 响应——
// - fixtures/tencent/snapshot-mixed.gbk.b64 存原始 GBK 字节的 base64(注释行 # 开头),
//   用例先 Buffer.from(base64) → ArrayBuffer → TextDecoder("gbk") 解码,再喂给纯解析函数 / fetchQuotes;
// - kline-*.json / trends-*.json 为 UTF-8 JSON,直接读文件后 JSON.parse。
// HTTP 层用 vi.stubGlobal("fetch", ...) 打桩,解析层直接调用导出函数,两层分开验证。
function fixtureText(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/tencent/${name}`, import.meta.url)),
    "utf8"
  );
}

function fixtureJson(name: string): unknown {
  return JSON.parse(fixtureText(name));
}

/** git 快照 fixture 的原始字节(去掉注释行后的 base64 解码)。 */
function snapshotBytes(): Uint8Array {
  const base64 = fixtureText("snapshot-mixed.gbk.b64")
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("");
  return new Uint8Array(Buffer.from(base64, "base64"));
}

/** GBK 字节 → 解码后的响应文本(与源实现同路径)。 */
function snapshotText(): string {
  return new TextDecoder("gbk").decode(snapshotBytes());
}

/** 北京时间某时刻(YYYY-MM-DD HH:mm:ss)→ unix 秒;与源实现同算法,用于「日期缺失取当日」的断言。 */
function beijingTodayAt(date: string, hms: string): number {
  return Date.parse(`${date}T${hms}Z`) / 1000 - 8 * 3600;
}

/** 今日(北京时间)YYYY-MM-DD。 */
function beijingDate(offsetMs = 0): string {
  const now = new Date(Date.now() + offsetMs + 8 * 3600 * 1000);
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
}

function inst(id: string): InstrumentConfig {
  const found = getInstrument(id);
  if (found === undefined) {
    throw new Error(`测试引用了不存在的标的: ${id}`);
  }
  return found;
}

function instsOf(...ids: string[]): InstrumentConfig[] {
  return ids.map(inst);
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

function bufferResponse(bytes: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer as ArrayBuffer
  } as unknown as Response;
}

/** 取第 n 次 fetch 调用的 URL(断言 param 段拼装用)。 */
function urlOf(mock: ReturnType<typeof vi.fn>, call = 0): string {
  return String(mock.mock.calls[call][0]);
}

const XAU = inst("xau");
const SH000001 = inst("sh000001");

/** 合成内盘 v_ 字段数组:38 段(未赋值即下标不足),仅供 fixture 覆盖不到的边界形态。 */
function indexFields(values: string[] = []): string[] {
  const padded = new Array<string>(38).fill("");
  values.forEach((value, index) => {
    padded[index] = value;
  });
  return padded;
}

/** 合成为真实的 v_ 赋值串(~ 分隔)。 */
function snapshotLine(code: string, fields: string[]): string {
  return `v_${code}="${fields.join("~")}";`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchQuotes 腾讯快照", () => {
  it("GBK 字节经 TextDecoder('gbk') 解码后解析混批(sh000001 + hf_XAU 一次请求)", async () => {
    const mock = stubFetch(async () => bufferResponse(snapshotBytes()));
    const quotes = await fetchQuotes(instsOf("sh000001", "xau"));

    // 默认前缀 + 代码列表(与 insts 顺序一致)。
    expect(urlOf(mock)).toBe("https://qt.gtimg.cn/q=sh000001,hf_XAU");
    expect(quotes.map((quote) => quote.instrumentId)).toEqual(["sh000001", "xau"]);
    expect(quotes.every((quote) => quote.source === "tencent")).toBe(true);
  });

  it("内盘指数 ~ 体例字段映射:最新价/昨收/今开/涨跌/最高最低/量额(万元→元)", () => {
    const [quote] = parseSnapshot(snapshotText(), [SH000001]);
    expect(quote).toEqual({
      instrumentId: "sh000001",
      price: 3813.79,
      change: 1.89,
      changePct: 0.05,
      // 腾讯快照不提供振幅字段,由 high/low/prevClose 推导补齐:(3824.71 - 3754.14) / 3811.90 × 100。
      amplitudePct: 1.85,
      open: 3804.09,
      high: 3824.71,
      low: 3754.14,
      prevClose: 3811.9,
      volume: 535149921,
      // 响应的 88856120 单位为万元。
      amount: 888561200000,
      // 20261009155000(北京时间)→ unix 秒。
      time: Date.UTC(2026, 9, 9, 7, 50, 0) / 1000,
      source: "tencent"
    });
  });

  it("外盘逗号体例字段映射:量/额缺失为 null,时间由响应日期 + 时刻合成", () => {
    const [quote] = parseSnapshot(snapshotText(), [XAU]);
    expect(quote).toEqual({
      instrumentId: "xau",
      price: 4192.61,
      // 外盘响应无涨跌额字段,由 price - prevClose 推导补齐。
      change: 59.15,
      changePct: 1.43,
      // 振幅同样由 high/low/prevClose 推导补齐。
      amplitudePct: 1.85,
      open: 4134.26,
      high: 4207.46,
      low: 4130.9,
      prevClose: 4133.46,
      volume: null,
      amount: null,
      // 2026-10-09 15:49:00(北京时间)。
      time: Date.UTC(2026, 9, 9, 7, 49, 0) / 1000,
      source: "tencent"
    });
  });

  it("外盘时间边界:字段非法置 null、缺秒的 HH:mm 可解析、日期缺失按北京时间当日兜底", () => {
    const withoutTime =
      'v_hf_XAU="4192.61,1.43,4192.61,4192.96,4207.46,4130.90,,4133.46,4134.26,0,0,0,2026-10-09";';
    expect(parseSnapshot(withoutTime, [XAU])[0].time).toBeNull();

    const badTime =
      'v_hf_XAU="4192.61,1.43,4192.61,4192.96,4207.46,4130.90,bad,4133.46,4134.26,0,0,0,2026-10-09";';
    expect(parseSnapshot(badTime, [XAU])[0].time).toBeNull();

    // 下标不足:时间字段整段缺失。
    const short = parseSnapshot('v_hf_XAU="4192.61,1.43";', [XAU]);
    expect(short[0]).toMatchObject({ price: 4192.61, time: null, open: null, prevClose: null });

    // 只有 HH:mm(无秒)也按 0 秒解析。
    const shortTime =
      'v_hf_XAU="4192.61,1.43,4192.61,4192.96,4207.46,4130.90,15:49,4133.46,4134.26,0,0,0,2026-10-09";';
    expect(parseSnapshot(shortTime, [XAU])[0].time).toBe(
      Date.UTC(2026, 9, 9, 15, 49, 0) / 1000 - 8 * 3600
    );

    // 日期字段缺失 / 非法 → 取北京时间当日(调用前后两个候选值消除跨零点竞态)。
    const before = beijingDate();
    for (const line of [
      'v_hf_XAU="4192.61,1.43,4192.61,4192.96,4207.46,4130.90,15:49:00,4133.46,4134.26";',
      'v_hf_XAU="4192.61,1.43,4192.61,4192.96,4207.46,4130.90,15:49:00,4133.46,4134.26,0,0,0,2026/10/09";'
    ]) {
      const time = parseSnapshot(line, [XAU])[0].time;
      const after = beijingDate();
      expect([before, after].map((date) => beijingTodayAt(date, "15:49:00"))).toContain(time);
    }
  });

  it("无 tencentCode 的标的跳过:代码列表与结果都不含 au9999", async () => {
    const mock = stubFetch(async () => bufferResponse(snapshotBytes()));
    const quotes = await fetchQuotes(instsOf("sh000001", "au9999"));
    expect(urlOf(mock)).toBe("https://qt.gtimg.cn/q=sh000001");
    expect(quotes.map((quote) => quote.instrumentId)).toEqual(["sh000001"]);
  });

  it("全部标的都无 tencentCode → 不发请求直接返回空数组(空值边界)", async () => {
    const mock = stubFetch(async () => bufferResponse(snapshotBytes()));
    await expect(fetchQuotes(instsOf("au9999"))).resolves.toEqual([]);
    expect(mock).not.toHaveBeenCalled();
  });

  it("某 code 无 v_ 段 → 该标的不出现在结果(调用方继续兜底)", () => {
    // fixture 只有 sh000001 / hf_XAU,请求 sz399006 时该 code 无对应赋值串。
    const quotes = parseSnapshot(snapshotText(), instsOf("sz399006", "xau"));
    expect(quotes.map((quote) => quote.instrumentId)).toEqual(["xau"]);
  });

  it("空响应文本 → 空数组(空值边界)", () => {
    expect(parseSnapshot("", instsOf("sh000001", "xau"))).toEqual([]);
    expect(parseSnapshot("   \n", instsOf("sh000001"))).toEqual([]);
  });

  it("非法 v_ 串:最新价非数 → 跳过该标的且不抛错(非法状态边界)", () => {
    const brokenIndex = 'v_sh000001="1~上证指数~000001~abc~3811.90~3804.09";';
    const brokenForeign =
      'v_hf_XAU="not-a-number,1.43,,,,15:49:00,4133.46,4134.26,0,0,0,2026-10-09";';
    expect(parseSnapshot(brokenIndex, instsOf("sh000001"))).toEqual([]);
    expect(parseSnapshot(brokenForeign, instsOf("xau"))).toEqual([]);
  });

  it("字段缺失/非法只置 null,最新价有效仍返回(越界与部分坏行边界)", () => {
    // 下标不足:只有 0~5 段(最新价/昨收/今开),31/32/33/34/36/37 全部缺失。
    const short = snapshotLine("sh000001", ["1", "上证指数", "000001", "3813.79", "3811.90", "0"]);
    expect(parseSnapshot(short, instsOf("sh000001"))[0]).toMatchObject({
      price: 3813.79,
      // 今开 "0" 是合法字段值(零值边界,不当缺失)。
      open: 0,
      prevClose: 3811.9,
      // 涨跌额/涨跌幅字段缺失 → 由 price/prevClose 推导补齐。
      change: 1.89,
      changePct: 0.05,
      high: null,
      low: null,
      // high/low 不可得 → 振幅保持 null。
      amplitudePct: null,
      volume: null,
      amount: null,
      time: null
    });

    // 个别字段非法:只该字段 null,其余照常映射。
    const badHigh = indexFields();
    badHigh[3] = "3813.79";
    badHigh[4] = "3811.90";
    badHigh[5] = "3804.09";
    badHigh[30] = "bad-stamp";
    badHigh[32] = "abc";
    badHigh[33] = "3824.71";
    badHigh[34] = "3754.14";
    badHigh[36] = "535149921";
    badHigh[37] = "";
    const [quote] = parseSnapshot(snapshotLine("sh000001", badHigh), instsOf("sh000001"));
    expect(quote).toMatchObject({
      price: 3813.79,
      open: 3804.09,
      prevClose: 3811.9,
      // 字段 "abc" 解析失败 → null → 参与推导补齐(change 由 price/prevClose 推导,changePct 用推导后的 change)。
      change: 1.89,
      changePct: 0.05,
      high: 3824.71,
      low: 3754.14,
      amplitudePct: 1.85,
      volume: 535149921,
      amount: null,
      time: null
    });
  });

  it("price 为 0 是合法行情,标的不被跳过(零值边界)", () => {
    const [quote] = parseSnapshot('v_sh000001="1~上证指数~000001~0.00~0~0";', instsOf("sh000001"));
    expect(quote.price).toBe(0);
  });

  it("facade 轮换的腾讯自有裸域名落到端点默认前缀(域名由端点决定,不盲用轮换域名)", async () => {
    const mock = stubFetch(async () => bufferResponse(snapshotBytes()));
    // 快照务必走 qt.gtimg.cn:web.ifzq.gtimg.cn 只服务 K 线 / 分时(实测该域名请求快照返回 code 11)。
    await fetchQuotes(instsOf("sh000001"), "web.ifzq.gtimg.cn");
    expect(urlOf(mock, 0)).toBe("https://qt.gtimg.cn/q=sh000001");
  });

  it("未知裸域名换掉默认前缀的 host;完整 URL 前缀原样拼接", async () => {
    const mock = stubFetch(async () => bufferResponse(snapshotBytes()));
    await fetchQuotes(instsOf("sh000001"), "mirror.example.com");
    expect(urlOf(mock, 0)).toBe("https://mirror.example.com/q=sh000001");

    await fetchQuotes(instsOf("sh000001"), "https://qt.gtimg.cn/q=");
    expect(urlOf(mock, 1)).toBe("https://qt.gtimg.cn/q=sh000001");
  });

  it("网络失败原样抛出(reject 透传,不做源内兜底)", async () => {
    const networkError = new Error("network down");
    stubFetch(async () => {
      throw networkError;
    });
    await expect(fetchQuotes(instsOf("sh000001"))).rejects.toBe(networkError);
  });

  it("非 2xx 抛出 HTTP 状态错误", async () => {
    stubFetch(async () => ({ ok: false, status: 502 }) as unknown as Response);
    await expect(fetchQuotes(instsOf("sh000001"))).rejects.toThrow(/HTTP 502/);
  });
});

describe("腾讯快照缺失字段推导补齐", () => {
  it("指数体例:振幅为 null 时由 high/low/prevClose 推导补齐", () => {
    const fields = indexFields();
    fields[3] = "3813.79";
    fields[4] = "3811.90";
    fields[5] = "3804.09";
    fields[31] = "1.89";
    fields[32] = "0.05";
    fields[33] = "3824.71";
    fields[34] = "3754.14";
    const [quote] = parseSnapshot(snapshotLine("sh000001", fields), instsOf("sh000001"));
    expect(quote.amplitudePct).toBe(1.85);
    // 已解析到的涨跌额/涨跌幅原样保留,不参与推导。
    expect(quote.change).toBe(1.89);
    expect(quote.changePct).toBe(0.05);
  });

  it("外盘体例:涨跌额 / 涨跌幅 / 振幅缺失时全量推导补齐", () => {
    // 涨跌幅字段为空 → 与涨跌额、振幅一并推导(price/prevClose/high/low 均可解析)。
    const body =
      'v_hf_XAU="4192.61,,4192.61,4192.96,4207.46,4130.90,15:49:00,4133.46,4134.26,0,0,0,2026-10-09";';
    const [quote] = parseSnapshot(body, instsOf("xau"));
    expect(quote).toMatchObject({
      price: 4192.61,
      prevClose: 4133.46,
      // 4192.61 - 4133.46。
      change: 59.15,
      // 推导后的 change / prevClose × 100。
      changePct: 1.43,
      // (4207.46 - 4130.90) / 4133.46 × 100。
      amplitudePct: 1.85
    });
  });

  it("已解析到的值不被覆盖(推导只补 null)", () => {
    const fields = indexFields();
    fields[3] = "100";
    fields[4] = "50";
    // 与 price - prevClose 不一致,但已解析到 → 保留原值。
    fields[31] = "77";
    fields[32] = "9.99";
    fields[33] = "120";
    fields[34] = "40";
    const [quote] = parseSnapshot(snapshotLine("sh000001", fields), instsOf("sh000001"));
    // 振幅缺失 → 照常推导:(120 - 40) / 50 × 100。
    expect(quote).toMatchObject({ change: 77, changePct: 9.99, amplitudePct: 160 });
  });

  it("change 按标的 priceDecimals 四舍五入(COMEX 1 位)", () => {
    const body = 'v_hf_GC="4000.44,0,4000.44,4010.00,4005.00,3990.00,15:49:00,4000.00,3995.00";';
    const [quote] = parseSnapshot(body, instsOf("gc"));
    expect(quote.change).toBe(0.4);
  });

  it("prevClose 为 0 或缺失 / 字段不可得时保持 null(推导边界)", () => {
    // prevClose=0 是有限数:change 照常推导,涨跌幅 / 振幅因分母为 0 保持 null。
    const zeroPrev = indexFields();
    zeroPrev[3] = "3813.79";
    zeroPrev[4] = "0";
    zeroPrev[33] = "3824.71";
    zeroPrev[34] = "3754.14";
    const [zeroQuote] = parseSnapshot(snapshotLine("sh000001", zeroPrev), instsOf("sh000001"));
    expect(zeroQuote).toMatchObject({ change: 3813.79, changePct: null, amplitudePct: null });

    // prevClose / high / low 全部不可得 → 三个字段都保持 null。
    const missingFields = indexFields();
    missingFields[3] = "3813.79";
    const [missingQuote] = parseSnapshot(
      snapshotLine("sh000001", missingFields),
      instsOf("sh000001")
    );
    expect(missingQuote).toMatchObject({ change: null, changePct: null, amplitudePct: null });
  });
});

describe("fetchKlines 腾讯 K 线", () => {
  it("day:param 拼装 / 行映射 / amount 恒 null / 振幅按前收推导 / 多返回的一条被截断后 hasMore 为 true", async () => {
    const mock = stubFetch(async () => jsonResponse(fixtureJson("kline-day.json")));
    const page = await fetchKlines(SH000001, "day", { limit: 5 });

    expect(urlOf(mock)).toBe(
      "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,5,"
    );
    // fixture 真实返回 6 条(端点多给一条用于判断还有更早数据),按最新 5 条截断。
    expect(page.bars).toHaveLength(5);
    expect(page.hasMore).toBe(true);
    // 截断后首根(09-28)丢失前收 09-24 的收盘 → 振幅 null。
    expect(page.bars[0]).toEqual({
      time: "2026-09-28",
      open: 3878.41,
      close: 3823.62,
      high: 3878.41,
      low: 3806.67,
      volume: 452350675,
      amount: null,
      amplitudePct: null
    });
    // 10-09:前收 3811.90,振幅 (3824.71 - 3754.14) / 3811.90 × 100 = 1.851… → 1.85。
    expect(page.bars[4]).toEqual({
      time: "2026-10-09",
      open: 3804.09,
      close: 3813.79,
      high: 3824.71,
      low: 3754.14,
      volume: 535149921,
      amount: null,
      amplitudePct: 1.85
    });
  });

  it("振幅计算:首根 null、前收为 0 → null、(高-低)/前收×100 保留两位(手算)", () => {
    const payload = {
      data: {
        sh000001: {
          day: [
            // 首根:无前收 → null。
            ["2026-10-01", "100", "100", "105", "95", "1"],
            // 前收 100,high 105,low 95 → (105-95)/100×100 = 10.00。
            ["2026-10-02", "100", "100", "105", "95", "1"],
            // 前收仍是 100;本根收盘 0 是合法零值,照常推导 → 10。
            ["2026-10-03", "0", "0", "105", "95", "1"],
            // 前收 0 → null(不产生 Infinity)。
            ["2026-10-04", "100", "100", "105", "95", "1"],
            // 前收恢复有效 100 → 照常推导 10。
            ["2026-10-05", "100", "100", "105", "95", "1"],
            // 高=低 → 振幅 0 是合法零值,保留(不冒充缺失)。
            ["2026-10-06", "100", "100", "100", "100", "1"]
          ]
        }
      }
    };

    expect(
      parseKlines(payload, "sh000001", "day", 200).bars.map((bar) => bar.amplitudePct)
    ).toEqual([null, 10, 10, null, 10, 0]);
  });

  it.each([
    ["day", 5, 5, true],
    ["week", 3, 3, true],
    ["month", 2, 2, true]
  ] as const)("%s 周期映射(limit %i → %i 条)", async (period, limit, count, hasMore) => {
    stubFetch(async () => jsonResponse(fixtureJson(`kline-${period}.json`)));
    const page = await fetchKlines(SH000001, period, { limit });
    expect(page.bars).toHaveLength(count);
    expect(page.hasMore).toBe(hasMore);
    // 三个周期都是 [日期,开,收,高,低,成交量],升序原样保留。
    expect(page.bars[page.bars.length - 1]?.time).toBe("2026-10-09");
  });

  it("返回条数少于 limit → hasMore 为 false", async () => {
    stubFetch(async () => jsonResponse(fixtureJson("kline-week.json")));
    const page = await fetchKlines(SH000001, "week", { limit: 5 });
    expect(page.bars).toHaveLength(3);
    expect(page.hasMore).toBe(false);
  });

  it("end(YYYYMMDD)→ YYYY-MM-DD 拼进 param;limit 缺省 200 且 end 缺省留空", async () => {
    const mock = stubFetch(async () => jsonResponse(fixtureJson("kline-day.json")));
    await fetchKlines(SH000001, "day", { end: "20260930", limit: 3 });
    expect(urlOf(mock, 0)).toBe(
      "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,2026-09-30,3,"
    );

    await fetchKlines(SH000001, "month", {});
    expect(urlOf(mock, 1)).toBe(
      "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,month,,,200,"
    );

    // 非法 end 与缺省同义:留空而非拼出坏日期。
    await fetchKlines(SH000001, "day", { end: "2026-09-30" });
    expect(urlOf(mock, 2)).toBe(
      "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,200,"
    );
  });

  it("host 语义:facade 轮换的裸域名落默认前缀、未知裸域名换 host、完整前缀原样", async () => {
    const mock = stubFetch(async () => jsonResponse(fixtureJson("kline-day.json")));
    // qt.gtimg.cn(facade 轮换首个域名)不服务 K 线,直接落到 K 线默认前缀。
    await fetchKlines(SH000001, "day", { limit: 5 }, "qt.gtimg.cn");
    expect(urlOf(mock, 0)).toBe(
      "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,5,"
    );

    await fetchKlines(SH000001, "day", { limit: 5 }, "mirror.example.com");
    expect(urlOf(mock, 1)).toBe(
      "https://mirror.example.com/appstock/app/fqkline/get?param=sh000001,day,,,5,"
    );
  });

  it("备用完整 URL 前缀原样拼接(主备域名路径不同)", async () => {
    const mock = stubFetch(async () => jsonResponse(fixtureJson("kline-day.json")));
    await fetchKlines(
      SH000001,
      "day",
      { limit: 5 },
      "https://proxy.finance.qq.com/ifzqgtimg/kline/kline?param="
    );
    expect(urlOf(mock)).toBe(
      "https://proxy.finance.qq.com/ifzqgtimg/kline/kline?param=sh000001,day,,,5,"
    );
  });

  it.each(["day", "week", "month"] as const)(
    "hf_ 外盘代码请求 %s K线 → 抛 MarketError",
    async (period) => {
      const mock = stubFetch(async () => jsonResponse({}));
      await expect(fetchKlines(XAU, period, {})).rejects.toBeInstanceOf(MarketError);
      expect(mock).not.toHaveBeenCalled();
    }
  );

  it("无 tencentCode 的标的请求 K线 → 抛 MarketError(配置缺失边界)", async () => {
    const mock = stubFetch(async () => jsonResponse({}));
    await expect(fetchKlines(inst("au9999"), "day", {})).rejects.toMatchObject({
      name: "MarketError",
      source: "tencent",
      message: expect.stringContaining("黄金9999")
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it("响应整体变形 → {bars: [], hasMore: false}", () => {
    expect(parseKlines(null, "sh000001", "day", 200)).toEqual({ bars: [], hasMore: false });
    expect(parseKlines({}, "sh000001", "day", 200)).toEqual({ bars: [], hasMore: false });
    expect(parseKlines({ data: [] }, "sh000001", "day", 200)).toEqual({
      bars: [],
      hasMore: false
    });
    expect(parseKlines({ data: { sh000001: { day: "oops" } } }, "sh000001", "day", 200)).toEqual({
      bars: [],
      hasMore: false
    });
  });

  it("下标不足 / 开收高低非法的行丢弃,其余行保留(越界边界)", () => {
    const payload = {
      data: {
        sh000001: {
          day: [
            ["2026-10-08", "3838.98"],
            ["2026-10-09", "3804.09", "3813.79", "3824.71", "3754.14", "535149921"],
            [12345, "1", "2", "3", "4", "5"],
            ["2026-10-10", "1", "abc", "3", "4", "5"]
          ]
        }
      }
    };
    const page = parseKlines(payload, "sh000001", "day", 200);
    expect(page.bars).toEqual([
      {
        time: "2026-10-09",
        open: 3804.09,
        close: 3813.79,
        high: 3824.71,
        low: 3754.14,
        volume: 535149921,
        amount: null,
        // 唯一保留的一根即首根 → 无前收,振幅 null。
        amplitudePct: null
      }
    ]);
    expect(page.hasMore).toBe(false);
  });

  it("成交量缺失 → volume null(缺失不冒充 0)", () => {
    const payload = { data: { sh000001: { day: [["2026-10-09", "1", "2", "3", "0.5"]] } } };
    expect(parseKlines(payload, "sh000001", "day", 200).bars[0]).toEqual({
      time: "2026-10-09",
      open: 1,
      close: 2,
      high: 3,
      low: 0.5,
      volume: null,
      amount: null,
      amplitudePct: null
    });
  });

  it("网络失败原样抛出(reject 透传)", async () => {
    const networkError = new Error("network down");
    stubFetch(async () => {
      throw networkError;
    });
    await expect(fetchKlines(SH000001, "day", {})).rejects.toBe(networkError);
  });
});

describe("fetchKlines 腾讯 K 线范围查询(beg)", () => {
  it("带 beg:param 为 {code},{period},{start},{end},2000,(YYYYMMDD → YYYY-MM-DD)", async () => {
    const mock = stubFetch(async () => jsonResponse(fixtureJson("kline-day.json")));

    const page = await fetchKlines(SH000001, "day", { beg: "20250901", end: "20260901", limit: 3 });

    expect(urlOf(mock)).toBe(
      "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,2025-09-01,2026-09-01,2000,"
    );
    // fixture 6 条 > limit 3:范围模式不截断,hasMore 恒 false。
    expect(page.bars).toHaveLength(6);
    expect(page.hasMore).toBe(false);
  });

  it("范围模式 end 缺省留空;非法 beg 留空但仍按范围模式取数(count 仍 2000)", async () => {
    const mock = stubFetch(async () => jsonResponse(fixtureJson("kline-week.json")));

    const page = await fetchKlines(SH000001, "week", { beg: "20250901" });
    expect(urlOf(mock, 0)).toBe(
      "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,week,2025-09-01,,2000,"
    );
    expect(page.bars).toHaveLength(3);
    expect(page.hasMore).toBe(false);

    await fetchKlines(SH000001, "week", { beg: "2025-09-01" });
    expect(urlOf(mock, 1)).toBe(
      "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,week,,,2000,"
    );
  });

  it("beg 为空串视为未启用范围查询:维持 `,,{end},{limit},` 与 limit+1 截断(空值边界/回归)", async () => {
    const mock = stubFetch(async () => jsonResponse(fixtureJson("kline-day.json")));

    const page = await fetchKlines(SH000001, "day", { beg: "", limit: 5 });

    expect(urlOf(mock)).toBe(
      "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,5,"
    );
    expect(page.bars).toHaveLength(5);
    expect(page.hasMore).toBe(true);
  });

  it("parseKlines 范围模式(ranged=true):原样返回、hasMore 恒 false", () => {
    const payload = {
      data: {
        sh000001: {
          day: [
            ["2026-09-24", "3925.32", "3888.37", "3930.5", "3888.37", "438530412"],
            ["2026-09-25", "3888.37", "3900", "3910", "3880", "100"],
            ["2026-09-26", "3900", "3910", "3920", "3890", "200"]
          ]
        }
      }
    };

    const ranged = parseKlines(payload, "sh000001", "day", 1, true);

    expect(ranged.bars).toHaveLength(3);
    expect(ranged.hasMore).toBe(false);
    // 范围模式同样按返回序列算振幅:首根无前收 → null;09-25 (3910-3880)/3888.37×100 → 0.77;
    // 09-26 (3920-3890)/3900×100 → 0.77。
    expect(ranged.bars.map((bar) => bar.amplitudePct)).toEqual([null, 0.77, 0.77]);
    // 同一响应走非范围模式仍按最新 limit 根截断(既有语义不变);截断后首根无前收 → null。
    const truncated = parseKlines(payload, "sh000001", "day", 1);
    expect(truncated.bars.map((bar) => bar.time)).toEqual(["2026-09-26"]);
    expect(truncated.bars[0].amplitudePct).toBeNull();
  });
});

describe("fetchTrends 腾讯分时", () => {
  it("ndays=1:累计量差分(首根保留原值)、时间 YYYY-MM-DD HH:mm、prevClose 取 qt 块昨收", async () => {
    const mock = stubFetch(async () => jsonResponse(fixtureJson("trends-minute.json")));
    const trends = await fetchTrends(SH000001, 1);

    expect(urlOf(mock)).toBe("https://ifzq.gtimg.cn/appstock/app/minute/query?code=sh000001");
    expect(trends.points).toHaveLength(242);
    expect(trends.points[0]).toEqual({
      time: "2026-10-09 09:30",
      price: 3804.09,
      // 均价线与分钟 OHLC 腾讯都不提供。
      avgPrice: null,
      // 首根累计量即当日成交量。
      volume: 3600224,
      open: null,
      high: null,
      low: null
    });
    // 第二根起按相邻累计量差分:22565813 - 3600224。
    expect(trends.points[1]).toEqual({
      time: "2026-10-09 09:31",
      price: 3806.44,
      avgPrice: null,
      volume: 22565813 - 3600224,
      open: null,
      high: null,
      low: null
    });
    expect(trends.points[241]).toMatchObject({
      time: "2026-10-09 15:00",
      price: 3813.79,
      volume: 535149921 - 529619632
    });
    expect(trends.prevClose).toBe(3811.9);
  });

  it("ndays=5:最新在前 → reverse 成升序;块内差分、跨块不差分", async () => {
    const mock = stubFetch(async () => jsonResponse(fixtureJson("trends-fiveday.json")));
    const trends = await fetchTrends(SH000001, 5);

    expect(urlOf(mock)).toBe("https://ifzq.gtimg.cn/appstock/app/day/query?code=sh000001");
    // 5 个日块 × 242 根。
    expect(trends.points).toHaveLength(5 * 242);
    expect(trends.points[0]).toEqual({
      time: "2026-09-28 09:30",
      price: 3878.41,
      avgPrice: null,
      volume: 3901496,
      open: null,
      high: null,
      low: null
    });
    expect(trends.points[1]).toMatchObject({
      time: "2026-09-28 09:31",
      volume: 20844108 - 3901496
    });
    // 跨块首根保留本块累计量(不与上一块末尾差分)。
    expect(trends.points[242]).toEqual({
      time: "2026-09-29 09:30",
      price: 3816.15,
      avgPrice: null,
      volume: 3341162,
      open: null,
      high: null,
      low: null
    });
    expect(trends.points[trends.points.length - 1]).toMatchObject({
      time: "2026-10-09 15:00",
      price: 3813.79
    });
    expect(trends.prevClose).toBe(3811.9);
  });

  it("qt 块缺失 / 昨收非法 → prevClose null,分时点仍返回", () => {
    const payload = {
      data: {
        sh000001: {
          data: { date: "20261009", data: ["0930 3804.09 3600224 5970630812.60"] }
        }
      }
    };
    expect(parseTrends(payload, "sh000001", 1)).toEqual({
      points: [
        {
          time: "2026-10-09 09:30",
          price: 3804.09,
          avgPrice: null,
          volume: 3600224,
          open: null,
          high: null,
          low: null
        }
      ],
      prevClose: null
    });

    const badQt = {
      data: {
        sh000001: {
          qt: { sh000001: ["1", "上证指数", "000001", "3813.79", "abc"] },
          data: { date: "20261009", data: [] }
        }
      }
    };
    expect(parseTrends(badQt, "sh000001", 1).prevClose).toBeNull();
  });

  it("响应整体变形 / 空数组 → {points: [], prevClose: null}", () => {
    expect(parseTrends(null, "sh000001", 1)).toEqual({ points: [], prevClose: null });
    expect(parseTrends({ data: {} }, "sh000001", 1)).toEqual({ points: [], prevClose: null });
    expect(parseTrends({ data: { sh000001: {} } }, "sh000001", 1)).toEqual({
      points: [],
      prevClose: null
    });
    expect(parseTrends({ data: { sh000001: { data: [] } } }, "sh000001", 5)).toEqual({
      points: [],
      prevClose: null
    });
  });

  it("坏项丢弃:时间/价格非法或非字符串项跳过;累计量缺失 → volume null 且后续差分仍以上一有效累计量为基准", () => {
    const payload = {
      data: {
        sh000001: {
          data: {
            date: "20261009",
            data: [
              "0930 3804.09 1000 5970630812.60",
              42,
              "0931 abc 2000 3.00",
              "0932 3806.44 abc 4.00",
              "0933 3806.00 5000 5.00",
              "093 3806.00 6000 6.00"
            ]
          }
        }
      }
    };
    expect(parseTrends(payload, "sh000001", 1)).toEqual({
      points: [
        {
          time: "2026-10-09 09:30",
          price: 3804.09,
          avgPrice: null,
          volume: 1000,
          open: null,
          high: null,
          low: null
        },
        {
          time: "2026-10-09 09:32",
          price: 3806.44,
          avgPrice: null,
          volume: null,
          open: null,
          high: null,
          low: null
        },
        // 以上一根有效累计量 1000 为基准差分:5000 - 1000。
        {
          time: "2026-10-09 09:33",
          price: 3806,
          avgPrice: null,
          volume: 4000,
          open: null,
          high: null,
          low: null
        }
      ],
      prevClose: null
    });
  });

  it("容器层级缺失 / 类型不符 → {points: [], prevClose: null}(越界边界)", () => {
    expect(parseTrends({ data: null }, "sh000001", 1)).toEqual({ points: [], prevClose: null });
    expect(parseTrends({ data: 42 }, "sh000001", 1)).toEqual({ points: [], prevClose: null });
    expect(parseTrends({ data: { sh000001: 42 } }, "sh000001", 1)).toEqual({
      points: [],
      prevClose: null
    });
  });

  it("qt 为裸数组(facade 之外的响应形态)也能取昨收", () => {
    const bareQt = {
      data: {
        sh000001: {
          qt: ["1", "上证指数", "000001", "3813.79", "3811.90"],
          data: { date: "20261009", data: [] }
        }
      }
    };
    expect(parseTrends(bareQt, "sh000001", 1).prevClose).toBe(3811.9);
  });

  it("日块日期 / 点集类型不符 → 跳过该块(越界边界)", () => {
    const cases = [
      { date: 20261009, data: [] },
      { date: "20261009", data: "oops" },
      // 日期格式不符(要求 YYYYMMDD)。
      { date: "2026-10-09", data: ["0930 3804.09 1000 5970630812.60"] }
    ];
    for (const block of cases) {
      expect(parseTrends({ data: { sh000001: { data: block } } }, "sh000001", 1)).toEqual({
        points: [],
        prevClose: null
      });
    }

    // 5 日:数组里夹非对象块时只跳过该块,其余块照常解析。
    const mixedBlocks = {
      data: {
        sh000001: {
          data: [
            { date: "20261009", data: ["0930 3804.09 1000 5970630812.60"] },
            null,
            { date: "20261008", data: ["0930 3838.98 2000 6743785034.40"] }
          ]
        }
      }
    };
    expect(parseTrends(mixedBlocks, "sh000001", 5)).toEqual({
      points: [
        // 最新块在前 → 反转后升序;两块各为独立差分起点。
        {
          time: "2026-10-08 09:30",
          price: 3838.98,
          avgPrice: null,
          volume: 2000,
          open: null,
          high: null,
          low: null
        },
        {
          time: "2026-10-09 09:30",
          price: 3804.09,
          avgPrice: null,
          volume: 1000,
          open: null,
          high: null,
          low: null
        }
      ],
      prevClose: null
    });
  });

  it("hf_ 外盘 / 无 tencentCode → 抛 MarketError(不支持该形态)", async () => {
    const mock = stubFetch(async () => jsonResponse({}));
    await expect(fetchTrends(XAU, 1)).rejects.toBeInstanceOf(MarketError);
    await expect(fetchTrends(XAU, 5)).rejects.toMatchObject({ source: "tencent" });
    await expect(fetchTrends(inst("au9999"), 1)).rejects.toBeInstanceOf(MarketError);
    expect(mock).not.toHaveBeenCalled();
  });

  it("host 语义:自治裸域名落默认前缀、未知裸域名换 host、完整前缀原样", async () => {
    const mock = stubFetch(async () => jsonResponse(fixtureJson("trends-minute.json")));
    // qt.gtimg.cn 是 facade 轮换的首个域名,但它不服务分时(实测 "bad request"),故落到分时默认前缀。
    await fetchTrends(SH000001, 1, "qt.gtimg.cn");
    expect(urlOf(mock, 0)).toBe("https://ifzq.gtimg.cn/appstock/app/minute/query?code=sh000001");

    await fetchTrends(SH000001, 1, "mirror.example.com");
    expect(urlOf(mock, 1)).toBe(
      "https://mirror.example.com/appstock/app/minute/query?code=sh000001"
    );

    await fetchTrends(SH000001, 5, "https://ifzq.gtimg.cn/appstock/app/day/query?code=");
    expect(urlOf(mock, 2)).toBe("https://ifzq.gtimg.cn/appstock/app/day/query?code=sh000001");
  });

  it("网络失败原样抛出(reject 透传)", async () => {
    const networkError = new Error("network down");
    stubFetch(async () => {
      throw networkError;
    });
    await expect(fetchTrends(SH000001, 1)).rejects.toBe(networkError);
  });
});

describe("Quote 契约完整性", () => {
  it("解析结果字段集与 Quote 契约一致(不缺字段)", () => {
    const expectedKeys: Array<keyof Quote> = [
      "instrumentId",
      "price",
      "change",
      "changePct",
      "amplitudePct",
      "open",
      "high",
      "low",
      "prevClose",
      "volume",
      "amount",
      "time",
      "source"
    ];
    for (const quote of parseSnapshot(snapshotText(), instsOf("sh000001", "xau"))) {
      expect(Object.keys(quote).sort()).toEqual([...expectedKeys].sort());
    }
  });
});
