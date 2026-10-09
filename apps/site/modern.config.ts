import { writeFileSync } from "node:fs";
import path from "node:path";

import { appTools, defineConfig, type Rspack } from "@modern-js/app-tools";

// site 默认 8082(server 8080 / admin 8081 已占用,见 docs/quality-and-site-plan.md 阶段 17)。
const devServerPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8082;

// dev 代理 /api → Go server(e2e 起独立端口的服务端时用 API_PROXY_TARGET 覆盖)。
// 契约路径字面带 /api/site 前缀,开发态原样透传(见 docs/multi-audience-contracts.md)。
const apiProxyTarget = process.env.API_PROXY_TARGET ?? "http://localhost:8080";

// 生产静态资源前缀 / 路由 basename(GitHub Pages 演示部署以仓库 basePath 优先:
// GITHUB_PAGES_BASE_PATH 显式传值 > 自动推断,helper 与 admin 同款)。
// 纯静态导出(SITE_STATIC_EXPORT=true)时:SSR 关闭走 CSR,产物扁平化(basePath 下
// /gold 这类深链由 404.html 兜底),资源前缀与路由 basename 都要带 basePath。
// 注意两个规范化方向不同:basename 去尾斜杠(router basename 不接受尾斜杠),
// assetPrefix 带尾斜杠(静态资源目录拼接)。
const staticExport = process.env.SITE_STATIC_EXPORT === "true";

const githubPagesBasePath = normalizeGitHubPagesBasePath(
  process.env.GITHUB_PAGES_BASE_PATH ?? inferGitHubPagesBasePath()
);

function inferGitHubPagesBasePath() {
  if (process.env.GITHUB_ACTIONS !== "true" || !process.env.GITHUB_REPOSITORY) {
    return undefined;
  }

  const repositoryName = process.env.GITHUB_REPOSITORY.split("/").pop();
  return repositoryName ? `/${repositoryName}/` : undefined;
}

function normalizeGitHubPagesBasePath(basePath?: string) {
  const trimmedBasePath = basePath?.trim();
  if (!trimmedBasePath || trimmedBasePath === "/") {
    return undefined;
  }

  return `/${trimmedBasePath.replace(/^\/+|\/+$/g, "")}/`;
}

const routerBasename = staticExport ? (githubPagesBasePath?.replace(/\/$/, "") ?? "") : "";

// 生产构建注入 CSP meta(XSS 防御,仅生产注入:dev 的 HMR/内联脚本会被 CSP 破坏,
// 与 admin 同策略,见 docs/site.md「安全」)。SSR 会内联 loader 数据 script,严格
// 'self' 会拦内联 script,起步放开 'unsafe-inline';TODO:nonce 化后收紧。
// connect-src 联动上报端点:构建期 env 配置了 RUM_ENDPOINT / TRACK_ENDPOINT 时,
// 把其 origin 自动并入(仅协议+主机+端口,不带路径),保证监控/埋点上报不被 CSP 拦截;
// 未配置时保持 'self' 起步配置。托管层响应头 CSP 为权威配置。
function reportOrigins(): string[] {
  const origins: string[] = [];
  for (const value of [process.env.RUM_ENDPOINT, process.env.TRACK_ENDPOINT]) {
    if (!value) {
      continue;
    }
    try {
      const origin = new URL(value).origin;
      if (origin !== "null" && !origins.includes(origin)) {
        origins.push(origin);
      }
    } catch {
      // 非法 URL 不并入 CSP(CSP 配置错误应显式暴露而非静默放宽)
    }
  }
  return origins;
}

// 行情源域名(行情页由浏览器直连,与部署形态无关,connect-src 无条件放行,见 T1e 卡片)。
const MARKET_CONNECT_SRC = [
  "https://push2.eastmoney.com",
  "https://1.push2.eastmoney.com",
  "https://82.push2.eastmoney.com",
  "https://push2delay.eastmoney.com",
  "https://push2his.eastmoney.com",
  "https://1.push2his.eastmoney.com",
  "https://82.push2his.eastmoney.com",
  "https://push2delayhis.eastmoney.com",
  "https://web.ifzq.gtimg.cn",
  "https://ifzq.gtimg.cn",
  "https://qt.gtimg.cn",
  "https://proxy.finance.qq.com",
  "https://api.gold-api.com",
  // 公共 CORS 代理(东财全域名不可达时的最末端传输层兜底,仅 auto 链使用,见 docs/site.md 行情页小节)
  "https://api.allorigins.win",
  "https://api.codetabs.com"
];

const productionCSP = [
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  `connect-src 'self'${MARKET_CONNECT_SRC.map((origin) => ` ${origin}`).join("")}${reportOrigins()
    .map((origin) => ` ${origin}`)
    .join("")}`
].join("; ");

const productionCSPMeta = {
  "Content-Security-Policy": {
    "http-equiv": "Content-Security-Policy",
    content: productionCSP
  }
};

// RUM 配置构建期内联:客户端 bundle 不存在 Node 的 process,裸 process.env 引用会
// ReferenceError(实测踩过),因此把 process.env.RUM_* 显式内联为字面量;
// 未配置时内联为空串,readRumConfig 判空即不初始化(dev 默认关闭,见 docs/site.md「监控」)。
// 构建期内联意味着部署时 RUM_ENDPOINT/RUM_PID 需在构建(CI)阶段注入,而非仅运行时。
const rumDefine = {
  "process.env.RUM_PID": JSON.stringify(process.env.RUM_PID ?? ""),
  "process.env.RUM_ENDPOINT": JSON.stringify(process.env.RUM_ENDPOINT ?? "")
};

// 路由 basename 构建期内联:客户端 bundle 无 Node process,源码里以
// `process.env.SITE_ROUTER_BASENAME ?? ""` 成员访问写法读(config/router.ts),
// 构建期替换为字面量;SSR / 根路径部署内联为空串(basename 走框架默认)。
const routerDefine = {
  "process.env.SITE_ROUTER_BASENAME": JSON.stringify(routerBasename)
};

// Arco 按需加载(官方 recipe):组件按 es/<Component> 引入并随带 style,
// 图标单独一条 react-icon 规则且不引样式。arco 的目录是 PascalCase,
// 因此必须关掉默认的 camelToDashComponentName(否则会去找 es/config-provider)。
// 全量 arco.css 已移除(阶段 2):样式经 transformImport 按需注入。
const arcoTransformImport = [
  {
    libraryName: "@arco-design/web-react",
    libraryDirectory: "es",
    camelToDashComponentName: false,
    style: true
  },
  {
    libraryName: "@arco-design/web-react/icon",
    libraryDirectory: "react-icon",
    camelToDashComponentName: false,
    style: false
  }
];

// 构建分析由环境变量 ANALYZE 门控(仅显式 "true" 生效,build:analyze 脚本负责注入)。
// @rsbuild/core@2.1.0(Modern.js 3.5 底层)的 performance 配置已无 bundleAnalyze 字段,
// 因此用 tools.rspack 挂一个只读 stats 的极简插件,把报告写到固定名文件;
// 报告落在 dist/(已被 .gitignore 覆盖),不引入额外分析器依赖。
const analyzeEnabled = process.env.ANALYZE === "true";

const bundleReportDir = path.resolve(process.cwd(), "dist");

const bundleAnalyzePlugin: Rspack.RspackPluginInstance = {
  apply(compiler) {
    compiler.hooks.done.tap("site-bundle-analyze", (stats) => {
      // SSR 构建有 client/server 两个环境,各自落固定名报告,避免相互覆盖。
      const environmentName = compiler.name || "default";
      const report = stats.toJson({
        all: false,
        assets: true,
        chunks: true,
        modules: true
      });
      writeFileSync(
        path.join(bundleReportDir, `bundle-report.${environmentName}.json`),
        JSON.stringify(report, null, 2)
      );
    });
  }
};

export default defineConfig({
  source: {
    define: { ...rumDefine, ...routerDefine },
    transformImport: arcoTransformImport
  },
  tools: {
    rspack: (config) => {
      if (analyzeEnabled) {
        config.plugins?.push(bundleAnalyzePlugin);
      }
    }
  },
  html: {
    title: "CMS Template",
    // 纯静态导出:产物扁平化到 dist 根(CSR 只出一份 index.html;basePath 下的
    // /gold、/indices 深链刷新由 404.html 兜底,见 scripts/copy-404.mjs)。
    ...(staticExport ? { outputStructure: "flat" as const } : {}),
    ...(process.env.NODE_ENV === "production" ? { meta: productionCSPMeta } : {})
  },
  // 静态导出的产物位置/资源前缀只在静态导出时出现:非静态(SSR)形态保持框架默认产物结构。
  ...(staticExport
    ? {
        output: {
          distPath: { html: "" },
          assetPrefix: githubPagesBasePath ?? "/"
        }
      }
    : {}),
  server: {
    port: devServerPort,
    // SSR 开启后路由模块的 loader(page.data.ts / layout.data.ts)在服务端执行,
    // 数据随 HTML 下发,客户端 hydration 复用(见 docs/site.md「SSR 注意事项」)。
    // 纯静态导出(GitHub Pages)关闭 SSR 走纯 CSR:现有 layout/page 的 loader 在客户端
    // 执行且已 try/catch 降级 null,静态托管上 /api 快速 404 不会炸页面。
    ssr: staticExport ? false : true
  },
  dev: {
    server: {
      proxy: {
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true
        }
      }
    }
  },
  plugins: [appTools()]
});
