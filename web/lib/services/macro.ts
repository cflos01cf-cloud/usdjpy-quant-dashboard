import { db } from "./db";

/**
 * Contexto macro: diferencial de tasas EE. UU. – Japón (FRED, gratuito con API key).
 *  - DGS2 / DGS10: Treasuries 2 y 10 años (diario)
 *  - IRLTLT01JPM156N: JGB 10 años (mensual, OCDE)
 * Se refresca 1×/día. Si no hay FRED_API_KEY el módulo devuelve null (no se inventa nada).
 */
const SERIES = ["DGS2", "DGS10", "IRLTLT01JPM156N"] as const;

export interface MacroContext {
  us2y: { value: number; date: string } | null;
  us10y: { value: number; date: string } | null;
  jp10y: { value: number; date: string } | null;
  diff10y: number | null;
  us10yChange20d: number | null;
  source: string;
  fetchedAt: string;
}

async function fredSeries(id: string, key: string) {
  const u = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&sort_order=desc&limit=60`;
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) throw new Error(`FRED ${id} HTTP ${r.status}`);
  const j = await r.json();
  return (j.observations as { date: string; value: string }[]).filter((o) => o.value !== ".").map((o) => ({ date: o.date, value: +o.value }));
}

export async function loadMacro(): Promise<MacroContext | null> {
  const key = process.env.FRED_API_KEY;
  const { data: rows } = await db().from("macro_cache").select("*");
  const fresh = rows?.length === SERIES.length && rows.every((r) => Date.now() - Date.parse(r.fetched_at) < 20 * 3600_000);
  let obs: Record<string, { date: string; value: number }[]> = Object.fromEntries((rows ?? []).map((r) => [r.series, r.observations]));
  let fetchedAt = rows?.[0]?.fetched_at ?? new Date().toISOString();
  if (!fresh && key) {
    try {
      const got = await Promise.all(SERIES.map((s) => fredSeries(s, key)));
      obs = Object.fromEntries(SERIES.map((s, i) => [s, got[i]]));
      fetchedAt = new Date().toISOString();
      await db().from("macro_cache").upsert(SERIES.map((s) => ({ series: s, observations: obs[s], fetched_at: fetchedAt })));
    } catch (e) {
      console.error("[macro]", (e as Error).message);
    }
  }
  if (!obs.DGS10?.length) return null;
  const first = (s: string) => (obs[s]?.[0] ? { value: obs[s][0].value, date: obs[s][0].date } : null);
  const us10 = first("DGS10"), jp10 = first("IRLTLT01JPM156N");
  return {
    us2y: first("DGS2"),
    us10y: us10,
    jp10y: jp10,
    diff10y: us10 && jp10 ? Number((us10.value - jp10.value).toFixed(2)) : null,
    us10yChange20d: obs.DGS10.length > 20 ? Number((obs.DGS10[0].value - obs.DGS10[20].value).toFixed(2)) : null,
    source: "FRED (St. Louis Fed)",
    fetchedAt,
  };
}
