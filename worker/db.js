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
export async function insertLink(env, { token, display_name, owner_key }) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/links`, {
    method: 'POST',
    headers: headers(env, { Prefer: 'return=representation' }),
    body: JSON.stringify({ token, display_name, owner_key }),
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

export async function insertClick(env, { link_id, ip_hash, user_agent, counted }) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/clicks`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({ link_id, ip_hash, user_agent, counted }),
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
