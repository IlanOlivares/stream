# Abundant Church — Stream Status

Public status page for Abundant Church's livestreams, served by GitHub Pages.

- **Live status** comes from Companion, which posts a small JSON status to ntfy.sh (`abundant-status-m4p8w2`) once a minute while a service is live and whenever a service starts or stops.
- **Alerts** are the same Companion messages sent to phones (`abundant-stream-k7x2q9`).
- **Prep checklist** comes from `prep.json`, updated after each weekly setup run.

No stream keys or passwords are stored here.

## Features

- On-air badge, live status tiles (ATEM, OBS backup, OBS recording, Spanish) with a color key
- "Now playing" header during services: message title, time live, scheduled end, auto-stop countdown
- Run sheet for the current or next service, checked off from Companion alerts and the clock
- Next-service countdown, quick links (this week's outline and Spanish stream, plus channels), alerts feed, prep checklist
- Phone layout (2×2 tiles) and home-screen icon ("Stream")

## Pending (after Wednesday Nov 11, 2026)

1. ~~**OBS health**~~ Done Nov 10: Equipment tiles show OBS uptime, CPU, RAM, fps, disk and skipped frames, plus a "restart suggested" flag.
2. ~~**Connection checks**~~ Done Nov 10: ATEM, OBS and Spanish tiles show NOT CONNECTED / MAC OFF.
3. ~~**Heartbeat**~~ Done Nov 10: status posts every 15 minutes (trigger "Status heartbeat"), and immediately when OBS connects or drops.
- ~~**HyperDeck tile**~~ Done Nov 10: Companion reads the HyperDeck Studio 4K Pro (172.16.1.184, status only, no control); tile shows SSD, recording state and time left.
4. ~~**Bitrate chart**~~ Done Nov 10: ATEM + OBS upload rate (Mbps, last 150 min) with ATEM buffer warning. Verify on Wednesday that the ATEM's "MB/s" value really is megabytes (chart multiplies by 8).
- ~~**Agreed Nov 10 Companion changes**~~ Done Nov 10 (moved up from Thursday): Watchdog now alerts once per outage (after ~1 min) for ATEM and for OBS (disconnected or not recording), with recovery messages (tested); Wed Wrap-up treats a powered-off Spanish Mac as stopped; Space check at each Health Check time; HyperDeck recording nudge 10 min in (verify its "Record" status text on Wednesday); Sun 9:00 KTSM reminder removed (worker checks at 10:35).
- ~~**Restream destination checks**~~ Done Nov 10 in the worker (alerts need the ntfy paid plan; the free tier's shared daily quota blocks Cloudflare).
5. ~~**Watchdog: alert once per outage**~~ Done Nov 10.
- ~~**Cloud worker**~~ Done Nov 10: Cloudflare worker `abundant-stream` (code in `worker/`). Dead man's switch live (test with a real 25-min outage after Wednesday). Restream destination tiles live on the status page. Optional later: confirm YouTube is actually live.

### Cleanup (after Wednesday Nov 11, 2026)

6. ~~**Delete the old claude.ai status page**~~ Done Nov 10 (Ilan confirmed).
7. ~~**Remove ATEM record on/off**~~ Done Nov 10 from all 4 Go Live and 4 End triggers.
8. **OBS settings review** done Nov 10. To change (Ilan, on the church Mac): Settings → Output → Recording → Video Encoder = "(Use stream encoder)" (recording is already identical: Apple VT H.264, CBR 6000). Nov 8 crash: OBS had run 2.7 days and aborted in Apple's OpenGL/Metal driver as the virtual camera started (since removed) → supports a daily clean OBS restart (item 12).
9. **Restream Storage housekeeping**: checked Nov 10: 98% free, uploads 1/50 (Nov 4). Ilan clears old Wednesday uploads now and then; Claude never deletes uploads.
10. ~~**Merge status triggers**~~ Done Nov 10: heartbeat trigger also fires when service_live changes (with a 1 s wait so it posts the new value); "on start/stop" trigger deleted.
11. **Companion 5.1.2 update** on the church Mac.
12. **Scheduled OBS restart** on the church Mac (the uptime tile shows how often it's needed).
13. ~~**Docs**~~ Done Nov 10: runbook has Alerts and checks + Status page and cloud worker sections; VDO.Ninja material removed; Companion connections and trigger pattern updated. Re-touch after the remaining cleanup items.

Not planned: viewer counts.
