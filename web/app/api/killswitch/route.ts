import { NextResponse } from "next/server";
import { db } from "@/lib/services/db";
import { isAdmin } from "@/lib/services/auth";
import { sendTelegram, plainMessage } from "@/lib/services/telegram";

export const dynamic = "force-dynamic";

/** Kill switch: { on: true|false }. Bloquea toda nueva entrada de inmediato. */
export async function POST(req: Request) {
  if (!isAdmin(req)) return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  const { on } = await req.json();
  const cur = (await db().from("settings").select("risk").eq("id", 1).maybeSingle()).data?.risk ?? {};
  const { error } = await db().from("settings").upsert({ id: 1, risk: { ...cur, killSwitch: !!on }, updated_at: new Date().toISOString() });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await sendTelegram(plainMessage(on ? "🛑 Kill switch ACTIVADO" : "✅ Kill switch desactivado", on ? "No se generarán nuevas entradas." : "El motor vuelve a operar normalmente."));
  return NextResponse.json({ killSwitch: !!on });
}
