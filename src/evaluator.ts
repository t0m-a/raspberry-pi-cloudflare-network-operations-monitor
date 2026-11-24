import {
  formatUtcTimestamp,
  hasTwoConsecutiveHoursAtOrAbove5xxThreshold,
} from "./collector.ts";
import {
  QUOTAS,
  THRESHOLDS,
  type ActiveAlertEntry,
  type AnomalyFinding,
  type CloudMetricsPayload,
  type Domain5xxStreakEntry,
  type Esp32TelemetryPayload,
  type NocPersistentState,
  type Rpi5TelemetryPayload,
  type SnoozedAnomaly,
  type ZoneMetrics,
} from "./types.ts";

export function normalizeSnoozeDuration(durInput: string): {
  seconds: number;
  label: string;
  code: "24h" | "72h" | "7d";
} {
  const clean = String(durInput || "24h").trim().toLowerCase();
  if (["24", "24h", "24hr", "24hrs", "24 hours", "24 hour", "1d", "1 day", "day", "daily"].includes(clean)) {
    return { seconds: 24 * 3600, label: "24 Hours", code: "24h" };
  }
  if (["72", "72h", "72hr", "72hrs", "72 hours", "72 hour", "3d", "3 days"].includes(clean)) {
    return { seconds: 72 * 3600, label: "72 Hours", code: "72h" };
  }
  if (
    ["7", "7d", "7day", "7days", "7 days", "7 day", "168h", "168 hours", "1w", "1 week", "week", "weekly"].includes(
      clean,
    )
  ) {
    return { seconds: 7 * 86400, label: "7 Days", code: "7d" };
  }
  throw new Error(
    `Invalid snooze duration '${durInput}'. Allowed durations: 24h (24 hours), 72h (72 hours), or 7d (7 days).`,
  );
}

export function formatDurationHuman(seconds: number): string {
  if (seconds <= 0) {
    return "expired";
  }
  const mins = seconds / 60.0;
  if (mins < 60) {
    return `${Math.floor(mins)}m`;
  }
  const hours = seconds / 3600.0;
  if (hours < 48) {
    return `${hours.toFixed(1)}h`;
  }
  const days = hours / 24.0;
  return `${days.toFixed(1)}d`;
}

export function parseMetricsTimestamp(tsStr: string): Date | null {
  if (!tsStr) {
    return null;
  }
  const clean = tsStr.replace("UTC", "").trim();
  const m = clean.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }
  const parsed = Date.parse(tsStr);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

/**
 * STRICT HTTP 5XX ALERTING POLICY:
 * Do NOT alert on HTTP 5xx errors unless they reach the threshold of >= 100 errors/hour
 * across a consecutive 2-hour time span (two adjacent 1-hour buckets each >= 100, OR
 * single-hour rate staying >= 100 continuously for >= 7,200 seconds).
 */
export function evaluateDomain5xxRule(
  dmetrics: ZoneMetrics,
  prevStreakEntry: Domain5xxStreakEntry | undefined,
  nowUtc: Date = new Date(),
): {
  shouldAlert: boolean;
  sustainedHours: number;
  nextStreakEntry: Domain5xxStreakEntry | null;
  latestHour5xx: number;
  prevHour5xx: number;
} {
  const nowTs = nowUtc.getTime() / 1000.0;
  const threshold = THRESHOLDS.domain_5xx_warn; // 100 errors/hour
  const err5xx = Number(dmetrics.errors_5xx || 0);
  const prevHr5xx = Number(dmetrics.errors_5xx_prev_hour || 0);
  const hourly = Array.isArray(dmetrics.errors_5xx_hourly) ? dmetrics.errors_5xx_hourly : [];

  const hourly2hReached =
    hourly.length >= 2
      ? hasTwoConsecutiveHoursAtOrAbove5xxThreshold(hourly, threshold)
      : false;
  const flag2hReached = Boolean(dmetrics.errors_5xx_2h_consecutive_over_100);
  const pair2hReached = err5xx >= threshold && prevHr5xx >= threshold;

  // Determine whether the current hourly rate itself is at or above threshold (100/hr)
  const currentAtThreshold = err5xx >= threshold;

  let nextStreakEntry: Domain5xxStreakEntry | null = null;
  let sustainedSec = 0.0;

  if (currentAtThreshold) {
    const firstTs = Number(prevStreakEntry?.first_exceeded_ts || nowTs);
    const firstUtc = prevStreakEntry?.first_exceeded_utc || formatUtcTimestamp(nowUtc);
    sustainedSec = Math.max(0.0, nowTs - firstTs);
    nextStreakEntry = {
      first_exceeded_ts: firstTs,
      first_exceeded_utc: firstUtc,
      last_seen_ts: nowTs,
      last_errors_5xx: err5xx,
      sustained_seconds: Math.floor(sustainedSec),
    };
  }

  let shouldAlert = false;
  if (hourly.length >= 2) {
    // When explicit hourly buckets exist, require 2 consecutive buckets >= 100/hr
    // OR continuous stateful streak >= 2h while current hour is still >= 100/hr.
    shouldAlert =
      hourly2hReached ||
      (flag2hReached && (pair2hReached || hourly2hReached)) ||
      (currentAtThreshold && sustainedSec >= THRESHOLDS.domain_5xx_sustained_seconds);
  } else {
    shouldAlert =
      flag2hReached ||
      pair2hReached ||
      (currentAtThreshold && sustainedSec >= THRESHOLDS.domain_5xx_sustained_seconds);
  }

  const sustainedHours = shouldAlert
    ? Math.max(THRESHOLDS.domain_5xx_sustained_hours, sustainedSec / 3600.0)
    : sustainedSec / 3600.0;

  return {
    shouldAlert,
    sustainedHours,
    nextStreakEntry,
    latestHour5xx: err5xx,
    prevHour5xx: prevHr5xx,
  };
}

function evaluateRpi5Telemetry(
  rpi5: Rpi5TelemetryPayload,
  nowUtc: Date,
  anomalies: AnomalyFinding[],
  briefLines: string[],
): void {
  const refTsStr = rpi5.received_at_utc || rpi5.reported_at_utc || "";
  const refDt = parseMetricsTimestamp(refTsStr);
  const ageSec = refDt ? Math.floor((nowUtc.getTime() - refDt.getTime()) / 1000) : 999_999;

  if (ageSec > THRESHOLDS.rpi5_stale_seconds) {
    anomalies.push({
      key: "rpi5:stale_report",
      severity: "CRITICAL",
      category: "Raspberry Pi 5",
      title: "Raspberry Pi 5 Cron Telemetry Stale",
      detail: `Last RPi5 cron push received ${Math.floor(ageSec / 60)}m ago (${refTsStr || "unknown"}) — expected every 15m`,
    });
  }

  const host = rpi5.host;
  const cpu = rpi5.cpu;
  const th = rpi5.thermals;
  const mem = rpi5.memory;
  const qd = rpi5.qdrant;
  const sync = rpi5.sync;
  const services = rpi5.services || [];
  const storage = rpi5.storage || [];

  // CPU & Load
  const cpuPct = Number(cpu?.usage_pct ?? 0);
  if (cpuPct >= THRESHOLDS.rpi5_cpu_crit_pct) {
    anomalies.push({
      key: "rpi5:cpu",
      severity: "CRITICAL",
      category: "Raspberry Pi 5",
      title: "Raspberry Pi 5 CPU Critical",
      detail: `CPU at ${cpuPct}% (${cpu?.freq_mhz ?? 0} MHz, load 1m: ${cpu?.load_1m ?? 0})`,
    });
  } else if (cpuPct >= THRESHOLDS.rpi5_cpu_warn_pct) {
    anomalies.push({
      key: "rpi5:cpu",
      severity: "WARNING",
      category: "Raspberry Pi 5",
      title: "Raspberry Pi 5 CPU Elevated",
      detail: `CPU at ${cpuPct}% (${cpu?.freq_mhz ?? 0} MHz, load 1m: ${cpu?.load_1m ?? 0})`,
    });
  }

  const loadPct = Number(cpu?.load_pct ?? 0);
  if (loadPct >= THRESHOLDS.rpi5_load_crit_pct) {
    anomalies.push({
      key: "rpi5:load",
      severity: "CRITICAL",
      category: "Raspberry Pi 5",
      title: "Raspberry Pi 5 Load Average Critical",
      detail: `Load ${cpu?.load_1m}/${cpu?.load_5m}/${cpu?.load_15m} (${loadPct}% of ${cpu?.cores ?? 4} cores)`,
    });
  } else if (loadPct >= THRESHOLDS.rpi5_load_warn_pct) {
    anomalies.push({
      key: "rpi5:load",
      severity: "WARNING",
      category: "Raspberry Pi 5",
      title: "Raspberry Pi 5 Load Average Elevated",
      detail: `Load ${cpu?.load_1m}/${cpu?.load_5m}/${cpu?.load_15m} (${loadPct}% of ${cpu?.cores ?? 4} cores)`,
    });
  }

  // Thermals & Power Throttling
  if (th?.soc_temp_c !== null && th?.soc_temp_c !== undefined) {
    const t = Number(th.soc_temp_c);
    if (t >= THRESHOLDS.rpi5_temp_crit_c) {
      anomalies.push({
        key: "rpi5:thermal",
        severity: "CRITICAL",
        category: "Raspberry Pi 5",
        title: "Raspberry Pi 5 SoC Overheating",
        detail: `SoC temperature ${t}°C (Fan: ${th.fan_rpm ?? "N/A"} RPM, Throttle: ${th.throttled_status})`,
      });
    } else if (t >= THRESHOLDS.rpi5_temp_warn_c) {
      anomalies.push({
        key: "rpi5:thermal",
        severity: "WARNING",
        category: "Raspberry Pi 5",
        title: "Raspberry Pi 5 SoC Temperature Elevated",
        detail: `SoC temperature ${t}°C (Fan: ${th.fan_rpm ?? "N/A"} RPM)`,
      });
    }
  }

  if (th?.throttled_now) {
    anomalies.push({
      key: "rpi5:throttled",
      severity: "CRITICAL",
      category: "Raspberry Pi 5",
      title: "Raspberry Pi 5 Active Power/Thermal Throttling",
      detail: `vcgencmd get_throttled=${th.throttled_hex} (${(th.throttled_flags || []).join(", ") || th.throttled_status})`,
    });
  }

  // Memory & Swap
  const ramPct = Number(mem?.ram_usage_pct ?? 0);
  if (ramPct >= THRESHOLDS.rpi5_ram_crit_pct) {
    anomalies.push({
      key: "rpi5:ram",
      severity: "CRITICAL",
      category: "Raspberry Pi 5",
      title: "Raspberry Pi 5 Memory Critical",
      detail: `RAM at ${ramPct}% (${mem?.ram_used_mb}/${mem?.ram_total_mb} MB, ${mem?.ram_available_mb} MB avail)`,
    });
  } else if (ramPct >= THRESHOLDS.rpi5_ram_warn_pct) {
    anomalies.push({
      key: "rpi5:ram",
      severity: "WARNING",
      category: "Raspberry Pi 5",
      title: "Raspberry Pi 5 Memory Elevated",
      detail: `RAM at ${ramPct}% (${mem?.ram_used_mb}/${mem?.ram_total_mb} MB, ${mem?.ram_available_mb} MB avail)`,
    });
  }

  const swapPct = Number(mem?.swap_usage_pct ?? 0);
  if ((mem?.swap_total_mb ?? 0) > 0 && swapPct >= THRESHOLDS.rpi5_swap_crit_pct) {
    anomalies.push({
      key: "rpi5:swap",
      severity: "CRITICAL",
      category: "Raspberry Pi 5",
      title: "Raspberry Pi 5 Swap Exhaustion",
      detail: `Swap at ${swapPct}% (${mem?.swap_used_mb}/${mem?.swap_total_mb} MB)`,
    });
  } else if ((mem?.swap_total_mb ?? 0) > 0 && swapPct >= THRESHOLDS.rpi5_swap_warn_pct) {
    anomalies.push({
      key: "rpi5:swap",
      severity: "WARNING",
      category: "Raspberry Pi 5",
      title: "Raspberry Pi 5 Swap Usage High",
      detail: `Swap at ${swapPct}% (${mem?.swap_used_mb}/${mem?.swap_total_mb} MB)`,
    });
  }

  // Storage Filesystems
  for (const fs of storage) {
    const pct = Number(fs.usage_pct ?? 0);
    const mp = fs.mountpoint || "/";
    if (pct >= THRESHOLDS.rpi5_disk_crit_pct) {
      anomalies.push({
        key: `rpi5:disk:${mp}`,
        severity: "CRITICAL",
        category: "Raspberry Pi 5",
        title: `RPi5 Disk '${mp}' Critical`,
        detail: `${pct}% full (${fs.used_gb}/${fs.total_gb} GB, ${fs.free_gb} GB free)`,
      });
    } else if (pct >= THRESHOLDS.rpi5_disk_warn_pct) {
      anomalies.push({
        key: `rpi5:disk:${mp}`,
        severity: "WARNING",
        category: "Raspberry Pi 5",
        title: `RPi5 Disk '${mp}' Elevated`,
        detail: `${pct}% full (${fs.used_gb}/${fs.total_gb} GB, ${fs.free_gb} GB free)`,
      });
    }
  }

  // Qdrant Vector DB
  if (qd) {
    if (!qd.reachable || !qd.healthz_ok) {
      anomalies.push({
        key: "rpi5:qdrant_down",
        severity: "CRITICAL",
        category: "RPi5 Qdrant",
        title: "Qdrant Vector Database Unreachable",
        detail: qd.error || `Container status: ${qd.container_status || "unknown"}, healthz_ok=${qd.healthz_ok}`,
      });
    } else if (qd.status && qd.status.toLowerCase() !== "green") {
      anomalies.push({
        key: "rpi5:qdrant_status",
        severity: qd.status.toLowerCase() === "red" ? "CRITICAL" : "WARNING",
        category: "RPi5 Qdrant",
        title: `Qdrant Collection '${qd.collection}' Status ${qd.status.toUpperCase()}`,
        detail: `Points: ${qd.points_count}, Optimizer: ${qd.optimizer_status}, Segments: ${qd.segments_count}`,
      });
    }
  }

  // Brain Sync Daemon (`gemini-brain-watcher`)
  if (sync) {
    if (sync.enabled && !sync.service_active) {
      anomalies.push({
        key: "rpi5:sync_service_down",
        severity: "CRITICAL",
        category: "RPi5 Brain Sync",
        title: "Gemini Brain Sync Daemon Down",
        detail: `gemini-brain-watcher is ${sync.service_substate || "inactive"} (synced chunks: ${sync.total_synced_chunks})`,
      });
    }
    if (sync.enabled && sync.brain_uplink_ok === false) {
      anomalies.push({
        key: "rpi5:sync_uplink_down",
        severity: "CRITICAL",
        category: "RPi5 Brain Sync",
        title: "Brain Edge Uplink Unreachable from RPi5",
        detail: `https://brain.tsimon.me/server-card returned HTTP ${sync.brain_uplink_http_code ?? "ERR"}`,
      });
    }
    if (sync.enabled && sync.last_qdrant_pass_utc) {
      const passDt = parseMetricsTimestamp(sync.last_qdrant_pass_utc);
      if (passDt) {
        const passAgeSec = Math.floor((nowUtc.getTime() - passDt.getTime()) / 1000);
        if (passAgeSec > THRESHOLDS.rpi5_sync_pass_stale_seconds) {
          anomalies.push({
            key: "rpi5:sync_stale",
            severity: "WARNING",
            category: "RPi5 Brain Sync",
            title: "RPi5 Qdrant Federation Pass Stale",
            detail: `Last Qdrant federation pass was ${Math.floor(passAgeSec / 60)}m ago (${sync.last_qdrant_pass_utc})`,
          });
        }
      }
    }
    if ((sync.recent_errors_count ?? 0) >= THRESHOLDS.rpi5_sync_errors_warn) {
      anomalies.push({
        key: "rpi5:sync_errors",
        severity: "WARNING",
        category: "RPi5 Brain Sync",
        title: "Gemini Brain Watcher Sync Errors",
        detail: `${sync.recent_errors_count} recent errors in journald${sync.recent_error_sample ? `: ${sync.recent_error_sample.slice(0, 120)}` : ""}`,
      });
    }
  }

  // Critical Services
  const downCritical: string[] = [];
  for (const svc of services) {
    if (svc.critical && !svc.active) {
      downCritical.push(svc.name);
      anomalies.push({
        key: `rpi5:svc:${svc.name}`,
        severity: "CRITICAL",
        category: "RPi5 Services",
        title: `Critical RPi5 Service Down: ${svc.display_name || svc.name}`,
        detail: `Type: ${svc.type} | State: ${svc.status}/${svc.substate}${svc.health_detail ? ` (${svc.health_detail})` : ""}`,
      });
    }
  }

  const rootFs = storage.find((s) => s.mountpoint === "/") || storage[0];
  briefLines.push(
    `[RASPBERRY PI 5 VITALS] Host: ${host?.hostname || "rpi"} (up ${host?.uptime_human || "--"}, reported ${refTsStr}, age ${Math.floor(ageSec / 60)}m) | ` +
      `CPU: ${cpuPct}% @ ${cpu?.freq_mhz ?? 0}MHz (load ${cpu?.load_1m}/${cpu?.load_5m}/${cpu?.load_15m}) | ` +
      `Thermals: SoC ${th?.soc_temp_c ?? "N/A"}°C, RP1 ${th?.rp1_temp_c ?? "N/A"}°C, Fan ${th?.fan_rpm ?? "N/A"}RPM, ${th?.core_volts ?? "N/A"}V, Throttle ${th?.throttled_status || "OK"} | ` +
      `RAM: ${ramPct}% (${mem?.ram_used_mb}/${mem?.ram_total_mb}MB), Swap: ${swapPct}% | ` +
      `Root FS: ${rootFs ? `${rootFs.usage_pct}% (${rootFs.used_gb}/${rootFs.total_gb}GB)` : "N/A"} | ` +
      `IP: ${rpi5.network?.primary_ip || "--"}, GW RTT: ${rpi5.network?.gateway_rtt_ms ?? "N/A"}ms`,
  );

  const prefixSummary = Object.entries(sync?.chunks_by_prefix || {})
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
  briefLines.push(
    `[RPI5 QDRANT & SYNC] Qdrant v${qd?.version || "?"}: ${qd?.reachable ? qd.status.toUpperCase() : "OFFLINE"} ` +
      `(collection=${qd?.collection || "knowledge_hub"}, points=${qd?.points_count ?? 0}, segments=${qd?.segments_count ?? 0}, disk=${qd?.disk_usage_mb ?? 0}MB, ${qd?.api_latency_ms ?? "?"}ms) | ` +
      `Sync Watcher: ${sync?.service_active ? "ACTIVE" : "DOWN"}, Total Chunks=${sync?.total_synced_chunks ?? 0} (${prefixSummary || "none"}), ` +
      `Last Qdrant Pass: ${sync?.last_qdrant_pass_utc || "N/A"} (scanned=${sync?.last_qdrant_scanned ?? 0}, new=${sync?.last_qdrant_newly_synced ?? 0}), ` +
      `Uplink: ${sync?.brain_uplink_ok ? "OK" : "FAIL"} (${sync?.brain_uplink_latency_ms ?? "?"}ms), Errors: ${sync?.recent_errors_count ?? 0}`,
  );

  const activeSvcCount = services.filter((s) => s.active).length;
  briefLines.push(
    `[RPI5 CRITICAL SERVICES] ${activeSvcCount}/${services.length} active` +
      (downCritical.length > 0 ? ` | CRITICAL DOWN: ${downCritical.join(", ")}` : " (All critical services running)"),
  );
}

function evaluateEsp32Telemetry(
  esp32: Esp32TelemetryPayload,
  nowUtc: Date,
  anomalies: AnomalyFinding[],
  briefLines: string[],
): void {
  const refStr = esp32.last_updated_utc || esp32.sources?.rpi5_probe_utc || esp32.sources?.direct_push_utc || "";
  const refDt = parseMetricsTimestamp(refStr);
  const ageSec = refDt ? Math.floor((nowUtc.getTime() - refDt.getTime()) / 1000) : 999_999;

  if (ageSec > THRESHOLDS.esp32_stale_seconds) {
    anomalies.push({
      key: "esp32:stale_telemetry",
      severity: "WARNING",
      category: "ESP-32S Watchdog",
      title: "ESP-32S Telemetry Stale",
      detail: `Last ESP-32S probe/heartbeat was ${Math.floor(ageSec / 60)}m ago (${refStr || "unknown"})`,
    });
  }

  const ping = esp32.ping;
  if (ping) {
    if (!ping.reachable) {
      anomalies.push({
        key: "esp32:unreachable",
        severity: "CRITICAL",
        category: "ESP-32S Watchdog",
        title: "ESP-32S Watchdog Unreachable (Ping Failed)",
        detail: `ICMP ping to ${ping.target_ip || "ESP-32S"} (${ping.mac || "unknown MAC"}) failed: ${ping.packet_loss_pct}% packet loss`,
      });
    } else {
      if (ping.packet_loss_pct >= THRESHOLDS.esp32_loss_crit_pct) {
        anomalies.push({
          key: "esp32:packet_loss",
          severity: "CRITICAL",
          category: "ESP-32S Watchdog",
          title: "ESP-32S Severe Packet Loss",
          detail: `${ping.packet_loss_pct}% packet loss (${ping.packets_received}/${ping.packets_sent}) to ${ping.target_ip}`,
        });
      } else if (ping.packet_loss_pct >= THRESHOLDS.esp32_loss_warn_pct) {
        anomalies.push({
          key: "esp32:packet_loss",
          severity: "WARNING",
          category: "ESP-32S Watchdog",
          title: "ESP-32S Elevated Packet Loss",
          detail: `${ping.packet_loss_pct}% packet loss (${ping.packets_received}/${ping.packets_sent}) to ${ping.target_ip}`,
        });
      }

      if (ping.rtt_avg_ms !== null && ping.rtt_avg_ms >= THRESHOLDS.esp32_rtt_crit_ms) {
        anomalies.push({
          key: "esp32:high_latency",
          severity: "CRITICAL",
          category: "ESP-32S Watchdog",
          title: "ESP-32S Ping Latency Critical",
          detail: `Avg RTT ${ping.rtt_avg_ms}ms (min ${ping.rtt_min_ms}ms / max ${ping.rtt_max_ms}ms / jitter ${ping.rtt_jitter_ms}ms)`,
        });
      } else if (ping.rtt_avg_ms !== null && ping.rtt_avg_ms >= THRESHOLDS.esp32_rtt_warn_ms) {
        anomalies.push({
          key: "esp32:high_latency",
          severity: "WARNING",
          category: "ESP-32S Watchdog",
          title: "ESP-32S Ping Latency Elevated",
          detail: `Avg RTT ${ping.rtt_avg_ms}ms (min ${ping.rtt_min_ms}ms / max ${ping.rtt_max_ms}ms / jitter ${ping.rtt_jitter_ms}ms)`,
        });
      }
    }
  }

  const dev = esp32.device;
  if (dev) {
    if (dev.wifi_rssi_dbm !== 0 && dev.wifi_rssi_dbm <= THRESHOLDS.esp32_rssi_warn_dbm) {
      anomalies.push({
        key: "esp32:weak_wifi",
        severity: "WARNING",
        category: "ESP-32S Watchdog",
        title: "ESP-32S Weak Wi-Fi Signal",
        detail: `Wi-Fi RSSI ${dev.wifi_rssi_dbm} dBm (${dev.wifi_signal_pct}%) on SSID '${dev.wifi_ssid}' ch ${dev.wifi_channel}`,
      });
    }
    if (dev.free_heap_kb > 0 && dev.free_heap_kb < THRESHOLDS.esp32_heap_warn_kb) {
      anomalies.push({
        key: "esp32:low_heap",
        severity: "WARNING",
        category: "ESP-32S Watchdog",
        title: "ESP-32S Low Free SRAM Heap",
        detail: `Free heap ${dev.free_heap_kb} KB / ${dev.total_heap_kb} KB (min ${dev.min_free_heap_kb} KB, frag ${dev.heap_frag_pct}%)`,
      });
    }
  }

  const oob = esp32.oob_watchdog;
  if (oob) {
    if (oob.cf_global_indicator && oob.cf_global_indicator !== "none" && oob.cf_global_indicator !== "unknown") {
      anomalies.push({
        key: "esp32:cf_global_incident",
        severity: oob.cf_global_indicator === "critical" || oob.cf_global_indicator === "major" ? "CRITICAL" : "WARNING",
        category: "ESP-32S Watchdog",
        title: `Cloudflare Global Incident (${oob.cf_global_indicator.toUpperCase()})`,
        detail: `${oob.cf_global_description}${oob.cf_global_incident ? ` — ${oob.cf_global_incident}` : ""}`,
      });
    }
    for (const ep of oob.endpoints || []) {
      if (ep.state === "DOWN") {
        anomalies.push({
          key: `esp32:oob_down:${ep.name}`,
          severity: "CRITICAL",
          category: "ESP-32S Watchdog",
          title: `OOB Watchdog Reports '${ep.name}' DOWN`,
          detail: `${ep.url} -> ${ep.last_error || `HTTP ${ep.http_code}`} (${ep.consecutive_fails} fails)`,
        });
      }
    }
  }

  const hist = esp32.history;
  const parts: string[] = [
    `[ESP-32S WATCHDOG] IP: ${ping?.target_ip || dev?.wifi_ip || "--"} (${ping?.mac || dev?.wifi_mac || "--"})`,
    ping
      ? `Ping: ${ping.reachable ? "ONLINE" : "OFFLINE"} (avg=${ping.rtt_avg_ms ?? "N/A"}ms, min=${ping.rtt_min_ms ?? "N/A"}ms, max=${ping.rtt_max_ms ?? "N/A"}ms, jitter=${ping.rtt_jitter_ms ?? "N/A"}ms, loss=${ping.packet_loss_pct}%)`
      : "Ping: Pending",
  ];
  if (hist) {
    parts.push(`24h Uptime: ${hist.uptime_pct_24h}% (${hist.samples_24h} samples, avg24h=${hist.avg_rtt_24h_ms ?? "N/A"}ms)`);
  }
  if (dev) {
    parts.push(
      `Device: up ${dev.uptime_human}, RSSI ${dev.wifi_rssi_dbm}dBm (${dev.wifi_ssid} ch${dev.wifi_channel}), heap ${dev.free_heap_kb}/${dev.total_heap_kb}KB, reset=${dev.reset_reason}`,
    );
  }
  if (oob) {
    const epStr = (oob.endpoints || []).map((e) => `${e.name}:${e.state}(${e.latency_ms}ms)`).join(", ");
    parts.push(`OOB CF Global: ${oob.cf_global_indicator} | Probes: [${epStr}]`);
  }
  briefLines.push(parts.join(" | "));
}

export interface EvaluationResult {
  rawAnomalies: AnomalyFinding[];
  activeAnomalies: AnomalyFinding[];
  snoozedAnomalies: SnoozedAnomaly[];
  stateUpdates: Partial<NocPersistentState>;
  compactBrief: string;
}

export function evaluateCloudTelemetry(
  metrics: CloudMetricsPayload,
  prevState: NocPersistentState,
  nowUtc: Date = new Date(),
): EvaluationResult {
  const nowTs = nowUtc.getTime() / 1000.0;
  const anomalies: AnomalyFinding[] = [];
  const briefLines: string[] = [];

  // 0. Check Metrics Freshness
  const lastUpdatedStr = metrics.last_updated || "";
  const lastDt = parseMetricsTimestamp(lastUpdatedStr);
  const ageSec = lastDt ? Math.floor((nowUtc.getTime() - lastDt.getTime()) / 1000) : 999_999;
  if (ageSec > THRESHOLDS.metrics_stale_seconds) {
    anomalies.push({
      key: "daemon:stale_metrics",
      severity: "CRITICAL",
      category: "Monitor Service",
      title: "Telemetry Stale",
      detail: `Cloudflare metrics snapshot last updated ${Math.floor(ageSec / 60)}m ago (${lastUpdatedStr})`,
    });
  }

  const bp = metrics.billing_period || { month_start: "--", current_date_utc: "--" };
  briefLines.push(
    `[NOC SYNC] ${lastUpdatedStr} | Billing Period (UTC): ${bp.month_start} -> ${bp.current_date_utc}`,
  );

  // 1. Cloudflare Edge Domains
  // STRICT RULE IN CODE: Do NOT alert on HTTP 5xx errors unless they reach >= 100/hour
  // across a 2-hour consecutive time span.
  const domains = metrics.domains || {};
  const prev5xxStreak: Record<string, Domain5xxStreakEntry> = { ...(prevState.domain_5xx_streak || {}) };
  const curr5xxStreak: Record<string, Domain5xxStreakEntry> = {};
  const domainSummaries: string[] = [];

  for (const [dname, dmetrics] of Object.entries(domains)) {
    const st = dmetrics.status || "UNKNOWN";
    const hits = Number(dmetrics.hit_volume || 0);
    const chrPct = Number(dmetrics.cache_hit_ratio || 0.0);
    const secEv = Number(dmetrics.security_events || 0);
    const bwGb = Number(dmetrics.bandwidth_gb || 0.0);

    const rule5xx = evaluateDomain5xxRule(dmetrics, prev5xxStreak[dname], nowUtc);
    if (rule5xx.nextStreakEntry) {
      curr5xxStreak[dname] = rule5xx.nextStreakEntry;
    }

    if (rule5xx.shouldAlert) {
      domainSummaries.push(
        `${dname}: ${st}, ${hits} reqs/1h, CHR ${chrPct}%, threats:${secEv}, ` +
          `5xx:${rule5xx.latestHour5xx}/hr (ALERT: >=${THRESHOLDS.domain_5xx_warn}/hr for ${rule5xx.sustainedHours.toFixed(1)}h span), bw:${bwGb}GB`,
      );
    } else {
      domainSummaries.push(
        `${dname}: ${st}, ${hits} reqs/1h, CHR ${chrPct}%, threats:${secEv}, 5xx:nominal, bw:${bwGb}GB`,
      );
    }

    if (st !== "HEALTHY") {
      anomalies.push({
        key: `cf_domain_status:${dname}`,
        severity: "CRITICAL",
        category: "Cloudflare Edge",
        title: `Domain ${dname} Unhealthy`,
        detail: `Status reported as '${st}'`,
      });
    }

    if (rule5xx.shouldAlert) {
      anomalies.push({
        key: `cf_domain_5xx:${dname}`,
        severity: "WARNING",
        category: "Cloudflare Edge",
        title: `Sustained Origin 5xx Errors on ${dname}`,
        detail: `${rule5xx.latestHour5xx} HTTP 5xx/hr (prev hr: ${rule5xx.prevHour5xx}) — reached >= ${THRESHOLDS.domain_5xx_warn}/hr over ${rule5xx.sustainedHours.toFixed(1)}h span (${hits} total requests)`,
      });
    }

    if (secEv >= THRESHOLDS.domain_threats_crit) {
      anomalies.push({
        key: `cf_domain_threats:${dname}`,
        severity: "CRITICAL",
        category: "Cloudflare Security",
        title: `Attack / Threat Spike on ${dname}`,
        detail: `${secEv} security threats blocked in past 1h`,
      });
    } else if (secEv >= THRESHOLDS.domain_threats_warn) {
      anomalies.push({
        key: `cf_domain_threats:${dname}`,
        severity: "WARNING",
        category: "Cloudflare Security",
        title: `Elevated Security Events on ${dname}`,
        detail: `${secEv} security threats blocked in past 1h`,
      });
    }
  }

  if (domainSummaries.length > 0) {
    briefLines.push(`[CLOUDFLARE DOMAINS (1h)] ${domainSummaries.join(" || ")}`);
  }

  // 2. Cloudflare Workers, Pages, Workers AI, D1, Durable Objects, KV & R2 Quotas
  const wp = metrics.workers_and_pages;
  const ai = metrics.workers_ai;
  const d1b = metrics.d1_billing;
  const d1Dbs = metrics.d1_databases || [];
  const doUsage = metrics.durable_objects;
  const kvb = metrics.kv_billing;
  const r2b = metrics.r2_billing;

  const wpDailyPct = Number(wp?.daily_requests_pct || 0.0);
  const wpBuildPct = Number(wp?.monthly_build_minutes_pct || 0.0);
  const aiDailyPct = Number(ai?.daily_neurons_pct || 0.0);

  // D1 & Durable Objects SQL Rows Read Quota -> 50 Billion / month
  const d1ReadPct =
    d1b?.monthly_rows_read_pct !== undefined
      ? Number(d1b.monthly_rows_read_pct)
      : Math.round(((Number(d1b?.mtd_rows_read || 0) / QUOTAS.d1_monthly_rows_read_limit) * 100) * 10000) / 10000;
  const d1WritePct = Number(d1b?.daily_rows_written_pct || 0.0);
  const d1StoPct = Number(d1b?.account_storage_pct || 0.0);

  const doReqPct = Number(doUsage?.daily_requests_pct || 0.0);
  const doDurPct = Number(doUsage?.daily_duration_gbs_pct || 0.0);
  const doReadPct =
    doUsage?.monthly_rows_read_pct !== undefined
      ? Number(doUsage.monthly_rows_read_pct)
      : Math.round(((Number(doUsage?.mtd_rows_read || 0) / QUOTAS.do_monthly_rows_read_limit) * 100) * 10000) / 10000;
  const doWritePct = Number(doUsage?.daily_rows_written_pct || 0.0);
  const doStoPct = Number(doUsage?.storage_pct || 0.0);

  const kvReadPct = Number(kvb?.daily_reads_pct || 0.0);
  const kvWritePct = Number(kvb?.daily_writes_pct || 0.0);
  const kvDelPct = Number(kvb?.daily_deletes_pct || 0.0);
  const kvListPct = Number(kvb?.daily_lists_pct || 0.0);
  const kvStoPct = Number(kvb?.storage_pct || 0.0);

  const r2ClassAPct = Number(r2b?.monthly_class_a_pct || 0.0);
  const r2ClassBPct = Number(r2b?.monthly_class_b_pct || 0.0);
  const r2StoPct = Number(r2b?.storage_pct || 0.0);

  const totalEstUsd =
    Number(wp?.estimated_billable_usd || 0.0) +
    Number(ai?.estimated_billable_usd || 0.0) +
    Number(d1b?.estimated_billable_usd || 0.0) +
    Number(doUsage?.estimated_billable_usd || 0.0) +
    Number(kvb?.estimated_billable_usd || 0.0) +
    Number(r2b?.estimated_billable_usd || 0.0);

  const scriptSummaries = (wp?.scripts || []).map(
    (s) => `${s.name}(today:${s.requests_today}, mtd:${s.requests_mtd}, err:${s.errors_mtd})`,
  );
  const dbSummaries = d1Dbs.map((d) => `${d.name}(${d.file_size_mb}MB/${d.capacity_pct}%)`);
  const doSummaries = (doUsage?.namespaces || []).map(
    (ns) => `${ns.name}(today:${ns.requests_today}, mtd:${ns.requests_mtd}, storage:${ns.storage_mb}MB, err:${ns.errors_mtd})`,
  );
  const kvSummaries = (kvb?.namespaces || []).map(
    (ns) => `${ns.title}(R:${ns.reads_mtd}, W:${ns.writes_mtd}, ${ns.storage_mb}MB)`,
  );
  const r2Summaries = (r2b?.buckets || []).map(
    (b) => `${b.name}(${b.payload_size_mb}MB, objs:${b.object_count}, A:${b.class_a_ops_mtd}, B:${b.class_b_ops_mtd})`,
  );

  briefLines.push(
    `[CLOUDFLARE QUOTAS] Workers Daily: ${wp?.daily_requests ?? 0} (${wpDailyPct}%), ` +
      `MTD Reqs: ${wp?.mtd_worker_requests ?? 0}, MTD Errors: ${wp?.mtd_errors ?? 0}, ` +
      `Builds: ${wp?.mtd_build_minutes ?? 0}m (${wpBuildPct}%) ` +
      `[${scriptSummaries.join(", ")}] | ` +
      `Workers AI Today: ${ai?.daily_neurons ?? 0} neurons (${aiDailyPct}%), MTD: ${ai?.mtd_neurons ?? 0} | ` +
      `D1 Read MTD: ${(d1b?.mtd_rows_read ?? 0).toLocaleString()} (${d1ReadPct}% of 50B/mo), Write Today: ${d1WritePct}%, Storage: ${d1b?.total_storage_mb ?? 0}MB (${d1StoPct}%) ` +
      `[${dbSummaries.join(", ")}] | ` +
      `Durable Objects Today: ${doUsage?.daily_requests ?? 0} reqs (${doReqPct}%), ` +
      `Duration: ${doUsage?.daily_duration_gbs ?? 0} GB-s (${doDurPct}%), ` +
      `SQL Read MTD: ${(doUsage?.mtd_rows_read ?? 0).toLocaleString()} (${doReadPct}% of 50B/mo), SQL Write Today: ${doWritePct}%, Storage: ${doUsage?.total_storage_mb ?? 0}MB (${doStoPct}%) ` +
      `[${doSummaries.join(", ")}] | ` +
      `KV Today R/W/D/L: ${kvReadPct}%/${kvWritePct}%/${kvDelPct}%/${kvListPct}%, ` +
      `Storage: ${kvb?.total_storage_mb ?? 0}MB (${kvStoPct}%), Keys: ${kvb?.total_keys ?? 0} ` +
      `[${kvSummaries.join(", ")}] | ` +
      `R2 MTD Class A: ${r2b?.mtd_class_a_ops ?? 0} (${r2ClassAPct}%), ` +
      `Class B: ${r2b?.mtd_class_b_ops ?? 0} (${r2ClassBPct}%), ` +
      `Storage: ${r2b?.total_storage_mb ?? 0}MB (${r2StoPct}%) ` +
      `[${r2Summaries.join(", ")}] | Est Billable: $${totalEstUsd.toFixed(2)}`,
  );

  const quotaChecks: Array<[string, string, number, string]> = [
    ["quota:workers_daily", "Workers Daily Requests Quota", wpDailyPct, "100,000 / day"],
    ["quota:workers_builds_monthly", "Workers Monthly Build Minutes Quota", wpBuildPct, "3,000 min / month"],
    ["quota:workers_ai_daily", "Workers AI Daily Neurons Quota", aiDailyPct, "10,000 Neurons / day"],
    ["quota:d1_reads_monthly", "D1 Monthly Rows Read Quota", d1ReadPct, "50,000,000,000 rows / month"],
    ["quota:d1_writes_daily", "D1 Daily Rows Written Quota", d1WritePct, "100,000 rows / day"],
    ["quota:d1_storage", "D1 Account Storage Quota", d1StoPct, "5,000 MB (5 GB)"],
    ["quota:do_requests_daily", "Durable Objects Daily Requests Quota", doReqPct, "100,000 / day"],
    ["quota:do_duration_daily", "Durable Objects Daily Duration Quota", doDurPct, "13,000 GB-s / day"],
    ["quota:do_reads_monthly", "Durable Objects SQL Monthly Rows Read Quota", doReadPct, "50,000,000,000 rows / month"],
    ["quota:do_writes_daily", "Durable Objects SQL Daily Rows Written Quota", doWritePct, "100,000 rows / day"],
    ["quota:do_storage", "Durable Objects Account Storage Quota", doStoPct, "5,000 MB (5 GB)"],
    ["quota:kv_reads_daily", "Workers KV Daily Reads Quota", kvReadPct, "100,000 / day"],
    ["quota:kv_writes_daily", "Workers KV Daily Writes Quota", kvWritePct, "1,000 / day"],
    ["quota:kv_deletes_daily", "Workers KV Daily Deletes Quota", kvDelPct, "1,000 / day"],
    ["quota:kv_lists_daily", "Workers KV Daily Lists Quota", kvListPct, "1,000 / day"],
    ["quota:kv_storage", "Workers KV Account Storage Quota", kvStoPct, "1,024 MB (1 GB)"],
    ["quota:r2_class_a_monthly", "R2 Monthly Class A Operations Quota", r2ClassAPct, "1,000,000 / month"],
    ["quota:r2_class_b_monthly", "R2 Monthly Class B Operations Quota", r2ClassBPct, "10,000,000 / month"],
    ["quota:r2_storage", "R2 Monthly Object Storage Quota", r2StoPct, "10,000 MB (10 GB)"],
  ];

  for (const [qKey, qLabel, qPct, qLimitDesc] of quotaChecks) {
    if (qPct >= THRESHOLDS.quota_crit_pct) {
      anomalies.push({
        key: qKey,
        severity: "CRITICAL",
        category: "Cloudflare Quota",
        title: `${qLabel} Critical`,
        detail: `Usage at ${qPct}% of ${qLimitDesc} limit`,
      });
    } else if (qPct >= THRESHOLDS.quota_warn_pct) {
      anomalies.push({
        key: qKey,
        severity: "WARNING",
        category: "Cloudflare Quota",
        title: `${qLabel} Warning`,
        detail: `Usage at ${qPct}% of ${qLimitDesc} limit`,
      });
    }
  }

  // Track per-script MTD errors delta so old MTD errors do not alert repeatedly
  const prevScriptErrors: Record<string, number> = { ...(prevState.script_errors_mtd || {}) };
  const currScriptErrors: Record<string, number> = {};
  for (const s of wp?.scripts || []) {
    const sname = s.name || "unknown";
    const serrs = Number(s.errors_mtd || 0);
    currScriptErrors[sname] = serrs;
    if (sname in prevScriptErrors && serrs > prevScriptErrors[sname]) {
      const delta = serrs - prevScriptErrors[sname];
      anomalies.push({
        key: `worker_err:${sname}`,
        severity: "WARNING",
        category: "Cloudflare Workers",
        title: `New Worker Script Errors (${sname})`,
        detail: `+${delta} new invocation error(s) on Worker '${sname}' (MTD total: ${serrs})`,
      });
    }
  }

  // Track per-Durable-Object namespace MTD errors delta
  const prevDoErrors: Record<string, number> = { ...(prevState.do_errors_mtd || {}) };
  const currDoErrors: Record<string, number> = {};
  for (const ns of doUsage?.namespaces || []) {
    const nsKey = ns.name || ns.namespace_id || "unknown";
    const nsErrs = Number(ns.errors_mtd || 0);
    currDoErrors[nsKey] = nsErrs;
    if (nsKey in prevDoErrors && nsErrs > prevDoErrors[nsKey]) {
      const delta = nsErrs - prevDoErrors[nsKey];
      anomalies.push({
        key: `do_err:${nsKey}`,
        severity: "WARNING",
        category: "Durable Objects",
        title: `New Durable Object Errors (${nsKey})`,
        detail: `+${delta} new invocation error(s) on Durable Object '${nsKey}' (MTD total: ${nsErrs})`,
      });
    }
  }

  for (const db of d1Dbs) {
    const dbName = db.name || "unknown";
    const capPct = Number(db.capacity_pct || 0.0);
    if (capPct >= THRESHOLDS.quota_crit_pct) {
      anomalies.push({
        key: `d1_db_cap:${dbName}`,
        severity: "CRITICAL",
        category: "D1 Database",
        title: `D1 Database '${dbName}' Near Capacity`,
        detail: `${db.file_size_mb} MB used (${capPct}% of 500 MB limit)`,
      });
    } else if (capPct >= THRESHOLDS.quota_warn_pct) {
      anomalies.push({
        key: `d1_db_cap:${dbName}`,
        severity: "WARNING",
        category: "D1 Database",
        title: `D1 Database '${dbName}' Elevated Storage`,
        detail: `${db.file_size_mb} MB used (${capPct}% of 500 MB limit)`,
      });
    }
  }

  // 3. Raspberry Pi 5 Edge Host, Qdrant, Sync & Services Evaluation
  if (metrics.rpi5) {
    evaluateRpi5Telemetry(metrics.rpi5, nowUtc, anomalies, briefLines);
  } else {
    briefLines.push("[RASPBERRY PI 5 VITALS] Awaiting initial 15-minute cron report from Raspberry Pi 5 agent.");
  }

  // 4. ESP-32S Out-of-Band Watchdog Evaluation
  if (metrics.esp32) {
    evaluateEsp32Telemetry(metrics.esp32, nowUtc, anomalies, briefLines);
  } else {
    briefLines.push("[ESP-32S WATCHDOG] Awaiting initial LAN ping probe / heartbeat telemetry.");
  }

  // 5. Process Snoozed / Operator-Acknowledged Findings
  const snoozedStore: Record<string, SnoozedAnomaly> = { ...(prevState.snoozed_anomalies || {}) };
  const validSnoozes: Record<string, SnoozedAnomaly> = {};
  const activeSnoozedList: SnoozedAnomaly[] = [];
  const rawAnomalyKeys = new Set(anomalies.map((a) => a.key));

  for (const [k, sEntry] of Object.entries(snoozedStore)) {
    if (k.startsWith("cf_domain_5xx:") && !rawAnomalyKeys.has(k)) {
      continue;
    }
    const untilTs = Number(sEntry.snoozed_until_ts || 0.0);
    if (untilTs > nowTs) {
      const remSec = untilTs - nowTs;
      const sCopy: SnoozedAnomaly = {
        ...sEntry,
        remaining_seconds: Math.floor(remSec),
        remaining_human: formatDurationHuman(remSec),
      };
      validSnoozes[k] = sCopy;
      activeSnoozedList.push(sCopy);
    }
  }

  const activeAnomalies: AnomalyFinding[] = [];
  for (const a of anomalies) {
    const k = a.key;
    if (validSnoozes[k]) {
      validSnoozes[k].title = a.title;
      validSnoozes[k].severity = a.severity;
      validSnoozes[k].category = a.category;
      validSnoozes[k].detail = a.detail;
    } else {
      activeAnomalies.push(a);
    }
  }

  if (activeAnomalies.length > 0) {
    briefLines.push("\n[DETECTED ACTIVE ANOMALIES]");
    for (const a of activeAnomalies) {
      briefLines.push(`- [${a.severity}] ${a.category} — ${a.title}: ${a.detail}`);
    }
  } else {
    briefLines.push("\n[DETECTED ACTIVE ANOMALIES] None — All monitored Cloudflare, Raspberry Pi 5, and ESP-32S systems nominal and HEALTHY.");
  }

  if (activeSnoozedList.length > 0) {
    briefLines.push("\n[SNOOZED / OPERATOR-ACKNOWLEDGED FINDINGS (Alerts Muted)]");
    for (const s of activeSnoozedList) {
      briefLines.push(
        `- [SNOOZED ${s.duration_str || "24h"} • ${s.remaining_human || ""} remaining (until ${s.snoozed_until_utc || ""})] ` +
          `${s.title || s.key}: ${s.detail || ""}`,
      );
    }
    briefLines.push(
      "Note: Operator has already acknowledged snoozed findings. Do not raise alarms or advise actions for them.",
    );
  }

  const stateUpdates: Partial<NocPersistentState> = {
    script_errors_mtd: currScriptErrors,
    do_errors_mtd: currDoErrors,
    domain_5xx_streak: curr5xxStreak,
    snoozed_anomalies: validSnoozes,
  };

  return {
    rawAnomalies: anomalies,
    activeAnomalies,
    snoozedAnomalies: activeSnoozedList,
    stateUpdates,
    compactBrief: briefLines.join("\n"),
  };
}

export function determineEvaluationTrigger(
  activeAnomalies: AnomalyFinding[],
  prevState: NocPersistentState,
  nowTs: number,
  options: { forceAi?: boolean; reasonOverride?: string } = {},
): {
  shouldRunAi: boolean;
  reasonCode: string;
  nextActiveAlerts: Record<string, ActiveAlertEntry>;
  hasNewAnomaly: boolean;
  hasEscalation: boolean;
  trulyResolvedKeys: string[];
} {
  const prevActive: Record<string, ActiveAlertEntry> = { ...(prevState.active_alerts || {}) };
  const nextActiveAlerts: Record<string, ActiveAlertEntry> = {};

  let hasNewAnomaly = false;
  let hasEscalation = false;

  for (const a of activeAnomalies) {
    const prevEntry = prevActive[a.key];
    if (!prevEntry) {
      hasNewAnomaly = true;
    } else if (prevEntry.severity !== "CRITICAL" && a.severity === "CRITICAL") {
      hasEscalation = true;
    }
    nextActiveAlerts[a.key] = {
      severity: a.severity,
      title: a.title,
      detail: a.detail,
      first_seen_ts: prevEntry?.first_seen_ts ?? nowTs,
      last_updated_ts: nowTs,
    };
  }

  const snoozedKeys = new Set(Object.keys(prevState.snoozed_anomalies || {}));
  const trulyResolved = Object.keys(prevActive).filter(
    (k) => !(k in nextActiveAlerts) && !snoozedKeys.has(k),
  );

  const lastLlmTs = Number(prevState.last_llm_ts || 0.0);
  const refreshDue = nowTs - lastLlmTs >= THRESHOLDS.ai_refresh_interval_seconds;
  const noPriorAnalysis = !prevState.last_ai_analysis;

  if (options.forceAi) {
    return {
      shouldRunAi: true,
      reasonCode: options.reasonOverride || "MANUAL_ANALYSIS",
      nextActiveAlerts,
      hasNewAnomaly,
      hasEscalation,
      trulyResolvedKeys: trulyResolved,
    };
  }
  if (hasEscalation) {
    return {
      shouldRunAi: true,
      reasonCode: "ESCALATED_CRITICAL",
      nextActiveAlerts,
      hasNewAnomaly,
      hasEscalation,
      trulyResolvedKeys: trulyResolved,
    };
  }
  if (hasNewAnomaly) {
    return {
      shouldRunAi: true,
      reasonCode: "ANOMALY_DETECTED",
      nextActiveAlerts,
      hasNewAnomaly,
      hasEscalation,
      trulyResolvedKeys: trulyResolved,
    };
  }
  if (activeAnomalies.length === 0 && trulyResolved.length > 0) {
    return {
      shouldRunAi: true,
      reasonCode: "ALL_CLEAR_RESOLVED",
      nextActiveAlerts,
      hasNewAnomaly,
      hasEscalation,
      trulyResolvedKeys: trulyResolved,
    };
  }
  if (noPriorAnalysis || refreshDue) {
    return {
      shouldRunAi: true,
      reasonCode: "SCHEDULED_REFRESH",
      nextActiveAlerts,
      hasNewAnomaly,
      hasEscalation,
      trulyResolvedKeys: trulyResolved,
    };
  }
  return {
    shouldRunAi: false,
    reasonCode: "NO_CHANGE_COOLDOWN",
    nextActiveAlerts,
    hasNewAnomaly,
    hasEscalation,
    trulyResolvedKeys: trulyResolved,
  };
}

export function decideTelegramAlertAction(
  activeAnomalies: AnomalyFinding[],
  prevState: NocPersistentState,
  nowTs: number,
  cooldownSec: number = THRESHOLDS.telegram_alert_cooldown_seconds,
): { shouldAlert: boolean; reasonCode: string } {
  const prevActive = prevState.active_alerts || {};
  const snoozedKeys = new Set(Object.keys(prevState.snoozed_anomalies || {}));
  const lastAlertTs = Number(prevState.telegram?.last_alert_ts || 0);

  let hasNew = false;
  let hasEscalation = false;
  const activeKeys = new Set<string>();

  for (const a of activeAnomalies) {
    activeKeys.add(a.key);
    const prev = prevActive[a.key];
    if (!prev) {
      hasNew = true;
    } else if (prev.severity !== "CRITICAL" && a.severity === "CRITICAL") {
      hasEscalation = true;
    }
  }

  const trulyResolved = Object.keys(prevActive).filter(
    (k) => !activeKeys.has(k) && !snoozedKeys.has(k),
  );

  if (hasEscalation) {
    return { shouldAlert: true, reasonCode: "ESCALATED_CRITICAL" };
  }
  if (hasNew) {
    return { shouldAlert: true, reasonCode: "ANOMALY_DETECTED" };
  }
  if (activeAnomalies.length === 0 && trulyResolved.length > 0) {
    return { shouldAlert: true, reasonCode: "ALL_CLEAR_RESOLVED" };
  }
  if (activeAnomalies.length > 0 && nowTs - lastAlertTs >= Math.max(300, cooldownSec)) {
    return { shouldAlert: true, reasonCode: "COOLDOWN_REMINDER" };
  }
  return { shouldAlert: false, reasonCode: "NONE" };
}
