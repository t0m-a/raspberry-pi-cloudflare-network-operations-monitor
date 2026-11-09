#!/usr/bin/env python3
import concurrent.futures
import html
import ipaddress
import json
import os
import platform
import random
import re
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def _load_service_env_fallback():
    """Load Environment= entries from cloud-monitor.service if env vars are not already set."""
    candidates = [
        os.path.join(SCRIPT_DIR, "cloud-monitor.service"),
        "/etc/systemd/system/cloud-monitor.service",
    ]
    for path in candidates:
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        m = re.match(r'^(?:Environment=|export\s+)["\']?([A-Za-z0-9_]+)=([^"\']+)["\']?$', line)
                        if m:
                            key, val = m.group(1), m.group(2)
                            if key not in os.environ:
                                os.environ[key] = val
            except Exception:
                pass
            break


_load_service_env_fallback()

# --- CONFIGURATION ---
CF_API_TOKEN = os.getenv("CLOUDFLARE_API_TOKEN", "YOUR_CF_API_TOKEN")
CF_ACCOUNT_ID = os.getenv("CLOUDFLARE_ACCOUNT_ID", "YOUR_CF_ACCOUNT_ID")
OUTPUT_PATH = os.getenv(
    "METRICS_OUTPUT_PATH",
    "/var/www/html/metrics.json" if os.name != "nt" else os.path.join(SCRIPT_DIR, "metrics.json"),
)
LOCAL_OUTPUT_PATH = os.path.join(SCRIPT_DIR, "metrics.json")
OUI_CACHE_PATH = os.path.join(
    "/var/tmp" if os.name != "nt" and os.path.isdir("/var/tmp") else SCRIPT_DIR,
    "noc_oui_cache.json",
)

CF_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql"
CF_API_BASE_URL = "https://api.cloudflare.com/client/v4"

# DEFINE YOUR DOMAINS AND ZONE IDs HERE
DOMAINS_TO_MONITOR = {
    "tsimon.me": os.getenv("CF_ZONE_ID_1", "FIRST_ZONE_ID_HERE"),
    "minkalab.net": os.getenv("CF_ZONE_ID_2", "SECOND_ZONE_ID_HERE"),
    "tsimon.app": os.getenv("CF_ZONE_ID_3", "THIRD_ZONE_ID_HERE"),
}

# Cloudflare Free Tier / Standard Plan Quotas & Pricing Constants
QUOTAS = {
    "workers_daily_requests_limit": 100_000,
    "workers_monthly_build_minutes_limit": 3_000,
    "workers_ai_daily_neurons_limit": 10_000,
    "workers_ai_cost_per_1k_neurons_usd": 0.011,
    "d1_daily_rows_read_limit": 5_000_000,
    "d1_daily_rows_written_limit": 100_000,
    "d1_per_db_storage_limit_mb": 500.0,
    "d1_account_storage_limit_mb": 5000.0,
}
# ---------------------

_ZONE_NAME_CACHE = {}
_PREV_CPU_TIMES = None
_PREV_NET_IO = {}
_PREV_NET_TS = 0.0
_AVAHI_LOCK = threading.Lock()
_LAN_NAME_CACHE = {}  # mac_or_ip -> {"dns": str, "nb": str, "nb_grp": str, "mdns": str, "label": str}

# Built-in curated OUI vendor prefixes (first 6 hex digits uppercase)
_BUILTIN_OUI_MAP = {
    "28CDC1": "Raspberry Pi Trading Ltd",
    "2CCF67": "Raspberry Pi (Trading) Ltd",
    "B827EB": "Raspberry Pi Foundation",
    "D83ADD": "Raspberry Pi Trading Ltd",
    "DC2632": "Raspberry Pi Trading Ltd",
    "DCA632": "Raspberry Pi Trading Ltd",
    "E45F01": "Raspberry Pi Trading Ltd",
    "24C013": "ZTE Corporation",
    "8842D0": "Earda Technologies Co., Ltd",
    "DC567B": "Cloud Network Technology Singapore Pte. Ltd.",
    "A4438C": "CommScope",
    "00155D": "Microsoft Corporation (Hyper-V)",
    "000C29": "VMware, Inc.",
    "005056": "VMware, Inc.",
    "080027": "PCS Systemtechnik GmbH (VirtualBox)",
    "525400": "QEMU / KVM Virtual NIC",
    "BC2411": "Proxmox Server Solutions GmbH",
    "00163E": "Xensource, Inc.",
    "001B63": "Apple, Inc.",
    "001EC2": "Apple, Inc.",
    "3C22FB": "Apple, Inc.",
    "F01898": "Apple, Inc.",
    "ACDE48": "Apple, Inc.",
    "BC926B": "Apple, Inc.",
    "001A11": "Google, Inc.",
    "3C5AB4": "Google, Inc.",
    "F4F5D8": "Google, Inc.",
    "D8EB97": "TP-Link Systems Inc",
    "50C7BF": "TP-Link Technologies Co., Ltd.",
    "E8DE27": "TP-Link Technologies Co., Ltd.",
    "B0BE76": "TP-Link Technologies Co., Ltd.",
    "245A4C": "Ubiquiti Inc",
    "7483C2": "Ubiquiti Inc",
    "802AA8": "Ubiquiti Inc",
    "F09FC2": "Ubiquiti Inc",
    "240AC4": "Espressif Inc.",
    "30AEA4": "Espressif Inc.",
    "84CCA8": "Espressif Inc.",
    "A4CF12": "Espressif Inc.",
    "C44F33": "Espressif Inc.",
    "ECFAAB": "Espressif Inc.",
    "00E04C": "Realtek Semiconductor Corp.",
}

_OUI_CACHE = dict(_BUILTIN_OUI_MAP)
_OUI_CACHE_LOCK = threading.Lock()
_SYSTEM_OUI_LOADED = False


def run_cmd_safe(cmd, timeout=2.5):
    """Executes a subprocess command with a strict timeout and DEVNULL stdin so it never hangs."""
    try:
        res = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=timeout,
            check=False,
        )
        return res.stdout if res.returncode == 0 or res.stdout else ""
    except Exception:
        return ""


def _load_oui_caches():
    """Loads persistent JSON OUI cache and Linux system-installed IEEE OUI database files."""
    global _SYSTEM_OUI_LOADED
    if _SYSTEM_OUI_LOADED:
        return
    with _OUI_CACHE_LOCK:
        if _SYSTEM_OUI_LOADED:
            return
        _SYSTEM_OUI_LOADED = True

        # 1. Load local JSON cache if present
        if os.path.isfile(OUI_CACHE_PATH):
            try:
                if os.path.getsize(OUI_CACHE_PATH) > 0:
                    with open(OUI_CACHE_PATH, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        if isinstance(data, dict):
                            for k, v in data.items():
                                if isinstance(k, str) and isinstance(v, str) and v:
                                    _OUI_CACHE[k.upper()] = v
            except Exception:
                pass

        # 2. Load Linux udev 20-OUI.hwdb (installed on Raspberry Pi OS / Debian)
        hwdb_paths = [
            "/usr/lib/udev/hwdb.d/20-OUI.hwdb",
            "/lib/udev/hwdb.d/20-OUI.hwdb",
        ]
        for path in hwdb_paths:
            if os.path.isfile(path):
                try:
                    current_oui = None
                    with open(path, "r", encoding="utf-8", errors="replace") as f:
                        for line in f:
                            if line.startswith("OUI:"):
                                prefix = line[4:].strip().rstrip("*").upper()
                                current_oui = prefix[:6] if len(prefix) >= 6 else None
                            elif current_oui and "ID_OUI_FROM_DATABASE=" in line:
                                vendor = line.split("ID_OUI_FROM_DATABASE=", 1)[1].strip()
                                if vendor and current_oui not in _OUI_CACHE:
                                    _OUI_CACHE[current_oui] = vendor
                                current_oui = None
                except Exception:
                    pass
                break

        # 3. Load ieee-data / nmap / arp-scan OUI text files if present
        txt_paths = [
            "/usr/share/ieee-data/oui.txt",
            "/var/lib/ieee-data/oui.txt",
            "/usr/share/misc/oui.txt",
            "/usr/share/nmap/nmap-mac-prefixes",
            "/usr/share/arp-scan/ieee-oui.txt",
        ]
        for path in txt_paths:
            if os.path.isfile(path):
                try:
                    with open(path, "r", encoding="utf-8", errors="replace") as f:
                        for line in f:
                            if "(base 16)" in line:
                                parts = line.split("(base 16)", 1)
                                oui = re.sub(r"[^0-9A-Fa-f]", "", parts[0]).upper()
                                vendor = parts[1].strip()
                                if len(oui) == 6 and vendor and oui not in _OUI_CACHE:
                                    _OUI_CACHE[oui] = vendor
                            elif "\t" in line and not line.startswith("#"):
                                parts = line.split("\t", 1)
                                oui = re.sub(r"[^0-9A-Fa-f]", "", parts[0]).upper()
                                vendor = parts[1].strip()
                                if len(oui) == 6 and vendor and oui not in _OUI_CACHE:
                                    _OUI_CACHE[oui] = vendor
                except Exception:
                    pass


def _save_oui_cache_entry(oui_prefix, vendor):
    """Persists newly discovered OUI vendor mapping to OUI_CACHE_PATH."""
    try:
        existing = {}
        if os.path.isfile(OUI_CACHE_PATH) and os.path.getsize(OUI_CACHE_PATH) > 0:
            try:
                with open(OUI_CACHE_PATH, "r", encoding="utf-8") as f:
                    existing = json.load(f) or {}
            except Exception:
                existing = {}
        existing[oui_prefix] = vendor
        with open(OUI_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2, sort_keys=True)
    except Exception:
        pass


def normalize_mac(mac_str):
    """Normalizes any MAC address string to uppercase AA:BB:CC:DD:EE:FF format."""
    if not mac_str:
        return ""
    hex_chars = re.sub(r"[^0-9A-Fa-f]", "", str(mac_str)).upper()
    if len(hex_chars) != 12:
        return ""
    return ":".join(hex_chars[i : i + 2] for i in range(0, 12, 2))


def is_randomized_mac(mac_norm):
    """Checks if the Locally Administered Address (LAA) bit is set on the first octet."""
    if not mac_norm or len(mac_norm) < 2:
        return False
    try:
        first_octet = int(mac_norm[:2], 16)
        return bool(first_octet & 0x02) and not bool(first_octet & 0x01)
    except Exception:
        return False


def resolve_mac_vendor(mac_str, allow_network=True):
    """Resolves hardware manufacturer / vendor name from a MAC address (OUI)."""
    _load_oui_caches()
    mac_norm = normalize_mac(mac_str)
    if not mac_norm or mac_norm in ("00:00:00:00:00:00", "FF:FF:FF:FF:FF:FF"):
        return "Unknown"

    oui = mac_norm.replace(":", "")[:6]
    with _OUI_CACHE_LOCK:
        cached = _OUI_CACHE.get(oui)
    if cached:
        return cached

    # Check if this is a Locally Administered virtual BSSID derived from a known hardware OUI (bit 1 flipped)
    if is_randomized_mac(mac_norm):
        try:
            base_first_octet = int(oui[:2], 16) & ~0x02
            base_oui = f"{base_first_octet:02X}{oui[2:]}"
            with _OUI_CACHE_LOCK:
                base_vendor = _OUI_CACHE.get(base_oui)
            if base_vendor and base_oui in ("24C013", "2CCF67", "D8EB97", "50C7BF", "245A4C", "7483C2"):
                return f"{base_vendor} (Virtual/LAA)"
        except Exception:
            pass

    # Query online OUI lookup API if not in local hwdb
    if allow_network and not is_randomized_mac(mac_norm):
        try:
            url = f"https://api.maclookup.app/v2/macs/{mac_norm}"
            req = urllib.request.Request(url, headers={"User-Agent": "CloudMonitorDaemon/1.0"})
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                if resp.status == 200:
                    body = json.loads(resp.read().decode("utf-8"))
                    company = (body.get("company") or "").strip()
                    if company:
                        with _OUI_CACHE_LOCK:
                            _OUI_CACHE[oui] = company
                        _save_oui_cache_entry(oui, company)
                        return company
        except Exception:
            pass

    if is_randomized_mac(mac_norm):
        return "Randomized / Locally Administered MAC"
    return "Unknown Vendor"


def format_uptime(seconds):
    """Formats uptime in seconds into a human-readable 'Xd Xh Xm' string."""
    seconds = max(0, int(seconds))
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, _ = divmod(rem, 60)
    parts = []
    if days > 0:
        parts.append(f"{days}d")
    if hours > 0 or days > 0:
        parts.append(f"{hours}h")
    parts.append(f"{minutes}m")
    return " ".join(parts)


# =====================================================================
# RASPBERRY PI LINUX LOCAL SYSTEM MONITORING
# =====================================================================

def _read_linux_cpu_times():
    """Reads aggregate and per-core CPU jiffies from /proc/stat."""
    cores = {}
    try:
        with open("/proc/stat", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("cpu"):
                    parts = line.split()
                    name = parts[0]
                    vals = [int(x) for x in parts[1:]]
                    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
                    total = sum(vals[:8])
                    cores[name] = (idle, total)
    except Exception:
        pass
    return cores


def collect_cpu_and_temp_metrics():
    """Collects Raspberry Pi Linux CPU usage %, per-core %, clock frequency, SoC/RP1 temperatures, fan RPM, and throttling."""
    global _PREV_CPU_TIMES
    logical_cores = os.cpu_count() or 1
    cpu_model = platform.processor() or platform.machine()
    freq_mhz = 0.0
    max_freq_mhz = 0.0
    governor = ""
    usage_pct = 0.0
    per_core_pct = []
    temp_c = None
    rp1_temp_c = None
    fan_rpm = None
    temp_sensor = "cpu-thermal"
    throttled_status = "OK (0x0)"

    # 1. CPU Utilization from /proc/stat delta
    cur = _read_linux_cpu_times()
    if not _PREV_CPU_TIMES:
        time.sleep(0.25)
        prev = cur
        cur = _read_linux_cpu_times()
    else:
        prev = _PREV_CPU_TIMES
    _PREV_CPU_TIMES = cur

    if "cpu" in cur and "cpu" in prev:
        idle_d = cur["cpu"][0] - prev["cpu"][0]
        total_d = cur["cpu"][1] - prev["cpu"][1]
        if total_d > 0:
            usage_pct = round(max(0.0, min(100.0, (1.0 - idle_d / total_d) * 100.0)), 1)

    core_keys = sorted(
        [k for k in cur.keys() if k != "cpu" and k[3:].isdigit()],
        key=lambda x: int(x[3:]),
    )
    for k in core_keys:
        if k in prev:
            id_d = cur[k][0] - prev[k][0]
            tot_d = cur[k][1] - prev[k][1]
            pct = round(max(0.0, min(100.0, (1.0 - id_d / tot_d) * 100.0)), 1) if tot_d > 0 else 0.0
            per_core_pct.append(pct)

    # 2. CPU Model & ARM Part ID from /proc/cpuinfo
    arm_part_map = {
        "0xd0b": "ARM Cortex-A76 (BCM2712)",
        "0xd08": "ARM Cortex-A72 (BCM2711)",
        "0xd03": "ARM Cortex-A53 (BCM2837)",
    }
    try:
        if os.path.isfile("/proc/cpuinfo"):
            with open("/proc/cpuinfo", "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    if ":" in line:
                        k, v = [p.strip() for p in line.split(":", 1)]
                        if k == "CPU part" and v.lower() in arm_part_map:
                            cpu_model = arm_part_map[v.lower()]
                        elif k in ("model name", "Hardware") and v and cpu_model == platform.machine():
                            cpu_model = v
    except Exception:
        pass

    # 3. CPU Clock Frequency & Governor from /sys/devices/system/cpu/cpu0/cpufreq
    for freq_path in (
        "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq",
        "/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_cur_freq",
    ):
        if os.path.isfile(freq_path):
            try:
                with open(freq_path, "r", encoding="utf-8") as f:
                    freq_mhz = round(int(f.read().strip()) / 1000.0, 0)
                break
            except Exception:
                pass

    max_freq_path = "/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq"
    if os.path.isfile(max_freq_path):
        try:
            with open(max_freq_path, "r", encoding="utf-8") as f:
                max_freq_mhz = round(int(f.read().strip()) / 1000.0, 0)
        except Exception:
            pass

    gov_path = "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"
    if os.path.isfile(gov_path):
        try:
            with open(gov_path, "r", encoding="utf-8") as f:
                governor = f.read().strip()
        except Exception:
            pass

    # 4. Thermal Sensors (/sys/class/thermal & /sys/class/hwmon & vcgencmd)
    thermal_base = "/sys/class/thermal"
    if os.path.isdir(thermal_base):
        try:
            for entry in sorted(os.listdir(thermal_base)):
                if not entry.startswith("thermal_zone"):
                    continue
                t_path = os.path.join(thermal_base, entry, "temp")
                type_path = os.path.join(thermal_base, entry, "type")
                if os.path.isfile(t_path):
                    with open(t_path, "r", encoding="utf-8") as f:
                        raw = int(f.read().strip())
                    val_c = round(raw / 1000.0 if raw > 200 else float(raw), 1)
                    z_type = entry
                    if os.path.isfile(type_path):
                        with open(type_path, "r", encoding="utf-8") as tf:
                            z_type = tf.read().strip()
                    if 0.0 < val_c < 130.0:
                        temp_c = val_c
                        temp_sensor = z_type
                        if any(w in z_type.lower() for w in ("cpu", "soc", "bcm")):
                            break
        except Exception:
            pass

    # Check hwmon for RP1 southbridge temp and PWM cooling fan RPM on Raspberry Pi 5
    hwmon_base = "/sys/class/hwmon"
    if os.path.isdir(hwmon_base):
        try:
            for entry in sorted(os.listdir(hwmon_base)):
                hdir = os.path.join(hwmon_base, entry)
                name_file = os.path.join(hdir, "name")
                if not os.path.isfile(name_file):
                    continue
                with open(name_file, "r", encoding="utf-8") as f:
                    hname = f.read().strip().lower()
                if "rp1" in hname and os.path.isfile(os.path.join(hdir, "temp1_input")):
                    with open(os.path.join(hdir, "temp1_input"), "r", encoding="utf-8") as tf:
                        rp1_temp_c = round(int(tf.read().strip()) / 1000.0, 1)
                elif "fan" in hname and os.path.isfile(os.path.join(hdir, "fan1_input")):
                    with open(os.path.join(hdir, "fan1_input"), "r", encoding="utf-8") as ff:
                        fan_rpm = int(ff.read().strip())
        except Exception:
            pass

    if temp_c is None and shutil.which("vcgencmd"):
        out = run_cmd_safe(["vcgencmd", "measure_temp"], timeout=2.0)
        m = re.search(r"temp=([0-9.]+)", out)
        if m:
            temp_c = round(float(m.group(1)), 1)
            temp_sensor = "VideoCore SoC"

    if shutil.which("vcgencmd"):
        out = run_cmd_safe(["vcgencmd", "get_throttled"], timeout=2.0)
        m = re.search(r"0x([0-9a-fA-F]+)", out)
        if m:
            mask = int(m.group(1), 16)
            if mask == 0:
                throttled_status = "OK (0x0)"
            else:
                flags = []
                if mask & 0x1:
                    flags.append("Under-Voltage")
                if mask & 0x2:
                    flags.append("Freq-Capped")
                if mask & 0x4:
                    flags.append("Throttled")
                if mask & 0x8:
                    flags.append("Soft-Temp-Limit")
                throttled_status = ", ".join(flags) if flags else f"Past Event (0x{mask:x})"

    return {
        "usage_pct": usage_pct,
        "per_core_pct": per_core_pct,
        "logical_cores": logical_cores,
        "freq_mhz": freq_mhz,
        "max_freq_mhz": max_freq_mhz,
        "governor": governor,
        "model": cpu_model,
        "temperature_c": temp_c,
        "rp1_temp_c": rp1_temp_c,
        "fan_rpm": fan_rpm,
        "temp_sensor": temp_sensor,
        "throttled_status": throttled_status,
    }


def collect_host_and_load_metrics(logical_cores):
    """Collects Raspberry Pi hostname, OS release, device-tree model, uptime, process count, and 1m/5m/15m load."""
    hostname = socket.gethostname()
    os_desc = f"{platform.system()} {platform.release()} ({platform.machine()})"
    hw_model = platform.machine()
    uptime_sec = 0
    running_procs = 0
    process_count = 0
    load_1m, load_5m, load_15m = 0.0, 0.0, 0.0

    if os.path.isfile("/etc/os-release"):
        try:
            with open("/etc/os-release", "r", encoding="utf-8") as f:
                for line in f:
                    if line.startswith("PRETTY_NAME="):
                        pretty = line.split("=", 1)[1].strip().strip('"\'')
                        os_desc = f"{pretty} | Kernel {platform.release()}"
                        break
        except Exception:
            pass

    for model_path in (
        "/proc/device-tree/model",
        "/sys/firmware/devicetree/base/model",
        "/sys/devices/virtual/dmi/id/product_name",
    ):
        if os.path.isfile(model_path):
            try:
                with open(model_path, "r", encoding="utf-8", errors="replace") as f:
                    val = f.read().replace("\x00", "").strip()
                    if val:
                        hw_model = val
                        break
            except Exception:
                pass

    if os.path.isfile("/proc/uptime"):
        try:
            with open("/proc/uptime", "r", encoding="utf-8") as f:
                uptime_sec = int(float(f.read().split()[0]))
        except Exception:
            pass

    try:
        l1, l5, l15 = os.getloadavg()
        load_1m, load_5m, load_15m = round(l1, 2), round(l5, 2), round(l15, 2)
    except Exception:
        pass

    if os.path.isfile("/proc/loadavg"):
        try:
            with open("/proc/loadavg", "r", encoding="utf-8") as f:
                parts = f.read().split()
                if len(parts) >= 4 and "/" in parts[3]:
                    r_str, t_str = parts[3].split("/", 1)
                    running_procs = int(r_str)
                    process_count = int(t_str)
        except Exception:
            pass

    load_pct = round(min(100.0, (load_1m / max(1, logical_cores)) * 100.0), 1)
    return {
        "host": {
            "hostname": hostname,
            "os": os_desc,
            "hardware_model": hw_model,
            "uptime_seconds": uptime_sec,
            "uptime_human": format_uptime(uptime_sec),
            "running_processes": running_procs,
            "process_count": process_count,
        },
        "load": {
            "load_1m": load_1m,
            "load_5m": load_5m,
            "load_15m": load_15m,
            "cores": logical_cores,
            "load_pct": load_pct,
        },
    }


def collect_memory_and_swap_metrics():
    """Collects RAM and Swap memory usage from /proc/meminfo."""
    ram = {
        "total_mb": 0.0,
        "used_mb": 0.0,
        "available_mb": 0.0,
        "free_mb": 0.0,
        "cached_buffers_mb": 0.0,
        "usage_pct": 0.0,
    }
    swap = {
        "total_mb": 0.0,
        "used_mb": 0.0,
        "free_mb": 0.0,
        "usage_pct": 0.0,
    }

    info = {}
    if os.path.isfile("/proc/meminfo"):
        try:
            with open("/proc/meminfo", "r", encoding="utf-8") as f:
                for line in f:
                    if ":" in line:
                        k, v = line.split(":", 1)
                        num = v.strip().split()[0]
                        info[k.strip()] = int(num)  # kB
        except Exception:
            pass

    mem_total_kb = info.get("MemTotal", 0)
    mem_free_kb = info.get("MemFree", 0)
    buffers_kb = info.get("Buffers", 0)
    cached_kb = info.get("Cached", 0) + info.get("SReclaimable", 0)
    mem_avail_kb = info.get("MemAvailable", mem_free_kb + buffers_kb + cached_kb)
    mem_used_kb = max(0, mem_total_kb - mem_avail_kb)

    if mem_total_kb > 0:
        ram["total_mb"] = round(mem_total_kb / 1024.0, 1)
        ram["used_mb"] = round(mem_used_kb / 1024.0, 1)
        ram["available_mb"] = round(mem_avail_kb / 1024.0, 1)
        ram["free_mb"] = round(mem_free_kb / 1024.0, 1)
        ram["cached_buffers_mb"] = round((buffers_kb + cached_kb) / 1024.0, 1)
        ram["usage_pct"] = round((mem_used_kb / mem_total_kb) * 100.0, 1)

    swap_total_kb = info.get("SwapTotal", 0)
    swap_free_kb = info.get("SwapFree", 0)
    swap_used_kb = max(0, swap_total_kb - swap_free_kb)
    if swap_total_kb > 0:
        swap["total_mb"] = round(swap_total_kb / 1024.0, 1)
        swap["used_mb"] = round(swap_used_kb / 1024.0, 1)
        swap["free_mb"] = round(swap_free_kb / 1024.0, 1)
        swap["usage_pct"] = round((swap_used_kb / swap_total_kb) * 100.0, 1)

    return ram, swap


def collect_filesystem_metrics():
    """Collects mounted filesystems from /proc/mounts and os.statvfs."""
    filesystems = []
    ignore_fstypes = {
        "proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "securityfs", "cgroup", "cgroup2",
        "pstore", "efivarfs", "bpf", "autofs", "mqueue", "hugetlbfs", "debugfs", "tracefs",
        "configfs", "fusectl", "nsfs", "squashfs", "rpc_pipefs", "ramfs", "binfmt_misc", "overlay",
    }
    seen_mounts = set()
    seen_devs = set()
    if os.path.isfile("/proc/mounts"):
        try:
            with open("/proc/mounts", "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) < 3:
                        continue
                    dev, mnt, fstype = parts[0], parts[1], parts[2]
                    mnt = mnt.replace("\\040", " ")
                    if fstype in ignore_fstypes and mnt != "/":
                        continue
                    if mnt.startswith(("/proc", "/sys", "/run", "/dev/pts", "/var/lib/docker")):
                        continue
                    if mnt in seen_mounts or (dev.startswith("/dev/") and dev in seen_devs and mnt != "/"):
                        continue
                    try:
                        usage = shutil.disk_usage(mnt)
                        if usage.total <= 0:
                            continue
                        seen_mounts.add(mnt)
                        if dev.startswith("/dev/"):
                            seen_devs.add(dev)
                        tot_gb = round(usage.total / (1024 ** 3), 2)
                        used_gb = round(usage.used / (1024 ** 3), 2)
                        free_gb = round(usage.free / (1024 ** 3), 2)
                        pct = round((usage.used / usage.total) * 100.0, 1)
                        filesystems.append({
                            "mountpoint": mnt,
                            "device": dev,
                            "fstype": fstype,
                            "total_gb": tot_gb,
                            "used_gb": used_gb,
                            "free_gb": free_gb,
                            "usage_pct": pct,
                        })
                    except Exception:
                        pass
        except Exception:
            pass
    return filesystems


def _classify_nic_type(name, is_wireless=False):
    """Classifies Linux network interface into Ethernet, Wi-Fi, VPN/Tunnel, or Virtual/Bridge."""
    n = (name or "").lower()
    if is_wireless or "wlan" in n or n.startswith("wl"):
        return "Wi-Fi"
    if any(p in n for p in ("wg", "tailscale", "tun", "tap", "vpn", "zt")):
        return "VPN/Tunnel"
    if any(p in n for p in ("docker", "br-", "veth", "virbr")):
        return "Docker/Bridge"
    return "Ethernet"


def collect_network_interfaces():
    """Collects Raspberry Pi local network interfaces, IPs, MACs, link speeds, traffic counters, and throughput rates."""
    global _PREV_NET_IO, _PREV_NET_TS

    def _read_dev_counters():
        stats = {}
        if os.path.isfile("/proc/net/dev"):
            try:
                with open("/proc/net/dev", "r", encoding="utf-8") as f:
                    for line in f:
                        if ":" not in line:
                            continue
                        iface, rest = line.split(":", 1)
                        iface = iface.strip()
                        # Skip loopback and ephemeral container veth pairs
                        if iface == "lo" or iface.startswith("veth"):
                            continue
                        cols = [int(x) for x in rest.split()]
                        if len(cols) >= 16:
                            stats[iface] = {
                                "rx_bytes": cols[0],
                                "rx_packets": cols[1],
                                "rx_errors": cols[2],
                                "rx_dropped": cols[3],
                                "tx_bytes": cols[8],
                                "tx_packets": cols[9],
                                "tx_errors": cols[10],
                                "tx_dropped": cols[11],
                            }
            except Exception:
                pass
        return stats

    dev_stats = _read_dev_counters()
    now_ts = time.time()

    # If this is the first run (e.g. --once), take a 300ms delta so real-time throughput rates are populated immediately
    if not _PREV_NET_IO or _PREV_NET_TS <= 0:
        _PREV_NET_IO = {k: (v["rx_bytes"], v["tx_bytes"]) for k, v in dev_stats.items()}
        _PREV_NET_TS = now_ts
        time.sleep(0.3)
        dev_stats = _read_dev_counters()
        now_ts = time.time()

    dt = max(0.001, now_ts - _PREV_NET_TS)
    new_net_io = {}

    # Read IP addresses via `ip -j addr show`
    ip_map = {}
    if shutil.which("ip"):
        out = run_cmd_safe(["ip", "-j", "addr", "show"], timeout=2.5)
        if out:
            try:
                for entry in json.loads(out):
                    ifname = entry.get("ifname", "")
                    ipv4_list = []
                    ipv6_list = []
                    for a in entry.get("addr_info") or []:
                        fam = a.get("family")
                        local = a.get("local")
                        plen = a.get("prefixlen")
                        if fam == "inet" and local:
                            ipv4_list.append(f"{local}/{plen}" if plen is not None else local)
                        elif fam == "inet6" and local:
                            ipv6_list.append(local)
                    ip_map[ifname] = {
                        "ipv4": ipv4_list,
                        "ipv6": ipv6_list,
                        "mac": normalize_mac(entry.get("address", "")),
                        "operstate": (entry.get("operstate") or "UNKNOWN").upper(),
                        "mtu": entry.get("mtu") or 1500,
                    }
            except Exception:
                pass

    # Default gateway per interface via `ip -j route show default`
    gw_by_iface = {}
    if shutil.which("ip"):
        out = run_cmd_safe(["ip", "-j", "route", "show", "default"], timeout=2.0)
        if out:
            try:
                for r in json.loads(out):
                    dev = r.get("dev")
                    gw = r.get("gateway")
                    if dev and gw and gw not in gw_by_iface.get(dev, []):
                        gw_by_iface.setdefault(dev, []).append(gw)
            except Exception:
                pass

    interfaces = []
    for iface, st in dev_stats.items():
        sys_dir = f"/sys/class/net/{iface}"
        ip_info = ip_map.get(iface, {})
        mac = ip_info.get("mac") or ""
        if not mac and os.path.isfile(f"{sys_dir}/address"):
            try:
                with open(f"{sys_dir}/address", "r", encoding="utf-8") as f:
                    mac = normalize_mac(f.read().strip())
            except Exception:
                pass

        oper = ip_info.get("operstate") or "UNKNOWN"
        if oper == "UNKNOWN" and os.path.isfile(f"{sys_dir}/operstate"):
            try:
                with open(f"{sys_dir}/operstate", "r", encoding="utf-8") as f:
                    oper = f.read().strip().upper()
            except Exception:
                pass
        oper = "UP" if oper == "UP" else "DOWN"

        is_wireless = os.path.isdir(f"{sys_dir}/wireless") or os.path.isdir(f"{sys_dir}/phy80211")
        speed_mbps = 0.0
        if os.path.isfile(f"{sys_dir}/speed"):
            try:
                with open(f"{sys_dir}/speed", "r", encoding="utf-8") as f:
                    sp = int(f.read().strip())
                    if sp > 0:
                        speed_mbps = float(sp)
            except Exception:
                pass

        wifi_meta = {}
        if is_wireless and shutil.which("iw"):
            link_out = run_cmd_safe(["iw", "dev", iface, "link"], timeout=2.0)
            if link_out and "Connected to" in link_out:
                m_bssid = re.search(r"Connected to ([0-9a-fA-F:]{17})", link_out)
                if m_bssid:
                    wifi_meta["wifi_bssid"] = normalize_mac(m_bssid.group(1))
                m_ssid = re.search(r"^\s*SSID:\s*(.+)$", link_out, re.MULTILINE)
                if m_ssid:
                    wifi_meta["wifi_ssid"] = m_ssid.group(1).strip()
                m_sig = re.search(r"^\s*signal:\s*(-?[0-9.]+)\s*dBm", link_out, re.MULTILINE)
                if m_sig:
                    dbm = int(round(float(m_sig.group(1))))
                    wifi_meta["wifi_signal_dbm"] = dbm
                    wifi_meta["wifi_signal_pct"] = max(0, min(100, 2 * (dbm + 100)))
                m_tx = re.search(r"^\s*tx bitrate:\s*([0-9.]+)\s*MBit/s", link_out, re.MULTILINE)
                if m_tx and speed_mbps <= 0:
                    speed_mbps = round(float(m_tx.group(1)), 1)

        rx_b = st["rx_bytes"]
        tx_b = st["tx_bytes"]
        new_net_io[iface] = (rx_b, tx_b)

        rx_kbps = 0.0
        tx_kbps = 0.0
        if iface in _PREV_NET_IO:
            prev_rx, prev_tx = _PREV_NET_IO[iface]
            if rx_b >= prev_rx:
                rx_kbps = round(((rx_b - prev_rx) * 8.0) / (dt * 1000.0), 2)
            if tx_b >= prev_tx:
                tx_kbps = round(((tx_b - prev_tx) * 8.0) / (dt * 1000.0), 2)

        nic_type = _classify_nic_type(iface, is_wireless)
        interfaces.append({
            "name": iface,
            "type": nic_type,
            "operstate": oper,
            "mac_address": mac,
            "vendor": resolve_mac_vendor(mac, allow_network=True),
            "speed_mbps": speed_mbps,
            "mtu": ip_info.get("mtu", 1500),
            "ipv4": ip_info.get("ipv4", []),
            "ipv6": ip_info.get("ipv6", []),
            "gateways": gw_by_iface.get(iface, []),
            "rx_rate_kbps": rx_kbps,
            "tx_rate_kbps": tx_kbps,
            **st,
            **wifi_meta,
        })

    _PREV_NET_IO = new_net_io
    _PREV_NET_TS = now_ts

    interfaces.sort(
        key=lambda x: (
            0 if x.get("type") in ("Ethernet", "Wi-Fi") else 1,
            0 if x.get("operstate") == "UP" else 1,
            x.get("name", ""),
        )
    )
    return interfaces


# =====================================================================
# RASPBERRY PI WI-FI SCANNING & LAN DEVICE DISCOVERY
# =====================================================================

def _freq_to_band_and_channel(freq_mhz):
    """Converts 802.11 frequency in MHz to (band_str, channel_int)."""
    if not freq_mhz:
        return "Unknown", 0
    f = int(freq_mhz)
    if f == 2484:
        return "2.4 GHz", 14
    if 2412 <= f <= 2472:
        return "2.4 GHz", (f - 2407) // 5
    if 5000 <= f <= 5895:
        return "5 GHz", (f - 5000) // 5
    if 5925 <= f <= 7125:
        return "6 GHz", (f - 5950) // 5
    return f"{round(f / 1000.0, 1)} GHz", 0


def _unescape_iw_ssid(raw_ssid):
    """Unescapes \\xHH sequences in iw scan SSID strings."""
    if not raw_ssid:
        return ""
    try:
        s = re.sub(
            r"\\x([0-9a-fA-F]{2})",
            lambda m: chr(int(m.group(1), 16)),
            raw_ssid,
        )
        return s.strip()
    except Exception:
        return raw_ssid.strip()


def scan_wifi_networks():
    """Scans visible Wi-Fi networks on the Raspberry Pi using `iw dev <iface> scan` and `nmcli` fallback."""
    networks = []
    seen_bssids = set()

    wlan_ifaces = []
    if os.path.isdir("/sys/class/net"):
        for iface in sorted(os.listdir("/sys/class/net")):
            if os.path.isdir(f"/sys/class/net/{iface}/wireless") or os.path.isdir(f"/sys/class/net/{iface}/phy80211"):
                wlan_ifaces.append(iface)

    connected_bssid = ""
    for iface in wlan_ifaces:
        if shutil.which("iw"):
            link_out = run_cmd_safe(["iw", "dev", iface, "link"], timeout=2.0)
            m_bssid = re.search(r"Connected to ([0-9a-fA-F:]{17})", link_out)
            if m_bssid:
                connected_bssid = normalize_mac(m_bssid.group(1))

    # 1. Hardware scan via `iw dev <iface> scan`
    for iface in wlan_ifaces:
        if not shutil.which("iw"):
            break
        scan_out = ""
        for cmd in (["iw", "dev", iface, "scan"], ["iw", "dev", iface, "scan", "dump"]):
            scan_out = run_cmd_safe(cmd, timeout=6.0)
            if "BSS " in scan_out:
                break
        if not scan_out:
            continue

        blocks = re.split(r"^BSS (?=[0-9a-fA-F:]{17})", scan_out, flags=re.MULTILINE)
        for blk in blocks[1:]:
            m_mac = re.match(r"([0-9a-fA-F:]{17})", blk)
            if not m_mac:
                continue
            bssid = normalize_mac(m_mac.group(1))
            if not bssid or bssid in seen_bssids:
                continue
            seen_bssids.add(bssid)

            m_ssid = re.search(r"^\s*SSID:\s*(.*)$", blk, re.MULTILINE)
            ssid = _unescape_iw_ssid(m_ssid.group(1)) if m_ssid else ""
            if not ssid:
                ssid = "<Hidden Network>"

            m_freq = re.search(r"^\s*freq:\s*([0-9.]+)", blk, re.MULTILINE)
            freq = int(float(m_freq.group(1))) if m_freq else None
            band, ch = _freq_to_band_and_channel(freq)

            m_ch = re.search(r"(?:DS Parameter set: channel|primary channel:)\s*([0-9]+)", blk)
            if m_ch:
                ch = int(m_ch.group(1))

            m_sig = re.search(r"^\s*signal:\s*(-?[0-9.]+)\s*dBm", blk, re.MULTILINE)
            sig_dbm = int(round(float(m_sig.group(1)))) if m_sig else -85
            sig_pct = max(0, min(100, 2 * (sig_dbm + 100)))

            sec_parts = []
            if "RSN:" in blk:
                sec_parts.append("WPA3-SAE" if "SAE" in blk else "WPA2-CCMP")
            if "WPA:" in blk:
                sec_parts.append("WPA")
            if not sec_parts:
                sec_parts.append("WEP/Privacy" if "Privacy" in blk[:300] else "Open")

            radio = "802.11"
            if "EHT capabilities" in blk:
                radio = "802.11be (Wi-Fi 7)"
            elif "HE capabilities" in blk:
                radio = "802.11ax (Wi-Fi 6)"
            elif "VHT capabilities" in blk:
                radio = "802.11ac (Wi-Fi 5)"
            elif "HT capabilities" in blk:
                radio = "802.11n (Wi-Fi 4)"

            is_conn = (bssid == connected_bssid) or ("associated" in blk[:120])
            networks.append({
                "ssid": ssid,
                "bssid": bssid,
                "vendor": resolve_mac_vendor(bssid, allow_network=True),
                "channel": ch,
                "frequency_mhz": freq,
                "band": band,
                "radio_type": radio,
                "signal_pct": sig_pct,
                "signal_dbm": sig_dbm,
                "security": "/".join(sec_parts),
                "connected": is_conn,
                "interface": iface,
            })

    # 2. Supplement / fallback with `nmcli`
    if shutil.which("nmcli"):
        out = run_cmd_safe(
            ["nmcli", "-t", "-f", "IN-USE,BSSID,SSID,CHAN,FREQ,SIGNAL,SECURITY,DEVICE", "dev", "wifi", "list"],
            timeout=4.0,
        )
        for line in out.splitlines():
            line_clean = line.replace("\\:", "-")
            parts = line_clean.split(":")
            if len(parts) >= 7:
                in_use = parts[0].strip() == "*"
                bssid = normalize_mac(parts[1])
                if not bssid or bssid in seen_bssids:
                    continue
                seen_bssids.add(bssid)
                ssid = parts[2].strip() or "<Hidden Network>"
                ch = int(parts[3]) if parts[3].isdigit() else 0
                m_f = re.search(r"([0-9]+)", parts[4])
                freq = int(m_f.group(1)) if m_f else None
                band, _ = _freq_to_band_and_channel(freq)
                sig_pct = int(parts[5]) if parts[5].isdigit() else 0
                sig_dbm = int(round((sig_pct / 2.0) - 100))
                sec = parts[6].strip() or "Open"
                dev = parts[7].strip() if len(parts) > 7 else (wlan_ifaces[0] if wlan_ifaces else "wlan0")
                networks.append({
                    "ssid": ssid,
                    "bssid": bssid,
                    "vendor": resolve_mac_vendor(bssid, allow_network=True),
                    "channel": ch,
                    "frequency_mhz": freq,
                    "band": band,
                    "radio_type": "802.11",
                    "signal_pct": sig_pct,
                    "signal_dbm": sig_dbm,
                    "security": sec,
                    "connected": in_use,
                    "interface": dev,
                })

    networks.sort(key=lambda x: (0 if x.get("connected") else 1, -(x.get("signal_dbm") or -100), x.get("ssid", "")))
    return networks


# --- Multi-Protocol LAN Name Resolution Helpers (DNS, NetBIOS, Samba, mDNS/Avahi, HTTP) ---

def _build_dns_ptr_query(ip_str, unicast_response_bit=False):
    tid = random.randint(1, 65534)
    header = struct.pack("!HHHHHH", tid, 0x0100, 1, 0, 0, 0)
    rev_name = ".".join(reversed(ip_str.split("."))) + ".in-addr.arpa"
    qname = b"".join(bytes([len(lbl)]) + lbl.encode("ascii") for lbl in rev_name.split(".")) + b"\x00"
    qclass = 0x8001 if unicast_response_bit else 0x0001
    return header + qname + struct.pack("!HH", 12, qclass)


def _decode_dns_labels(pkt, offset):
    labels = []
    jumps = 0
    while offset < len(pkt) and jumps < 12:
        length = pkt[offset]
        if length == 0:
            break
        if (length & 0xC0) == 0xC0:
            if offset + 1 >= len(pkt):
                break
            offset = ((length & 0x3F) << 8) | pkt[offset + 1]
            jumps += 1
        else:
            offset += 1
            labels.append(pkt[offset : offset + length].decode("utf-8", errors="replace"))
            offset += length
    return ".".join(labels).rstrip(".")


def _parse_dns_ptr_response(pkt):
    if not pkt or len(pkt) < 12:
        return None
    _, _, qdcount, ancount, _, _ = struct.unpack("!HHHHHH", pkt[:12])
    if ancount <= 0:
        return None
    off = 12
    for _ in range(qdcount):
        while off < len(pkt) and pkt[off] != 0:
            if (pkt[off] & 0xC0) == 0xC0:
                off += 1
                break
            off += 1 + pkt[off]
        off += 5
    for _ in range(ancount):
        if off >= len(pkt):
            break
        if (pkt[off] & 0xC0) == 0xC0:
            off += 2
        else:
            while off < len(pkt) and pkt[off] != 0:
                off += 1 + pkt[off]
            off += 1
        if off + 10 > len(pkt):
            break
        rtype, _, _, rdlen = struct.unpack("!HHIH", pkt[off : off + 10])
        off += 10
        if rtype == 12 and off + rdlen <= len(pkt):
            name = _decode_dns_labels(pkt, off)
            if name:
                return name
        off += rdlen
    return None


def _build_nbstat_query():
    tid = random.randint(1, 65534)
    header = struct.pack("!HHHHHH", tid, 0x0000, 1, 0, 0, 0)
    qname = b"\x20CKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\x00"
    return header + qname + struct.pack("!HH", 0x0021, 0x0001)


def _collect_samba_netbios_map(max_wait_sec=2.0):
    """
    Safely inspects active Samba sessions (`smbstatus -b` + `/proc/<pid>/fd`) and non-empty
    Samba browse/log files with a strict timeout budget so empty or locked log files never block.
    Returns dict mapping IP -> (netbios_name, workgroup).
    """
    deadline = time.monotonic() + max_wait_sec
    nb_map = {}

    # 1. Inspect active smbd processes via `smbstatus -b` with strict timeout
    if shutil.which("smbstatus"):
        rem = max(0.3, deadline - time.monotonic())
        out = run_cmd_safe(["smbstatus", "-b"], timeout=min(1.5, rem))
        for line in out.splitlines():
            if time.monotonic() > deadline:
                break
            # Format: 207886  root  root  192.168.1.7 (ipv4:192.168.1.7:49697) ...
            m = re.match(r"^\s*(\d+)\s+\S+\s+\S+\s+(\S+)\s+\(ipv4:(\d+\.\d+\.\d+\.\d+):", line)
            if m:
                pid_str, machine_col, ip_str = m.group(1), m.group(2).strip(), m.group(3)
                nb_name = ""
                if machine_col and machine_col != ip_str and not re.match(r"^\d+\.\d+\.\d+\.\d+$", machine_col):
                    nb_name = machine_col.upper()
                if not nb_name:
                    # Check /proc/<pid>/fd/2 and /proc/<pid>/fd/3 symlinks (e.g. /var/log/samba/log.tsltp02)
                    for fd_num in (2, 3):
                        fd_path = f"/proc/{pid_str}/fd/{fd_num}"
                        try:
                            target = os.readlink(fd_path)
                            base = os.path.basename(target)
                            if base.startswith("log.") and len(base) > 4:
                                cand = base[4:]
                                if cand and cand != ip_str and not re.match(r"^\d+\.\d+\.\d+\.\d+$", cand):
                                    if cand not in ("smbd", "nmbd", "winbindd"):
                                        nb_name = cand.upper()
                                        break
                        except Exception:
                            pass
                if nb_name:
                    nb_map[ip_str] = (nb_name, "WORKGROUP")

    # 2. Safely inspect /var/log/samba/log.* with empty-file check and strict deadline
    samba_log_dir = "/var/log/samba"
    if time.monotonic() < deadline and os.path.isdir(samba_log_dir):
        try:
            for fname in os.listdir(samba_log_dir):
                if time.monotonic() > deadline:
                    break
                if not fname.startswith("log.") or len(fname) <= 4:
                    continue
                suffix = fname[4:]
                if suffix in ("smbd", "nmbd", "winbindd", "wb-RPI") or suffix.startswith(("rpcd_", "samba-", "2800_", "fe80_")):
                    continue
                if re.match(r"^\d+\.\d+\.\d+\.\d+$", suffix):
                    continue
                fpath = os.path.join(samba_log_dir, fname)
                try:
                    # Skip non-regular or empty (0-byte) log files immediately without opening
                    st = os.stat(fpath)
                    if st.st_size <= 0:
                        continue
                    with open(fpath, "rb") as f:
                        if st.st_size > 8192:
                            f.seek(st.st_size - 8192)
                        tail_text = f.read(8192).decode("utf-8", errors="replace")
                    m_ip = re.findall(r"\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b", tail_text)
                    for ip_cand in reversed(m_ip):
                        if not ip_cand.startswith("127.") and ip_cand not in nb_map:
                            nb_map[ip_cand] = (suffix.upper(), "WORKGROUP")
                            break
                except Exception:
                    continue
        except Exception:
            pass

    return nb_map


def query_netbios_node_status(ip_str, samba_nb_map, timeout=0.6):
    """Queries NetBIOS name via active Samba map, UDP 137 NBSTAT socket, and nmblookup fallback."""
    if ip_str in samba_nb_map:
        return samba_nb_map[ip_str]

    # 1. Direct UDP 137 NBSTAT query
    pkt = _build_nbstat_query()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(pkt, (ip_str, 137))
        data, _ = sock.recvfrom(1024)
        if len(data) > 57:
            num_names = data[56]
            pos = 57
            unique_names = []
            workgroup = ""
            for _ in range(num_names):
                if pos + 18 > len(data):
                    break
                raw_name = data[pos : pos + 15].decode("latin-1", errors="replace").strip()
                clean_name = "".join(ch for ch in raw_name if 32 <= ord(ch) <= 126).strip()
                suffix = data[pos + 15]
                nb_flags = struct.unpack("!H", data[pos + 16 : pos + 18])[0]
                is_group = bool(nb_flags & 0x8000)
                if clean_name and not clean_name.startswith("__"):
                    if not is_group and suffix in (0x00, 0x20):
                        if clean_name not in unique_names:
                            unique_names.append(clean_name)
                    elif is_group and suffix in (0x00, 0x1E) and not workgroup:
                        workgroup = clean_name
                pos += 18
            if unique_names:
                return unique_names[0], workgroup
    except Exception:
        pass
    finally:
        sock.close()

    # 2. Fallback to `nmblookup -A <ip>` with strict 1.2s timeout
    if shutil.which("nmblookup"):
        out = run_cmd_safe(["nmblookup", "-A", ip_str], timeout=1.2)
        if out and "No reply" not in out:
            unique_name = ""
            workgroup = ""
            for line in out.splitlines():
                m = re.match(r"^\s*([A-Za-z0-9._-]+)\s+<([0-9a-fA-F]{2})>\s+-\s+(.*)$", line)
                if m:
                    nm, code, flags = m.group(1).strip(), m.group(2).lower(), m.group(3)
                    if "<GROUP>" in flags and code in ("00", "1e") and not workgroup:
                        workgroup = nm
                    elif "<GROUP>" not in flags and code in ("00", "20") and not unique_name:
                        unique_name = nm
            if unique_name:
                return unique_name, workgroup

    return "", ""


def query_mdns_avahi(ip_str, timeout=1.3):
    """Resolves mDNS (.local) hostname via avahi-daemon Unix socket on Raspberry Pi or UDP 5353 fallback."""
    # 1. Query /run/avahi-daemon/socket serialized with _AVAHI_LOCK so avahi-daemon doesn't drop concurrent requests
    for sock_path in ("/run/avahi-daemon/socket", "/var/run/avahi-daemon/socket"):
        if os.path.exists(sock_path):
            with _AVAHI_LOCK:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.settimeout(timeout)
                try:
                    s.connect(sock_path)
                    s.sendall(f"RESOLVE-ADDRESS {ip_str}\n".encode("ascii"))
                    resp = s.recv(512).decode("utf-8", errors="replace").strip()
                    # Format: "+ 3 0 Android_CCMZSQAW.local"
                    if resp.startswith("+"):
                        parts = resp.split()
                        if len(parts) >= 4:
                            return parts[3].strip()
                except Exception:
                    pass
                finally:
                    s.close()
            break

    # 2. Fallback to direct UDP 5353 unicast PTR query
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(0.5)
    try:
        q = _build_dns_ptr_query(ip_str, unicast_response_bit=True)
        sock.sendto(q, (ip_str, 5353))
        resp, _ = sock.recvfrom(1024)
        name = _parse_dns_ptr_response(resp)
        if name and name != ip_str and not name.endswith(".in-addr.arpa"):
            return name
    except Exception:
        pass
    finally:
        sock.close()
    return ""


def _is_valid_resolved_hostname(name, ip_str):
    """Returns True if `name` is a genuine hostname and not just an echoed IP address string."""
    if not name:
        return False
    n = name.strip().rstrip(".")
    if not n or n == ip_str or n.endswith(".in-addr.arpa"):
        return False
    if re.match(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$", n):
        return False
    return True


def query_dns_ptr(ip_str, dns_servers, dhcp_leases, timeout=0.6):
    """Resolves reverse DNS name via DHCP leases, system resolver, and direct DNS PTR queries."""
    if ip_str in dhcp_leases and _is_valid_resolved_hostname(dhcp_leases[ip_str], ip_str):
        return dhcp_leases[ip_str]

    try:
        host, _, _ = socket.gethostbyaddr(ip_str)
        if _is_valid_resolved_hostname(host, ip_str):
            return host
    except Exception:
        pass

    for srv in dns_servers:
        if not srv:
            continue
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(timeout)
        try:
            q = _build_dns_ptr_query(ip_str, unicast_response_bit=False)
            sock.sendto(q, (srv, 53))
            resp, _ = sock.recvfrom(1024)
            name = _parse_dns_ptr_response(resp)
            if _is_valid_resolved_hostname(name, ip_str):
                return name
        except Exception:
            pass
        finally:
            sock.close()

    return ""


def query_http_device_title(ip_str, timeout=1.0):
    """Fetches HTTP/HTTPS <title> from web management interfaces (e.g., routers/gateways)."""
    ctx = ssl._create_unverified_context()
    for proto in ("http", "https"):
        try:
            req = urllib.request.Request(f"{proto}://{ip_str}/", headers={"User-Agent": "CloudMonitorDaemon/1.0"})
            with urllib.request.urlopen(req, timeout=timeout, context=ctx if proto == "https" else None) as resp:
                raw = resp.read(4096).decode("utf-8", errors="replace")
                m = re.search(r"<title[^>]*>(.*?)</title>", raw, re.IGNORECASE | re.DOTALL)
                if m:
                    title = html.unescape(m.group(1)).strip()
                    title = re.sub(r"\s+", " ", title)
                    if title and len(title) <= 40:
                        return title
        except Exception:
            pass
    return ""


def _measure_host_rtt_ms(ip_str):
    """Measures quick TCP reachability latency in milliseconds."""
    for port in (80, 443, 22, 445, 139, 53):
        t0 = time.perf_counter()
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.2)
        try:
            err = s.connect_ex((ip_str, port))
            elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 1)
            if err in (0, 111, 10061):
                return elapsed_ms
        except Exception:
            pass
        finally:
            s.close()
    return None


def _load_local_dhcp_and_hosts():
    """Loads IP -> hostname mappings from local DHCP lease files and /etc/hosts."""
    mapping = {}
    lease_files = [
        "/var/lib/misc/dnsmasq.leases",
        "/tmp/dhcp.leases",
        "/var/lib/NetworkManager/dnsmasq-*.leases",
    ]
    for lf in lease_files:
        if os.path.isfile(lf) and os.path.getsize(lf) > 0:
            try:
                with open(lf, "r", encoding="utf-8", errors="replace") as f:
                    for line in f:
                        parts = line.split()
                        if len(parts) >= 4 and re.match(r"^\d+\.\d+\.\d+\.\d+$", parts[2]):
                            h = parts[3].strip()
                            if h and h != "*":
                                mapping[parts[2]] = h
            except Exception:
                pass
    if os.path.isfile("/etc/hosts") and os.path.getsize("/etc/hosts") > 0:
        try:
            with open("/etc/hosts", "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.split("#", 1)[0].strip()
                    parts = line.split()
                    if len(parts) >= 2 and re.match(r"^\d+\.\d+\.\d+\.\d+$", parts[0]):
                        if not parts[0].startswith("127."):
                            mapping[parts[0]] = parts[1].strip()
        except Exception:
            pass
    return mapping


def scan_lan_devices(interfaces, wifi_networks=None):
    """
    Runs an active LAN subnet sweep + kernel neighbor inspection on the Raspberry Pi,
    then concurrently resolves MAC Vendor (OUI), Reverse DNS, NetBIOS (Samba/NBSTAT/nmblookup),
    and mDNS (Avahi) names for every discovered device.
    """
    t_start = time.perf_counter()
    wifi_networks = wifi_networks or []

    # Build BSSID -> SSID lookup (including matching lower 5 MAC octets for Wi-Fi extenders/APs)
    bssid_exact_map = {}
    bssid_suffix_map = {}
    for w in wifi_networks:
        b_mac = normalize_mac(w.get("bssid", ""))
        w_ssid = w.get("ssid", "")
        if b_mac and w_ssid and w_ssid != "<Hidden Network>":
            bssid_exact_map[b_mac] = w_ssid
            bssid_suffix_map[b_mac[3:]] = w_ssid

    # 1. Identify physical LAN interfaces, local IPs, primary subnet, and gateway
    local_ips = {}  # ip -> (mac, iface_name)
    primary_ip = ""
    subnet_cidr = ""
    gateway_ip = ""
    dns_servers = []
    lan_ifaces = set()

    for nic in interfaces:
        if nic.get("operstate") == "UP" and nic.get("type") in ("Ethernet", "Wi-Fi"):
            ifname = nic.get("name", "")
            lan_ifaces.add(ifname)
            for cidr in nic.get("ipv4") or []:
                ip_part = cidr.split("/")[0]
                if not ip_part.startswith(("127.", "169.254.")):
                    local_ips[ip_part] = (nic.get("mac_address", ""), ifname)
                    if not primary_ip:
                        primary_ip = ip_part
                        subnet_cidr = cidr if "/" in cidr else f"{ip_part}/24"
                    if not gateway_ip and nic.get("gateways"):
                        gateway_ip = nic["gateways"][0]

    if gateway_ip:
        dns_servers.append(gateway_ip)

    if os.path.isfile("/etc/resolv.conf"):
        try:
            with open("/etc/resolv.conf", "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip().startswith("nameserver"):
                        parts = line.split()
                        if len(parts) >= 2 and re.match(r"^\d+\.\d+\.\d+\.\d+$", parts[1]):
                            if parts[1] not in dns_servers and not parts[1].startswith("127."):
                                dns_servers.append(parts[1])
        except Exception:
            pass

    target_net = None
    target_ips = []
    network_str = ""
    if primary_ip:
        try:
            target_net = ipaddress.IPv4Interface(subnet_cidr).network
            if target_net.prefixlen < 24:
                target_net = ipaddress.IPv4Network(f"{primary_ip}/24", strict=False)
            network_str = str(target_net)
            target_ips = [str(ip) for ip in target_net.hosts()]
        except Exception:
            pass

    # 2. Active UDP subnet sweep to trigger Linux kernel ARP resolution for all live L2 hosts
    if target_ips:
        nb_pkt = _build_nbstat_query()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setblocking(False)
        try:
            for ip_str in target_ips:
                if ip_str in local_ips:
                    continue
                try:
                    sock.sendto(b"\x00", (ip_str, 33434))
                    sock.sendto(nb_pkt, (ip_str, 137))
                except Exception:
                    pass
        finally:
            sock.close()
        time.sleep(0.35)

    # 3. Collect discovered L2 neighbors from /proc/net/arp and `ip -j neigh show`
    discovered = {}  # ip -> {"mac": mac, "state": state, "iface": iface}
    for lip, (lmac, liface) in local_ips.items():
        discovered[lip] = {"mac": lmac, "state": "ONLINE", "iface": liface}

    if os.path.isfile("/proc/net/arp"):
        try:
            with open("/proc/net/arp", "r", encoding="utf-8") as f:
                for line in f.readlines()[1:]:
                    parts = line.split()
                    if len(parts) >= 6:
                        ip_s, flags_hex, mac_s, dev_s = parts[0], parts[2], normalize_mac(parts[3]), parts[5]
                        if lan_ifaces and dev_s not in lan_ifaces:
                            continue
                        if flags_hex != "0x0" and mac_s and mac_s != "00:00:00:00:00:00":
                            discovered[ip_s] = {"mac": mac_s, "state": "REACHABLE", "iface": dev_s}
        except Exception:
            pass

    if shutil.which("ip"):
        out = run_cmd_safe(["ip", "-j", "neigh", "show"], timeout=2.5)
        if out:
            try:
                for entry in json.loads(out):
                    dst = entry.get("dst", "")
                    dev_s = entry.get("dev", "")
                    lladdr = normalize_mac(entry.get("lladdr", ""))
                    state_list = entry.get("state") or []
                    state = state_list[0] if state_list else "REACHABLE"
                    if lan_ifaces and dev_s not in lan_ifaces:
                        continue
                    if dst and ":" not in dst and lladdr and lladdr != "00:00:00:00:00:00":
                        if state not in ("FAILED", "INCOMPLETE"):
                            discovered[dst] = {"mac": lladdr, "state": state, "iface": dev_s}
            except Exception:
                pass

    # Pre-load DHCP leases and Samba NetBIOS client table (with strict timeout & empty-file safety)
    dhcp_leases = _load_local_dhcp_and_hosts()
    samba_nb_map = _collect_samba_netbios_map(max_wait_sec=2.0)
    local_hostname = socket.gethostname()

    def _inspect_single_device(ip_str, meta):
        mac = normalize_mac(meta.get("mac", ""))
        iface = meta.get("iface", "")
        is_self = ip_str in local_ips
        is_gw = ip_str == gateway_ip
        role = f"THIS NODE ({iface})" if is_self else ("GATEWAY" if is_gw else "PEER")

        vendor = resolve_mac_vendor(mac, allow_network=True)

        # Cross-reference Wi-Fi AP BSSIDs (e.g. Wi-Fi extenders whose virtual BSSID shares the lower 5 octets)
        ap_ssid = bssid_exact_map.get(mac) or (bssid_suffix_map.get(mac[3:]) if len(mac) == 17 else None)
        if ap_ssid and vendor in ("Unknown Vendor", "Randomized / Locally Administered MAC"):
            vendor = f"Wi-Fi AP / Extender ({ap_ssid})"

        if is_self:
            dns_name = local_hostname
            nb_name = local_hostname.upper()
            nb_group = "WORKGROUP"
            mdns_name = f"{local_hostname.lower()}.local"
            rtt_ms = 0.1
            status = "ONLINE"
            device_label = ""
        else:
            cache_key = mac or ip_str
            cached_names = _LAN_NAME_CACHE.get(cache_key, {})
            rtt_ms = _measure_host_rtt_ms(ip_str)
            dns_name = query_dns_ptr(ip_str, dns_servers, dhcp_leases) or cached_names.get("dns", "")
            nb_name, nb_group = query_netbios_node_status(ip_str, samba_nb_map)
            if not nb_name and cached_names.get("nb"):
                nb_name = cached_names["nb"]
                nb_group = cached_names.get("nb_grp", "")
            mdns_name = query_mdns_avahi(ip_str) or cached_names.get("mdns", "")
            status = "ONLINE" if (rtt_ms is not None or dns_name or nb_name or mdns_name) else meta.get("state", "REACHABLE")

            # Fallback hostname discovery via HTTP title (for routers/appliances) or matched AP SSID
            device_label = cached_names.get("label", "")
            if not (dns_name or nb_name or mdns_name or device_label):
                if is_gw or rtt_ms is not None:
                    device_label = query_http_device_title(ip_str, timeout=1.0)
                if not device_label and ap_ssid:
                    device_label = ap_ssid

            if dns_name or nb_name or mdns_name or device_label:
                _LAN_NAME_CACHE[cache_key] = {
                    "dns": dns_name,
                    "nb": nb_name,
                    "nb_grp": nb_group,
                    "mdns": mdns_name,
                    "label": device_label,
                }

        primary_hostname = (
            dns_name
            or nb_name
            or (mdns_name[:-6] if mdns_name.endswith(".local") else mdns_name)
            or device_label
            or ("Default Gateway" if is_gw else "-")
        )

        return {
            "ip": ip_str,
            "mac": mac or "Unknown",
            "vendor": vendor,
            "hostname": primary_hostname,
            "dns_name": dns_name or "-",
            "netbios_name": nb_name or "-",
            "netbios_group": nb_group or "",
            "mdns_name": mdns_name or "-",
            "interface": iface,
            "role": role,
            "status": status,
            "rtt_ms": rtt_ms,
        }

    devices = []
    if discovered:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(24, len(discovered) + 1)) as pool:
            futures = [pool.submit(_inspect_single_device, ip_s, meta) for ip_s, meta in discovered.items()]
            for fut in concurrent.futures.as_completed(futures):
                try:
                    devices.append(fut.result())
                except Exception:
                    pass

    devices.sort(
        key=lambda d: tuple(int(p) for p in d["ip"].split("."))
        if re.match(r"^\d+\.\d+\.\d+\.\d+$", d["ip"])
        else (999,)
    )
    duration_ms = int(round((time.perf_counter() - t_start) * 1000))

    return {
        "summary": {
            "local_ip": primary_ip or "Disconnected",
            "subnet": network_str or subnet_cidr or "N/A",
            "gateway_ip": gateway_ip or "N/A",
            "dns_servers": dns_servers,
            "active_devices_count": len(devices),
            "scan_duration_ms": duration_ms,
        },
        "devices": devices,
    }


def collect_local_and_lan_telemetry():
    """Aggregates Raspberry Pi local system metrics, network interfaces, Wi-Fi scan, and LAN device discovery."""
    cpu_metrics = collect_cpu_and_temp_metrics()
    host_load = collect_host_and_load_metrics(cpu_metrics["logical_cores"])
    ram_metrics, swap_metrics = collect_memory_and_swap_metrics()
    filesystems = collect_filesystem_metrics()
    interfaces = collect_network_interfaces()
    wifi_networks = scan_wifi_networks()

    lan_data = scan_lan_devices(interfaces, wifi_networks=wifi_networks)
    lan_data["summary"]["wifi_networks_count"] = len(wifi_networks)

    return {
        "local_system": {
            "host": host_load["host"],
            "load": host_load["load"],
            "cpu": cpu_metrics,
            "memory": ram_metrics,
            "swap": swap_metrics,
            "filesystems": filesystems,
            "network_interfaces": interfaces,
        },
        "lan_network": {
            "summary": lan_data["summary"],
            "wifi_networks": wifi_networks,
            "lan_devices": lan_data["devices"],
        },
    }


# =====================================================================
# CLOUDFLARE EDGE & ACCOUNT BILLING TELEMETRY
# =====================================================================

def http_request_json(url, headers, method="GET", payload=None, timeout=15):
    """Performs an HTTP request using stdlib urllib and returns (status_code, parsed_json)."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req_headers = dict(headers)
    req_headers.setdefault("User-Agent", "CloudMonitorDaemon/1.0")
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8")
            return e.code, json.loads(body) if body else {}
        except Exception:
            return e.code, {}


def resolve_zone_name(default_name, zone_id, headers):
    """Resolves the actual domain name for a Cloudflare Zone ID and caches it."""
    if not zone_id or "ZONE_ID" in zone_id:
        return default_name
    if zone_id in _ZONE_NAME_CACHE:
        return _ZONE_NAME_CACHE[zone_id]
    try:
        status, body = http_request_json(f"{CF_API_BASE_URL}/zones/{zone_id}", headers, timeout=10)
        if status == 200:
            name = (body.get("result") or {}).get("name")
            if name:
                _ZONE_NAME_CACHE[zone_id] = name
                return name
    except Exception:
        pass
    return default_name


def fetch_zone_metrics(zone_name, zone_id, headers):
    """Queries Cloudflare's GraphQL API for a specific Zone ID."""
    zone_metrics = {
        "status": "HEALTHY",
        "bandwidth_gb": 0.0,
        "hit_volume": 0,
        "cache_hit_ratio": 0.0,
        "security_events": 0,
        "errors_5xx": 0,
    }

    if not zone_id or "ZONE_ID" in zone_id:
        zone_metrics["status"] = "UNCONFIGURED"
        return zone_metrics

    since_iso = (
        (datetime.now(timezone.utc) - timedelta(hours=1))
        .replace(minute=0, second=0, microsecond=0)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    )
    query = """
    query GetZoneMetrics($zoneId: String!, $since: Time!) {
      viewer {
        zones(filter: { zoneTag: $zoneId }) {
          httpRequests1hGroups(limit: 2, filter: { datetime_geq: $since }) {
            sum {
              bytes
              requests
              cachedRequests
              threats
              responseStatusMap {
                edgeResponseStatus
                requests
              }
            }
          }
        }
      }
    }
    """
    try:
        status_code, body = http_request_json(
            CF_GRAPHQL_URL,
            headers,
            method="POST",
            payload={"query": query, "variables": {"zoneId": zone_id, "since": since_iso}},
            timeout=10,
        )
        if status_code == 200:
            errors = body.get("errors")
            if errors:
                err_msg = errors[0].get("message", "GraphQL Error")
                zone_metrics["status"] = f"GQL Error: {err_msg[:40]}"
                return zone_metrics

            zones_data = ((body.get("data") or {}).get("viewer") or {}).get("zones") or []
            if zones_data:
                http_list = zones_data[0].get("httpRequests1hGroups") or []
                total_reqs = 0
                total_cached = 0
                total_bytes = 0
                total_threats = 0
                total_5xx = 0

                for group in http_list:
                    http_data = group.get("sum") or {}
                    total_reqs += http_data.get("requests", 0) or 0
                    total_cached += http_data.get("cachedRequests", 0) or 0
                    total_bytes += http_data.get("bytes", 0) or 0
                    total_threats += http_data.get("threats", 0) or 0

                    for status_entry in http_data.get("responseStatusMap") or []:
                        code = status_entry.get("edgeResponseStatus", 0) or 0
                        if 500 <= code < 600:
                            total_5xx += status_entry.get("requests", 0) or 0

                zone_metrics["hit_volume"] = total_reqs
                zone_metrics["bandwidth_gb"] = round(total_bytes / (1024 ** 3), 4)
                zone_metrics["cache_hit_ratio"] = round((total_cached / total_reqs * 100), 2) if total_reqs > 0 else 0.0
                zone_metrics["security_events"] = total_threats
                zone_metrics["errors_5xx"] = total_5xx
        else:
            zone_metrics["status"] = f"HTTP Error {status_code}"
    except Exception as e:
        zone_metrics["status"] = f"API Error: {str(e)}"

    return zone_metrics


def fetch_account_billing_and_usage(account_id, headers):
    """
    Queries Cloudflare GraphQL and REST APIs for Month-to-Date (MTD) and Daily (UTC)
    billing/quota usage across:
      1. Workers & Pages (Invocations, Pages Functions, Static Assets, Build Minutes)
      2. Workers AI (Neurons, Requests, Input/Output Tokens, Inference Time, Per-Model breakdown)
      3. D1 Databases (Rows Read, Rows Written, Read/Write Queries, Storage Size)
    """
    now = datetime.now(timezone.utc)
    today_str = now.strftime("%Y-%m-%d")
    month_start_date = now.replace(day=1).strftime("%Y-%m-%d")
    month_start_iso = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")

    result = {
        "billing_period": {
            "month_start": month_start_date,
            "current_date_utc": today_str,
        },
        "workers_and_pages": {
            "daily_requests": 0,
            "daily_requests_limit": QUOTAS["workers_daily_requests_limit"],
            "daily_requests_pct": 0.0,
            "mtd_worker_requests": 0,
            "mtd_pages_requests": 0,
            "mtd_subrequests": 0,
            "mtd_errors": 0,
            "mtd_cpu_time_ms": 0.0,
            "mtd_assets_requests": 0,
            "mtd_build_minutes": 0.0,
            "monthly_build_minutes_limit": QUOTAS["workers_monthly_build_minutes_limit"],
            "monthly_build_minutes_pct": 0.0,
            "estimated_billable_usd": 0.0,
            "scripts": [],
            "assets_hosts": [],
        },
        "workers_ai": {
            "daily_neurons": 0.0,
            "daily_neurons_limit": QUOTAS["workers_ai_daily_neurons_limit"],
            "daily_neurons_pct": 0.0,
            "daily_requests": 0,
            "mtd_neurons": 0.0,
            "mtd_billable_neurons": 0.0,
            "mtd_requests": 0,
            "mtd_input_tokens": 0,
            "mtd_output_tokens": 0,
            "mtd_inference_time_ms": 0,
            "estimated_billable_usd": 0.0,
            "models": [],
        },
        "d1_billing": {
            "daily_rows_read": 0,
            "daily_rows_read_limit": QUOTAS["d1_daily_rows_read_limit"],
            "daily_rows_read_pct": 0.0,
            "daily_rows_written": 0,
            "daily_rows_written_limit": QUOTAS["d1_daily_rows_written_limit"],
            "daily_rows_written_pct": 0.0,
            "mtd_rows_read": 0,
            "mtd_rows_written": 0,
            "mtd_read_queries": 0,
            "mtd_write_queries": 0,
            "total_storage_mb": 0.0,
            "account_storage_limit_mb": QUOTAS["d1_account_storage_limit_mb"],
            "account_storage_pct": 0.0,
            "estimated_billable_usd": 0.0,
        },
        "d1_databases": [],
    }

    if not account_id or "YOUR_CF" in account_id:
        return result

    # 1. Fetch deployed Worker scripts & Pages projects via REST to include 0-traffic services
    known_scripts = {}
    try:
        st, body = http_request_json(f"{CF_API_BASE_URL}/accounts/{account_id}/workers/scripts", headers, timeout=10)
        if st == 200:
            for s in body.get("result") or []:
                sname = s.get("id")
                if sname:
                    known_scripts[sname] = {
                        "name": sname,
                        "type": "Worker",
                        "requests_today": 0,
                        "requests_mtd": 0,
                        "subrequests_mtd": 0,
                        "errors_mtd": 0,
                        "cpu_time_ms_mtd": 0.0,
                    }
    except Exception:
        pass

    try:
        st, body = http_request_json(f"{CF_API_BASE_URL}/accounts/{account_id}/pages/projects", headers, timeout=10)
        if st == 200:
            for p in body.get("result") or []:
                pname = p.get("name")
                if pname and pname not in known_scripts:
                    known_scripts[pname] = {
                        "name": pname,
                        "type": "Pages",
                        "requests_today": 0,
                        "requests_mtd": 0,
                        "subrequests_mtd": 0,
                        "errors_mtd": 0,
                        "cpu_time_ms_mtd": 0.0,
                    }
    except Exception:
        pass

    # 2. Query Cloudflare GraphQL Analytics API for MTD + Daily breakdown
    gql_query = """
    query GetAccountBillingUsage($accountId: String!, $sinceDate: Date!, $sinceIso: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountId }) {
          workersInvocationsAdaptive(limit: 5000, filter: { date_geq: $sinceDate }) {
            dimensions {
              scriptName
              date
            }
            sum {
              requests
              subrequests
              errors
              cpuTimeUs
            }
          }
          pagesFunctionsInvocationsAdaptiveGroups(limit: 5000, filter: { date_geq: $sinceDate }) {
            dimensions {
              scriptName
              date
            }
            sum {
              requests
              subrequests
              errors
            }
          }
          workersAssetsRequestsAdaptiveGroups(limit: 5000, filter: { datetime_geq: $sinceIso }) {
            dimensions {
              date
              hostname
            }
            sum {
              requests
            }
          }
          workersBuildsBuildMinutesAdaptiveGroups(limit: 1000, filter: { datetime_geq: $sinceIso }) {
            sum {
              buildMinutes
            }
          }
          aiInferenceAdaptiveGroups(limit: 5000, filter: { datetime_geq: $sinceIso }) {
            count
            dimensions {
              modelId
              date
            }
            sum {
              totalNeurons
              totalInputTokens
              totalOutputTokens
              totalInferenceTimeMs
            }
          }
          d1AnalyticsAdaptiveGroups(limit: 5000, filter: { date_geq: $sinceDate }) {
            dimensions {
              databaseId
              date
            }
            sum {
              readQueries
              writeQueries
              rowsRead
              rowsWritten
              queryBatchResponseBytes
            }
          }
        }
      }
    }
    """

    d1_stats_by_id = {}

    try:
        status_code, body = http_request_json(
            CF_GRAPHQL_URL,
            headers,
            method="POST",
            payload={
                "query": gql_query,
                "variables": {
                    "accountId": account_id,
                    "sinceDate": month_start_date,
                    "sinceIso": month_start_iso,
                },
            },
            timeout=15,
        )
        if status_code == 200:
            accounts = ((body.get("data") or {}).get("viewer") or {}).get("accounts") or []
            if accounts:
                acct = accounts[0]
                wp = result["workers_and_pages"]

                # --- A. Workers Invocations ---
                for row in acct.get("workersInvocationsAdaptive") or []:
                    dims = row.get("dimensions") or {}
                    sums = row.get("sum") or {}
                    sname = dims.get("scriptName") or "unknown"
                    r_date = dims.get("date") or ""
                    reqs = sums.get("requests", 0) or 0
                    subreqs = sums.get("subrequests", 0) or 0
                    errs = sums.get("errors", 0) or 0
                    cpu_us = sums.get("cpuTimeUs", 0) or 0

                    wp["mtd_worker_requests"] += reqs
                    wp["mtd_subrequests"] += subreqs
                    wp["mtd_errors"] += errs
                    wp["mtd_cpu_time_ms"] += cpu_us / 1000.0
                    if r_date == today_str:
                        wp["daily_requests"] += reqs

                    if sname not in known_scripts:
                        known_scripts[sname] = {
                            "name": sname,
                            "type": "Worker",
                            "requests_today": 0,
                            "requests_mtd": 0,
                            "subrequests_mtd": 0,
                            "errors_mtd": 0,
                            "cpu_time_ms_mtd": 0.0,
                        }
                    entry = known_scripts[sname]
                    entry["requests_mtd"] += reqs
                    entry["subrequests_mtd"] += subreqs
                    entry["errors_mtd"] += errs
                    entry["cpu_time_ms_mtd"] = round(entry["cpu_time_ms_mtd"] + (cpu_us / 1000.0), 2)
                    if r_date == today_str:
                        entry["requests_today"] += reqs

                # --- B. Pages Functions Invocations ---
                for row in acct.get("pagesFunctionsInvocationsAdaptiveGroups") or []:
                    dims = row.get("dimensions") or {}
                    sums = row.get("sum") or {}
                    sname = dims.get("scriptName") or "pages-function"
                    r_date = dims.get("date") or ""
                    reqs = sums.get("requests", 0) or 0
                    subreqs = sums.get("subrequests", 0) or 0
                    errs = sums.get("errors", 0) or 0

                    wp["mtd_pages_requests"] += reqs
                    wp["mtd_subrequests"] += subreqs
                    wp["mtd_errors"] += errs
                    if r_date == today_str:
                        wp["daily_requests"] += reqs

                    if sname not in known_scripts:
                        known_scripts[sname] = {
                            "name": sname,
                            "type": "Pages Function",
                            "requests_today": 0,
                            "requests_mtd": 0,
                            "subrequests_mtd": 0,
                            "errors_mtd": 0,
                            "cpu_time_ms_mtd": 0.0,
                        }
                    entry = known_scripts[sname]
                    entry["requests_mtd"] += reqs
                    entry["subrequests_mtd"] += subreqs
                    entry["errors_mtd"] += errs
                    if r_date == today_str:
                        entry["requests_today"] += reqs

                # --- C. Static Assets Requests ---
                assets_by_host = {}
                for row in acct.get("workersAssetsRequestsAdaptiveGroups") or []:
                    dims = row.get("dimensions") or {}
                    sums = row.get("sum") or {}
                    host = dims.get("hostname") or "unknown"
                    r_date = dims.get("date") or ""
                    reqs = sums.get("requests", 0) or 0
                    wp["mtd_assets_requests"] += reqs
                    if host not in assets_by_host:
                        assets_by_host[host] = {"hostname": host, "requests_today": 0, "requests_mtd": 0}
                    assets_by_host[host]["requests_mtd"] += reqs
                    if r_date == today_str:
                        assets_by_host[host]["requests_today"] += reqs

                wp["assets_hosts"] = sorted(
                    assets_by_host.values(), key=lambda x: x["requests_mtd"], reverse=True
                )

                # --- D. Workers Builds Minutes ---
                build_mins = 0.0
                for row in acct.get("workersBuildsBuildMinutesAdaptiveGroups") or []:
                    build_mins += (row.get("sum") or {}).get("buildMinutes", 0.0) or 0.0
                wp["mtd_build_minutes"] = round(build_mins, 2)
                wp["monthly_build_minutes_pct"] = round(
                    (build_mins / QUOTAS["workers_monthly_build_minutes_limit"]) * 100, 2
                )

                wp["mtd_cpu_time_ms"] = round(wp["mtd_cpu_time_ms"], 2)
                wp["daily_requests_pct"] = round(
                    (wp["daily_requests"] / QUOTAS["workers_daily_requests_limit"]) * 100, 2
                )
                wp["scripts"] = sorted(
                    known_scripts.values(), key=lambda x: (x["requests_mtd"], x["name"]), reverse=True
                )

                # --- E. Workers AI ---
                ai = result["workers_ai"]
                models_map = {}
                neurons_by_date = {}

                for row in acct.get("aiInferenceAdaptiveGroups") or []:
                    dims = row.get("dimensions") or {}
                    sums = row.get("sum") or {}
                    model_id = dims.get("modelId") or "unknown"
                    r_date = dims.get("date") or ""
                    cnt = row.get("count", 0) or 0
                    neurons = sums.get("totalNeurons", 0.0) or 0.0
                    in_tok = sums.get("totalInputTokens", 0) or 0
                    out_tok = sums.get("totalOutputTokens", 0) or 0
                    inf_ms = sums.get("totalInferenceTimeMs", 0) or 0

                    ai["mtd_requests"] += cnt
                    ai["mtd_neurons"] += neurons
                    ai["mtd_input_tokens"] += in_tok
                    ai["mtd_output_tokens"] += out_tok
                    ai["mtd_inference_time_ms"] += inf_ms
                    neurons_by_date[r_date] = neurons_by_date.get(r_date, 0.0) + neurons

                    if r_date == today_str:
                        ai["daily_neurons"] += neurons
                        ai["daily_requests"] += cnt

                    if model_id not in models_map:
                        models_map[model_id] = {
                            "model_id": model_id,
                            "requests_mtd": 0,
                            "requests_today": 0,
                            "neurons_mtd": 0.0,
                            "input_tokens_mtd": 0,
                            "output_tokens_mtd": 0,
                            "inference_time_ms_mtd": 0,
                        }
                    m_entry = models_map[model_id]
                    m_entry["requests_mtd"] += cnt
                    m_entry["neurons_mtd"] = round(m_entry["neurons_mtd"] + neurons, 2)
                    m_entry["input_tokens_mtd"] += in_tok
                    m_entry["output_tokens_mtd"] += out_tok
                    m_entry["inference_time_ms_mtd"] += inf_ms
                    if r_date == today_str:
                        m_entry["requests_today"] += cnt

                billable_neurons = sum(
                    max(0.0, day_total - QUOTAS["workers_ai_daily_neurons_limit"])
                    for day_total in neurons_by_date.values()
                )
                ai["daily_neurons"] = round(ai["daily_neurons"], 2)
                ai["daily_neurons_pct"] = round(
                    (ai["daily_neurons"] / QUOTAS["workers_ai_daily_neurons_limit"]) * 100, 2
                )
                ai["mtd_neurons"] = round(ai["mtd_neurons"], 2)
                ai["mtd_billable_neurons"] = round(billable_neurons, 2)
                ai["estimated_billable_usd"] = round(
                    (billable_neurons / 1000.0) * QUOTAS["workers_ai_cost_per_1k_neurons_usd"], 4
                )
                ai["models"] = sorted(models_map.values(), key=lambda x: x["neurons_mtd"], reverse=True)

                # --- F. D1 Analytics ---
                d1b = result["d1_billing"]
                for row in acct.get("d1AnalyticsAdaptiveGroups") or []:
                    dims = row.get("dimensions") or {}
                    sums = row.get("sum") or {}
                    db_id = dims.get("databaseId") or ""
                    r_date = dims.get("date") or ""
                    r_read = sums.get("rowsRead", 0) or 0
                    r_written = sums.get("rowsWritten", 0) or 0
                    q_read = sums.get("readQueries", 0) or 0
                    q_write = sums.get("writeQueries", 0) or 0

                    d1b["mtd_rows_read"] += r_read
                    d1b["mtd_rows_written"] += r_written
                    d1b["mtd_read_queries"] += q_read
                    d1b["mtd_write_queries"] += q_write

                    if r_date == today_str:
                        d1b["daily_rows_read"] += r_read
                        d1b["daily_rows_written"] += r_written

                    if db_id:
                        if db_id not in d1_stats_by_id:
                            d1_stats_by_id[db_id] = {
                                "rows_read_mtd": 0,
                                "rows_written_mtd": 0,
                                "rows_read_today": 0,
                                "rows_written_today": 0,
                                "read_queries_mtd": 0,
                                "write_queries_mtd": 0,
                            }
                        st_entry = d1_stats_by_id[db_id]
                        st_entry["rows_read_mtd"] += r_read
                        st_entry["rows_written_mtd"] += r_written
                        st_entry["read_queries_mtd"] += q_read
                        st_entry["write_queries_mtd"] += q_write
                        if r_date == today_str:
                            st_entry["rows_read_today"] += r_read
                            st_entry["rows_written_today"] += r_written

                d1b["daily_rows_read_pct"] = round(
                    (d1b["daily_rows_read"] / QUOTAS["d1_daily_rows_read_limit"]) * 100, 3
                )
                d1b["daily_rows_written_pct"] = round(
                    (d1b["daily_rows_written"] / QUOTAS["d1_daily_rows_written_limit"]) * 100, 2
                )
    except Exception as e:
        print(f"Error querying account GraphQL billing metrics: {e}", file=sys.stderr)

    # 3. Fetch D1 Database inventory & storage sizes from REST API
    d1_url = f"{CF_API_BASE_URL}/accounts/{account_id}/d1/database"
    try:
        status_code, body = http_request_json(d1_url, headers, timeout=10)
        if status_code == 200:
            databases = body.get("result") or []
            total_bytes = 0
            for db in databases:
                uuid = db.get("uuid", "")
                file_size = db.get("file_size", 0) or 0
                total_bytes += file_size
                size_mb = round(file_size / (1024 * 1024), 2)
                storage_pct = round((size_mb / QUOTAS["d1_per_db_storage_limit_mb"]) * 100, 1) if file_size else 0.0
                db_stats = d1_stats_by_id.get(uuid, {})
                result["d1_databases"].append({
                    "name": db.get("name", "Unknown"),
                    "uuid": uuid,
                    "file_size_mb": size_mb,
                    "capacity_pct": storage_pct,
                    "rows_read": db_stats.get("rows_read_mtd", 0),
                    "rows_written": db_stats.get("rows_written_mtd", 0),
                    "rows_read_today": db_stats.get("rows_read_today", 0),
                    "rows_written_today": db_stats.get("rows_written_today", 0),
                    "read_queries": db_stats.get("read_queries_mtd", 0),
                    "write_queries": db_stats.get("write_queries_mtd", 0),
                })
            total_mb = round(total_bytes / (1024 * 1024), 2)
            result["d1_billing"]["total_storage_mb"] = total_mb
            result["d1_billing"]["account_storage_pct"] = round(
                (total_mb / QUOTAS["d1_account_storage_limit_mb"]) * 100, 2
            )
    except Exception as e:
        print(f"Error fetching D1 databases: {e}", file=sys.stderr)

    return result


def write_json_atomic(path, payload):
    """Atomically writes payload JSON to path."""
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=4)
    os.replace(tmp_path, path)


def collect_once(headers):
    payload = {
        "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "local_system": {},
        "lan_network": {},
        "domains": {},
        "billing_period": {},
        "workers_and_pages": {},
        "workers_ai": {},
        "d1_billing": {},
        "d1_databases": [],
    }

    # Collect Raspberry Pi Local System Telemetry & LAN/Wi-Fi Discovery concurrently with Cloudflare APIs
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        fut_local = executor.submit(collect_local_and_lan_telemetry)
        fut_acct = executor.submit(fetch_account_billing_and_usage, CF_ACCOUNT_ID, headers)

        for default_name, zone_id in DOMAINS_TO_MONITOR.items():
            actual_name = resolve_zone_name(default_name, zone_id, headers)
            payload["domains"][actual_name] = fetch_zone_metrics(actual_name, zone_id, headers)

        try:
            local_and_lan = fut_local.result()
            payload["local_system"] = local_and_lan.get("local_system", {})
            payload["lan_network"] = local_and_lan.get("lan_network", {})
        except Exception as e:
            print(f"Error collecting local/LAN telemetry: {e}", file=sys.stderr)

        try:
            acct_usage = fut_acct.result()
            payload["billing_period"] = acct_usage["billing_period"]
            payload["workers_and_pages"] = acct_usage["workers_and_pages"]
            payload["workers_ai"] = acct_usage["workers_ai"]
            payload["d1_billing"] = acct_usage["d1_billing"]
            payload["d1_databases"] = acct_usage["d1_databases"]
        except Exception as e:
            print(f"Error collecting Cloudflare account usage: {e}", file=sys.stderr)

    # Flush state payload matrix safely to target output path(s)
    targets = {os.path.abspath(OUTPUT_PATH)}
    if os.path.abspath(SCRIPT_DIR) != "/usr/local/bin":
        targets.add(os.path.abspath(LOCAL_OUTPUT_PATH))
    if os.name != "nt" and os.path.isdir("/var/www/html"):
        targets.add("/var/www/html/metrics.json")
    for target in targets:
        try:
            write_json_atomic(target, payload)
        except Exception as e:
            print(f"Error saving file payload to {target}: {e}", file=sys.stderr)

    return payload


def main():
    headers = {
        "Authorization": f"Bearer {CF_API_TOKEN}",
        "Content-Type": "application/json",
    }

    if "--once" in sys.argv:
        collect_once(headers)
        return

    while True:
        collect_once(headers)
        time.sleep(30)


if __name__ == "__main__":
    main()
