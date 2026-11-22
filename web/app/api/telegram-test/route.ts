import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/services/auth";

export const dynamic = "force-dynamic";

/** Prueba de Telegram con diagnóstico (requiere x-admin-token). No expone el token. */
export async function POST(req: Request) {
  if (!isAdmin(req)) return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const chat = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
  const out: Record<string, unknown> = {
    tokenPresent: !!token,
    tokenFormatOk: /^\d+:[A-Za-z0-9_-]{30,}$/.test(token),
    chatId: chat ? chat.replace(/^(-?\d{2})\d+(\d{2})$/, "$1•••$2") : "(vacío)",
    chatIdFormatOk: /^-?\d+$/.test(chat),
  };
  if (!token) return NextResponse.json({ ...out, error: "Falta TELEGRAM_BOT_TOKEN" });
  try {
    const me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`, { cache: "no-store" })).json();
    out.getMe = me.ok ? { ok: true, bot: `@${me.result.username}` } : { ok: false, description: me.description };
    if (!me.ok) return NextResponse.json({ ...out, diagnosis: "El token es inválido: cópialo de nuevo desde @BotFather (/mybots → API Token)" });
    if (!chat) return NextResponse.json({ ...out, error: "Falta TELEGRAM_CHAT_ID" });
    const r = await (await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: "✅ USD/JPY Quant Engine — mensaje de prueba: las alertas están conectadas." }),
    })).json();
    out.sendMessage = r.ok ? { ok: true } : { ok: false, description: r.description };
    if (!r.ok && /chat not found/i.test(r.description ?? "")) out.diagnosis = `El chat_id no corresponde a un chat con ${(out.getMe as { bot: string }).bot}: abre ese bot en Telegram, pulsa Iniciar y revisa el número`;
    if (!r.ok && /blocked/i.test(r.description ?? "")) out.diagnosis = "Bloqueaste al bot: desbloquéalo en Telegram y pulsa Iniciar";
  } catch (e) {
    out.error = (e as Error).message;
  }
  return NextResponse.json(out);
}
