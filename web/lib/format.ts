import { PIP } from "./config";

export const fmtPrice = (p: number | null | undefined) => (p === null || p === undefined || !Number.isFinite(p) ? "—" : p.toFixed(3));
export const toPips = (d: number) => d / PIP;
export const fmtPips = (d: number) => `${toPips(d).toFixed(1)} pips`;

export function fmtCdmx(utcSec: number, withDate = false) {
  return new Date(utcSec * 1000).toLocaleString("es-MX", {
    timeZone: "America/Mexico_City",
    hour: "2-digit",
    minute: "2-digit",
    ...(withDate ? { day: "2-digit", month: "short" } : {}),
    hour12: false,
  });
}
