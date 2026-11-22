import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/services/auth";

export const dynamic = "force-dynamic";

/** Diagnóstico de conexión a Supabase (requiere x-admin-token). No expone llaves. */
export async function GET(req: Request) {
  if (!isAdmin(req)) return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  const raw = process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const url = raw.trim().replace(/\/+$/, "").replace(/\/(rest|auth|storage)\/v1.*$/i, "");
  const out: Record<string, unknown> = {
    supabaseUrlRaw: raw.replace(/([a-z0-9]{4})[a-z0-9]+(\.supabase\.co)/i, "$1••••$2"),
    rawLength: raw.length,
    rawHasSpaces: /\s/.test(raw),
    urlUsed: url.replace(/([a-z0-9]{4})[a-z0-9]+(\.supabase\.co)/i, "$1••••$2"),
    startsWithHttps: url.startsWith("https://"),
    endsWithSupabaseCo: /\.supabase\.co$/i.test(url),
    keyPresent: key.length > 0,
    keyType: key.startsWith("sb_secret_") ? "secret" : key.startsWith("sb_publishable_") ? "publishable (INCORRECTA)" : key.startsWith("eyJ") ? "jwt (service_role o anon)" : key ? "desconocido" : "vacía",
    schema: process.env.SUPABASE_SCHEMA || "usdjpy",
  };
  try {
    const host = new URL(url).hostname;
    out.host = host.replace(/^([a-z0-9]{4})[a-z0-9]+/i, "$1••••");
  } catch {
    out.urlParse = "URL inválida";
    return NextResponse.json(out);
  }
  try {
    const r = await fetch(`${url}/rest/v1/settings?select=id`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Accept-Profile": out.schema as string },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    out.restStatus = r.status;
    out.restBody = (await r.text()).slice(0, 300);
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    out.fetchError = err.message;
    out.fetchCause = err.cause?.code ?? err.cause?.message ?? null;
  }
  return NextResponse.json(out);
}
