// Vanilla JS, no build step. Runs the three-state banner, the leaderboard
// table, and the link-creation form on the single page.

const $ = (id) => document.getElementById(id);
const PLAYER_KEY = 'cv_player'; // localStorage: { token, owner_key, display_name }

// Declared before init() runs: a cold visit calls init -> renderLeaderboard
// -> fetchLeaderboard synchronously with no await in between, so this must
// already be initialized rather than still pending further down the file.
let leaderboardCache = null;

init();

async function init() {
  // Wire the form up first and independently of everything below — a
  // failure in the banner state or the leaderboard fetch must never leave
  // the create-link form as a bare, unhandled HTML GET submission.
  setupCreateForm();

  try {
    const nonce = readNonceFromHash();
    const stored = JSON.parse(localStorage.getItem(PLAYER_KEY) || 'null');

    if (nonce) {
      await handleGotState(nonce);
    } else if (stored) {
      await handleReturningState(stored);
    } else {
      handleColdState();
    }
  } catch (err) {
    console.error('banner state failed:', err);
  }

  try {
    await renderLeaderboard();
  } catch (err) {
    console.error('leaderboard render failed:', err);
  }
}

function handleColdState() {
  $('banner-cold').hidden = false;
}

async function handleGotState(nonce) {
  const payload = decodeNoncePayload(nonce);
  $('banner-got').hidden = false;
  $('got-name').textContent = payload ? payload.display_name : 'someone';

  // Strip the nonce from the address bar so it can't be copy-pasted or
  // replayed from browser history.
  history.replaceState(null, '', location.pathname + location.search);

  try {
    await fetch('/api/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
    });
  } catch {
    // PHASE 2: surface a retry/error state. For now a failed request just
    // silently doesn't score — the banner already displayed optimistically.
  }
}

async function handleReturningState(stored) {
  $('banner-returning').hidden = false;
  $('returning-name').textContent = stored.display_name;

  const link = `${location.origin}/${stored.token}`;
  $('returning-link').textContent = link;
  $('returning-copy').addEventListener('click', () => copyText(link));

  $('create-section').classList.add('demoted');
  $('create-heading').textContent = '★ make another link ★';

  const rows = await fetchLeaderboard();
  const mine = rows.find((r) => r.token === stored.token);
  $('returning-score').textContent = mine ? mine.score : 'not in the top 50 yet';
}

function setupCreateForm() {
  $('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const display_name = $('display-name').value.trim();
    if (!display_name) return;

    const res = await fetch('/api/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name }),
    });
    if (!res.ok) {
      alert('could not create your link, try again');
      return;
    }

    const { token, owner_key } = await res.json();
    localStorage.setItem(PLAYER_KEY, JSON.stringify({ token, owner_key, display_name }));

    const link = `${location.origin}/${token}`;
    $('result-link').textContent = link;
    $('create-result').hidden = false;
    $('create-form').hidden = true;
    $('result-copy').addEventListener('click', () => copyText(link));
  });
}

async function fetchLeaderboard() {
  if (!leaderboardCache) {
    const res = await fetch('/api/leaderboard');
    const body = await res.json();
    if (!res.ok || !Array.isArray(body)) {
      console.error('GET /api/leaderboard did not return a list:', res.status, body);
      return [];
    }
    leaderboardCache = body;
  }
  return leaderboardCache;
}

async function renderLeaderboard() {
  const rows = await fetchLeaderboard();

  const body = $('leaderboard-body');
  body.innerHTML = '';
  rows.slice(0, 10).forEach((row, i) => {
    const tr = document.createElement('tr');
    const rank = document.createElement('td');
    rank.textContent = i + 1;
    const name = document.createElement('td');
    const nameLink = document.createElement('a');
    nameLink.href = `/${row.token}`;
    nameLink.textContent = row.display_name;
    name.appendChild(nameLink);
    const score = document.createElement('td');
    score.textContent = row.score;
    tr.append(rank, name, score);
    body.appendChild(tr);
  });

  // Approximates total clicks from the top-50 rows the API returns — good
  // enough for a flavor widget, not a real global count.
  const totalClicks = rows.reduce((sum, row) => sum + row.score, 0);
  $('visitor-counter').textContent = `YOU ARE VISITOR: ${String(totalClicks).padStart(6, '0')}`;
}

function copyText(text) {
  navigator.clipboard.writeText(text).catch(() => {});
}

function readNonceFromHash() {
  const match = location.hash.match(/^#n=(.+)$/);
  return match ? match[1] : null;
}

function decodeNoncePayload(nonceStr) {
  const payloadB64 = nonceStr.split('.')[0];
  try {
    return JSON.parse(base64UrlDecodeToString(payloadB64));
  } catch {
    return null;
  }
}

// Client-side decode only, for display — the Worker is the one that
// actually verifies the HMAC signature server-side.
function base64UrlDecodeToString(str) {
  const binary = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  let percentEncoded = '';
  for (let i = 0; i < binary.length; i++) {
    percentEncoded += '%' + binary.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return decodeURIComponent(percentEncoded);
}
