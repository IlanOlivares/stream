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
    // Only allowed while not connected (or connected without the write permission the worker now needs),
    // so nobody else can swap in their account. To reconnect on purpose otherwise, delete the restream_tokens
    // key in the worker's KV storage (Cloudflare dashboard) first.
    const scope = await env.STATE.get('rs_scope') || '';
    if (await env.STATE.get('restream_tokens') && scope.includes('stream.write')) return html('<h2>Already connected</h2><p><a style="color:#2fd27a" href="/restream/test">Run the test</a></p>');
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
    const tok = await tokenRequest(env, { grant_type: 'authorization_code', redirect_uri: callbackUrl(req), code });
    await saveTokens(env, tok);
    await env.STATE.put('rs_scope', url.searchParams.get('scope') || tok.scope || '');
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
    // Write-permission probe: a delete with a deliberately invalid id changes nothing. 400 = allowed, 401/403 = not.
    try {
      const ev = await readEvent(env);
      if (ev && !ev.live) {
        const t = await accessToken(env);
        const r = await fetch(RS_API + '/v2/user/events/' + ev.id + '/destinations/not-a-uuid', { method: 'DELETE', headers: { authorization: 'Bearer ' + t } });
        rows.push(`<h3>Write permission probe → HTTP ${r.status}</h3><pre>${esc((await r.text()).slice(0, 300))}</pre>`);
      } else rows.push('<h3>Write permission probe skipped</h3><p>' + (ev ? 'A stream is in progress.' : 'No reusable stream found.') + '</p>');
    } catch (e) { rows.push('<h3>Write permission probe</h3><pre>' + esc(e.message) + '</pre>'); }
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
// A stream in progress counts whatever it is. Otherwise only the reusable live stream counts (the one the
// ATEM feeds, no scheduled time); scheduled events such as Saturday's replay upload are ignored until they run.
async function readEvent(env) {
  for (const p of ['/v2/user/events/in-progress', '/v2/user/events/upcoming']) {
    const r = await rsGet(env, p);
    let list = Array.isArray(r.body) ? r.body : [];
    if (r.status !== 200) continue;
    if (!p.includes('in-progress')) list = list.filter(e => !e.scheduledFor && !e.isRecordOnly);
    if (!list.length) continue;
    const ev = list.find(e => e.isInstant) || list[0];
    const ids = new Set(); list.forEach(e => (e.destinations || []).forEach(d => ids.add(String(d.channelId))));
    return { id: ev.id, title: ev.title || '', live: p.includes('in-progress'), ids, count: list.length,
      dests: list.flatMap(e => (e.destinations || []).map(d => ({ event: e.id, id: d.id, channelId: String(d.channelId) }))) };
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

// ---------- YouTube: is the English channel actually live? (needs the YOUTUBE_API_KEY secret) ----------
// Only asks YouTube during service windows. One search (100 quota units, at most every 5 min) finds the live
// video; after that a 1-unit lookup confirms it is still live. Daily quota is 10,000 units.
const YT_CHANNEL = 'UCOVPztRFN8bXFYhak1j7KkQ';
const YT_WINDOWS = [[0, 530, 625], [0, 635, 730], [0, 740, 840], [3, 1100, 1200], [6, 1010, 1110]];
async function ytGet(env, path) {
  const r = await fetch('https://www.googleapis.com/youtube/v3/' + path + '&key=' + env.YOUTUBE_API_KEY, { signal: AbortSignal.timeout(8000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('YouTube API ' + r.status + ' ' + ((j.error && j.error.message) || '').slice(0, 120));
  return j;
}
async function youtubeStatus(env, ts) {
  if (!env.YOUTUBE_API_KEY) return { configured: false };
  const now = denverClock(ts), t = Math.floor(ts / 1000);
  const inWindow = YT_WINDOWS.some(([d, a, b]) => d === now.day && now.min >= a && now.min < b);
  if (!inWindow) { await env.STATE.delete('yt_live'); return { configured: true, inWindow: false, live: false }; }
  const saved = JSON.parse(await env.STATE.get('yt_live') || 'null');
  if (saved && saved.id) {
    const j = await ytGet(env, 'videos?part=snippet,liveStreamingDetails&id=' + saved.id);
    const v = (j.items || [])[0];
    if (v && v.snippet.liveBroadcastContent === 'live') return { configured: true, inWindow: true, live: true, id: saved.id, title: v.snippet.title, since: v.liveStreamingDetails && v.liveStreamingDetails.actualStartTime };
    await env.STATE.delete('yt_live');
  }
  const last = Number(await env.STATE.get('yt_search_at') || 0);
  if (t - last < 300) return { configured: true, inWindow: true, live: false, nextSearch: last + 300 };
  await env.STATE.put('yt_search_at', String(t), { expirationTtl: 3600 });
  const j = await ytGet(env, 'search?part=snippet&channelId=' + YT_CHANNEL + '&eventType=live&type=video&maxResults=1');
  const hit = (j.items || [])[0];
  if (!hit) return { configured: true, inWindow: true, live: false };
  await env.STATE.put('yt_live', JSON.stringify({ id: hit.id.videoId, at: t }), { expirationTtl: 6 * 3600 });
  return { configured: true, inWindow: true, live: true, id: hit.id.videoId, title: hit.snippet.title };
}
async function youtubeRoute(req, env, ctx) {
  const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json', 'cache-control': 'public, max-age=120' };
  const cache = caches.default, key = new Request(new URL('/youtube/status', req.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  let body;
  try { body = { t: Math.floor(Date.now() / 1000), ok: true, ...(await youtubeStatus(env, Date.now())) }; }
  catch (e) { body = { t: Math.floor(Date.now() / 1000), ok: false, error: String(e.message || e).slice(0, 200) }; }
  const res = new Response(JSON.stringify(body), { headers: cors });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}
// Two minutes after each Live Check: alert if YouTube still isn't showing the stream.
const YT_CHECKS = [
  { day: 0, min: 9 * 60 + 2, label: 'Sun 9:00' }, { day: 0, min: 10 * 60 + 42, label: 'Sun 10:45' },
  { day: 0, min: 12 * 60 + 27, label: 'Sun 12:30' }, { day: 3, min: 18 * 60 + 32, label: 'Wed 6:30' },
];
async function checkYouTube(env, ts) {
  const now = denverClock(ts);
  const c = YT_CHECKS.find(x => x.day === now.day && x.min === now.min);
  if (!c || !env.YOUTUBE_API_KEY) return 'nothing due';
  await env.STATE.delete('yt_search_at'); // allow a fresh search right now
  let st;
  try { st = await youtubeStatus(env, ts); } catch (e) { await notify(`⚠️ ${c.label}: couldn't check YouTube (${String(e.message || e).slice(0, 80)}). Streaming is not affected.`, 'youtube,warning'); return 'error'; }
  if (st.live) return 'live';
  await notify(`⚠️ ${c.label}: YouTube isn't showing the stream yet. The encoders may be fine; check Restream's YouTube destination and the channel's live page.`, 'youtube,warning');
  return 'alerted';
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
  // KTSM comes off at 10:30: after the 9:00 service stops (10:25) and before the 10:45 Go Live (10:35).
  { day: 0, min: 10 * 60 + 30, label: 'Sun 9:00', off: { KTSM }, remove: 'listed' },
  { day: 0, min: 10 * 60 + 40, label: 'Sun 10:45', on: { YouTube: YT, Facebook: FB, Subsplash: SUB } },
  { day: 0, min: 12 * 60 + 25, label: 'Sun 12:30', on: { YouTube: YT, Facebook: FB, Subsplash: SUB } },
  { day: 0, min: 14 * 60 + 10, label: 'Sunday', off: { YouTube: YT, Facebook: FB, Subsplash: SUB, KTSM }, remove: 'all' },
  { day: 3, min: 18 * 60 + 30, label: 'Wed 6:30', on: { YouTube: YT, Facebook: FB, Subsplash: SUB } },
  { day: 3, min: 20 * 60 + 10, label: 'Wednesday', off: { YouTube: YT, Facebook: FB, Subsplash: SUB, KTSM }, remove: 'all' },
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
// After a service: take destinations off the reusable live stream so the ATEM can't broadcast by accident.
// 'all' removes every destination; 'listed' only the ones named in the check. Needs Restream's stream.write.
async function removeDestinations(env, check) {
  const ev = await readEvent(env);
  if (!ev || ev.live || !ev.dests.length) return { removed: [], failed: ev && ev.live ? 'a stream is still in progress' : null };
  const r = await rsGet(env, '/v2/user/channel/all');
  const names = await platformNames(env);
  const chans = Object.fromEntries((Array.isArray(r.body) ? r.body : []).map(c => [String(c.id), { name: c.displayName, platform: names[c.streamingPlatformId] || '' }]));
  const label = c => c ? ((/custom/i.test(c.platform) || !c.platform) ? c.name : c.platform.replace(/^Youtube$/, 'YouTube')) : 'a destination';
  const want = ev.dests.filter(d => check.remove === 'all' || Object.values(check.off).some(m => chans[d.channelId] && m({ ...chans[d.channelId], enabled: true })));
  const t = await accessToken(env), removed = [];
  let failed = null;
  for (const d of want) {
    const res = await fetch(RS_API + '/v2/user/events/' + d.event + '/destinations/' + d.id, { method: 'DELETE', headers: { authorization: 'Bearer ' + t } });
    if (res.status === 204 || res.status === 404) removed.push(label(chans[d.channelId]));
    else { failed = 'Restream said ' + res.status + (res.status === 403 ? ' (the worker needs write permission)' : ''); break; }
  }
  return { removed, failed };
}
async function checkDestinations(env, ts) {
  const now = denverClock(ts);
  const check = DEST_CHECKS.find(c => c.day === now.day && c.min === now.min);
  if (!check || !(await env.STATE.get('restream_tokens'))) return 'nothing due';
  let problems = destProblems(check, await readChannels(env));
  let extra = '';
  if (!problems.length) return 'ok';
  if (check.remove) {
    const res = await removeDestinations(env, check).catch(e => ({ removed: [], failed: String(e.message || e) }));
    problems = destProblems(check, await readChannels(env));
    if (res.removed.length && !problems.length) {
      await notify(`✅ ${check.label} is over: turned off ${res.removed.join(', ')} in Restream.`, 'restream,destinations');
      return 'removed';
    }
    if (res.failed) extra = ` I couldn't turn them off automatically: ${res.failed}.`;
  }
  const msg = check.pre
    ? `⏰ ${check.label} starts in 30 min: ${problems.join(', ')} in Restream. Turn ${problems.length > 1 ? 'them' : 'it'} on before Go Live at ${check.pre}.`
    : check.on
    ? `⚠️ ${check.label}: Restream destination problem: ${problems.join(', ')}. Viewers there can't see the stream.`
    : `⚠️ ${check.label} is over but ${problems.join(', ')} in Restream. Turn ${problems.length > 1 ? 'them' : 'it'} off so the ATEM can't broadcast by accident.${extra}`;
  await notify(msg, 'restream,destinations');
  return 'alerted';
}

// Restart reminders: Ilan restarts the church Mac by hand before each service day. Companion starts with the
// Mac, so its uptime stands in for the Mac's. Reminds if the Mac hasn't restarted in the last 24 hours.
const RESTART_REMINDERS = [
  { day: 3, min: 9 * 60, msg: "🔄 Restart the church Mac before tonight's 6:30 service (it hasn't restarted in {up}). Apple menu → Restart, with \"Reopen windows\" unchecked." },
  { day: 3, min: 15 * 60, msg: '🔄 Reminder: the church Mac still hasn\'t restarted today (up {up}). Tonight\'s service is at 6:30.' },
  { day: 6, min: 21 * 60, msg: "🔄 Restart the church Mac before Sunday's services (it hasn't restarted in {up}). Apple menu → Restart, with \"Reopen windows\" unchecked." },
  { day: 0, min: 7 * 60, msg: '🔄 Reminder: the church Mac still hasn\'t restarted (up {up}). The 9:00 health check is at 8:30.' },
];
function upText(sec) { const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600); return d ? `${d} day${d > 1 ? 's' : ''}${h ? ' ' + h + ' h' : ''}` : `${h} h`; }
async function macUptime(ts) {
  const status = await poll(STATUS_TOPIC);
  for (const m of status.sort((a, b) => b.time - a.time)) {
    try { const j = JSON.parse(m.message); const up = Number(j.comp_up); if (!isNaN(up) && j.t) return up + (ts / 1000 - Number(j.t)); } catch {}
  }
  return null; // no report in 12 h: the dead man's switch already covers that
}
async function checkRestartReminder(ts) {
  const now = denverClock(ts);
  const r = RESTART_REMINDERS.find(x => x.day === now.day && x.min === now.min);
  if (!r) return 'nothing due';
  const up = await macUptime(ts);
  if (up === null || up < 24 * 3600) return 'ok';
  await notify(r.msg.replace('{up}', upText(up)), 'arrows_counterclockwise,restart');
  return 'reminded';
}

export default {
  // Runs every minute: renew the Restream sign-in when needed; heartbeat check every 5 minutes.
  async scheduled(event, env, ctx) {
    NTFY_AUTH = env.NTFY_TOKEN || null;
    const min = new Date(event.scheduledTime || Date.now()).getUTCMinutes();
    const jobs = [];
    if (env.STATE && env.RESTREAM_CLIENT_ID) jobs.push(refreshIfNeeded(env).then(() => checkDestinations(env, event.scheduledTime || Date.now())));
    jobs.push(checkRestartReminder(event.scheduledTime || Date.now()));
    if (env.STATE) jobs.push(checkYouTube(env, event.scheduledTime || Date.now()));
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
    if (path === '/youtube/status') return youtubeRoute(req, env, ctx);
    if (path === '/youtube/test') {
      // One 1-unit call to confirm the key works: reads the channel's public name.
      if (!env.YOUTUBE_API_KEY) return Response.json({ configured: false });
      try { const j = await ytGet(env, 'channels?part=snippet&id=' + YT_CHANNEL); return Response.json({ configured: true, ok: true, channel: j.items && j.items[0] && j.items[0].snippet.title }); }
      catch (e) { return Response.json({ configured: true, ok: false, error: String(e.message || e) }); }
    }
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
