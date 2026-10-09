# Site 开发规范(对外网站)

本文是对外网站 app(`apps/site`)的开发规范全集,与 [admin 开发规范](./admin.md)、
[server 开发规范](./server.md) 平级;仓库通用规则见 [development.md](./development.md)。
site 由 Modern.js SSR(appTools + `server.ssr: true`)驱动,消费 `openapi/site.yaml`
公开契约(见 [multi-audience-contracts.md](./multi-audience-contracts.md))。

## 目录结构

```text
apps/site/
  modern.config.ts      SSR/端口/dev 代理/html 配置
  orval.config.ts       由 openapi/site.yaml 生成接口函数(与 admin 同款流水线)
  src/
    api/                client.ts(mutator)/ controllers.gen.ts(绑定层)/ generated/(生成物,禁手改)
    components/         跨页面复用组件(site-header / site-footer …)
    hooks/              复用 hooks(use-breakpoint …)
    store/              zustand 客户端全局状态(每个领域一个 useXxxStore)
    constants/          全局常量(版权文案、导航项等)
    config/             运行时配置装配(如 RUM 初始化参数)
    utils/              纯数据操作工具
    routes/             文件路由:layout.tsx(根布局)/ page.tsx(首页)/ $.tsx(404 兜底)
                        及同名的 .data.ts(loader,服务端数据加载)
  tests/                Vitest + RTL 用例(见「测试」)
```

- `api/` 生成物与绑定层由 `pnpm gen:api` 生成,禁止手改;前端接口函数一律经
  `client.ts` 的 mutator(orval `customInstance`),不在页面手写请求函数;
- `src/config`、`src/utils` 为预留分区,出现首个真实文件后删除 `.gitkeep`。

## 接口契约

- site 只消费 `openapi/site.yaml`(`/api/site/*`,只读公开接口);改接口先改契约再
  `pnpm gen:api`,两侧不允许出现与契约不一致的手写类型(与 admin 同纪律);
- `client.ts` 双端 baseURL 规则:SSR 服务端进程内无"同源"概念,用绝对地址
  (env `SITE_API_BASE`,默认 `http://127.0.0.1:8080`);浏览器端保持空串走同源
  相对路径(dev 由 Modern.js 代理 `/api`,生产由网关同域转发)。SSR 环境判断统一用
  `typeof window === "undefined"`;
- 公开站无会话:client 不做 token 注入、不做 401 跳转,只保留 `{code, message, data}`
  信封解包与错误 console。

## 数据加载(SSR)

- 数据加载统一用 Modern.js App Router 的 loader 约定:`src/routes/*.data.ts` 具名导出
  `loader`,SSR 下在服务端执行,数据随 HTML 下发、客户端 hydration 复用;组件内用
  `useLoaderData()`(从 `@modern-js/runtime/router` 导入,react-router 7 语义)读取;
- **loader 内不得引用任何客户端状态**(window/localStorage/zustand 均禁止);
- loader 必须自捕获请求失败(try/catch 返回 `null` 降级),服务端接口故障不得阻断
  整页 SSR 渲染,组件对 `null` 渲染兜底文案;
- 服务端数据不进 zustand:loader 拉取的数据只经 `useLoaderData` 消费;当前 layout 与
  首页各拉一次 site-info(页面主视觉自持数据),栏目页增多后可合并到 layout 一处。

## 行情页(黄金价格 / 国内指数)

### 页面清单

- `/gold` 黄金价格:黄金9999 / 伦敦金 / COMEX黄金;
- `/indices` 国内指数:上证指数 / 创业板指 / 科创50。

两页同为行情卡片列表(顶部全局筛选栏 + 各标的快照统计行 + K 线/分时图),共用
`src/components/market/` 组件与 `src/api/market` 数据层;新增标的见下方「新增指数指引」。

### 全局筛选栏

两页共用一个吸顶筛选栏(`src/components/market/market-filter-bar.tsx`),状态放全局 store
(`src/store/market-filter.ts`,zustand),**跨页保持**(切到另一页再回来,周期 / 日期范围 / 数据源不重置):

| 控件     | 取值                                      | 覆盖范围与限制                                                                                                                                                           |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 周期     | 分时 / 五日 / 日K / 周K / 月K(默认分时)   | 分时两档走走势接口(`getTrends`,60s 轮询);K 线三档走 `getKlines`                                                                                                          |
| 日期范围 | 默认 [近 365 天, 今天],禁选未来日期       | **仅 K 线三档消费**(去连字符后作 `beg`/`end` 范围查询);分时两档控件置禁用态并给 Tooltip 说明,store 值不清空,由图表侧按周期忽略                                           |
| 数据源   | 自动(多源兜底)/ 东方财富 / 腾讯(默认自动) | 「自动」走完整兜底链;指定源只请求该源、失败不回退,不可用的标的直接进区块错误态或渲染 `--`                                                                                |
| 快捷日期 | 一周 / 2周 / 1个月 / 3个月 / 半年 / 1年   | 一键把日期范围设为 [今天-跨度, 今天](周档按自然日、月档按日历月、年档按日历年,起点收口到目标月最后一天);起点终点与当前范围受控比对,命中才高亮;分时两档同日期范围一起禁用 |

指定源的覆盖限制(与下方兜底链同源):

- **腾讯无 au9999**:黄金9999 未配 `tencentCode`,指定腾讯时快照跳过请求(渲染 `--`)、K 线 / 分时抛错(区块错误态);
- **腾讯无外盘 K 线 / 分时**:伦敦金 / COMEX 的 `tencentCode` 为 `hf_` 前缀,腾讯只支持内盘代码,指定腾讯时快照仍出数(外盘快照体例),图表进错误态;
- 东财不可达(本机实测被限流,HTTP 000)时:「自动」先由公共 CORS 代理转发东财取数(见下方兜底链),
  仍不可用再回退腾讯;指定东财不试代理,两页区块出现错误态 + 重试(黄金 K 线 / 分时无腾讯兜底,
  指定东财失败即区块错误态)。

图表**不注册滚轮 / 触摸平移与缩放**:一次渲染日期范围内的全量数据,历史深度完全由「周期 + 日期范围」决定
(要看更早的历史改日期范围即可;分时两档由源侧固定 1 / 5 天,不受日期范围影响)。

图表**十字光标与浮标**(主图悬停):鼠标移入绘制区显示 tooltip 浮标 + 十字准线 —— 横向虚线定 y、
纵向实线定 x,准线色 `#86909c`(横 `[4,4]` 虚线、竖为实线,竖线必须显式给空 lineDash,否则会沿用画布上
一次的 dash 状态);配置在 `src/components/market/chart-spec.ts` 的 `tooltipInteraction`(官方 G2 5.4.8
字段:shared + crosshairs / crosshairsX(横,默认 false)/ crosshairsY(竖,默认 true)+ 线色线宽线型),
并按固定行序排序、过滤缺值行(null/undefined 不展示,0 照常展示)。十字准线只在 tooltip 的 series 分支
渲染,故 K 线用一条不可见的收盘价载体线(蜡烛实体是 interval,不是 series 元素)提供 series 入口与横向
准线锚点、分时由价格线承担;量柱副图是独立 view,准线与浮标只作用于主图,不跨子图联动。
真实网络验证:本机东财不可达,`/indices` 切「日K」后走腾讯兜底数据,悬停浮标给出当前区间内日期
(区间变更后同一位置日期随之前移),canvas 内竖线贯穿 + 横虚线由准线色像素扫描确认;
配置层断言见 `tests/market/chart-spec.test.ts`(crosshairs 字段、载体线 series 入口、行过滤与行序)。

### 数据层与 loader 豁免

```text
src/api/market/
  types.ts      契约类型(Quote / KlineBar / TrendPoint / MarketError 等)
  config.ts     INSTRUMENTS 六标的静态配置 + 分组 id 常量(GOLD_IDS / INDEX_IDS)
  utils.ts      纯格式化 / 计算函数(缺失显示 "--"、均线、日期位移等)
  throttle.ts   并发闸门 + 域名轮换 + 退避重试 + 带超时的原生 fetch 封装
  sources/      eastmoney.ts / tencent.ts / gold-api.ts(各源的取数与解析)
  index.ts      facade:getQuotes / getKlines / getTrends(兜底链、缺失态、埋点)
```

**loader 豁免**(根 AGENTS.md §19 与上文「数据加载(SSR)」的适用边界):该目录数据来自
东财 / 腾讯 / gold-api 的**第三方公开只读 API**,不是本仓库 server 的 `openapi/site.yaml`
契约数据,由浏览器直连;纯静态部署(`SITE_STATIC_EXPORT=true`)下没有服务端,
**loader 无法承载**(行情还需客户端定时轮询刷新)。因此本模块不进 orval 管线、不改
`openapi/site.yaml`、不使用 `src/api/client.ts`(契约 mutator),按客户端 `useRequest` +
轮询取数;网络统一用原生 fetch(腾讯快照为 GBK,按 arrayBuffer 解码后交
`TextDecoder("gbk")`)。

### 数据兜底链

每级「失败 / 无数据」都进下一级;最终仍缺的标的渲染 `--`(price 为 0 是合法行情):

| 能力             | 主源                             | 传输层兜底(仅「自动」链)                 | 兜底一                          | 兜底二                                  |
| ---------------- | -------------------------------- | ---------------------------------------- | ------------------------------- | --------------------------------------- |
| 快照 `getQuotes` | 东财批量(一次请求覆盖全部 secid) | 公共 CORS 代理转发东财(push2 直连池末尾) | 腾讯批量(指数全形态 + 外盘快照) | gold-api(XAU 快照)                      |
| K 线 `getKlines` | 东财                             | 公共 CORS 代理转发东财(push2his 池末尾)  | 腾讯(仅非 `hf_` 代码)           | 抛 MarketError(UI 显示「暂无数据」)     |
| 分时 `getTrends` | 东财                             | 公共 CORS 代理转发东财(push2his 池末尾)  | 腾讯(仅非 `hf_` 代码)           | 抛 MarketError(伦敦金/COMEX 无分时兜底) |

- 东财域名池按端点分两组:快照走实时行情域(push2 / 82.push2),K 线 / 分时走历史行情域
  (push2his / 82.push2his);「自动」链在各自直连域名之后追加**公共 CORS 代理**垫底
  (api.allorigins.win、api.codetabs.com;源内把完整东财 URL `encodeURIComponent` 进 `{url}` 模板,
  响应体即东财原 JSON、解析路径与直连相同),用于本机 / 部分网络对 eastmoney 全域不可达
  (实测 HTTP 000)时仍能出图;代理请求超时放宽到 15s(直连 10s);
- **代理为公共免费服务**:可用性 / 限流 / 数据完整性均不由本仓库保证(2026-10-09 本机 curl 实测
  ——含浏览器 UA 与 Origin 头——三个候选全部不可用:api.allorigins.win 522、api.codetabs.com 522、
  corsproxy.io 401 需 API Key;另试 cors.lol / cors.eu.org(429)、whateverorigin(500)、
  thingproxy / yacdn(000)、r.jina.ai(401)、cors-anywhere(403)同样不可用,故代理选型未获实证,
  仅按「无 Key、曾支持裸 JSON 转发」保留为最后兜底);代理也失败时维持原错误态;
  验证手段:接线路由拦截(playwright 模拟直连全封锁 + 代理取回夹具)见
  `tests/playwright/market-gold.spec.ts`,真实出图未能在本机网络验证;
- 代理仅属于「自动」链:数据源指定东方财富时只用直连域名池(不试代理,单源语义与错误归属不变);
- au9999(上金所 黄金9999)只有东财链(无 tencentCode / goldApiSymbol);
- 腾讯外盘(`hf_` 前缀)体例缺涨跌幅 / 振幅字段,解析后按价格与昨收推导补齐(只补 null);
- 腾讯 K 线范围查询(带 `beg`)的 count 受源校验约束:实测(2026-10-09)2000 正常返回区间数据、
  2500 起返回 `param error`(解析后表现为「无数据」),故区间取数上限钉定为 2000 根
  (`RANGE_KLINE_COUNT`,约 8 年日线,足够覆盖筛选栏可选区间);
- 每次回退与最终失败各上报一条埋点(`market_source_fallback` / `market_data_error`)。

### 频控

- 快照轮询 15s(`QUOTE_POLL_INTERVAL_MS`);分时 60s,日/周/月 K 不轮询;
- 所有真实请求经 `throttle.ts` 的调度器:并发上限 2(多卡片共享同一进程内单例)、失败退避
  800ms → 2000ms、重试按 attempt 在域名池内轮换(腾讯 qt / web.ifzq 与 gold-api 单域名最多 3 次
  尝试;东财「自动」链域名池 4 个——直连 2 + 代理 2——`retries = 池长 - 1`,每个域名各试一次,
  保证轮换能走到垫底的代理),降低东财连续快发被限流(HTTP 000,40–60s 恢复)的命中率;
- 单请求超时 10s(公共 CORS 代理 15s)。

### 新增指数指引

只改 `src/api/market/config.ts` 两处:

1. `INSTRUMENTS` 追加一项(必填 `id` / `name` / `category` / `secid` / `priceDecimals` /
   `hasVolume` / `hasAmount` / `hasAvgLine`;`tencentCode` 等可选字段按源真实响应核对);
2. 把新 `id` 加进 `INDEX_IDS`(黄金同理加 `GOLD_IDS`)——分组筛选、列表顺序与兜底链都由
   INSTRUMENTS 派生的 id 常量驱动,页面与数据层无需改动。

### GitHub Pages 构建

- `SITE_STATIC_EXPORT=true` 关闭 SSR 走 CSR、产物扁平化并复制 `dist/404.html`
  (basePath 下 `/gold`、`/indices` 深链刷新由它兜底);资源前缀与路由 basename 由
  `GITHUB_PAGES_BASE_PATH` 注入(缺省在 GitHub Actions 内按仓库名自动推断),产物引用带
  basePath 前缀;
- 命令(`modern build` → `scripts/copy-404.mjs` → `scripts/check-budgets.mjs`):

  ```bash
  GITHUB_PAGES_BASE_PATH=/price-trending SITE_STATIC_EXPORT=true NODE_ENV=production \
    pnpm --filter @monorepo-template/site run build:github-pages
  ```

- 生产构建注入 CSP meta,`connect-src` 无条件放行行情源域名(见 `modern.config.ts` 的
  `MARKET_CONNECT_SRC`),静态托管下行情页仍可直连第三方源;清单:
  东财实时/历史域(push2 / push2his 及 `1.` / `82.` / `delay` 变体,共 8 个)、
  腾讯行情域(web.ifzq.gtimg.cn / ifzq.gtimg.cn / qt.gtimg.cn / proxy.finance.qq.com)、
  gold-api(api.gold-api.com)、公共 CORS 代理(api.allorigins.win / api.codetabs.com,即上文
  兜底链的传输层兜底,已随代理落地一并放行,不再有「代理被 connect-src 拦截」的遗留);
  构建期配置了 `RUM_ENDPOINT` / `TRACK_ENDPOINT` 时其 origin 自动并入(仅协议+主机+端口),
  未配置保持 `'self'` 起步;托管层响应头 CSP 为权威配置,meta 为兜底。

## 状态管理

- 客户端全局状态用 zustand(`src/store/`,每个领域一个 `useXxxStore`),如移动端
  菜单开合 `useUiStore`;
- 服务端状态一律走 loader,禁止 useEffect 手动拉接口、禁止 ahooks 的 useRequest。

## UI 与响应式

- **后台式固定布局**:顶栏 `.site-header`(`site-header.css`)与桌面左侧栏 `.site-sidebar`
  (`site-sidebar.css`)都是 `position: fixed`(脱离文档流,z-index 100 / 90),尺寸与偏移统一由
  `routes/layout.css` 的 `:root` 变量提供 —— `--site-header-h: 56px`(顶栏高)、
  `--site-sidebar-w: 200px`(侧栏宽);内容区以 `padding-top` 让位顶栏、桌面(≥ 768px)再以
  `padding-left` 让出侧栏,行情页筛选栏的吸顶偏移、侧栏顶边同样引用这两个变量(引用处各自带兜底值);
  移动端(< 768px)侧栏不渲染,导航回到页头右上角汉堡 + 抽屉(Drawer 默认 z-index 1001,高于固定顶栏);
- UI 优先用 `@arco-design/web-react` 基础组件;React 19 下必须在根布局顶部引入
  `@arco-design/web-react/es/_util/react-19-adapter`(与 admin 同做法);
- **响应式双端适配是硬要求**:每个页面的布局、导航、字号必须在 mobile(< 768px)与
  desktop(≥ 768px)双端可用;断点与 Arco Grid 的 md(768px)对齐,统一经
  `src/hooks/use-breakpoint.ts` 的 `useIsMobile()` 判断(matchMedia 实现);
- 断点判定 hook 必须对 SSR 安全:服务端固定按桌面渲染,挂载后再同步真实断点,
  保证 hydration 无告警;
- 复用规则:2 个及以上页面用 → 提到 `src/components`、`src/hooks`;单页面用 →
  留在页面目录内;
- 单文件超约 300 行必须拆分,页面主入口只做数据编排。

## 测试

- 单元/组件:Vitest + React Testing Library + jsdom(配置 `vitest.config.ts` 与
  `tests/setup.ts`,与 admin 同构);`window.matchMedia`、`ResizeObserver` 等 jsdom
  缺失 API 在 setup 补 shim;生成物不写用例;
- E2E:Playwright(根 `playwright.config.ts` 的 site project,dev 端口 18081,
  `API_PROXY_TARGET` 指向 e2e Go server);SSR 用 `javaScriptEnabled: false` 的
  硬证据用例固化;
- **计划期测试用例纪律**:做计划时必须先列出测试用例清单与边界条件(空值/零值/
  越界/权限缺失/网络失败/非法状态迁移六类必查),实现提交与用例同批交付。

## 安全

### XSS

- SSR 输出由 React 转义,业务代码**禁止使用 `dangerouslySetInnerHTML`**;富文本需求
  出现时先引 DOMPurify 消毒,并在评审中单独说明;
- 外部/媒体 URL 渲染前限定 `http(s)` 协议;
- 生产构建注入 CSP meta(`modern.config.ts` html 配置,仅生产;SSR 会内联 loader 数据
  script,起步用 `script-src 'self' 'unsafe-inline'`,nonce 化列 TODO);托管层响应头
  CSP 为权威配置,meta 为兜底。

### CSRF

- site 契约全部为 GET 公开只读、无 Cookie 无会话,CSRF **结构性不适用**
  (与 admin 的 Bearer 结论同理,见 docs/server.md「CSRF 与会话安全」);
- **约束**:site 未来新增写接口时,必须在 site 链挂 `OriginCheck` 中间件
  (server 阶段 10 已有,复用)且不得引入 Cookie 会话,二者缺一不得合并。

## 监控(RUM)

- 阿里云 ARMS 用户体验监控:`@arms/rum-browser`,初始化代码在 `src/config/rum.ts`,
  根布局客户端侧调用;
- 初始化条件:`typeof window !== "undefined"`(仅客户端)+ **动态 import** 不阻塞首屏 +
  env `RUM_ENDPOINT` 与 `RUM_PID` 均存在,任一缺失即不初始化——**dev 默认关闭**,
  生产部署注入(占位见 `apps/site/.env.example`);`spaMode: "history"`,
  `version` 取应用版本;
- **客户端配置走构建期内联**(`modern.config.ts` 的 `source.define` 把
  `process.env.RUM_*` 内联为字面量——浏览器无 `process`,裸 `process.env` 引用会
  ReferenceError):部署时 RUM 变量须在**构建(CI)阶段**注入,仅运行时注入对浏览器端无效;
- 上报内容:PV、JS 错误、Web 性能(SDK 默认采集);自定义埋点见下方「埋点(tracking)」。

## 埋点(tracking)

- 自研 facade(`src/tracking/`):业务只调 `track(event, payload?)` / `trackPageView(params)`,
  API 表面严格两方法;事件名与载荷类型登记在 `src/config/tracking-events.ts`
  (`TrackingPayloadMap`,未登记的事件无法通过编译);
- 三 sink 可组合:console(dev)/ RUM 自定义事件(`@arms/rum-browser` 的 sendEvent,
  复用 RUM_* 配置与判空门控)/ HTTP sendBeacon(`TRACK_ENDPOINT`,fetch keepalive 兜底);
- 开关走 `src/config/features.ts`:`TRACK_ENDPOINT` 缺失强制关,整体 no-op;
- **不引入第三方分析 SDK**;事件队列/离线持久化被明确否决(见 docs/site-shell-plan.md §2 决策 2);
- web-vitals(CLS/LCP/INP/FCP/TTFB)经 `initTracking()` 注册,指标映射进 sink。

## 稳定性

- 双层 ErrorBoundary(`src/components/error-boundary.tsx`):根层兜壳层错误、
  页面层兜 Outlet 内错误,各自上报 `react_render_error`;降级 UI 支持重试;
- 全局客户端初始化集中在 `routes/layout.tsx`:RUM(useRum)+ 埋点(initTracking),
  均 client-only 且 env 缺失自动 no-op;
- 路由级 loading:`routes/loading.tsx`(Modern.js 约定)+ `page-loading.tsx` 骨架屏;
- 接口韧性:`src/api/client.ts` 超时 10s、幂等 GET 指数退避重试 1 次(仅网络/5xx),
  最终失败上报 `api_error`;SSR 侧失败沿用 loader 降级 null 约定。

## 性能预算

- 预算配置坑:`apps/site/config/budgets.json`,检查脚本 `apps/site/scripts/check-budgets.mjs`
  (gzip 体积断言),P8 收口挂进 CI;
- 构建分析:`ANALYZE=true pnpm --filter @monorepo-template/site build`(stats 插件输出,
  rsbuild 无 bundleAnalyze 原生开关);
- Arco CSS 已按需引入(transformImport):562 kB 全量 → 82 kB(11 kB gzip);
  进一步收口(Menu/Drawer 全变体样式)列入后续。

## 环境变量

- `SITE_API_BASE` — SSR 服务端请求 Go server 的绝对地址(默认 `http://127.0.0.1:8080`);
- `API_PROXY_TARGET` — dev 代理目标(默认 `http://localhost:8080`);
- `RUM_ENDPOINT` / `RUM_PID` — RUM 上报端点与站点 PID(均缺失则不初始化;构建期内联,须构建时注入);
- 占位见 `apps/site/.env.example`;`.env.*` 已 gitignore,禁止提交真实密钥。
