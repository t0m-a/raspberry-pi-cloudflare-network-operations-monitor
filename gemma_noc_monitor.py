#!/root/.venv/bin/python
"""
Gemma 4 Edge NOC Monitor, Interactive Telegram Bot & Smart Alerting Service
===========================================================================
1. Automatically and regularly (every 15m) analyzes `/var/www/html/metrics.json`
   produced by `cloud_monitor_daemon.py` across:
     - Raspberry Pi 5 Local System (CPU, Load, SoC/RP1 Temp, Fan, Throttle, RAM, Swap, Disk, NICs)
     - Local Area Network & Wi-Fi Spectrum (Gateway, Wi-Fi Signal, New LAN Device MAC Discovery)
     - Cloudflare Edge Domains (`tsimon.me`, `minkalab.net`, `tsimon.app` — Status, 5xx, Threats)
     - Cloudflare Platform Quotas & Billing (Workers, Pages, Workers AI Neurons, D1 SQL Storage & Rows)
   and sends smart Telegram alerts + daily health digests.

2. Listens continuously for incoming Telegram messages (`@minkalab_alert_bot`) so you can chat
   with Gemma 4 directly from Telegram using:
     - Any plain-text message in your direct chat with `@minkalab_alert_bot`
     - Mentions (`@minkalab_alert_bot ...`), hashtags (`#gemma ...`, `#noc ...`), or replies in groups/channels
     - Slash commands: `/status`, `/pi`, `/lan`, `/cf`, `/ask <question>`, `/gemma <question>`, `/help`

3. Spawns LiteRT-LM (`gemma-4-E2B-it.litertlm`) in an isolated child process per inference so the
   4 GB Raspberry Pi 5 reclaims 100% of model RAM immediately after every response.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import html
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Any


# --- PATHS & CONFIGURATION ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

SERVICE_ENV_FILES = (
    "/etc/systemd/system/cloud-monitor.service",
    "/etc/systemd/system/gemma-noc-monitor.service",
    os.path.join(SCRIPT_DIR, "cloud-monitor.service"),
)


def load_service_env_fallback() -> None:
    """Loads Environment= entries from systemd unit files if not already set in os.environ."""
    for path in SERVICE_ENV_FILES:
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        m = re.match(
                            r'^(?:Environment=|export\s+)["\']?([A-Za-z0-9_]+)=([^"\']+)["\']?$',
                            line,
                        )
                        if m:
                            key, val = m.group(1), m.group(2)
                            if key not in os.environ:
                                os.environ[key] = val
            except Exception:
                pass


load_service_env_fallback()

METRICS_PATH = os.getenv("METRICS_OUTPUT_PATH", "/var/www/html/metrics.json")
AI_ANALYSIS_OUTPUT_PATH = os.getenv(
    "AI_ANALYSIS_OUTPUT_PATH", "/var/www/html/ai_analysis.json"
)
STATE_FILE_PATH = os.getenv(
    "GEMMA_NOC_STATE_PATH", "/var/lib/gemma-noc-monitor/state.json"
)
DASHBOARD_URL = os.getenv("DASHBOARD_PUBLIC_URL", "https://pi.tsimon.me/")

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
BOT_USERNAME = os.getenv("TELEGRAM_BOT_USERNAME", "minkalab_alert_bot")

# Candidate LiteRT-LM model paths (ordered by XNNPACK cache proximity)
CANDIDATE_MODEL_PATHS = [
    os.getenv("GEMMA_MODEL_PATH", ""),
    "/root/.litert-lm/cache/huggingface/litert-community/gemma-4-E2B-it-litert-lm/gemma-4-E2B-it.litertlm",
    "/root/.cache/litert-cli/models/google__gemma-4-E4B-it/gemma-4-E2B-it.litertlm",
    "/root/.litert-lm/models/gemma-4-E2B-it/model.litertlm",
]

DEFAULT_XNNPACK_CACHE_DIR = (
    "/root/.litert-lm/cache/huggingface/litert-community/gemma-4-E2B-it-litert-lm"
)

# Alert Cooldowns & Digest Settings
ALERT_COOLDOWN_SECONDS = int(os.getenv("GEMMA_ALERT_COOLDOWN_SEC", str(4 * 3600)))  # 4 hours
DAILY_DIGEST_HOUR_LOCAL = int(os.getenv("GEMMA_DAILY_DIGEST_HOUR", "8"))  # 08:00 local time
MONITOR_INTERVAL_SECONDS = int(os.getenv("GEMMA_MONITOR_INTERVAL_SEC", "900"))  # 15 minutes

# Thresholds
THRESHOLDS = {
    "metrics_stale_seconds": 600,       # 10 minutes
    "cpu_warn_pct": 75.0,
    "cpu_crit_pct": 90.0,
    "load_warn_pct": 75.0,
    "load_crit_pct": 90.0,
    "temp_warn_c": 70.0,
    "temp_crit_c": 80.0,
    "ram_warn_pct": 85.0,
    "ram_crit_pct": 92.0,
    "swap_warn_pct": 60.0,
    "swap_crit_pct": 85.0,
    "disk_warn_pct": 80.0,
    "disk_crit_pct": 90.0,
    "wifi_warn_dbm": -75,
    "gateway_rtt_warn_ms": 50.0,
    "nic_error_delta_warn": 50,
    "domain_5xx_warn": 1,
    "domain_5xx_crit": 50,
    "domain_threats_warn": 15,
    "domain_threats_crit": 100,
    "quota_warn_pct": 60.0,
    "quota_crit_pct": 80.0,
}


def resolve_model_and_cache() -> tuple[str, str]:
    """Resolves the local LiteRT-LM Gemma 4 model path and XNNPACK cache directory."""
    for path in CANDIDATE_MODEL_PATHS:
        if path and os.path.isfile(path):
            real_path = os.path.realpath(path)
            real_dir = os.path.dirname(real_path)
            cache_dir = (
                DEFAULT_XNNPACK_CACHE_DIR
                if os.path.isdir(DEFAULT_XNNPACK_CACHE_DIR)
                else real_dir
            )
            return real_path, cache_dir
    raise FileNotFoundError(
        f"Could not find gemma-4-E2B-it.litertlm in any candidate path: {CANDIDATE_MODEL_PATHS}"
    )


def load_json_file(path: str, default: Any = None) -> Any:
    """Safely loads a JSON file or returns default."""
    if not os.path.isfile(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def write_json_atomic(path: str, payload: Any) -> None:
    """Atomically writes JSON data to disk."""
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    os.replace(tmp_path, path)


def parse_metrics_timestamp(ts_str: str) -> datetime | None:
    """Parses `last_updated` ('YYYY-MM-DD HH:MM:SS UTC') from metrics.json."""
    if not ts_str:
        return None
    try:
        clean = ts_str.replace("UTC", "").strip()
        dt = datetime.strptime(clean, "%Y-%m-%d %H:%M:%S")
        return dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


# =====================================================================
# SNOOZE LOGIC & DURATIONS (24h, 72h, 7d)
# =====================================================================

SNOOZE_DURATIONS: dict[str, int] = {
    "24h": 24 * 3600,       # 86,400s (24 hours)
    "72h": 72 * 3600,       # 259,200s (72 hours)
    "7d": 7 * 86400,        # 604,800s (7 days)
}

_KEY_HASH_MAP: dict[str, str] = {}


def normalize_snooze_duration(dur_input: str) -> tuple[int, str, str]:
    """
    Normalizes a duration string into (seconds, label, code).
    Supported durations:
      - 24 hours: '24h', '24', '24 hours', '1d', '1 day' -> (86400, "24 Hours", "24h")
      - 72 hours: '72h', '72', '72 hours', '3d', '3 days' -> (259200, "72 Hours", "72h")
      - 7 days:   '7d',  '7',  '7 days',  '168h', '1w'     -> (604800, "7 Days", "7d")
    """
    clean = (dur_input or "24h").strip().lower()
    if clean in ("24", "24h", "24hr", "24hrs", "24 hours", "24 hour", "1d", "1 day", "day", "daily"):
        return 24 * 3600, "24 Hours", "24h"
    elif clean in ("72", "72h", "72hr", "72hrs", "72 hours", "72 hour", "3d", "3 days"):
        return 72 * 3600, "72 Hours", "72h"
    elif clean in ("7", "7d", "7day", "7days", "7 days", "7 day", "168h", "168 hours", "1w", "1 week", "week", "weekly"):
        return 7 * 86400, "7 Days", "7d"
    else:
        raise ValueError(
            f"Invalid snooze duration '{dur_input}'. Allowed durations: 24h (24 hours), 72h (72 hours), or 7d (7 days)."
        )


def format_duration_human(seconds: float) -> str:
    """Formats seconds into concise human duration (e.g. '23.8h', '2.5d', '45m')."""
    if seconds <= 0:
        return "expired"
    mins = seconds / 60.0
    if mins < 60:
        return f"{int(mins)}m"
    hours = seconds / 3600.0
    if hours < 48:
        return f"{hours:.1f}h"
    days = hours / 24.0
    return f"{days:.1f}d"


def get_short_key(key: str) -> str:
    """Returns key as-is if short enough for Telegram callback_data, or generates a short hash."""
    if len(key) <= 30 and ":" not in key[10:]:
        _KEY_HASH_MAP[key] = key
        return key
    h = hashlib.sha1(key.encode("utf-8")).hexdigest()[:10]
    _KEY_HASH_MAP[h] = key
    _KEY_HASH_MAP[key] = key
    return h


def resolve_key(short_or_full: str) -> str:
    """Resolves short hash back to full anomaly key."""
    return _KEY_HASH_MAP.get(short_or_full, short_or_full)


def build_snooze_inline_keyboard(
    anomalies: list[dict[str, Any]],
    snoozed: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """Constructs Telegram inline keyboard for snoozing findings one by one."""
    buttons: list[list[dict[str, str]]] = []

    if len(anomalies) == 1:
        a = anomalies[0]
        k = a["key"]
        short_k = get_short_key(k)
        buttons.append([
            {"text": "💤 Snooze: 24h", "callback_data": f"snz:{short_k}:24h"},
            {"text": "72h", "callback_data": f"snz:{short_k}:72h"},
            {"text": "7d", "callback_data": f"snz:{short_k}:7d"},
        ])
    elif len(anomalies) > 1:
        for idx, a in enumerate(anomalies[:6], 1):
            k = a["key"]
            short_k = get_short_key(k)
            buttons.append([
                {"text": f"💤 #{idx} (24h)", "callback_data": f"snz:{short_k}:24h"},
                {"text": f"#{idx} (72h)", "callback_data": f"snz:{short_k}:72h"},
                {"text": f"#{idx} (7d)", "callback_data": f"snz:{short_k}:7d"},
            ])
        buttons.append([
            {"text": "💤 Snooze All (24h)", "callback_data": "snz_all:24h"},
            {"text": "All (72h)", "callback_data": "snz_all:72h"},
            {"text": "All (7d)", "callback_data": "snz_all:7d"},
        ])

    if snoozed:
        for s in snoozed[:4]:
            k = s["key"]
            short_k = get_short_key(k)
            stitle = s.get("title", k)
            if len(stitle) > 20:
                stitle = stitle[:19] + "…"
            buttons.append([
                {"text": f"❌ Unsnooze: {stitle}", "callback_data": f"unsnz:{short_k}"}
            ])

    if not buttons:
        return None
    return {"inline_keyboard": buttons}


def snooze_anomaly_by_key(
    key_or_pattern: str,
    duration_str: str = "24h",
    source: str = "operator",
) -> dict[str, Any]:
    """
    Snoozes an assessment/anomaly by key, short hash, 1-based index, or pattern match.
    Persists immediately to state.json and refreshes ai_analysis.json.
    """
    sec, label, code = normalize_snooze_duration(duration_str)
    now_ts = time.time()
    now_utc = datetime.now(timezone.utc)
    until_ts = now_ts + sec
    until_utc_str = datetime.fromtimestamp(until_ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    state = load_json_file(STATE_FILE_PATH, default={}) or {}
    metrics = load_json_file(METRICS_PATH, default={}) or {}

    raw_anomalies, _, _ = evaluate_telemetry(metrics, {**state, "snoozed_anomalies": {}})

    target_anomaly = None
    target_key = resolve_key(key_or_pattern.strip())

    if key_or_pattern.strip().isdigit():
        idx = int(key_or_pattern.strip()) - 1
        if 0 <= idx < len(raw_anomalies):
            target_anomaly = raw_anomalies[idx]
            target_key = target_anomaly["key"]

    if not target_anomaly:
        for a in raw_anomalies:
            if (
                a["key"] == target_key
                or key_or_pattern.lower() in a["key"].lower()
                or key_or_pattern.lower() in a["title"].lower()
            ):
                target_anomaly = a
                target_key = a["key"]
                break

    if not target_anomaly:
        prev_alerts = state.get("active_alerts") or {}
        if target_key in prev_alerts:
            pa = prev_alerts[target_key]
            target_anomaly = {
                "key": target_key,
                "title": pa.get("title", target_key),
                "severity": pa.get("severity", "WARNING"),
                "category": "NOC finding",
                "detail": pa.get("detail", ""),
            }
        else:
            target_anomaly = {
                "key": target_key,
                "title": target_key,
                "severity": "WARNING",
                "category": "Custom",
                "detail": "Operator-defined assessment key",
            }

    snoozes = dict(state.get("snoozed_anomalies") or {})
    snooze_entry = {
        "key": target_key,
        "title": target_anomaly.get("title", target_key),
        "severity": target_anomaly.get("severity", "WARNING"),
        "category": target_anomaly.get("category", "General"),
        "detail": target_anomaly.get("detail", ""),
        "duration_str": code,
        "duration_label": label,
        "duration_seconds": sec,
        "snoozed_at_ts": now_ts,
        "snoozed_at_utc": now_utc.strftime("%Y-%m-%d %H:%M:%S UTC"),
        "snoozed_until_ts": until_ts,
        "snoozed_until_utc": until_utc_str,
        "snoozed_by": source,
    }
    snoozes[target_key] = snooze_entry
    state["snoozed_anomalies"] = snoozes

    write_json_atomic(STATE_FILE_PATH, state)

    try:
        refresh_public_ai_analysis(metrics=metrics, state=state)
    except Exception as e:
        print(f"[GemmaNOC] Warning refreshing ai_analysis.json on snooze: {e}", file=sys.stderr)

    return snooze_entry


def unsnooze_anomaly_by_key(key_or_pattern: str) -> list[dict[str, Any]]:
    """Unsnoozes one or all snoozed anomalies."""
    state = load_json_file(STATE_FILE_PATH, default={}) or {}
    metrics = load_json_file(METRICS_PATH, default={}) or {}
    snoozes = dict(state.get("snoozed_anomalies") or {})
    if not snoozes:
        return []

    target = key_or_pattern.strip()
    removed: list[dict[str, Any]] = []

    if target.lower() in ("all", "*"):
        removed = list(snoozes.values())
        snoozes.clear()
    else:
        target_key = resolve_key(target)
        if target.isdigit():
            idx = int(target) - 1
            keys_list = list(snoozes.keys())
            if 0 <= idx < len(keys_list):
                target_key = keys_list[idx]

        match_key = None
        for k, entry in list(snoozes.items()):
            if (
                k == target_key
                or target.lower() in k.lower()
                or target.lower() in entry.get("title", "").lower()
            ):
                match_key = k
                break

        if match_key and match_key in snoozes:
            removed.append(snoozes.pop(match_key))

    state["snoozed_anomalies"] = snoozes
    write_json_atomic(STATE_FILE_PATH, state)

    try:
        refresh_public_ai_analysis(metrics=metrics, state=state)
    except Exception as e:
        print(f"[GemmaNOC] Warning refreshing ai_analysis.json on unsnooze: {e}", file=sys.stderr)

    return removed


def refresh_public_ai_analysis(
    metrics: dict[str, Any] | None = None,
    state: dict[str, Any] | None = None,
) -> None:
    """Refreshes /var/www/html/ai_analysis.json immediately with active vs snoozed state."""
    if metrics is None:
        metrics = load_json_file(METRICS_PATH, default={}) or {}
    if state is None:
        state = load_json_file(STATE_FILE_PATH, default={}) or {}

    now_utc_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    active_anomalies, _, _ = evaluate_telemetry(metrics, state)
    snoozed_dict = dict(state.get("snoozed_anomalies") or {})
    snoozed_list = list(snoozed_dict.values())

    now_ts = time.time()
    for s in snoozed_list:
        rem_s = float(s.get("snoozed_until_ts") or 0.0) - now_ts
        s["remaining_human"] = format_duration_human(rem_s)

    crit_count = sum(1 for a in active_anomalies if a.get("severity") == "CRITICAL")
    warn_count = sum(1 for a in active_anomalies if a.get("severity") == "WARNING")
    overall_status = "CRITICAL" if crit_count > 0 else ("WARNING" if warn_count > 0 else "HEALTHY")

    prev_public = load_json_file(AI_ANALYSIS_OUTPUT_PATH, default={}) or {}
    analysis_text = prev_public.get("analysis", state.get("last_gemma_analysis", "Nominal status."))

    payload = {
        "last_analyzed_utc": prev_public.get("last_analyzed_utc", now_utc_str),
        "metrics_sync_utc": metrics.get("last_updated", ""),
        "model": "google/gemma-4-E2B-it (LiteRT-LM)",
        "inference_duration_sec": float(prev_public.get("inference_duration_sec") or state.get("last_inference_sec") or 0.0),
        "overall_status": overall_status,
        "reason_code": "SNOOZE_UPDATED",
        "telegram_status": state.get("last_telegram_status", "Idle"),
        "anomalies_count": len(active_anomalies),
        "anomalies": active_anomalies,
        "snoozed_count": len(snoozed_list),
        "snoozed_anomalies": snoozed_list,
        "analysis": analysis_text,
    }
    write_json_atomic(AI_ANALYSIS_OUTPUT_PATH, payload)


class SnoozeApiHandler(BaseHTTPRequestHandler):
    """Zero-dependency HTTP API for Web Dashboard snooze operations on 127.0.0.1:8088."""

    def log_message(self, format: str, *args: Any) -> None:
        if args and str(args[1]) not in ("200", "204"):
            sys.stderr.write(f"[SnoozeAPI] {self.address_string()} - {format % args}\n")

    def _send_json(self, status: int, data: Any) -> None:
        body = json.dumps(data, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/")
        if path in ("/api/snooze", "/api/status", "/snooze", "/status"):
            st = load_json_file(STATE_FILE_PATH, default={}) or {}
            metrics = load_json_file(METRICS_PATH, default={}) or {}
            active, _, _ = evaluate_telemetry(metrics, st)
            snoozes = list((st.get("snoozed_anomalies") or {}).values())
            now_ts = time.time()
            for s in snoozes:
                rem = float(s.get("snoozed_until_ts") or 0.0) - now_ts
                s["remaining_human"] = format_duration_human(rem)
            self._send_json(200, {
                "ok": True,
                "active_anomalies": active,
                "snoozed_anomalies": snoozes,
                "server_time_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
            })
        else:
            self._send_json(404, {"ok": False, "error": f"Endpoint not found: {self.path}"})

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/")
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length > 0 else b"{}"
        try:
            req_data = json.loads(body.decode("utf-8")) if body else {}
        except Exception:
            return self._send_json(400, {"ok": False, "error": "Invalid JSON body"})

        if path in ("/api/snooze", "/snooze"):
            key = str(req_data.get("key", "")).strip()
            duration = str(req_data.get("duration", "24h")).strip()
            if not key:
                return self._send_json(400, {"ok": False, "error": "Missing required field 'key'"})
            try:
                res = snooze_anomaly_by_key(key, duration, source="web_ui")
                self._send_json(200, {"ok": True, "snoozed": res})
            except Exception as e:
                self._send_json(400, {"ok": False, "error": str(e)})

        elif path in ("/api/unsnooze", "/unsnooze"):
            key = str(req_data.get("key", "")).strip()
            if not key:
                return self._send_json(400, {"ok": False, "error": "Missing required field 'key'"})
            try:
                removed = unsnooze_anomaly_by_key(key)
                self._send_json(200, {"ok": True, "unsnoozed": removed})
            except Exception as e:
                self._send_json(400, {"ok": False, "error": str(e)})

        elif path in ("/api/analyze", "/analyze"):
            threading.Thread(
                target=run_cycle,
                kwargs={"force_telegram": False, "analyze_always": True},
                daemon=True,
            ).start()
            self._send_json(200, {"ok": True, "message": "Triggered fresh Gemma 4 evaluation"})

        else:
            self._send_json(404, {"ok": False, "error": f"Endpoint not found: {self.path}"})


def start_snooze_api_server(port: int = 8088) -> None:
    """Starts the Snooze HTTP API daemon on 127.0.0.1:8088."""
    try:
        server = HTTPServer(("127.0.0.1", port), SnoozeApiHandler)
        t = threading.Thread(target=server.serve_forever, daemon=True, name="SnoozeApiServer")
        t.start()
        print(f"[GemmaNOC] Local Snooze & NOC API server listening on http://127.0.0.1:{port}/api/")
    except Exception as e:
        print(f"[GemmaNOC] Warning: could not start Snooze API server on port {port}: {e}", file=sys.stderr)


# =====================================================================
# TELEMETRY EVALUATION & STATE DIFFING
# =====================================================================

def evaluate_telemetry(
    metrics: dict[str, Any], prev_state: dict[str, Any]
) -> tuple[list[dict[str, Any]], dict[str, Any], str]:
    """
    Evaluates all monitors in `metrics.json` against thresholds and `prev_state`.
    Returns:
      - anomalies: list of dict(key, severity, category, title, detail)
      - next_state_updates: dict of updated state counters/inventories
      - compact_brief: compact structured text summary (~350 tokens) for Gemma 4
    """
    now_utc = datetime.now(timezone.utc)
    anomalies: list[dict[str, Any]] = []
    brief_lines: list[str] = []

    # 0. Check Metrics Freshness
    last_updated_str = metrics.get("last_updated", "")
    last_dt = parse_metrics_timestamp(last_updated_str)
    age_sec = int((now_utc - last_dt).total_seconds()) if last_dt else 999999
    if age_sec > THRESHOLDS["metrics_stale_seconds"]:
        anomalies.append({
            "key": "daemon:stale_metrics",
            "severity": "CRITICAL",
            "category": "Monitor Service",
            "title": "Telemetry Stale",
            "detail": f"metrics.json last updated {age_sec // 60}m ago ({last_updated_str})",
        })

    # 1. Local Raspberry Pi 5 System
    sys_data = metrics.get("local_system") or {}
    host = sys_data.get("host") or {}
    load = sys_data.get("load") or {}
    cpu = sys_data.get("cpu") or {}
    mem = sys_data.get("memory") or {}
    swap = sys_data.get("swap") or {}
    filesystems = sys_data.get("filesystems") or []
    nics = sys_data.get("network_interfaces") or []

    hostname = host.get("hostname", "rpi")
    uptime_human = host.get("uptime_human", "N/A")
    cpu_pct = float(cpu.get("usage_pct") or 0.0)
    load_1m = float(load.get("load_1m") or 0.0)
    load_5m = float(load.get("load_5m") or 0.0)
    load_pct = float(load.get("load_pct") or 0.0)
    temp_c = cpu.get("temperature_c")
    rp1_temp_c = cpu.get("rp1_temp_c")
    fan_rpm = cpu.get("fan_rpm")
    throttled = str(cpu.get("throttled_status") or "OK (0x0)")
    mem_pct = float(mem.get("usage_pct") or 0.0)
    mem_used = float(mem.get("used_mb") or 0.0)
    mem_tot = float(mem.get("total_mb") or 0.0)
    swap_pct = float(swap.get("usage_pct") or 0.0)

    brief_lines.append(
        f"[HOST {hostname}] Sync: {last_updated_str} | Uptime: {uptime_human} | "
        f"Load: {load_1m}/{load_5m} ({load_pct}%) | CPU: {cpu_pct}% @ {cpu.get('freq_mhz', 0):.0f}MHz | "
        f"Temp: {temp_c}°C (RP1: {rp1_temp_c}°C, Fan: {fan_rpm} RPM) | Power: {throttled}"
    )
    brief_lines.append(
        f"[MEMORY] RAM: {mem_pct}% ({mem_used:.0f}/{mem_tot:.0f} MB, avail {mem.get('available_mb', 0):.0f} MB) | Swap: {swap_pct}%"
    )

    if cpu_pct >= THRESHOLDS["cpu_crit_pct"]:
        anomalies.append({
            "key": "sys:cpu_usage",
            "severity": "CRITICAL",
            "category": "Local System",
            "title": "Critical CPU Utilization",
            "detail": f"CPU usage at {cpu_pct}% (Load 1m: {load_1m})",
        })
    elif cpu_pct >= THRESHOLDS["cpu_warn_pct"]:
        anomalies.append({
            "key": "sys:cpu_usage",
            "severity": "WARNING",
            "category": "Local System",
            "title": "Elevated CPU Utilization",
            "detail": f"CPU usage at {cpu_pct}% (Load 1m: {load_1m})",
        })

    if load_pct >= THRESHOLDS["load_crit_pct"]:
        anomalies.append({
            "key": "sys:load",
            "severity": "CRITICAL",
            "category": "Local System",
            "title": "High System Load",
            "detail": f"1m load {load_1m} ({load_pct}% of {load.get('cores', 4)} cores)",
        })
    elif load_pct >= THRESHOLDS["load_warn_pct"]:
        anomalies.append({
            "key": "sys:load",
            "severity": "WARNING",
            "category": "Local System",
            "title": "Elevated System Load",
            "detail": f"1m load {load_1m} ({load_pct}% of {load.get('cores', 4)} cores)",
        })

    if temp_c is not None:
        t_val = float(temp_c)
        if t_val >= THRESHOLDS["temp_crit_c"]:
            anomalies.append({
                "key": "sys:temp",
                "severity": "CRITICAL",
                "category": "Thermal",
                "title": "SoC Thermal Critical",
                "detail": f"CPU temp {t_val}°C (RP1: {rp1_temp_c}°C, Fan: {fan_rpm} RPM)",
            })
        elif t_val >= THRESHOLDS["temp_warn_c"]:
            anomalies.append({
                "key": "sys:temp",
                "severity": "WARNING",
                "category": "Thermal",
                "title": "SoC Thermal Warning",
                "detail": f"CPU temp {t_val}°C (RP1: {rp1_temp_c}°C, Fan: {fan_rpm} RPM)",
            })

    if not throttled.startswith("OK"):
        sev = "CRITICAL" if any(k in throttled for k in ("Under-Voltage", "Throttled")) else "WARNING"
        anomalies.append({
            "key": "sys:throttled",
            "severity": sev,
            "category": "Power/Thermal",
            "title": "Hardware Throttling Flag",
            "detail": f"vcgencmd status: {throttled}",
        })

    if mem_pct >= THRESHOLDS["ram_crit_pct"]:
        anomalies.append({
            "key": "sys:ram",
            "severity": "CRITICAL",
            "category": "Memory",
            "title": "RAM Exhaustion Risk",
            "detail": f"RAM at {mem_pct}% ({mem_used:.0f}/{mem_tot:.0f} MB, avail: {mem.get('available_mb', 0):.0f} MB)",
        })
    elif mem_pct >= THRESHOLDS["ram_warn_pct"]:
        anomalies.append({
            "key": "sys:ram",
            "severity": "WARNING",
            "category": "Memory",
            "title": "High RAM Usage",
            "detail": f"RAM at {mem_pct}% ({mem_used:.0f}/{mem_tot:.0f} MB)",
        })

    if swap_pct >= THRESHOLDS["swap_crit_pct"]:
        anomalies.append({
            "key": "sys:swap",
            "severity": "CRITICAL",
            "category": "Memory",
            "title": "High Swap Usage",
            "detail": f"Swap at {swap_pct}% ({swap.get('used_mb', 0):.0f}/{swap.get('total_mb', 0):.0f} MB)",
        })
    elif swap_pct >= THRESHOLDS["swap_warn_pct"]:
        anomalies.append({
            "key": "sys:swap",
            "severity": "WARNING",
            "category": "Memory",
            "title": "Elevated Swap Usage",
            "detail": f"Swap at {swap_pct}% ({swap.get('used_mb', 0):.0f}/{swap.get('total_mb', 0):.0f} MB)",
        })

    # Filesystems
    fs_summaries = []
    for fs in filesystems:
        mnt = fs.get("mountpoint", "?")
        pct = float(fs.get("usage_pct") or 0.0)
        free_gb = float(fs.get("free_gb") or 0.0)
        fs_summaries.append(f"{mnt}: {pct}% ({free_gb}GB free)")
        if pct >= THRESHOLDS["disk_crit_pct"]:
            anomalies.append({
                "key": f"fs:{mnt}",
                "severity": "CRITICAL",
                "category": "Storage",
                "title": f"Disk Full Risk ({mnt})",
                "detail": f"{mnt} at {pct}% ({free_gb} GB free of {fs.get('total_gb')} GB)",
            })
        elif pct >= THRESHOLDS["disk_warn_pct"]:
            anomalies.append({
                "key": f"fs:{mnt}",
                "severity": "WARNING",
                "category": "Storage",
                "title": f"High Disk Usage ({mnt})",
                "detail": f"{mnt} at {pct}% ({free_gb} GB free)",
            })
    if fs_summaries:
        brief_lines.append(f"[STORAGE] {' | '.join(fs_summaries)}")

    # Network Interfaces
    prev_nic_errors: dict[str, int] = dict(prev_state.get("nic_errors") or {})
    curr_nic_errors: dict[str, int] = {}
    nic_summaries = []
    for nic in nics:
        name = nic.get("name", "")
        ntype = nic.get("type", "")
        state = nic.get("operstate", "UNKNOWN")
        errs = int(nic.get("rx_errors") or 0) + int(nic.get("tx_errors") or 0)
        curr_nic_errors[name] = errs

        if name in ("eth0", "wlan0"):
            ipv4 = (nic.get("ipv4") or ["-"])[0]
            nic_summaries.append(
                f"{name}({state}, {ipv4}, rx:{nic.get('rx_rate_kbps', 0)}kbps, tx:{nic.get('tx_rate_kbps', 0)}kbps, errs:{errs})"
            )
            if state != "UP":
                anomalies.append({
                    "key": f"nic_down:{name}",
                    "severity": "CRITICAL" if name == "eth0" else "WARNING",
                    "category": "Network Interface",
                    "title": f"Interface {name} is {state}",
                    "detail": f"Physical interface {name} ({ntype}) operstate is {state}",
                })
            if name in prev_nic_errors:
                delta_err = errs - prev_nic_errors[name]
                if delta_err >= THRESHOLDS["nic_error_delta_warn"]:
                    anomalies.append({
                        "key": f"nic_errors:{name}",
                        "severity": "WARNING",
                        "category": "Network Interface",
                        "title": f"Packet Errors Increasing on {name}",
                        "detail": f"+{delta_err} new RX/TX errors on {name} (total: {errs})",
                    })
            if name == "wlan0" and nic.get("wifi_signal_dbm") is not None:
                sig_dbm = int(nic["wifi_signal_dbm"])
                if sig_dbm <= THRESHOLDS["wifi_warn_dbm"]:
                    anomalies.append({
                        "key": "wifi:weak_signal",
                        "severity": "WARNING",
                        "category": "Wi-Fi",
                        "title": "Weak Wi-Fi Signal",
                        "detail": f"wlan0 ({nic.get('wifi_ssid', '?')}) signal at {sig_dbm} dBm",
                    })
    if nic_summaries:
        brief_lines.append(f"[NICS] {' | '.join(nic_summaries)}")

    # 2. LAN Network & Device Inventory
    lan = metrics.get("lan_network") or {}
    lan_sum = lan.get("summary") or {}
    lan_devices = lan.get("lan_devices") or []
    wifi_nets = lan.get("wifi_networks") or []

    gw_ip = lan_sum.get("gateway_ip", "192.168.1.1")
    gw_dev = next((d for d in lan_devices if d.get("ip") == gw_ip or d.get("role") == "GATEWAY"), None)
    if not gw_dev or gw_dev.get("status") != "ONLINE":
        anomalies.append({
            "key": "lan:gateway_offline",
            "severity": "CRITICAL",
            "category": "LAN Network",
            "title": "Default Gateway Unreachable",
            "detail": f"Gateway {gw_ip} not responding as ONLINE in LAN scan",
        })
    elif gw_dev.get("rtt_ms") is not None and float(gw_dev["rtt_ms"]) >= THRESHOLDS["gateway_rtt_warn_ms"]:
        anomalies.append({
            "key": "lan:gateway_latency",
            "severity": "WARNING",
            "category": "LAN Network",
            "title": "High LAN Gateway Latency",
            "detail": f"Gateway {gw_ip} RTT is {gw_dev['rtt_ms']} ms",
        })

    # Known LAN MAC tracking
    known_macs: dict[str, dict[str, str]] = dict(prev_state.get("known_lan_macs") or {})
    is_first_baseline = not bool(known_macs)
    new_devices_found = []

    for dev in lan_devices:
        mac = (dev.get("mac") or "").upper()
        ip = dev.get("ip") or ""
        hostname_dev = dev.get("hostname") or "-"
        vendor = dev.get("vendor") or "Unknown"
        if not mac or mac == "UNKNOWN":
            continue
        if mac not in known_macs:
            known_macs[mac] = {
                "first_seen": now_utc.strftime("%Y-%m-%d %H:%M UTC"),
                "last_ip": ip,
                "hostname": hostname_dev,
                "vendor": vendor,
            }
            if not is_first_baseline:
                new_devices_found.append(dev)
                anomalies.append({
                    "key": f"lan:new_device:{mac}",
                    "severity": "WARNING",
                    "category": "LAN Security",
                    "title": f"New LAN Device Joined ({ip})",
                    "detail": f"Host: {hostname_dev} | MAC: {mac} | Vendor: {vendor}",
                })
        else:
            known_macs[mac]["last_ip"] = ip
            if hostname_dev and hostname_dev != "-":
                known_macs[mac]["hostname"] = hostname_dev

    host_labels = [
        f"{d.get('ip')}({d.get('hostname') or d.get('vendor', '?')[:12]})"
        for d in lan_devices
    ]
    brief_lines.append(
        f"[LAN] Subnet {lan_sum.get('subnet', '192.168.1.0/24')} | "
        f"{len(lan_devices)} active hosts, {len(wifi_nets)} Wi-Fi APs | "
        f"Hosts: {', '.join(host_labels[:14])}"
    )

    # 3. Cloudflare Edge Domains
    domains = metrics.get("domains") or {}
    domain_summaries = []
    for dname, dmetrics in domains.items():
        st = dmetrics.get("status", "UNKNOWN")
        hits = int(dmetrics.get("hit_volume") or 0)
        chr_pct = float(dmetrics.get("cache_hit_ratio") or 0.0)
        sec_ev = int(dmetrics.get("security_events") or 0)
        err_5xx = int(dmetrics.get("errors_5xx") or 0)
        bw_gb = float(dmetrics.get("bandwidth_gb") or 0.0)

        domain_summaries.append(
            f"{dname}: {st}, {hits} reqs/1h, CHR {chr_pct}%, threats:{sec_ev}, 5xx:{err_5xx}, bw:{bw_gb}GB"
        )

        if st != "HEALTHY":
            anomalies.append({
                "key": f"cf_domain_status:{dname}",
                "severity": "CRITICAL",
                "category": "Cloudflare Edge",
                "title": f"Domain {dname} Unhealthy",
                "detail": f"Status reported as '{st}'",
            })

        if err_5xx >= THRESHOLDS["domain_5xx_crit"]:
            anomalies.append({
                "key": f"cf_domain_5xx:{dname}",
                "severity": "CRITICAL",
                "category": "Cloudflare Edge",
                "title": f"High 5xx Origin Errors on {dname}",
                "detail": f"{err_5xx} HTTP 5xx errors in past 1h ({hits} total requests, CHR {chr_pct}%)",
            })
        elif err_5xx >= THRESHOLDS["domain_5xx_warn"]:
            anomalies.append({
                "key": f"cf_domain_5xx:{dname}",
                "severity": "WARNING",
                "category": "Cloudflare Edge",
                "title": f"Origin 5xx Errors on {dname}",
                "detail": f"{err_5xx} HTTP 5xx errors in past 1h ({hits} total requests)",
            })

        if sec_ev >= THRESHOLDS["domain_threats_crit"]:
            anomalies.append({
                "key": f"cf_domain_threats:{dname}",
                "severity": "CRITICAL",
                "category": "Cloudflare Security",
                "title": f"Attack / Threat Spike on {dname}",
                "detail": f"{sec_ev} security threats blocked in past 1h",
            })
        elif sec_ev >= THRESHOLDS["domain_threats_warn"]:
            anomalies.append({
                "key": f"cf_domain_threats:{dname}",
                "severity": "WARNING",
                "category": "Cloudflare Security",
                "title": f"Elevated Security Events on {dname}",
                "detail": f"{sec_ev} security threats blocked in past 1h",
            })

    if domain_summaries:
        brief_lines.append(f"[CLOUDFLARE DOMAINS (1h)] {' || '.join(domain_summaries)}")

    # 4. Cloudflare Workers, Pages, Workers AI & D1 Quotas
    wp = metrics.get("workers_and_pages") or {}
    ai = metrics.get("workers_ai") or {}
    d1b = metrics.get("d1_billing") or {}
    d1_dbs = metrics.get("d1_databases") or []

    wp_daily_pct = float(wp.get("daily_requests_pct") or 0.0)
    ai_daily_pct = float(ai.get("daily_neurons_pct") or 0.0)
    d1_read_pct = float(d1b.get("daily_rows_read_pct") or 0.0)
    d1_write_pct = float(d1b.get("daily_rows_written_pct") or 0.0)
    d1_sto_pct = float(d1b.get("account_storage_pct") or 0.0)

    total_est_usd = (
        float(wp.get("estimated_billable_usd") or 0.0)
        + float(ai.get("estimated_billable_usd") or 0.0)
        + float(d1b.get("estimated_billable_usd") or 0.0)
    )

    script_summaries = [
        f"{s.get('name')}(today:{s.get('requests_today', 0)}, mtd:{s.get('requests_mtd', 0)}, err:{s.get('errors_mtd', 0)})"
        for s in (wp.get("scripts") or [])
    ]
    db_summaries = [
        f"{d.get('name')}({d.get('file_size_mb', 0)}MB/{d.get('capacity_pct', 0)}%)"
        for d in d1_dbs
    ]

    brief_lines.append(
        f"[CLOUDFLARE QUOTAS] Workers Daily: {wp.get('daily_requests', 0)} ({wp_daily_pct}%), "
        f"MTD Reqs: {wp.get('mtd_worker_requests', 0)}, MTD Errors: {wp.get('mtd_errors', 0)} "
        f"[{', '.join(script_summaries)}] | "
        f"Workers AI Today: {ai.get('daily_neurons', 0)} neurons ({ai_daily_pct}%), MTD: {ai.get('mtd_neurons', 0)} | "
        f"D1 Read: {d1_read_pct}%, Write: {d1_write_pct}%, Storage: {d1b.get('total_storage_mb', 0)}MB ({d1_sto_pct}%) "
        f"[{', '.join(db_summaries)}] | Est Billable: ${total_est_usd:.2f}"
    )

    for q_key, q_label, q_pct in (
        ("quota:workers_daily", "Workers Daily Requests Quota", wp_daily_pct),
        ("quota:workers_ai_daily", "Workers AI Daily Neurons Quota", ai_daily_pct),
        ("quota:d1_reads_daily", "D1 Daily Rows Read Quota", d1_read_pct),
        ("quota:d1_writes_daily", "D1 Daily Rows Written Quota", d1_write_pct),
        ("quota:d1_storage", "D1 Account Storage Quota", d1_sto_pct),
    ):
        if q_pct >= THRESHOLDS["quota_crit_pct"]:
            anomalies.append({
                "key": q_key,
                "severity": "CRITICAL",
                "category": "Cloudflare Quota",
                "title": f"{q_label} Critical",
                "detail": f"Usage at {q_pct}% of free tier limit",
            })
        elif q_pct >= THRESHOLDS["quota_warn_pct"]:
            anomalies.append({
                "key": q_key,
                "severity": "WARNING",
                "category": "Cloudflare Quota",
                "title": f"{q_label} Warning",
                "detail": f"Usage at {q_pct}% of free tier limit",
            })

    # Track per-script MTD errors delta so old MTD errors don't alert repeatedly
    prev_script_errors: dict[str, int] = dict(prev_state.get("script_errors_mtd") or {})
    curr_script_errors: dict[str, int] = {}
    for s in wp.get("scripts") or []:
        sname = s.get("name", "unknown")
        serrs = int(s.get("errors_mtd") or 0)
        curr_script_errors[sname] = serrs
        if sname in prev_script_errors and serrs > prev_script_errors[sname]:
            delta = serrs - prev_script_errors[sname]
            anomalies.append({
                "key": f"worker_err:{sname}",
                "severity": "WARNING",
                "category": "Cloudflare Workers",
                "title": f"New Worker Script Errors ({sname})",
                "detail": f"+{delta} new invocation error(s) on Worker '{sname}' (MTD total: {serrs})",
            })

    for db in d1_dbs:
        db_name = db.get("name", "unknown")
        cap_pct = float(db.get("capacity_pct") or 0.0)
        if cap_pct >= THRESHOLDS["quota_crit_pct"]:
            anomalies.append({
                "key": f"d1_db_cap:{db_name}",
                "severity": "CRITICAL",
                "category": "D1 Database",
                "title": f"D1 Database '{db_name}' Near Capacity",
                "detail": f"{db.get('file_size_mb')} MB used ({cap_pct}% of 500 MB limit)",
            })

    # 5. Process Snoozed / Acknowledged Findings
    now_ts = time.time()
    snoozed_store: dict[str, dict[str, Any]] = dict(prev_state.get("snoozed_anomalies") or {})
    valid_snoozes: dict[str, dict[str, Any]] = {}
    active_snoozed_list: list[dict[str, Any]] = []

    for k, s_entry in snoozed_store.items():
        until_ts = float(s_entry.get("snoozed_until_ts") or 0.0)
        if until_ts > now_ts:
            rem_sec = until_ts - now_ts
            s_copy = dict(s_entry)
            s_copy["remaining_seconds"] = int(rem_sec)
            s_copy["remaining_human"] = format_duration_human(rem_sec)
            valid_snoozes[k] = s_copy
            active_snoozed_list.append(s_copy)
            get_short_key(k)

    active_anomalies: list[dict[str, Any]] = []
    for a in anomalies:
        k = a["key"]
        get_short_key(k)
        if k in valid_snoozes:
            valid_snoozes[k]["title"] = a["title"]
            valid_snoozes[k]["severity"] = a["severity"]
            valid_snoozes[k]["category"] = a["category"]
            valid_snoozes[k]["detail"] = a["detail"]
        else:
            active_anomalies.append(a)

    if active_anomalies:
        brief_lines.append("\n[DETECTED ACTIVE ANOMALIES]")
        for a in active_anomalies:
            brief_lines.append(f"- [{a['severity']}] {a['category']} — {a['title']}: {a['detail']}")
    else:
        brief_lines.append("\n[DETECTED ACTIVE ANOMALIES] None — All active systems nominal and HEALTHY.")

    if active_snoozed_list:
        brief_lines.append("\n[SNOOZED / OPERATOR-ACKNOWLEDGED FINDINGS (Alerts Silenced)]")
        for s in active_snoozed_list:
            brief_lines.append(
                f"- [SNOOZED {s.get('duration_str', '24h')} • {s.get('remaining_human', '')} remaining (until {s.get('snoozed_until_utc', '')})] "
                f"{s.get('title', s.get('key'))}: {s.get('detail', '')}"
            )
        brief_lines.append("Note: Operator has already acknowledged snoozed findings. Do not raise alarms for them.")

    state_updates = {
        "known_lan_macs": known_macs,
        "nic_errors": curr_nic_errors,
        "script_errors_mtd": curr_script_errors,
        "snoozed_anomalies": valid_snoozes,
    }
    return active_anomalies, state_updates, "\n".join(brief_lines)


def decide_notification_action(
    anomalies: list[dict[str, Any]],
    prev_state: dict[str, Any],
    force_telegram: bool = False,
) -> tuple[bool, str, list[dict[str, Any]]]:
    """Determines whether an automated Telegram alert/digest should be sent."""
    now_ts = time.time()
    local_now = datetime.now().astimezone()
    today_local_str = local_now.strftime("%Y-%m-%d")

    prev_active: dict[str, dict[str, Any]] = dict(prev_state.get("active_alerts") or {})
    triggered: list[dict[str, Any]] = []

    if force_telegram:
        return True, "MANUAL_REPORT", anomalies

    for a in anomalies:
        key = a["key"]
        sev = a["severity"]
        prev_entry = prev_active.get(key)
        if not prev_entry:
            triggered.append(a)
        else:
            prev_sev = prev_entry.get("severity", "WARNING")
            last_sent = float(prev_entry.get("last_sent_ts") or 0.0)
            escalated = (prev_sev != "CRITICAL" and sev == "CRITICAL")
            cooldown_expired = (now_ts - last_sent) >= ALERT_COOLDOWN_SECONDS
            if escalated or cooldown_expired:
                triggered.append(a)

    if triggered:
        return True, "ANOMALY_ALERT", triggered

    if not anomalies and prev_active:
        snoozed_keys = set((prev_state.get("snoozed_anomalies") or {}).keys())
        truly_resolved = [k for k in prev_active if k not in snoozed_keys]
        if truly_resolved:
            return True, "ALL_CLEAR_RESOLVED", []
        return False, "NO_CHANGE_COOLDOWN", []

    last_digest_date = prev_state.get("last_daily_digest_date", "")
    if last_digest_date != today_local_str and local_now.hour >= DAILY_DIGEST_HOUR_LOCAL:
        return True, "DAILY_DIGEST", anomalies

    return False, "NO_CHANGE_COOLDOWN", []


# =====================================================================
# GEMMA 4 LITERT-LM INFERENCE (IN-PROCESS & SUBPROCESS ISOLATED)
# =====================================================================

def _llm_worker_execute(system_instruction: str, prompt: str, max_output_tokens: int = 280) -> tuple[str, float]:
    """Runs LiteRT-LM directly inside the worker process."""
    import litert_lm

    litert_lm.set_min_log_severity(litert_lm.LogSeverity.ERROR)
    model_path, cache_dir = resolve_model_and_cache()

    t0 = time.perf_counter()
    with litert_lm.Engine(
        model_path,
        backend=litert_lm.Backend.CPU(thread_count=4),
        vision_backend=None,
        audio_backend=None,
        max_num_tokens=1536,
        cache_dir=cache_dir,
    ) as engine:
        with engine.create_conversation(
            system_message=system_instruction,
            thinking_config=litert_lm.ThinkingConfig(
                enable_thinking=False, thinking_token_budget=0
            ),
            sampler_config=litert_lm.SamplerConfig(
                temperature=0.2, top_k=20, top_p=0.9
            ),
        ) as conv:
            response_msg = conv.send_message(prompt, max_output_tokens=max_output_tokens)
            text = str(response_msg).strip()

    elapsed_s = round(time.perf_counter() - t0, 2)
    return text, elapsed_s


def run_gemma4_subprocess(system_instruction: str, prompt: str, max_output_tokens: int = 280) -> tuple[str, float]:
    """
    Executes Gemma 4 LiteRT-LM in a short-lived child process so 100% of the ~2GB
    model memory is returned to the Raspberry Pi 5 kernel immediately after inference.
    """
    payload = json.dumps({
        "system_instruction": system_instruction,
        "prompt": prompt,
        "max_output_tokens": max_output_tokens,
    })
    res = subprocess.run(
        [sys.executable, os.path.abspath(__file__), "--llm-worker"],
        input=payload,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=180,
        check=False,
    )
    if res.returncode != 0:
        raise RuntimeError(f"LLM worker exited {res.returncode}: {res.stderr.strip()[-300:]}")
    out_lines = [line for line in res.stdout.strip().splitlines() if line.strip()]
    if not out_lines:
        raise RuntimeError("Empty output from LLM worker")
    data = json.loads(out_lines[-1])
    return data["text"], float(data["elapsed_s"])


def run_gemma4_analysis(compact_brief: str, reason_code: str) -> tuple[str, float]:
    """Generates the automated NOC assessment using Gemma 4."""
    system_instruction = (
        "You are Gemma 4, an automated Network Operations Center (NOC) AI Engineer running "
        "locally on a Raspberry Pi 5 (rpi) in La Paz, Bolivia. "
        "Analyze the provided telemetry snapshot accurately using ONLY the exact numbers given. "
        "Write a concise, high-signal assessment in 3 to 4 short bullet points covering: "
        "(1) Critical/Warning anomalies & root cause (or confirm healthy state), "
        "(2) Local Pi 5 hardware & LAN status, "
        "(3) Cloudflare domains & quotas status, and "
        "(4) Immediate recommended action if any anomaly is present. "
        "Keep total output under 140 words. Do not invent metrics."
    )
    prompt = (
        f"Notification Type: {reason_code}\n"
        f"Telemetry Snapshot:\n{compact_brief}\n\n"
        "Provide your concise NOC AI assessment (3-4 bullet points):"
    )
    return run_gemma4_subprocess(system_instruction, prompt, max_output_tokens=260)


def run_gemma4_chat_reply(user_question: str, compact_brief: str) -> tuple[str, float]:
    """Answers an interactive user question from Telegram using live NOC telemetry."""
    system_instruction = (
        "You are Gemma 4 (E2B-it), the local AI NOC Assistant running on Thomas Simon's "
        "Raspberry Pi 5 (hostname: rpi) via Google LiteRT-LM. "
        "You have live access to the current NOC telemetry snapshot below (Local Pi 5 system, "
        "LAN devices, Wi-Fi spectrum, Cloudflare Edge domains, Workers, Workers AI, and D1 databases). "
        "Answer the user's question directly, accurately, and concisely using the live telemetry when relevant. "
        "Keep your response clear and under 180 words."
    )
    prompt = (
        f"Live NOC Telemetry Context:\n{compact_brief}\n\n"
        f"User Message from Telegram:\n{user_question}\n\n"
        "Your Answer:"
    )
    return run_gemma4_subprocess(system_instruction, prompt, max_output_tokens=320)


# =====================================================================
# TELEGRAM BOT API HELPERS & INTERACTIVE CHAT HANDLER
# =====================================================================

def telegram_api_call(method: str, payload: dict[str, Any] | None = None, timeout: int = 15) -> dict[str, Any]:
    """Calls a Telegram Bot API method and returns parsed JSON."""
    if not TELEGRAM_BOT_TOKEN:
        return {"ok": False, "description": "Missing TELEGRAM_BOT_TOKEN"}
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/{method}"
    data = json.dumps(payload or {}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": "GemmaNOCMonitor/2.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        return {"ok": False, "error_code": e.code, "description": err_body}
    except Exception as e:
        return {"ok": False, "description": str(e)}


def send_telegram_message(
    text_html: str,
    chat_id: str | int | None = None,
    reply_to_message_id: int | None = None,
    reply_markup: dict[str, Any] | None = None,
) -> tuple[bool, str, int | None]:
    """Sends an HTML-formatted message via the Telegram Bot API."""
    target_chat = str(chat_id or TELEGRAM_CHAT_ID)
    if not TELEGRAM_BOT_TOKEN or not target_chat:
        return False, "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID", None

    payload: dict[str, Any] = {
        "chat_id": target_chat,
        "text": text_html,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if reply_to_message_id:
        payload["reply_to_message_id"] = reply_to_message_id
    if reply_markup:
        payload["reply_markup"] = reply_markup

    body = telegram_api_call("sendMessage", payload, timeout=15)
    if body.get("ok"):
        msg_id = (body.get("result") or {}).get("message_id")
        return True, f"Sent (message_id={msg_id})", msg_id
    return False, f"Telegram API error: {body.get('description', body)}", None


def edit_telegram_message(
    chat_id: str | int,
    message_id: int,
    text_html: str,
    reply_markup: dict[str, Any] | None = None,
) -> bool:
    """Edits an existing Telegram message in-place."""
    payload: dict[str, Any] = {
        "chat_id": str(chat_id),
        "message_id": message_id,
        "text": text_html,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    body = telegram_api_call(
        "editMessageText",
        payload,
        timeout=15,
    )
    return bool(body.get("ok"))


def register_bot_commands() -> None:
    """Registers slash commands with Telegram so they appear in the chat '/' menu."""
    commands = [
        {"command": "status", "description": "Instant NOC overview + latest Gemma 4 verdict"},
        {"command": "snooze", "description": "Snooze active findings one by one (24h, 72h, 7d)"},
        {"command": "unsnooze", "description": "Reactivate snoozed findings"},
        {"command": "pi", "description": "Raspberry Pi 5 CPU, thermals, RAM, disk & NICs"},
        {"command": "lan", "description": "Active LAN devices inventory & Wi-Fi signal"},
        {"command": "cf", "description": "Cloudflare domains, 5xx errors & Workers/AI/D1 quotas"},
        {"command": "ask", "description": "Ask Gemma 4 a question with live NOC telemetry"},
        {"command": "analyze", "description": "Run a fresh Gemma 4 AI analysis right now"},
        {"command": "help", "description": "How to chat with Gemma 4 on Telegram"},
    ]
    telegram_api_call("setMyCommands", {"commands": commands}, timeout=10)


def format_telegram_html(
    metrics: dict[str, Any],
    anomalies: list[dict[str, Any]],
    reason_code: str,
    gemma_analysis: str,
    inference_sec: float,
    snoozed: list[dict[str, Any]] | None = None,
) -> str:
    """Formats a rich HTML Telegram notification message."""
    sys_data = metrics.get("local_system") or {}
    host = sys_data.get("host") or {}
    cpu = sys_data.get("cpu") or {}
    load = sys_data.get("load") or {}
    mem = sys_data.get("memory") or {}
    lan_sum = (metrics.get("lan_network") or {}).get("summary") or {}
    domains = metrics.get("domains") or {}

    has_crit = any(a["severity"] == "CRITICAL" for a in anomalies)
    has_warn = any(a["severity"] == "WARNING" for a in anomalies)

    if reason_code == "ALL_CLEAR_RESOLVED":
        header = "✅ <b>NOC MONITOR: ALL SYSTEMS RESOLVED</b>"
    elif has_crit:
        header = "🚨 <b>NOC ALERT: CRITICAL STATUS DETECTED</b>"
    elif has_warn:
        header = "⚠️ <b>NOC ALERT: WARNING STATUS DETECTED</b>"
    elif reason_code == "DAILY_DIGEST":
        header = "📊 <b>NOC DAILY HEALTH DIGEST (Gemma 4)</b>"
    else:
        header = "🟢 <b>NOC STATUS REPORT: HEALTHY</b>"

    lines = [
        header,
        f"<i>Node: {html.escape(str(host.get('hostname', 'rpi')))} • Sync: {html.escape(str(metrics.get('last_updated', 'N/A')))}</i>",
        "",
    ]

    if anomalies:
        lines.append(f"<b>Active Findings ({len(anomalies)}):</b>")
        for a in anomalies:
            icon = "🔴" if a["severity"] == "CRITICAL" else "🟡"
            lines.append(
                f"{icon} <b>{html.escape(a['title'])}</b>: {html.escape(a['detail'])}"
            )
        lines.append("")

    if snoozed:
        lines.append(f"💤 <b>Snoozed Findings ({len(snoozed)}):</b>")
        for s in snoozed:
            lines.append(
                f"• 💤 <b>{html.escape(s['title'])}</b> <i>({s.get('duration_str', '24h')} • {s.get('remaining_human', '')} left)</i>"
            )
        lines.append("")

    fs_root = next(
        (f for f in (sys_data.get("filesystems") or []) if f.get("mountpoint") == "/"),
        {},
    )
    lines.append("<b>System &amp; Edge Snapshot:</b>")
    lines.append(
        f"• <b>Pi 5:</b> CPU {cpu.get('usage_pct', 0)}% | Load {load.get('load_1m', 0)} | "
        f"Temp {cpu.get('temperature_c', 'N/A')}°C | RAM {mem.get('usage_pct', 0)}% | "
        f"Root FS {fs_root.get('usage_pct', 0)}%"
    )
    lines.append(
        f"• <b>LAN:</b> {lan_sum.get('active_devices_count', 0)} active hosts on {html.escape(str(lan_sum.get('subnet', 'LAN')))} "
        f"(GW {html.escape(str(lan_sum.get('gateway_ip', '-')))})"
    )

    dom_parts = []
    for dname, dm in domains.items():
        d_icon = "🟢" if dm.get("status") == "HEALTHY" and (dm.get("errors_5xx") or 0) == 0 else "🟠"
        dom_parts.append(
            f"{d_icon} {html.escape(dname)} ({dm.get('hit_volume', 0)} req, {dm.get('errors_5xx', 0)} 5xx, {dm.get('security_events', 0)} thr)"
        )
    if dom_parts:
        lines.append(f"• <b>Edge (1h):</b> {' | '.join(dom_parts)}")

    lines.append("")
    lines.append(f"🤖 <b>Gemma 4 E2B Analysis</b> <i>({inference_sec}s on LiteRT-LM)</i>:")
    clean_gemma = html.escape(gemma_analysis.strip())
    lines.append(clean_gemma)
    lines.append("")
    lines.append(f"🔗 <a href=\"{html.escape(DASHBOARD_URL)}\">Open Live NOC Dashboard</a>")

    return "\n".join(lines)


def format_quick_pi_card(metrics: dict[str, Any]) -> str:
    """Instant (<0.1s) Raspberry Pi 5 system status card."""
    sys_data = metrics.get("local_system") or {}
    host = sys_data.get("host") or {}
    cpu = sys_data.get("cpu") or {}
    load = sys_data.get("load") or {}
    mem = sys_data.get("memory") or {}
    swap = sys_data.get("swap") or {}
    fs_list = sys_data.get("filesystems") or []
    nics = sys_data.get("network_interfaces") or []

    lines = [
        f"🍓 <b>Raspberry Pi 5 Telemetry ({html.escape(str(host.get('hostname', 'rpi')))})</b>",
        f"<i>Sync: {html.escape(str(metrics.get('last_updated', 'N/A')))} • Uptime: {html.escape(str(host.get('uptime_human', '--')))}</i>",
        "",
        f"• <b>CPU:</b> {cpu.get('usage_pct', 0)}% @ {cpu.get('freq_mhz', 0)} MHz ({html.escape(str(cpu.get('governor', '')))})",
        f"• <b>Load (1m/5m/15m):</b> {load.get('load_1m', 0)} / {load.get('load_5m', 0)} / {load.get('load_15m', 0)} ({load.get('load_pct', 0)}%)",
        f"• <b>Thermal &amp; Fan:</b> SoC {cpu.get('temperature_c', 'N/A')}°C | RP1 {cpu.get('rp1_temp_c', 'N/A')}°C | Fan {cpu.get('fan_rpm', 'N/A')} RPM",
        f"• <b>Power/Throttle:</b> {html.escape(str(cpu.get('throttled_status', 'OK')))}",
        f"• <b>RAM:</b> {mem.get('usage_pct', 0)}% ({mem.get('used_mb', 0)} / {mem.get('total_mb', 0)} MB, avail {mem.get('available_mb', 0)} MB)",
        f"• <b>Swap:</b> {swap.get('usage_pct', 0)}% ({swap.get('used_mb', 0)} / {swap.get('total_mb', 0)} MB)",
        "",
        "<b>Storage:</b>",
    ]
    for fs in fs_list:
        lines.append(
            f"• <code>{html.escape(str(fs.get('mountpoint')))}</code>: {fs.get('usage_pct')}% ({fs.get('used_gb')}/{fs.get('total_gb')} GB, {fs.get('free_gb')} GB free)"
        )
    lines.append("")
    lines.append("<b>Interfaces:</b>")
    for nic in nics:
        if nic.get("name") in ("eth0", "wlan0"):
            ips = ", ".join(nic.get("ipv4") or ["-"])
            lines.append(
                f"• <code>{html.escape(str(nic.get('name')))}</code> ({nic.get('operstate')}): {html.escape(ips)} | "
                f"↓{nic.get('rx_rate_kbps', 0)} kbps ↑{nic.get('tx_rate_kbps', 0)} kbps | err: {nic.get('rx_errors', 0)}/{nic.get('tx_errors', 0)}"
            )
    return "\n".join(lines)


def format_quick_lan_card(metrics: dict[str, Any]) -> str:
    """Instant (<0.1s) LAN & Wi-Fi inventory card."""
    lan = metrics.get("lan_network") or {}
    s = lan.get("summary") or {}
    devs = lan.get("lan_devices") or []
    wifis = lan.get("wifi_networks") or []

    lines = [
        f"🌐 <b>LAN &amp; Wi-Fi Inventory ({html.escape(str(s.get('subnet', '192.168.1.0/24')))})</b>",
        f"<i>Active Devices: {len(devs)} • Gateway: {html.escape(str(s.get('gateway_ip', '-')))} • Scan: {s.get('scan_duration_ms', 0)} ms</i>",
        "",
        "<b>Discovered LAN Hosts:</b>",
    ]
    for d in devs:
        rtt = f" ({d['rtt_ms']}ms)" if d.get("rtt_ms") is not None else ""
        lines.append(
            f"• <code>{html.escape(str(d.get('ip')))}</code> — <b>{html.escape(str(d.get('hostname', '-')))}</b> "
            f"[{html.escape(str(d.get('vendor', '?')[:22]))}]{rtt}"
        )
    if wifis:
        lines.append("")
        lines.append("<b>Visible Wi-Fi Networks:</b>")
        for w in wifis:
            conn = "🟢" if w.get("connected") else "⚪"
            lines.append(
                f"{conn} <b>{html.escape(str(w.get('ssid')))}</b> ({w.get('band')} Ch {w.get('channel')}) — {w.get('signal_dbm')} dBm ({w.get('signal_pct')}%)"
            )
    return "\n".join(lines)


def format_quick_cf_card(metrics: dict[str, Any]) -> str:
    """Instant (<0.1s) Cloudflare Domains & Quotas card."""
    domains = metrics.get("domains") or {}
    wp = metrics.get("workers_and_pages") or {}
    ai = metrics.get("workers_ai") or {}
    d1b = metrics.get("d1_billing") or {}

    lines = [
        "☁️ <b>Cloudflare Edge Domains &amp; Platform Quotas</b>",
        f"<i>Sync: {html.escape(str(metrics.get('last_updated', 'N/A')))}</i>",
        "",
        "<b>Edge Domains (Past 1h):</b>",
    ]
    for dname, dm in domains.items():
        icon = "🟢" if dm.get("status") == "HEALTHY" and (dm.get("errors_5xx") or 0) == 0 else "🟠"
        lines.append(
            f"{icon} <b>{html.escape(dname)}</b>: {dm.get('status')} | {dm.get('hit_volume', 0)} reqs | "
            f"CHR {dm.get('cache_hit_ratio', 0)}% | 5xx: <b>{dm.get('errors_5xx', 0)}</b> | Threats: {dm.get('security_events', 0)}"
        )
    lines.extend([
        "",
        "<b>Account Free-Tier Quotas &amp; MTD Usage:</b>",
        f"• <b>Workers Reqs (Today):</b> {wp.get('daily_requests', 0):,} / {wp.get('daily_requests_limit', 100000):,} ({wp.get('daily_requests_pct', 0)}%)",
        f"• <b>Workers MTD:</b> {wp.get('mtd_worker_requests', 0):,} reqs | {wp.get('mtd_errors', 0)} errors | {wp.get('mtd_assets_requests', 0):,} static assets",
        f"• <b>Workers AI (Today):</b> {ai.get('daily_neurons', 0)} / {ai.get('daily_neurons_limit', 10000):,} neurons ({ai.get('daily_neurons_pct', 0)}%)",
        f"• <b>D1 SQL (Today):</b> Read {d1b.get('daily_rows_read', 0):,} ({d1b.get('daily_rows_read_pct', 0)}%) | Write {d1b.get('daily_rows_written', 0):,} ({d1b.get('daily_rows_written_pct', 0)}%)",
        f"• <b>D1 Storage:</b> {d1b.get('total_storage_mb', 0)} MB / {d1b.get('account_storage_limit_mb', 5000)} MB ({d1b.get('account_storage_pct', 0)}%)",
    ])
    return "\n".join(lines)


def parse_incoming_trigger(msg: dict[str, Any]) -> tuple[str | None, str]:
    """
    Determines if an incoming Telegram message should be handled and how.
    Supported triggers:
      - In direct 1-on-1 private chat: ANY message (plain text or command)
      - In groups/channels:
          * Slash commands (`/status`, `/pi`, `/lan`, `/cf`, `/ask`, `/gemma`, `/analyze`, `/help`)
          * Mentioning `@minkalab_alert_bot` or `@gemma`
          * Hashtags `#gemma` or `#noc`
          * Replying to a message sent by `@minkalab_alert_bot`
    Returns (action_type, cleaned_query).
    """
    text = (msg.get("text") or msg.get("caption") or "").strip()
    if not text:
        return None, ""

    chat = msg.get("chat") or {}
    chat_type = chat.get("type", "private")
    is_private = chat_type == "private"

    reply_to = msg.get("reply_to_message") or {}
    reply_from = reply_to.get("from") or {}
    is_reply_to_bot = bool(
        reply_from.get("is_bot")
        and (
            str(reply_from.get("username", "")).lower() == BOT_USERNAME.lower()
            or str(reply_from.get("id", "")) == TELEGRAM_BOT_TOKEN.split(":")[0]
        )
    )

    # Check slash commands first
    m_cmd = re.match(r"^/([a-zA-Z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$", text, flags=re.DOTALL)
    if m_cmd:
        cmd = m_cmd.group(1).lower()
        arg = (m_cmd.group(2) or "").strip()
        if cmd in ("start", "help"):
            return "HELP", ""
        if cmd == "status":
            return "STATUS", arg
        if cmd in ("snooze", "silence", "mute"):
            return "SNOOZE", arg
        if cmd in ("unsnooze", "unmute", "resume"):
            return "UNSNOOZE", arg
        if cmd in ("pi", "system", "host"):
            return "PI", arg
        if cmd in ("lan", "wifi", "network"):
            return "LAN", arg
        if cmd in ("cf", "cloudflare", "domains"):
            return "CF", arg
        if cmd in ("analyze", "report"):
            return "ANALYZE", arg
        if cmd in ("ask", "gemma", "chat"):
            return "CHAT", arg or "Give me a current status summary of all monitored systems."

    # Check natural language snooze commands: e.g., "snooze 1 for 24h", "snooze 5xx 72 hours", "snooze assessment for 7 days"
    m_snz_nl = re.match(
        r"^(?:please\s+)?(?:snooze|silence|mute)\s+(.+?)(?:\s+for\s+|\s+)(\d+\s*(?:h|hr|hrs|hours|hour|d|day|days|w|week|weeks))?$",
        text,
        flags=re.IGNORECASE,
    )
    if m_snz_nl:
        target = m_snz_nl.group(1).strip()
        dur = (m_snz_nl.group(2) or "24h").strip()
        return "SNOOZE", f"{target} {dur}"

    m_unsnz_nl = re.match(
        r"^(?:please\s+)?(?:unsnooze|unmute|reactivate)\s*(.*)$",
        text,
        flags=re.IGNORECASE,
    )
    if m_unsnz_nl:
        return "UNSNOOZE", (m_unsnz_nl.group(1) or "").strip()

    # Check mentions & hashtags (#gemma, #noc, @minkalab_alert_bot, @gemma)
    mention_pattern = rf"(?:@{re.escape(BOT_USERNAME)}|@gemma4?|#gemma4?|#noc)\b"
    if re.search(mention_pattern, text, flags=re.IGNORECASE):
        cleaned = re.sub(mention_pattern, "", text, flags=re.IGNORECASE).strip(" :,-")
        return "CHAT", cleaned or "What is the current status of the Pi and NOC dashboard?"

    # If in private chat or replying to a bot message, treat any plain text as a direct chat question to Gemma 4
    if is_private or is_reply_to_bot:
        return "CHAT", text

    return None, ""


def handle_snooze_command(query: str, chat_id: str | int, msg_id: int | None = None) -> None:
    """Handles the /snooze slash command or chat trigger."""
    query = query.strip()
    metrics = load_json_file(METRICS_PATH, default={}) or {}
    state = load_json_file(STATE_FILE_PATH, default={}) or {}
    now_ts = time.time()

    if query:
        parts = query.split()
        target = parts[0]
        dur = parts[1] if len(parts) > 1 else "24h"

        if target.lower() in ("all", "*"):
            raw, _, _ = evaluate_telemetry(metrics, {**state, "snoozed_anomalies": {}})
            count = 0
            for a in raw:
                snooze_anomaly_by_key(a["key"], dur, source=f"tg_{chat_id}")
                count += 1
            send_telegram_message(
                f"💤 <b>Snoozed All Findings ({dur})</b>\nSnoozed <b>{count}</b> active finding(s) for <b>{dur}</b>.",
                chat_id=chat_id,
                reply_to_message_id=msg_id,
            )
            return

        try:
            res = snooze_anomaly_by_key(target, dur, source=f"tg_{chat_id}")
            send_telegram_message(
                f"💤 <b>Assessment Snoozed ({res['duration_label']})</b>\n"
                f"• <b>{html.escape(res['title'])}</b>\n"
                f"<i>Detail: {html.escape(res.get('detail', ''))}</i>\n"
                f"<i>Silenced until: {res['snoozed_until_utc']}</i>",
                chat_id=chat_id,
                reply_to_message_id=msg_id,
            )
            return
        except Exception as e:
            send_telegram_message(
                f"⚠️ <b>Snooze Error:</b> {html.escape(str(e))}\n\n"
                f"<b>Supported Durations:</b> <code>24h</code> (24 hours), <code>72h</code> (72 hours), or <code>7d</code> (7 days)\n"
                f"<b>Example:</b> <code>/snooze 1 24h</code> or <code>/snooze all 72h</code>",
                chat_id=chat_id,
                reply_to_message_id=msg_id,
            )
            return

    # No query: Interactive menu
    raw, _, _ = evaluate_telemetry(metrics, {**state, "snoozed_anomalies": {}})
    snoozes = dict(state.get("snoozed_anomalies") or {})
    valid_snoozes = []
    for k, s in snoozes.items():
        if float(s.get("snoozed_until_ts") or 0) > now_ts:
            rem = float(s["snoozed_until_ts"]) - now_ts
            s["remaining_human"] = format_duration_human(rem)
            valid_snoozes.append(s)

    lines = ["💤 <b>Gemma 4 Assessment Snooze Manager</b>", ""]
    if raw:
        lines.append(f"<b>Active Findings ({len(raw)}):</b>")
        for idx, a in enumerate(raw, 1):
            icon = "🔴" if a.get("severity") == "CRITICAL" else "🟡"
            lines.append(f"{idx}. {icon} <b>{html.escape(a['title'])}</b>")
            lines.append(f"   <i>{html.escape(a['detail'])}</i>")
        lines.append("\n<i>Tap a button below to snooze for 24h, 72h, or 7 days:</i>")
    else:
        lines.append("🟢 <b>All Active Systems Nominal</b> — 0 active findings to snooze.")

    if valid_snoozes:
        lines.append(f"\n<b>Currently Snoozed Findings ({len(valid_snoozes)}):</b>")
        for s in valid_snoozes:
            lines.append(
                f"• 💤 <b>{html.escape(s['title'])}</b> "
                f"(<b>{s.get('duration_str', '24h')}</b> • {s['remaining_human']} left, expires {s.get('snoozed_until_utc', '')})"
            )

    lines.append("\n💡 <i>Commands: <code>/snooze 1 24h</code> • <code>/snooze 1 72h</code> • <code>/snooze 1 7d</code> • <code>/unsnooze 1</code></i>")
    markup = build_snooze_inline_keyboard(raw, valid_snoozes)
    send_telegram_message(
        "\n".join(lines),
        chat_id=chat_id,
        reply_to_message_id=msg_id,
        reply_markup=markup,
    )


def handle_unsnooze_command(query: str, chat_id: str | int, msg_id: int | None = None) -> None:
    """Handles the /unsnooze slash command."""
    query = query.strip()
    state = load_json_file(STATE_FILE_PATH, default={}) or {}
    snoozes = dict(state.get("snoozed_anomalies") or {})
    if not snoozes:
        send_telegram_message(
            "ℹ️ No findings are currently snoozed.",
            chat_id=chat_id,
            reply_to_message_id=msg_id,
        )
        return

    if query:
        res = unsnooze_anomaly_by_key(query)
        if res:
            titles = ", ".join(r.get("title", r.get("key")) for r in res)
            send_telegram_message(
                f"🔔 <b>Assessment(s) Unsnoozed</b>\n<b>{html.escape(titles)}</b> reactivated and alerting normally.",
                chat_id=chat_id,
                reply_to_message_id=msg_id,
            )
        else:
            send_telegram_message(
                f"⚠️ Could not find snoozed finding matching '{html.escape(query)}'.\nUse <code>/unsnooze</code> to see all snoozed items.",
                chat_id=chat_id,
                reply_to_message_id=msg_id,
            )
        return

    now_ts = time.time()
    valid_snoozes = []
    for k, s in snoozes.items():
        if float(s.get("snoozed_until_ts") or 0) > now_ts:
            rem = float(s["snoozed_until_ts"]) - now_ts
            s["remaining_human"] = format_duration_human(rem)
            valid_snoozes.append(s)

    lines = ["🔔 <b>Snoozed Findings Management</b>", ""]
    buttons = []
    for idx, s in enumerate(valid_snoozes, 1):
        lines.append(
            f"{idx}. 💤 <b>{html.escape(s['title'])}</b> "
            f"({s.get('duration_str')} • {s.get('remaining_human')} left, expires {s.get('snoozed_until_utc')})"
        )
        short_k = get_short_key(s["key"])
        stitle = s.get("title", f"#{idx}")
        if len(stitle) > 20:
            stitle = stitle[:19] + "…"
        buttons.append([
            {"text": f"❌ Unsnooze: {stitle}", "callback_data": f"unsnz:{short_k}"}
        ])

    if len(valid_snoozes) > 1:
        buttons.append([{"text": "❌ Unsnooze All", "callback_data": "unsnz:all"}])

    lines.append("\n<i>Tap a button or type <code>/unsnooze &lt;number&gt;</code> to reactivate:</i>")
    send_telegram_message(
        "\n".join(lines),
        chat_id=chat_id,
        reply_to_message_id=msg_id,
        reply_markup={"inline_keyboard": buttons} if buttons else None,
    )


def handle_telegram_callback_query(cq: dict[str, Any]) -> None:
    """Handles interactive inline keyboard button taps from Telegram."""
    cq_id = cq.get("id")
    sender = cq.get("from") or {}
    sender_id = str(sender.get("id", ""))
    msg = cq.get("message") or {}
    chat = msg.get("chat") or {}
    chat_id = str(chat.get("id", ""))

    if TELEGRAM_CHAT_ID and sender_id != str(TELEGRAM_CHAT_ID) and chat_id != str(TELEGRAM_CHAT_ID):
        telegram_api_call("answerCallbackQuery", {
            "callback_query_id": cq_id,
            "text": "Unauthorized",
            "show_alert": True,
        })
        return

    data = str(cq.get("data") or "")
    print(f"[GemmaNOC] Telegram Callback Query received: data={data!r}")

    if data.startswith("snz_all:"):
        dur = data.split(":", 1)[1]
        metrics = load_json_file(METRICS_PATH, default={}) or {}
        st = load_json_file(STATE_FILE_PATH, default={}) or {}
        raw, _, _ = evaluate_telemetry(metrics, {**st, "snoozed_anomalies": {}})
        count = 0
        for a in raw:
            snooze_anomaly_by_key(a["key"], dur, source=f"tg_{sender_id}")
            count += 1
        telegram_api_call("answerCallbackQuery", {
            "callback_query_id": cq_id,
            "text": f"💤 Snoozed all {count} active finding(s) for {dur}!",
            "show_alert": False,
        })
        send_telegram_message(
            f"💤 <b>All Findings Snoozed ({dur})</b>\nSnoozed <b>{count}</b> active findings for <b>{dur}</b>.",
            chat_id=chat_id,
        )
        return

    if data.startswith("snz:"):
        parts = data.split(":")
        if len(parts) >= 3:
            key_hash = parts[1]
            dur = parts[2]
            key = resolve_key(key_hash)
            try:
                res = snooze_anomaly_by_key(key, dur, source=f"tg_{sender_id}")
                telegram_api_call("answerCallbackQuery", {
                    "callback_query_id": cq_id,
                    "text": f"💤 Snoozed for {res['duration_label']}!",
                    "show_alert": False,
                })
                conf_html = (
                    f"💤 <b>Assessment Snoozed ({res['duration_label']})</b>\n"
                    f"• <b>{html.escape(res['title'])}</b>\n"
                    f"<i>Silenced until {res['snoozed_until_utc']}</i>"
                )
                send_telegram_message(conf_html, chat_id=chat_id)
            except Exception as e:
                telegram_api_call("answerCallbackQuery", {
                    "callback_query_id": cq_id,
                    "text": f"Error: {e}",
                    "show_alert": True,
                })
        return

    if data.startswith("unsnz:"):
        key_hash = data.split(":", 1)[1]
        if key_hash == "all":
            res = unsnooze_anomaly_by_key("all")
            telegram_api_call("answerCallbackQuery", {
                "callback_query_id": cq_id,
                "text": f"Unsnoozed all ({len(res)}) findings!",
                "show_alert": False,
            })
            send_telegram_message(
                f"🔔 <b>All Assessments Unsnoozed</b>\nReactivated <b>{len(res)}</b> snoozed finding(s).",
                chat_id=chat_id,
            )
            return

        key = resolve_key(key_hash)
        res = unsnooze_anomaly_by_key(key)
        if res:
            title = res[0].get("title", key)
            telegram_api_call("answerCallbackQuery", {
                "callback_query_id": cq_id,
                "text": "Unsnoozed!",
                "show_alert": False,
            })
            send_telegram_message(
                f"🔔 <b>Assessment Unsnoozed</b>\n<b>{html.escape(title)}</b> is now active and alerting normally.",
                chat_id=chat_id,
            )
        else:
            telegram_api_call("answerCallbackQuery", {
                "callback_query_id": cq_id,
                "text": "Item not found in active snoozes",
                "show_alert": True,
            })
        return


def handle_telegram_message(msg: dict[str, Any]) -> None:
    """Processes an authorized incoming Telegram message or command."""
    chat = msg.get("chat") or {}
    chat_id = str(chat.get("id", ""))
    sender = msg.get("from") or {}
    sender_id = str(sender.get("id", ""))
    msg_id = msg.get("message_id")

    # Security check: only respond to authorized TELEGRAM_CHAT_ID
    if TELEGRAM_CHAT_ID and chat_id != str(TELEGRAM_CHAT_ID) and sender_id != str(TELEGRAM_CHAT_ID):
        print(f"[GemmaNOC] Ignoring message from unauthorized chat_id={chat_id} sender_id={sender_id}")
        return

    action, query = parse_incoming_trigger(msg)
    if not action:
        return

    print(f"[GemmaNOC] Telegram trigger: action={action} query={query!r}")
    metrics = load_json_file(METRICS_PATH, default={}) or {}
    prev_state = load_json_file(STATE_FILE_PATH, default={}) or {}

    if action == "HELP":
        help_html = (
            "🤖 <b>Gemma 4 LiteRT-LM NOC Bot (@minkalab_alert_bot)</b>\n\n"
            "<b>How to chat with Gemma 4:</b>\n"
            "• <b>Direct Chat:</b> Just send any message in plain text!\n"
            "• <b>Mentions / Hashtags:</b> Use <code>#gemma</code>, <code>#noc</code>, or <code>@minkalab_alert_bot</code> in any message, or reply to any alert.\n\n"
            "<b>Instant Commands:</b>\n"
            "• /status — Instant NOC snapshot + latest Gemma 4 assessment\n"
            "• /snooze — Snooze active findings one by one (24h, 72h, or 7 days)\n"
            "• /unsnooze — Reactivate snoozed assessments\n"
            "• /pi — Raspberry Pi 5 CPU, SoC/RP1 temp, fan, RAM &amp; storage\n"
            "• /lan — Active LAN hosts &amp; Wi-Fi spectrum inventory\n"
            "• /cf — Cloudflare domains, 5xx errors &amp; Workers/AI/D1 quotas\n"
            "• /ask <i>&lt;question&gt;</i> — Ask Gemma 4 anything with live NOC telemetry\n"
            "• /analyze — Run a fresh Gemma 4 AI analysis cycle right now\n\n"
            "<b>Snoozing Findings:</b>\n"
            "• Tap the <b>[24h] [72h] [7d]</b> inline buttons on any alert\n"
            "• Or type <code>/snooze 1 24h</code>, <code>/snooze 5xx 72h</code>, or <code>/snooze all 7d</code>"
        )
        send_telegram_message(help_html, chat_id=chat_id, reply_to_message_id=msg_id)
        return

    if action == "SNOOZE":
        handle_snooze_command(query, chat_id=chat_id, msg_id=msg_id)
        return

    if action == "UNSNOOZE":
        handle_unsnooze_command(query, chat_id=chat_id, msg_id=msg_id)
        return

    if action == "PI":
        send_telegram_message(format_quick_pi_card(metrics), chat_id=chat_id, reply_to_message_id=msg_id)
        return

    if action == "LAN":
        send_telegram_message(format_quick_lan_card(metrics), chat_id=chat_id, reply_to_message_id=msg_id)
        return

    if action == "CF":
        send_telegram_message(format_quick_cf_card(metrics), chat_id=chat_id, reply_to_message_id=msg_id)
        return

    if action == "STATUS" and not query:
        anomalies, state_updates, _ = evaluate_telemetry(metrics, prev_state)
        snoozed_dict = dict(state_updates.get("snoozed_anomalies") or prev_state.get("snoozed_anomalies") or {})
        snoozed_list = list(snoozed_dict.values())
        now_ts = time.time()
        for s in snoozed_list:
            rem = float(s.get("snoozed_until_ts") or 0.0) - now_ts
            s["remaining_human"] = format_duration_human(rem)

        last_analysis = prev_state.get("last_gemma_analysis", "No cached analysis yet. Send /analyze to run Gemma 4.")
        last_sec = float(prev_state.get("last_inference_sec") or 0.0)
        html_out = format_telegram_html(metrics, anomalies, "STATUS_CHECK", last_analysis, last_sec, snoozed=snoozed_list)
        markup = build_snooze_inline_keyboard(anomalies, snoozed_list)
        send_telegram_message(html_out, chat_id=chat_id, reply_to_message_id=msg_id, reply_markup=markup)
        return

    if action == "ANALYZE":
        _, _, placeholder_id = send_telegram_message(
            "⏳ <b>Gemma 4 E2B</b> is running a fresh NOC telemetry analysis on Raspberry Pi 5...",
            chat_id=chat_id,
            reply_to_message_id=msg_id,
        )
        run_cycle(force_telegram=True)
        if placeholder_id:
            telegram_api_call("deleteMessage", {"chat_id": chat_id, "message_id": placeholder_id}, timeout=5)
        return

    # Interactive CHAT with Gemma 4 (with live telemetry context)
    question = query or "Give me a summary of the current NOC status."
    telegram_api_call("sendChatAction", {"chat_id": chat_id, "action": "typing"}, timeout=5)
    _, _, placeholder_id = send_telegram_message(
        f"🤖 <i>Gemma 4 E2B is thinking on Raspberry Pi 5...</i>\n<code>Q: {html.escape(question[:120])}</code>",
        chat_id=chat_id,
        reply_to_message_id=msg_id,
    )

    _, _, compact_brief = evaluate_telemetry(metrics, prev_state)
    try:
        answer, elapsed_s = run_gemma4_chat_reply(question, compact_brief)
        reply_html = (
            f"🤖 <b>Gemma 4 NOC Assistant</b> <i>({elapsed_s}s on LiteRT-LM)</i>\n\n"
            f"{html.escape(answer)}\n\n"
            f"<i>Telemetry sync: {html.escape(str(metrics.get('last_updated', 'N/A')))}</i>"
        )
    except Exception as e:
        reply_html = f"⚠️ <b>Gemma 4 Inference Error:</b> <code>{html.escape(str(e))}</code>"

    if placeholder_id:
        if not edit_telegram_message(chat_id, placeholder_id, reply_html):
            send_telegram_message(reply_html, chat_id=chat_id, reply_to_message_id=msg_id)
    else:
        send_telegram_message(reply_html, chat_id=chat_id, reply_to_message_id=msg_id)


# =====================================================================
# MAIN MONITORING CYCLE & BOT LONG-POLLING LOOP
# =====================================================================

def run_cycle(
    *,
    force_telegram: bool = False,
    analyze_always: bool = False,
    dry_run: bool = False,
) -> int:
    """Executes one complete monitoring, Gemma 4 analysis, and alerting cycle."""
    metrics = load_json_file(METRICS_PATH)
    if not metrics or not isinstance(metrics, dict):
        err_msg = f"CRITICAL: Unable to read valid JSON from {METRICS_PATH}"
        print(err_msg, file=sys.stderr)
        if not dry_run:
            send_telegram_message(f"🚨 <b>NOC MONITOR ERROR</b>\n{html.escape(err_msg)}")
        return 1

    prev_state = load_json_file(STATE_FILE_PATH, default={}) or {}
    anomalies, state_updates, compact_brief = evaluate_telemetry(metrics, prev_state)

    should_notify, reason_code, triggered_anomalies = decide_notification_action(
        anomalies=anomalies,
        prev_state=prev_state,
        force_telegram=force_telegram,
    )

    now_ts = time.time()
    now_utc_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    local_today_str = datetime.now().astimezone().strftime("%Y-%m-%d")

    gemma_analysis = prev_state.get("last_gemma_analysis", "")
    inference_sec = float(prev_state.get("last_inference_sec") or 0.0)
    last_llm_ts = float(prev_state.get("last_llm_ts") or 0.0)
    dashboard_refresh_due = (now_ts - last_llm_ts) >= 3600

    run_llm = should_notify or analyze_always or dry_run or not gemma_analysis or dashboard_refresh_due
    if run_llm:
        try:
            print(f"[GemmaNOC] Running LiteRT-LM Gemma 4 analysis (reason={reason_code})...")
            gemma_analysis, inference_sec = run_gemma4_analysis(compact_brief, reason_code)
            last_llm_ts = now_ts
            print(f"[GemmaNOC] Analysis completed in {inference_sec}s:\n{gemma_analysis}\n")
        except Exception as e:
            print(f"[GemmaNOC] LiteRT-LM Error: {e}", file=sys.stderr)
            gemma_analysis = (
                f"Automated rule engine detected {len(anomalies)} finding(s). "
                f"(LiteRT-LM inference fallback: {e})"
            )
            inference_sec = 0.0
    else:
        print(
            f"[GemmaNOC] No new alert or state change (reason={reason_code}, "
            f"active_anomalies={len(anomalies)}). Reusing recent Gemma 4 analysis."
        )

    telegram_status = "Skipped (no alert trigger)"
    snoozed_dict = dict(state_updates.get("snoozed_anomalies") or prev_state.get("snoozed_anomalies") or {})
    snoozed_list = list(snoozed_dict.values())
    for s in snoozed_list:
        rem_s = float(s.get("snoozed_until_ts") or 0.0) - now_ts
        s["remaining_human"] = format_duration_human(rem_s)

    if should_notify:
        msg_html = format_telegram_html(
            metrics=metrics,
            anomalies=anomalies,
            reason_code=reason_code,
            gemma_analysis=gemma_analysis,
            inference_sec=inference_sec,
            snoozed=snoozed_list,
        )
        markup = build_snooze_inline_keyboard(anomalies, snoozed_list)
        if dry_run:
            print("[GemmaNOC] --- DRY RUN TELEGRAM PAYLOAD ---")
            print(msg_html)
            print("[GemmaNOC] --------------------------------")
            telegram_status = "Dry-run (not sent)"
        else:
            ok, detail, _ = send_telegram_message(msg_html, reply_markup=markup)
            telegram_status = detail
            print(f"[GemmaNOC] Telegram dispatch ({reason_code}): ok={ok} ({detail})")

    prev_active: dict[str, dict[str, Any]] = dict(prev_state.get("active_alerts") or {})
    new_active: dict[str, dict[str, Any]] = {}
    triggered_keys = {a["key"] for a in triggered_anomalies}

    for a in anomalies:
        key = a["key"]
        prev_entry = prev_active.get(key, {})
        sent_ts = (
            now_ts
            if (should_notify and not dry_run and (key in triggered_keys or force_telegram))
            else float(prev_entry.get("last_sent_ts") or now_ts)
        )
        new_active[key] = {
            "severity": a["severity"],
            "title": a["title"],
            "detail": a["detail"],
            "first_seen_ts": float(prev_entry.get("first_seen_ts") or now_ts),
            "last_sent_ts": sent_ts,
        }

    # Re-read state right before saving so we preserve `telegram_update_offset` if updated
    latest_disk_state = load_json_file(STATE_FILE_PATH, default={}) or {}
    next_state = {
        **prev_state,
        **latest_disk_state,
        **state_updates,
        "last_check_utc": now_utc_str,
        "last_reason_code": reason_code,
        "last_telegram_status": telegram_status,
        "last_gemma_analysis": gemma_analysis,
        "last_inference_sec": inference_sec,
        "last_llm_ts": last_llm_ts,
        "active_alerts": new_active,
        "snoozed_anomalies": snoozed_dict,
        "last_daily_digest_date": (
            local_today_str
            if (should_notify and not dry_run and reason_code in ("DAILY_DIGEST", "MANUAL_REPORT"))
            else prev_state.get("last_daily_digest_date", "")
        ),
    }

    if not dry_run:
        try:
            write_json_atomic(STATE_FILE_PATH, next_state)
        except Exception as e:
            print(f"[GemmaNOC] Warning: could not save state file {STATE_FILE_PATH}: {e}", file=sys.stderr)

    ai_public_payload = {
        "last_analyzed_utc": now_utc_str,
        "metrics_sync_utc": metrics.get("last_updated", ""),
        "model": "google/gemma-4-E2B-it (LiteRT-LM)",
        "inference_duration_sec": inference_sec,
        "overall_status": (
            "CRITICAL"
            if any(a["severity"] == "CRITICAL" for a in anomalies)
            else ("WARNING" if anomalies else "HEALTHY")
        ),
        "reason_code": reason_code,
        "telegram_status": telegram_status,
        "anomalies_count": len(anomalies),
        "anomalies": anomalies,
        "snoozed_count": len(snoozed_list),
        "snoozed_anomalies": snoozed_list,
        "analysis": gemma_analysis,
    }
    try:
        write_json_atomic(AI_ANALYSIS_OUTPUT_PATH, ai_public_payload)
    except Exception as e:
        print(f"[GemmaNOC] Warning: could not write {AI_ANALYSIS_OUTPUT_PATH}: {e}", file=sys.stderr)

    return 0


def run_bot_and_monitor_daemon(interval_sec: int = 900) -> None:
    """
    Runs the unified Telegram Bot listener (long-polling `getUpdates`) and
    periodic 15-minute NOC telemetry evaluator in a single lightweight process.
    """
    print(f"[GemmaNOC] Starting Telegram Bot (@{BOT_USERNAME}) + {interval_sec}s NOC Monitor Daemon...")
    register_bot_commands()
    start_snooze_api_server(port=8088)

    state = load_json_file(STATE_FILE_PATH, default={}) or {}
    offset = int(state.get("telegram_update_offset") or 0)
    last_monitor_ts = float(state.get("last_llm_ts") or 0.0)

    # If more than interval_sec has passed since last check, run immediately on startup
    if (time.time() - last_monitor_ts) >= interval_sec:
        try:
            run_cycle()
        except Exception as e:
            print(f"[GemmaNOC] Initial cycle error: {e}", file=sys.stderr)
        last_monitor_ts = time.time()

    while True:
        now = time.time()
        if (now - last_monitor_ts) >= interval_sec:
            try:
                run_cycle()
            except Exception as e:
                print(f"[GemmaNOC] Scheduled cycle error: {e}", file=sys.stderr)
            last_monitor_ts = time.time()

        # Long-poll Telegram getUpdates for up to 20s
        poll_timeout = min(20, max(1, int(interval_sec - (time.time() - last_monitor_ts))))
        resp = telegram_api_call(
            "getUpdates",
            {
                "offset": offset,
                "timeout": poll_timeout,
                "allowed_updates": ["message", "channel_post", "callback_query"],
            },
            timeout=poll_timeout + 10,
        )

        if resp.get("ok"):
            updates = resp.get("result") or []
            for upd in updates:
                upd_id = int(upd.get("update_id", 0))
                if upd_id >= offset:
                    offset = upd_id + 1
                    st = load_json_file(STATE_FILE_PATH, default={}) or {}
                    st["telegram_update_offset"] = offset
                    try:
                        write_json_atomic(STATE_FILE_PATH, st)
                    except Exception:
                        pass

                # Handle callback_query (interactive inline buttons)
                cb_obj = upd.get("callback_query")
                if cb_obj:
                    try:
                        handle_telegram_callback_query(cb_obj)
                    except Exception as e:
                        print(f"[GemmaNOC] Error handling Telegram callback query: {e}", file=sys.stderr)

                msg_obj = upd.get("message") or upd.get("channel_post")
                if msg_obj:
                    try:
                        handle_telegram_message(msg_obj)
                    except Exception as e:
                        print(f"[GemmaNOC] Error handling Telegram message: {e}", file=sys.stderr)
        else:
            time.sleep(5)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Gemma 4 Edge NOC Monitor, Interactive Telegram Bot & Smart Alerter"
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run a single monitoring check and exit.",
    )
    parser.add_argument(
        "--daemon",
        action="store_true",
        help="Run continuous Telegram Bot chat listener + 15-minute NOC monitor loop.",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=MONITOR_INTERVAL_SECONDS,
        help="NOC check interval in seconds when --daemon is used (default: 900s / 15m).",
    )
    parser.add_argument(
        "--force-telegram",
        action="store_true",
        help="Force Gemma 4 analysis and dispatch a Telegram report immediately.",
    )
    parser.add_argument(
        "--analyze-always",
        action="store_true",
        help="Always run Gemma 4 inference to refresh ai_analysis.json even if Telegram is on cooldown.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run Gemma 4 analysis and print output without sending Telegram messages or mutating state.",
    )
    parser.add_argument(
        "--snooze",
        nargs="+",
        metavar=("KEY", "DURATION"),
        help="Snooze a finding: --snooze <key_or_idx> [24h|72h|7d]",
    )
    parser.add_argument(
        "--unsnooze",
        metavar="KEY",
        help="Unsnooze a finding: --unsnooze <key_or_idx|all>",
    )
    parser.add_argument(
        "--list-snoozes",
        action="store_true",
        help="List all currently snoozed assessments and findings.",
    )
    parser.add_argument(
        "--llm-worker",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    args = parser.parse_args()

    # CLI snooze commands
    if args.snooze:
        key = args.snooze[0]
        dur = args.snooze[1] if len(args.snooze) > 1 else "24h"
        try:
            res = snooze_anomaly_by_key(key, dur, source="cli")
            print(f"✅ Successfully snoozed '{res['title']}' for {res['duration_label']} (until {res['snoozed_until_utc']})")
        except Exception as e:
            print(f"❌ Error: {e}", file=sys.stderr)
            sys.exit(1)
        return

    if args.unsnooze:
        removed = unsnooze_anomaly_by_key(args.unsnooze)
        if removed:
            print(f"✅ Unsnoozed {len(removed)} finding(s):")
            for r in removed:
                print(f"   • {r.get('title', r.get('key'))}")
        else:
            print(f"ℹ️ No active snooze found matching '{args.unsnooze}'")
        return

    if args.list_snoozes:
        st = load_json_file(STATE_FILE_PATH, default={}) or {}
        snoozes = list((st.get("snoozed_anomalies") or {}).values())
        now_ts = time.time()
        print(f"--- Current Snoozed Findings ({len(snoozes)}) ---")
        for idx, s in enumerate(snoozes, 1):
            rem = float(s.get("snoozed_until_ts") or 0.0) - now_ts
            print(f"{idx}. {s.get('title')} [{s.get('key')}]")
            print(f"   Duration: {s.get('duration_label')} | Remaining: {format_duration_human(rem)} | Expires: {s.get('snoozed_until_utc')}")
        return

    # Internal child worker mode for isolated LiteRT-LM execution
    if args.llm_worker:
        req = json.loads(sys.stdin.read())
        text, elapsed_s = _llm_worker_execute(
            req["system_instruction"],
            req["prompt"],
            int(req.get("max_output_tokens", 280)),
        )
        print(json.dumps({"text": text, "elapsed_s": elapsed_s}))
        return

    if args.daemon:
        lock_path = "/run/gemma-noc-daemon.lock" if os.path.isdir("/run") else "/tmp/gemma-noc-daemon.lock"
        lock_file = open(lock_path, "w", encoding="utf-8")
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("[GemmaNOC] Daemon is already running. Exiting.")
            sys.exit(0)
        run_bot_and_monitor_daemon(interval_sec=max(60, args.interval))
    else:
        sys.exit(
            run_cycle(
                force_telegram=args.force_telegram,
                analyze_always=args.analyze_always,
                dry_run=args.dry_run,
            )
        )


if __name__ == "__main__":
    main()
