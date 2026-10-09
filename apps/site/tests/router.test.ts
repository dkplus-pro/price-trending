// @vitest-environment node
// 路由 basename 剥离与导航选中态派生(T1e 卡片用例清单)。
// ROUTER_BASENAME 是现代构建期内联的常量(vitest 下 process.env 未内联 → 空串),
// 为使 basename 分支可测,toAppPathname 设计为第二参数可显式传入 basename(默认取内联常量)。
import { describe, expect, it } from "vitest";

import { ROUTER_BASENAME, matchNavKey, toAppPathname } from "../src/config/router";

describe("ROUTER_BASENAME", () => {
  it("配置缺失边界:未内联(非静态导出/测试环境)时为空串", () => {
    expect(ROUTER_BASENAME).toBe("");
  });
});

describe("toAppPathname", () => {
  it("零值边界:basename 为空串时恒等返回", () => {
    expect(toAppPathname("/gold", "")).toBe("/gold");
    expect(toAppPathname("/", "")).toBe("/");
    expect(toAppPathname("/indices", "")).toBe("/indices");
  });

  it("有 basename 时剥离前缀", () => {
    expect(toAppPathname("/price-trending/gold", "/price-trending")).toBe("/gold");
    expect(toAppPathname("/price-trending/indices", "/price-trending")).toBe("/indices");
  });

  it("剥完为空串时回退根路径", () => {
    expect(toAppPathname("/price-trending", "/price-trending")).toBe("/");
    expect(toAppPathname("/price-trending/", "/price-trending")).toBe("/");
  });

  it("非前缀路径原样返回", () => {
    expect(toAppPathname("/other/gold", "/price-trending")).toBe("/other/gold");
    expect(toAppPathname("/", "/price-trending")).toBe("/");
  });

  it("空值边界:空 pathname 原样返回", () => {
    expect(toAppPathname("", "")).toBe("");
    expect(toAppPathname("", "/price-trending")).toBe("");
  });
});

describe("matchNavKey", () => {
  it("根路径精确匹配首页", () => {
    expect(matchNavKey("/")).toBe("/");
  });

  it("栏目路径命中对应导航项", () => {
    expect(matchNavKey("/gold")).toBe("/gold");
    expect(matchNavKey("/indices")).toBe("/indices");
  });

  it("带尾斜杠/子路径前缀命中(深链高亮)", () => {
    expect(matchNavKey("/gold/")).toBe("/gold");
    expect(matchNavKey("/indices/000001")).toBe("/indices");
  });

  it("越界边界:未知深链回退首页", () => {
    expect(matchNavKey("/unknown")).toBe("/");
    expect(matchNavKey("/goldfish")).toBe("/");
  });

  it("空值边界:空串回退首页", () => {
    expect(matchNavKey("")).toBe("/");
  });

  it("与 toAppPathname 串联:basename 部署下同样命中", () => {
    expect(matchNavKey(toAppPathname("/price-trending/indices", "/price-trending"))).toBe(
      "/indices"
    );
    expect(matchNavKey(toAppPathname("/price-trending", "/price-trending"))).toBe("/");
  });
});
