// Abundant Stream cloud worker.
// Job 1: dead man's switch. Companion posts status to ntfy at least every 15 minutes.
// If nothing arrives for 20+ minutes, alert Ilan's phone once; when status resumes, say so.
// Stateless: it reads the alert topic to know whether it already sent the "down" alert.

const NTFY = 'https://ntfy.sh/';
const STATUS_TOPIC = 'abundant-status-m4p8w2';
const ALERT_TOPIC = 'abundant-stream-k7x2q9';
const SILENT_MIN = 20;
const TZ = 'America/Denver';

// ntfy occasionally times out (522) on the first try from Cloudflare; retry quickly.
async function ntfyFetch(url, opts) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(8000) });
      if (res.ok) return res;
      last = new Error(`ntfy ${res.status}`);
    } catch (e) { last = e; }
  }
  throw last;
}

async function poll(topic) {
  const res = await ntfyFetch(`${NTFY}${topic}/json?poll=1&since=12h`);
  return (await res.text()).split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(m => m && m.event === 'message');
}

function clock(ts) {
  return new Date(ts * 1000).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
}

async function notify(message, tags) {
  await ntfyFetch(NTFY + ALERT_TOPIC, { method: 'POST', body: message, headers: { Tags: tags } });
}

async function checkHeartbeat(dryRun) {
  const now = Math.floor(Date.now() / 1000);
  const [status, alerts] = await Promise.all([poll(STATUS_TOPIC), poll(ALERT_TOPIC)]);
  const last = status.reduce((t, m) => Math.max(t, m.time), 0);
  const silentFor = last ? now - last : null;
  const silent = !last || silentFor > SILENT_MIN * 60;
  const mine = alerts.filter(m => (m.tags || []).includes('heartbeat')).sort((a, b) => b.time - a.time)[0];
  const downSent = !!mine && (mine.tags || []).includes('down');

  let action = 'none';
  if (silent && !downSent) {
    action = 'down';
    const since = last ? `since ${clock(last)} (${Math.round(silentFor / 60)} min)` : 'in the last 12 hours';
    if (!dryRun) await notify(`⚠️ Church Mac is silent: no status from Companion ${since}. The Mac may be asleep, off or offline, or Companion is closed.`, 'heartbeat,down');
  } else if (!silent && downSent) {
    action = 'up';
    const gap = Math.round((last - mine.time) / 60) + SILENT_MIN;
    if (!dryRun) await notify(`🟢 Church Mac is reporting again (quiet for about ${gap} min).`, 'heartbeat,up');
  }
  return { lastStatus: last ? new Date(last * 1000).toISOString() : null, silentMinutes: silentFor === null ? null : Math.round(silentFor / 60), downAlertOpen: downSent, action, dryRun: !!dryRun };
}


// ---------- Restream (testing stage) ----------
// Secrets RESTREAM_CLIENT_ID and RESTREAM_CLIENT_SECRET live in Cloudflare settings, never in this repo.
const RS_API = 'https://api.restream.io';

function html(body, status) {
  return new Response(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Abundant Stream · Restream</title><body style="font:16px system-ui;max-width:640px;margin:40px auto;padding:0 16px;background:#0f1214;color:#e8ecee">${body}</body>`, { status: status || 200, headers: { 'content-type': 'text/html;charset=utf-8' } });
}
function callbackUrl(req) { return new URL('/restream/callback', req.url).toString(); }
function basicAuth(env) { return 'Basic ' + btoa(env.RESTREAM_CLIENT_ID + ':' + env.RESTREAM_CLIENT_SECRET); }

async function saveTokens(env, j) {
  const t = { access: j.access_token, refresh: j.refresh_token, expires: j.expires || (Math.floor(Date.now() / 1000) + (j.expires_in || 3600)) };
  await env.STATE.put('restream_tokens', JSON.stringify(t));
  return t;
}
async function tokenRequest(env, params) {
  const r = await fetch(RS_API + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basicAuth(env) }, body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Restream token request failed: ' + r.status + ' ' + JSON.stringify(j.error || j).slice(0, 200));
  return j;
}
async function accessToken(env) {
  const raw = await env.STATE.get('restream_tokens');
  if (!raw) return null;
  let t = JSON.parse(raw);
  if (t.expires - 120 < Date.now() / 1000) t = await saveTokens(env, await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: t.refresh }));
  return t.access;
}
async function rsGet(env, path) {
  const tok = await accessToken(env);
  if (!tok) throw new Error('Not connected to Restream yet');
  const r = await fetch(RS_API + path, { headers: { authorization: 'Bearer ' + tok } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

async function restreamRoute(req, env, path) {
  if (!env.RESTREAM_CLIENT_ID || !env.RESTREAM_CLIENT_SECRET) return html('<h2>Not set up</h2><p>Add RESTREAM_CLIENT_ID and RESTREAM_CLIENT_SECRET in Cloudflare first.</p>', 503);
  const url = new URL(req.url);
  if (path === '/restream/connect') {
    // Only allowed while not connected, so nobody else can swap in their account.
    if (await env.STATE.get('restream_tokens') && url.searchParams.get('force') !== '1') return html('<h2>Already connected</h2><p><a style="color:#2fd27a" href="/restream/test">Run the test</a></p>');
    const state = crypto.randomUUID();
    await env.STATE.put('oauth_state', state, { expirationTtl: 600 });
    const q = new URLSearchParams({ response_type: 'code', client_id: env.RESTREAM_CLIENT_ID, redirect_uri: callbackUrl(req), state });
    return Response.redirect(RS_API + '/login?' + q, 302);
  }
  if (path === '/restream/callback') {
    const code = url.searchParams.get('code'), state = url.searchParams.get('state');
    if (!code) {
      const got = [...url.searchParams.entries()].map(([k, v]) => esc(k) + ' = ' + esc(v.slice(0, 200))).join('<br>') || '(nothing)';
      return html('<h2>Not connected</h2><p>Restream didn\'t send a code. It sent back:</p><p style="font-family:monospace;color:#f5b041">' + got + '</p>', 400);
    }
    if (!state || state !== await env.STATE.get('oauth_state')) return html('<h2>Link expired</h2><p>Start again from /restream/connect.</p>', 400);
    await env.STATE.delete('oauth_state');
    await saveTokens(env, await tokenRequest(env, { grant_type: 'authorization_code', redirect_uri: callbackUrl(req), code }));
    return Response.redirect(new URL('/restream/test', req.url).toString(), 302);
  }
  if (path === '/restream/test') {
    // Shows what Restream reports for each destination (names and on/off-style fields only; no keys).
    const rows = [];
    for (const p of ['/v2/user/channels', '/v2/user/channel/all']) {
      const r = await rsGet(env, p);
      const list = Array.isArray(r.body) ? r.body : (r.body && (r.body.channels || r.body.data)) || [];
      rows.push(`<h3>${p} → HTTP ${r.status}</h3>`);
      if (!list.length) { rows.push(`<pre>${esc(JSON.stringify(r.body).slice(0, 300))}</pre>`); continue; }
      rows.push(`<p>Fields: <code>${esc(Object.keys(list[0]).join(', '))}</code></p><ul>`);
      for (const c of list) {
        const flags = Object.entries(c).filter(([k, v]) => typeof v === 'boolean' || /active|enabled|status|online/i.test(k)).map(([k, v]) => k + '=' + v).join(' · ');
        rows.push(`<li>${esc(c.displayName || c.name || c.id)} <span style="color:#8d989e">${esc(flags || '(no on/off field)')}</span></li>`);
      }
      rows.push('</ul>');
    }
    try { rows.push('<p>Status page update: ' + esc(await checkRestream(env)) + '</p>'); } catch (e) { rows.push('<pre>' + esc(e.message) + '</pre>'); }
    try { rows.push('<h3>As the status page will see it</h3><ul>' + (await readChannels(env)).map(c => `<li>${esc(c.platform)} · ${esc(c.name)}: <b>${c.enabled ? 'ON' : 'off'}</b></li>`).join('') + '</ul>'); } catch (e) { rows.push('<pre>' + esc(e.message) + '</pre>'); }
    return html('<h2>Restream test</h2>' + rows.join(''));
  }
  return html('<h2>Not found</h2>', 404);
}

// ---------- Restream destination status ----------
const RESTREAM_TOPIC = 'abundant-restream-jg00ai';
// Service windows (Mountain time): check every minute inside these, every 15 minutes otherwise.
const WINDOWS = [
  { day: 0, from: 8 * 60, to: 14 * 60 + 30 },   // Sunday, all three services
  { day: 3, from: 17 * 60 + 30, to: 20 * 60 + 30 }, // Wednesday
  { day: 6, from: 16 * 60 + 30, to: 19 * 60 },  // Saturday replay
];
function denverNow() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')), min: (parseInt(g('hour'), 10) % 24) * 60 + parseInt(g('minute'), 10) };
}
function inWindow() { const n = denverNow(); return WINDOWS.some(w => w.day === n.day && n.min >= w.from && n.min < w.to); }

async function platformNames(env) {
  const cached = await env.STATE.get('rs_platforms');
  if (cached) return JSON.parse(cached);
  const r = await fetch(RS_API + '/v2/platform/all');
  const list = r.ok ? await r.json() : [];
  const map = {}; (Array.isArray(list) ? list : []).forEach(p => { map[p.id] = p.name; });
  await env.STATE.put('rs_platforms', JSON.stringify(map), { expirationTtl: 7 * 86400 });
  return map;
}

async function readChannels(env) {
  const r = await rsGet(env, '/v2/user/channel/all');
  if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('Restream channel list HTTP ' + r.status);
  const names = await platformNames(env);
  return r.body.map(c => ({ name: c.displayName, platform: names[c.streamingPlatformId] || ('Platform ' + c.streamingPlatformId), enabled: !!c.enabled }));
}

async function checkRestream(env) {
  if (!env.RESTREAM_CLIENT_ID || !env.STATE) return 'not set up';
  if (!(await env.STATE.get('restream_tokens'))) return 'not connected';
  const t = Math.floor(Date.now() / 1000);
  let msg;
  try {
    msg = { t, ok: true, channels: await readChannels(env) };
    if (await env.STATE.get('rs_broken')) {
      await env.STATE.delete('rs_broken');
      await notify('🟢 Restream status is working again.', 'restream,up');
    }
  } catch (e) {
    const text = String(e.message || e);
    msg = { t, ok: false, error: text.slice(0, 200) };
    if (/invalid_grant|refresh/i.test(text)) {
      // Sign-in chain broken: clear it so /restream/connect works again, and tell Ilan once.
      await env.STATE.delete('restream_tokens');
      if (!(await env.STATE.get('rs_broken'))) {
        await env.STATE.put('rs_broken', '1');
        await notify('⚠️ Restream status needs reconnecting (the sign-in expired). Open abundant-stream.proud-base-a9ba.workers.dev/restream/connect and approve. Streaming is not affected.', 'restream,down');
      }
    }
  }
  await ntfyFetch(NTFY + RESTREAM_TOPIC, { method: 'POST', body: JSON.stringify(msg) });
  return msg.ok ? 'posted' : 'error: ' + msg.error;
}

export default {
  // Runs every minute: heartbeat check every 5 minutes; Restream every minute during services, every 15 otherwise.
  async scheduled(event, env, ctx) {
    const min = new Date(event.scheduledTime || Date.now()).getUTCMinutes();
    const jobs = [];
    if (min % 5 === 0) jobs.push(checkHeartbeat(false));
    if (inWindow() || min % 15 === 0) jobs.push(checkRestream(env));
    ctx.waitUntil(Promise.allSettled(jobs));
  },
  // Visiting the worker's URL shows the current check without sending anything.
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/restream/')) {
      try { return await restreamRoute(req, env, path); }
      catch (e) { return html('<h2>Error</h2><pre>' + esc(e.message || e) + '</pre>', 502); }
    }
    if (path === '/debug') {
      const out = {};
      for (const u of ['https://ntfy.sh/v1/health', 'https://ntfy.sh/' + STATUS_TOPIC + '/json?poll=1&since=1h', 'https://example.com/']) {
        const t0 = Date.now();
        try { const r = await fetch(u); out[u.split('?')[0]] = r.status + ' in ' + (Date.now() - t0) + 'ms'; }
        catch (e) { out[u.split('?')[0]] = 'error ' + e; }
      }
      return Response.json(out);
    }
    try { return Response.json(await checkHeartbeat(true)); }
    catch (e) { return Response.json({ error: String(e) }, { status: 502 }); }
  },
};
