// 桌面左侧导航(T1e 卡片用例清单):三项导航带图标、选中态随路由派生、移动端不渲染。
// 固定侧栏契约(后台式布局):.site-sidebar 容器 + CSS 源文本断言——jsdom 不计算布局,
// fixed 贴边/贴底与宽度变量只能对源文件断言(测试内读 src/components/site-sidebar.css)。
// 路由上下文用 MemoryRouter 提供(Link/useLocation 依赖真实上下文,不 mock 路由模块);
// 断点判定走 useIsMobile 替身:默认回落真实实现(测试环境 matchMedia 为桌面),
// forceMobile 用例覆盖移动端分支。
const h = vi.hoisted(() => ({ forceMobile: null as boolean | null }));

vi.mock("../../src/hooks/use-breakpoint", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/use-breakpoint")>();
  return {
    useIsMobile: () => (h.forceMobile === null ? actual.useIsMobile() : h.forceMobile)
  };
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "@modern-js/runtime/router";
import { afterEach, describe, expect, it, vi } from "vitest";

import SiteSidebar from "../../src/components/site-sidebar";

/** 读取 CSS 源文本并压缩空白(布局契约断言用)。 */
function readStyle(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8").replace(
    /\s+/g,
    " "
  );
}

function renderSidebar(pathname = "/") {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <SiteSidebar />
    </MemoryRouter>
  );
}

afterEach(() => {
  h.forceMobile = null;
});

describe("SiteSidebar 导航渲染", () => {
  it("三项导航全量渲染,每项都带图标", () => {
    const { container } = renderSidebar();
    expect(screen.getByRole("link", { name: "首页" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "黄金价格" })).toHaveAttribute("href", "/gold");
    expect(screen.getByRole("link", { name: "国内指数" })).toHaveAttribute("href", "/indices");
    expect(container.querySelectorAll(".site-sidebar-icon").length).toBe(3);
  });
});

describe("SiteSidebar 选中态", () => {
  it("根路由选中首页", () => {
    renderSidebar("/");
    expect(screen.getByRole("link", { name: "首页" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "黄金价格" })).not.toHaveAttribute("aria-current");
  });

  it("/gold 路由选中「黄金价格」,Arco 菜单高亮同步", () => {
    const { container } = renderSidebar("/gold");
    expect(screen.getByRole("link", { name: "黄金价格" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "首页" })).not.toHaveAttribute("aria-current");
    expect(container.querySelector(".arco-menu-selected")?.textContent).toContain("黄金价格");
  });

  it("越界深链回退首页高亮", () => {
    renderSidebar("/unknown");
    expect(screen.getByRole("link", { name: "首页" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "国内指数" })).not.toHaveAttribute("aria-current");
  });
});

describe("SiteSidebar 响应式", () => {
  it("移动端断点不渲染侧栏(导航由页头抽屉承担)", () => {
    h.forceMobile = true;
    const { container } = renderSidebar();
    expect(container.querySelector(".site-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "黄金价格" })).not.toBeInTheDocument();
  });

  it("SSR 直出桌面侧栏(hydration 一致:服务端无 matchMedia,固定按桌面渲染)", () => {
    // jsdom 挂在 window 上,renderToString 仍会执行组件的渲染期逻辑;此处断言的是
    // 服务端首帧(useEffect 未执行)下侧栏与三个导航项已随 HTML 输出。
    const html = renderToString(
      <MemoryRouter initialEntries={["/gold"]}>
        <SiteSidebar />
      </MemoryRouter>
    );
    expect(html).toContain("site-sidebar");
    expect(html).toContain("首页");
    expect(html).toContain("黄金价格");
    expect(html).toContain("国内指数");
  });
});

describe("SiteSidebar 固定定位契约(CSS)", () => {
  it("侧栏 fixed 贴左缘、上起顶栏下缘、下至视口底,宽度走 :root 变量", () => {
    const css = readStyle("../../src/components/site-sidebar.css");
    expect(css).toContain("position: fixed");
    expect(css).toContain("left: 0");
    expect(css).toContain("top: var(--site-header-h, 56px)");
    expect(css).toContain("bottom: 0");
    expect(css).toContain("width: var(--site-sidebar-w, 200px)");
    // 层级低于固定顶栏(100)、高于内容区;菜单过长时栏内自身滚动。
    expect(css).toContain("z-index: 90");
    expect(css).toContain("overflow-y: auto");
  });

  it("菜单满宽点击区与选中态左侧高亮条(inset 阴影不引起文字位移)", () => {
    const css = readStyle("../../src/components/site-sidebar.css");
    expect(css).toContain(".site-sidebar .site-sidebar-menu.arco-menu-vertical .arco-menu-inner");
    expect(css).toContain("inset 2px 0 0 rgb(var(--primary-6))");
  });
});
