#!/usr/bin/env bash
# Sentinel — PokeGrails host watchdog.
#
# Runs on the host OS (outside Docker), driven by a systemd timer every 2 min.
# Performs three classes of check:
#
#   1. HOST           — RAM, disk, swap, load, OOM kills in dmesg
#   2. CONTAINERS     — every compose service: running + healthy
#   3. APP            — /api/canary on prod + dev; TLS cert expiry
#
# Runs recovery actions (single docker restart) before alerting for transient
# failures. Sends a heartbeat to healthchecks.io on every successful run so a
# total outage still pages you via the dead-man's switch.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load config — thresholds + secrets
if [ -f /etc/sentinel/config.env ]; then
  # shellcheck disable=SC1091
  source /etc/sentinel/config.env
elif [ -f "$SCRIPT_DIR/config.env" ]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/config.env"
fi

# shellcheck source=./alert.sh
source "$SCRIPT_DIR/alert.sh"

# ---------------- defaults (override in /etc/sentinel/config.env) ----------------
: "${SENTINEL_CONTAINERS:=pokegrails pokegrails-dev pokegrails-caddy pokegrails-backup}"
: "${SENTINEL_CANARY_URLS:=https://pokegrails.com/api/canary https://dev.pokegrails.com/api/canary}"
: "${SENTINEL_TLS_HOSTS:=pokegrails.com dev.pokegrails.com}"
: "${SENTINEL_TLS_WARN_DAYS:=14}"
: "${SENTINEL_TLS_FAIL_DAYS:=5}"
: "${SENTINEL_DISK_WARN_PCT:=85}"
: "${SENTINEL_DISK_FAIL_PCT:=95}"
: "${SENTINEL_MEM_WARN_AVAIL_MB:=500}"
: "${SENTINEL_MEM_FAIL_AVAIL_MB:=150}"
: "${SENTINEL_SWAP_WARN_PCT:=50}"
: "${SENTINEL_LOAD_WARN_MULT:=2}"   # warn if load > nproc * mult
: "${SENTINEL_LOAD_FAIL_MULT:=4}"
: "${SENTINEL_LOG_LOOKBACK:=5m}"
: "${SENTINEL_SELF_HEAL:=1}"        # set to 0 to disable docker restart attempts
: "${SENTINEL_LOG_DIR:=/var/log/sentinel}"
: "${SENTINEL_EVENTS_JSON:=$SENTINEL_STATE_DIR/events.json}"

mkdir -p "$SENTINEL_STATE_DIR" "$SENTINEL_LOG_DIR" 2>/dev/null || true

# ---------------- helpers ----------------
warn_count=0
fail_count=0

record_event() {
  # Tiny ring buffer (last 200 entries) for a future status page
  local sev="$1" name="$2" detail="$3"
  local line
  line=$(printf '{"ts":"%s","sev":"%s","name":"%s","detail":"%s"}' \
    "$(_iso)" "$sev" "$name" "$(printf '%s' "$detail" | sed 's/"/\\"/g' | tr -d '\n')")
  {
    echo "$line"
    [ -f "$SENTINEL_EVENTS_JSON" ] && head -n 199 "$SENTINEL_EVENTS_JSON"
  } > "${SENTINEL_EVENTS_JSON}.tmp" && mv "${SENTINEL_EVENTS_JSON}.tmp" "$SENTINEL_EVENTS_JSON"
}

raise() {
  # raise SEVERITY KEY TITLE BODY → emits alert + counts severity
  local sev="$1"
  case "$sev" in
    CRITICAL) fail_count=$((fail_count+1)) ;;
    WARN)     warn_count=$((warn_count+1)) ;;
  esac
  record_event "$sev" "$2" "$3"
  alert "$@"
}

human_mem_mb() {
  # Parse `free -m` second line: total used free shared buffers available
  awk '/^Mem:/ { print $7 }' <(free -m) 2>/dev/null || echo 0
}
human_swap_pct() {
  awk '/^Swap:/ { if ($2==0) print 0; else print int($3*100/$2) }' <(free -m) 2>/dev/null || echo 0
}

# ---------------- checks ----------------

check_host_resources() {
  # Memory
  local avail_mb
  avail_mb=$(human_mem_mb)
  if [ "$avail_mb" -lt "$SENTINEL_MEM_FAIL_AVAIL_MB" ]; then
    raise CRITICAL host_mem_critical "host RAM critical" \
      "Only ${avail_mb}MB available (threshold: ${SENTINEL_MEM_FAIL_AVAIL_MB}MB). $(free -h | head -3)"
  elif [ "$avail_mb" -lt "$SENTINEL_MEM_WARN_AVAIL_MB" ]; then
    raise WARN host_mem_low "host RAM low" \
      "${avail_mb}MB available. $(free -h | head -3)"
  fi

  # Swap
  local swap_pct
  swap_pct=$(human_swap_pct)
  if [ "$swap_pct" -gt "$SENTINEL_SWAP_WARN_PCT" ]; then
    raise WARN host_swap_high "swap usage elevated" \
      "Swap ${swap_pct}% used. $(free -h | head -3)"
  fi

  # Disk
  local disk_pct
  disk_pct=$(df --output=pcent / 2>/dev/null | tail -n1 | tr -dc '0-9' || echo 0)
  if [ "$disk_pct" -ge "$SENTINEL_DISK_FAIL_PCT" ]; then
    raise CRITICAL host_disk_critical "disk nearly full" \
      "/ at ${disk_pct}% used. $(df -h / | tail -n1)"
  elif [ "$disk_pct" -ge "$SENTINEL_DISK_WARN_PCT" ]; then
    raise WARN host_disk_high "disk filling up" \
      "/ at ${disk_pct}% used. $(df -h / | tail -n1)"
  fi

  # Load
  local nproc load1 load1_int
  nproc=$(nproc 2>/dev/null || echo 1)
  load1=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)
  load1_int=$(printf '%.0f' "$load1")
  local warn_at=$(( nproc * SENTINEL_LOAD_WARN_MULT ))
  local fail_at=$(( nproc * SENTINEL_LOAD_FAIL_MULT ))
  if [ "$load1_int" -ge "$fail_at" ]; then
    raise CRITICAL host_load_critical "load average extreme" \
      "load1=${load1} on ${nproc} cores. $(uptime)"
  elif [ "$load1_int" -ge "$warn_at" ]; then
    raise WARN host_load_high "load average high" \
      "load1=${load1} on ${nproc} cores. $(uptime)"
  fi

  # OOM kills in recent kernel log
  local oom_hits=""
  if command -v dmesg >/dev/null 2>&1; then
    oom_hits=$(dmesg -T --since "$SENTINEL_LOG_LOOKBACK" 2>/dev/null | grep -iE 'killed process|out of memory' | tail -5 || true)
  fi
  if [ -n "$oom_hits" ]; then
    raise CRITICAL host_oom_kill "kernel OOM killer fired" \
      "$oom_hits"
  fi
}

check_container() {
  local name="$1"
  local running health exit_code restarts started
  running=$(docker inspect -f '{{.State.Running}}'  "$name" 2>/dev/null || echo missing)
  health=$(docker  inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || echo missing)
  exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$name" 2>/dev/null || echo ?)
  restarts=$(docker  inspect -f '{{.RestartCount}}'   "$name" 2>/dev/null || echo 0)
  started=$(docker   inspect -f '{{.State.StartedAt}}' "$name" 2>/dev/null || echo "")

  if [ "$running" = "missing" ]; then
    raise CRITICAL "container_missing_${name}" "container ${name} not found" \
      "docker inspect returned nothing — was the container removed?"
    return
  fi

  # Not running → try one self-heal, then alert on failure
  if [ "$running" != "true" ]; then
    local last_log
    last_log=$(docker logs --tail 30 "$name" 2>&1 | tail -20)
    if [ "$SENTINEL_SELF_HEAL" = "1" ] && [ "$restarts" -lt 5 ]; then
      log "attempting self-heal: docker restart $name"
      if docker restart "$name" >/dev/null 2>&1; then
        sleep 8
        local now_running
        now_running=$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo false)
        if [ "$now_running" = "true" ]; then
          raise INFO "container_recovered_${name}" "recovered ${name}" \
            "Container was stopped (exit ${exit_code}, ${restarts} prior restarts). Sentinel restarted it successfully."
          return
        fi
      fi
    fi
    raise CRITICAL "container_down_${name}" "container ${name} DOWN" \
      "State: ${running}, exit=${exit_code}, restarts=${restarts}
Last logs:
${last_log}"
    return
  fi

  # Running but unhealthy
  if [ "$health" = "unhealthy" ]; then
    local last_log
    last_log=$(docker logs --tail 20 "$name" 2>&1 | tail -15)
    raise WARN "container_unhealthy_${name}" "container ${name} unhealthy" \
      "Running but healthcheck failing. Restarts: ${restarts}
Last logs:
${last_log}"
    return
  fi
}

check_containers() {
  if ! command -v docker >/dev/null 2>&1; then
    raise CRITICAL docker_missing "docker CLI not found on host" "Install Docker or fix PATH."
    return
  fi
  for c in $SENTINEL_CONTAINERS; do
    check_container "$c"
  done
}

check_canary() {
  local url="$1"
  local tmp
  tmp=$(mktemp)
  local http_code
  http_code=$(curl -sk -o "$tmp" -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)
  local body
  body=$(tr -d '\r' < "$tmp" | head -c 2000)
  rm -f "$tmp"

  local label
  label=$(printf '%s' "$url" | sed -E 's#https?://([^/]+).*#\1#')

  if [ "$http_code" = "000" ]; then
    raise CRITICAL "canary_unreachable_${label}" "canary unreachable: ${label}" \
      "No HTTP response from ${url} within 10s."
    return
  fi
  if [ "$http_code" = "503" ]; then
    raise CRITICAL "canary_critical_${label}" "canary CRITICAL: ${label}" \
      "HTTP 503 from ${url}. Body:
${body}"
    return
  fi
  if [ "$http_code" != "200" ]; then
    raise WARN "canary_${http_code}_${label}" "canary HTTP ${http_code}: ${label}" \
      "${url} returned ${http_code}. Body:
${body}"
    return
  fi

  # 200 — parse status field without requiring jq
  local status
  status=$(printf '%s' "$body" | grep -oE '"status":"[^"]+"' | head -n1 | sed 's/.*"status":"\([^"]*\)".*/\1/')
  case "$status" in
    ok)       ;;  # quiet success
    degraded) raise WARN "canary_degraded_${label}" "canary degraded: ${label}" "Body:
${body}" ;;
    *)        raise WARN "canary_unparsable_${label}" "canary response unparsable: ${label}" "${body:0:500}" ;;
  esac
}

check_canaries() {
  for u in $SENTINEL_CANARY_URLS; do
    check_canary "$u"
  done
}

check_tls() {
  local host="$1"
  if ! command -v openssl >/dev/null 2>&1; then return; fi
  # openssl s_client is noisy; redirect stderr
  local not_after_raw not_after days_left
  not_after_raw=$(printf '' | timeout 8 openssl s_client -connect "${host}:443" -servername "$host" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null | head -n1)
  not_after=$(printf '%s' "$not_after_raw" | sed 's/^notAfter=//')
  if [ -z "$not_after" ]; then
    raise WARN "tls_unreadable_${host}" "TLS cert unreadable: ${host}" \
      "Could not read x509 notAfter from openssl s_client."
    return
  fi
  local not_after_epoch now_epoch
  not_after_epoch=$(date -d "$not_after" +%s 2>/dev/null || echo 0)
  now_epoch=$(date +%s)
  if [ "$not_after_epoch" -eq 0 ]; then return; fi
  days_left=$(( (not_after_epoch - now_epoch) / 86400 ))

  if [ "$days_left" -le "$SENTINEL_TLS_FAIL_DAYS" ]; then
    raise CRITICAL "tls_expiring_${host}" "TLS cert expiring soon: ${host}" \
      "${days_left} days until expiry (${not_after}). Caddy renews at 30 days — something is blocking renewal."
  elif [ "$days_left" -le "$SENTINEL_TLS_WARN_DAYS" ]; then
    raise WARN "tls_expiring_${host}" "TLS cert expiring soon: ${host}" \
      "${days_left} days until expiry (${not_after})."
  fi
}

check_tls_all() {
  for h in $SENTINEL_TLS_HOSTS; do
    check_tls "$h"
  done
}

check_log_patterns() {
  # Look at the app containers' very recent logs for red flags.
  # "missed execution" is intentionally NOT in the pattern — we already catch
  # symptomatic issues via canary/load checks and node-cron logs a lot of them
  # during normal heavy model runs.
  local patterns='SIGKILL|ENOSPC|EACCES|ECONNREFUSED|FATAL|UnhandledPromiseRejection|out of memory|heap out of memory'
  for c in pokegrails pokegrails-dev; do
    local hits
    hits=$(docker logs --since "$SENTINEL_LOG_LOOKBACK" "$c" 2>&1 \
           | grep -iE "$patterns" \
           | tail -5 || true)
    if [ -n "$hits" ]; then
      raise WARN "log_redflag_${c}" "red-flag log lines in ${c}" \
        "Last ${SENTINEL_LOG_LOOKBACK}:
${hits}"
    fi
  done
}

# ---------------- main ----------------
main() {
  log "run start · host=$SENTINEL_HOSTNAME"
  check_host_resources
  check_containers
  check_canaries
  check_tls_all
  check_log_patterns

  log "run done · warn=${warn_count} fail=${fail_count}"

  # Only ping the dead-man's switch if we completed without a critical error.
  # (A critical issue should be visible anyway via ntfy; we don't want HC to
  # go green while the server is melting.)
  if [ "$fail_count" -eq 0 ]; then
    heartbeat
  fi
}

main "$@"
