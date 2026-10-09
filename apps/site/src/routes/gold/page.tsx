import "@arco-design/web-react/es/_util/react-19-adapter";
import { Button } from "@arco-design/web-react";

import { GOLD_IDS } from "../../api/market/config";
import InstrumentSection from "../../components/market/instrument-section";
import MarketFilterBar from "../../components/market/market-filter-bar";
import { usePageQuotes } from "../../components/market/use-page-quotes";
import { useMarketFilterStore } from "../../store/market-filter";

import "./page.css";

// 黄金价格页。纯静态 + 纯客户端取数:不建 page.data.ts(loader 会破坏静态导出),
// 行情数据由浏览器侧直连公开行情源(东财 / 腾讯 / gold-api,取数编排见 src/api/market 与
// components/market/use-page-quotes.ts)。区块数量由 GOLD_IDS 配置驱动:新增标的只改 config。
// 周期 / 日期范围 / 数据源由顶部全局筛选栏(MarketFilterBar)统一控制;快照跟随数据源选择。
export default function GoldPage() {
  const source = useMarketFilterStore((state) => state.source);
  const { instruments, quoteMap, loading, error, refresh } = usePageQuotes(GOLD_IDS, source);

  return (
    <main className="market-page market-page-gold">
      <p className="market-page-note">数据来源于公开行情接口,仅供参考</p>
      {/* 筛选栏直接作为 .market-page 的子项:中间再包一层会让 sticky 的包含块与自身等高,吸顶失效。 */}
      <MarketFilterBar />
      {error === null ? null : (
        <div className="market-page-error" role="alert">
          <span className="market-page-error-text">行情加载失败:{error}</span>
          <Button size="small" onClick={refresh}>
            重试
          </Button>
        </div>
      )}
      {instruments.map((instrument) => (
        <InstrumentSection
          key={instrument.id}
          instrument={instrument}
          quote={quoteMap.get(instrument.id) ?? null}
          quoteLoading={loading}
          onRetryQuote={refresh}
        />
      ))}
    </main>
  );
}
