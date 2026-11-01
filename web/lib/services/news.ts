import type { NewsEvent } from "../engine/types";
import type { NewsConfig } from "../config";
import type { NewsState } from "../engine/scoring";
import { db } from "./db";

/**
 * Calendario económico.
 * Fuente por defecto: feed semanal público de ForexFactory (no oficial, sin API key, se refresca 1×/hora).
 * Cada evento guarda fuente y hora de obtención. Eventos manuales (p. ej. intervención del MoF/BOJ,
 * declaraciones de Kato/Ueda) se insertan en `news_events` con source='manual'.
 * Nunca se inventan eventos: si la fuente falla, el panel lo indica y se mantiene lo último verificado.
 */
const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

interface FFItem { title: string; country: string; date: string; impact: string; forecast?: string; previous?: string; actual?: string }

const IMPACT: Record<string, NewsEvent["impact"] | undefined> = { High: "HIGH", Medium: "MEDIUM", Low: "LOW" };

export async function fetchForexFactory(currencies: string[]): Promise<NewsEvent[]> {
  const res = await fetch(FF_URL, { cache: "no-store", headers: { "User-Agent": "usdjpy-quant-dashboard" } });
  if (!res.ok) throw new Error(`ForexFactory HTTP ${res.status}`);
  const items: FFItem[] = await res.json();
  const now = Math.floor(Date.now() / 1000);
  return items
    .filter((x) => currencies.includes(x.country) && IMPACT[x.impact])
    .map((x) => {
      const time = Math.floor(Date.parse(x.date) / 1000);
      return {
        id: `ff|${x.country}|${time}|${x.title}`,
        time,
        currency: x.country,
        title: x.title,
        impact: IMPACT[x.impact]!,
        source: "forexfactory",
        fetchedAt: now,
        forecast: x.forecast || null,
        previous: x.previous || null,
        actual: x.actual || null,
      };
    })
    .filter((e) => Number.isFinite(e.time));
}

export async function refreshNews(cfg: NewsConfig, force = false): Promise<{ refreshed: boolean; error?: string }> {
  const { data: last } = await db().from("news_events").select("fetched_at").eq("source", "forexfactory").order("fetched_at", { ascending: false }).limit(1).maybeSingle();
  if (!force && last && Date.now() - Date.parse(last.fetched_at) < 3600_000) return { refreshed: false };
  try {
    const evs = await fetchForexFactory(cfg.currencies);
    if (evs.length) {
      const rows = evs.map((e) => ({
        id: e.id, time: new Date(e.time * 1000).toISOString(), currency: e.currency, title: e.title, impact: e.impact,
        source: e.source, forecast: e.forecast, previous: e.previous, actual: e.actual, fetched_at: new Date(e.fetchedAt * 1000).toISOString(),
      }));
      const { error } = await db().from("news_events").upsert(rows, { onConflict: "id", ignoreDuplicates: false });
      if (error) throw new Error(error.message);
    }
    return { refreshed: true };
  } catch (e) {
    return { refreshed: false, error: (e as Error).message };
  }
}

export async function loadNews(fromSec: number, toSec: number): Promise<(NewsEvent & { alerted: boolean })[]> {
  const { data, error } = await db()
    .from("news_events")
    .select("*")
    .gte("time", new Date(fromSec * 1000).toISOString())
    .lte("time", new Date(toSec * 1000).toISOString())
    .order("time");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id, time: Math.floor(Date.parse(r.time) / 1000), currency: r.currency, title: r.title, impact: r.impact,
    source: r.source, fetchedAt: Math.floor(Date.parse(r.fetched_at) / 1000), forecast: r.forecast, previous: r.previous, actual: r.actual, alerted: r.alerted,
  }));
}

/** Estado de bloqueo por noticias en el instante `now` (puro → reutilizable en backtest). */
export function newsStateAt(events: NewsEvent[], now: number, cfg: NewsConfig): NewsState {
  const relevant = events.filter((e) => cfg.currencies.includes(e.currency) && (e.impact === "HIGH" || (cfg.mediumImpactBlocks && e.impact === "MEDIUM")));
  const blocked = relevant.some((e) => now >= e.time - cfg.blockBeforeMin * 60 && now <= e.time + cfg.blockAfterMin * 60);
  const near = relevant.some((e) => now >= e.time - 2 * cfg.blockBeforeMin * 60 && now <= e.time + 2 * cfg.blockAfterMin * 60);
  const nextE = events.filter((e) => e.time >= now - cfg.blockAfterMin * 60 && e.impact !== "LOW").sort((a, b) => a.time - b.time)[0];
  return { blocked, nearHighImpact: near, next: nextE ? { title: nextE.title, time: nextE.time, impact: nextE.impact, currency: nextE.currency } : null };
}
