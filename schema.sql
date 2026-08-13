-- Phase 1 schema, plus Phase 2 additions below. Run the whole file in the
-- Supabase SQL editor — for a database that already has the Phase 1 tables,
-- only the "Phase 2 additions" block at the bottom is new.
--
-- The Worker talks to Supabase with the service_role key, which bypasses
-- Row Level Security entirely. RLS is enabled with no policies (see the
-- Phase 2 block below) so nothing else can read or write these tables.

create table links (
  id           bigint generated always as identity primary key,
  token        text not null unique,
  display_name text not null,
  owner_key    text not null,
  score        integer not null default 0,
  created_at   timestamptz not null default now()
);

-- clicks.link_id is nullable on purpose: if a POST to /api/click arrives
-- with a nonce that fails to parse at all, we still want an audit row, even
-- though we have no link to attach it to.
create table clicks (
  id         bigint generated always as identity primary key,
  link_id    bigint references links(id) on delete set null,
  created_at timestamptz not null default now(),
  ip_hash    text,
  user_agent text,
  counted    boolean not null default false
);

create index clicks_link_id_idx on clicks (link_id);

-- Phase 2 additions. Run this whole block once in the Supabase SQL editor
-- against an existing Phase 1 database — every statement below is additive
-- (new columns/tables, or replacing the RPC), nothing here drops data.

-- Lock down PostgREST: RLS with zero policies is default-deny for every
-- role except service_role, which bypasses RLS entirely. The Worker uses
-- service_role, so this only closes off the anon/authenticated surface
-- that was never supposed to be reachable directly.
alter table links enable row level security;
alter table clicks enable row level security;

-- Per-IP rate limiting on link creation needs to know which IP created
-- which link. Nullable/unused by anything user-facing — hashed the same
-- way clicks.ip_hash already is.
alter table links add column ip_hash text;
create index links_ip_hash_created_at_idx on links (ip_hash, created_at);

-- Same index shape for clicks, backing both the /api/click rate limit and
-- the dedupe-window check (both filter by ip_hash + created_at).
create index clicks_ip_hash_created_at_idx on clicks (ip_hash, created_at);

-- Fraud-analysis detail: why a given attempt didn't count. Null when
-- counted = true.
alter table clicks add column reason text;

-- Nonce single-use enforcement. nonce_id is the nonce payload's `rand`
-- field (a UUID minted per redirect). A unique-constraint insert is
-- atomic, so two concurrent replays of the same nonce can't both win —
-- see the Phase 2 plan for why this was picked over Cloudflare KV.
create table spent_nonces (
  nonce_id text primary key,
  spent_at timestamptz not null default now()
);

-- Makes "score within a time window" answerable later (e.g. a monthly
-- leaderboard) without restructuring links or clicks. Nothing queries this
-- yet in Phase 2 — it's populated going forward so there's no backfill
-- needed whenever that feature actually gets built.
create table link_period_scores (
  link_id    bigint not null references links(id) on delete cascade,
  period_key text not null,  -- UTC 'YYYY-MM', e.g. '2026-08' — not load-bearing, just a label
  score      integer not null default 0,
  primary key (link_id, period_key)
);
create index link_period_scores_period_score_idx on link_period_scores (period_key, score desc);

-- Atomic increment via RPC so the Worker never has to read-then-write a
-- score (which would race under concurrent clicks). Phase 2: also upserts
-- the current period's row in link_period_scores in the same statement.
create or replace function increment_score(link_id_input bigint)
returns void
language sql
as $$
  update links set score = score + 1 where id = link_id_input;
  insert into link_period_scores (link_id, period_key, score)
  values (link_id_input, to_char(now() at time zone 'utc', 'YYYY-MM'), 1)
  on conflict (link_id, period_key) do update set score = link_period_scores.score + 1;
$$;
