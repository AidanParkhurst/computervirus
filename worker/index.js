import { genToken, genOwnerKey, mintNonce, verifyNonce, hashIp } from './crypto.js';
import { insertLink, getLinkByToken, getTopLinks, insertClick, incrementScore } from './db.js';

// Where the static frontend lives once it's not being served locally by
// Wrangler's asset binding. Swap this when the real GitHub Pages URL exists.
const FRONTEND_ORIGIN = 'https://REPLACE_ME.github.io/REPLACE_ME';

const TOKEN_RE = /^\/([A-Za-z0-9\-_]{8})$/;
const MAX_LINK_CREATE_ATTEMPTS = 5;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/links') {
      return handleCreateLink(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/api/leaderboard') {
      return handleLeaderboard(env);
    }
    if (request.method === 'POST' && url.pathname === '/api/click') {
      return handleClick(request, env);
    }

    const tokenMatch = request.method === 'GET' && url.pathname.match(TOKEN_RE);
    if (tokenMatch) {
      return handleTokenRedirect(request, env, tokenMatch[1]);
    }

    return serveFrontend(request, env);
  },
};

async function handleCreateLink(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid json' }, 400);
  }

  const display_name = String(body.display_name || '').trim().slice(0, 40);
  if (!display_name) {
    return jsonResponse({ error: 'display_name is required' }, 400);
  }

  const owner_key = genOwnerKey();
  for (let attempt = 0; attempt < MAX_LINK_CREATE_ATTEMPTS; attempt++) {
    const token = genToken();
    const row = await insertLink(env, { token, display_name, owner_key });
    if (row) return jsonResponse({ token: row.token, owner_key });
    // row is null on a token collision — loop and try a fresh token.
  }

  return jsonResponse({ error: 'could not generate a unique token, try again' }, 500);
}

async function handleLeaderboard(env) {
  const rows = await getTopLinks(env, 50);
  return jsonResponse(rows);
}

async function handleTokenRedirect(request, env, token) {
  const link = await getLinkByToken(env, token);
  if (!link) {
    // Not a real link token — treat this path as a normal frontend request.
    return serveFrontend(request, env);
  }

  const nonce = await mintNonce(
    { token: link.token, display_name: link.display_name, ts: Math.floor(Date.now() / 1000), rand: crypto.randomUUID() },
    env.NONCE_SECRET
  );

  const url = new URL(request.url);
  const redirectUrl = new URL('/', url.origin);
  redirectUrl.hash = `n=${nonce}`;
  return Response.redirect(redirectUrl.toString(), 302);
}

async function handleClick(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const userAgent = request.headers.get('User-Agent') || '';
  const ipHash = await hashIp(ip, env.IP_HASH_SECRET);

  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const payload = body.nonce ? await verifyNonce(body.nonce, env.NONCE_SECRET) : null;
  const link = payload ? await getLinkByToken(env, payload.token) : null;
  const counted = Boolean(payload && link);

  // Every attempt gets logged, counted or not — this is the fraud-analysis
  // audit trail called for in the brief.
  await insertClick(env, { link_id: link ? link.id : null, ip_hash: ipHash, user_agent: userAgent, counted });

  // PHASE 2: reject nonces that have already been spent (single-use
  // enforcement) and rate-limit by ip_hash here.

  if (!counted) {
    return jsonResponse({ ok: false }, 400);
  }

  await incrementScore(env, link.id);
  return jsonResponse({ ok: true });
}

async function serveFrontend(request, env) {
  // PHASE 2: this is the seam to rewrite/inject into the outgoing HTML —
  // e.g. per-link Open Graph tags ("Bob has claimed 47 victims") so Slack/
  // Discord unfurlers don't spoil the joke before anyone clicks through.
  if (env.ASSETS) {
    return env.ASSETS.fetch(request);
  }
  const url = new URL(request.url);
  return fetch(FRONTEND_ORIGIN + url.pathname + url.search);
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
