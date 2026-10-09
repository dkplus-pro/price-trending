// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  DEFAULT_KLINE_LIMIT,
  getInstrument,
  GOLD_IDS,
  INDEX_IDS,
  INSTRUMENTS
} from "../../src/api/market/config";

// 配置回归防线:六标的字段完整性 + 关键能力标志(改动实验证过的 API 结论会在这里亮红灯)。
const byId = (id: string): ReturnType<typeof getInstrument> => getInstrument(id);

describe("INSTRUMENTS", () => {
  it("共 6 项,id 唯一且非空", () => {
    expect(INSTRUMENTS).toHaveLength(6);
    const ids = INSTRUMENTS.map((inst) => inst.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const inst of INSTRUMENTS) {
      expect(inst.id).toBeTruthy();
      expect(inst.name).toBeTruthy();
      expect(inst.secid).toMatch(/^\d+\.[A-Za-z0-9]+$/);
      expect(Number.isInteger(inst.priceDecimals)).toBe(true);
      expect(inst.priceDecimals).toBeGreaterThanOrEqual(0);
      expect(["gold", "index"]).toContain(inst.category);
      expect(inst.sessionHint).toBeTruthy();
    }
  });

  it("分组 id 常量都能在 INSTRUMENTS 中解析,且与 category 互相印证", () => {
    expect(GOLD_IDS).toEqual(["au9999", "xau", "gc"]);
    expect(INDEX_IDS).toEqual(["sh000001", "sz399006", "sh000688"]);
    for (const id of [...GOLD_IDS, ...INDEX_IDS]) {
      expect(byId(id)).toBeDefined();
    }
    for (const inst of INSTRUMENTS) {
      const group = inst.category === "gold" ? GOLD_IDS : INDEX_IDS;
      expect(group).toContain(inst.id);
    }
    expect(new Set([...GOLD_IDS, ...INDEX_IDS]).size).toBe(INSTRUMENTS.length);
  });

  it("黄金9999:上金所标的,有量有额、无均价线", () => {
    const inst = byId("au9999");
    expect(inst).toMatchObject({
      name: "黄金9999",
      category: "gold",
      secid: "118.AU9999",
      priceDecimals: 2,
      hasVolume: true,
      hasAmount: true,
      hasAvgLine: false
    });
    expect(inst?.tencentCode).toBeUndefined();
    expect(inst?.goldApiSymbol).toBeUndefined();
  });

  it("伦敦金:外盘快照,无量无额,均价线关闭,双兜底配置", () => {
    const inst = byId("xau");
    expect(inst).toMatchObject({
      secid: "122.XAU",
      tencentCode: "hf_XAU",
      goldApiSymbol: "XAU",
      priceDecimals: 2,
      hasVolume: false,
      hasAmount: false,
      hasAvgLine: false
    });
  });

  it("COMEX黄金:1 位小数、有量无额,无 gold-api 兜底", () => {
    const inst = byId("gc");
    expect(inst).toMatchObject({
      secid: "101.GC00Y",
      tencentCode: "hf_GC",
      priceDecimals: 1,
      hasVolume: true,
      hasAmount: false,
      hasAvgLine: false
    });
    expect(inst?.goldApiSymbol).toBeUndefined();
  });

  it.each(["sh000001", "sz399006", "sh000688"])(
    "指数 %s:有量有额(单位 手)、开均价线、腾讯同构代码",
    (id) => {
      const inst = byId(id);
      expect(inst).toMatchObject({
        category: "index",
        priceDecimals: 2,
        hasVolume: true,
        hasAmount: true,
        volumeUnit: "手",
        hasAvgLine: true,
        sessionHint: "9:30–15:00"
      });
      expect(inst?.tencentCode).toBe(id);
      expect(inst?.goldApiSymbol).toBeUndefined();
    }
  );
});

describe("getInstrument", () => {
  it("按 id 命中配置对象本身", () => {
    expect(byId("au9999")).toBe(INSTRUMENTS[0]);
  });

  it("未知 id 返回 undefined(不抛错,由调用方兜底)", () => {
    expect(byId("not-exist")).toBeUndefined();
  });
});

describe("DEFAULT_KLINE_LIMIT", () => {
  it("K 线默认条数为 200(源与 facade 共用)", () => {
    expect(DEFAULT_KLINE_LIMIT).toBe(200);
  });
});
