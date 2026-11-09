#!/root/.venv/bin/python
"""
LiteRT-LM Interactive Tool Preset for NOC Dashboard & Telegram Alerting
=======================================================================
Usage with LiteRT-LM CLI:
  /root/.venv/bin/litert-lm run gemma-4-E2B-it --preset /root/noc_preset.py

Provides Gemma 4 with live tool-calling functions to read `/var/www/html/metrics.json`
and send Telegram notifications on demand.
"""

import json
import os
import re
import urllib.request

METRICS_PATH = "/var/www/html/metrics.json"
SERVICE_FILE = "/etc/systemd/system/cloud-monitor.service"

system_instruction = (
    "You are Gemma 4, the local Network Operations Center (NOC) AI Assistant on Raspberry Pi 5 (rpi). "
    "Use the provided tools to read live system, LAN, Wi-Fi, and Cloudflare telemetry from "
    "/var/www/html/metrics.json and to send Telegram alert messages when requested."
)


def _load_env():
    if os.path.isfile(SERVICE_FILE):
        with open(SERVICE_FILE, "r", encoding="utf-8") as f:
            for line in f:
                m = re.match(r'^Environment="([A-Za-z0-9_]+)=([^"]+)"$', line.strip())
                if m and m.group(1) not in os.environ:
                    os.environ[m.group(1)] = m.group(2)


def get_local_system_status() -> dict:
    """Reads Raspberry Pi 5 CPU, temperature, load, RAM, swap, disk, and network interfaces status."""
    with open(METRICS_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    return {
        "last_updated": data.get("last_updated"),
        "local_system": data.get("local_system", {}),
    }


def get_lan_and_wifi_status() -> dict:
    """Reads the active LAN device inventory and visible Wi-Fi networks from the NOC dashboard."""
    with open(METRICS_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    return {
        "last_updated": data.get("last_updated"),
        "lan_network": data.get("lan_network", {}),
    }


def get_cloudflare_domains_and_quotas() -> dict:
    """Reads Cloudflare Edge domain metrics (tsimon.me, minkalab.net, tsimon.app) and Workers/AI/D1 quotas."""
    with open(METRICS_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    return {
        "last_updated": data.get("last_updated"),
        "domains": data.get("domains", {}),
        "workers_and_pages": data.get("workers_and_pages", {}),
        "workers_ai": data.get("workers_ai", {}),
        "d1_billing": data.get("d1_billing", {}),
        "d1_databases": data.get("d1_databases", []),
    }


def send_telegram_alert(message: str) -> str:
    """Sends a plain-text alert message to the NOC Telegram chat."""
    _load_env()
    token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id:
        return "Error: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured."
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = json.dumps({"chat_id": chat_id, "text": message}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as resp:
        res = json.loads(resp.read().decode("utf-8"))
        return f"Sent to Telegram (ok={res.get('ok')})"


def snooze_assessment(key_or_name: str, duration: str = "24h") -> str:
    """Snoozes an active NOC assessment or finding by name or key for 24h, 72h, or 7d."""
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:8088/api/snooze",
            data=json.dumps({"key": key_or_name, "duration": duration}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            res = data.get("snoozed", {})
            return f"Snoozed '{res.get('title')}' for {res.get('duration_label')} (until {res.get('snoozed_until_utc')})"
    except Exception as e:
        return f"Error snoozing assessment: {e}"


def get_snoozed_assessments() -> list:
    """Returns the list of currently snoozed NOC assessments and findings with remaining duration and expiration times."""
    try:
        with urllib.request.urlopen("http://127.0.0.1:8088/api/status", timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("snoozed_anomalies", [])
    except Exception as e:
        return [{"error": str(e)}]


tools = [
    get_local_system_status,
    get_lan_and_wifi_status,
    get_cloudflare_domains_and_quotas,
    send_telegram_alert,
    snooze_assessment,
    get_snoozed_assessments,
]
