// Abundant Stream cloud worker.
// Job 1: dead man's switch. Companion posts status to ntfy at least every 15 minutes.
// If nothing arrives for 20+ minutes, alert Ilan's phone once; when status resumes, say so.
// Stateless: it reads the alert topic to know whether it already sent the "down" alert.

const NTFY = 'https://ntfy.sh/';
const STATUS_TOPIC = 'abundant-status-m4p8w2';
const ALERT_TOPIC = 'abundant-stream-k7x2q9';
const SILENT_MIN = 20;
const TZ = 'America/Denver';

async function poll(topic) {
  const res = await fetch(`${NTFY}${topic}/json?poll=1&since=12h`);
  if (!res.ok) throw new Error(`ntfy ${topic} ${res.status}`);
  return (await res.text()).split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(m => m && m.event === 'message');
}

function clock(ts) {
  return new Date(ts * 1000).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
}

async function notify(message, tags) {
  await fetch(NTFY + ALERT_TOPIC, { method: 'POST', body: message, headers: { Tags: tags } });
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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkHeartbeat(false));
  },
  // Visiting the worker's URL shows the current check without sending anything.
  async fetch() {
    try { return Response.json(await checkHeartbeat(true)); }
    catch (e) { return Response.json({ error: String(e) }, { status: 502 }); }
  },
};
