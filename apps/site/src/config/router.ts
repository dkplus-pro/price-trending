import { NAV_ITEMS } from "./site";

// 站点路由 basename 与导航选中态派生(唯一来源,页头抽屉与左侧栏共用)。
//
// ROUTER_BASENAME 由 modern.config.ts 的 source.define 构建期内联:
// 纯静态部署(GitHub Pages)时挂仓库 basePath(/price-trending),否则为空串(根路径)。
// 禁止加 typeof process 守卫——守卫会让内联后的表达式在浏览器走向错误分支;
// 也禁止包成普通函数调用,define 只替换字面量成员表达式 `process.env.SITE_ROUTER_BASENAME`。
export const ROUTER_BASENAME = process.env.SITE_ROUTER_BASENAME ?? "";

// URL 路径 → 应用内路径(剥离 basename)。basename 可显式传入以测试(默认取构建期内联常量);
// 不以 basename 开头(含无 basename)时原样返回;剥完为空串时回退 "/"。
export function toAppPathname(pathname: string, basename: string = ROUTER_BASENAME): string {
  if (!basename || !pathname.startsWith(basename)) {
    return pathname;
  }

  return pathname.slice(basename.length) || "/";
}

// 应用内路径 → 导航选中 key。"/" 精确匹配首页;其余取 NAV_ITEMS 非根项的最长匹配前缀
// (用 "/" 分段边界判定,避免 "/goldfish" 误命中 "/gold");无匹配回退首页。
export function matchNavKey(appPathname: string): string {
  if (!appPathname || appPathname === "/") {
    return "/";
  }

  let matched = "/";
  for (const item of NAV_ITEMS) {
    if (item.path === "/") {
      continue;
    }
    const isMatch = appPathname === item.path || appPathname.startsWith(`${item.path}/`);
    if (isMatch && item.path.length > matched.length) {
      matched = item.path;
    }
  }

  return matched;
}
