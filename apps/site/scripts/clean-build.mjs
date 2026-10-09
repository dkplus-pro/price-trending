// 构建前清空 dist 产物目录。
// 背景:本地若残留上一次构建(或其他形态/dev server)的产物,check-budgets 会把新旧 chunk
// 一起统计导致误报。CI 干净检出不受影响,本脚本只为本地反复构建兜底。
// 注意:不要在 dev server 运行时执行生产构建——dev 的增量产物会并发写入 dist 造成污染。
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const siteRoot = dirname(dirname(fileURLToPath(import.meta.url)));
rmSync(join(siteRoot, "dist"), { recursive: true, force: true });
console.info("[clean-build] 已清空 dist");
