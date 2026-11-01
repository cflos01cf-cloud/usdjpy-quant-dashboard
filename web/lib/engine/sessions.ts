import { SESSIONS } from "../config";
import type { Candle, SessionInfo, SessionName } from "./types";

/**
 * Sesiones con zonas IANA → el horario de verano de Londres, Nueva York y Sídney se aplica solo.
 * Día de trading: rollover a las 17:00 de Nueva York (convención FX).
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  wd: number; // 0=dom
  minutes: number; // minutos desde medianoche local
  dateKey: string;
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const partsCache = new Map<string, LocalParts>();
export function localParts(tz: string, utcSec: number): LocalParts {
  const minuteKey = `${tz}|${Math.floor(utcSec / 60)}`;
  const hit = partsCache.get(minuteKey);
  if (hit) return hit;
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(new Date(utcSec * 1000))) p[x.type] = x.value;
  const r: LocalParts = {
    y: +p.year,
    m: +p.month,
    d: +p.day,
    hh: +p.hour,
    mm: +p.minute,
    wd: WD[p.weekday],
    minutes: +p.hour * 60 + +p.minute,
    dateKey: `${p.year}-${p.month}-${p.day}`,
  };
  if (partsCache.size > 50_000) partsCache.clear();
  partsCache.set(minuteKey, r);
  return r;
}

const hm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

/** Mercado FX cerrado: viernes 17:00 NY → domingo 17:00 NY. */
export function isMarketClosed(utcSec: number): boolean {
  const ny = localParts("America/New_York", utcSec);
  if (ny.wd === 6) return true;
  if (ny.wd === 5 && ny.minutes >= 17 * 60) return true;
  if (ny.wd === 0 && ny.minutes < 17 * 60) return true;
  return false;
}

export function isSessionActive(name: SessionName, utcSec: number): boolean {
  if (isMarketClosed(utcSec)) return false;
  const s = SESSIONS[name];
  const lp = localParts(s.tz, utcSec);
  // fin de semana LOCAL = cerrado (Sídney abre el lunes local, que en UTC aún es domingo)
  if (lp.wd === 0 || lp.wd === 6) return false;
  return lp.minutes >= hm(s.open) && lp.minutes < hm(s.close);
}

export function sessionInfo(utcSec: number, withNext = true): SessionInfo {
  const names: SessionName[] = ["SYDNEY", "TOKYO", "LONDON", "NEW_YORK"];
  const active = names.filter((n) => isSessionActive(n, utcSec));
  const overlap = active.includes("LONDON") && active.includes("NEW_YORK");
  let label = "FUERA DE SESIÓN";
  if (isMarketClosed(utcSec)) label = "MERCADO CERRADO";
  else if (overlap) label = "OVERLAP LONDRES-NY";
  else if (active.includes("NEW_YORK")) label = "NUEVA YORK";
  else if (active.includes("LONDON")) label = "LONDRES";
  else if (active.includes("TOKYO")) label = "TOKIO";
  else if (active.includes("SYDNEY")) label = "SÍDNEY";
  // próximo cambio: busca minuto a minuto (barato, máximo 24h)
  let next: number | null = null;
  if (!withNext) return { active, overlapLondonNY: overlap, label, nextChangeUtc: null };
  const key = (t: number) => names.map((n) => (isSessionActive(n, t) ? 1 : 0)).join("");
  const k0 = key(utcSec);
  for (let t = utcSec - (utcSec % 60) + 60; t < utcSec + 86400 * 2; t += 300) {
    if (key(t) !== k0) {
      // refina al minuto
      for (let r = t - 300; r <= t; r += 60) if (key(r) !== k0) { next = r; break; }
      break;
    }
  }
  return { active, overlapLondonNY: overlap, label, nextChangeUtc: next };
}

/** Clave del día de trading: fecha NY tras rollover 17:00. */
export function tradingDayKey(utcSec: number): string {
  return localParts("America/New_York", utcSec + 7 * 3600).dateKey;
}

/** Horario y sesión en hora de Ciudad de México para la UI. */
export function sessionScheduleCdmx(utcSec: number) {
  const out: { name: SessionName; openCdmx: string; closeCdmx: string; active: boolean }[] = [];
  const names: SessionName[] = ["SYDNEY", "TOKYO", "LONDON", "NEW_YORK"];
  for (const n of names) {
    const s = SESSIONS[n];
    const open = nextLocalTimeUtc(s.tz, hm(s.open), utcSec - 86400);
    const close = nextLocalTimeUtc(s.tz, hm(s.close), open);
    const cd = (t: number) => {
      const p = localParts("America/Mexico_City", t);
      return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
    };
    out.push({ name: n, openCdmx: cd(open), closeCdmx: cd(close), active: isSessionActive(n, utcSec) });
  }
  return out;
}

/** Primer instante UTC ≥ from en que la hora local de tz es `minutes`. */
export function nextLocalTimeUtc(tz: string, minutes: number, from: number): number {
  let t = from - (from % 60);
  for (let i = 0; i < 60 * 48; i++, t += 60) if (localParts(tz, t).minutes === minutes) return t;
  return from;
}

// ───────────── Rangos de sesión y niveles diarios (serie causal) ─────────────

export interface SessionLevels {
  dayKey: string;
  pdh: number | null;
  pdl: number | null;
  asiaH: number | null;
  asiaL: number | null;
  asiaComplete: boolean;
  lonH: number | null;
  lonL: number | null;
  lonComplete: boolean;
  nyH: number | null;
  nyL: number | null;
  /** día actual hasta la vela */
  dayH: number;
  dayL: number;
  dayOpen: number;
}

/** Rango asiático estilo ICT: 19:00–02:00 hora NY (antes de Londres). */
function inAsiaRange(utc: number) {
  const m = localParts("America/New_York", utc).minutes;
  return m >= 19 * 60 || m < 2 * 60;
}

/**
 * Para cada vela i, niveles conocidos al CIERRE de la vela i (usa velas ≤ i).
 */
export function computeSessionLevels(c: Candle[]): SessionLevels[] {
  const out: SessionLevels[] = [];
  let day = "";
  let prevH: number | null = null;
  let prevL: number | null = null;
  let dH = -Infinity, dL = Infinity, dOpen = NaN;
  let aH: number | null = null, aL: number | null = null;
  let lH: number | null = null, lL: number | null = null;
  let nH: number | null = null, nL: number | null = null;
  let asiaDone = false, lonDone = false;

  for (let i = 0; i < c.length; i++) {
    const t = c[i].time;
    const key = tradingDayKey(t);
    if (key !== day) {
      if (day !== "") {
        prevH = dH;
        prevL = dL;
      }
      day = key;
      dH = -Infinity; dL = Infinity; dOpen = c[i].open;
      aH = aL = lH = lL = nH = nL = null;
      asiaDone = lonDone = false;
    }
    dH = Math.max(dH, c[i].high);
    dL = Math.min(dL, c[i].low);
    const x = c[i];
    if (inAsiaRange(t) && !asiaDone) {
      aH = aH === null ? x.high : Math.max(aH, x.high);
      aL = aL === null ? x.low : Math.min(aL, x.low);
    } else if (aH !== null) asiaDone = true;
    if (isSessionActive("LONDON", t)) {
      lH = lH === null ? x.high : Math.max(lH, x.high);
      lL = lL === null ? x.low : Math.min(lL, x.low);
    } else if (lH !== null) lonDone = true;
    if (isSessionActive("NEW_YORK", t)) {
      nH = nH === null ? x.high : Math.max(nH, x.high);
      nL = nL === null ? x.low : Math.min(nL, x.low);
    }
    out.push({
      dayKey: day, pdh: prevH, pdl: prevL,
      asiaH: aH, asiaL: aL, asiaComplete: asiaDone,
      lonH: lH, lonL: lL, lonComplete: lonDone,
      nyH: nH, nyL: nL, dayH: dH, dayL: dL, dayOpen: dOpen,
    });
  }
  return out;
}

/** Niveles de liquidez de sesión conocidos ANTES de la vela i (para detectar barridos en i). */
export function sessionLiquidityBefore(levels: SessionLevels[], i: number): { name: string; price: number }[] {
  if (i <= 0) return [];
  const L = levels[i - 1];
  const sameDay = levels[i].dayKey === L.dayKey;
  const cur = levels[i];
  const out: { name: string; price: number }[] = [];
  if (cur.pdh !== null) out.push({ name: "PDH", price: cur.pdh });
  if (cur.pdl !== null) out.push({ name: "PDL", price: cur.pdl });
  if (sameDay) {
    if (L.asiaComplete || (L.asiaH !== null && cur.asiaComplete)) {
      if (L.asiaH !== null) out.push({ name: "ASIA_H", price: L.asiaH });
      if (L.asiaL !== null) out.push({ name: "ASIA_L", price: L.asiaL });
    }
    if (L.lonComplete && L.lonH !== null && L.lonL !== null) {
      out.push({ name: "LON_H", price: L.lonH }, { name: "LON_L", price: L.lonL });
    }
  }
  return out;
}
