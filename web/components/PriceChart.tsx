"use client";
import { useEffect, useRef, useState } from "react";
import {
  createChart, CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers, LineStyle,
  type IChartApi, type ISeriesApi, type UTCTimestamp, type SeriesMarker, type Time,
  type ISeriesPrimitive, type SeriesAttachedParameter, type IPrimitivePaneView, type IPrimitivePaneRenderer,
} from "lightweight-charts";

type Pt = { time: number; value: number | null };
interface ZoneDto { kind: "FVG" | "OB"; direction: "LONG" | "SHORT"; top: number; bottom: number; fromTime: number }
interface ChartDto {
  tf: string; candles: { time: number; open: number; high: number; low: number; close: number }[];
  ema20: Pt[]; ema50: Pt[]; ema200: Pt[]; rsi: Pt[]; macd: Pt[]; macdSignal: Pt[]; macdHist: Pt[]; atr: Pt[];
  events: { time: number; type: string; direction: string; level: number }[];
  sweeps: { time: number; direction: string; levelName: string; extreme: number }[];
  zones: ZoneDto[]; fetchedAt: string | null; error?: string;
}
export interface Levels { direction: "LONG" | "SHORT"; entry: number; stop: number; tp1: number; tp2: number; tp3: number; label: string }

const C = { long: "#26a69a", short: "#ef5350", e20: "#6ea8fe", e50: "#e0a84a", e200: "#b48ead", grid: "#151b26", text: "#7b869a" };

/** Primitiva para dibujar zonas FVG / Order Block como rectángulos que se extienden a la derecha. */
class ZonesPrimitive implements ISeriesPrimitive<Time> {
  private p: SeriesAttachedParameter<Time> | null = null;
  private zones: ZoneDto[] = [];
  attached(p: SeriesAttachedParameter<Time>) { this.p = p; }
  detached() { this.p = null; }
  set(z: ZoneDto[]) { this.zones = z; this.p?.requestUpdate(); }
  updateAllViews() {}
  paneViews(): readonly IPrimitivePaneView[] {
    const self = this;
    const renderer: IPrimitivePaneRenderer = {
      draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]) {
        const p = self.p;
        if (!p) return;
        target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr, mediaSize }) => {
          for (const z of self.zones) {
            const x1 = p.chart.timeScale().timeToCoordinate(z.fromTime as UTCTimestamp);
            const y1 = p.series.priceToCoordinate(z.top), y2 = p.series.priceToCoordinate(z.bottom);
            if (x1 === null || y1 === null || y2 === null) continue;
            const col = z.direction === "LONG" ? "38,166,154" : "239,83,80";
            ctx.fillStyle = `rgba(${col},${z.kind === "OB" ? 0.13 : 0.08})`;
            ctx.strokeStyle = `rgba(${col},0.35)`;
            ctx.lineWidth = 1;
            const x = x1 * hr, y = Math.min(y1, y2) * vr, w = (mediaSize.width - x1) * hr, h = Math.max(1, Math.abs(y2 - y1) * vr);
            ctx.fillRect(x, y, w, h);
            ctx.setLineDash(z.kind === "FVG" ? [4 * hr, 3 * hr] : []);
            ctx.strokeRect(x, y, w, h);
            ctx.setLineDash([]);
            ctx.fillStyle = `rgba(${col},0.8)`;
            ctx.font = `${10 * vr}px ui-monospace, monospace`;
            ctx.fillText(z.kind, x + 4 * hr, y + 11 * vr);
          }
        });
      },
    };
    return [{ renderer: () => renderer, zOrder: () => "bottom" }];
  }
}

const fmtTime = (t: number) => new Date(t * 1000).toLocaleString("es-MX", { timeZone: "America/Mexico_City", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const pts = (a: Pt[]) => a.filter((p) => p.value !== null).map((p) => ({ time: p.time as UTCTimestamp, value: p.value as number }));

export default function PriceChart({ levels }: { levels: Levels | null }) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [tf, setTf] = useState("M15");
  const [data, setData] = useState<ChartDto | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => fetch(`/api/chart?tf=${tf}`).then((r) => r.json()).then((j) => alive && setData(j)).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [tf]);

  useEffect(() => {
    if (!el.current || !data?.candles?.length) return;
    const chart = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: C.text, fontSize: 11, panes: { separatorColor: "#1e2635" } },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: "#1e2635" },
      timeScale: { borderColor: "#1e2635", timeVisible: true, tickMarkFormatter: (t: Time) => fmtTime(t as number).split(",").pop()!.trim() },
      localization: { timeFormatter: (t: Time) => `${fmtTime(t as number)} CDMX`, priceFormatter: (p: number) => p.toFixed(3) },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;
    const cs = chart.addSeries(CandlestickSeries, { upColor: C.long, downColor: C.short, borderVisible: false, wickUpColor: C.long, wickDownColor: C.short, priceFormat: { type: "price", precision: 3, minMove: 0.001 } });
    cs.setData(data.candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
    candleRef.current = cs;
    for (const [k, col] of [["ema20", C.e20], ["ema50", C.e50], ["ema200", C.e200]] as const) {
      const s = chart.addSeries(LineSeries, { color: col, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: () => null });
      s.setData(pts(data[k]));
    }
    const zp = new ZonesPrimitive();
    cs.attachPrimitive(zp);
    zp.set(data.zones);

    const markers: SeriesMarker<Time>[] = [
      ...data.events.map((e) => ({
        time: e.time as UTCTimestamp,
        position: (e.direction === "LONG" ? "belowBar" : "aboveBar") as "belowBar" | "aboveBar",
        color: e.direction === "LONG" ? C.long : C.short,
        shape: (e.direction === "LONG" ? "arrowUp" : "arrowDown") as "arrowUp" | "arrowDown",
        text: e.type,
      })),
      ...data.sweeps.filter((s) => !s.levelName.includes("SWING")).slice(-12).map((s) => ({
        time: s.time as UTCTimestamp,
        position: (s.direction === "LONG" ? "belowBar" : "aboveBar") as "belowBar" | "aboveBar",
        color: "#e0a84a",
        shape: "circle" as const,
        text: s.levelName,
      })),
    ].sort((a, b) => (a.time as number) - (b.time as number));
    createSeriesMarkers(cs, markers);

    // Paneles inferiores: RSI, MACD, ATR
    const rsi = chart.addSeries(LineSeries, { color: "#b48ead", lineWidth: 1, priceLineVisible: false }, 1);
    rsi.setData(pts(data.rsi));
    for (const lvl of [70, 50, 30]) rsi.createPriceLine({ price: lvl, color: "#2a3345", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
    const hist = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "price", precision: 3, minMove: 0.001 } }, 2);
    hist.setData(pts(data.macdHist).map((p) => ({ ...p, color: p.value >= 0 ? "rgba(38,166,154,.6)" : "rgba(239,83,80,.6)" })));
    chart.addSeries(LineSeries, { color: C.e20, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 2).setData(pts(data.macd));
    chart.addSeries(LineSeries, { color: C.e50, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 2).setData(pts(data.macdSignal));
    chart.addSeries(LineSeries, { color: "#7b869a", lineWidth: 1, priceLineVisible: false, priceFormat: { type: "price", precision: 3, minMove: 0.001 } }, 3).setData(pts(data.atr));
    const panes = chart.panes();
    [5, 1.1, 1.1, 0.8].forEach((f, k) => panes[k]?.setStretchFactor(f));
    chart.timeScale().scrollToRealTime();
    return () => { chart.remove(); chartRef.current = null; candleRef.current = null; };
  }, [data]);

  // Entry / SL / TP
  useEffect(() => {
    const cs = candleRef.current;
    if (!cs || !levels) return;
    const lines = [
      { p: levels.entry, c: "#6ea8fe", t: `ENTRY ${levels.label}` },
      { p: levels.stop, c: C.short, t: "SL" },
      { p: levels.tp1, c: C.long, t: "TP1" },
      { p: levels.tp2, c: C.long, t: "TP2" },
      { p: levels.tp3, c: C.long, t: "TP3" },
    ].map((l) => cs.createPriceLine({ price: l.p, color: l.c, lineWidth: 1, lineStyle: l.t.startsWith("ENTRY") ? LineStyle.Solid : LineStyle.Dashed, axisLabelVisible: true, title: l.t }));
    return () => { for (const l of lines) cs.removePriceLine(l); };
  }, [levels, data]);

  return (
    <section className="panel">
      <header>
        <h2>USD/JPY · {tf}</h2>
        <div className="legend">
          <span><i style={{ background: C.e20 }} />EMA20</span>
          <span><i style={{ background: C.e50 }} />EMA50</span>
          <span><i style={{ background: C.e200 }} />EMA200</span>
          <span>▭ FVG / OB</span>
          <span style={{ color: "#e0a84a" }}>● sweep sesión/PDH-PDL</span>
          <span>RSI · MACD · ATR</span>
        </div>
        <div className="tfs">
          {["D1", "H4", "H1", "M15", "M5", "M1"].map((x) => (
            <button key={x} className={x === tf ? "on" : ""} onClick={() => setTf(x)}>{x}</button>
          ))}
        </div>
      </header>
      {data && !data.candles?.length ? (
        <div className="body empty">{data.error ?? "Sin velas en caché todavía: el motor aún no ha corrido o no hay conexión con TwelveData. No se muestran datos simulados."}</div>
      ) : (
        <div ref={el} className="chart" />
      )}
    </section>
  );
}
