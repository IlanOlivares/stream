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
2. **Connection checks**: whether Companion is connected to the ATEM, OBS and the Spanish OBS.
3. ~~**Heartbeat**~~ Done Nov 10: status posts every 15 minutes (trigger "Status heartbeat"), and immediately when OBS connects or drops.
- ~~**HyperDeck tile**~~ Done Nov 10: Companion reads the HyperDeck Studio 4K Pro (172.16.1.184, status only, no control); tile shows SSD, recording state and time left.
4. **Bitrate chart**: OBS bitrate over the service, from the once-a-minute updates.
5. **Watchdog: alert once per outage** instead of every 30 seconds while the ATEM stream is down (Companion change).
- **Dead man's switch**: a free outside check-in service (e.g. Healthchecks.io). Companion pings it every 15 minutes; if the pings stop (Mac asleep, crashed or offline, or Companion closed) the service alerts Ilan. Higher priority than the bitrate chart.
- **Restream on/off tiles** (optional, Ilan to decide): via Restream's API with the sign-in refreshed by Companion; Ilan pastes the keys himself.
- **Bitrate chart: ATEM too**: check whether Companion's ATEM connection reports streaming bitrate and buffer; add an ATEM line and a buffer-filling warning if so.

### Cleanup (after Wednesday Nov 11, 2026)

6. **Delete the old claude.ai status page** ("Abundant Stream Status") once this page is confirmed working; confirm with Ilan before deleting.
7. **Remove ATEM record on/off** from the 4 Go Live and 4 End triggers (no drive in the ATEM; HyperDeck handles that recording).
8. **OBS: record with the stream encoder** ("Use stream encoder") to halve encoding load; part of the OBS settings review.
9. **Restream Storage housekeeping**: Ilan clears old Wednesday recordings now and then (cap is 50; Claude never deletes uploads).
10. **Companion 5.1.2 update** on the church Mac.
11. **Scheduled OBS restart** on the church Mac (the uptime tile shows how often it's needed).
12. **Docs**: remove VDO.Ninja / virtual camera references and add this week's changes to the runbook and setup instructions.

Not planned: viewer counts.
