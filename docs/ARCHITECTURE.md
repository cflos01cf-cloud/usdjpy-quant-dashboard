# USD/JPY Quant Engine — Arquitectura técnica y plan de implementación

## 1. Decisiones de diseño

| Decisión | Elección | Motivo |
|---|---|---|
| Motor en vivo | Next.js 16 + TypeScript, Netlify (función programada cada 5 min) | Mismo stack que EUR/USD, XAU y Oil; despliegue y operación ya conocidos. |
| Persistencia | Supabase (PostgreSQL) | Caché compartido de velas, señales, paper trades, estado de riesgo. |
| Research | Paquete Python (`research/`) con pandas/numpy/scikit-learn | Backtest, walk-forward, Monte Carlo y ML corren offline. **Las señales del backtest las genera el mismo motor TS que corre en vivo** (`web/scripts/backtest-export.ts`), así no hay un port a Python que pueda divergir. |
| Datos | TwelveData (`USD/JPY`), cuenta exclusiva | Plan gratuito: 8 req/min, 800 créditos/día → presupuesto de créditos en §4. |
| Broker | Exness (parámetros en `lib/config.ts`) | Spread, comisión y contrato configurables (Standard vs Raw Spread). |
| Calendario | Feed semanal de ForexFactory (JSON público) + tabla manual en Supabase | Sin inventar noticias: cada evento guarda fuente y hora de obtención. Intervenciones/BOJ se pueden registrar a mano. |
| Macro | FRED (DGS2, DGS10, IRLTLT01JPM156N) | Diferencial de tasas EE. UU.–Japón como contexto D1. Opcional (requiere `FRED_API_KEY`). |
| Gráficos | lightweight-charts v5 | Velas reales + EMAs + marcadores BOS/CHoCH/sweep + zonas FVG/OB (primitiva propia). |
| Alertas | Telegram Bot API | Señales, invalidaciones, TP/SL, límites de riesgo, noticias de alto impacto. |

**Principio central — causalidad:** todo cálculo (indicadores, swings, BOS/CHoCH, FVG, OB, sesiones) se produce como *series* donde el valor en la vela `i` sólo usa velas `≤ i`. Un swing con confirmación de `n` velas a la derecha sólo "existe" a partir de `i + n`. Así el mismo código sirve para vivo y para backtest sin look-ahead. Las temporalidades superiores se alinean por **hora de cierre** (una vela H1 sólo es visible cuando cerró).

## 2. Capas (separadas como pide el prompt)

```
┌──────────────┐  ┌──────────────────┐  ┌─────────────────┐  ┌──────────────┐
│ Datos        │→ │ Motor de análisis │→ │ Motor de señales│→ │ Riesgo       │
│ data/        │  │ engine/           │  │ strategies/     │  │ engine/risk  │
│ TwelveData   │  │ indicadores, SMC, │  │ A–E, scoring,   │  │ sizing, kill │
│ calendario   │  │ sesiones, régimen │  │ niveles, dedupe │  │ switch       │
│ FRED         │  └──────────────────┘  └─────────────────┘  └──────┬───────┘
└──────────────┘                                                    │
        ▲                                                           ▼
┌──────────────┐  ┌──────────────────┐  ┌─────────────────┐  ┌──────────────┐
│ Supabase     │← │ Ciclo autónomo    │→ │ Alertas Telegram│  │ Paper trading│
│ caché/estado │  │ engine-cron (5m)  │  │ services/       │  │ seguimiento  │
└──────────────┘  └──────────────────┘  └─────────────────┘  └──────────────┘
        │
        ▼
┌─────────────────────────────┐        ┌──────────────────────────────────┐
│ Interfaz Next.js (lee sólo   │        │ Research Python (offline)        │
│ snapshots: no gasta créditos)│        │ backtest · WFA · Monte Carlo · ML │
└─────────────────────────────┘        └──────────────────────────────────┘
```

## 3. Ciclo autónomo (cada 5 min, `netlify/functions/engine-cron.mts`)

1. **Obtener datos** — M1/M5/M15 en cada ciclo; H1/H4/D1 desde caché si siguen vigentes.
2. **Validar calidad** — orden temporal, duplicados, OHLC coherente, huecos, antigüedad → `LIVE` / `DELAYED` / `HISTORICAL` / `MARKET_CLOSED`. Sin `LIVE` no hay señales nuevas. Nunca se simulan precios.
3. **Indicadores** — EMA 20/50/200, RSI 14, MACD 12/26/9, ATR 14, ADX 14 por temporalidad.
4. **Estructura** — swings, tendencia, BOS, CHoCH, FVG, Order Blocks, sweeps, equal highs/lows, rangos de sesión, PDH/PDL, premium/discount.
5. **Estrategias A–E** — cada una propone *setups* independientes.
6. **Scoring** 0–100 por dirección con los pesos del prompt; filtros duros aparte (noticias, spread, distancia a la entrada, R:R neto < 2, límites de riesgo).
7. **Riesgo** — tamaño de posición, límites diario/semanal, posiciones simultáneas, rachas, kill switch.
8. **Señal** — Entry / SL / TP1-3 / R:R / vigencia / invalidación; deduplicación por clave de oportunidad + cooldown.
9. **Alertas** — Telegram.
10. **Seguimiento** — paper trades con velas M1 (si una vela toca SL y TP, se asume SL), parciales, break-even, trailing, cierre por fin de jornada.
11. **Registro** — `engine_runs`, `signals`, `signal_events`, `paper_trades`, `engine_snapshots`.

## 4. Presupuesto de créditos TwelveData (plan gratuito)

| TF | Refresco | Llamadas/día (06–21 UTC) |
|---|---|---|
| M1, M5, M15 | cada ciclo (5 min) | 3 × 180 = 540 |
| H1 | 15 min | 60 |
| H4 | 60 min | 15 |
| D1 | 1 vez + al cambio de día | ~2 |
| **Total** | | **≈ 617 / 800** |

El dashboard nunca llama a TwelveData: lee el último snapshot de Supabase.

## 5. Scoring (0–100)

| Bloque | Pts | Componentes |
|---|---|---|
| Tendencia y estructura | 20 | D1 5 · H4 6 · H1 5 · estructura M15 4 |
| Smart Money Concepts | 20 | sweep 6 · BOS/CHoCH a favor 5 · precio en FVG/OB 5 · premium/discount correcto 4 |
| Confirmación técnica | 15 | 5 pts por estrategia independiente que coincide (máx. 3) |
| Liquidez | 15 | liquidez tomada 7 · objetivo de liquidez con espacio ≥ TP2 8 |
| Momentum | 10 | MACD 4 · RSI 3 · ADX ≥ 20 y subiendo 3 |
| Volatilidad | 10 | ATR en percentil 20–85 → 6 · spread/ATR aceptable 4 |
| Sesión y noticias | 10 | Londres/NY/overlap 6 (Tokio 3) · sin evento de alto impacto en ventana extendida 4 |

El score **no** es una probabilidad. Los umbrales (90/80/70/60) se recalibran con walk-forward: el módulo Python reporta la expectativa neta por banda de score.

## 6. Esquema de base de datos

Ver `supabase/schema.sql`: `candles_cache`, `engine_snapshots`, `signals`, `signal_events`, `paper_trades`, `risk_state`, `settings`, `news_events`, `engine_runs`.

## 7. Plan de fases

| Fase | Entregable | Estado |
|---|---|---|
| 1 | Arquitectura + UI | ✅ este repo |
| 2 | Conexión TwelveData + validación de datos | ✅ código; requiere API key |
| 3 | Indicadores | ✅ con tests |
| 4 | SMC (swings, BOS, CHoCH, FVG, OB, sweeps, EQH/EQL) | ✅ con tests |
| 5 | Estrategias A–E + scoring + señales | ✅ |
| 6 | Riesgo (sizing Exness, límites, kill switch, BE, trailing, parciales) | ✅ |
| 7 | Backtest, walk-forward, Monte Carlo, ML (Python) | ✅ código; correr con histórico real |
| 8 | Telegram | ✅ requiere bot token |
| 9 | Paper trading | ✅ |
| 10 | Validación integral y despliegue | ⏳ 50+ señales cerradas en paper antes de capital real |

## 8. Metodologías adicionales incorporadas (y cómo se comparan)

- **Meta-labeling** (López de Prado): en lugar de que el ML genere señales, un clasificador decide si *tomar o no* una señal del motor de reglas. Se compara en walk-forward: expectativa neta con y sin filtro ML. Sólo se activa si mejora OOS.
- **Purged walk-forward con embargo**: evita fuga de información entre ventanas solapadas.
- **Bootstrap Monte Carlo** de la secuencia de R: distribución de drawdown y probabilidad de tocar el límite de pérdida.
- **Objetivo robusto**: la optimización maximiza expectativa neta en R penalizando pocos trades y drawdown, y se elige la región de parámetros estable (vecindad), no el pico.

- **Una sola fuente de verdad para las señales**: en lugar de portar el motor a Python (lo que pide el prompt original), el backtest ejecuta el código TS de producción vela a vela y exporta candidatas con varias variantes de salida ya simuladas. Python aplica umbrales, reglas de riesgo y validación. Prueba de fuga: sobre un random walk sin costos la expectativa sale negativa (≈ −0.2 R por el supuesto conservador de SL primero), no positiva.
