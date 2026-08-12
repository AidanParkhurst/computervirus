# computervir.us — Phase 1

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

## Notes

- No rate limiting, no CAPTCHA, no nonce single-use enforcement, no click
  dedupe beyond the `counted` flag. Look for `// PHASE 2:` comments in
  `worker/index.js` marking where each would go.
- `FRONTEND_ORIGIN` in `worker/index.js` is a placeholder
  (`https://REPLACE_ME.github.io/REPLACE_ME`). It's only used when the
  Worker has no `ASSETS` binding (i.e. once the frontend is actually split
  out to GitHub Pages and the Worker is deployed standalone). Local dev
  never touches it.
