# Sentinel — PokeGrails host watchdog

Sentinel is a three-layer defense-in-depth monitor for the PokeGrails stack.
It is designed to **tell you when something is wrong within 2 minutes**, to
**survive Docker itself dying**, and to **page you via a dead-man's switch**
if the entire server disappears.

## Why three layers

Almost every home-grown monitoring setup eventually discovers the same
humiliating failure: *the monitor died with the thing it was monitoring, and
nobody told you*. Sentinel deliberately separates failure domains:

| Layer | Where it runs | Survives |
|---|---|---|
| `/api/canary` | Inside the Node app (container) | App alive |
| `sentinel.sh` | Host systemd (outside Docker) | Docker/app crashing |
| healthchecks.io ping | External third-party service | Entire server offline |

If the app dies → host watchdog alerts.
If Docker dies → host watchdog alerts (systemd unit still runs).
If the host dies → healthchecks.io notices the missed ping and emails you.
If healthchecks.io dies → well, you're out of pizza but your app is still fine.

## What it checks

Every 2 minutes:

**Host**
- RAM available (warn <500 MB, crit <150 MB)
- Disk used (warn 85%, crit 95%)
- Swap used (warn >50%)
- Load average vs `nproc` (warn 2×, crit 4×)
- Kernel OOM kills in `dmesg` (crit)

**Containers** — each of `pokegrails`, `pokegrails-dev`, `pokegrails-caddy`, `pokegrails-backup`
- Running state (crit if stopped; attempts one `docker restart` before alerting)
- Docker healthcheck status (warn if `unhealthy`)
- Exit code + last 20 log lines included in alert

**App (via `/api/canary`)**
- DB read (`SELECT COUNT FROM cards`)
- DB write (heartbeat upsert — proves WAL/lock is healthy)
- In-memory cache round-trip
- Price snapshot freshness (warn >2h, fail >8h)
- Model freshness (warn >10d, fail >21d)
- Reddit poll freshness (warn >2h, fail >12h)
- Process memory (warn >700 MB RSS, fail >1 GB)
- Event loop responsiveness (warn >150 ms, fail >500 ms)

**TLS certs** — `pokegrails.com` and `dev.pokegrails.com`
- Warn at 14 days to expiry, crit at 5 days (Caddy renews at 30; if we see
  anything under 14 it means renewal is broken)

**Recent log patterns** in prod + dev
- `SIGKILL`, `out of memory`, `heap out of memory`, `FATAL`,
  `ECONNREFUSED`, `ENOSPC`, `EACCES`, `UnhandledPromiseRejection`

## How you get alerted

Three channels, any subset of which you can enable. **Pick at least ntfy + healthchecks.** The combo costs nothing and covers ~99% of failure modes.

### 1. ntfy.sh — instant mobile push (strongly recommended)

Free, open-source, no signup. Install the [ntfy Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) or [iOS app](https://apps.apple.com/us/app/ntfy/id1625396347), subscribe to a secret topic name, and Sentinel will push notifications to your phone within seconds of a failure.

**Setup:**

```bash
# Generate a secret topic name (anyone with this name can read your alerts)
openssl rand -hex 12
# → e.g. 3f9acb412d7e0081a4f3902b
# Your topic becomes: pokegrails-sentinel-3f9acb412d7e0081a4f3902b
```

1. Install the ntfy app on your phone.
2. In the app, tap **+** → Subscribe → enter the topic name → Subscribe.
3. On the server, edit `/etc/sentinel/config.env`:
   ```
   NTFY_TOPIC=pokegrails-sentinel-3f9acb412d7e0081a4f3902b
   ```
4. Fire a test: `sudo -u sentinel /opt/sentinel/alert.sh INFO test 'hello' 'test from server'`

### 2. healthchecks.io — dead-man's switch (strongly recommended)

Free tier: 20 checks. The *absence* of a heartbeat is the alert. If Sentinel
stops pinging for 10 minutes, HC emails you. This is your guarantee against
"the whole server is dead."

**Setup:**

1. Sign up at [healthchecks.io](https://healthchecks.io).
2. Create a new check:
   - Name: `PokeGrails Sentinel`
   - Schedule: **Period 10 minutes, grace 5 minutes** (Sentinel runs every 2 min, so this is forgiving)
3. Copy the **Ping URL** (looks like `https://hc-ping.com/3f9a-...`).
4. In `/etc/sentinel/config.env`:
   ```
   HEALTHCHECKS_PING_URL=https://hc-ping.com/3f9a-...
   ```
5. Add Email + (optionally) SMS integrations in HC settings so you actually get notified.

Sentinel only pings healthchecks on a fully clean run. If there's a CRITICAL issue, the host watchdog hits ntfy *and* the HC ping is intentionally skipped — so your check goes red on HC too, giving you a second signal.

### 3. Discord webhook — audit trail (optional)

Nice for keeping a visible history of alerts in a channel. In Discord:
Server Settings → Integrations → Webhooks → New Webhook → Copy URL.

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

## Installation

On the server (as a user who has sudo):

```bash
cd /opt/pokegrails          # wherever your repo is checked out
git pull
sudo bash ops/sentinel/install.sh
# Then edit /etc/sentinel/config.env and fill in NTFY_TOPIC + HEALTHCHECKS_PING_URL
sudo systemctl list-timers sentinel.timer  # confirm it will fire
```

First run:

```bash
sudo -u sentinel /opt/sentinel/sentinel.sh    # runs once, logs to stdout
sudo journalctl -u sentinel -n 50 --no-pager  # subsequent systemd runs
```

## Verifying it works

Fire a deliberate test alert end-to-end:

```bash
sudo -u sentinel /opt/sentinel/alert.sh INFO test 'sentinel hello' 'If you can see this, the alert pipeline is working.'
```

You should get a push on your phone via ntfy within seconds. If you set up Discord, it shows up there too. healthchecks.io is heartbeat-only — its signal is silence, so you won't see anything from a test alert.

Force a canary failure (temporarily, for testing):

```bash
# Stop the dev container and watch
docker stop pokegrails-dev
sleep 130  # wait 2min + a little
sudo journalctl -u sentinel -n 100 --no-pager | grep -E 'container_down|recovered'
# You should see a "container_down" alert followed (within the next run) by a
# "recovered" alert as Sentinel restarts the container itself.
```

## Architecture

```
 ┌──────────────────────────────────────────────────────────────┐
 │ Host OS                                                     │
 │                                                              │
 │  systemd.timer ──2min──▶ sentinel.service (one-shot)        │
 │                              │                               │
 │                              ▼                               │
 │   /opt/sentinel/sentinel.sh                                  │
 │   ├── check host resources (RAM, disk, load, OOM)           │
 │   ├── docker inspect each container                         │
 │   │     └── self-heal: docker restart (once) if down        │
 │   ├── curl https://localhost /api/canary  (prod + dev)      │
 │   ├── check TLS cert expiry                                 │
 │   ├── scan docker logs for red-flag patterns                │
 │   └── on clean run → curl hc-ping.com/<uuid>                │
 │                                                              │
 │  ┌──────── Docker ────────┐                                  │
 │  │  pokegrails (prod)     │                                  │
 │  │  pokegrails-dev        │    /api/canary exercises:        │
 │  │  pokegrails-caddy      │    DB r/w, cache, freshness,     │
 │  │  pokegrails-backup     │    memory, event loop            │
 │  └────────────────────────┘                                  │
 └──────────────────────────────────────────────────────────────┘
              │
              │  alerts                  heartbeat (every clean run)
              ▼                                ▼
       ┌──────────────┐                 ┌────────────────────┐
       │   ntfy.sh    │                 │  healthchecks.io   │
       │ (push phone) │                 │ (silence = alarm)  │
       └──────────────┘                 └────────────────────┘
```

## Runbook — what to do when you get an alert

| Alert | Likely cause | First action |
|---|---|---|
| `host_mem_critical` | OOM thrashing (we saw this before) | `ssh` in, check `free -h`, `docker stats` — kill the greediest container |
| `host_disk_critical` | Docker image bloat or log rotation failing | `docker system df`, `docker system prune -af --volumes` (careful!) |
| `host_load_critical` | CPU-bound cron job or infinite loop | `docker stats`, `docker top pokegrails` |
| `host_oom_kill` | Kernel killed a process | `dmesg -T | grep -i kill` to find victim; add swap or memory limits |
| `container_down_*` | App crash, OOM inside container, bad deploy | Sentinel already tried `docker restart`. Check `docker logs --tail 100 NAME` |
| `container_unhealthy_*` | App alive but `/api/health` not responding | Check if it's a slow model run (`/api/canary` event_loop check) or a stuck request |
| `canary_critical_*` | 503 from deep health endpoint | Body of alert contains which check failed — DB, cache, or freshness |
| `canary_degraded_*` | Non-fatal but worth attention | Usually stale model or Reddit poll — fix the upstream job |
| `tls_expiring_*` | Caddy ACME renewal stuck | `docker logs pokegrails-caddy | grep -i acme` — often DNS or CA rate limit |
| `log_redflag_*` | Spotted concerning log line | Alert body shows the exact lines — most common is `SIGKILL` = OOM |

## Tuning noise

If Sentinel is too chatty:
- Raise `SENTINEL_COOLDOWN_SEC` (default 900 = 15 min per key)
- Lower `SENTINEL_FLAP_THRESHOLD` (default 3/hr) to suppress sooner
- Comment out a container from `SENTINEL_CONTAINERS` (e.g. if dev is expected to flap)

If Sentinel is too quiet:
- Lower `SENTINEL_MEM_WARN_AVAIL_MB` / `SENTINEL_DISK_WARN_PCT`
- Add canary URLs or TLS hosts to the lists

All thresholds live in `/etc/sentinel/config.env` — edit, save, and the next run (<2 min later) picks them up. No daemon to reload.

## Security notes

- Runs as a dedicated `sentinel` system user — **not** root, **not** your deploy user.
- Member of the `docker` group (read-only inspect + targeted `docker restart`).
- Systemd unit hardened: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, minimal capabilities (`CAP_SYSLOG` for `dmesg` only).
- Config file `/etc/sentinel/config.env` is mode `0640 root:sentinel` — webhooks and ntfy topics are readable only by root and sentinel.
- `/api/canary` is public but returns no secrets and is rate-limited by the existing `/api` limiter.

## Uninstall

```bash
sudo bash ops/sentinel/uninstall.sh          # keeps config + state
sudo bash ops/sentinel/uninstall.sh --purge  # removes everything
```
