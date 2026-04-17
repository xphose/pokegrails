#!/usr/bin/env bash
# Remove Sentinel. Run as root:
#   sudo bash ops/sentinel/uninstall.sh
#
# Preserves /etc/sentinel/config.env and /var/lib/sentinel (state/history)
# unless you pass --purge.

set -euo pipefail

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "error: must run as root" >&2
  exit 1
fi

PURGE=0
if [ "${1:-}" = "--purge" ]; then
  PURGE=1
fi

echo "==> Disabling + stopping timer"
systemctl disable --now sentinel.timer 2>/dev/null || true
systemctl stop sentinel.service 2>/dev/null || true

echo "==> Removing systemd units"
rm -f /etc/systemd/system/sentinel.service /etc/systemd/system/sentinel.timer
systemctl daemon-reload

echo "==> Removing /opt/sentinel"
rm -rf /opt/sentinel

if [ "$PURGE" = "1" ]; then
  echo "==> PURGE: removing config + state + logs"
  rm -rf /etc/sentinel /var/lib/sentinel /var/log/sentinel
  if id -u sentinel >/dev/null 2>&1; then
    userdel sentinel 2>/dev/null || true
    groupdel sentinel 2>/dev/null || true
  fi
else
  echo "   keeping /etc/sentinel, /var/lib/sentinel, /var/log/sentinel"
  echo "   (pass --purge to remove them too)"
fi

echo "Sentinel uninstalled."
