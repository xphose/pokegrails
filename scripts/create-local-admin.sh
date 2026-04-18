#!/usr/bin/env bash
# Create (or reset) an admin account in the local dev SQLite DB.
#
# Idempotent: if the email already exists the script updates its password
# + role + username in place instead of failing on the UNIQUE constraint.
#
# Usage:
#   scripts/create-local-admin.sh
#
# Env overrides:
#   POKEGRAILS_LOCAL_ADMIN_EMAIL      (default: admin@local.dev)
#   POKEGRAILS_LOCAL_ADMIN_USERNAME   (default: localadmin)
#   POKEGRAILS_LOCAL_PASSWORD         (default: devdev123; must be ≥ 8 chars)
#   POKEGRAILS_LOCAL_DB               (default: apps/server/data/pokegrails.sqlite)

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
EMAIL="${POKEGRAILS_LOCAL_ADMIN_EMAIL:-admin@local.dev}"
USERNAME="${POKEGRAILS_LOCAL_ADMIN_USERNAME:-localadmin}"
PASSWORD="${POKEGRAILS_LOCAL_PASSWORD:-devdev123}"
DB="${POKEGRAILS_LOCAL_DB:-$REPO_ROOT/apps/server/data/pokegrails.sqlite}"

if [ ${#PASSWORD} -lt 8 ]; then
  echo "[create-local-admin] POKEGRAILS_LOCAL_PASSWORD must be at least 8 characters."
  exit 1
fi

if [ ! -f "$DB" ]; then
  echo "[create-local-admin] local DB not found at $DB"
  echo "                     Run 'npm run dev:prod-data' or 'npm run snapshot' first,"
  echo "                     or point POKEGRAILS_LOCAL_DB at your dev DB."
  exit 1
fi

for bin in sqlite3 node; do
  command -v "$bin" >/dev/null 2>&1 || { echo "[create-local-admin] missing binary: $bin"; exit 1; }
done

# bcryptjs is the same hashing lib auth.ts uses (pure JS, no native addon).
if [ ! -d "$REPO_ROOT/apps/server/node_modules/bcryptjs" ] && [ ! -d "$REPO_ROOT/node_modules/bcryptjs" ]; then
  echo "[create-local-admin] bcryptjs not installed — running npm install"
  (cd "$REPO_ROOT" && npm install --silent)
fi

PW_HASH="$(cd "$REPO_ROOT/apps/server" && PW="$PASSWORD" node -e "
  const bcrypt = require('bcryptjs')
  bcrypt.hash(process.env.PW, 12).then(h => process.stdout.write(h))
")"

# SQL-escape single quotes defensively (emails/usernames shouldn't contain
# them in practice, but we don't want to rely on input sanitization here).
esc() { printf "%s" "$1" | sed "s/'/''/g"; }
EMAIL_SQL="$(esc "$EMAIL")"
USERNAME_SQL="$(esc "$USERNAME")"
HASH_SQL="$(esc "$PW_HASH")"

# INSERT ... ON CONFLICT(email) DO UPDATE makes this a single idempotent
# operation. We don't upsert on username because if the username is taken
# by a different email we want to hear about it (UNIQUE constraint fires).
sqlite3 "$DB" <<SQL
INSERT INTO users (username, email, password_hash, role)
VALUES ('$USERNAME_SQL', '$EMAIL_SQL', '$HASH_SQL', 'admin')
ON CONFLICT(email) DO UPDATE SET
  password_hash = excluded.password_hash,
  role          = 'admin',
  username      = excluded.username,
  updated_at    = datetime('now');
SQL

ROW="$(sqlite3 -separator '|' "$DB" "SELECT id, email, username, role FROM users WHERE email = '$EMAIL_SQL';")"
if [ -z "$ROW" ]; then
  echo "[create-local-admin] something went wrong — user not found after upsert."
  exit 1
fi

echo "[create-local-admin] ✓ admin ready in $DB"
echo "                     row:      $ROW"
echo "                     email:    $EMAIL"
echo "                     password: $PASSWORD"
echo "                     role:     admin"
echo ""
echo "Log in at http://localhost:5173 with the above credentials."
