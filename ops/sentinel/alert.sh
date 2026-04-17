#!/usr/bin/env bash
# Sentinel alert dispatch.
#
# Sends messages to ntfy.sh, Discord, and healthchecks.io with per-alert-type
# cooldowns and flap detection so you never get paged for the same thing 30 times.
#
# Usage:
#   alert CRITICAL db_down "pokegrails DB unresponsive" "$CONTEXT"
#   alert WARN      disk_high  "/ at 87% used"            "$CONTEXT"
#   alert INFO      recovered  "pokegrails container back up" ""
#   heartbeat                  # ping the dead-man's switch
#
# Exit codes: 0 on success (or suppressed), non-zero only for misconfig.

set -u
# NB: we deliberately do NOT `set -e` here — a flaky ntfy must not stop the watchdog.

: "${SENTINEL_STATE_DIR:=/var/lib/sentinel}"
: "${SENTINEL_COOLDOWN_SEC:=900}"      # 15 min between repeats of the same alert
: "${SENTINEL_FLAP_WINDOW_SEC:=3600}"  # 1 hr
: "${SENTINEL_FLAP_THRESHOLD:=3}"      # 3 alerts in window → suppress until window passes
: "${NTFY_URL:=https://ntfy.sh}"
: "${NTFY_TOPIC:=}"
: "${DISCORD_WEBHOOK_URL:=}"
: "${HEALTHCHECKS_PING_URL:=}"
: "${SENTINEL_HOSTNAME:=$(hostname -s 2>/dev/null || echo host)}"

mkdir -p "$SENTINEL_STATE_DIR" 2>/dev/null || true

_now() { date +%s; }
_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

_state_file() {
  local key="$1"
  # sanitize to [A-Za-z0-9_.-]
  local safe
  safe=$(printf '%s' "$key" | tr -c 'A-Za-z0-9_.-' '_')
  printf '%s/alert.%s.state' "$SENTINEL_STATE_DIR" "$safe"
}

# Records one fire of alert $1 and returns the count in the flap window.
_record_fire() {
  local key="$1"
  local file
  file=$(_state_file "$key")
  local now
  now=$(_now)
  local cutoff=$(( now - SENTINEL_FLAP_WINDOW_SEC ))
  # keep only timestamps newer than cutoff
  local kept=""
  if [ -f "$file" ]; then
    while IFS= read -r ts; do
      [ -z "$ts" ] && continue
      if [ "$ts" -ge "$cutoff" ] 2>/dev/null; then
        kept+="$ts"$'\n'
      fi
    done < "$file"
  fi
  kept+="$now"$'\n'
  printf '%s' "$kept" > "$file"
  printf '%s' "$kept" | grep -c '^[0-9]' || true
}

# Returns 0 if we should send, 1 if suppressed by cooldown/flap.
_should_send() {
  local key="$1"
  local file
  file=$(_state_file "$key")
  if [ ! -f "$file" ]; then
    return 0
  fi
  local last_ts
  last_ts=$(tail -n 1 "$file" 2>/dev/null || true)
  [ -z "$last_ts" ] && return 0
  local now
  now=$(_now)
  local delta=$(( now - last_ts ))
  if [ "$delta" -lt "$SENTINEL_COOLDOWN_SEC" ]; then
    return 1
  fi
  return 0
}

log() {
  # stdout goes to journald via systemd
  printf '[sentinel %s] %s\n' "$(_iso)" "$*"
}

# Emoji + priority mapping for ntfy
_ntfy_priority() {
  case "$1" in
    CRITICAL) echo "urgent" ;;
    WARN)     echo "high" ;;
    INFO)     echo "default" ;;
    *)        echo "default" ;;
  esac
}

_ntfy_tags() {
  case "$1" in
    CRITICAL) echo "rotating_light,boom" ;;
    WARN)     echo "warning" ;;
    INFO)     echo "white_check_mark" ;;
    *)        echo "loudspeaker" ;;
  esac
}

_send_ntfy() {
  local sev="$1" title="$2" body="$3"
  [ -z "$NTFY_TOPIC" ] && return 0
  curl -fsS -m 10 \
    -H "Title: ${title}" \
    -H "Priority: $(_ntfy_priority "$sev")" \
    -H "Tags: $(_ntfy_tags "$sev")" \
    -d "$body" \
    "${NTFY_URL%/}/${NTFY_TOPIC}" >/dev/null 2>&1 \
    && log "ntfy sent: [$sev] $title" \
    || log "ntfy FAILED: [$sev] $title"
}

_send_discord() {
  local sev="$1" title="$2" body="$3"
  [ -z "$DISCORD_WEBHOOK_URL" ] && return 0
  local color
  case "$sev" in
    CRITICAL) color=15548997 ;;  # red
    WARN)     color=16763904 ;;  # amber
    INFO)     color=3066993 ;;   # green
    *)        color=9807270 ;;   # grey
  esac
  # JSON-escape body and title
  local esc_title esc_body
  esc_title=$(printf '%s' "$title" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$title")
  esc_body=$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$body")
  local payload
  payload=$(printf '{"embeds":[{"title":%s,"description":%s,"color":%d,"footer":{"text":"sentinel · %s"}}]}' \
    "$esc_title" "$esc_body" "$color" "$SENTINEL_HOSTNAME")
  curl -fsS -m 10 -H 'Content-Type: application/json' -d "$payload" \
    "$DISCORD_WEBHOOK_URL" >/dev/null 2>&1 \
    && log "discord sent: [$sev] $title" \
    || log "discord FAILED: [$sev] $title"
}

# Public: emit an alert.
# alert SEVERITY KEY TITLE BODY
alert() {
  local sev="${1:-INFO}"
  local key="${2:-generic}"
  local title="${3:-untitled}"
  local body="${4:-}"

  # INFO/recovered alerts bypass cooldown so you always get the "it's back up" ping.
  if [ "$sev" != "INFO" ]; then
    if ! _should_send "$key"; then
      log "suppressed (cooldown): [$sev] $key"
      return 0
    fi
    local count
    count=$(_record_fire "$key")
    if [ "$count" -gt "$SENTINEL_FLAP_THRESHOLD" ]; then
      log "suppressed (flapping ${count}x/hr): [$sev] $key"
      return 0
    fi
  fi

  local tagged_title="[${sev}] ${SENTINEL_HOSTNAME}: ${title}"
  _send_ntfy "$sev" "$tagged_title" "$body"
  _send_discord "$sev" "$tagged_title" "$body"
}

# Public: ping the dead-man's switch.
# Call on every successful watchdog run so healthchecks.io emails you if we stop.
heartbeat() {
  [ -z "$HEALTHCHECKS_PING_URL" ] && return 0
  curl -fsS -m 10 -o /dev/null --retry 3 "$HEALTHCHECKS_PING_URL" 2>/dev/null \
    && log "heartbeat sent" \
    || log "heartbeat FAILED"
}

# Allow direct CLI invocation, e.g. ./alert.sh CRITICAL test "hi" "body"
if [ "${BASH_SOURCE[0]:-}" = "$0" ] || [ -z "${BASH_SOURCE+x}" ]; then
  if [ "${1:-}" = "heartbeat" ]; then
    heartbeat
  elif [ "$#" -ge 3 ]; then
    alert "$@"
  else
    echo "usage: $0 SEVERITY KEY TITLE [BODY]  |  $0 heartbeat" >&2
    exit 2
  fi
fi
