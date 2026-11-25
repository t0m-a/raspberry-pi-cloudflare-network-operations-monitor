import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAutomatedNocAnalysis } from "../src/ai-analyst.ts";
import {
  classifyR2ActionType,
  fetchAccountBillingAndUsage,
  formatUtcTimestamp,
  hasTwoConsecutiveHoursAtOrAbove5xxThreshold,
} from "../src/collector.ts";
import {
  decideTelegramAlertAction,
  determineEvaluationTrigger,
  evaluateCloudTelemetry,
  evaluateDomain5xxRule,
  normalizeSnoozeDuration,
} from "../src/evaluator.ts";
import worker from "../src/index.ts";
import { NocMonitorDO, updateEsp32History } from "../src/noc-do.ts";
import {
  parseTelegramCommand,
  shortKeyHash,
  splitTelegramMessage,
} from "../src/telegram.ts";
import {
  QUOTAS,
  type CloudMetricsPayload,
  type Env,
  type Esp32TelemetryPayload,
  type NocPersistentState,
  type Rpi5TelemetryPayload,
} from "../src/types.ts";

function buildMockRpi5(nowUtc: Date = new Date()): Rpi5TelemetryPayload {
  const ts = formatUtcTimestamp(nowUtc);
  return {
    reported_at_utc: ts,
    received_at_utc: ts,
    agent_version: "1.0.0",
    cron_interval_sec: 900,
    host: {
      hostname: "rpi",
      os_pretty: "Debian GNU/Linux 13 (trixie)",
      kernel: "6.18.62+rpt-rpi-v8",
      arch: "aarch64",
      model: "Raspberry Pi 5 Model B Rev 1.0",
      uptime_seconds: 158000,
      uptime_human: "1d 19h 53m",
      boot_time_utc: "2026-11-18 22:26:00 UTC",
      processes_total: 240,
      processes_running: 2,
    },
    cpu: {
      model: "ARM Cortex-A76 (BCM2712)",
      cores: 4,
      usage_pct: 12.4,
      per_core_pct: [10.0, 14.2, 11.8, 13.6],
      freq_mhz: 1600,
      max_freq_mhz: 2400,
      governor: "ondemand",
      load_1m: 0.24,
      load_5m: 0.18,
      load_15m: 0.12,
      load_pct: 6.0,
    },
    thermals: {
      soc_temp_c: 51.2,
      rp1_temp_c: 44.5,
      fan_rpm: 1370,
      fan_pwm: 75,
      core_volts: 0.77,
      throttled_hex: "0x0",
      throttled_status: "OK (0x0)",
      throttled_now: false,
      throttled_flags: [],
    },
    memory: {
      ram_total_mb: 3995,
      ram_used_mb: 2400,
      ram_available_mb: 1595,
      ram_cached_mb: 980,
      ram_free_mb: 220,
      ram_usage_pct: 60.1,
      swap_total_mb: 2047,
      swap_used_mb: 400,
      swap_free_mb: 1647,
      swap_usage_pct: 19.5,
    },
    storage: [
      {
        device: "/dev/mmcblk0p2",
        mountpoint: "/",
        fstype: "ext4",
        total_gb: 117.0,
        used_gb: 48.0,
        free_gb: 65.0,
        usage_pct: 43.0,
        inode_usage_pct: 6.2,
      },
    ],
    network: {
      primary_ip: "192.168.1.95",
      gateway_ip: "192.168.1.1",
      gateway_rtt_ms: 1.4,
      interfaces: [
        {
          name: "eth0",
          operstate: "up",
          ipv4: ["192.168.1.95"],
          ipv6: [],
          mac: "2c:cf:67:39:11:ee",
          speed_mbps: 1000,
          rx_mb: 420.5,
          tx_mb: 195.2,
          rx_errors: 0,
          tx_errors: 0,
          rx_drops: 0,
          tx_drops: 0,
        },
      ],
    },
    qdrant: {
      reachable: true,
      healthz_ok: true,
      status: "green",
      version: "1.20.2",
      collection: "knowledge_hub",
      collections_count: 1,
      points_count: 2690,
      indexed_vectors_count: 0,
      segments_count: 2,
      optimizer_status: "ok",
      vector_size: 384,
      distance: "Cosine",
      disk_usage_mb: 23.0,
      api_latency_ms: 4.2,
      container_status: "running",
      container_uptime: "Up 41 hours",
      container_rss_mb: 185.0,
    },
    sync: {
      enabled: true,
      cli_sync_enabled: true,
      service_active: true,
      service_substate: "running",
      service_uptime: "Fri 2026-11-20 12:17:09 -04",
      service_rss_mb: 48.5,
      total_synced_chunks: 6745,
      chunks_by_prefix: { md: 3761, qdrant: 2690, py: 291, cli: 3 },
      last_chunk_synced_utc: ts,
      last_qdrant_pass_utc: ts,
      last_qdrant_scanned: 2690,
      last_qdrant_newly_synced: 0,
      recent_errors_count: 0,
      recent_error_sample: "",
      brain_uplink_ok: true,
      brain_uplink_http_code: 200,
      brain_uplink_latency_ms: 145.0,
      watch_dirs: ["/opt/edge-rag-hub", "/opt/gemini-brain"],
      state_db_size_mb: 1.83,
    },
    services: [
      {
        name: "cloudflared",
        display_name: "Cloudflare Tunnel",
        type: "systemd",
        critical: true,
        active: true,
        status: "active",
        substate: "running",
        uptime_since: "Wed 2026-11-18 18:26:03 -04",
        pid: 1534,
        rss_mb: 42.1,
        restarts: 0,
        health_detail: "Tunnel connected",
      },
      {
        name: "edge-qdrant",
        display_name: "Qdrant Vector DB",
        type: "docker",
        critical: true,
        active: true,
        status: "running",
        substate: "healthy",
        uptime_since: "Up 41 hours",
        pid: 2201,
        rss_mb: 185.0,
        restarts: 0,
        health_detail: "v1.20.2 green",
      },
    ],
  };
}

function buildMockEsp32(nowUtc: Date = new Date()): Esp32TelemetryPayload {
  const ts = formatUtcTimestamp(nowUtc);
  return {
    last_updated_utc: ts,
    sources: { rpi5_probe_utc: ts, direct_push_utc: ts },
    ping: {
      reachable: true,
      target_ip: "192.168.1.125",
      mac: "28:05:A5:E2:96:2C",
      vendor: "Espressif Inc.",
      arp_state: "REACHABLE",
      interface: "eth0",
      packets_sent: 5,
      packets_received: 5,
      packet_loss_pct: 0,
      rtt_min_ms: 48.2,
      rtt_avg_ms: 72.5,
      rtt_max_ms: 105.4,
      rtt_jitter_ms: 18.2,
      ttl: 64,
      probed_at_utc: ts,
      probed_from: "rpi",
    },
    device: {
      firmware_version: "1.2.0",
      chip_model: "ESP32-D0WDQ6",
      cpu_freq_mhz: 240,
      flash_size_mb: 4,
      sdk_version: "v4.4.7",
      uptime_seconds: 86400,
      uptime_human: "1d 0h 0m",
      reset_reason: "POWERON",
      internal_temp_c: 46.5,
      free_heap_kb: 218,
      total_heap_kb: 320,
      min_free_heap_kb: 184,
      max_alloc_heap_kb: 112,
      heap_frag_pct: 12.4,
      wifi_ssid: "NEYROT",
      wifi_bssid: "24:C0:13:56:DB:63",
      wifi_channel: 7,
      wifi_rssi_dbm: -54,
      wifi_signal_pct: 92,
      wifi_ip: "192.168.1.125",
      wifi_gateway: "192.168.1.1",
      wifi_mac: "28:05:A5:E2:96:2C",
      wifi_reconnects: 0,
      poll_cycles: 1440,
      total_probe_failures: 0,
      telegram_alerts_sent: 1,
    },
    oob_watchdog: {
      cf_global_indicator: "none",
      cf_global_description: "All Systems Operational",
      cf_global_incident: "",
      endpoints: [
        {
          name: "brain",
          url: "https://brain.tsimon.me/server-card",
          state: "UP",
          http_code: 200,
          latency_ms: 310,
          consecutive_fails: 0,
          consecutive_passes: 50,
          down_seconds: 0,
          last_error: "",
        },
      ],
    },
    history: {
      samples_24h: 12,
      uptime_pct_24h: 100,
      avg_rtt_24h_ms: 72.5,
      min_rtt_24h_ms: 48.2,
      max_rtt_24h_ms: 105.4,
      consecutive_failures: 0,
      consecutive_successes: 12,
      last_seen_online_utc: ts,
      recent_samples: [{ ts_utc: ts, ok: true, rtt_ms: 72.5, loss_pct: 0 }],
    },
  };
}

function buildMockMetrics(overrides: Partial<CloudMetricsPayload> = {}): CloudMetricsPayload {
  const now = new Date();
  return {
    last_updated: formatUtcTimestamp(now),
    domains: {
      "tsimon.me": {
        status: "HEALTHY",
        bandwidth_gb: 0.012,
        hit_volume: 1850,
        cache_hit_ratio: 84.5,
        security_events: 0,
        errors_5xx: 2,
        errors_5xx_prev_hour: 0,
        errors_5xx_hourly: [
          { hour_utc: "2026-11-20T02:00:00Z", errors_5xx: 0 },
          { hour_utc: "2026-11-20T03:00:00Z", errors_5xx: 2 },
        ],
        errors_5xx_2h_consecutive_over_100: false,
      },
      "minkalab.net": {
        status: "HEALTHY",
        bandwidth_gb: 0.002,
        hit_volume: 120,
        cache_hit_ratio: 92.0,
        security_events: 0,
        errors_5xx: 0,
        errors_5xx_prev_hour: 0,
        errors_5xx_hourly: [],
        errors_5xx_2h_consecutive_over_100: false,
      },
    },
    billing_period: {
      month_start: "2026-11-01",
      current_date_utc: "2026-11-20",
    },
    workers_and_pages: {
      daily_requests: 136,
      daily_requests_limit: 100000,
      daily_requests_pct: 0.14,
      mtd_worker_requests: 11621,
      mtd_pages_requests: 0,
      mtd_subrequests: 14638,
      mtd_errors: 3,
      mtd_cpu_time_ms: 477533.85,
      mtd_assets_requests: 33296,
      mtd_build_minutes: 20.55,
      monthly_build_minutes_limit: 3000,
      monthly_build_minutes_pct: 0.68,
      estimated_billable_usd: 0.0,
      scripts: [
        {
          name: "gemini-brain",
          type: "Worker",
          requests_today: 54,
          requests_mtd: 826,
          subrequests_mtd: 639,
          errors_mtd: 0,
          cpu_time_ms_mtd: 3378.54,
        },
      ],
      assets_hosts: [
        {
          hostname: "tsimon.me",
          requests_today: 411,
          requests_mtd: 22913,
        },
      ],
    },
    workers_ai: {
      daily_neurons: 535.2,
      daily_neurons_limit: 10000,
      daily_neurons_pct: 5.35,
      daily_requests: 393,
      mtd_neurons: 10924.82,
      mtd_billable_neurons: 0.0,
      mtd_requests: 6368,
      mtd_input_tokens: 1449879,
      mtd_output_tokens: 159910,
      mtd_inference_time_ms: 2053186,
      estimated_billable_usd: 0.0,
      models: [],
    },
    d1_billing: {
      daily_rows_read: 44,
      daily_rows_read_limit: QUOTAS.d1_monthly_rows_read_limit,
      daily_rows_read_pct: 0.0408,
      monthly_rows_read_limit: QUOTAS.d1_monthly_rows_read_limit,
      monthly_rows_read_pct: 0.0408,
      daily_rows_written: 88,
      daily_rows_written_limit: 100000,
      daily_rows_written_pct: 0.09,
      mtd_rows_read: 20376475,
      mtd_rows_written: 9808,
      mtd_read_queries: 666,
      mtd_write_queries: 3576,
      total_storage_mb: 55.34,
      account_storage_limit_mb: 5000.0,
      account_storage_pct: 1.11,
      estimated_billable_usd: 0.0,
    },
    d1_databases: [
      {
        name: "archive-knowledge-db",
        uuid: "c0734505-169c-4997-a603-8b3c9d06cab0",
        file_size_mb: 55.3,
        capacity_pct: 11.1,
        rows_read: 20376475,
        rows_written: 9808,
        rows_read_today: 44,
        rows_written_today: 88,
        read_queries: 666,
        write_queries: 3576,
      },
    ],
    durable_objects: {
      daily_requests: 120,
      daily_requests_limit: 100000,
      daily_requests_pct: 0.12,
      daily_duration_gbs: 2.4,
      daily_duration_gbs_limit: 13000,
      daily_duration_gbs_pct: 0.02,
      daily_rows_read: 1850,
      daily_rows_read_limit: QUOTAS.do_monthly_rows_read_limit,
      daily_rows_read_pct: 0.0001,
      monthly_rows_read_limit: QUOTAS.do_monthly_rows_read_limit,
      monthly_rows_read_pct: 0.0001,
      daily_rows_written: 95,
      daily_rows_written_limit: 100000,
      daily_rows_written_pct: 0.1,
      mtd_requests: 4210,
      mtd_errors: 0,
      mtd_duration_gbs: 38.5,
      mtd_active_time_sec: 142.3,
      mtd_cpu_time_ms: 890.4,
      mtd_rows_read: 64200,
      mtd_rows_written: 3120,
      mtd_subrequests: 480,
      mtd_ws_messages: 0,
      total_storage_mb: 4.82,
      storage_limit_mb: 5000.0,
      storage_pct: 0.096,
      estimated_billable_usd: 0.0,
      namespaces: [
        {
          namespace_id: "ns-brain-do",
          name: "BrainMemoryDO (gemini-brain)",
          script_name: "gemini-brain",
          class_name: "BrainMemoryDO",
          use_sqlite: true,
          requests_today: 90,
          requests_mtd: 3100,
          errors_mtd: 0,
          duration_gbs_today: 1.8,
          duration_gbs_mtd: 29.1,
          rows_read_today: 1400,
          rows_written_today: 70,
          rows_read_mtd: 52000,
          rows_written_mtd: 2400,
          ws_inbound_mtd: 0,
          ws_outbound_mtd: 0,
          subrequests_mtd: 360,
          storage_mb: 4.5,
        },
      ],
    },
    kv_billing: {
      daily_reads: 450,
      daily_reads_limit: 100000,
      daily_reads_pct: 0.45,
      daily_writes: 12,
      daily_writes_limit: 1000,
      daily_writes_pct: 1.2,
      daily_deletes: 0,
      daily_deletes_limit: 1000,
      daily_deletes_pct: 0.0,
      daily_lists: 2,
      daily_lists_limit: 1000,
      daily_lists_pct: 0.2,
      mtd_reads: 8400,
      mtd_writes: 210,
      mtd_deletes: 5,
      mtd_lists: 40,
      mtd_object_bytes_mb: 1.85,
      total_keys: 148,
      total_storage_mb: 0.42,
      storage_limit_mb: 1024.0,
      storage_pct: 0.04,
      estimated_billable_usd: 0.0,
      namespaces: [],
    },
    r2_billing: {
      daily_class_a_ops: 15,
      daily_class_b_ops: 180,
      mtd_class_a_ops: 420,
      monthly_class_a_limit: 1000000,
      monthly_class_a_pct: 0.04,
      mtd_class_b_ops: 5600,
      monthly_class_b_limit: 10000000,
      monthly_class_b_pct: 0.056,
      mtd_free_ops: 12,
      mtd_egress_mb: 24.5,
      total_objects: 84,
      total_storage_mb: 128.4,
      storage_limit_mb: 10000.0,
      storage_pct: 1.28,
      estimated_billable_usd: 0.0,
      buckets: [],
    },
    rpi5: buildMockRpi5(now),
    esp32: buildMockEsp32(now),
    ...overrides,
  };
}

describe("Cloudflare, RPi5 & ESP-32S NOC Evaluator & Quota Rules", () => {
  it("reports 0 anomalies on healthy Cloudflare + RPi5 + ESP-32S telemetry", () => {
    const metrics = buildMockMetrics();
    const res = evaluateCloudTelemetry(metrics, {});
    assert.equal(res.activeAnomalies.length, 0);
    assert.equal(res.snoozedAnomalies.length, 0);
    assert.ok(res.compactBrief.includes("[CLOUDFLARE DOMAINS (1h)]"));
    assert.ok(res.compactBrief.includes("[RASPBERRY PI 5 VITALS]"));
    assert.ok(res.compactBrief.includes("[RPI5 QDRANT & SYNC]"));
    assert.ok(res.compactBrief.includes("[ESP-32S WATCHDOG]"));
  });

  it("enforces strict HTTP 5xx rule: do NOT alert unless >= 100/hr across a 2-hour consecutive span", () => {
    // 1. 99 errors/hr for 2 consecutive hours -> NO alert
    assert.equal(
      hasTwoConsecutiveHoursAtOrAbove5xxThreshold(
        [
          { hour_utc: "2026-11-20T01:00:00Z", errors_5xx: 99 },
          { hour_utc: "2026-11-20T02:00:00Z", errors_5xx: 99 },
        ],
        100,
      ),
      false,
    );

    // 2. 60 + 60 across 2 hours (120 total, neither hour >= 100) -> NO alert
    const splitUnder100 = buildMockMetrics();
    splitUnder100.domains["tsimon.me"].errors_5xx = 60;
    splitUnder100.domains["tsimon.me"].errors_5xx_prev_hour = 60;
    splitUnder100.domains["tsimon.me"].errors_5xx_hourly = [
      { hour_utc: "2026-11-20T01:00:00Z", errors_5xx: 60 },
      { hour_utc: "2026-11-20T02:00:00Z", errors_5xx: 60 },
    ];
    assert.equal(evaluateDomain5xxRule(splitUnder100.domains["tsimon.me"], undefined).shouldAlert, false);

    // 3. Single hour >= 100 (e.g., 145) while prev hour < 100 -> NO alert
    const singleHourSpike = buildMockMetrics();
    singleHourSpike.domains["tsimon.me"].errors_5xx = 145;
    singleHourSpike.domains["tsimon.me"].errors_5xx_prev_hour = 12;
    singleHourSpike.domains["tsimon.me"].errors_5xx_hourly = [
      { hour_utc: "2026-11-20T01:00:00Z", errors_5xx: 12 },
      { hour_utc: "2026-11-20T02:00:00Z", errors_5xx: 145 },
    ];
    singleHourSpike.domains["tsimon.me"].errors_5xx_2h_consecutive_over_100 = false;
    const eval1 = evaluateCloudTelemetry(singleHourSpike, {});
    assert.equal(eval1.activeAnomalies.some((a) => a.key === "cf_domain_5xx:tsimon.me"), false);

    // 4. Non-consecutive hours (3h gap) both >= 100 -> NO alert
    assert.equal(
      hasTwoConsecutiveHoursAtOrAbove5xxThreshold(
        [
          { hour_utc: "2026-11-20T01:00:00Z", errors_5xx: 120 },
          { hour_utc: "2026-11-20T04:00:00Z", errors_5xx: 130 },
        ],
        100,
      ),
      false,
    );

    // 5. Exactly 100 errors/hr for 2 consecutive hours -> ALERTS!
    const exactThreshold = buildMockMetrics();
    exactThreshold.domains["tsimon.me"].errors_5xx = 100;
    exactThreshold.domains["tsimon.me"].errors_5xx_prev_hour = 100;
    exactThreshold.domains["tsimon.me"].errors_5xx_hourly = [
      { hour_utc: "2026-11-20T01:00:00Z", errors_5xx: 100 },
      { hour_utc: "2026-11-20T02:00:00Z", errors_5xx: 100 },
    ];
    exactThreshold.domains["tsimon.me"].errors_5xx_2h_consecutive_over_100 = true;
    const eval2 = evaluateCloudTelemetry(exactThreshold, {});
    const finding = eval2.activeAnomalies.find((a) => a.key === "cf_domain_5xx:tsimon.me");
    assert.ok(finding, "Should alert when >= 100 5xx/hr reaches 2 consecutive hours");
    assert.equal(finding?.severity, "WARNING");
  });

  it("enforces 50 Billion/month rows read quota for both D1 and Durable Objects SQL", () => {
    assert.equal(QUOTAS.d1_monthly_rows_read_limit, 50_000_000_000);
    assert.equal(QUOTAS.do_monthly_rows_read_limit, 50_000_000_000);

    // 10 Billion rows read MTD (20% of 50B/mo) -> NO alert
    const low = buildMockMetrics();
    low.d1_billing.mtd_rows_read = 10_000_000_000;
    low.d1_billing.monthly_rows_read_pct = 20.0;
    low.durable_objects.mtd_rows_read = 10_000_000_000;
    low.durable_objects.monthly_rows_read_pct = 20.0;
    assert.equal(evaluateCloudTelemetry(low, {}).activeAnomalies.length, 0);

    // 32 Billion D1 (64% -> WARNING) and 42 Billion DO (84% -> CRITICAL)
    const high = buildMockMetrics();
    high.d1_billing.mtd_rows_read = 32_000_000_000;
    high.d1_billing.monthly_rows_read_pct = 64.0;
    high.durable_objects.mtd_rows_read = 42_000_000_000;
    high.durable_objects.monthly_rows_read_pct = 84.0;
    const evalHigh = evaluateCloudTelemetry(high, {});
    const d1Finding = evalHigh.activeAnomalies.find((a) => a.key === "quota:d1_reads_monthly");
    const doFinding = evalHigh.activeAnomalies.find((a) => a.key === "quota:do_reads_monthly");
    assert.equal(d1Finding?.severity, "WARNING");
    assert.ok(d1Finding?.detail.includes("50,000,000,000"));
    assert.equal(doFinding?.severity, "CRITICAL");
    assert.ok(doFinding?.detail.includes("50,000,000,000"));
  });

  it("evaluates Raspberry Pi 5 vitals, Qdrant, Brain sync & critical services anomalies", () => {
    const m = buildMockMetrics();
    m.rpi5!.thermals.soc_temp_c = 83.5;
    m.rpi5!.thermals.throttled_now = true;
    m.rpi5!.qdrant.reachable = false;
    m.rpi5!.qdrant.healthz_ok = false;
    m.rpi5!.sync.service_active = false;
    m.rpi5!.services[0].active = false; // cloudflared down

    const res = evaluateCloudTelemetry(m, {});
    const keys = res.activeAnomalies.map((a) => a.key);
    assert.ok(keys.includes("rpi5:thermal"));
    assert.ok(keys.includes("rpi5:throttled"));
    assert.ok(keys.includes("rpi5:qdrant_down"));
    assert.ok(keys.includes("rpi5:sync_service_down"));
    assert.ok(keys.includes("rpi5:svc:cloudflared"));
  });

  it("evaluates ESP-32S ping, latency, packet loss, Wi-Fi RSSI, heap, and OOB probe failures", () => {
    const m = buildMockMetrics();
    m.esp32!.ping!.rtt_avg_ms = 220;
    m.esp32!.ping!.packet_loss_pct = 25;
    m.esp32!.device!.wifi_rssi_dbm = -82;
    m.esp32!.device!.free_heap_kb = 32;
    m.esp32!.oob_watchdog!.endpoints[0].state = "DOWN";
    m.esp32!.oob_watchdog!.endpoints[0].last_error = "HTTP 502";

    const res = evaluateCloudTelemetry(m, {});
    const keys = res.activeAnomalies.map((a) => a.key);
    assert.ok(keys.includes("esp32:high_latency"));
    assert.ok(keys.includes("esp32:packet_loss"));
    assert.ok(keys.includes("esp32:weak_wifi"));
    assert.ok(keys.includes("esp32:low_heap"));
    assert.ok(keys.includes("esp32:oob_down:brain"));

    // Rolling 24h history computation
    let hist = updateEsp32History(undefined, { ts_utc: "2026-11-20 12:00:00 UTC", ok: true, rtt_ms: 60, loss_pct: 0 });
    hist = updateEsp32History(hist, { ts_utc: "2026-11-20 12:15:00 UTC", ok: false, rtt_ms: null, loss_pct: 100 });
    assert.equal(hist.samples_24h, 2);
    assert.equal(hist.uptime_pct_24h, 50);
    assert.equal(hist.consecutive_failures, 1);
  });

  it("decides Telegram alert actions with cooldown and recovery support", () => {
    const nowTs = 1_800_000_000;
    const finding = {
      key: "rpi5:qdrant_down",
      severity: "CRITICAL" as const,
      category: "RPi5 Qdrant",
      title: "Qdrant Down",
      detail: "Unreachable",
    };

    // New anomaly -> immediate alert
    const d1 = decideTelegramAlertAction([finding], {}, nowTs, 14400);
    assert.equal(d1.shouldAlert, true);
    assert.equal(d1.reasonCode, "ANOMALY_DETECTED");

    // Existing anomaly inside cooldown -> NO spam alert
    const stateActive: NocPersistentState = {
      active_alerts: {
        "rpi5:qdrant_down": {
          severity: "CRITICAL",
          title: "Qdrant Down",
          detail: "Unreachable",
          first_seen_ts: nowTs - 900,
          last_updated_ts: nowTs - 900,
        },
      },
      telegram: { last_alert_ts: nowTs - 900 },
    };
    const d2 = decideTelegramAlertAction([finding], stateActive, nowTs, 14400);
    assert.equal(d2.shouldAlert, false);

    // Resolved -> ALL_CLEAR_RESOLVED alert
    const d3 = decideTelegramAlertAction([], stateActive, nowTs, 14400);
    assert.equal(d3.shouldAlert, true);
    assert.equal(d3.reasonCode, "ALL_CLEAR_RESOLVED");
  });

  it("parses exhaustive Telegram commands and splits long HTML safely", () => {
    assert.deepEqual(parseTelegramCommand("/pi", true), { type: "PI" });
    assert.deepEqual(parseTelegramCommand("/qdrant@my_noc_bot", false), { type: "QDRANT" });
    assert.deepEqual(parseTelegramCommand("/sync", true), { type: "SYNC" });
    assert.deepEqual(parseTelegramCommand("/services", true), { type: "SERVICES" });
    assert.deepEqual(parseTelegramCommand("/esp32", true), { type: "ESP32" });
    assert.deepEqual(parseTelegramCommand("/5xx", true), { type: "FIVE_XX" });
    assert.deepEqual(parseTelegramCommand("/full", true), { type: "FULL" });
    assert.deepEqual(parseTelegramCommand("/cf tsimon.me", true), { type: "CF", arg: "tsimon.me" });
    assert.deepEqual(parseTelegramCommand("/snooze 1 72h", true), { type: "SNOOZE", arg: "1 72h" });
    assert.deepEqual(parseTelegramCommand("Why is RPi5 warm?", true), { type: "ASK", question: "Why is RPi5 warm?" });

    const bigText = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${"x".repeat(30)}`).join("\n");
    const chunks = splitTelegramMessage(bigText, 1000);
    assert.ok(chunks.length > 5);
    assert.ok(chunks.every((c) => c.length <= 1000));
  });

  it("validates R2 classification & snooze durations", () => {
    assert.equal(classifyR2ActionType("PutObject"), "class_a");
    assert.equal(classifyR2ActionType("GetObject"), "class_b");
    assert.equal(classifyR2ActionType("DeleteObject"), "free");
    assert.equal(normalizeSnoozeDuration("24h").seconds, 86400);
    assert.equal(normalizeSnoozeDuration("72h").seconds, 259200);
    assert.equal(normalizeSnoozeDuration("7d").seconds, 604800);
  });
});

describe("End-to-End Worker, Host Isolation, Ingest & Telegram Integration", () => {
  it("enforces noc-hook.tsimon.me isolation, authenticates RPi5/ESP32 ingest & processes Telegram commands", async () => {
    const kvMap = new Map<string, unknown>();
    const mockState: any = {
      storage: {
        get: async (k: string) => kvMap.get(k),
        put: async (k: string, v: unknown) => {
          kvMap.set(k, v);
        },
      },
    };

    const telegramCalls: Array<{ method: string; body: any }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.telegram.org/bot")) {
        const method = url.split("/").pop() || "";
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        telegramCalls.push({ method, body });
        return Response.json({ ok: true, result: { message_id: 101, username: "test_noc_bot" } });
      }
      return Response.json({ result: [] });
    }) as typeof fetch;

    try {
      const mockEnv: Env = {
        CLOUDFLARE_API_TOKEN: "test-token",
        CLOUDFLARE_ACCOUNT_ID: "70f73cd2a15a31eba64e1aa860d47614",
        NOC_INGEST_TOKEN: "super-secret-ingest-token",
        NOC_WEBHOOK_HOST: "noc-hook.tsimon.me",
        TELEGRAM_BOT_TOKEN: "123456:TESTTOKEN",
        TELEGRAM_CHAT_ID: "8590242462",
        TELEGRAM_WEBHOOK_SECRET: "tg-webhook-secret-xyz",
        AI_MODEL: "@cf/google/gemma-4-26b-a4b-it",
        AI: {
          run: async () => ({
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "* **Status**: Healthy across Cloudflare, RPi5, and ESP-32S.",
                },
                finish_reason: "stop",
              },
            ],
          }),
        } as any,
        ASSETS: {
          fetch: async () => new Response("<html>NOC Dashboard</html>", { status: 200 }),
        } as any,
        NOC_MONITOR_DO: null as any,
      };

      const doInstance = new NocMonitorDO(mockState, mockEnv);
      mockEnv.NOC_MONITOR_DO = {
        idFromName: () => "global-id" as any,
        get: () => ({
          fetch: (req: Request | string, init?: RequestInit) =>
            doInstance.fetch(typeof req === "string" ? new Request(req, init) : req),
        }),
      } as any;

      // Seed Cloudflare metrics cache
      await mockState.storage.put("metrics_cache", {
        fetchedAtMs: Date.now(),
        payload: buildMockMetrics({ rpi5: null, esp32: null }),
      });

      const ctx: any = { waitUntil: () => {} };

      // 1. noc-hook.tsimon.me MUST reject dashboard / metrics routes with 404
      const blockedDash = await worker.fetch(new Request("https://noc-hook.tsimon.me/"), mockEnv, ctx);
      assert.equal(blockedDash.status, 404);
      const blockedMetrics = await worker.fetch(new Request("https://noc-hook.tsimon.me/metrics.json"), mockEnv, ctx);
      assert.equal(blockedMetrics.status, 404);

      // 2. noc-hook.tsimon.me/api/ingest/rpi5 rejects bad token (401)
      const badIngest = await worker.fetch(
        new Request("https://noc-hook.tsimon.me/api/ingest/rpi5", {
          method: "POST",
          headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
          body: JSON.stringify(buildMockRpi5()),
        }),
        mockEnv,
        ctx,
      );
      assert.equal(badIngest.status, 401);

      // 3. Valid RPi5 ingest with embedded ESP-32S probe succeeds & populates /metrics.json
      const rpiPayload: any = {
        ...buildMockRpi5(),
        esp32_probe: {
          ping: buildMockEsp32().ping,
        },
      };
      const goodIngest = await worker.fetch(
        new Request("https://noc-hook.tsimon.me/api/ingest/rpi5", {
          method: "POST",
          headers: { Authorization: "Bearer super-secret-ingest-token", "Content-Type": "application/json" },
          body: JSON.stringify(rpiPayload),
        }),
        mockEnv,
        ctx,
      );
      assert.equal(goodIngest.status, 200);

      // Verify /metrics.json on noc.tsimon.me now includes rpi5 and esp32!
      const metricsResp = await worker.fetch(new Request("https://noc.tsimon.me/metrics.json"), mockEnv, ctx);
      const merged = (await metricsResp.json()) as CloudMetricsPayload;
      assert.equal(merged.rpi5?.host.hostname, "rpi");
      assert.equal(merged.rpi5?.qdrant.points_count, 2690);
      assert.equal(merged.esp32?.ping?.target_ip, "192.168.1.125");
      assert.equal(merged.esp32?.history?.samples_24h, 1);

      // 4. Telegram webhook rejects bad secret token
      const badTg = await worker.fetch(
        new Request("https://noc-hook.tsimon.me/api/telegram/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "wrong" },
          body: JSON.stringify({ message: { chat: { id: 8590242462, type: "private" }, from: { id: 8590242462 }, text: "/pi" } }),
        }),
        mockEnv,
        ctx,
      );
      assert.equal(badTg.status, 401);

      // 5. Authorized Telegram commands (/pi, /qdrant, /sync, /services, /esp32, /5xx, /full)
      for (const cmd of ["/pi", "/qdrant", "/sync", "/services", "/esp32", "/5xx", "/d1", "/do", "/full"]) {
        const tgResp = await worker.fetch(
          new Request("https://noc-hook.tsimon.me/api/telegram/webhook", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Telegram-Bot-Api-Secret-Token": "tg-webhook-secret-xyz",
            },
            body: JSON.stringify({
              message: {
                message_id: 42,
                chat: { id: 8590242462, type: "private" },
                from: { id: 8590242462 },
                text: cmd,
              },
            }),
          }),
          mockEnv,
          ctx,
        );
        assert.equal(tgResp.status, 200, `Command ${cmd} failed`);
      }

      const sentTexts = telegramCalls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
      assert.ok(sentTexts.some((t) => t.includes("Raspberry Pi 5 System Vitals")));
      assert.ok(sentTexts.some((t) => t.includes("Qdrant Vector DB") && t.includes("2,690")));
      assert.ok(sentTexts.some((t) => t.includes("gemini-brain-watcher") && t.includes("6,745")));
      assert.ok(sentTexts.some((t) => t.includes("ESP-32S Out-of-Band Watchdog") && t.includes("192.168.1.125")));
      assert.ok(sentTexts.some((t) => t.includes("50,000,000,000")));

      // 6. Unauthorized Telegram chat is ignored without sending any message
      const countBefore = telegramCalls.length;
      const unauthTg = await worker.fetch(
        new Request("https://noc-hook.tsimon.me/api/telegram/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Telegram-Bot-Api-Secret-Token": "tg-webhook-secret-xyz",
          },
          body: JSON.stringify({
            message: { chat: { id: 999999, type: "private" }, from: { id: 999999 }, text: "/full" },
          }),
        }),
        mockEnv,
        ctx,
      );
      assert.equal(unauthTg.status, 200);
      assert.equal(telegramCalls.length, countBefore, "Unauthorized chat must not receive any Telegram reply");

      // 7. Critical RPi5 Qdrant outage triggers proactive Telegram alert with snooze keyboard!
      const critBefore = telegramCalls.filter((c) => c.method === "sendMessage").length;
      const downRpi = buildMockRpi5();
      downRpi.qdrant.reachable = false;
      downRpi.qdrant.healthz_ok = false;
      downRpi.qdrant.status = "offline";
      await worker.fetch(
        new Request("https://noc-hook.tsimon.me/api/ingest/rpi5", {
          method: "POST",
          headers: { Authorization: "Bearer super-secret-ingest-token", "Content-Type": "application/json" },
          body: JSON.stringify(downRpi),
        }),
        mockEnv,
        ctx,
      );
      const alertMsgs = telegramCalls.filter((c) => c.method === "sendMessage").slice(critBefore);
      assert.ok(alertMsgs.length >= 1, "Proactive Telegram alert should fire on critical Qdrant outage");
      assert.ok(String(alertMsgs[0].body.text).includes("Qdrant Vector Database Unreachable"));
      assert.ok(alertMsgs[0].body.reply_markup?.inline_keyboard?.length > 0);

      // 8. Inline callback button snoozes that Qdrant alert
      const qHash = shortKeyHash("rpi5:qdrant_down");
      const cbResp = await worker.fetch(
        new Request("https://noc-hook.tsimon.me/api/telegram/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Telegram-Bot-Api-Secret-Token": "tg-webhook-secret-xyz",
          },
          body: JSON.stringify({
            callback_query: {
              id: "cb-1",
              from: { id: 8590242462 },
              message: { chat: { id: 8590242462 } },
              data: `snz:${qHash}:24h`,
            },
          }),
        }),
        mockEnv,
        ctx,
      );
      assert.equal(cbResp.status, 200);
      const aiAfterSnooze = await (await worker.fetch(new Request("https://noc.tsimon.me/ai_analysis.json"), mockEnv, ctx)).json() as any;
      assert.equal(aiAfterSnooze.anomalies_count, 0);
      assert.equal(aiAfterSnooze.snoozed_count, 1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("parses GraphQL & REST telemetry with 50B/mo D1 and Durable Objects SQL read quotas", async () => {
    const origFetch = globalThis.fetch;
    const nowUtc = new Date(Date.UTC(2026, 10, 20, 18, 0, 0));

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith("/graphql")) {
        return Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  workersInvocationsAdaptive: [],
                  pagesFunctionsInvocationsAdaptiveGroups: [],
                  workersAssetsRequestsAdaptiveGroups: [],
                  workersBuildsBuildMinutesAdaptiveGroups: [],
                  aiInferenceAdaptiveGroups: [],
                  d1AnalyticsAdaptiveGroups: [
                    {
                      dimensions: { databaseId: "db-1", date: "2026-11-20" },
                      sum: { readQueries: 100, writeQueries: 10, rowsRead: 5_000_000_000, rowsWritten: 500 },
                    },
                  ],
                  durableObjectsInvocationsAdaptiveGroups: [],
                  durableObjectsPeriodicGroups: [
                    {
                      dimensions: { name: "BrainMemoryDO", namespaceId: "do-1", date: "2026-11-20" },
                      sum: {
                        activeTime: 1_000_000,
                        cpuTime: 10_000,
                        duration: 5.0,
                        rowsRead: 10_000_000_000,
                        rowsWritten: 100,
                        subrequests: 10,
                        inboundWebsocketMsgCount: 0,
                        outboundWebsocketMsgCount: 0,
                      },
                    },
                  ],
                  durableObjectsSqlStorageGroups: [],
                  durableObjectsStorageGroups: [],
                  kvOperationsAdaptiveGroups: [],
                  kvStorageAdaptiveGroups: [],
                  r2OperationsAdaptiveGroups: [],
                  r2StorageAdaptiveGroups: [],
                },
              ],
            },
          },
        });
      }
      return Response.json({ result: [] });
    }) as typeof fetch;

    try {
      const res = await fetchAccountBillingAndUsage(
        "70f73cd2a15a31eba64e1aa860d47614",
        { Authorization: "Bearer test" },
        nowUtc,
      );
      assert.equal(res.d1_billing.monthly_rows_read_limit, 50_000_000_000);
      assert.equal(res.d1_billing.monthly_rows_read_pct, 10.0); // 5B / 50B = 10%
      assert.equal(res.durable_objects.monthly_rows_read_limit, 50_000_000_000);
      assert.equal(res.durable_objects.monthly_rows_read_pct, 20.0); // 10B / 50B = 20%
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("uses @cf/google/gemma-4-26b-a4b-it by default with ChatCompletions extraction and enable_thinking disabled", async () => {
    const calls: Array<{ model: string; inputs: any }> = [];
    const mockEnv: Env = {
      CLOUDFLARE_API_TOKEN: "test-token",
      CLOUDFLARE_ACCOUNT_ID: "70f73cd2a15a31eba64e1aa860d47614",
      NOC_INGEST_TOKEN: "test-ingest",
      AI: {
        run: async (model: string, inputs: any) => {
          calls.push({ model, inputs });
          return {
            id: "chatcmpl-gemma4",
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "* **Status**: All Cloudflare, RPi5, and ESP-32S systems nominal.",
                },
                finish_reason: "stop",
              },
            ],
          };
        },
      } as any,
      ASSETS: {} as any,
      NOC_MONITOR_DO: {} as any,
    };

    const out = await runAutomatedNocAnalysis(mockEnv, "Snapshot: nominal", "SCHEDULED", []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, "@cf/google/gemma-4-26b-a4b-it");
    assert.equal(calls[0].inputs.max_tokens, 1024);
    assert.deepEqual(calls[0].inputs.chat_template_kwargs, { enable_thinking: false });
    assert.equal(out.modelUsed, "@cf/google/gemma-4-26b-a4b-it (Workers AI)");
    assert.ok(out.text.includes("All Cloudflare, RPi5, and ESP-32S systems nominal."));
  });
});
