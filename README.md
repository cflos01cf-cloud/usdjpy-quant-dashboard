# USD/JPY Quant Engine

Motor cuantitativo intradía para USD/JPY: análisis multitemporal (D1→M1), Smart Money Concepts, 5 estrategias independientes, scoring 0-100, gestión de riesgo para Exness, alertas Telegram, paper trading y validación estadística (walk-forward, Monte Carlo, meta-labeling).

Arquitectura y decisiones: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```
web/        Next.js 16 + TypeScript (motor en vivo, API, dashboard, función programada Netlify)
  lib/engine/      indicadores, estructura SMC, sesiones, contexto MTF, scoring, señales, riesgo, simulador
  lib/strategies/  A SMC · B Trend · C Price Action · D Liquidez · E Breakout
  lib/services/    ciclo autónomo, Supabase, noticias, macro (FRED), Telegram
  netlify/functions/engine-cron.mts   ciclo cada 5 min
research/   Python: backtest, walk-forward, Monte Carlo, ML, reportes
supabase/schema.sql
```

## Puesta en marcha

1. **Supabase**: crea un proyecto, ejecuta `supabase/schema.sql` en el SQL Editor.
2. **Telegram**: crea un bot con @BotFather y obtén tu `chat_id`.
3. **Netlify**: nuevo sitio desde este repo, *Base directory* = `web`. Variables de entorno (ver `web/.env.example`):
   `TWELVEDATA_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ADMIN_TOKEN`, `PUBLIC_URL`, opcional `FRED_API_KEY`, `BROKER_PRESET` (`EXNESS_STANDARD` o `EXNESS_RAW`), `ACCOUNT_EQUITY`.
4. Despliega. La función `engine-cron` corre cada 5 min entre 06:00 y 21:00 UTC (≈ 617 créditos/día de TwelveData).
5. Ciclo manual: `curl -X POST "$PUBLIC_URL/api/engine?force=1" -H "x-admin-token: $ADMIN_TOKEN"`.

**Antes de operar**: verifica en tu terminal Exness spread, comisión y tamaño de contrato de tu tipo de cuenta y ajústalos en `web/lib/config.ts` (`BROKER_PRESETS`).

Configuración en caliente (capital, riesgo, umbrales, ventanas de noticias):
```bash
curl -X POST "$PUBLIC_URL/api/settings" -H "x-admin-token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"risk":{"equity":25000,"riskPerTradePct":0.5},"signal":{"minScoreToAlert":80}}'
```

## Desarrollo

```bash
cd web && npm install
npm test            # 20 pruebas: indicadores, causalidad SMC, DST, riesgo, simulador, motor completo
npm run build
```

## Backtest y validación

```bash
cd research && pip install -e .[dev] && pytest
# Con TwelveData (M5 desde una fecha):
TWELVEDATA_API_KEY=... python scripts/run_backtest.py --download --start 2024-01-01 --label "TwelveData M5"
# Con CSV de Dukascopy (M1 → simulación de ejecución en M1, más precisa):
python scripts/run_backtest.py --csv USDJPY_M1.csv --label "Dukascopy M1"
```
Genera `research/output/report.md` y `web/data/backtest/latest.json` (lo muestra el dashboard tras el siguiente deploy).

Pipeline: el motor TS de producción recorre el histórico y exporta candidatas → Python aplica umbrales y reglas de riesgo → walk-forward (IS 180 d / OOS 60 d / embargo 1 d) con selección suavizada por vecindad → Monte Carlo → bandas de score → meta-labeling ML purgado → regímenes (GMM ajustado sólo con pasado).

## Reglas de seguridad del sistema

- Sin datos `LIVE` no hay señales nuevas; nunca se simulan precios.
- Bloqueo de entradas ±30 min alrededor de noticias de alto impacto USD/JPY.
- 0.5 % por operación, 2 % diario, 5 % semanal, 5 operaciones/día, 1 posición, pausa tras 3 pérdidas seguidas, kill switch.
- Contra tendencia D1+H4 sólo con score ≥ 90.
- El score no es una probabilidad; el backtest no garantiza resultados futuros. Meta: ≥ 50 señales cerradas en paper con expectativa neta positiva antes de capital real.
