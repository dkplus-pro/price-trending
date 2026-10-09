// layout.tsx 装配结构(docs/site-shell-plan.md 阶段 5.1 装配 + 任务卡 6.1):
// ConfigProvider(react-19 适配器/locale/theme)+ 双层 ErrorBoundary(根层兜壳层、页面层兜
// Outlet)+ useRum / initTracking 客户端装配 + 站名兜底。双层边界用行为断言验证:
// Outlet 抛错 → 内层边界兜住、壳层(页头/页脚)仍可用;壳层(页头)抛错 → 外层边界兜住、整树降级。
// 固定布局契约(后台式):壳层结构(内容区/页脚归属)与 CSS 源文本断言——jsdom 不做布局计算,
// fixed 定位/让位高度只能对源文件断言;断点分支走 useIsMobile 替身(与 site-sidebar 用例同款)。
// Router 上下文以替身替代(useLoaderData 受控数据源、Outlet 按开关抛错、useNavigate 空实现、
// Link/useLocation 供左侧栏 SiteSidebar 真实渲染);
// SiteHeader 以按开关抛错的替身替代(组件自身用例见 tests/components/site-header.test.tsx);
// tracking facade 以 vi.mock 替身断言装配调用(initTracking 替身避免拉起 web-vitals 动态依赖)。
const h = vi.hoisted(() => ({
  loaderData: { value: null as unknown },
  outletThrows: { value: false },
  headerThrows: { value: false },
  forceMobile: null as boolean | null,
  initTracking: vi.fn(),
  track: vi.fn(),
  navigate: vi.fn()
}));

vi.mock("@modern-js/runtime/router", async () => {
  const { createElement } = await import("react");
  return {
    Link: ({ to, children }: { to: string; children?: ReactNode }) =>
      createElement("a", { href: to }, children),
    Outlet: () => {
      if (h.outletThrows.value) {
        throw new Error("outlet boom");
      }
      return createElement("div", null, "outlet-content");
    },
    useLoaderData: () => h.loaderData.value,
    useLocation: () => ({ pathname: "/" }),
    useNavigate: () => h.navigate
  };
});

vi.mock("../../src/tracking", () => ({ initTracking: h.initTracking, track: h.track }));

vi.mock("../../src/components/site-header", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: { siteName: string }) => {
      if (h.headerThrows.value) {
        throw new Error("header boom");
      }
      return createElement("header", null, props.siteName);
    }
  };
});

// 断点替身:null 走桌面(与 jsdom 的 matchMedia 替身一致),true 走移动端分支。
vi.mock("../../src/hooks/use-breakpoint", () => ({
  useIsMobile: () => h.forceMobile === true
}));

import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import SiteLayout from "../../src/routes/layout";

/** 读取 CSS 源文本并压缩空白:固定定位契约 jsdom 不计算样式,只能对源文件断言。 */
function readStyle(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8").replace(
    /\s+/g,
    " "
  );
}

// RUM 初始化读真实 env;测试内清空保证守卫语义(缺失即不初始化)不受本机环境影响。
let consoleErrorSpy: MockInstance;

beforeEach(() => {
  h.loaderData.value = null;
  h.outletThrows.value = false;
  h.headerThrows.value = false;
  h.forceMobile = null;
  h.initTracking.mockClear();
  h.track.mockClear();
  h.navigate.mockClear();
  vi.stubEnv("RUM_ENDPOINT", "");
  vi.stubEnv("RUM_PID", "");
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("SiteLayout 装配结构", () => {
  it("壳层按序装配:页头(站名/Logo)/主内容 Outlet/页脚,埋点初始化仅调用一次", () => {
    h.loaderData.value = { siteName: "测试站", logoUrl: "https://cdn.example.com/logo.png" };
    const { container } = render(<SiteLayout />);
    expect(screen.getByText("测试站")).toBeInTheDocument();
    expect(screen.getByText("outlet-content")).toBeInTheDocument();
    expect(screen.getByText("© 2026 CMS Template")).toBeInTheDocument();
    expect(container.querySelector(".site-shell")).toBeInTheDocument();
    expect(container.querySelector(".site-main")).toBeInTheDocument();
    expect(h.initTracking).toHaveBeenCalledTimes(1);
  });

  it("站名兜底:layout loader 降级 null 时回退 FALLBACK_SITE_NAME", () => {
    h.loaderData.value = null;
    render(<SiteLayout />);
    expect(screen.getByText("CMS Template")).toBeInTheDocument();
  });
});

describe("SiteLayout 双层 ErrorBoundary", () => {
  it("页面层边界:Outlet 渲染错误被内层兜住并上报,壳层(页头/页脚)保持可用", () => {
    h.loaderData.value = { siteName: "测试站" };
    h.outletThrows.value = true;
    const { container } = render(<SiteLayout />);
    expect(screen.getByText("页面出错了")).toBeInTheDocument();
    expect(screen.getByText("outlet boom")).toBeInTheDocument();
    expect(screen.getByText("测试站")).toBeInTheDocument();
    expect(screen.getByText("© 2026 CMS Template")).toBeInTheDocument();
    expect(container.querySelector(".site-shell")).toBeInTheDocument();
    expect(h.track).toHaveBeenCalledWith(
      "react_render_error",
      expect.objectContaining({ message: "outlet boom" })
    );
  });

  it("根层边界:壳层渲染错误被外层兜住,整树降级不再输出壳层", () => {
    h.loaderData.value = { siteName: "测试站" };
    h.headerThrows.value = true;
    const { container } = render(<SiteLayout />);
    expect(screen.getByText("页面出错了")).toBeInTheDocument();
    expect(screen.queryByText("outlet-content")).not.toBeInTheDocument();
    expect(container.querySelector(".site-shell")).not.toBeInTheDocument();
    expect(h.track).toHaveBeenCalledWith(
      "react_render_error",
      expect.objectContaining({ message: "header boom" })
    );
  });
});

describe("SiteLayout 固定布局结构(后台式)", () => {
  it("桌面:固定侧栏与内容区同壳,页脚归属内容区(不再横跨整页宽度)", () => {
    h.loaderData.value = { siteName: "测试站" };
    const { container } = render(<SiteLayout />);
    const body = container.querySelector(".site-body");
    const main = container.querySelector(".site-main");
    expect(body).toBeInTheDocument();
    expect(body?.querySelector(".site-sidebar")).toBeInTheDocument();
    expect(main).toBeInTheDocument();
    expect(main?.querySelector(".site-footer")).toBeInTheDocument();
  });

  it("移动端(useIsMobile=true):不渲染侧栏,内容区仍在壳层内", () => {
    h.forceMobile = true;
    const { container } = render(<SiteLayout />);
    expect(container.querySelector(".site-sidebar")).not.toBeInTheDocument();
    expect(container.querySelector(".site-main")).toBeInTheDocument();
    expect(container.querySelector(".site-shell")).toBeInTheDocument();
  });

  it("SSR 直出:固定壳层结构随 HTML 输出,水合前结构一致", () => {
    h.loaderData.value = { siteName: "测试站" };
    const html = renderToString(<SiteLayout />);
    expect(html).toContain("site-shell");
    expect(html).toContain("site-body");
    expect(html).toContain("site-sidebar");
    expect(html).toContain("site-main");
    expect(html).toContain("测试站");
  });
});

describe("SiteLayout 固定布局契约(CSS)", () => {
  it("尺寸变量与内容区让位:--site-header-h / --site-sidebar-w + padding-top + 桌面左侧让位", () => {
    const css = readStyle("../../src/routes/layout.css");
    // 变量值须与固定顶栏实际高度一致(site-header.css 同源:height: var(--site-header-h))。
    expect(css).toContain("--site-header-h: 56px");
    expect(css).toContain("--site-sidebar-w: 200px");
    // 内容区让位:顶部让出固定顶栏,桌面左侧让出固定侧栏。
    expect(css).toContain("padding-top: var(--site-header-h, 56px)");
    expect(css).toContain("padding-left: var(--site-sidebar-w, 200px)");
  });

  it("变量缺失兜底:顶栏高度/侧栏宽度在 var() 内均带默认值(配置缺失不塌陷)", () => {
    const layoutCss = readStyle("../../src/routes/layout.css");
    expect(layoutCss).toContain("var(--site-header-h, 56px)");
    expect(layoutCss).toContain("var(--site-sidebar-w, 200px)");
    expect(readStyle("../../src/components/site-header.css")).toContain(
      "height: var(--site-header-h, 56px)"
    );
    expect(readStyle("../../src/components/site-sidebar.css")).toContain(
      "width: var(--site-sidebar-w, 200px)"
    );
  });
});
