// Abundant Stream cloud worker.
// Job 1: dead man's switch. Companion posts status to ntfy at least every 15 minutes.
// If nothing arrives for 20+ minutes, alert Ilan's phone once; when status resumes, say so.
// Stateless: it reads the alert topic to know whether it already sent the "down" alert.

const NTFY = 'https://ntfy.sh/';
const STATUS_TOPIC = 'abundant-status-m4p8w2';
const ALERT_TOPIC = 'abundant-stream-k7x2q9';
const SILENT_MIN = 20;
const TZ = 'America/Denver';

// About 1 in 3 requests from Cloudflare to ntfy hangs; a quick retry almost always gets through.
// If every try fails, the next 5-minute run tries again (the down alert is resent until it lands).
// Optional ntfy access token (secret NTFY_TOKEN) so ntfy counts requests per account, not per shared Cloudflare address.
let NTFY_AUTH = null;
async function ntfyFetch(url, opts) {
  opts = opts || {};
  if (NTFY_AUTH) opts = { ...opts, headers: { ...(opts.headers || {}), authorization: 'Bearer ' + NTFY_AUTH } };
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      // A distinct URL per try so a stuck connection isn't reused.
      const u = (!opts.method || opts.method === 'GET') ? url + (url.includes('?') ? '&' : '?') + 'try=' + i + '-' + Date.now() : url;
      const res = await fetch(u, { ...opts, signal: AbortSignal.timeout(4000) });
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
  return JSON.parse(raw).access;
}
// Only the once-a-minute schedule renews the sign-in, so two renewals can never overlap
// (Restream cancels the old key on each renewal).
async function refreshIfNeeded(env) {
  const raw = await env.STATE.get('restream_tokens');
  if (!raw) return 'not connected';
  const t = JSON.parse(raw);
  if (t.expires - 15 * 60 > Date.now() / 1000) return 'fresh';
  try {
    await saveTokens(env, await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: t.refresh }));
    if (await env.STATE.get('rs_broken')) { await env.STATE.delete('rs_broken'); await notify('🟢 Restream status is working again.', 'restream,up').catch(() => {}); }
    return 'renewed';
  } catch (e) {
    if (/invalid_grant|400|401/.test(String(e.message))) {
      await env.STATE.delete('restream_tokens');
      if (!(await env.STATE.get('rs_broken'))) {
        await env.STATE.put('rs_broken', '1');
        await notify('⚠️ Restream status needs reconnecting (the sign-in expired). Open abundant-stream.proud-base-a9ba.workers.dev/restream/connect and approve. Streaming is not affected.', 'restream,down').catch(() => {});
      }
    }
    return 'error: ' + e.message;
  }
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
    // Restream's newer app picks destinations per stream (event), so show what the events endpoints report.
    for (const p of ['/v2/user/events/in-progress', '/v2/user/events/upcoming?source=1', '/v2/user/events/upcoming']) {
      try {
        const r = await rsGet(env, p);
        const list = Array.isArray(r.body) ? r.body : (r.body && (r.body.events || r.body.data)) || [];
        rows.push(`<h3>${esc(p)} → HTTP ${r.status}, ${list.length} event(s)</h3>`);
        if (!list.length) { rows.push(`<pre>${esc(JSON.stringify(r.body).slice(0, 300))}</pre>`); continue; }
        rows.push(`<p>Fields: <code>${esc(Object.keys(list[0]).join(', '))}</code></p>`);
        for (const ev of list.slice(0, 5)) {
          const d = (ev.destinations || []).map(x => Object.entries(x).filter(([k]) => !/key|url|token/i.test(k)).map(([k, v]) => k + '=' + v).join(' ')).join('<br>');
          rows.push(`<p><b>${esc(ev.title || ev.id)}</b> status=${esc(ev.status)} scheduledFor=${esc(ev.scheduledFor)}<br><span style="font-family:monospace">${d || '(no destinations field)'}</span></p>`);
        }
      } catch (e) { rows.push(`<h3>${esc(p)}</h3><pre>${esc(e.message)}</pre>`); }
    }
    try { rows.push('<h3>As the status page will see it</h3><ul>' + (await readChannels(env)).map(c => `<li>${esc(c.platform)} · ${esc(c.name)}: <b>${c.enabled ? 'ON' : 'off'}</b></li>`).join('') + '</ul>'); } catch (e) { rows.push('<pre>' + esc(e.message) + '</pre>'); }
    return html('<h2>Restream test</h2>' + rows.join(''));
  }
  return html('<h2>Not found</h2>', 404);
}

// ---------- Restream destination status ----------
// The status page asks GET /restream/status about once a minute. Answers are cached for 60 s.
async function platformNames(env) {
  const cached = await env.STATE.get('rs_platforms');
  if (cached) return JSON.parse(cached);
  const r = await fetch(RS_API + '/v2/platform/all');
  const list = r.ok ? await r.json() : [];
  const map = {}; (Array.isArray(list) ? list : []).forEach(p => { map[p.id] = p.name; });
  await env.STATE.put('rs_platforms', JSON.stringify(map), { expirationTtl: 7 * 86400 });
  return map;
}
// Restream's newer app chooses destinations per stream (event) instead of global on/off switches, and the
// old "enabled" flag no longer follows it. So: if a stream is in progress or set up as upcoming, a destination
// counts as on when that stream includes it; with no stream set up, fall back to the old flag.
async function readEvent(env) {
  for (const p of ['/v2/user/events/in-progress', '/v2/user/events/upcoming']) {
    const r = await rsGet(env, p);
    const list = Array.isArray(r.body) ? r.body : [];
    if (r.status !== 200 || !list.length) continue;
    const ev = list.find(e => e.isInstant) || list[0];
    const ids = new Set(); list.forEach(e => (e.destinations || []).forEach(d => ids.add(String(d.channelId))));
    return { title: ev.title || '', live: p.includes('in-progress'), ids, count: list.length };
  }
  return null;
}
async function readChannels(env, withEvent) {
  const r = await rsGet(env, '/v2/user/channel/all');
  if (r.status !== 200 || !Array.isArray(r.body)) throw new Error('Restream channel list HTTP ' + r.status);
  const names = await platformNames(env);
  const ev = await readEvent(env).catch(() => null);
  const channels = r.body.map(c => ({ name: c.displayName, platform: names[c.streamingPlatformId] || ('Platform ' + c.streamingPlatformId),
    enabled: ev ? ev.ids.has(String(c.id)) : !!c.enabled }));
  return withEvent ? { channels, event: ev ? { title: ev.title, live: ev.live, count: ev.count } : null } : channels;
}
async function restreamStatus(req, env, ctx) {
  const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json', 'cache-control': 'public, max-age=60' };
  const cache = caches.default, key = new Request(new URL('/restream/status', req.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  let body;
  try { const rc = await readChannels(env, true); body = { t: Math.floor(Date.now() / 1000), ok: true, channels: rc.channels, event: rc.event }; }
  catch (e) { body = { t: Math.floor(Date.now() / 1000), ok: false, error: String(e.message || e).slice(0, 200) }; }
  const res = new Response(JSON.stringify(body), { headers: cors });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// ---------- Restream destination checks (alerts only when something is wrong) ----------
// Times are Mountain. "on" = these must be on; "off" = these must be off.
const YT = c => /youtube/i.test(c.platform);
const FB = c => /^facebook$/i.test(c.platform);
const SUB = c => /subsplash/i.test(c.name);
const KTSM = c => /ktsm/i.test(c.name);
const DEST_CHECKS = [
  // 30 min before each service (Health Check time): heads-up while there's still time before Go Live.
  { day: 0, min: 8 * 60 + 30, label: 'Sun 9:00', pre: '8:50', on: { YouTube: YT, Facebook: FB, Subsplash: SUB, KTSM } },
  { day: 0, min: 10 * 60 + 15, label: 'Sun 10:45', pre: '10:35', on: { YouTube: YT, Facebook: FB, Subsplash: SUB } },
  { day: 0, min: 12 * 60, label: 'Sun 12:30', pre: '12:20', on: { YouTube: YT, Facebook: FB, Subsplash: SUB } },
  { day: 3, min: 18 * 60, label: 'Wed 6:30', pre: '6:20', on: { YouTube: YT, Facebook: FB, Subsplash: SUB } },
  { day: 0, min: 9 * 60, label: 'Sun 9:00', on: { YouTube: YT, Facebook: FB, Subsplash: SUB, KTSM } },
  { day: 0, min: 10 * 60 + 35, label: 'Sun 9:00', off: { KTSM } },
  { day: 0, min: 10 * 60 + 40, label: 'Sun 10:45', on: { YouTube: YT, Facebook: FB, Subsplash: SUB } },
  { day: 0, min: 12 * 60 + 25, label: 'Sun 12:30', on: { YouTube: YT, Facebook: FB, Subsplash: SUB } },
  { day: 0, min: 14 * 60 + 10, label: 'Sunday', off: { YouTube: YT, Facebook: FB, Subsplash: SUB, KTSM } },
  { day: 3, min: 18 * 60 + 30, label: 'Wed 6:30', on: { YouTube: YT, Facebook: FB, Subsplash: SUB } },
  { day: 3, min: 20 * 60 + 10, label: 'Wednesday', off: { YouTube: YT, Facebook: FB, Subsplash: SUB, KTSM } },
];
function denverClock(ts) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(ts));
  const g = t => p.find(x => x.type === t).value;
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')), min: (parseInt(g('hour'), 10) % 24) * 60 + parseInt(g('minute'), 10) };
}
function destProblems(check, channels) {
  const out = [];
  for (const [name, match] of Object.entries(check.on || {})) {
    const c = channels.filter(match);
    if (!c.length) out.push(name + ' not found in Restream');
    else if (!c.some(x => x.enabled)) out.push(name + ' is off');
  }
  for (const [name, match] of Object.entries(check.off || {})) {
    if (channels.filter(match).some(x => x.enabled)) out.push(name + ' is still on');
  }
  return out;
}
async function checkDestinations(env, ts) {
  const now = denverClock(ts);
  const check = DEST_CHECKS.find(c => c.day === now.day && c.min === now.min);
  if (!check || !(await env.STATE.get('restream_tokens'))) return 'nothing due';
  const problems = destProblems(check, await readChannels(env));
  if (!problems.length) return 'ok';
  const msg = check.pre
    ? `⏰ ${check.label} starts in 30 min: ${problems.join(', ')} in Restream. Turn ${problems.length > 1 ? 'them' : 'it'} on before Go Live at ${check.pre}.`
    : check.on
    ? `⚠️ ${check.label}: Restream destination problem: ${problems.join(', ')}. Viewers there can't see the stream.`
    : `⚠️ ${check.label} is over but ${problems.join(', ')} in Restream. Turn ${problems.length > 1 ? 'them' : 'it'} off so the ATEM can't broadcast by accident.`;
  await notify(msg, 'restream,destinations');
  return 'alerted';
}

export default {
  // Runs every minute: renew the Restream sign-in when needed; heartbeat check every 5 minutes.
  async scheduled(event, env, ctx) {
    NTFY_AUTH = env.NTFY_TOKEN || null;
    const min = new Date(event.scheduledTime || Date.now()).getUTCMinutes();
    const jobs = [];
    if (env.STATE && env.RESTREAM_CLIENT_ID) jobs.push(refreshIfNeeded(env).then(() => checkDestinations(env, event.scheduledTime || Date.now())));
    if (min % 5 === 0) jobs.push(checkHeartbeat(false).then(
      r => env.STATE && env.STATE.put('hb_last', JSON.stringify({ at: new Date().toISOString(), ok: true, action: r.action })),
      e => env.STATE && env.STATE.put('hb_last', JSON.stringify({ at: new Date().toISOString(), ok: false, error: String(e && e.message || e) }))));
    ctx.waitUntil(Promise.allSettled(jobs));
  },
  // Visiting the worker's URL shows the current check without sending anything.
  async fetch(req, env, ctx) {
    NTFY_AUTH = env.NTFY_TOKEN || null;
    const path = new URL(req.url).pathname;
    if (path === '/restream/status') return restreamStatus(req, env, ctx);
    if (path.startsWith('/restream/')) {
      try { return await restreamRoute(req, env, path); }
      catch (e) { return html('<h2>Error</h2><pre>' + esc(e.message || e) + '</pre>', 502); }
    }
    if (path === '/ntfy-check') {
      // Three quick reads from ntfy to see whether Cloudflare can reach it reliably.
      const out = [];
      for (let i = 0; i < 3; i++) { const t0 = Date.now(); try { const r = await fetch(NTFY + STATUS_TOPIC + '/json?poll=1&since=5m', { headers: NTFY_AUTH ? { authorization: 'Bearer ' + NTFY_AUTH } : {}, signal: AbortSignal.timeout(8000) }); out.push(r.status + ' in ' + (Date.now() - t0) + ' ms'); } catch (e) { out.push(e.name + ' after ' + (Date.now() - t0) + ' ms'); } }
      const posts = [];
      for (let i = 0; i < 2; i++) { const t0 = Date.now(); try { const r = await fetch(NTFY + 'abundant-debug-x7q2', { method: 'POST', body: 'check', headers: NTFY_AUTH ? { authorization: 'Bearer ' + NTFY_AUTH } : {}, signal: AbortSignal.timeout(4000) }); posts.push(r.status + ' in ' + (Date.now() - t0) + ' ms ' + (r.status >= 400 ? (await r.text()).slice(0, 120) : '')); } catch (e) { posts.push(e.name + ' after ' + (Date.now() - t0) + ' ms'); } }
      return Response.json({ token: !!NTFY_AUTH, reads: out, posts, lastScheduledCheck: env.STATE ? JSON.parse(await env.STATE.get('hb_last') || 'null') : null });
    }
    try { return Response.json(await checkHeartbeat(true)); }
    catch (e) { return Response.json({ error: String(e) }, { status: 502 }); }
  },
};
