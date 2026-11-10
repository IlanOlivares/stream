# Abundant Stream worker (Cloudflare)

Runs every minute on Cloudflare's free plan.

- **Restream destinations:** every minute during service windows (Sun 8:00-2:30, Wed 5:30-8:30, Sat 4:30-7:00), every 15 minutes otherwise, posts each destination's on/off to ntfy topic abundant-restream-jg00ai for the status page. If the Restream sign-in breaks, alerts once; reconnect at /restream/connect.
- **Dead man's switch:** if Companion's status feed goes quiet for 20+ minutes, posts one alert to the phone topic; posts again when it recovers. Stateless (reads the alert topic to avoid repeats).
- Visit the worker's URL to see the current check without sending anything.

