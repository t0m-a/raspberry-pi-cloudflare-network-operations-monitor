#!/usr/bin/env python3
"""
Raspberry Pi 5 15-Minute NOC Telemetry Reporter & ESP-32S LAN Prober
====================================================================
Collects:
  1. Complete Raspberry Pi 5 system vitals (CPU, per-core, freq, load, SoC/RP1 temps,
     PWM fan RPM, core voltage, vcgencmd throttling flags, RAM/Swap, filesystems+inodes,
     network interfaces, Wi-Fi link stats, gateway RTT)
  2. Qdrant Vector DB live status (version, healthz, collection status,
     points/indexed/segments, optimizer, disk MB, API latency, container RSS)
  3. Gemini Brain Edge Sync status (gemini-brain-watcher systemd unit, SQLite sync_state.db
     chunk counts & breakdown, last Qdrant federation pass, recent errors, brain.tsimon.me uplink)
  4. Critical Services status (systemd units, timers, Docker containers with /proc RSS)
  5. ESP-32S Out-of-Band Watchdog LAN probe (ICMP ping x5, RTT min/avg/max/jitter, loss %,
     TTL, ARP state, MAC auto-discovery, plus optional local http://<esp32>/metrics fetch)

Pushes JSON atomically to:
  POST https://noc-hook.tsimon.me/api/ingest/rpi5
  Authorization: Bearer <NOC_INGEST_TOKEN>

Zero external Python dependencies (Python 3 standard library only).
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

AGENT_VERSION = "1.0.0"
DEFAULT_ENV_FILE = "/etc/noc-agent/reporter.env"
DEFAULT_INGEST_URL = "https://noc-hook.tsimon.me/api/ingest/rpi5"
DEFAULT_ESP32_IP = "192.168.1.125"
DEFAULT_ESP32_MAC = "28:05:A5:E2:96:2C"


def utc_now_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def load_env_file(path: str) -> dict[str, str]:
    vals: dict[str, str] = {}
    p = Path(path)
    if not p.is_file():
        return vals
    try:
        for raw in p.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k:
                vals[k] = v
    except OSError:
        pass
    return vals


def run_cmd(cmd: list[str], timeout: float = 5.0) -> tuple[int, str, str]:
    try:
        cp = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return cp.returncode, cp.stdout.strip(), cp.stderr.strip()
    except Exception as exc:
        return -1, "", str(exc)


def format_uptime(seconds: float) -> str:
    s = max(0, int(seconds))
    days, rem = divmod(s, 86400)
    hours, rem = divmod(rem, 3600)
    mins, _ = divmod(rem, 60)
    parts: list[str] = []
    if days > 0:
        parts.append(f"{days}d")
    if hours > 0 or days > 0:
        parts.append(f"{hours}h")
    parts.append(f"{mins}m")
    return " ".join(parts)


def read_pid_rss_mb(pid: int | None) -> float | None:
    if not pid or pid <= 0:
        return None
    try:
        txt = Path(f"/proc/{pid}/status").read_text(encoding="utf-8", errors="replace")
        m = re.search(r"^VmRSS:\s+(\d+)\s+kB", txt, re.M)
        if m:
            return round(int(m.group(1)) / 1024.0, 1)
    except OSError:
        pass
    return None


def read_container_total_rss_mb(container_name: str) -> float | None:
    rc, out, _ = run_cmd(["docker", "top", container_name, "-eo", "pid"], timeout=4.0)
    if rc != 0 or not out:
        return None
    total_kb = 0
    found = False
    for line in out.splitlines()[1:]:
        s = line.strip()
        if not s.isdigit():
            continue
        try:
            txt = Path(f"/proc/{s}/status").read_text(encoding="utf-8", errors="replace")
            m = re.search(r"^VmRSS:\s+(\d+)\s+kB", txt, re.M)
            if m:
                total_kb += int(m.group(1))
                found = True
        except OSError:
            pass
    return round(total_kb / 1024.0, 1) if found else None


# ============================================================================
# 1. RASPBERRY PI 5 SYSTEM VITALS
# ============================================================================

def collect_host_info() -> dict[str, Any]:
    os_pretty = "Debian GNU/Linux"
    try:
        for line in Path("/etc/os-release").read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("PRETTY_NAME="):
                os_pretty = line.split("=", 1)[1].strip().strip('"')
                break
    except OSError:
        pass

    model = "Raspberry Pi 5"
    for p in ("/proc/device-tree/model", "/sys/firmware/devicetree/base/model"):
        try:
            raw = Path(p).read_bytes().replace(b"\x00", b"").decode("utf-8", errors="replace").strip()
            if raw:
                model = raw
                break
        except OSError:
            pass

    uptime_sec = 0.0
    try:
        uptime_sec = float(Path("/proc/uptime").read_text().split()[0])
    except Exception:
        pass
    boot_dt = datetime.fromtimestamp(time.time() - uptime_sec, tz=timezone.utc)

    procs_running = 0
    procs_total = 0
    try:
        parts = Path("/proc/loadavg").read_text().split()
        if len(parts) >= 4 and "/" in parts[3]:
            r_str, t_str = parts[3].split("/", 1)
            procs_running = int(r_str)
            procs_total = int(t_str)
    except Exception:
        pass

    return {
        "hostname": platform.node() or "rpi",
        "os_pretty": os_pretty,
        "kernel": platform.release(),
        "arch": platform.machine(),
        "model": model,
        "uptime_seconds": int(uptime_sec),
        "uptime_human": format_uptime(uptime_sec),
        "boot_time_utc": boot_dt.strftime("%Y-%m-%d %H:%M:%S UTC"),
        "processes_total": procs_total,
        "processes_running": procs_running,
    }


def _read_proc_stat() -> dict[str, tuple[int, int]]:
    res: dict[str, tuple[int, int]] = {}
    try:
        for line in Path("/proc/stat").read_text().splitlines():
            if not line.startswith("cpu"):
                continue
            parts = line.split()
            vals = [int(x) for x in parts[1:]]
            idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
            total = sum(vals[:8])
            res[parts[0]] = (idle, total)
    except OSError:
        pass
    return res


def collect_cpu_metrics() -> dict[str, Any]:
    cores = os.cpu_count() or 4
    t1 = _read_proc_stat()
    time.sleep(0.4)
    t2 = _read_proc_stat()

    usage_pct = 0.0
    if "cpu" in t1 and "cpu" in t2:
        tot_d = t2["cpu"][1] - t1["cpu"][1]
        idl_d = t2["cpu"][0] - t1["cpu"][0]
        if tot_d > 0:
            usage_pct = round(max(0.0, min(100.0, (1.0 - idl_d / tot_d) * 100.0)), 1)

    per_core: list[float] = []
    for k in sorted((c for c in t2 if c != "cpu" and c[3:].isdigit()), key=lambda x: int(x[3:])):
        if k in t1:
            tot_d = t2[k][1] - t1[k][1]
            idl_d = t2[k][0] - t1[k][0]
            pct = round(max(0.0, min(100.0, (1.0 - idl_d / tot_d) * 100.0)), 1) if tot_d > 0 else 0.0
            per_core.append(pct)

    cpu_model = platform.machine()
    arm_map = {
        "0xd0b": "ARM Cortex-A76 (BCM2712)",
        "0xd08": "ARM Cortex-A72 (BCM2711)",
        "0xd03": "ARM Cortex-A53 (BCM2837)",
    }
    try:
        for line in Path("/proc/cpuinfo").read_text(errors="replace").splitlines():
            if ":" in line:
                k, v = [p.strip() for p in line.split(":", 1)]
                if k == "CPU part" and v.lower() in arm_map:
                    cpu_model = arm_map[v.lower()]
                    break
    except OSError:
        pass

    freq_mhz = 0.0
    max_freq_mhz = 0.0
    governor = ""
    try:
        freq_mhz = round(int(Path("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq").read_text().strip()) / 1000.0, 0)
    except Exception:
        pass
    try:
        max_freq_mhz = round(int(Path("/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq").read_text().strip()) / 1000.0, 0)
    except Exception:
        pass
    try:
        governor = Path("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor").read_text().strip()
    except Exception:
        pass

    l1, l5, l15 = 0.0, 0.0, 0.0
    try:
        l1, l5, l15 = os.getloadavg()
    except OSError:
        pass

    return {
        "model": cpu_model,
        "cores": cores,
        "usage_pct": usage_pct,
        "per_core_pct": per_core,
        "freq_mhz": int(freq_mhz),
        "max_freq_mhz": int(max_freq_mhz),
        "governor": governor,
        "load_1m": round(l1, 2),
        "load_5m": round(l5, 2),
        "load_15m": round(l15, 2),
        "load_pct": round((l1 / max(1, cores)) * 100.0, 1),
    }


def decode_throttled(hex_val: int) -> tuple[bool, list[str], str]:
    now_map = [
        (0, "Under-voltage NOW"),
        (1, "ARM Freq Capped NOW"),
        (2, "Throttled NOW"),
        (3, "Soft Temp Limit NOW"),
    ]
    hist_map = [
        (16, "Under-voltage occurred"),
        (17, "ARM Freq Capped occurred"),
        (18, "Throttling occurred"),
        (19, "Soft Temp Limit occurred"),
    ]
    flags: list[str] = []
    active_now = False
    for bit, label in now_map:
        if hex_val & (1 << bit):
            active_now = True
            flags.append(label)
    for bit, label in hist_map:
        if hex_val & (1 << bit):
            flags.append(label)
    hex_str = hex(hex_val)
    if not flags:
        return False, [], f"OK ({hex_str})"
    return active_now, flags, f"{'; '.join(flags)} ({hex_str})"


def collect_thermals() -> dict[str, Any]:
    soc_temp: float | None = None
    rp1_temp: float | None = None
    fan_rpm: int | None = None
    fan_pwm: int | None = None
    core_volts: float | None = None
    throttled_hex = "0x0"
    throttled_now = False
    throttled_flags: list[str] = []
    throttled_status = "OK (0x0)"

    # SoC Temp via thermal_zone0 or vcgencmd
    try:
        raw_t = int(Path("/sys/class/thermal/thermal_zone0/temp").read_text().strip())
        soc_temp = round(raw_t / 1000.0, 1)
    except Exception:
        pass

    rc, out, _ = run_cmd(["vcgencmd", "measure_temp"], timeout=3.0)
    if rc == 0:
        m = re.search(r"temp=([0-9.]+)", out)
        if m:
            soc_temp = round(float(m.group(1)), 1)

    rc, out, _ = run_cmd(["vcgencmd", "measure_volts", "core"], timeout=3.0)
    if rc == 0:
        m = re.search(r"volt=([0-9.]+)V", out)
        if m:
            core_volts = round(float(m.group(1)), 3)

    rc, out, _ = run_cmd(["vcgencmd", "get_throttled"], timeout=3.0)
    if rc == 0:
        m = re.search(r"throttled=(0x[0-9a-fA-F]+)", out)
        if m:
            throttled_hex = m.group(1)
            val = int(throttled_hex, 16)
            throttled_now, throttled_flags, throttled_status = decode_throttled(val)

    # Scan hwmon for RP1 ADC temp & PWM fan
    hwmon_base = Path("/sys/class/hwmon")
    if hwmon_base.is_dir():
        for h in sorted(hwmon_base.iterdir()):
            try:
                name = (h / "name").read_text().strip().lower()
            except OSError:
                continue
            if "rp1" in name:
                try:
                    rp1_temp = round(int((h / "temp1_input").read_text().strip()) / 1000.0, 1)
                except Exception:
                    pass
            elif "fan" in name or (h / "fan1_input").is_file():
                try:
                    fan_rpm = int((h / "fan1_input").read_text().strip())
                except Exception:
                    pass
                try:
                    fan_pwm = int((h / "pwm1").read_text().strip())
                except Exception:
                    pass

    return {
        "soc_temp_c": soc_temp,
        "rp1_temp_c": rp1_temp,
        "fan_rpm": fan_rpm,
        "fan_pwm": fan_pwm,
        "core_volts": core_volts,
        "throttled_hex": throttled_hex,
        "throttled_status": throttled_status,
        "throttled_now": throttled_now,
        "throttled_flags": throttled_flags,
    }


def collect_memory() -> dict[str, Any]:
    kv: dict[str, int] = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            m = re.match(r"^(\w+):\s+(\d+)\s+kB", line)
            if m:
                kv[m.group(1)] = int(m.group(2))
    except OSError:
        pass

    total_mb = round(kv.get("MemTotal", 0) / 1024.0, 1)
    avail_mb = round(kv.get("MemAvailable", kv.get("MemFree", 0)) / 1024.0, 1)
    free_mb = round(kv.get("MemFree", 0) / 1024.0, 1)
    cached_mb = round((kv.get("Cached", 0) + kv.get("Buffers", 0)) / 1024.0, 1)
    used_mb = round(max(0.0, total_mb - avail_mb), 1)
    ram_pct = round((used_mb / total_mb) * 100.0, 1) if total_mb > 0 else 0.0

    swap_total = round(kv.get("SwapTotal", 0) / 1024.0, 1)
    swap_free = round(kv.get("SwapFree", 0) / 1024.0, 1)
    swap_used = round(max(0.0, swap_total - swap_free), 1)
    swap_pct = round((swap_used / swap_total) * 100.0, 1) if swap_total > 0 else 0.0

    return {
        "ram_total_mb": total_mb,
        "ram_used_mb": used_mb,
        "ram_available_mb": avail_mb,
        "ram_cached_mb": cached_mb,
        "ram_free_mb": free_mb,
        "ram_usage_pct": ram_pct,
        "swap_total_mb": swap_total,
        "swap_used_mb": swap_used,
        "swap_free_mb": swap_free,
        "swap_usage_pct": swap_pct,
    }


def collect_storage() -> list[dict[str, Any]]:
    inode_pct_map: dict[str, float] = {}
    rc_i, out_i, _ = run_cmd(["df", "-P", "-i"], timeout=4.0)
    if rc_i == 0:
        for line in out_i.splitlines()[1:]:
            parts = line.split()
            if len(parts) >= 6:
                pct_str = parts[4].rstrip("%")
                if pct_str.replace(".", "", 1).isdigit():
                    inode_pct_map[parts[5]] = float(pct_str)

    entries: list[dict[str, Any]] = []
    seen_mounts: set[str] = set()
    rc, out, _ = run_cmd(["df", "-B1", "-P", "-T"], timeout=4.0)
    if rc != 0:
        return entries
    skip_fs = {"tmpfs", "devtmpfs", "squashfs", "overlay", "proc", "sysfs", "cgroup2", "efivarfs", "vfat_skip"}
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 7:
            continue
        dev, fstype, total_b, used_b, avail_b, pct_s, mount = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], parts[6]
        if fstype in skip_fs or mount.startswith("/snap/") or mount.startswith("/var/lib/docker"):
            continue
        if mount in seen_mounts:
            continue
        seen_mounts.add(mount)
        try:
            tot = int(total_b)
            usd = int(used_b)
            fre = int(avail_b)
            pct = float(pct_s.rstrip("%"))
            entries.append({
                "device": dev,
                "mountpoint": mount,
                "fstype": fstype,
                "total_gb": round(tot / (1024 ** 3), 2),
                "used_gb": round(usd / (1024 ** 3), 2),
                "free_gb": round(fre / (1024 ** 3), 2),
                "usage_pct": round(pct, 1),
                "inode_usage_pct": inode_pct_map.get(mount),
            })
        except ValueError:
            continue
    return entries


def collect_network() -> dict[str, Any]:
    primary_ip = ""
    gateway_ip = ""
    gateway_rtt_ms: float | None = None

    rc_r, out_r, _ = run_cmd(["ip", "-j", "route", "show", "default"], timeout=4.0)
    if rc_r == 0 and out_r:
        try:
            routes = json.loads(out_r)
            if routes:
                routes.sort(key=lambda r: int(r.get("metric", 9999)))
                gateway_ip = str(routes[0].get("gateway") or "")
                primary_ip = str(routes[0].get("prefsrc") or "")
        except Exception:
            pass

    if gateway_ip:
        rc_p, out_p, _ = run_cmd(["ping", "-c", "3", "-i", "0.2", "-W", "2", gateway_ip], timeout=6.0)
        if rc_p == 0:
            m = re.search(r"=\s*([0-9.]+)/([0-9.]+)/([0-9.]+)", out_p)
            if m:
                gateway_rtt_ms = round(float(m.group(2)), 2)

    # Read /proc/net/dev counters
    net_counters: dict[str, dict[str, int]] = {}
    try:
        for line in Path("/proc/net/dev").read_text().splitlines()[2:]:
            if ":" not in line:
                continue
            ifname, rest = line.split(":", 1)
            vals = [int(x) for x in rest.split()]
            if len(vals) >= 12:
                net_counters[ifname.strip()] = {
                    "rx_bytes": vals[0],
                    "rx_errors": vals[2],
                    "rx_drops": vals[3],
                    "tx_bytes": vals[8],
                    "tx_errors": vals[10],
                    "tx_drops": vals[11],
                }
    except OSError:
        pass

    # Wi-Fi link info on wlan0
    wifi_info: dict[str, Any] = {}
    rc_w, out_w, _ = run_cmd(["iw", "dev", "wlan0", "link"], timeout=3.0)
    if rc_w == 0 and "Connected to" in out_w:
        m_ssid = re.search(r"SSID:\s*(.+)", out_w)
        m_sig = re.search(r"signal:\s*(-?\d+)\s*dBm", out_w)
        m_freq = re.search(r"freq:\s*([0-9.]+)", out_w)
        m_bit = re.search(r"rx bitrate:\s*([0-9.]+)", out_w)
        wifi_info = {
            "wifi_ssid": m_ssid.group(1).strip() if m_ssid else None,
            "wifi_rssi_dbm": int(m_sig.group(1)) if m_sig else None,
            "wifi_freq_mhz": round(float(m_freq.group(1)), 1) if m_freq else None,
            "wifi_bitrate_mbps": round(float(m_bit.group(1)), 1) if m_bit else None,
        }

    interfaces: list[dict[str, Any]] = []
    rc_a, out_a, _ = run_cmd(["ip", "-j", "addr", "show"], timeout=4.0)
    if rc_a == 0 and out_a:
        try:
            for item in json.loads(out_a):
                name = str(item.get("ifname") or "")
                if not name or name == "lo" or name.startswith(("veth", "br-", "docker")):
                    continue
                ipv4 = [a["local"] for a in item.get("addr_info", []) if a.get("family") == "inet"]
                ipv6 = [a["local"] for a in item.get("addr_info", []) if a.get("family") == "inet6" and a.get("scope") != "link"]
                speed = None
                try:
                    sp = int(Path(f"/sys/class/net/{name}/speed").read_text().strip())
                    if sp > 0:
                        speed = sp
                except Exception:
                    pass
                ctr = net_counters.get(name, {})
                entry: dict[str, Any] = {
                    "name": name,
                    "operstate": str(item.get("operstate") or "unknown").lower(),
                    "ipv4": ipv4,
                    "ipv6": ipv6,
                    "mac": str(item.get("address") or ""),
                    "speed_mbps": speed,
                    "rx_mb": round(ctr.get("rx_bytes", 0) / (1024 * 1024), 2),
                    "tx_mb": round(ctr.get("tx_bytes", 0) / (1024 * 1024), 2),
                    "rx_errors": ctr.get("rx_errors", 0),
                    "tx_errors": ctr.get("tx_errors", 0),
                    "rx_drops": ctr.get("rx_drops", 0),
                    "tx_drops": ctr.get("tx_drops", 0),
                }
                if name == "wlan0" and wifi_info:
                    entry.update(wifi_info)
                interfaces.append(entry)
                if not primary_ip and ipv4:
                    primary_ip = ipv4[0]
        except Exception:
            pass

    return {
        "primary_ip": primary_ip,
        "gateway_ip": gateway_ip,
        "gateway_rtt_ms": gateway_rtt_ms,
        "interfaces": interfaces,
    }


# ============================================================================
# 2. QDRANT VECTOR DB STATUS
# ============================================================================

def collect_qdrant_status() -> dict[str, Any]:
    rag_env = load_env_file("/opt/edge-rag-hub/.env")
    api_key = rag_env.get("QDRANT_API_KEY", "")
    collection = rag_env.get("QDRANT_COLLECTION", "knowledge_hub")
    headers = {"api-key": api_key} if api_key else {}

    res: dict[str, Any] = {
        "reachable": False,
        "healthz_ok": False,
        "status": "offline",
        "version": "",
        "collection": collection,
        "collections_count": 0,
        "points_count": 0,
        "indexed_vectors_count": 0,
        "segments_count": 0,
        "optimizer_status": "unknown",
        "vector_size": 0,
        "distance": "",
        "disk_usage_mb": 0.0,
        "api_latency_ms": None,
        "container_status": "unknown",
        "container_uptime": "",
        "container_rss_mb": read_container_total_rss_mb("edge-qdrant"),
        "error": "",
    }

    # Disk footprint of qdrant_data
    rc_du, out_du, _ = run_cmd(["du", "-sm", "/opt/edge-rag-hub/qdrant_data"], timeout=5.0)
    if rc_du == 0 and out_du:
        try:
            res["disk_usage_mb"] = float(out_du.split()[0])
        except ValueError:
            pass

    # Docker container status for edge-qdrant
    rc_dk, out_dk, _ = run_cmd(["docker", "ps", "-a", "--filter", "name=^/edge-qdrant$", "--format", "{{.State}}|{{.Status}}"], timeout=4.0)
    if rc_dk == 0 and "|" in out_dk:
        st, up = out_dk.split("|", 1)
        res["container_status"] = st.strip()
        res["container_uptime"] = up.strip()

    # HTTP /healthz + / + /collections + /collections/<collection>
    try:
        t0 = time.monotonic()
        with urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:6333/healthz"), timeout=4) as r:
            res["healthz_ok"] = r.status == 200
            res["reachable"] = True
        res["api_latency_ms"] = round((time.monotonic() - t0) * 1000.0, 2)

        with urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:6333/", headers=headers), timeout=4) as r:
            info = json.loads(r.read().decode("utf-8", errors="replace"))
            res["version"] = str(info.get("version") or "")

        with urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:6333/collections", headers=headers), timeout=4) as r:
            cols = json.loads(r.read().decode("utf-8", errors="replace"))
            col_list = cols.get("result", {}).get("collections", [])
            res["collections_count"] = len(col_list)

        with urllib.request.urlopen(
            urllib.request.Request(f"http://127.0.0.1:6333/collections/{collection}", headers=headers),
            timeout=5,
        ) as r:
            col_data = json.loads(r.read().decode("utf-8", errors="replace")).get("result", {})
            res["status"] = str(col_data.get("status") or "unknown")
            res["points_count"] = int(col_data.get("points_count") or 0)
            res["indexed_vectors_count"] = int(col_data.get("indexed_vectors_count") or 0)
            res["segments_count"] = int(col_data.get("segments_count") or 0)
            opt = col_data.get("optimizer_status")
            res["optimizer_status"] = opt if isinstance(opt, str) else json.dumps(opt)
            vec_cfg = col_data.get("config", {}).get("params", {}).get("vectors", {})
            if isinstance(vec_cfg, dict):
                res["vector_size"] = int(vec_cfg.get("size") or 0)
                res["distance"] = str(vec_cfg.get("distance") or "")
    except Exception as exc:
        res["error"] = str(exc)[:180]

    return res


# ============================================================================
# 3. BRAIN EDGE SYNC STATUS (gemini-brain-watcher)
# ============================================================================

def _systemctl_show(unit: str) -> dict[str, str]:
    rc, out, _ = run_cmd(
        [
            "systemctl",
            "show",
            "-p",
            "ActiveState,SubState,ActiveEnterTimestamp,MainPID,NRestarts",
            unit,
        ],
        timeout=4.0,
    )
    props: dict[str, str] = {}
    if rc == 0:
        for line in out.splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                props[k.strip()] = v.strip()
    return props


def collect_sync_status() -> dict[str, Any]:
    wenv = load_env_file("/etc/gemini-brain/watcher.env")
    enabled = wenv.get("RPI_SYNC_ENABLED", "true").lower() in ("1", "true", "yes")
    cli_enabled = wenv.get("CLI_SYNC_ENABLED", "true").lower() in ("1", "true", "yes")
    watch_dirs = [d.strip() for d in wenv.get("WATCH_DIRS", "").split(",") if d.strip()]

    props = _systemctl_show("gemini-brain-watcher.service")
    active = props.get("ActiveState") == "active"
    pid = int(props.get("MainPID", "0") or 0) or None

    total_chunks = 0
    chunks_by_prefix: dict[str, int] = {}
    last_chunk_utc = ""
    db_size_mb = 0.0
    db_path = Path(wenv.get("BRAIN_STATE_DB", "/root/.cache/gemini-brain/sync_state.db")).expanduser()
    if db_path.is_file():
        try:
            db_size_mb = round(db_path.stat().st_size / (1024 * 1024), 2)
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=3)
            row = conn.execute("SELECT COUNT(*), MAX(synced_at) FROM synced_chunks").fetchone()
            if row:
                total_chunks = int(row[0] or 0)
                if row[1]:
                    last_chunk_utc = datetime.fromtimestamp(int(row[1]), tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
            for p_row in conn.execute(
                "SELECT substr(chunk_id, 1, instr(chunk_id, '_') - 1) AS p, COUNT(*) FROM synced_chunks GROUP BY p"
            ).fetchall():
                key = str(p_row[0] or "other")
                chunks_by_prefix[key] = int(p_row[1] or 0)
            conn.close()
        except Exception:
            pass

    # Parse recent journald logs for Qdrant federation pass and recent errors
    last_pass_utc = ""
    last_scanned = 0
    last_new = 0
    err_count = 0
    err_sample = ""

    rc_j, out_j, _ = run_cmd(
        ["journalctl", "-u", "gemini-brain-watcher", "-n", "120", "--no-pager", "-o", "short-iso"],
        timeout=5.0,
    )
    if rc_j == 0 and out_j:
        for line in out_j.splitlines():
            m_pass = re.search(r"^(\S+)\s+.*Qdrant federation pass complete:\s*scanned=(\d+),\s*newly_synced=(\d+)", line)
            if m_pass:
                raw_ts = m_pass.group(1)
                try:
                    dt = datetime.fromisoformat(raw_ts).astimezone(timezone.utc)
                    last_pass_utc = dt.strftime("%Y-%m-%d %H:%M:%S UTC")
                except Exception:
                    last_pass_utc = raw_ts
                last_scanned = int(m_pass.group(2))
                last_new = int(m_pass.group(3))
            if "[ERROR]" in line or "Traceback" in line:
                err_count += 1
                err_sample = line.strip()[:180]

    # Check uplink reachability to brain.tsimon.me
    uplink_ok = False
    uplink_code: int | None = None
    uplink_ms: float | None = None
    try:
        t0 = time.monotonic()
        req = urllib.request.Request(
            "https://brain.tsimon.me/server-card",
            headers={"User-Agent": f"RPi5NocReporter/{AGENT_VERSION}"},
        )
        with urllib.request.urlopen(req, timeout=8) as r:
            uplink_code = r.status
            uplink_ok = 200 <= r.status < 400
            uplink_ms = round((time.monotonic() - t0) * 1000.0, 1)
    except urllib.error.HTTPError as he:
        uplink_code = he.code
    except Exception:
        pass

    return {
        "enabled": enabled,
        "cli_sync_enabled": cli_enabled,
        "service_active": active,
        "service_substate": props.get("SubState", "unknown"),
        "service_uptime": props.get("ActiveEnterTimestamp", ""),
        "service_rss_mb": read_pid_rss_mb(pid),
        "total_synced_chunks": total_chunks,
        "chunks_by_prefix": chunks_by_prefix,
        "last_chunk_synced_utc": last_chunk_utc,
        "last_qdrant_pass_utc": last_pass_utc,
        "last_qdrant_scanned": last_scanned,
        "last_qdrant_newly_synced": last_new,
        "recent_errors_count": err_count,
        "recent_error_sample": err_sample,
        "brain_uplink_ok": uplink_ok,
        "brain_uplink_http_code": uplink_code,
        "brain_uplink_latency_ms": uplink_ms,
        "watch_dirs": watch_dirs,
        "state_db_size_mb": db_size_mb,
    }


# ============================================================================
# 4. CRITICAL SERVICES STATUS (SYSTEMD + TIMERS + DOCKER)
# ============================================================================

def collect_critical_services(qdrant_info: dict[str, Any]) -> list[dict[str, Any]]:
    systemd_targets = [
        ("cloudflared.service", "Cloudflare Tunnel (cloudflared)", "systemd", True),
        ("docker.service", "Docker Engine", "systemd", True),
        ("gemini-brain-watcher.service", "Gemini Brain Sync Watcher", "systemd", True),
        ("ssh.service", "OpenSSH Server", "systemd", True),
        ("cron.service", "Cron Scheduler", "systemd", True),
        ("smbd.service", "Samba File Share (smbd)", "systemd", False),
        ("cloudflared-update.timer", "Cloudflared Auto-Update Timer", "timer", False),
    ]

    services: list[dict[str, Any]] = []
    for unit, display, svc_type, critical in systemd_targets:
        props = _systemctl_show(unit)
        state = props.get("ActiveState", "unknown")
        substate = props.get("SubState", "unknown")
        pid = int(props.get("MainPID", "0") or 0) or None
        restarts = int(props.get("NRestarts", "0") or 0)
        services.append({
            "name": unit.replace(".service", ""),
            "display_name": display,
            "type": svc_type,
            "critical": critical,
            "active": state == "active",
            "status": state,
            "substate": substate,
            "uptime_since": props.get("ActiveEnterTimestamp", ""),
            "pid": pid,
            "rss_mb": read_pid_rss_mb(pid),
            "restarts": restarts,
            "health_detail": "Active" if state == "active" else f"State: {state}/{substate}",
        })

    # Docker containers
    docker_targets = [
        ("edge-qdrant", "Edge Qdrant Vector DB", True),
    ]
    for cname, display, critical in docker_targets:
        rc, out, _ = run_cmd(
            ["docker", "inspect", "--format", "{{.State.Status}}|{{.State.Pid}}|{{.RestartCount}}|{{.State.StartedAt}}", cname],
            timeout=4.0,
        )
        if rc == 0 and "|" in out:
            st, pid_s, rst_s, started = out.split("|", 3)
            is_running = st.strip() == "running"
            pid = int(pid_s) if pid_s.isdigit() and int(pid_s) > 0 else None
            restarts = int(rst_s) if rst_s.isdigit() else 0
            detail = "Running"
            effective_active = is_running
            if cname == "edge-qdrant":
                effective_active = is_running and bool(qdrant_info.get("healthz_ok"))
                detail = f"Qdrant v{qdrant_info.get('version', '?')} • {qdrant_info.get('status', 'offline').upper()} ({qdrant_info.get('points_count', 0)} pts)"
            services.append({
                "name": cname,
                "display_name": display,
                "type": "docker",
                "critical": critical,
                "active": effective_active,
                "status": st.strip(),
                "substate": "healthy" if effective_active else "unhealthy",
                "uptime_since": started.strip()[:19].replace("T", " ") + " UTC",
                "pid": pid,
                "rss_mb": read_container_total_rss_mb(cname),
                "restarts": restarts,
                "health_detail": detail,
            })
        else:
            services.append({
                "name": cname,
                "display_name": display,
                "type": "docker",
                "critical": critical,
                "active": False,
                "status": "missing",
                "substate": "not_found",
                "uptime_since": "",
                "pid": None,
                "rss_mb": None,
                "restarts": 0,
                "health_detail": "Docker container not found",
            })

    return services


# ============================================================================
# 5. ESP-32S LAN PROBE (ICMP PING, LATENCY, ARP/MAC, OPTIONAL LOCAL /metrics)
# ============================================================================

def _find_esp32_from_arp(expected_mac: str) -> tuple[str | None, str, str, str]:
    target_mac = expected_mac.strip().lower()
    rc, out, _ = run_cmd(["ip", "-j", "neigh", "show"], timeout=4.0)
    if rc != 0 or not out:
        return None, expected_mac, "UNKNOWN", "eth0"
    try:
        entries = json.loads(out)
        # Prefer exact MAC match
        for e in entries:
            ll = str(e.get("lladdr") or "").lower()
            dst = str(e.get("dst") or "")
            if ll == target_mac and "." in dst:
                states = e.get("state") or ["UNKNOWN"]
                return dst, ll.upper(), str(states[0]), str(e.get("dev") or "eth0")
        # Secondary match on Espressif OUI prefix if MAC changed
        for e in entries:
            ll = str(e.get("lladdr") or "").lower()
            dst = str(e.get("dst") or "")
            if ll.startswith(target_mac[:8]) and "." in dst:
                states = e.get("state") or ["UNKNOWN"]
                return dst, ll.upper(), str(states[0]), str(e.get("dev") or "eth0")
    except Exception:
        pass
    return None, expected_mac.upper(), "UNKNOWN", "eth0"


def probe_esp32_lan(esp32_ip: str, esp32_mac: str, hostname: str) -> dict[str, Any]:
    probed_at = utc_now_str()
    target_ip = esp32_ip
    mac = esp32_mac.upper()
    arp_state = "UNKNOWN"
    iface = "eth0"

    # First check ARP table for exact MAC in case DHCP reassigned IP
    arp_ip, arp_mac, arp_st, arp_dev = _find_esp32_from_arp(esp32_mac)
    if arp_ip:
        target_ip = arp_ip
        mac = arp_mac
        arp_state = arp_st
        iface = arp_dev

    packets_sent = 5
    packets_received = 0
    loss_pct = 100.0
    rtt_min: float | None = None
    rtt_avg: float | None = None
    rtt_max: float | None = None
    rtt_jitter: float | None = None
    ttl: int | None = None

    rc, out, _ = run_cmd(["ping", "-c", str(packets_sent), "-i", "0.25", "-W", "2", target_ip], timeout=12.0)
    if out:
        m_pkt = re.search(r"(\d+)\s+packets transmitted,\s+(\d+)\s+received.*?([0-9.]+)%\s+packet loss", out)
        if m_pkt:
            packets_sent = int(m_pkt.group(1))
            packets_received = int(m_pkt.group(2))
            loss_pct = round(float(m_pkt.group(3)), 1)
        m_rtt = re.search(r"=\s*([0-9.]+)/([0-9.]+)/([0-9.]+)/([0-9.]+)\s*ms", out)
        if m_rtt:
            rtt_min = round(float(m_rtt.group(1)), 2)
            rtt_avg = round(float(m_rtt.group(2)), 2)
            rtt_max = round(float(m_rtt.group(3)), 2)
            rtt_jitter = round(float(m_rtt.group(4)), 2)
        m_ttl = re.search(r"ttl=(\d+)", out)
        if m_ttl:
            ttl = int(m_ttl.group(1))

    # Refresh ARP state right after ping
    rc_n, out_n, _ = run_cmd(["ip", "-j", "neigh", "show", target_ip], timeout=3.0)
    if rc_n == 0 and out_n:
        try:
            arr = json.loads(out_n)
            if arr:
                if arr[0].get("lladdr"):
                    mac = str(arr[0]["lladdr"]).upper()
                states = arr[0].get("state") or []
                if states:
                    arp_state = str(states[0])
                if arr[0].get("dev"):
                    iface = str(arr[0]["dev"])
        except Exception:
            pass

    reachable = packets_received > 0
    probe_result: dict[str, Any] = {
        "ping": {
            "reachable": reachable,
            "target_ip": target_ip,
            "mac": mac,
            "vendor": "Espressif Inc.",
            "arp_state": arp_state,
            "interface": iface,
            "packets_sent": packets_sent,
            "packets_received": packets_received,
            "packet_loss_pct": loss_pct,
            "rtt_min_ms": rtt_min,
            "rtt_avg_ms": rtt_avg,
            "rtt_max_ms": rtt_max,
            "rtt_jitter_ms": rtt_jitter,
            "ttl": ttl,
            "probed_at_utc": probed_at,
            "probed_from": hostname,
        }
    }

    # Optional: if updated esp32-monitor firmware exposes local http://<ip>/metrics, pull rich vitals + OOB probes!
    if reachable:
        try:
            req = urllib.request.Request(
                f"http://{target_ip}/metrics",
                headers={"User-Agent": f"RPi5NocReporter/{AGENT_VERSION}"},
            )
            with urllib.request.urlopen(req, timeout=2.5) as r:
                if r.status == 200:
                    body = json.loads(r.read().decode("utf-8", errors="replace"))
                    if isinstance(body.get("device"), dict):
                        probe_result["device"] = body["device"]
                    if isinstance(body.get("oob_watchdog"), dict):
                        probe_result["oob_watchdog"] = body["oob_watchdog"]
        except Exception:
            # Normal when ESP-32S is running legacy firmware without local HTTP /metrics
            pass

    return probe_result


# ============================================================================
# MAIN COLLECTOR & PUSH CLIENT
# ============================================================================

def build_full_payload(esp32_ip: str, esp32_mac: str) -> dict[str, Any]:
    host = collect_host_info()
    qdrant = collect_qdrant_status()
    return {
        "reported_at_utc": utc_now_str(),
        "agent_version": AGENT_VERSION,
        "cron_interval_sec": 900,
        "host": host,
        "cpu": collect_cpu_metrics(),
        "thermals": collect_thermals(),
        "memory": collect_memory(),
        "storage": collect_storage(),
        "network": collect_network(),
        "qdrant": qdrant,
        "sync": collect_sync_status(),
        "services": collect_critical_services(qdrant),
        "esp32_probe": probe_esp32_lan(esp32_ip, esp32_mac, host["hostname"]),
    }


def push_payload(url: str, token: str, payload: dict[str, Any], verbose: bool = False) -> bool:
    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "User-Agent": f"RPi5NocReporter/{AGENT_VERSION}",
    }
    last_err = ""
    for attempt in range(1, 4):
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=15) as resp:
                resp_body = resp.read().decode("utf-8", errors="replace")
                if verbose:
                    print(f"[{utc_now_str()}] Push HTTP {resp.status}: {resp_body}")
                return 200 <= resp.status < 300
        except urllib.error.HTTPError as he:
            body_err = he.read().decode("utf-8", errors="replace")[:200]
            last_err = f"HTTP {he.code}: {body_err}"
        except Exception as exc:
            last_err = str(exc)
        if attempt < 3:
            time.sleep(attempt * 2)
    print(f"[{utc_now_str()}] ERROR pushing RPi5 telemetry to {url}: {last_err}", file=sys.stderr)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Raspberry Pi 5 15-Minute NOC Telemetry Reporter")
    parser.add_argument("--env-file", default=DEFAULT_ENV_FILE, help="Path to reporter.env")
    parser.add_argument("--dry-run", action="store_true", help="Print collected JSON payload without pushing")
    parser.add_argument("--verbose", action="store_true", help="Print verbose status output")
    args = parser.parse_args()

    file_env = load_env_file(args.env_file)
    ingest_url = os.environ.get("NOC_INGEST_URL") or file_env.get("NOC_INGEST_URL") or DEFAULT_INGEST_URL
    ingest_token = os.environ.get("NOC_INGEST_TOKEN") or file_env.get("NOC_INGEST_TOKEN") or ""
    esp32_ip = os.environ.get("ESP32_IP") or file_env.get("ESP32_IP") or DEFAULT_ESP32_IP
    esp32_mac = os.environ.get("ESP32_MAC") or file_env.get("ESP32_MAC") or DEFAULT_ESP32_MAC

    payload = build_full_payload(esp32_ip=esp32_ip, esp32_mac=esp32_mac)

    if args.dry_run:
        print(json.dumps(payload, indent=2))
        return 0

    if not ingest_token:
        print("ERROR: NOC_INGEST_TOKEN is not set in environment or env file.", file=sys.stderr)
        return 2

    ok = push_payload(ingest_url, ingest_token, payload, verbose=args.verbose)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
