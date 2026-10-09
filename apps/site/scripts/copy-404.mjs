// GitHub Pages 纯静态部署的 SPA 深链兜底:复制 dist/index.html 为 dist/404.html,
// 深链刷新(/gold、/indices 等)由 Pages 的 404 页面重新交给 CSR 路由接管。
// 产物缺 index.html 说明构建未执行或失败,直接报错非零退出,避免静默产出坏包。
import { copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const distDir = resolve(import.meta.dirname, "..", "dist");
const indexHtml = join(distDir, "index.html");
const notFoundHtml = join(distDir, "404.html");

if (!existsSync(indexHtml)) {
  console.error(
    `[copy-404] 未找到 ${indexHtml}:请先执行 SITE_STATIC_EXPORT=true modern build 生成静态产物`
  );
  process.exit(1);
}

copyFileSync(indexHtml, notFoundHtml);
console.info(`[copy-404] 已生成 ${notFoundHtml}`);
