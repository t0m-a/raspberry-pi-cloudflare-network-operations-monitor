#!/usr/bin/env bash
# Installs the Raspberry Pi 5 15-minute NOC telemetry reporter cron job.
# Usage:
#   sudo NOC_INGEST_TOKEN="<secret>" ./install_rpi5_cron.sh
set -euo pipefail

INSTALL_DIR="/opt/noc-agent"
ENV_DIR="/etc/noc-agent"
ENV_FILE="${ENV_DIR}/reporter.env"
CRON_FILE="/etc/cron.d/rpi5-noc-reporter"
LOG_FILE="/var/log/rpi5-noc-reporter.log"

NOC_INGEST_URL="${NOC_INGEST_URL:-https://noc-hook.tsimon.me/api/ingest/rpi5}"
ESP32_IP="${ESP32_IP:-192.168.1.125}"
ESP32_MAC="${ESP32_MAC:-28:05:A5:E2:96:2C}"

if [[ -z "${NOC_INGEST_TOKEN:-}" ]]; then
  echo "ERROR: Please supply NOC_INGEST_TOKEN environment variable." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$ENV_DIR"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "${SCRIPT_DIR}/rpi5_noc_reporter.py" "${INSTALL_DIR}/rpi5_noc_reporter.py"
chmod 0755 "${INSTALL_DIR}/rpi5_noc_reporter.py"

cat > "$ENV_FILE" <<EOF
NOC_INGEST_URL=${NOC_INGEST_URL}
NOC_INGEST_TOKEN=${NOC_INGEST_TOKEN}
ESP32_IP=${ESP32_IP}
ESP32_MAC=${ESP32_MAC}
EOF
chmod 0600 "$ENV_FILE"

cat > "$CRON_FILE" <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Report Raspberry Pi 5 vitals, Qdrant, Brain sync, critical services & ESP-32S ping every 15 minutes
*/15 * * * * root /usr/bin/python3 ${INSTALL_DIR}/rpi5_noc_reporter.py --verbose >> ${LOG_FILE} 2>&1
EOF
chmod 0644 "$CRON_FILE"

echo "Installed ${INSTALL_DIR}/rpi5_noc_reporter.py and ${CRON_FILE} (*/15 * * * *)."
echo "Running initial verification push..."
/usr/bin/python3 "${INSTALL_DIR}/rpi5_noc_reporter.py" --verbose
