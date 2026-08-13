// Hand-rolled fetch wrappers around the Supabase REST API (PostgREST).
// No @supabase/supabase-js — just fetch, per the no-deps rule.

function headers(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// Returns the inserted row, or null if the token already exists (unique
// violation) so the caller can retry with a fresh token.
export async function insertLink(env, { token, display_name, owner_key, ip_hash }) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/links`, {
    method: 'POST',
    headers: headers(env, { Prefer: 'return=representation' }),
    body: JSON.stringify({ token, display_name, owner_key, ip_hash }),
  });
  if (res.status === 409) return null;
  if (!res.ok) throw new Error(`insertLink failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows[0];
}

export async function getLinkByToken(env, token) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/links?token=eq.${encodeURIComponent(token)}&select=*`,
    { headers: headers(env) }
  );
  if (!res.ok) throw new Error(`getLinkByToken failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

export async function getTopLinks(env, limit = 50) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/links?select=display_name,token,score&order=score.desc&limit=${limit}`,
    { headers: headers(env) }
  );
  if (!res.ok) throw new Error(`getTopLinks failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function insertClick(env, { link_id, ip_hash, user_agent, counted, reason }) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/clicks`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({ link_id, ip_hash, user_agent, counted, reason: reason || null }),
  });
  if (!res.ok) throw new Error(`insertClick failed: ${res.status} ${await res.text()}`);
}

export async function incrementScore(env, link_id) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/increment_score`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({ link_id_input: link_id }),
  });
  if (!res.ok) throw new Error(`incrementScore failed: ${res.status} ${await res.text()}`);
}

// Counts rows in `table` (clicks or links) from a given ip_hash since a
// timestamp — the shared shape behind both per-IP rate limits.
export async function countRecentByIp(env, table, ip_hash, sinceIso) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${table}?select=id&ip_hash=eq.${encodeURIComponent(ip_hash)}&created_at=gte.${encodeURIComponent(sinceIso)}`,
    { headers: headers(env) }
  );
  if (!res.ok) throw new Error(`countRecentByIp(${table}) failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows.length;
}

// True if this ip_hash already has a counted click on this link within the
// dedupe window — the same IP re-clicking the same link shouldn't score
// again.
export async function hasRecentCountedClick(env, link_id, ip_hash, sinceIso) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/clicks?select=id&link_id=eq.${link_id}&ip_hash=eq.${encodeURIComponent(ip_hash)}&counted=eq.true&created_at=gte.${encodeURIComponent(sinceIso)}&limit=1`,
    { headers: headers(env) }
  );
  if (!res.ok) throw new Error(`hasRecentCountedClick failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows.length > 0;
}

// Returns true the first time a given nonce id is spent, false if it's
// already been recorded (unique-constraint conflict) — single-use
// enforcement via the same insert-and-check-409 pattern as insertLink.
export async function insertSpentNonce(env, nonceId) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/spent_nonces`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({ nonce_id: nonceId }),
  });
  if (res.status === 409) return false;
  if (!res.ok) throw new Error(`insertSpentNonce failed: ${res.status} ${await res.text()}`);
  return true;
}
