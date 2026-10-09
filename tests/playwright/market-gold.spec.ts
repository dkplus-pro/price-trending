import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page, type Route } from "@playwright/test";

// 行情页(黄金)渲染 e2e:东财 / 腾讯 / gold-api 全被路由拦截,用真实响应夹具驱动渲染,
// 不依赖外网(本机 / 部分网络对 eastmoney 全域不可达,真连必然失败,故一律拦截):
// - 黄金三标的 au9999 / 伦敦金 / COMEX 的分时、快照、日 K(MA 图例)三区块都渲染出画布;
// - AU9999 分时含上金所夜盘跨零点数据(index 等距轴,不炸);
// - 伦敦金 hasVolume=false:底部无柱色(与有量的 AU9999 做相对比较);
// - 直连域名被封锁(abort)时,公共 CORS 代理 host 兜底出图(证明 C13 的代理传输层可用)。
//
// 本 spec 不带 site project 的 baseURL(playwright.config.ts 的 projects 未匹配本文件),
// 故一律用站点绝对地址;夹具沿用 apps/site/tests/market/fixtures/eastmoney/(与单测同源)。
test.describe.configure({ timeout: 90_000 });

const SITE_ORIGIN = "http://127.0.0.1:18081";
const FIXTURE_DIR = fileURLToPath(
  new URL("../../apps/site/tests/market/fixtures/eastmoney/", import.meta.url)
);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as unknown;
}

const ULIST_GOLD = fixture("ulist-gold-echo.json");
const KLINE_BY_SECID: Record<string, unknown> = {
  "118.AU9999": fixture("kline-au9999-day.json"),
  "122.XAU": fixture("kline-xau-day.json"),
  "101.GC00Y": fixture("kline-gc-day.json")
};
const TRENDS_BY_SECID: Record<string, unknown> = {
  "118.AU9999": fixture("trends-au9999-1d.json"),
  "122.XAU": fixture("trends-xau-1d.json"),
  "101.GC00Y": fixture("trends-gc-1d.json")
};

/** 东财直连域名(push2 / push2his 及其变体)。 */
const EASTMONEY_RE = /eastmoney\.com\/api\/qt\//;
/** 兜底用的公共 CORS 代理域名。 */
const PROXY_RE = /^https:\/\/api\.(allorigins\.win|codetabs\.com)\//;
/** 腾讯 / gold-api(不应被请求;拦住保证用例可判定)。 */
const OTHER_SOURCE_RE = /qt\.gtimg\.cn|web\.ifzq\.gtimg\.cn|api\.gold-api\.com/;

/** 代理 URL → 被编码的东财目标 URL;直连 URL 原样返回。 */
function targetUrlOf(requestUrl: string): string {
  const parsed = new URL(requestUrl);
  if (PROXY_RE.test(requestUrl)) {
    return parsed.searchParams.get("url") ?? parsed.searchParams.get("quest") ?? "";
  }
  return requestUrl;
}

/** 按东财端点 + secid 回夹具(响应体即东财原 JSON,与真实取数同解析路径)。 */
async function fulfillEastmoney(route: Route): Promise<void> {
  const target = targetUrlOf(route.request().url());
  const url = new URL(target);
  const body = url.pathname.endsWith("/ulist.np/get")
    ? ULIST_GOLD
    : url.pathname.endsWith("/stock/kline/get")
      ? KLINE_BY_SECID[url.searchParams.get("secid") ?? ""]
      : url.pathname.endsWith("/stock/trends2/get")
        ? TRENDS_BY_SECID[url.searchParams.get("secid") ?? ""]
        : undefined;
  if (body === undefined) {
    await route.abort();
    return;
  }
  // 跨域响应须带 CORS 头(浏览器对拦截响应同样做 CORS 校验)。
  await route.fulfill({ json: body, headers: { "access-control-allow-origin": "*" } });
}

/**
 * 拦截行情请求。
 * @param blockDirect 为 true 时直连东财域名一律 abort(模拟本机「被限流/封锁」),代理域名照常回夹具。
 */
async function stubMarketRoutes(
  page: Page,
  options: { blockDirect?: boolean; requestLog?: string[] } = {}
): Promise<void> {
  await page.route(
    (url) => EASTMONEY_RE.test(url.href) || PROXY_RE.test(url.href),
    async (route) => {
      const href = route.request().url();
      options.requestLog?.push(href);
      const isProxy = PROXY_RE.test(href);
      if (isProxy || options.blockDirect !== true) {
        await fulfillEastmoney(route);
        return;
      }
      await route.abort();
    }
  );
  await page.route(OTHER_SOURCE_RE, (route) => route.abort());
}

/** 按区块标题定位标的区块(InstrumentSection 的 aria-label 即标的展示名)。 */
function section(page: Page, name: string) {
  return page.locator(`section.market-instrument[aria-label="${name}"]`);
}

/** canvas 内某纵向区间的「饱和像素占比」:量柱 / 蜡烛 / 折线是饱和色,背景、网格与轴文字不是。 */
async function bandInk(
  page: Page,
  name: string,
  topRatio: number,
  bottomRatio: number
): Promise<number> {
  return section(page, name)
    .locator(".market-chart-canvas canvas")
    .evaluate(
      (element, ratios) => {
        const [top, bottom] = ratios as [number, number];
        const canvas = element as HTMLCanvasElement;
        const context = canvas.getContext("2d");
        if (context === null) {
          return 0;
        }
        const start = Math.floor(canvas.height * top);
        const height = Math.max(1, Math.floor(canvas.height * (bottom - top)));
        const { data } = context.getImageData(0, start, canvas.width, height);
        let colored = 0;
        let total = 0;
        for (let index = 0; index < data.length; index += 4) {
          total += 1;
          const red = data[index];
          const green = data[index + 1];
          const blue = data[index + 2];
          const alpha = data[index + 3];
          if (alpha > 128 && Math.max(red, green, blue) - Math.min(red, green, blue) > 40) {
            colored += 1;
          }
        }
        return total === 0 ? 0 : colored / total;
      },
      [topRatio, bottomRatio]
    );
}

const GOLD_SECTIONS = ["黄金9999", "伦敦金", "COMEX黄金"] as const;

test("黄金页分时:三标的分时图 + 快照渲染,AU9999 夜盘跨零点不炸,XAU 无量柱副图", async ({
  page
}) => {
  await stubMarketRoutes(page);
  await page.goto(`${SITE_ORIGIN}/gold`);

  // 三个标的区块、无任何错误态页面级 / 区块级。
  await expect(page.locator(".market-instrument")).toHaveCount(3);
  await expect(page.locator(".market-page-error")).toHaveCount(0);

  // 快照区显示夹具里的东财实测价格(gc 为一位小数)。
  await expect(section(page, "黄金9999").locator(".quote-header-last")).toHaveText("904.48");
  await expect(section(page, "伦敦金").locator(".quote-header-last")).toHaveText("4191.93");
  await expect(section(page, "COMEX黄金").locator(".quote-header-last")).toHaveText("4220.0");

  // 三区块都渲染出画布,且分时折线画到了画布上(主图区域出现饱和像素)。
  for (const name of GOLD_SECTIONS) {
    await expect(section(page, name).locator(".market-chart-canvas canvas")).toBeVisible({
      timeout: 15_000
    });
    await expect
      .poll(() => bandInk(page, name, 0.1, 0.6), { timeout: 15_000 })
      .toBeGreaterThan(0.002);
  }
  await expect(page.locator(".market-instrument-error")).toHaveCount(0);

  // 量柱对比:AU9999(hasVolume=true,分时 41 点含夜盘跨零点)底部有柱色;
  // 伦敦金(hasVolume=false)没有量柱副图,同一底部区间只有背景与轴文字 → 近乎无饱和像素。
  const auVolumeInk = await bandInk(page, "黄金9999", 0.88, 0.97);
  const xauVolumeInk = await bandInk(page, "伦敦金", 0.88, 0.97);
  expect(auVolumeInk).toBeGreaterThan(0.15);
  expect(xauVolumeInk).toBeLessThan(0.02);

  await page.screenshot({ path: "/tmp/gold-e2e-minute.png", fullPage: true });
});

test("黄金页切到日K:三区块蜡烛图 + MA5/10/20 图例渲染", async ({ page }) => {
  await stubMarketRoutes(page);
  await page.goto(`${SITE_ORIGIN}/gold`);

  // 先等客户端 hydration + 首屏分时取数完成(画布由挂载后的 effect 渲染):
  // SSR 直出的单选是原生 input,未 hydration 时点击只改原生 checked、不写 zustand store。
  await expect(section(page, "黄金9999").locator(".market-chart-canvas canvas")).toBeVisible({
    timeout: 15_000
  });

  // 全局筛选栏切「日K」(store 驱动三区块一起改周期)。
  await page.locator(".market-filter-periods").getByText("日K", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "日K" })).toBeChecked();
  // 日期范围控件由禁用转为可用:store.period 变更已生效的信号。
  await expect(page.getByRole("textbox", { name: "开始日期" })).toBeEnabled();

  // 三区块都出现均线图例行(仅 K 线三档渲染),且 MA5/10/20 有值(夹具 25 根 ≥ 20)。
  await expect(page.locator(".market-instrument-ma")).toHaveCount(3, { timeout: 15_000 });
  for (const name of GOLD_SECTIONS) {
    const legend = section(page, name).locator(".market-instrument-ma");
    await expect(legend).toContainText("MA5");
    await expect(legend).toContainText("MA10");
    await expect(legend).toContainText("MA20");
    await expect(legend.locator(".market-instrument-ma-value").first()).not.toHaveText("--");
  }

  // 蜡烛图 / 均线画到了画布上,且无错误块。
  for (const name of GOLD_SECTIONS) {
    await expect
      .poll(() => bandInk(page, name, 0.15, 0.65), { timeout: 15_000 })
      .toBeGreaterThan(0.002);
  }
  await expect(page.locator(".market-instrument-error")).toHaveCount(0);

  // 日 K 的量柱副图同样遵守 hasVolume:AU9999 有、伦敦金无。
  const auVolumeInk = await bandInk(page, "黄金9999", 0.88, 0.97);
  const xauVolumeInk = await bandInk(page, "伦敦金", 0.88, 0.97);
  expect(auVolumeInk).toBeGreaterThan(0.15);
  expect(xauVolumeInk).toBeLessThan(0.02);

  await page.screenshot({ path: "/tmp/gold-e2e-daykline.png", fullPage: true });
});

test("直连域名被封锁时:公共 CORS 代理 host 兜底出图", async ({ page }) => {
  const requestLog: string[] = [];
  await stubMarketRoutes(page, { blockDirect: true, requestLog });
  await page.goto(`${SITE_ORIGIN}/gold`);

  // 直连两次 abort 后(各带退避)由代理域名取回数据:快照与分时都出图,无错误块。
  await expect(section(page, "黄金9999").locator(".quote-header-last")).toHaveText("904.48", {
    timeout: 30_000
  });
  await expect(section(page, "黄金9999").locator(".market-chart-canvas canvas")).toBeVisible({
    timeout: 30_000
  });
  await expect
    .poll(() => bandInk(page, "黄金9999", 0.1, 0.6), { timeout: 30_000 })
    .toBeGreaterThan(0.002);
  await expect(page.locator(".market-instrument-error")).toHaveCount(0);
  await expect(page.locator(".market-page-error")).toHaveCount(0);

  // 轮换顺序证据:直连域名先被请求(全部失败),随后代理域名收到请求并成功。
  const directAttempts = requestLog.filter((href) => EASTMONEY_RE.test(href));
  const proxyAttempts = requestLog.filter((href) => PROXY_RE.test(href));
  expect(directAttempts[0]).toContain("push2his.eastmoney.com");
  expect(proxyAttempts.length).toBeGreaterThan(0);
  expect(proxyAttempts.some((href) => href.includes("api.allorigins.win"))).toBe(true);

  await page.screenshot({ path: "/tmp/gold-e2e-proxy.png", fullPage: true });
});
