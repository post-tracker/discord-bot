# discord-bot

Discord bot for [developertracker.com](https://developertracker.com).

## What it does now

Polls the public REST API (`GET /games`) on a schedule and announces any
**newly tracked game** to a configured Discord channel:

> 🎮 New game now tracked: **Game Name** — https://developertracker.com/identifier

State (the set of already-seen games) is kept in Redis, so restarts don't
re-announce. On its **first run** against a fresh Redis it silently seeds the
known-games set — it only announces games added *after* it starts.

## Roadmap

The bot connects to the Discord gateway (not just a webhook) so it can grow
into per-game post monitoring, slash commands, etc. Redis keys are namespaced
under `dt:discord:` to leave room for post cursors.

## Configuration (env)

- `DISCORD_BOT_TOKEN` — bot token (required)
- `DISCORD_ANNOUNCE_CHANNEL_ID` — channel to post announcements in (required)
- `REDIS_URL` — Redis connection string (required)
- `API_BASE` — REST API base (default `https://api.developertracker.com`)
- `SITE_BASE` — public site base for links (default `https://developertracker.com`)
- `POLL_SCHEDULE` — cron for polling (default `*/5 * * * *`)

## Run

```
npm ci
node index.js
```

Deploys to GHCR on push to `master`; runs as a container in the stack on edge4.
