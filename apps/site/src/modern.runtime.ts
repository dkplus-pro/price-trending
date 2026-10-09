import { defineRuntimeConfig } from "@modern-js/runtime";

import { ROUTER_BASENAME } from "./config/router";

// 路由 basename:纯静态部署(GitHub Pages)时挂仓库 basePath,SSR/根路径部署为空串。
// 约定文件名必须是 src/modern.runtime.ts(写错会被框架静默忽略,admin 踩过此坑);
// basename 为空串时传 undefined,走框架默认(无前缀)。
export default defineRuntimeConfig({
  router: {
    basename: ROUTER_BASENAME || undefined
  }
});
