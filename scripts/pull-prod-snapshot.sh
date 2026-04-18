#!/usr/bin/env bash
# Pull a WAL-consistent snapshot of the production SQLite DB, sanitize it,
# and install it at ./data/pokegrails.sqlite so `npm run dev` boots against
# real data.
#
# Usage:
#   scripts/pull-prod-snapshot.sh [--keep-secrets]
#
# Env overrides (configure once in your shell rc or drop in .env.local):
#   POKEGRAILS_SSH_HOST   (default: pokegrails.com)
#   POKEGRAILS_SSH_USER   (default: deploy)
#   POKEGRAILS_SSH_KEY    (default: ~/.ssh/id_ed25519)
#   POKEGRAILS_ADMIN_EMAIL  email kept as admin after sanitize (rest wiped)
#
# What it does:
#   1. SSH to the server
#   2. Run sqlite3 `.backup` inside the app container — this is atomic and
#      safe even while the server is actively writing (it's the same API
#      the nightly `backup` docker service uses)
#   3. docker cp the snapshot out, scp it down
#   4. Unless --keep-secrets is passed, strip:
#        - all users except POKEGRAILS_ADMIN_EMAIL (you), and that one's
#          password_hash is wiped (log in via Google OAuth, or re-register)
#        - all refresh_tokens (force re-login)
#        - all stripe_* columns
#   5. Move the result to ./data/pokegrails.sqlite (backs up any existing
#      local DB first to ./data/pokegrails.sqlite.local-bak-<timestamp>)

set -euo pipefail

KEEP_SECRETS=0
if [ "${1:-}" = "--keep-secrets" ]; then
  KEEP_SECRETS=1
  echo "[snapshot] --keep-secrets: not sanitizing. Do not share this file."
fi

HOST="${POKEGRAILS_SSH_HOST:-pokegrails.com}"
USER="${POKEGRAILS_SSH_USER:-deploy}"
KEY="${POKEGRAILS_SSH_KEY:-$HOME/.ssh/id_ed25519}"
ADMIN_EMAIL="${POKEGRAILS_ADMIN_EMAIL:-}"

if [ ! -f "$KEY" ]; then
  echo "[snapshot] SSH key not found at $KEY"
  echo "           Set POKEGRAILS_SSH_KEY to the right path."
  exit 1
fi

for bin in ssh scp sqlite3 node; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[snapshot] required command not found: $bin"
    [ "$bin" = "sqlite3" ] && echo "           Install with: sudo apt install sqlite3   (or: brew install sqlite)"
    exit 1
  fi
done

if [ "$KEEP_SECRETS" = "0" ] && [ -z "$ADMIN_EMAIL" ]; then
  echo "[snapshot] POKEGRAILS_ADMIN_EMAIL not set — can't decide which user to keep as admin."
  echo "           Either export it (e.g. export POKEGRAILS_ADMIN_EMAIL=you@example.com)"
  echo "           or run with --keep-secrets to skip sanitizing (not recommended)."
  exit 1
fi

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

STAMP="$(date -u +%Y%m%d-%H%M%S)"
REMOTE_SNAPSHOT="/tmp/pokegrails-snapshot-$STAMP.sqlite"

# First-time SSH ergonomics: if the host isn't in known_hosts yet, fetch
# its public key once with ssh-keyscan and pin it. After that, strict host
# key checking is on (so a MITM or swapped server would fail loudly).
KNOWN_HOSTS="$HOME/.ssh/known_hosts"
if ! ssh-keygen -F "$HOST" -f "$KNOWN_HOSTS" >/dev/null 2>&1; then
  echo "[snapshot] first-time connection to $HOST — adding to known_hosts"
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  ssh-keyscan -t ed25519,rsa -T 10 "$HOST" >> "$KNOWN_HOSTS" 2>/dev/null || {
    echo "[snapshot] ssh-keyscan failed — check that $HOST resolves and port 22 is open"
    exit 1
  }
  echo "[snapshot] pinned host key for $HOST"
fi

SSH_OPTS="-i $KEY -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=yes"
SSH="ssh $SSH_OPTS $USER@$HOST"
SCP="scp $SSH_OPTS"

echo "[snapshot] → $USER@$HOST: taking .backup snapshot (WAL-consistent)"
# `docker compose exec -T` reads from stdin, and stdin on the remote side
# is the heredoc itself. Without `< /dev/null` the first exec would
# greedily swallow every subsequent line of this script as sqlite3 SQL
# input, so `docker compose cp` never actually runs. Pinning stdin to
# /dev/null for each exec keeps the heredoc intact for bash to execute.
$SSH bash -s <<REMOTE
set -euo pipefail
cd /opt/pokegrails
docker compose exec -T app sqlite3 /app/data/pokegrails.sqlite ".backup /app/data/snapshot-$STAMP.sqlite" < /dev/null
docker compose cp app:/app/data/snapshot-$STAMP.sqlite $REMOTE_SNAPSHOT
docker compose exec -T app rm -f /app/data/snapshot-$STAMP.sqlite < /dev/null
ls -lh $REMOTE_SNAPSHOT
REMOTE

echo "[snapshot] ← downloading"
$SCP "$USER@$HOST:$REMOTE_SNAPSHOT" "$TMP/snapshot.sqlite"
$SSH "rm -f $REMOTE_SNAPSHOT"

SNAPSHOT="$TMP/snapshot.sqlite"
echo "[snapshot] local size: $(du -h "$SNAPSHOT" | awk '{print $1}')"

if [ "$KEEP_SECRETS" = "0" ]; then
  LOCAL_PW="${POKEGRAILS_LOCAL_PASSWORD:-devdev123}"

  # Safety gate: confirm the admin email actually exists in the prod DB
  # BEFORE we delete all the other users. Without this check, a typo or
  # leftover placeholder (e.g. POKEGRAILS_ADMIN_EMAIL=you@example.com)
  # silently wipes every row and leaves you with User count: 0 and no
  # way to log in. Happened once — not doing that again.
  MATCHES=$(sqlite3 "$SNAPSHOT" "SELECT COUNT(*) FROM users WHERE lower(email) = lower('$ADMIN_EMAIL');")
  if [ "$MATCHES" -eq 0 ]; then
    echo "[snapshot] ERROR: POKEGRAILS_ADMIN_EMAIL='$ADMIN_EMAIL' does not match any user in the prod snapshot."
    echo "           Refusing to sanitize — that would delete every user and leave you locked out."
    echo ""
    echo "           Fix options (pick one):"
    echo "             1. Set POKEGRAILS_ADMIN_EMAIL to your real prod email, then re-run."
    echo "             2. Re-run with --keep-secrets if you want the raw prod DB (not recommended)."
    echo "             3. Keep this snapshot and run 'npm run local:admin' afterwards to mint a"
    echo "                fresh local admin (doesn't need to exist in prod)."
    echo ""
    echo "           (Snapshot file left at $SNAPSHOT — won't be installed.)"
    exit 1
  fi

  echo "[snapshot] sanitizing — keeping $ADMIN_EMAIL ($MATCHES match) as admin, wiping other users & all tokens"
  # Hash the dev password with bcryptjs so it matches auth.ts expectations
  # (auth.ts imports from 'bcryptjs', the pure-JS variant; 'bcrypt' is a
  # different package with a native addon and is NOT a server dep).
  # Runs from apps/server so Node resolves bcryptjs whether npm hoisted it
  # to apps/server/node_modules or to the workspace root node_modules.
  if [ ! -d "$REPO_ROOT/apps/server/node_modules/bcryptjs" ] && [ ! -d "$REPO_ROOT/node_modules/bcryptjs" ]; then
    echo "[snapshot] bcryptjs not found — running npm install first so we can hash the dev password"
    (cd "$REPO_ROOT" && npm install --silent)
  fi
  PW_HASH="$(cd "$REPO_ROOT/apps/server" && PW="$LOCAL_PW" node -e "
    const bcrypt = require('bcryptjs')
    bcrypt.hash(process.env.PW, 12).then(h => process.stdout.write(h))
  ")"
  sqlite3 "$SNAPSHOT" <<SQL
BEGIN;
DELETE FROM users WHERE lower(email) != lower('$ADMIN_EMAIL');
UPDATE users SET password_hash = '$PW_HASH',
                 stripe_customer_id = NULL,
                 stripe_subscription_id = NULL,
                 oauth_id = NULL,
                 role = 'admin';
DELETE FROM refresh_tokens;
COMMIT;
VACUUM;
SQL
  FINAL_COUNT=$(sqlite3 "$SNAPSHOT" 'SELECT COUNT(*) FROM users;')
  if [ "$FINAL_COUNT" -eq 0 ]; then
    echo "[snapshot] ERROR: sanitize finished with 0 users somehow. Aborting install."
    exit 1
  fi
  echo "[snapshot] sanitized. User count: $FINAL_COUNT"
  echo "[snapshot] dev login → email: $ADMIN_EMAIL   password: $LOCAL_PW"
fi

# The dev server runs from apps/server/ (via `npm run dev -w server`), so
# its default DATABASE_PATH resolves to apps/server/data/pokegrails.sqlite.
# We install there. A symlink at the repo root is created for convenience
# (e.g. sqlite3 from the top level, docker-compose local runs).
SERVER_DATA_DIR="$REPO_ROOT/apps/server/data"
LOCAL="$SERVER_DATA_DIR/pokegrails.sqlite"
mkdir -p "$SERVER_DATA_DIR"

if [ -f "$LOCAL" ]; then
  BAK="$LOCAL.local-bak-$STAMP"
  echo "[snapshot] backing up existing local DB → $BAK"
  mv "$LOCAL" "$BAK"
  [ -f "$LOCAL-wal" ] && mv "$LOCAL-wal" "$BAK-wal"
  [ -f "$LOCAL-shm" ] && mv "$LOCAL-shm" "$BAK-shm"
fi

mv "$SNAPSHOT" "$LOCAL"

# Convenience symlink: `./data/pokegrails.sqlite` in the repo root points at
# the real DB. Makes ad-hoc sqlite3 commands and scripts `find`-able.
mkdir -p "$REPO_ROOT/data"
ln -sf "../apps/server/data/pokegrails.sqlite" "$REPO_ROOT/data/pokegrails.sqlite"

CARDS=$(sqlite3 "$LOCAL" 'SELECT COUNT(*) FROM cards;')
SETS=$(sqlite3 "$LOCAL" 'SELECT COUNT(*) FROM sets;')
PH=$(sqlite3 "$LOCAL" 'SELECT COUNT(*) FROM price_history;')
CGH=$(sqlite3 "$LOCAL" "SELECT COUNT(*) FROM sqlite_master WHERE name='card_grade_history';")

echo ""
echo "[snapshot] ✓ installed at apps/server/data/pokegrails.sqlite"
echo "           (symlinked from data/pokegrails.sqlite at repo root)"
echo "           sets=$SETS  cards=$CARDS  price_history_rows=$PH"
if [ "$CGH" = "0" ]; then
  echo "           (card_grade_history table will be created by migrations on first boot)"
fi
echo ""
if [ "$KEEP_SECRETS" = "0" ]; then
  echo "[snapshot] ✓ dev login ready:"
  echo "             email:    $ADMIN_EMAIL"
  echo "             password: ${POKEGRAILS_LOCAL_PASSWORD:-devdev123}"
  echo "             role:     admin"
fi
echo ""
echo "Next: npm run dev"
