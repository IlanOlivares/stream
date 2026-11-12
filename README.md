# Abundant Church — Stream Status

Public status page for Abundant Church's livestreams, served by GitHub Pages at
https://ilanolivares.github.io/stream/. The full runbook (alerts, schedule, emergency card, change rules)
lives in the "Abundant Livestream Runbook" doc.

## What's here

- `index.html`: the status page. It reads:
  - Companion's status reports from ntfy (`abundant-status-m4p8w2`): once a minute during a service, every
    15 minutes otherwise.
  - Alerts from ntfy (`abundant-stream-k7x2q9`), the same messages sent to the phone.
  - Restream destinations, YouTube live status and recent-service history from the cloud worker.
  - `prep.json`, the week's services, updated after each weekly setup run.
- `worker/`: the Cloudflare worker (see `worker/README.md`). Pushing to `main` deploys it.

Both ntfy topics are reserved: anyone can read, only the owner's account can post.
No stream keys or passwords are stored in this repo.

## Service times live in four places

A time change means updating all four: Companion's triggers (the real schedule), `worker/src/index.js`
(`SERVICES`, `DEST_CHECKS`, `YT_WINDOWS`, `YT_CHECKS`, `RESTART_REMINDERS`), `index.html` (`SERVICES`), and the
Watch & Connect block on the church website. For a one-off day without a service, add the date to the worker's
`SKIP_DATES` and pause Companion's triggers for that day.
