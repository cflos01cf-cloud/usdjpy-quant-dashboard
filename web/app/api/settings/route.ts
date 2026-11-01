import { NextResponse } from "next/server";
import { db } from "@/lib/services/db";
import { isAdmin } from "@/lib/services/auth";
import { loadSettings } from "@/lib/services/settings";
import { BROKER_PRESETS } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ...(await loadSettings()), presets: Object.keys(BROKER_PRESETS) });
}

/** Actualiza capital, riesgo, filtros, noticias o broker (requiere x-admin-token). */
export async function POST(req: Request) {
  if (!isAdmin(req)) return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  const body = await req.json();
  const cur = (await db().from("settings").select("*").eq("id", 1).maybeSingle()).data ?? {};
  const next = {
    id: 1,
    broker_preset: body.brokerPreset && BROKER_PRESETS[body.brokerPreset] ? body.brokerPreset : cur.broker_preset ?? "EXNESS_STANDARD",
    risk: { ...(cur.risk ?? {}), ...(body.risk ?? {}) },
    signal: { ...(cur.signal ?? {}), ...(body.signal ?? {}) },
    news: { ...(cur.news ?? {}), ...(body.news ?? {}) },
    updated_at: new Date().toISOString(),
  };
  const { error } = await db().from("settings").upsert(next);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(await loadSettings());
}
