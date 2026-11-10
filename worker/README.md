# Abundant Stream worker (Cloudflare)

Runs every minute on Cloudflare's free plan.

- **Restream destinations:** the status page asks `/restream/status` once a minute; the worker reads each destination's on/off from Restream (cached 60 s). The schedule renews the Restream sign-in before it expires; if renewal fails it alerts once. Reconnect at /restream/connect.
- **Restream destination checks:** at Sun 9:00, 10:40, 12:25 and Wed 6:30 alerts if YouTube, Facebook, Subsplash (and KTSM at 9:00) are off; at Sun 10:35 alerts if KTSM is still on; at Sun 2:10 alerts if anything is still on. Silent when all is well.
- **Dead man's switch:** if Companion's status feed goes quiet for 20+ minutes, posts one alert to the phone topic; posts again when it recovers. Stateless (reads the alert topic to avoid repeats).
- Visit the worker's URL to see the current check without sending anything.

