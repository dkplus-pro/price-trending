// K 线 / 分时图表组件(AntV G2 v5;spec 构造见 ./chart-spec.ts,纯函数单独可测)。
//
// 纯展示:直接把传入的全部 bars/trendPoints 交给 buildKlineSpec/buildTrendSpec,组件不维护可视窗口
// (历史深度由页面级全局日期范围筛选决定),不注册滚轮/触屏平移,也不请求更早历史。
// 悬停红虚线是组件层 overlay(原生 pointermove/pointerleave 只用于定位,不 preventDefault、不碰 G2 spec,
// 与 G2 自带的灰色十字光标共存:竖实线定 x、灰横虚线吸附数据点,红虚线跟随鼠标 y)。
//
// SSR 纪律(docs/site.md):@antv/g2 只在 useEffect 内动态 import(模块级缓存 promise),模块顶层与
// render 体不出现(下面的 `import type` 编译期擦除,不进运行时模块图);容器是普通 div,SSR 与客户端
// 首帧结构一致,图表渲染全部发生在挂载之后。悬停态的初值为 null(SSR/首帧不渲染虚线),仅客户端事件后变化。
import "@arco-design/web-react/es/_util/react-19-adapter";
import { Empty, Spin } from "@arco-design/web-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import type { G2Spec } from "@antv/g2";

import type { KlineBar, TrendPoint } from "../../api/market/types";
import { computeMA } from "../../api/market/utils";
import {
  buildKlineSpec,
  buildTrendSpec,
  DOWN_COLOR,
  FLAT_COLOR,
  formatTrendLabel,
  MA_COLORS,
  UP_COLOR
} from "./chart-spec";
import "./kline-chart.css";

/** 组件入参(冻结接口,父级与测试按此对接)。 */
export interface KlineChartProps {
  mode: "kline" | "trend";
  /** K 线数据(mode="kline";按 time 升序,末根最新)。 */
  bars?: KlineBar[];
  /** 分时数据(mode="trend")。 */
  trendPoints?: TrendPoint[];
  /** 昨收:分时画参考线用,缺失不画。 */
  prevClose?: number | null;
  hasVolume: boolean;
  hasAvgLine: boolean;
  /** 图表高度(桌面 420 / 移动 300,由父级传)。 */
  height: number;
  loading: boolean;
}

/** G2 图表实例用到的最小接口(真实类型在动态 import 之后取得)。 */
interface G2ChartInstance {
  options: (spec: G2Spec) => unknown;
  render: () => unknown;
  destroy: () => void;
}

/** MA 周期集合 = 线色表键(5/10/20)。 */
const MA_PERIODS = Object.keys(MA_COLORS).map((key) => Number(key));
/** 分时 x 轴刻度数:固定 6(不再按移动端二分——组件已不测容器宽度,桌面/移动统一值最简单)。 */
const TREND_TICK_COUNT = 6;

/** 动态加载缓存:只在 effect 内触发,SSR 阶段不会被调用。 */
let g2ModulePromise: Promise<typeof import("@antv/g2")> | null = null;

function loadG2(): Promise<typeof import("@antv/g2")> {
  g2ModulePromise ??= import("@antv/g2");
  return g2ModulePromise;
}

export function KlineChart(props: KlineChartProps): JSX.Element {
  const { mode, bars, trendPoints, prevClose, hasVolume, hasAvgLine, height, loading } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<G2ChartInstance | null>(null);
  const shapeRef = useRef<string | null>(null);
  /** 悬停红虚线的 y(相对图表容器顶部的 px,整数);null = 指针不在图上,不渲染。 */
  const [hoverY, setHoverY] = useState<number | null>(null);

  const total = mode === "trend" ? (trendPoints?.length ?? 0) : (bars?.length ?? 0);

  // MA 按全量数据算(整段数据都在图上,不存在窗口外历史问题)。
  const closes = useMemo(() => (bars ?? []).map((bar) => bar.close), [bars]);
  const ma = useMemo(() => computeMA(closes, MA_PERIODS), [closes]);

  const viewSpec = useMemo<G2Spec | null>(() => {
    if (total <= 0) return null;
    if (mode === "trend") {
      const points = (trendPoints ?? []).map((point, index) => ({
        idx: index,
        label: formatTrendLabel(point.time),
        price: point.price,
        // 分钟级 OHLC 透传给 spec(浮标行用;源未提供为 null)。
        open: point.open,
        high: point.high,
        low: point.low,
        avgPrice: point.avgPrice,
        volume: point.volume
      }));
      return buildTrendSpec({
        points,
        prevClose: prevClose ?? null,
        showAvg: hasAvgLine,
        hasVolume,
        upColor: UP_COLOR,
        downColor: DOWN_COLOR,
        tickCount: TREND_TICK_COUNT
      });
    }
    return buildKlineSpec({
      bars: bars ?? [],
      ma,
      hasVolume,
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      flatColor: FLAT_COLOR,
      maColors: MA_COLORS
    });
  }, [mode, bars, trendPoints, ma, hasVolume, hasAvgLine, prevClose, total]);

  // spec 形状(周期 / 量柱 / 均价线 / 昨收线切换)变化时销毁重建:形状变化后 G2 的增量更新会残留
  // 旧子节点;形状不变(仅数据变化)时整份 spec 覆盖更新(禁止 V4 链式与多次部分 options 叠加)。
  const shapeKey = [
    mode,
    hasVolume ? "vol" : "novol",
    mode === "trend" ? (hasAvgLine ? "avg" : "noavg") : "ma",
    prevClose === null ? "noprev" : "prev"
  ].join("|");

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !viewSpec) return undefined;
    let cancelled = false;
    void loadG2().then(({ Chart }) => {
      if (cancelled || !containerRef.current) return;
      if (shapeRef.current !== shapeKey) {
        chartRef.current?.destroy();
        chartRef.current = new Chart({ container: containerRef.current, autoFit: true, height });
        shapeRef.current = shapeKey;
      }
      chartRef.current?.options({ ...viewSpec, height });
      chartRef.current?.render();
    });
    return () => {
      cancelled = true;
    };
  }, [viewSpec, shapeKey, height]);

  // 卸载销毁(独立 effect:数据变化不重建)。
  useEffect(() => {
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
      shapeRef.current = null;
    };
  }, []);

  // 悬停红虚线:只记录鼠标相对画布顶部的 y,离开即清空(不 preventDefault、不注册滚轮/触屏平移,
  // 不参与 G2 spec)。画布是 .market-chart 的首个子元素、无内外边距偏移,故该 y 可直接用作 overlay 的 top。
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const handlePointerMove = (event: PointerEvent): void => {
      setHoverY(Math.round(event.clientY - element.getBoundingClientRect().top));
    };
    const handlePointerLeave = (): void => setHoverY(null);
    element.addEventListener("pointermove", handlePointerMove);
    element.addEventListener("pointerleave", handlePointerLeave);
    return () => {
      element.removeEventListener("pointermove", handlePointerMove);
      element.removeEventListener("pointerleave", handlePointerLeave);
    };
  }, []);

  const isEmpty = total === 0;

  return (
    <div className="market-chart">
      <div className="market-chart-canvas" ref={containerRef} style={{ height }} />
      {hoverY === null ? null : <div className="market-chart-hoverline" style={{ top: hoverY }} />}
      {loading ? (
        <div className="market-chart-loading" role="status" aria-label="图表加载中">
          <Spin size={24} />
        </div>
      ) : null}
      {isEmpty && !loading ? (
        <div className="market-chart-empty">
          <Empty description="暂无数据" />
        </div>
      ) : null}
    </div>
  );
}
