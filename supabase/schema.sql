-- USD/JPY Quant Engine — esquema Supabase
-- Ejecutar en el SQL Editor del proyecto. Todas las escrituras se hacen con la service role key
-- desde funciones del servidor; el frontend sólo lee vía API routes (nunca expone llaves).

create table if not exists candles_cache (
  tf text primary key,                 -- D1 | H4 | H1 | M15 | M5 | M1
  candles jsonb not null,              -- [{time,open,high,low,close}]
  fetched_at timestamptz not null default now(),
  last_close bigint                    -- cierre (UTC s) de la última vela cerrada
);

create table if not exists engine_snapshots (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  data_status text not null,           -- LIVE | DELAYED | HISTORICAL | MARKET_CLOSED | NO_DATA
  snapshot jsonb not null              -- estado completo que consume el dashboard
);
create index if not exists engine_snapshots_created on engine_snapshots (created_at desc);

create table if not exists signals (
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
create index if not exists signals_key_created on signals (key, created_at desc);
create index if not exists signals_status on signals (status);

create table if not exists signal_events (
  id bigserial primary key,
  signal_id text references signals(id) on delete cascade,
  created_at timestamptz not null default now(),
  type text not null,                  -- CREATED | FILLED | TP1 | TP2 | TP3 | SL | BE | TRAIL | EOD | EXPIRED | INVALIDATED
  price numeric,
  payload jsonb
);

create table if not exists paper_trades (
  signal_id text primary key references signals(id) on delete cascade,
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

create table if not exists risk_state (
  id int primary key default 1,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists settings (
  id int primary key default 1,
  broker_preset text not null default 'EXNESS_STANDARD',
  risk jsonb not null default '{}'::jsonb,       -- sobrescribe DEFAULT_RISK
  signal jsonb not null default '{}'::jsonb,     -- sobrescribe DEFAULT_SIGNAL
  news jsonb not null default '{}'::jsonb,       -- sobrescribe DEFAULT_NEWS
  updated_at timestamptz not null default now()
);
insert into settings (id) values (1) on conflict do nothing;

create table if not exists news_events (
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
create index if not exists news_events_time on news_events (time);

create table if not exists macro_cache (
  series text primary key,             -- DGS2, DGS10, IRLTLT01JPM156N
  observations jsonb not null,
  fetched_at timestamptz not null default now()
);

create table if not exists engine_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  duration_ms int,
  data_status text,
  credits_used int,
  signals_created int,
  errors text[],
  notes jsonb
);
create index if not exists engine_runs_started on engine_runs (started_at desc);

-- Limpieza: conservar 7 días de snapshots y 30 de runs
-- (programar en Supabase → Database → Cron, o ejecutar a mano)
-- delete from engine_snapshots where created_at < now() - interval '7 days';
-- delete from engine_runs where started_at < now() - interval '30 days';

alter table candles_cache enable row level security;
alter table engine_snapshots enable row level security;
alter table signals enable row level security;
alter table signal_events enable row level security;
alter table paper_trades enable row level security;
alter table risk_state enable row level security;
alter table settings enable row level security;
alter table news_events enable row level security;
alter table macro_cache enable row level security;
alter table engine_runs enable row level security;
-- Sin políticas públicas: sólo la service role (servidor) lee/escribe.
