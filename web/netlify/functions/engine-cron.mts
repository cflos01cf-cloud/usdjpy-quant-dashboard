import type { Config } from "@netlify/functions";
import { runCycle } from "../../lib/services/cycle";

/** Ciclo autónomo cada 5 minutos (límite de 30 s por ejecución en Netlify). */
export default async () => {
  try {
    const r = await runCycle();
    console.log("[engine-cron]", JSON.stringify(r));
  } catch (e) {
    console.error("[engine-cron] fallo", e);
  }
};

export const config: Config = { schedule: "*/5 * * * *" };
