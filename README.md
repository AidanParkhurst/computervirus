# computervir.us

A joke leaderboard game: generate a deliberately sketchy link, get people to
click it, watch your score go up. Clicking a link only ever lands the
visitor on this site's own leaderboard.

## Local setup

1. **Create a Supabase project.** Free tier is fine. Go to
   [supabase.com](https://supabase.com), create a project, and wait for it
   to finish provisioning.

2. **Run the schema.** Open the SQL editor in your Supabase project and run
   the contents of `schema.sql` (creates `links`, `clicks`, and the
   `increment_score` function).

3. **Get your API keys.** In the Supabase dashboard: Project Settings ->
   API. You need the **Project URL** and the **service_role key** (not the
   anon key — the Worker uses service_role and bypasses RLS).

4. **Set up your local env file.**

   ```
   cp .dev.vars.example .dev.vars
   ```

   Fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from step 3.
   Generate values for `NONCE_SECRET` and `IP_HASH_SECRET` (two different
   random strings — `openssl rand -hex 32` works well).

5. **Install wrangler.**

   ```
   npm install
   ```

6. **Run it.**

   ```
   npm run dev
   ```

   This starts the Worker at `http://localhost:8787`, serving the frontend
   from `public/` and the API from the same origin.

## Try the loop

1. Open `http://localhost:8787`, enter a name, click "generate my link".
   Save the link it gives you (also stored in your browser's localStorage).
2. Open that link (`http://localhost:8787/<token>`) in a different browser
   or an incognito window.
3. You should land back on `http://localhost:8787/` with a "you've been
   got" banner naming the link owner.
4. Refresh the first browser's tab (or reload `http://localhost:8787/`) —
   the score for that name should be up by 1 in the leaderboard table.

## Deploy

Assumes you've never deployed a Cloudflare Worker before. Do these once, in
order.

1. **Add the domain to Cloudflare.** In the Cloudflare dashboard, "Add a
   site" -> `computervir.us` -> pick a plan (Free is fine) -> update your
   registrar's nameservers to the two Cloudflare gives you. Wait for the
   zone to show "Active" (can take a few minutes to a day depending on the
   registrar).

2. **Create a DNS record for the Worker to attach to.** The Worker fully
   handles every request itself — there's no real backend server for the
   apex domain — so this record's target is never actually contacted, it
   just needs to exist and be proxied so Cloudflare routes traffic through
   the Worker instead of failing DNS resolution. In Cloudflare DNS: add an
   `A` record, name `@`, value `192.0.2.1` (a reserved placeholder IP),
   proxy status **Proxied** (orange cloud). This is a standard pattern for
   "Worker is the origin," not a workaround specific to this project.

3. **Set up GitHub Pages for the frontend.** In your GitHub repo: Settings
   -> Pages -> Build and deployment -> Source: "Deploy from a branch" ->
   Branch: `main`, folder: `/public` -> Save. GitHub gives you a URL like
   `https://<you>.github.io/<repo>`. `public/index.html` already uses
   relative asset paths, so it works fine served from that subpath — no
   build step needed.

4. **Point the Worker at that URL.** Edit `wrangler.toml`, under
   `[env.production.vars]`, set `FRONTEND_ORIGIN` to the exact URL from
   step 3, no trailing slash.

5. **Set the production secrets.** These are the same four values from
   your `.dev.vars`, pushed to Cloudflare instead of kept in a local file.
   Run each of these and paste the value when prompted (`.dev.vars` stays
   as-is for local dev — this doesn't replace it, it's a separate secret
   store for the deployed Worker):

   ```
   wrangler secret put SUPABASE_URL --env production
   wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env production
   wrangler secret put NONCE_SECRET --env production
   wrangler secret put IP_HASH_SECRET --env production
   ```

6. **Run the Phase 2 schema additions.** If your Supabase project was only
   ever set up for Phase 1, open the SQL editor and run the "Phase 2
   additions" block at the bottom of `schema.sql` (RLS, the `spent_nonces`
   and `link_period_scores` tables, new columns/indexes, and the updated
   `increment_score` function). Safe to run even on a fresh project — the
   whole file is idempotent-safe to run top to bottom.

7. **Deploy.**

   ```
   npm run deploy
   ```

   This runs `wrangler deploy --env production`, which also creates the
   `computervir.us/*` route declared in `wrangler.toml` on first deploy.

8. **Verify.** Visit `https://computervir.us` — you should see the same
   page you tested locally. Generate a link, click it from another device
   or network, confirm the score updates.

9. **Roll back, if a deploy goes bad.**

   ```
   wrangler deployments list --env production
   wrangler rollback --env production [deployment-id]
   ```

   Omitting the deployment ID rolls back to the previous version.

## Security

**Group B audit (frontend credential check):** `public/index.html`,
`public/app.js`, and `public/style.css` were checked line by line — none of
them reference the Supabase URL, anon key, service role key, or the HMAC
nonce secret, including in comments. The client only ever calls relative
`/api/*` paths, and the one thing it decodes client-side is the nonce's
*payload* (`token`, `display_name`, `ts`, `rand`) — deliberately non-secret,
since the nonce is signed, not encrypted (see the comment in
`worker/crypto.js`). The signature itself is verified server-side only.

**HMAC secret:** `NONCE_SECRET` is only ever read inside
`worker/crypto.js`'s `importHmacKey`, called from `mintNonce`/`verifyNonce`
inside the Worker. It's used to *sign* the nonce, never embedded in it — no
client code path can recover it.

**Row Level Security:** both `links` and `clicks` have RLS enabled with no
policies defined (see `schema.sql`), which is default-deny for every
Postgres role except `service_role`. The Worker authenticates to Supabase
with `service_role`, which bypasses RLS entirely, so this only closes off
the PostgREST surface that was never supposed to be reachable directly —
nothing else can read or write these tables even with the project URL.

## Operations

- **Logs:** the Worker logs uncaught errors as structured JSON
  (`console.error`). Tail them live with `wrangler tail --env production
  --format pretty`, or check after the fact in the Cloudflare dashboard:
  Workers & Pages -> computervirus -> Logs.
- **Kill switch:** set `MAINTENANCE_MODE` to `true` in the Cloudflare
  dashboard (Worker -> Settings -> Variables and Secrets) to take the whole
  site down to a static "be right back" page instantly, no CLI or redeploy
  needed. Flip it back to `false` the same way.
- **Google Search Console / Safe Browsing:** verify domain ownership in
  [Search Console](https://search.google.com/search-console) via a DNS TXT
  record on the Cloudflare zone (Search Console gives you the exact value
  to add). Given the site's whole premise is deliberately sketchy-looking
  links, a Safe Browsing flag is plausible eventually — if it happens,
  it'll show up in Search Console under Security -> Security Issues (also
  checkable anytime at
  [transparencyreport.google.com/safe-browsing/search](https://transparencyreport.google.com/safe-browsing/search)).
  Once you've confirmed the flag is a false positive (or fixed whatever
  triggered it), request a review from that same Security Issues page.

## Notes

- Anti-fraud is deliberately a floor, not a ceiling: per-IP rate limits on
  `/api/click` and `/api/links`, single-use nonces, and a per-IP/per-link
  dedupe window (all tunable in `worker/config.js`) are enough that a
  casual cheater gets bored — not a fortress. Every click attempt, counted
  or not, is logged to `clicks` with a `reason` when it didn't count, for
  looking at the shape of any fraud later.
- No Turnstile/CAPTCHA yet — see the `// PHASE 3:` comment at the top of
  `handleClick` in `worker/index.js` for the seam.
- `app.js` still has one open `// PHASE 2:` comment: a failed `/api/click`
  request currently fails silently (the banner already displayed
  optimistically) rather than surfacing a retry/error state. Not addressed
  here — out of scope for this round.
- Scores shown on the leaderboard are lifetime totals. `schema.sql` also
  populates a `link_period_scores` table (per link, per UTC month) on every
  scored click, so a future time-windowed leaderboard (e.g. monthly, with a
  prize) is a new query away, not a schema migration — nothing reads that
  table yet.
