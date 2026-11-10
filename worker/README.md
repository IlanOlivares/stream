# Abundant Stream worker (Cloudflare)

Runs every 5 minutes on Cloudflare's free plan.

- **Dead man's switch:** if Companion's status feed goes quiet for 20+ minutes, posts one alert to the phone topic; posts again when it recovers. Stateless (reads the alert topic to avoid repeats).
- Visit the worker's URL to see the current check without sending anything.

Planned: Restream destination status (needs a Restream developer app; secrets go in Cloudflare settings, never in this repo).
