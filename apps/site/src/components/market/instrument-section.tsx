import "@arco-design/web-react/es/_util/react-19-adapter";
import { Button } from "@arco-design/web-react";

import type { InstrumentConfig, KlineBar, MarketSource, Quote } from "../../api/market/types";
import { computeMA, formatPrice } from "../../api/market/utils";
import { useIsMobile } from "../../hooks/use-breakpoint";
import { useMarketFilterStore } from "../../store/market-filter";

import { KlineChart } from "./kline-chart";
import QuoteHeader from "./quote-header";
import { useChartData } from "./use-chart-data";

import "./instrument-section.css";

/** 来源角标文案(Quote.source → 展示名)。 */
const SOURCE_LABELS: Record<MarketSource, string> = {
  eastmoney: "东方财富",
  tencent: "腾讯",
  "gold-api": "gold-api"
};

/** 均线图例:周期 + 标签 + 色点(色值与 instrument-section.css 的变量一一对应)。 */
const MA_LEGEND_ITEMS = [
  { period: 5, label: "MA5", color: "var(--market-instrument-ma5, #ffb400)" },
  { period: 10, label: "MA10", color: "var(--market-instrument-ma10, #165dff)" },
  { period: 20, label: "MA20", color: "var(--market-instrument-ma20, #f76965)" }
] as const;

/** 图表高度:桌面 420 / 移动 300(避免小屏图表占满视口)。 */
const CHART_HEIGHT_DESKTOP = 420;
const CHART_HEIGHT_MOBILE = 300;

interface InstrumentSectionProps {
  instrument: InstrumentConfig;
  quote: Quote | null;
  quoteLoading: boolean;
  onRetryQuote: () => void;
}

/**
 * 均线图例行:最近一根可视数据的 MA5/10/20 值 + 色点。
 * 可视窗口由图表内部管理(缩放/拖拽不对外暴露),这里按最新一根 bar 的同口径取值。
 */
function MaLegend({ bars, decimals }: { bars?: KlineBar[]; decimals: number }) {
  if (bars === undefined || bars.length === 0) {
    return null;
  }
  const closes = bars.map((bar) => bar.close);
  const lines = computeMA(
    closes,
    MA_LEGEND_ITEMS.map((item) => item.period)
  );
  return (
    <div className="market-instrument-ma" aria-label="均线图例">
      {MA_LEGEND_ITEMS.map((item) => {
        const line = lines[item.period] ?? [];
        const latest = [...line].reverse().find((value) => value !== null) ?? null;
        return (
          <span className="market-instrument-ma-item" key={item.label}>
            <i
              className="market-instrument-ma-dot"
              style={{ background: item.color }}
              aria-hidden="true"
            />
            <span className="market-instrument-ma-label">{item.label}</span>
            <span className="market-instrument-ma-value">{formatPrice(latest, decimals)}</span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * 单标的数据分析区块(页面按标的平铺):标题行 → 快照 → 均线图例 → 图表。
 * 周期 / 日期范围 / 数据源由全局筛选栏(MarketFilterBar)写入 store,本区块只读并取数。
 * K 线周期在图表上方显示均线图例(与参考图一致);分时两档无均线,不渲染图例行。
 * 周期级取数错误只落在图表区(独立错误态 + 重试),不污染上方的快照区。
 */
export default function InstrumentSection({
  instrument,
  quote,
  quoteLoading,
  onRetryQuote
}: InstrumentSectionProps) {
  const isMobile = useIsMobile();
  const period = useMarketFilterStore((state) => state.period);
  const dateRange = useMarketFilterStore((state) => state.dateRange);
  const source = useMarketFilterStore((state) => state.source);
  const chart = useChartData(instrument, period, dateRange, source);

  const quoteMissing = quote === null && !quoteLoading;

  return (
    <section className="market-instrument" aria-label={instrument.name}>
      <header className="market-instrument-header">
        <h2 className="market-instrument-name">{instrument.name}</h2>
        {instrument.sessionHint === undefined ? null : (
          <span className="market-instrument-session-hint">{instrument.sessionHint}</span>
        )}
        {quote === null ? null : (
          <span className="market-instrument-source">源:{SOURCE_LABELS[quote.source]}</span>
        )}
      </header>

      <QuoteHeader instrument={instrument} quote={quote} loading={quoteLoading} />
      {quoteMissing ? (
        <div className="market-instrument-quote-retry">
          <Button size="small" onClick={onRetryQuote}>
            重试
          </Button>
        </div>
      ) : null}

      {chart.error === null ? (
        <>
          {/* MA 图例放图表上方(参考图:均线行紧邻图表);仅 K 线三档渲染。 */}
          {chart.mode === "kline" ? (
            <MaLegend bars={chart.bars} decimals={instrument.priceDecimals} />
          ) : null}
          <KlineChart
            mode={chart.mode}
            bars={chart.bars}
            trendPoints={chart.trendPoints}
            prevClose={chart.prevClose}
            hasVolume={instrument.hasVolume}
            hasAvgLine={instrument.hasAvgLine}
            height={isMobile ? CHART_HEIGHT_MOBILE : CHART_HEIGHT_DESKTOP}
            loading={chart.loading}
          />
        </>
      ) : (
        <div className="market-instrument-error" role="alert">
          <p className="market-instrument-error-title">该周期暂无数据或加载失败</p>
          <p className="market-instrument-error-detail">{chart.error}</p>
          <Button size="small" onClick={chart.retry}>
            重试
          </Button>
        </div>
      )}
    </section>
  );
}
