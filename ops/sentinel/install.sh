#!/usr/bin/env bash
# One-shot installer for Sentinel. Run as root on the server:
#   sudo bash ops/sentinel/install.sh
#
# It:
#   - creates a `sentinel` system user, adds it to the `docker` group
#   - copies scripts to /opt/sentinel/
#   - copies systemd units to /etc/systemd/system/
#   - installs an example /etc/sentinel/config.env (doesn't overwrite yours)
#   - enables + starts the timer
#
# Idempotent — safe to run multiple times (e.g. after `git pull`).

set -euo pipefail

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "error: must run as root (try: sudo bash $0)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Creating sentinel system user"
if ! id -u sentinel >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin --user-group sentinel
fi

echo "==> Adding sentinel to docker group (for read-only docker inspect)"
if getent group docker >/dev/null; then
  usermod -aG docker sentinel
else
  echo "   warning: 'docker' group missing — is Docker installed? Skipping."
fi

echo "==> Installing binaries to /opt/sentinel"
install -d -m 0755 /opt/sentinel
install -m 0755 "$SCRIPT_DIR/sentinel.sh" /opt/sentinel/sentinel.sh
install -m 0755 "$SCRIPT_DIR/alert.sh"    /opt/sentinel/alert.sh

echo "==> Installing state + log directories"
install -d -m 0750 -o sentinel -g sentinel /var/lib/sentinel
install -d -m 0755 -o sentinel -g sentinel /var/log/sentinel

echo "==> Installing config"
install -d -m 0755 /etc/sentinel
if [ ! -f /etc/sentinel/config.env ]; then
  install -m 0640 -o root -g sentinel "$SCRIPT_DIR/config.env.example" /etc/sentinel/config.env
  echo "   wrote /etc/sentinel/config.env (edit it now to add NTFY_TOPIC and HEALTHCHECKS_PING_URL)"
else
  echo "   /etc/sentinel/config.env already exists — leaving it alone"
fi

echo "==> Installing systemd units"
install -m 0644 "$SCRIPT_DIR/sentinel.service" /etc/systemd/system/sentinel.service
install -m 0644 "$SCRIPT_DIR/sentinel.timer"   /etc/systemd/system/sentinel.timer

echo "==> Reloading systemd"
systemctl daemon-reload

echo "==> Enabling + starting timer"
systemctl enable --now sentinel.timer

echo
echo "Sentinel installed."
echo
echo "Next steps:"
echo "  1. Edit /etc/sentinel/config.env — set NTFY_TOPIC and HEALTHCHECKS_PING_URL"
echo "     (see ops/sentinel/README.md for how to obtain those free)"
echo "  2. Test: sudo -u sentinel /opt/sentinel/sentinel.sh"
echo "  3. Watch:  sudo systemctl list-timers sentinel.timer"
echo "             sudo journalctl -u sentinel.service -n 50 --no-pager"
echo "  4. Trigger a test alert:"
echo "             sudo -u sentinel /opt/sentinel/alert.sh INFO test 'hello' 'Sentinel is alive'"
echo
