-- Phase 1 schema. Run this in the Supabase SQL editor.
--
-- The Worker talks to Supabase with the service_role key, which bypasses
-- Row Level Security entirely. That's intentional for Phase 1: the Worker is
-- the only client that ever touches this API, so there's no policy surface
-- to write yet. Leave RLS off (Supabase tables default to RLS disabled).

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

-- Atomic increment via RPC so the Worker never has to read-then-write a
-- score (which would race under concurrent clicks).
create or replace function increment_score(link_id_input bigint)
returns void
language sql
as $$
  update links set score = score + 1 where id = link_id_input;
$$;
