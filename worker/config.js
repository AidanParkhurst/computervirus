// Phase 2 tunables that don't vary by environment. Environment-varying
// settings (FRONTEND_ORIGIN, MAINTENANCE_MODE) live in wrangler.toml's
// [vars] blocks instead — see the [env.production] section there.

export const CONFIG = {
  maxLinkCreateAttempts: 5,

  // Per-IP rate limits, enforced with a "count recent rows" query against
  // Supabase rather than a Cloudflare Rate Limiting binding — see the
  // Group C notes in the Phase 2 plan for the tradeoff.
  clickRateLimit: { windowSeconds: 60, maxAttempts: 20 },
  linkCreateRateLimit: { windowSeconds: 3600, maxAttempts: 5 },

  // A counted click from the same IP hitting the same link again inside
  // this window gets logged but not scored.
  dedupeWindowSeconds: 300,

  // Case-insensitive substring match against the request's User-Agent.
  // Matches here skip nonce-minting and get templated OG/Twitter tags
  // instead of the real 302 + nonce redirect flow.
  unfurlUserAgents: [
    'facebookexternalhit',
    'Facebot',
    'Twitterbot',
    'Slackbot',
    'Discordbot',
    'TelegramBot',
    'WhatsApp',
    'LinkedInBot',
    'SkypeUriPreview',
    'Googlebot',
    'bingbot',
    'redditbot',
    'Applebot',
    'Pinterest',
    'vkShare',
    'W3C_Validator',
  ],

  // {name} is replaced with the link's display_name. Deliberately junk-link
  // energy, not real phishing: no company/product impersonation, no ask for
  // credentials/payment/personal info, no concrete "you've won X" claim.
  unfurlTitleTemplate: '{name} sent you a link \u{1F440}',
  unfurlDescriptionTemplate: 'highly clickable. definitely not a trick. 100% real website guaranteed*',
};
