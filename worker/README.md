# Abundant Stream worker (Cloudflare, free plan)

Runs every minute. It watches, alerts and turns Restream destinations off. It never starts or stops the stream.

- **Missed-report alert:** if Companion's status goes quiet for 20+ minutes, one alert; another when it recovers.
- **Emergency phone call:** during a service, ntfy calls the owner if both encoders are off for 3+ minutes, the
  church Mac sends nothing for 5+ minutes, or the service never went live. Once per service.
- **Restream destinations:** alert 30 minutes before a service and at service start if a needed destination is
  off. After services it turns destinations off (KTSM from 10:27 Sunday; everything at 2:10 pm Sunday and
  8:10 pm Wednesday), retrying for a few minutes because Restream refuses changes while a stream is in progress.
  Scheduled events such as the Saturday replay are left alone.
- **YouTube:** two minutes after each Live Check, alerts if the English channel (and, when there is one, the
  week's Spanish stream) isn't live. Only asks YouTube during service windows.
- **Restart reminder:** Wednesday 9:00 am and Saturday 9:00 pm if the church Mac hasn't restarted in 24 hours.
- **Service history:** a summary 10 minutes after each service, shown on the status page.
- `SKIP_DATES` switches every check off for a listed date.

Routes: `/restream/status`, `/youtube/status`, `/history` (read by the status page); `/restream/test`,
`/youtube/test`, `/ntfy-check`, `/` (diagnostics, change nothing); `/restream/connect` (only works while the
worker has no working Restream sign-in).

Secrets (Cloudflare → Settings → Variables and Secrets): `RESTREAM_CLIENT_ID`, `RESTREAM_CLIENT_SECRET`,
`NTFY_TOKEN`, `YOUTUBE_API_KEY`. State is kept in the `STATE` KV namespace.
