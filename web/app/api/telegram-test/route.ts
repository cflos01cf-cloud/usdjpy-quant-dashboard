import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/services/auth";
import { sendTelegram, plainMessage } from "@/lib/services/telegram";

export const dynamic = "force-dynamic";

/** Envía un mensaje de prueba a Telegram (requiere x-admin-token). */
export async function POST(req: Request) {
  if (!isAdmin(req)) return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID)
    return NextResponse.json({ ok: false, error: "Faltan TELEGRAM_BOT_TOKEN y/o TELEGRAM_CHAT_ID en Netlify" });
  const ok = await sendTelegram(plainMessage("✅ USD/JPY Quant Engine", "Mensaje de prueba: las alertas están conectadas."));
  return NextResponse.json({ ok, error: ok ? null : "Telegram rechazó el envío: revisa el token, el chat_id y que le hayas escrito primero al bot" });
}
