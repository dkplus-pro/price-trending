// site-header 响应式与抽屉开合(docs/quality-and-site-plan.md 阶段 18 用例清单 + T1e 导航改版):
// 桌面横向导航已移交左侧栏(components/site-sidebar.tsx),页头桌面只保留品牌区;
// 移动端汉堡 + 抽屉,抽屉选中态由 config/router 派生(与侧栏同源)。
// 固定顶栏契约(后台式布局):.site-header 容器 + CSS 源文本断言——jsdom 不计算布局,
// fixed 定位与让位高度只能对源文件断言(测试内读 src/components/site-header.css)。
// 路由上下文用 MemoryRouter 提供(Link/useLocation 依赖真实上下文),断点走 useIsMobile 替身。
const h = vi.hoisted(() => ({ isMobile: false }));

vi.mock("../../src/hooks/use-breakpoint", () => ({
  useIsMobile: () => h.isMobile
}));

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "@modern-js/runtime/router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SiteHeader from "../../src/components/site-header";
import { useUiStore } from "../../src/store/ui";

/** 读取 CSS 源文本并压缩空白(布局契约断言用)。 */
function readStyle(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8").replace(
    /\s+/g,
    " "
  );
}

function renderHeader(pathname = "/") {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <SiteHeader siteName="测试站" />
    </MemoryRouter>
  );
}

beforeEach(() => {
  h.isMobile = false;
  useUiStore.setState({ mobileMenuOpen: false });
});

describe("SiteHeader 桌面端", () => {
  it("渲染站名与品牌区;不再渲染横向导航,也没有汉堡按钮", () => {
    const { container } = renderHeader();
    expect(screen.getByText("测试站")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(container.querySelector(".site-nav")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开导航" })).not.toBeInTheDocument();
  });

  it("固定顶栏容器:.site-header 直出,移动端同样保留(汉堡在固定顶栏内)", () => {
    const { container: desktop } = renderHeader();
    expect(desktop.querySelector(".site-header")).toBeInTheDocument();

    h.isMobile = true;
    const { container: mobile } = renderHeader();
    expect(mobile.querySelector(".site-header")).toBeInTheDocument();
    expect(mobile.querySelector(".site-mobile-trigger")).toBeInTheDocument();
  });
});

describe("SiteHeader 固定定位契约(CSS)", () => {
  it("顶栏 fixed 贴顶全宽、高度走 :root 变量且含分隔线(box-sizing: border-box)", () => {
    const css = readStyle("../../src/components/site-header.css");
    expect(css).toContain("position: fixed");
    expect(css).toContain("top: 0");
    expect(css).toContain("left: 0");
    expect(css).toContain("right: 0");
    expect(css).toContain("height: var(--site-header-h, 56px)");
    expect(css).toContain("box-sizing: border-box");
    // 层级:低于 Arco Drawer(1001,门户到 body),高于固定侧栏(90)。
    expect(css).toContain("z-index: 100");
  });
});

describe("SiteHeader 移动端", () => {
  it("折叠为汉堡按钮,抽屉关闭态不渲染导航", () => {
    h.isMobile = true;
    renderHeader();
    const trigger = screen.getByRole("button", { name: "打开导航" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("点击汉堡打开抽屉,点导航项收起(开合闭环)", async () => {
    h.isMobile = true;
    const user = userEvent.setup();
    renderHeader();
    const trigger = screen.getByRole("button", { name: "打开导航" });

    await user.click(trigger);
    expect(useUiStore.getState().mobileMenuOpen).toBe(true);
    expect(screen.getByRole("button", { name: "关闭导航" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    const homeItem = await screen.findByRole("link", { name: "首页" });

    await user.click(homeItem);
    expect(useUiStore.getState().mobileMenuOpen).toBe(false);
    expect(screen.getByRole("button", { name: "打开导航" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });

  it("抽屉选中态按当前路由派生:/indices 下高亮「国内指数」", async () => {
    h.isMobile = true;
    const user = userEvent.setup();
    const { baseElement } = renderHeader("/indices");

    await user.click(screen.getByRole("button", { name: "打开导航" }));
    const indicesLink = await screen.findByRole("link", { name: "国内指数" });
    expect(indicesLink).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "首页" })).not.toHaveAttribute("aria-current");
    expect(baseElement.querySelector(".arco-menu-selected")?.textContent).toContain("国内指数");
  });
});
