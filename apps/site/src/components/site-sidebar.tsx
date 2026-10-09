import "@arco-design/web-react/es/_util/react-19-adapter";
import { Menu } from "@arco-design/web-react";
import { Link, useLocation } from "@modern-js/runtime/router";

import { matchNavKey, toAppPathname } from "../config/router";
import { NAV_ITEMS } from "../config/site";
import { useIsMobile } from "../hooks/use-breakpoint";

import "./site-sidebar.css";

// 桌面专属左侧导航(移动端导航由页头的汉堡 + 抽屉承担,见 components/site-header.tsx)。
// useIsMobile 在 SSR 固定返回 false(桌面),因此侧栏随 HTML 直出、挂载后再按真实断点隐藏,
// 与现有页头菜单的 hydration 模式一致(断点约定见 docs/site.md)。
export default function SiteSidebar() {
  const isMobile = useIsMobile();
  const location = useLocation();
  const selectedKey = matchNavKey(toAppPathname(location.pathname));

  if (isMobile) {
    return null;
  }

  return (
    <aside className="site-sidebar">
      <Menu className="site-sidebar-menu" mode="vertical" selectedKeys={[selectedKey]}>
        {NAV_ITEMS.map((item) => {
          const NavIcon = item.icon;
          const selected = item.path === selectedKey;
          return (
            <Menu.Item key={item.path}>
              <Link
                className="site-sidebar-link"
                to={item.path}
                aria-current={selected ? "page" : undefined}
              >
                <NavIcon className="site-sidebar-icon" />
                <span className="site-sidebar-label">{item.label}</span>
              </Link>
            </Menu.Item>
          );
        })}
      </Menu>
    </aside>
  );
}
