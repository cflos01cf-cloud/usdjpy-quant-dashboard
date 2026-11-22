-- USD/JPY Quant Engine — esquema Supabase
-- Todo vive en el esquema `usdjpy` para no chocar con tablas de otros proyectos (EUR/USD, XAU, Oil…)
-- que compartan la misma base. Es seguro ejecutarlo en un proyecto existente: no toca `public`.
--
-- DESPUÉS de ejecutarlo: Project Settings → API (Data API) → "Exposed schemas" → agregar `usdjpy` → Save.
-- El código usa SUPABASE_SCHEMA (por defecto `usdjpy`).
-- Escrituras sólo con la service role key desde el servidor; el frontend nunca ve llaves.

create schema if not exists usdjpy;
grant usage on schema usdjpy to service_role;
alter default privileges in schema usdjpy grant all on tables to service_role;
alter default privileges in schema usdjpy grant all on sequences to service_role;

create table if not exists usdjpy.candles_cache (
  tf text primary key,                 -- D1 | H4 | H1 | M15 | M5 | M1
  candles jsonb not null,              -- [{time,open,high,low,close}]
  fetched_at timestamptz not null default now(),
  last_close bigint                    -- cierre (UTC s) de la última vela cerrada
);

create table if not exists usdjpy.engine_snapshots (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  data_status text not null,           -- LIVE | DELAYED | HISTORICAL | MARKET_CLOSED | NO_DATA
  snapshot jsonb not null              -- estado completo que consume el dashboard
);
create index if not exists engine_snapshots_created on usdjpy.engine_snapshots (created_at desc);

create table if not exists usdjpy.signals (
  id text primary key,
  key text not null,
  created_at timestamptz not null default now(),
  direction text not null,
  entry numeric not null,
  stop numeric not null,
  tp1 numeric not null,
  tp2 numeric not null,
  tp3 numeric not null,
  rr jsonb not null,
  score int not null,
  score_breakdown jsonb not null,
  strategies text[] not null,
  reasons text[] not null,
  confirmation_tf text not null,
  order_type text not null,
  session text,
  valid_until timestamptz not null,
  invalidation text,
  status text not null,                -- PENDING | ACTIVE | CLOSED | EXPIRED | INVALIDATED
  sizing jsonb,
  result_r numeric,
  closed_at timestamptz
);
create index if not exists signals_key_created on usdjpy.signals (key, created_at desc);
create index if not exists signals_status on usdjpy.signals (status);

create table if not exists usdjpy.signal_events (
  id bigserial primary key,
  signal_id text references usdjpy.signals(id) on delete cascade,
  created_at timestamptz not null default now(),
  type text not null,                  -- CREATED | FILLED | TP1 | TP2 | TP3 | SL | BE | TRAIL | EOD | EXPIRED | INVALIDATED
  price numeric,
  payload jsonb
);

create table if not exists usdjpy.paper_trades (
  signal_id text primary key references usdjpy.signals(id) on delete cascade,
  state jsonb not null,                -- TradeState completo (lib/engine/tradeSim.ts)
  status text not null,
  strategy text not null,
  session text,
  result_r numeric,
  pnl_amount numeric,
  slippage_pips numeric,
  spread_pips numeric,
  duration_min numeric,
  updated_at timestamptz not null default now()
);

create table if not exists usdjpy.risk_state (
  id int primary key default 1,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists usdjpy.settings (
  id int primary key default 1,
  broker_preset text not null default 'EXNESS_STANDARD',
  risk jsonb not null default '{}'::jsonb,       -- sobrescribe DEFAULT_RISK
  signal jsonb not null default '{}'::jsonb,     -- sobrescribe DEFAULT_SIGNAL
  news jsonb not null default '{}'::jsonb,       -- sobrescribe DEFAULT_NEWS
  updated_at timestamptz not null default now()
);
insert into usdjpy.settings (id) values (1) on conflict do nothing;

create table if not exists usdjpy.news_events (
  id text primary key,
  time timestamptz not null,
  currency text not null,
  title text not null,
  impact text not null,                -- HIGH | MEDIUM | LOW
  source text not null,                -- 'forexfactory' | 'manual' | ...
  forecast text,
  previous text,
  actual text,
  fetched_at timestamptz not null default now(),
  alerted boolean not null default false
);
create index if not exists news_events_time on usdjpy.news_events (time);

create table if not exists usdjpy.macro_cache (
  series text primary key,             -- DGS2, DGS10, IRLTLT01JPM156N
  observations jsonb not null,
  fetched_at timestamptz not null default now()
);

create table if not exists usdjpy.engine_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  duration_ms int,
  data_status text,
  credits_used int,
  signals_created int,
  errors text[],
  notes jsonb
);
create index if not exists engine_runs_started on usdjpy.engine_runs (started_at desc);

-- Permisos explícitos para tablas ya creadas
grant all on all tables in schema usdjpy to service_role;
grant all on all sequences in schema usdjpy to service_role;

-- RLS activo y sin políticas públicas: sólo la service role (servidor) lee/escribe.
alter table usdjpy.candles_cache enable row level security;
alter table usdjpy.engine_snapshots enable row level security;
alter table usdjpy.signals enable row level security;
alter table usdjpy.signal_events enable row level security;
alter table usdjpy.paper_trades enable row level security;
alter table usdjpy.risk_state enable row level security;
alter table usdjpy.settings enable row level security;
alter table usdjpy.news_events enable row level security;
alter table usdjpy.macro_cache enable row level security;
alter table usdjpy.engine_runs enable row level security;

-- Limpieza opcional (Database → Cron, o a mano):
-- delete from usdjpy.engine_snapshots where created_at < now() - interval '7 days';
-- delete from usdjpy.engine_runs where started_at < now() - interval '30 days';
