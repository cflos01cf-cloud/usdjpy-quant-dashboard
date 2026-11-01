import { NextResponse } from "next/server";
import { runCycle } from "@/lib/services/cycle";
import { isAdmin } from "@/lib/services/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Ejecuta un ciclo manual (requiere x-admin-token). */
export async function POST(req: Request) {
  if (!isAdmin(req)) return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  const r = await runCycle({ force: new URL(req.url).searchParams.get("force") === "1" });
  return NextResponse.json(r);
}
