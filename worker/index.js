import { genToken, genOwnerKey, mintNonce, verifyNonce, hashIp } from './crypto.js';
import {
  insertLink, getLinkByToken, getTopLinks, insertClick, incrementScore,
  countRecentByIp, hasRecentCountedClick, insertSpentNonce,
} from './db.js';
import { CONFIG } from './config.js';

const TOKEN_RE = /^\/([A-Za-z0-9\-_]{8})$/;

export default {
  async fetch(request, env) {
    if (env.MAINTENANCE_MODE === 'true') {
      return maintenanceResponse();
    }

    try {
      return await route(request, env);
    } catch (err) {
      const url = new URL(request.url);
      console.error(JSON.stringify({
        path: url.pathname,
        method: request.method,
        error: err.message,
        stack: err.stack,
      }));
      return jsonResponse({ error: 'internal error' }, 500);
    }
  },
};

async function route(request, env) {
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
}

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

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ip_hash = await hashIp(ip, env.IP_HASH_SECRET);

  const since = windowStartIso(CONFIG.linkCreateRateLimit.windowSeconds);
  const recentCount = await countRecentByIp(env, 'links', ip_hash, since);
  if (recentCount >= CONFIG.linkCreateRateLimit.maxAttempts) {
    return jsonResponse({ error: 'rate limited, try again later' }, 429);
  }

  const owner_key = genOwnerKey();
  for (let attempt = 0; attempt < CONFIG.maxLinkCreateAttempts; attempt++) {
    const token = genToken();
    const row = await insertLink(env, { token, display_name, owner_key, ip_hash });
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

  const userAgent = request.headers.get('User-Agent') || '';
  if (isUnfurlBot(userAgent)) {
    return serveUnfurlPreview(request, env, link);
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

function isUnfurlBot(userAgent) {
  const ua = userAgent.toLowerCase();
  return CONFIG.unfurlUserAgents.some((marker) => ua.includes(marker.toLowerCase()));
}

// Serves the real frontend shell at the link's own URL, with per-link OG/
// Twitter tags injected, instead of the 302 + nonce flow real browsers get.
// No nonce is minted here, so this path structurally cannot score a point.
async function serveUnfurlPreview(request, env, link) {
  const html = await fetchFrontendHtml(request, env);
  const tagged = injectUnfurlTags(html, link, new URL(request.url));
  return new Response(tagged, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function injectUnfurlTags(html, link, requestUrl) {
  const title = CONFIG.unfurlTitleTemplate.replace('{name}', escapeHtml(link.display_name));
  const description = CONFIG.unfurlDescriptionTemplate.replace('{name}', escapeHtml(link.display_name));
  const pageUrl = new URL(`/${link.token}`, requestUrl.origin).toString();

  const tags = `<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
`;

  return html.includes('</head>') ? html.replace('</head>', `${tags}</head>`) : tags + html;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function handleClick(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const userAgent = request.headers.get('User-Agent') || '';
  const ipHash = await hashIp(ip, env.IP_HASH_SECRET);

  // PHASE 3: Turnstile/CAPTCHA verification would go here, ahead of every
  // check below, so a failed challenge never spends a DB round trip.

  // Rate limit first, before even looking at the nonce: it's a per-IP cap
  // on requests to this endpoint, not on successful clicks, so a flood of
  // garbage bodies has to be throttled same as a flood of valid ones.
  const clickSince = windowStartIso(CONFIG.clickRateLimit.windowSeconds);
  const recentClicks = await countRecentByIp(env, 'clicks', ipHash, clickSince);
  if (recentClicks >= CONFIG.clickRateLimit.maxAttempts) {
    await logRejectedClick(env, { ip_hash: ipHash, user_agent: userAgent, reason: 'rate_limited' });
    return jsonResponse({ ok: false }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const payload = body.nonce ? await verifyNonce(body.nonce, env.NONCE_SECRET) : null;
  if (!payload) {
    await logRejectedClick(env, { ip_hash: ipHash, user_agent: userAgent, reason: 'invalid_nonce' });
    return jsonResponse({ ok: false }, 400);
  }

  const isFirstUse = await insertSpentNonce(env, payload.rand);
  if (!isFirstUse) {
    await logRejectedClick(env, { ip_hash: ipHash, user_agent: userAgent, reason: 'nonce_replayed' });
    return jsonResponse({ ok: false }, 400);
  }

  const link = await getLinkByToken(env, payload.token);
  if (!link) {
    await logRejectedClick(env, { ip_hash: ipHash, user_agent: userAgent, reason: 'link_not_found' });
    return jsonResponse({ ok: false }, 400);
  }

  const dedupeSince = windowStartIso(CONFIG.dedupeWindowSeconds);
  const isDuplicate = await hasRecentCountedClick(env, link.id, ipHash, dedupeSince);
  if (isDuplicate) {
    await insertClick(env, { link_id: link.id, ip_hash: ipHash, user_agent: userAgent, counted: false, reason: 'duplicate_window' });
    return jsonResponse({ ok: false });
  }

  await insertClick(env, { link_id: link.id, ip_hash: ipHash, user_agent: userAgent, counted: true, reason: null });
  await incrementScore(env, link.id);
  return jsonResponse({ ok: true });
}

function logRejectedClick(env, { ip_hash, user_agent, reason }) {
  return insertClick(env, { link_id: null, ip_hash, user_agent, counted: false, reason });
}

function windowStartIso(windowSeconds) {
  return new Date(Date.now() - windowSeconds * 1000).toISOString();
}

// Fetches the frontend's index.html shell regardless of the request's own
// path — used only for the unfurl-preview injection above, which always
// wants the root document, not whatever /:token would otherwise resolve to.
async function fetchFrontendHtml(request, env) {
  const rootUrl = new URL('/', request.url);
  const res = env.ASSETS
    ? await env.ASSETS.fetch(new Request(rootUrl, request))
    : await fetch(env.FRONTEND_ORIGIN + '/');
  return res.text();
}

async function serveFrontend(request, env) {
  if (env.ASSETS) {
    return env.ASSETS.fetch(request);
  }
  // env.FRONTEND_ORIGIN is set in wrangler.toml's [env.production] vars —
  // this branch only runs in prod, where there's no ASSETS binding and the
  // real frontend lives on GitHub Pages instead.
  const url = new URL(request.url);
  return fetch(env.FRONTEND_ORIGIN + url.pathname + url.search);
}

function maintenanceResponse() {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>computervir.us</title>
<style>
  body { font-family: "Courier New", Courier, monospace; background: #000080; color: #ffff00;
         text-align: center; padding: 4em 1em; margin: 0; }
  h1 { font-size: 1.4em; letter-spacing: 0.05em; }
  p { color: #ffffff; }
</style>
</head>
<body>
<h1>★ be right back ★</h1>
<p>computervir.us is down for maintenance. try again soon.</p>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '300' },
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
