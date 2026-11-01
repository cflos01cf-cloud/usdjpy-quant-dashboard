import type { Signal } from "../engine/types";
import { fmtPrice, fmtCdmx } from "../format";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function sendTelegram(html: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
      });
      if (r.ok) return true;
      if (r.status === 429) await new Promise((res) => setTimeout(res, 1500));
      else return false;
    } catch {
      await new Promise((res) => setTimeout(res, 500 * (i + 1)));
    }
  }
  return false;
}

const yes = (b: boolean) => (b ? "CONFIRMED" : "—");

export function signalMessage(s: Signal, ctx: { structure: string; momentum: string; dashboardUrl?: string }): string {
  const icon = s.direction === "LONG" ? "🟢" : "🔴";
  const sw = s.scoreBreakdown.notes.some((n) => n.includes("sweep"));
  const fvg = s.scoreBreakdown.notes.some((n) => n.includes("FVG"));
  return [
    `🚨 <b>USD/JPY - ${s.direction} SIGNAL</b> ${icon}`,
    ``,
    `Entry: <b>${fmtPrice(s.entry)}</b> (${s.orderType})`,
    `Stop Loss: ${fmtPrice(s.stop)}`,
    `Take Profit 1: ${fmtPrice(s.tp1)}`,
    `Take Profit 2: ${fmtPrice(s.tp2)}`,
    `Take Profit 3: ${fmtPrice(s.tp3)}`,
    `Risk/Reward: 1:${s.rr.tp1} / 1:${s.rr.tp2} / 1:${s.rr.tp3} (neto TP2 1:${s.rr.netTp2})`,
    `Score: <b>${s.score}/100</b> — ${s.classification}`,
    s.sizing ? `Tamaño: ${s.sizing.lots} lotes · riesgo ${s.sizing.riskPct}% (${s.sizing.stopPips.toFixed(1)} pips)` : "",
    ``,
    `Market Structure: ${ctx.structure}`,
    `Liquidity Sweep: ${yes(sw)}`,
    `FVG/OB: ${yes(fvg)}`,
    `Momentum: ${ctx.momentum}`,
    `Session: ${esc(s.session)}`,
    `Estrategias: ${s.strategies.join(", ")}`,
    ``,
    `Reason: ${esc(s.reasons.join("; "))}`,
    `Invalidación: ${esc(s.invalidation)}`,
    `Vigencia: hasta ${fmtCdmx(s.validUntil)} (CDMX)`,
    ``,
    `Acción: <b>${s.action}</b>`,
    ctx.dashboardUrl ? `<a href="${ctx.dashboardUrl}">Dashboard</a>` : "",
  ].filter((l) => l !== "").join("\n").replace(/\n\n\n+/g, "\n\n");
}

export const eventMessage = (type: string, s: { direction: string; entry: number; id: string }, price: number, extra = "") => {
  const icons: Record<string, string> = { FILLED: "▶️", TP1: "✅", TP2: "✅✅", TP3: "🏁", SL: "⛔", BE: "⚖️", TRAIL: "📉", EOD: "🕔", EXPIRED: "⌛", INVALIDATED: "❌" };
  const names: Record<string, string> = { FILLED: "Entrada activada", TP1: "Take Profit 1 alcanzado", TP2: "Take Profit 2 alcanzado", TP3: "Take Profit 3 alcanzado", SL: "Stop Loss activado", BE: "Cerrada en break-even", TRAIL: "Trailing stop ejecutado", EOD: "Cierre intradía", EXPIRED: "Señal expirada sin activarse", INVALIDATED: "Señal invalidada" };
  return `${icons[type] ?? "ℹ️"} <b>USD/JPY ${s.direction}</b> — ${names[type] ?? type}\nPrecio: ${fmtPrice(price)} · Entrada ${fmtPrice(s.entry)}${extra ? `\n${esc(extra)}` : ""}`;
};

export const plainMessage = (title: string, body: string) => `<b>${esc(title)}</b>\n${esc(body)}`;
