import { BROKER_PRESETS, DEFAULT_NEWS, DEFAULT_RISK, DEFAULT_SIGNAL, type BrokerConfig, type NewsConfig, type RiskConfig, type SignalConfig } from "../config";
import { db } from "./db";

export interface Settings {
  brokerPreset: string;
  broker: BrokerConfig;
  risk: RiskConfig;
  signal: SignalConfig;
  news: NewsConfig;
}

export async function loadSettings(): Promise<Settings> {
  const { data } = await db().from("settings").select("*").eq("id", 1).maybeSingle();
  const preset = (data?.broker_preset as string) ?? process.env.BROKER_PRESET ?? "EXNESS_STANDARD";
  const broker = BROKER_PRESETS[preset] ?? BROKER_PRESETS.EXNESS_STANDARD;
  const risk: RiskConfig = { ...DEFAULT_RISK, ...(data?.risk ?? {}) };
  if (process.env.ACCOUNT_EQUITY) risk.equity = Number(process.env.ACCOUNT_EQUITY);
  return {
    brokerPreset: preset,
    broker,
    risk,
    signal: { ...DEFAULT_SIGNAL, ...(data?.signal ?? {}) },
    news: { ...DEFAULT_NEWS, ...(data?.news ?? {}) },
  };
}
