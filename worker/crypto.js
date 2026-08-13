// Token generation, HMAC-signed click nonces, and IP hashing.
// All Web Crypto — no npm crypto deps needed, Workers ships it natively.

const TOKEN_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function genToken(length = 8) {
  // 64-char set, 256 % 64 === 0, so byte % charset.length has no modulo bias.
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let token = '';
  for (const b of bytes) token += TOKEN_CHARSET[b % TOKEN_CHARSET.length];
  return token;
}

export function genOwnerKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashIp(ip, secret) {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Nonce format: base64url(JSON payload) + "." + base64url(HMAC signature).
// Not encrypted, just signed — the payload is readable by the browser so
// the leaderboard page can show "you scored a point for X" immediately.
export async function mintNonce(payload, secret) {
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${base64UrlEncode(sig)}`;
}

// Returns the decoded payload if the signature is valid and it's under 60s
// old, otherwise null. Caller decides what "invalid" means for logging.
//
// Wrapped in one try/catch because malformed input (e.g. a sigB64 segment
// that isn't valid base64 at all) makes atob() throw rather than just
// failing the signature check — and an attacker-controlled request body is
// exactly the input this needs to be defensive against, not just
// well-formed-but-wrong nonces.
export async function verifyNonce(nonceStr, secret) {
  try {
    const parts = nonceStr.split('.');
    if (parts.length !== 2) return null;
    const [payloadB64, sigB64] = parts;

    const key = await importHmacKey(secret);
    const sigBytes = base64UrlDecodeToBytes(sigB64);
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payloadB64));
    if (!valid) return null;

    const payload = JSON.parse(base64UrlDecodeToString(payloadB64));
    const ageSeconds = Date.now() / 1000 - payload.ts;
    if (ageSeconds > 60 || ageSeconds < -5) return null; // -5s slack for clock skew
    return payload;
  } catch {
    return null;
  }
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function base64UrlEncode(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeToBytes(str) {
  const binary = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeToString(str) {
  return new TextDecoder().decode(base64UrlDecodeToBytes(str));
}
