import "@arco-design/web-react/es/_util/react-19-adapter";
import { Skeleton } from "@arco-design/web-react";

import type { InstrumentConfig, Quote } from "../../api/market/types";
import {
  MISSING_TEXT,
  formatAmountCn,
  formatPct,
  formatPrice,
  formatQuoteTime,
  formatSigned,
  formatUnsignedPct,
  formatVolumeCn
} from "../../api/market/utils";

import "./quote-header.css";

/** 涨跌方向(配色三分支):up 红 / down 绿 / flat 灰。 */
type TrendDirection = "up" | "down" | "flat";

interface QuoteHeaderProps {
  instrument: InstrumentConfig;
  quote: Quote | null;
  /** 快照加载中:渲染骨架屏。 */
  loading: boolean;
}

interface StatItem {
  label: string;
  value: string;
}

/**
 * 涨跌方向:优先用涨跌额 change(> 0 红 / < 0 绿 / = 0 灰);
 * change 缺失时用 price 与 prevClose 推断,两者再缺按 flat 处理。
 */
function resolveTrendDirection(quote: Quote): TrendDirection {
  if (quote.change !== null && Number.isFinite(quote.change)) {
    if (quote.change > 0) {
      return "up";
    }
    return quote.change < 0 ? "down" : "flat";
  }
  if (
    quote.price !== null &&
    quote.prevClose !== null &&
    Number.isFinite(quote.price) &&
    Number.isFinite(quote.prevClose)
  ) {
    if (quote.price > quote.prevClose) {
      return "up";
    }
    return quote.price < quote.prevClose ? "down" : "flat";
  }
  return "flat";
}

/**
 * 统计项(参考图统计行顺序):今开 / 昨收 / 最高 / 最低 / 振幅 / 成交量 / 成交额 / 更新时间。
 * 成交量仅 hasVolume 标的渲染,成交额仅 hasAmount 标的渲染(伦敦金两项都不渲染);
 * 成交量单位:instrument.volumeUnit 有值才标(如「手」),缺失或量缺失都不标。
 */
function buildStatItems(quote: Quote, instrument: InstrumentConfig): StatItem[] {
  const decimals = instrument.priceDecimals;
  const items: StatItem[] = [
    { label: "今开", value: formatPrice(quote.open, decimals) },
    { label: "昨收", value: formatPrice(quote.prevClose, decimals) },
    { label: "最高", value: formatPrice(quote.high, decimals) },
    { label: "最低", value: formatPrice(quote.low, decimals) },
    { label: "振幅", value: formatUnsignedPct(quote.amplitudePct) }
  ];
  if (instrument.hasVolume) {
    const volume = formatVolumeCn(quote.volume);
    items.push({
      label: "成交量",
      value: volume === MISSING_TEXT ? MISSING_TEXT : `${volume}${instrument.volumeUnit ?? ""}`
    });
  }
  if (instrument.hasAmount) {
    items.push({ label: "成交额", value: formatAmountCn(quote.amount) });
  }
  items.push({ label: "更新时间", value: formatQuoteTime(quote.time) });
  return items;
}

/**
 * 单标的实时快照区块(参考图顶部):左块现价 + 涨跌额/涨跌幅,右块统计网格。
 * 空值一律渲染 "--"(MISSING_TEXT);错误态只给文案,重试按钮由父级(InstrumentSection)提供。
 */
export default function QuoteHeader({ instrument, quote, loading }: QuoteHeaderProps) {
  if (loading) {
    return (
      <div
        className="quote-header quote-header-loading"
        role="status"
        aria-label="行情加载中"
        aria-busy="true"
      >
        <Skeleton animation image={false} text={{ rows: 3, width: ["36%", "92%", "64%"] }} />
      </div>
    );
  }

  if (quote === null) {
    return (
      <div className="quote-header quote-header-error" role="alert">
        行情加载失败
      </div>
    );
  }

  const trend = resolveTrendDirection(quote);

  return (
    <div className="quote-header">
      <div className={`quote-header-price quote-header-price-${trend}`} data-trend={trend}>
        <span className="quote-header-last">
          {formatPrice(quote.price, instrument.priceDecimals)}
        </span>
        <span className="quote-header-change">
          <span className="quote-header-change-amount">
            {formatSigned(quote.change, instrument.priceDecimals)}
          </span>
          <span className="quote-header-change-pct">{formatPct(quote.changePct)}</span>
        </span>
      </div>
      <dl className="quote-header-stats">
        {buildStatItems(quote, instrument).map((item) => (
          <div className="quote-header-stat" key={item.label}>
            <dt className="quote-header-stat-label">{item.label}</dt>
            <dd className="quote-header-stat-value">{item.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
