export interface Env {
  NOC_MONITOR_DO: DurableObjectNamespace;
  AI: Ai;
  ASSETS: Fetcher;

  // Secrets & Environment Variables
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CF_ZONE_ID_1?: string;
  CF_ZONE_ID_2?: string;
  CF_ZONE_ID_3?: string;
  CF_ZONE_ID_4?: string;
  AI_MODEL?: string;
  AI_FALLBACK_MODEL?: string;
  METRICS_TTL_SECONDS?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;

  // Machine-to-Machine Ingest & Telegram Bot Integration
  NOC_INGEST_TOKEN?: string;
  NOC_DASHBOARD_URL?: string;
  NOC_WEBHOOK_HOST?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_ALERT_COOLDOWN_SEC?: string;
  [key: string]: unknown;
}

export const QUOTAS = {
  workers_daily_requests_limit: 100_000,
  workers_monthly_build_minutes_limit: 3_000,
  workers_ai_daily_neurons_limit: 10_000,
  workers_ai_cost_per_1k_neurons_usd: 0.011,
  // Updated per operator policy: 50 Billion rows read / month for D1 and Durable Objects SQL
  d1_monthly_rows_read_limit: 50_000_000_000,
  d1_daily_rows_read_limit: 50_000_000_000,
  d1_daily_rows_written_limit: 100_000,
  d1_per_db_storage_limit_mb: 500.0,
  d1_account_storage_limit_mb: 5_000.0,
  do_daily_requests_limit: 100_000,
  do_daily_duration_gbs_limit: 13_000,
  do_monthly_rows_read_limit: 50_000_000_000,
  do_daily_rows_read_limit: 50_000_000_000,
  do_daily_rows_written_limit: 100_000,
  do_storage_limit_mb: 5_000.0,
  kv_daily_reads_limit: 100_000,
  kv_daily_writes_limit: 1_000,
  kv_daily_deletes_limit: 1_000,
  kv_daily_lists_limit: 1_000,
  kv_storage_limit_mb: 1_024.0,
  r2_monthly_class_a_limit: 1_000_000,
  r2_monthly_class_b_limit: 10_000_000,
  r2_storage_limit_mb: 10_000.0,
} as const;

export const THRESHOLDS = {
  metrics_stale_seconds: 600,             // 10 minutes
  // Strict HTTP 5xx Alert Policy:
  // Do NOT alert on HTTP 5xx errors unless they reach >= 100 errors/hour across a 2-hour span.
  domain_5xx_warn: 100,
  domain_5xx_sustained_hours: 2,
  domain_5xx_sustained_seconds: 2 * 3600, // 7,200 seconds (2 consecutive hours)
  domain_threats_warn: 15,
  domain_threats_crit: 100,
  quota_warn_pct: 60.0,
  quota_crit_pct: 80.0,
  ai_refresh_interval_seconds: 3600,      // Refresh AI analysis at least once per hour on cron

  // Raspberry Pi 5 Monitoring Thresholds (15-minute cron cadence)
  rpi5_stale_seconds: 35 * 60,            // 35 minutes (> 2x 15m cron interval)
  rpi5_cpu_warn_pct: 80.0,
  rpi5_cpu_crit_pct: 92.0,
  rpi5_load_warn_pct: 80.0,
  rpi5_load_crit_pct: 95.0,
  rpi5_temp_warn_c: 70.0,
  rpi5_temp_crit_c: 80.0,
  rpi5_ram_warn_pct: 85.0,
  rpi5_ram_crit_pct: 93.0,
  rpi5_swap_warn_pct: 85.0,
  rpi5_swap_crit_pct: 95.0,
  rpi5_disk_warn_pct: 80.0,
  rpi5_disk_crit_pct: 90.0,
  rpi5_sync_pass_stale_seconds: 45 * 60,  // 45 minutes without Qdrant federation pass
  rpi5_sync_errors_warn: 5,

  // ESP-32S Out-of-Band Watchdog Thresholds
  esp32_stale_seconds: 35 * 60,           // 35 minutes
  esp32_rtt_warn_ms: 150.0,
  esp32_rtt_crit_ms: 400.0,
  esp32_loss_warn_pct: 20.0,
  esp32_loss_crit_pct: 60.0,
  esp32_rssi_warn_dbm: -78,
  esp32_heap_warn_kb: 40,

  // Telegram Alerting Cooldown
  telegram_alert_cooldown_seconds: 4 * 3600,
} as const;

export interface Hour5xxBucket {
  hour_utc: string;
  errors_5xx: number;
}

export interface ZoneMetrics {
  status: string;
  bandwidth_gb: number;
  hit_volume: number;
  cache_hit_ratio: number;
  security_events: number;
  errors_5xx: number;
  errors_5xx_prev_hour: number;
  errors_5xx_hourly: Hour5xxBucket[];
  errors_5xx_2h_consecutive_over_100: boolean;
}

export interface WorkerScriptUsage {
  name: string;
  type: "Worker" | "Pages" | "Pages Function";
  requests_today: number;
  requests_mtd: number;
  subrequests_mtd: number;
  errors_mtd: number;
  cpu_time_ms_mtd: number;
}

export interface AssetHostUsage {
  hostname: string;
  requests_today: number;
  requests_mtd: number;
}

export interface WorkersAndPagesUsage {
  daily_requests: number;
  daily_requests_limit: number;
  daily_requests_pct: number;
  mtd_worker_requests: number;
  mtd_pages_requests: number;
  mtd_subrequests: number;
  mtd_errors: number;
  mtd_cpu_time_ms: number;
  mtd_assets_requests: number;
  mtd_build_minutes: number;
  monthly_build_minutes_limit: number;
  monthly_build_minutes_pct: number;
  estimated_billable_usd: number;
  scripts: WorkerScriptUsage[];
  assets_hosts: AssetHostUsage[];
}

export interface AiModelUsage {
  model_id: string;
  requests_mtd: number;
  requests_today: number;
  neurons_mtd: number;
  input_tokens_mtd: number;
  output_tokens_mtd: number;
  inference_time_ms_mtd: number;
}

export interface WorkersAiUsage {
  daily_neurons: number;
  daily_neurons_limit: number;
  daily_neurons_pct: number;
  daily_requests: number;
  mtd_neurons: number;
  mtd_billable_neurons: number;
  mtd_requests: number;
  mtd_input_tokens: number;
  mtd_output_tokens: number;
  mtd_inference_time_ms: number;
  estimated_billable_usd: number;
  models: AiModelUsage[];
}

export interface D1BillingUsage {
  daily_rows_read: number;
  daily_rows_read_limit: number;
  daily_rows_read_pct: number;
  monthly_rows_read_limit?: number;
  monthly_rows_read_pct?: number;
  daily_rows_written: number;
  daily_rows_written_limit: number;
  daily_rows_written_pct: number;
  mtd_rows_read: number;
  mtd_rows_written: number;
  mtd_read_queries: number;
  mtd_write_queries: number;
  total_storage_mb: number;
  account_storage_limit_mb: number;
  account_storage_pct: number;
  estimated_billable_usd: number;
}

export interface D1DatabaseUsage {
  name: string;
  uuid: string;
  file_size_mb: number;
  capacity_pct: number;
  rows_read: number;
  rows_written: number;
  rows_read_today: number;
  rows_written_today: number;
  read_queries: number;
  write_queries: number;
}

export interface DurableObjectNamespaceUsage {
  namespace_id: string;
  name: string;
  script_name: string;
  class_name: string;
  use_sqlite: boolean;
  requests_today: number;
  requests_mtd: number;
  errors_mtd: number;
  duration_gbs_today: number;
  duration_gbs_mtd: number;
  rows_read_today: number;
  rows_written_today: number;
  rows_read_mtd: number;
  rows_written_mtd: number;
  ws_inbound_mtd: number;
  ws_outbound_mtd: number;
  subrequests_mtd: number;
  storage_mb: number;
}

export interface DurableObjectsUsage {
  daily_requests: number;
  daily_requests_limit: number;
  daily_requests_pct: number;
  daily_duration_gbs: number;
  daily_duration_gbs_limit: number;
  daily_duration_gbs_pct: number;
  daily_rows_read: number;
  daily_rows_read_limit: number;
  daily_rows_read_pct: number;
  monthly_rows_read_limit?: number;
  monthly_rows_read_pct?: number;
  daily_rows_written: number;
  daily_rows_written_limit: number;
  daily_rows_written_pct: number;
  mtd_requests: number;
  mtd_errors: number;
  mtd_duration_gbs: number;
  mtd_active_time_sec: number;
  mtd_cpu_time_ms: number;
  mtd_rows_read: number;
  mtd_rows_written: number;
  mtd_subrequests: number;
  mtd_ws_messages: number;
  total_storage_mb: number;
  storage_limit_mb: number;
  storage_pct: number;
  estimated_billable_usd: number;
  namespaces: DurableObjectNamespaceUsage[];
}

export interface KvNamespaceUsage {
  namespace_id: string;
  title: string;
  reads_today: number;
  writes_today: number;
  deletes_today: number;
  lists_today: number;
  reads_mtd: number;
  writes_mtd: number;
  deletes_mtd: number;
  lists_mtd: number;
  key_count: number;
  storage_mb: number;
}

export interface KvBillingUsage {
  daily_reads: number;
  daily_reads_limit: number;
  daily_reads_pct: number;
  daily_writes: number;
  daily_writes_limit: number;
  daily_writes_pct: number;
  daily_deletes: number;
  daily_deletes_limit: number;
  daily_deletes_pct: number;
  daily_lists: number;
  daily_lists_limit: number;
  daily_lists_pct: number;
  mtd_reads: number;
  mtd_writes: number;
  mtd_deletes: number;
  mtd_lists: number;
  mtd_object_bytes_mb: number;
  total_keys: number;
  total_storage_mb: number;
  storage_limit_mb: number;
  storage_pct: number;
  estimated_billable_usd: number;
  namespaces: KvNamespaceUsage[];
}

export interface R2BucketUsage {
  name: string;
  class_a_ops_today: number;
  class_b_ops_today: number;
  class_a_ops_mtd: number;
  class_b_ops_mtd: number;
  free_ops_mtd: number;
  egress_mb_mtd: number;
  object_count: number;
  upload_count: number;
  payload_size_mb: number;
  metadata_size_mb: number;
}

export interface R2BillingUsage {
  daily_class_a_ops: number;
  daily_class_b_ops: number;
  mtd_class_a_ops: number;
  monthly_class_a_limit: number;
  monthly_class_a_pct: number;
  mtd_class_b_ops: number;
  monthly_class_b_limit: number;
  monthly_class_b_pct: number;
  mtd_free_ops: number;
  mtd_egress_mb: number;
  total_objects: number;
  total_storage_mb: number;
  storage_limit_mb: number;
  storage_pct: number;
  estimated_billable_usd: number;
  buckets: R2BucketUsage[];
}

// ============================================================================
// RASPBERRY PI 5 EDGE HOST TELEMETRY (CRON EVERY 15 MINUTES)
// ============================================================================

export interface Rpi5HostInfo {
  hostname: string;
  os_pretty: string;
  kernel: string;
  arch: string;
  model: string;
  uptime_seconds: number;
  uptime_human: string;
  boot_time_utc: string;
  processes_total: number;
  processes_running: number;
}

export interface Rpi5CpuMetrics {
  model: string;
  cores: number;
  usage_pct: number;
  per_core_pct: number[];
  freq_mhz: number;
  max_freq_mhz: number;
  governor: string;
  load_1m: number;
  load_5m: number;
  load_15m: number;
  load_pct: number;
}

export interface Rpi5ThermalMetrics {
  soc_temp_c: number | null;
  rp1_temp_c: number | null;
  fan_rpm: number | null;
  fan_pwm: number | null;
  core_volts: number | null;
  throttled_hex: string;
  throttled_status: string;
  throttled_now: boolean;
  throttled_flags: string[];
}

export interface Rpi5MemoryMetrics {
  ram_total_mb: number;
  ram_used_mb: number;
  ram_available_mb: number;
  ram_cached_mb: number;
  ram_free_mb: number;
  ram_usage_pct: number;
  swap_total_mb: number;
  swap_used_mb: number;
  swap_free_mb: number;
  swap_usage_pct: number;
}

export interface Rpi5StorageEntry {
  device: string;
  mountpoint: string;
  fstype: string;
  total_gb: number;
  used_gb: number;
  free_gb: number;
  usage_pct: number;
  inode_usage_pct: number | null;
}

export interface Rpi5NetworkInterface {
  name: string;
  operstate: string;
  ipv4: string[];
  ipv6: string[];
  mac: string;
  speed_mbps: number | null;
  rx_mb: number;
  tx_mb: number;
  rx_errors: number;
  tx_errors: number;
  rx_drops: number;
  tx_drops: number;
  wifi_ssid?: string | null;
  wifi_rssi_dbm?: number | null;
  wifi_freq_mhz?: number | null;
  wifi_bitrate_mbps?: number | null;
}

export interface Rpi5NetworkMetrics {
  primary_ip: string;
  gateway_ip: string;
  gateway_rtt_ms: number | null;
  interfaces: Rpi5NetworkInterface[];
}

export interface Rpi5QdrantStatus {
  reachable: boolean;
  healthz_ok: boolean;
  status: string; // "green" | "yellow" | "red" | "offline"
  version: string;
  collection: string;
  collections_count: number;
  points_count: number;
  indexed_vectors_count: number;
  segments_count: number;
  optimizer_status: string;
  vector_size: number;
  distance: string;
  disk_usage_mb: number;
  api_latency_ms: number | null;
  container_status: string;
  container_uptime: string;
  container_rss_mb: number | null;
  error?: string;
}

export interface Rpi5SyncStatus {
  enabled: boolean;
  cli_sync_enabled: boolean;
  service_active: boolean;
  service_substate: string;
  service_uptime: string;
  service_rss_mb: number | null;
  total_synced_chunks: number;
  chunks_by_prefix: Record<string, number>;
  last_chunk_synced_utc: string;
  last_qdrant_pass_utc: string;
  last_qdrant_scanned: number;
  last_qdrant_newly_synced: number;
  recent_errors_count: number;
  recent_error_sample: string;
  brain_uplink_ok: boolean;
  brain_uplink_http_code: number | null;
  brain_uplink_latency_ms: number | null;
  watch_dirs: string[];
  state_db_size_mb: number;
}

export interface Rpi5ServiceStatus {
  name: string;
  display_name: string;
  type: "systemd" | "docker" | "timer";
  critical: boolean;
  active: boolean;
  status: string;
  substate: string;
  uptime_since: string;
  pid: number | null;
  rss_mb: number | null;
  restarts: number;
  health_detail: string;
}

export interface Rpi5TelemetryPayload {
  reported_at_utc: string;
  received_at_utc?: string;
  agent_version: string;
  cron_interval_sec: number;
  host: Rpi5HostInfo;
  cpu: Rpi5CpuMetrics;
  thermals: Rpi5ThermalMetrics;
  memory: Rpi5MemoryMetrics;
  storage: Rpi5StorageEntry[];
  network: Rpi5NetworkMetrics;
  qdrant: Rpi5QdrantStatus;
  sync: Rpi5SyncStatus;
  services: Rpi5ServiceStatus[];
}

// ============================================================================
// ESP-32S OUT-OF-BAND WATCHDOG TELEMETRY
// ============================================================================

export interface Esp32PingTelemetry {
  reachable: boolean;
  target_ip: string;
  mac: string;
  vendor: string;
  arp_state: string;
  interface: string;
  packets_sent: number;
  packets_received: number;
  packet_loss_pct: number;
  rtt_min_ms: number | null;
  rtt_avg_ms: number | null;
  rtt_max_ms: number | null;
  rtt_jitter_ms: number | null;
  ttl: number | null;
  probed_at_utc: string;
  probed_from: string;
}

export interface Esp32DeviceVitals {
  firmware_version: string;
  chip_model: string;
  cpu_freq_mhz: number;
  flash_size_mb: number;
  sdk_version: string;
  uptime_seconds: number;
  uptime_human: string;
  reset_reason: string;
  internal_temp_c: number | null;
  free_heap_kb: number;
  total_heap_kb: number;
  min_free_heap_kb: number;
  max_alloc_heap_kb: number;
  heap_frag_pct: number;
  wifi_ssid: string;
  wifi_bssid: string;
  wifi_channel: number;
  wifi_rssi_dbm: number;
  wifi_signal_pct: number;
  wifi_ip: string;
  wifi_gateway: string;
  wifi_mac: string;
  wifi_reconnects: number;
  poll_cycles: number;
  total_probe_failures: number;
  telegram_alerts_sent: number;
}

export interface Esp32OobEndpointStatus {
  name: string;
  url: string;
  state: "UP" | "SLOW" | "DOWN" | "INIT";
  http_code: number;
  latency_ms: number;
  consecutive_fails: number;
  consecutive_passes: number;
  down_seconds: number;
  last_error: string;
}

export interface Esp32OobWatchdogStatus {
  cf_global_indicator: string;
  cf_global_description: string;
  cf_global_incident: string;
  endpoints: Esp32OobEndpointStatus[];
}

export interface Esp32HistorySample {
  ts_utc: string;
  ok: boolean;
  rtt_ms: number | null;
  loss_pct: number;
}

export interface Esp32HistorySummary {
  samples_24h: number;
  uptime_pct_24h: number;
  avg_rtt_24h_ms: number | null;
  min_rtt_24h_ms: number | null;
  max_rtt_24h_ms: number | null;
  consecutive_failures: number;
  consecutive_successes: number;
  last_seen_online_utc: string;
  recent_samples: Esp32HistorySample[];
}

export interface Esp32TelemetryPayload {
  last_updated_utc: string;
  sources: {
    rpi5_probe_utc?: string;
    direct_push_utc?: string;
    local_http_utc?: string;
  };
  ping?: Esp32PingTelemetry;
  device?: Esp32DeviceVitals;
  oob_watchdog?: Esp32OobWatchdogStatus;
  history?: Esp32HistorySummary;
}

export interface CloudMetricsPayload {
  last_updated: string;
  domains: Record<string, ZoneMetrics>;
  billing_period: {
    month_start: string;
    current_date_utc: string;
  };
  workers_and_pages: WorkersAndPagesUsage;
  workers_ai: WorkersAiUsage;
  d1_billing: D1BillingUsage;
  d1_databases: D1DatabaseUsage[];
  durable_objects: DurableObjectsUsage;
  kv_billing: KvBillingUsage;
  r2_billing: R2BillingUsage;
  rpi5?: Rpi5TelemetryPayload | null;
  esp32?: Esp32TelemetryPayload | null;
}

export interface AnomalyFinding {
  key: string;
  severity: "WARNING" | "CRITICAL";
  category: string;
  title: string;
  detail: string;
}

export interface SnoozedAnomaly extends AnomalyFinding {
  duration_str: "24h" | "72h" | "7d";
  duration_label: string;
  duration_seconds: number;
  snoozed_at_ts: number;
  snoozed_at_utc: string;
  snoozed_until_ts: number;
  snoozed_until_utc: string;
  snoozed_by: string;
  remaining_seconds?: number;
  remaining_human?: string;
}

export interface Domain5xxStreakEntry {
  first_exceeded_ts: number;
  first_exceeded_utc: string;
  last_seen_ts: number;
  last_errors_5xx: number;
  sustained_seconds: number;
}

export interface ActiveAlertEntry {
  severity: "WARNING" | "CRITICAL";
  title: string;
  detail: string;
  first_seen_ts: number;
  last_updated_ts: number;
}

export interface TelegramAlertState {
  last_alert_ts?: number;
  last_alert_utc?: string;
  last_alert_reason?: string;
  last_alerted_keys?: string[];
  alerts_sent_total?: number;
  commands_handled_total?: number;
  last_command_utc?: string;
}

export interface NocPersistentState {
  zone_name_cache?: Record<string, string>;
  script_errors_mtd?: Record<string, number>;
  do_errors_mtd?: Record<string, number>;
  domain_5xx_streak?: Record<string, Domain5xxStreakEntry>;
  snoozed_anomalies?: Record<string, SnoozedAnomaly>;
  active_alerts?: Record<string, ActiveAlertEntry>;
  telegram?: TelegramAlertState;
  last_check_utc?: string;
  last_reason_code?: string;
  last_ai_analysis?: string;
  last_ai_model?: string;
  last_inference_sec?: number;
  last_llm_ts?: number;
}

export interface AiAnalysisPayload {
  last_analyzed_utc: string;
  metrics_sync_utc: string;
  model: string;
  inference_duration_sec: number;
  overall_status: "HEALTHY" | "WARNING" | "CRITICAL";
  reason_code: string;
  anomalies_count: number;
  anomalies: AnomalyFinding[];
  snoozed_count: number;
  snoozed_anomalies: SnoozedAnomaly[];
  analysis: string;
}
