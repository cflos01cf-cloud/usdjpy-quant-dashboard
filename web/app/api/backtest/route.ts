import { NextResponse } from "next/server";
import bt from "@/data/backtest/latest.json";

/** Resultados del último backtest/walk-forward generado por el módulo Python (research/). */
export async function GET() {
  return NextResponse.json(bt);
}
