#!/usr/bin/env python3
import os
import re
import sys
import json
import time
import urllib.request
import urllib.error
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
    "/var/www/html/dashboard/metrics.json" if os.name != "nt" else os.path.join(SCRIPT_DIR, "metrics.json"),
)
LOCAL_OUTPUT_PATH = os.path.join(SCRIPT_DIR, "metrics.json")

CF_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql"
CF_API_BASE_URL = "https://api.cloudflare.com/client/v4"

# DEFINE YOUR DOMAINS AND ZONE IDs HERE
DOMAINS_TO_MONITOR = {
    "example.com": os.getenv("CF_ZONE_ID_1", "FIRST_ZONE_ID_HERE"),
    "example.net": os.getenv("CF_ZONE_ID_2", "SECOND_ZONE_ID_HERE"),
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
        "domains": {},
        "billing_period": {},
        "workers_and_pages": {},
        "workers_ai": {},
        "d1_billing": {},
        "d1_databases": [],
    }

    # 1. Fetch metrics independently for each domain
    for default_name, zone_id in DOMAINS_TO_MONITOR.items():
        actual_name = resolve_zone_name(default_name, zone_id, headers)
        payload["domains"][actual_name] = fetch_zone_metrics(actual_name, zone_id, headers)

    # 2. Fetch Account-wide Billing & Usage (Workers & Pages, Workers AI, D1 Databases)
    acct_usage = fetch_account_billing_and_usage(CF_ACCOUNT_ID, headers)
    payload["billing_period"] = acct_usage["billing_period"]
    payload["workers_and_pages"] = acct_usage["workers_and_pages"]
    payload["workers_ai"] = acct_usage["workers_ai"]
    payload["d1_billing"] = acct_usage["d1_billing"]
    payload["d1_databases"] = acct_usage["d1_databases"]

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
