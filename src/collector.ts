import {
  QUOTAS,
  THRESHOLDS,
  type AiModelUsage,
  type AssetHostUsage,
  type CloudMetricsPayload,
  type D1DatabaseUsage,
  type DurableObjectNamespaceUsage,
  type Env,
  type Hour5xxBucket,
  type KvNamespaceUsage,
  type R2BucketUsage,
  type WorkerScriptUsage,
  type ZoneMetrics,
} from "./types.ts";

const R2_FREE_ACTIONS = new Set([
  "DeleteObject",
  "DeleteObjects",
  "AbortMultipartUpload",
]);

const R2_CLASS_B_ACTIONS = new Set([
  "GetObject",
  "HeadObject",
  "HeadBucket",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);

export function classifyR2ActionType(actionType: string): "class_a" | "class_b" | "free" {
  const clean = String(actionType || "").trim();
  if (!clean) {
    return "class_b";
  }
  if (R2_FREE_ACTIONS.has(clean) || clean.startsWith("Delete") || clean.startsWith("Abort")) {
    return "free";
  }
  if (R2_CLASS_B_ACTIONS.has(clean) || clean.startsWith("Get") || clean.startsWith("Head")) {
    return "class_b";
  }
  return "class_a";
}

const CF_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const CF_API_BASE_URL = "https://api.cloudflare.com/client/v4";

const DEFAULT_DOMAIN_KEYS: Array<[string, string]> = [
  ["tsimon.me", "CF_ZONE_ID_1"],
  ["minkalab.net", "CF_ZONE_ID_2"],
  ["tsimon.app", "CF_ZONE_ID_3"],
  ["boliviaremote.work", "CF_ZONE_ID_4"],
];

export function formatUtcTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`
  );
}

function roundTo(val: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

async function fetchJsonSafe(
  url: string,
  headers: Record<string, string>,
  options: { method?: string; payload?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const resp = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        "User-Agent": "CloudflareNOCMonitor/2.0",
        ...headers,
      },
      body: options.payload !== undefined ? JSON.stringify(options.payload) : undefined,
      signal: controller.signal,
    });
    const text = await resp.text();
    let parsed: Record<string, any> = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = {};
      }
    }
    return { status: resp.status, body: parsed };
  } finally {
    clearTimeout(timeoutId);
  }
}

export function discoverMonitoredZones(env: Env): Array<{ defaultName: string; zoneId: string }> {
  const seenZoneIds = new Set<string>();
  const list: Array<{ defaultName: string; zoneId: string }> = [];

  for (const [defaultName, envKey] of DEFAULT_DOMAIN_KEYS) {
    const rawVal = String(env[envKey] ?? "").trim();
    if (rawVal && !rawVal.includes("ZONE_ID")) {
      seenZoneIds.add(rawVal);
      list.push({ defaultName, zoneId: rawVal });
    }
  }

  const extraKeys = Object.keys(env)
    .filter((k) => k.startsWith("CF_ZONE_ID_"))
    .sort();

  for (const key of extraKeys) {
    const val = String(env[key] ?? "").trim();
    if (val && !val.includes("ZONE_ID") && !seenZoneIds.has(val)) {
      seenZoneIds.add(val);
      list.push({ defaultName: key.toLowerCase(), zoneId: val });
    }
  }

  return list;
}

export async function resolveZoneName(
  defaultName: string,
  zoneId: string,
  headers: Record<string, string>,
  zoneNameCache: Record<string, string>,
): Promise<string> {
  if (!zoneId || zoneId.includes("ZONE_ID")) {
    return defaultName;
  }
  if (zoneNameCache[zoneId]) {
    return zoneNameCache[zoneId];
  }
  try {
    const { status, body } = await fetchJsonSafe(`${CF_API_BASE_URL}/zones/${zoneId}`, headers, {
      timeoutMs: 10_000,
    });
    if (status === 200) {
      const name = body?.result?.name;
      if (typeof name === "string" && name.trim()) {
        zoneNameCache[zoneId] = name.trim();
        return name.trim();
      }
    }
  } catch {
    // Fallback to defaultName if lookup fails
  }
  return defaultName;
}

export function hasTwoConsecutiveHoursAtOrAbove5xxThreshold(
  hourly: Hour5xxBucket[],
  threshold: number = THRESHOLDS.domain_5xx_warn,
): boolean {
  if (!Array.isArray(hourly) || hourly.length < 2) {
    return false;
  }
  const sorted = [...hourly].sort((a, b) => String(a.hour_utc || "").localeCompare(String(b.hour_utc || "")));
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i];
    const nxt = sorted[i + 1];
    if (Number(cur.errors_5xx || 0) < threshold || Number(nxt.errors_5xx || 0) < threshold) {
      continue;
    }
    const t1 = Date.parse(cur.hour_utc || "");
    const t2 = Date.parse(nxt.hour_utc || "");
    if (Number.isFinite(t1) && Number.isFinite(t2)) {
      const diffMs = t2 - t1;
      // Adjacent 1-hour buckets (allow slight clock/serialization tolerance)
      if (diffMs > 0 && diffMs <= 3700_000) {
        return true;
      }
    } else {
      // Fallback when timestamps are non-ISO labels
      return true;
    }
  }
  return false;
}

export async function fetchZoneMetrics(
  zoneId: string,
  headers: Record<string, string>,
  nowUtc: Date = new Date(),
): Promise<ZoneMetrics> {
  const zoneMetrics: ZoneMetrics = {
    status: "HEALTHY",
    bandwidth_gb: 0.0,
    hit_volume: 0,
    cache_hit_ratio: 0.0,
    security_events: 0,
    errors_5xx: 0,
    errors_5xx_prev_hour: 0,
    errors_5xx_hourly: [],
    errors_5xx_2h_consecutive_over_100: false,
  };

  if (!zoneId || zoneId.includes("ZONE_ID")) {
    zoneMetrics.status = "UNCONFIGURED";
    return zoneMetrics;
  }

  const currHourDt = new Date(
    Date.UTC(
      nowUtc.getUTCFullYear(),
      nowUtc.getUTCMonth(),
      nowUtc.getUTCDate(),
      nowUtc.getUTCHours(),
      0,
      0,
      0,
    ),
  );
  const since1hIso = new Date(currHourDt.getTime() - 1 * 3600 * 1000).toISOString().replace(".000Z", "Z");
  const since2hIso = new Date(currHourDt.getTime() - 2 * 3600 * 1000).toISOString().replace(".000Z", "Z");

  const query = `
    query GetZoneMetrics($zoneId: String!, $since: Time!) {
      viewer {
        zones(filter: { zoneTag: $zoneId }) {
          httpRequests1hGroups(limit: 3, orderBy: [datetime_ASC], filter: { datetime_geq: $since }) {
            dimensions {
              datetime
            }
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
  `;

  try {
    const { status, body } = await fetchJsonSafe(CF_GRAPHQL_URL, headers, {
      method: "POST",
      payload: {
        query,
        variables: { zoneId, since: since2hIso },
      },
      timeoutMs: 10_000,
    });

    if (status === 200) {
      const errors = body?.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const errMsg = String(errors[0]?.message ?? "GraphQL Error");
        zoneMetrics.status = `GQL Error: ${errMsg.slice(0, 40)}`;
        return zoneMetrics;
      }

      const zonesData = body?.data?.viewer?.zones;
      if (Array.isArray(zonesData) && zonesData.length > 0) {
        const httpList = zonesData[0]?.httpRequests1hGroups ?? [];
        let totalReqs = 0;
        let totalCached = 0;
        let totalBytes = 0;
        let totalThreats = 0;
        let total5xx = 0;
        let prevHour5xx = 0;
        const hourly5xx: Hour5xxBucket[] = [];

        for (const group of httpList) {
          const dtStr = String(group?.dimensions?.datetime ?? "").trim();
          const httpData = group?.sum ?? {};
          let grp5xx = 0;
          for (const statusEntry of httpData?.responseStatusMap ?? []) {
            const code = Number(statusEntry?.edgeResponseStatus ?? 0);
            if (code >= 500 && code < 600) {
              grp5xx += Number(statusEntry?.requests ?? 0);
            }
          }

          hourly5xx.push({ hour_utc: dtStr, errors_5xx: grp5xx });

          if (!dtStr || dtStr >= since1hIso) {
            totalReqs += Number(httpData?.requests ?? 0);
            totalCached += Number(httpData?.cachedRequests ?? 0);
            totalBytes += Number(httpData?.bytes ?? 0);
            totalThreats += Number(httpData?.threats ?? 0);
          }
        }

        hourly5xx.sort((a, b) => a.hour_utc.localeCompare(b.hour_utc));

        // Keep errors_5xx strictly per-hour (never sum 2 separate hours into one bucket)
        // so the >= 100/hr across a 2-hour consecutive span rule cannot false-trigger.
        if (hourly5xx.length >= 2) {
          total5xx = hourly5xx[hourly5xx.length - 1].errors_5xx;
          prevHour5xx = hourly5xx[hourly5xx.length - 2].errors_5xx;
        } else if (hourly5xx.length === 1) {
          total5xx = hourly5xx[0].errors_5xx;
          prevHour5xx = 0;
        }

        const consecutive2hOver100 = hasTwoConsecutiveHoursAtOrAbove5xxThreshold(
          hourly5xx,
          THRESHOLDS.domain_5xx_warn,
        );

        zoneMetrics.hit_volume = totalReqs;
        zoneMetrics.bandwidth_gb = roundTo(totalBytes / 1024 ** 3, 4);
        zoneMetrics.cache_hit_ratio = totalReqs > 0 ? roundTo((totalCached / totalReqs) * 100, 2) : 0.0;
        zoneMetrics.security_events = totalThreats;
        zoneMetrics.errors_5xx = total5xx;
        zoneMetrics.errors_5xx_prev_hour = prevHour5xx;
        zoneMetrics.errors_5xx_hourly = hourly5xx;
        zoneMetrics.errors_5xx_2h_consecutive_over_100 = consecutive2hOver100;
      }
    } else {
      zoneMetrics.status = `HTTP Error ${status}`;
    }
  } catch (err: any) {
    zoneMetrics.status = `API Error: ${String(err?.message ?? err).slice(0, 40)}`;
  }

  return zoneMetrics;
}

export async function fetchAccountBillingAndUsage(
  accountId: string,
  headers: Record<string, string>,
  nowUtc: Date = new Date(),
): Promise<Omit<CloudMetricsPayload, "last_updated" | "domains">> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const todayStr = `${nowUtc.getUTCFullYear()}-${pad(nowUtc.getUTCMonth() + 1)}-${pad(nowUtc.getUTCDate())}`;
  const monthStartDate = `${nowUtc.getUTCFullYear()}-${pad(nowUtc.getUTCMonth() + 1)}-01`;
  const monthStartIso = `${monthStartDate}T00:00:00Z`;

  const result: Omit<CloudMetricsPayload, "last_updated" | "domains"> = {
    billing_period: {
      month_start: monthStartDate,
      current_date_utc: todayStr,
    },
    workers_and_pages: {
      daily_requests: 0,
      daily_requests_limit: QUOTAS.workers_daily_requests_limit,
      daily_requests_pct: 0.0,
      mtd_worker_requests: 0,
      mtd_pages_requests: 0,
      mtd_subrequests: 0,
      mtd_errors: 0,
      mtd_cpu_time_ms: 0.0,
      mtd_assets_requests: 0,
      mtd_build_minutes: 0.0,
      monthly_build_minutes_limit: QUOTAS.workers_monthly_build_minutes_limit,
      monthly_build_minutes_pct: 0.0,
      estimated_billable_usd: 0.0,
      scripts: [],
      assets_hosts: [],
    },
    workers_ai: {
      daily_neurons: 0.0,
      daily_neurons_limit: QUOTAS.workers_ai_daily_neurons_limit,
      daily_neurons_pct: 0.0,
      daily_requests: 0,
      mtd_neurons: 0.0,
      mtd_billable_neurons: 0.0,
      mtd_requests: 0,
      mtd_input_tokens: 0,
      mtd_output_tokens: 0,
      mtd_inference_time_ms: 0,
      estimated_billable_usd: 0.0,
      models: [],
    },
    d1_billing: {
      daily_rows_read: 0,
      daily_rows_read_limit: QUOTAS.d1_monthly_rows_read_limit,
      daily_rows_read_pct: 0.0,
      monthly_rows_read_limit: QUOTAS.d1_monthly_rows_read_limit,
      monthly_rows_read_pct: 0.0,
      daily_rows_written: 0,
      daily_rows_written_limit: QUOTAS.d1_daily_rows_written_limit,
      daily_rows_written_pct: 0.0,
      mtd_rows_read: 0,
      mtd_rows_written: 0,
      mtd_read_queries: 0,
      mtd_write_queries: 0,
      total_storage_mb: 0.0,
      account_storage_limit_mb: QUOTAS.d1_account_storage_limit_mb,
      account_storage_pct: 0.0,
      estimated_billable_usd: 0.0,
    },
    d1_databases: [],
    durable_objects: {
      daily_requests: 0,
      daily_requests_limit: QUOTAS.do_daily_requests_limit,
      daily_requests_pct: 0.0,
      daily_duration_gbs: 0.0,
      daily_duration_gbs_limit: QUOTAS.do_daily_duration_gbs_limit,
      daily_duration_gbs_pct: 0.0,
      daily_rows_read: 0,
      daily_rows_read_limit: QUOTAS.do_monthly_rows_read_limit,
      daily_rows_read_pct: 0.0,
      monthly_rows_read_limit: QUOTAS.do_monthly_rows_read_limit,
      monthly_rows_read_pct: 0.0,
      daily_rows_written: 0,
      daily_rows_written_limit: QUOTAS.do_daily_rows_written_limit,
      daily_rows_written_pct: 0.0,
      mtd_requests: 0,
      mtd_errors: 0,
      mtd_duration_gbs: 0.0,
      mtd_active_time_sec: 0.0,
      mtd_cpu_time_ms: 0.0,
      mtd_rows_read: 0,
      mtd_rows_written: 0,
      mtd_subrequests: 0,
      mtd_ws_messages: 0,
      total_storage_mb: 0.0,
      storage_limit_mb: QUOTAS.do_storage_limit_mb,
      storage_pct: 0.0,
      estimated_billable_usd: 0.0,
      namespaces: [],
    },
    kv_billing: {
      daily_reads: 0,
      daily_reads_limit: QUOTAS.kv_daily_reads_limit,
      daily_reads_pct: 0.0,
      daily_writes: 0,
      daily_writes_limit: QUOTAS.kv_daily_writes_limit,
      daily_writes_pct: 0.0,
      daily_deletes: 0,
      daily_deletes_limit: QUOTAS.kv_daily_deletes_limit,
      daily_deletes_pct: 0.0,
      daily_lists: 0,
      daily_lists_limit: QUOTAS.kv_daily_lists_limit,
      daily_lists_pct: 0.0,
      mtd_reads: 0,
      mtd_writes: 0,
      mtd_deletes: 0,
      mtd_lists: 0,
      mtd_object_bytes_mb: 0.0,
      total_keys: 0,
      total_storage_mb: 0.0,
      storage_limit_mb: QUOTAS.kv_storage_limit_mb,
      storage_pct: 0.0,
      estimated_billable_usd: 0.0,
      namespaces: [],
    },
    r2_billing: {
      daily_class_a_ops: 0,
      daily_class_b_ops: 0,
      mtd_class_a_ops: 0,
      monthly_class_a_limit: QUOTAS.r2_monthly_class_a_limit,
      monthly_class_a_pct: 0.0,
      mtd_class_b_ops: 0,
      monthly_class_b_limit: QUOTAS.r2_monthly_class_b_limit,
      monthly_class_b_pct: 0.0,
      mtd_free_ops: 0,
      mtd_egress_mb: 0.0,
      total_objects: 0,
      total_storage_mb: 0.0,
      storage_limit_mb: QUOTAS.r2_storage_limit_mb,
      storage_pct: 0.0,
      estimated_billable_usd: 0.0,
      buckets: [],
    },
  };

  if (!accountId || accountId.includes("YOUR_CF")) {
    return result;
  }

  const knownScripts: Record<string, WorkerScriptUsage> = {};
  const doNamespacesMap: Record<
    string,
    DurableObjectNamespaceUsage & { _latestStorageDate?: string; _latestStorageBytes?: number }
  > = {};
  const kvNamespacesMap: Record<
    string,
    KvNamespaceUsage & { _latestStorageDate?: string; _latestStorageBytes?: number }
  > = {};
  const r2BucketsMap: Record<
    string,
    R2BucketUsage & { _latestStorageDate?: string; _latestPayloadBytes?: number; _latestMetadataBytes?: number }
  > = {};

  const gqlQuery = `
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
          durableObjectsInvocationsAdaptiveGroups(limit: 5000, filter: { date_geq: $sinceDate }) {
            dimensions {
              scriptName
              name
              namespaceId
              date
            }
            sum {
              requests
              errors
              wallTime
              responseBodySize
            }
          }
          durableObjectsPeriodicGroups(limit: 5000, filter: { date_geq: $sinceDate }) {
            dimensions {
              name
              namespaceId
              date
            }
            sum {
              activeTime
              cpuTime
              duration
              rowsRead
              rowsWritten
              subrequests
              inboundWebsocketMsgCount
              outboundWebsocketMsgCount
            }
          }
          durableObjectsSqlStorageGroups(limit: 5000, filter: { date_geq: $sinceDate }) {
            dimensions {
              namespaceId
              date
            }
            max {
              storedBytes
            }
          }
          durableObjectsStorageGroups(limit: 5000, filter: { date_geq: $sinceDate }) {
            dimensions {
              namespaceIds
              date
            }
            max {
              storedBytes
            }
          }
          kvOperationsAdaptiveGroups(limit: 5000, filter: { date_geq: $sinceDate }) {
            dimensions {
              actionType
              namespaceId
              date
            }
            sum {
              requests
              objectBytes
            }
          }
          kvStorageAdaptiveGroups(limit: 5000, filter: { date_geq: $sinceDate }) {
            dimensions {
              namespaceId
              date
            }
            max {
              byteCount
              keyCount
            }
          }
          r2OperationsAdaptiveGroups(limit: 5000, filter: { date_geq: $sinceDate }) {
            dimensions {
              actionType
              bucketName
              date
            }
            sum {
              requests
              responseBytes
            }
          }
          r2StorageAdaptiveGroups(limit: 5000, filter: { date_geq: $sinceDate }) {
            dimensions {
              bucketName
              date
            }
            max {
              payloadSize
              metadataSize
              objectCount
              uploadCount
            }
          }
        }
      }
    }
  `;

  // Execute REST inventory lookups and GraphQL analytics query concurrently
  const [workersRest, pagesRest, gqlResp, d1Rest, doRest, kvRest, r2Rest] = await Promise.allSettled([
    fetchJsonSafe(`${CF_API_BASE_URL}/accounts/${accountId}/workers/scripts`, headers, { timeoutMs: 10_000 }),
    fetchJsonSafe(`${CF_API_BASE_URL}/accounts/${accountId}/pages/projects`, headers, { timeoutMs: 10_000 }),
    fetchJsonSafe(CF_GRAPHQL_URL, headers, {
      method: "POST",
      payload: {
        query: gqlQuery,
        variables: {
          accountId,
          sinceDate: monthStartDate,
          sinceIso: monthStartIso,
        },
      },
      timeoutMs: 15_000,
    }),
    fetchJsonSafe(`${CF_API_BASE_URL}/accounts/${accountId}/d1/database`, headers, { timeoutMs: 10_000 }),
    fetchJsonSafe(`${CF_API_BASE_URL}/accounts/${accountId}/workers/durable_objects/namespaces`, headers, {
      timeoutMs: 10_000,
    }),
    fetchJsonSafe(`${CF_API_BASE_URL}/accounts/${accountId}/storage/kv/namespaces?per_page=100`, headers, {
      timeoutMs: 10_000,
    }),
    fetchJsonSafe(`${CF_API_BASE_URL}/accounts/${accountId}/r2/buckets`, headers, {
      timeoutMs: 10_000,
    }),
  ]);

  const ensureDoNamespace = (
    nsId: string,
    opts: { name?: string; scriptName?: string; className?: string; useSqlite?: boolean } = {},
  ) => {
    const key = nsId || opts.name || "default";
    if (!doNamespacesMap[key]) {
      const className = opts.className || opts.name || "";
      const scriptName = opts.scriptName || "";
      const displayName =
        className && scriptName
          ? `${className} (${scriptName})`
          : className || scriptName || opts.name || key;
      doNamespacesMap[key] = {
        namespace_id: key,
        name: displayName,
        script_name: scriptName,
        class_name: className,
        use_sqlite: Boolean(opts.useSqlite),
        requests_today: 0,
        requests_mtd: 0,
        errors_mtd: 0,
        duration_gbs_today: 0.0,
        duration_gbs_mtd: 0.0,
        rows_read_today: 0,
        rows_written_today: 0,
        rows_read_mtd: 0,
        rows_written_mtd: 0,
        ws_inbound_mtd: 0,
        ws_outbound_mtd: 0,
        subrequests_mtd: 0,
        storage_mb: 0.0,
        _latestStorageDate: "",
        _latestStorageBytes: 0,
      };
    } else {
      const existing = doNamespacesMap[key];
      if (opts.scriptName && !existing.script_name) {
        existing.script_name = opts.scriptName;
      }
      if (opts.className && !existing.class_name) {
        existing.class_name = opts.className;
      }
      if (opts.name && !existing.class_name) {
        existing.class_name = opts.name;
      }
      if (opts.useSqlite) {
        existing.use_sqlite = true;
      }
      if (existing.class_name && existing.script_name) {
        existing.name = `${existing.class_name} (${existing.script_name})`;
      } else if (existing.class_name || existing.script_name) {
        existing.name = existing.class_name || existing.script_name;
      }
    }
    return doNamespacesMap[key];
  };

  const ensureKvNamespace = (nsId: string, title?: string) => {
    const key = nsId || "default";
    if (!kvNamespacesMap[key]) {
      kvNamespacesMap[key] = {
        namespace_id: key,
        title: title || key,
        reads_today: 0,
        writes_today: 0,
        deletes_today: 0,
        lists_today: 0,
        reads_mtd: 0,
        writes_mtd: 0,
        deletes_mtd: 0,
        lists_mtd: 0,
        key_count: 0,
        storage_mb: 0.0,
        _latestStorageDate: "",
        _latestStorageBytes: 0,
      };
    } else if (title && kvNamespacesMap[key].title === key) {
      kvNamespacesMap[key].title = title;
    }
    return kvNamespacesMap[key];
  };

  const ensureR2Bucket = (bucketName: string) => {
    const key = bucketName || "default";
    if (!r2BucketsMap[key]) {
      r2BucketsMap[key] = {
        name: key,
        class_a_ops_today: 0,
        class_b_ops_today: 0,
        class_a_ops_mtd: 0,
        class_b_ops_mtd: 0,
        free_ops_mtd: 0,
        egress_mb_mtd: 0.0,
        object_count: 0,
        upload_count: 0,
        payload_size_mb: 0.0,
        metadata_size_mb: 0.0,
        _latestStorageDate: "",
        _latestPayloadBytes: 0,
        _latestMetadataBytes: 0,
      };
    }
    return r2BucketsMap[key];
  };

  if (doRest.status === "fulfilled" && doRest.value.status === 200) {
    for (const ns of doRest.value.body?.result ?? []) {
      const nsId = String(ns?.id ?? "").trim();
      if (nsId) {
        ensureDoNamespace(nsId, {
          name: String(ns?.name ?? "").trim(),
          scriptName: String(ns?.script ?? "").trim(),
          className: String(ns?.class ?? "").trim(),
          useSqlite: Boolean(ns?.use_sqlite),
        });
      }
    }
  }

  if (kvRest.status === "fulfilled" && kvRest.value.status === 200) {
    for (const ns of kvRest.value.body?.result ?? []) {
      const nsId = String(ns?.id ?? "").trim();
      const title = String(ns?.title ?? "").trim();
      if (nsId) {
        ensureKvNamespace(nsId, title || nsId);
      }
    }
  }

  if (r2Rest.status === "fulfilled" && r2Rest.value.status === 200) {
    const rawResult = r2Rest.value.body?.result;
    const bucketList = Array.isArray(rawResult?.buckets)
      ? rawResult.buckets
      : Array.isArray(rawResult)
        ? rawResult
        : [];
    for (const b of bucketList) {
      const bname = String(b?.name ?? "").trim();
      if (bname) {
        ensureR2Bucket(bname);
      }
    }
  }

  if (workersRest.status === "fulfilled" && workersRest.value.status === 200) {
    for (const s of workersRest.value.body?.result ?? []) {
      const sname = String(s?.id ?? "").trim();
      if (sname) {
        knownScripts[sname] = {
          name: sname,
          type: "Worker",
          requests_today: 0,
          requests_mtd: 0,
          subrequests_mtd: 0,
          errors_mtd: 0,
          cpu_time_ms_mtd: 0.0,
        };
      }
    }
  }

  if (pagesRest.status === "fulfilled" && pagesRest.value.status === 200) {
    for (const p of pagesRest.value.body?.result ?? []) {
      const pname = String(p?.name ?? "").trim();
      if (pname && !knownScripts[pname]) {
        knownScripts[pname] = {
          name: pname,
          type: "Pages",
          requests_today: 0,
          requests_mtd: 0,
          subrequests_mtd: 0,
          errors_mtd: 0,
          cpu_time_ms_mtd: 0.0,
        };
      }
    }
  }

  const d1StatsById: Record<
    string,
    {
      rows_read_mtd: number;
      rows_written_mtd: number;
      rows_read_today: number;
      rows_written_today: number;
      read_queries_mtd: number;
      write_queries_mtd: number;
    }
  > = {};

  if (gqlResp.status === "fulfilled" && gqlResp.value.status === 200) {
    const accounts = gqlResp.value.body?.data?.viewer?.accounts ?? [];
    if (Array.isArray(accounts) && accounts.length > 0) {
      const acct = accounts[0];
      const wp = result.workers_and_pages;

      // A. Workers Invocations
      for (const row of acct?.workersInvocationsAdaptive ?? []) {
        const dims = row?.dimensions ?? {};
        const sums = row?.sum ?? {};
        const sname = String(dims?.scriptName || "unknown");
        const rDate = String(dims?.date || "");
        const reqs = Number(sums?.requests ?? 0);
        const subreqs = Number(sums?.subrequests ?? 0);
        const errs = Number(sums?.errors ?? 0);
        const cpuUs = Number(sums?.cpuTimeUs ?? 0);

        wp.mtd_worker_requests += reqs;
        wp.mtd_subrequests += subreqs;
        wp.mtd_errors += errs;
        wp.mtd_cpu_time_ms += cpuUs / 1000.0;
        if (rDate === todayStr) {
          wp.daily_requests += reqs;
        }

        if (!knownScripts[sname]) {
          knownScripts[sname] = {
            name: sname,
            type: "Worker",
            requests_today: 0,
            requests_mtd: 0,
            subrequests_mtd: 0,
            errors_mtd: 0,
            cpu_time_ms_mtd: 0.0,
          };
        }
        const entry = knownScripts[sname];
        entry.requests_mtd += reqs;
        entry.subrequests_mtd += subreqs;
        entry.errors_mtd += errs;
        entry.cpu_time_ms_mtd = roundTo(entry.cpu_time_ms_mtd + cpuUs / 1000.0, 2);
        if (rDate === todayStr) {
          entry.requests_today += reqs;
        }
      }

      // B. Pages Functions Invocations
      for (const row of acct?.pagesFunctionsInvocationsAdaptiveGroups ?? []) {
        const dims = row?.dimensions ?? {};
        const sums = row?.sum ?? {};
        const sname = String(dims?.scriptName || "pages-function");
        const rDate = String(dims?.date || "");
        const reqs = Number(sums?.requests ?? 0);
        const subreqs = Number(sums?.subrequests ?? 0);
        const errs = Number(sums?.errors ?? 0);

        wp.mtd_pages_requests += reqs;
        wp.mtd_subrequests += subreqs;
        wp.mtd_errors += errs;
        if (rDate === todayStr) {
          wp.daily_requests += reqs;
        }

        if (!knownScripts[sname]) {
          knownScripts[sname] = {
            name: sname,
            type: "Pages Function",
            requests_today: 0,
            requests_mtd: 0,
            subrequests_mtd: 0,
            errors_mtd: 0,
            cpu_time_ms_mtd: 0.0,
          };
        }
        const entry = knownScripts[sname];
        entry.requests_mtd += reqs;
        entry.subrequests_mtd += subreqs;
        entry.errors_mtd += errs;
        if (rDate === todayStr) {
          entry.requests_today += reqs;
        }
      }

      // C. Static Assets Requests
      const assetsByHost: Record<string, AssetHostUsage> = {};
      for (const row of acct?.workersAssetsRequestsAdaptiveGroups ?? []) {
        const dims = row?.dimensions ?? {};
        const sums = row?.sum ?? {};
        const host = String(dims?.hostname || "unknown");
        const rDate = String(dims?.date || "");
        const reqs = Number(sums?.requests ?? 0);

        wp.mtd_assets_requests += reqs;
        if (!assetsByHost[host]) {
          assetsByHost[host] = { hostname: host, requests_today: 0, requests_mtd: 0 };
        }
        assetsByHost[host].requests_mtd += reqs;
        if (rDate === todayStr) {
          assetsByHost[host].requests_today += reqs;
        }
      }

      wp.assets_hosts = Object.values(assetsByHost).sort((a, b) => b.requests_mtd - a.requests_mtd);

      // D. Workers Builds Minutes
      let buildMins = 0.0;
      for (const row of acct?.workersBuildsBuildMinutesAdaptiveGroups ?? []) {
        buildMins += Number(row?.sum?.buildMinutes ?? 0.0);
      }
      wp.mtd_build_minutes = roundTo(buildMins, 2);
      wp.monthly_build_minutes_pct = roundTo(
        (buildMins / QUOTAS.workers_monthly_build_minutes_limit) * 100,
        2,
      );

      wp.mtd_cpu_time_ms = roundTo(wp.mtd_cpu_time_ms, 2);
      wp.daily_requests_pct = roundTo(
        (wp.daily_requests / QUOTAS.workers_daily_requests_limit) * 100,
        2,
      );
      wp.scripts = Object.values(knownScripts).sort((a, b) =>
        b.requests_mtd !== a.requests_mtd ? b.requests_mtd - a.requests_mtd : a.name.localeCompare(b.name),
      );

      // E. Workers AI
      const ai = result.workers_ai;
      const modelsMap: Record<string, AiModelUsage> = {};
      const neuronsByDate: Record<string, number> = {};

      for (const row of acct?.aiInferenceAdaptiveGroups ?? []) {
        const dims = row?.dimensions ?? {};
        const sums = row?.sum ?? {};
        const modelId = String(dims?.modelId || "unknown");
        const rDate = String(dims?.date || "");
        const cnt = Number(row?.count ?? 0);
        const neurons = Number(sums?.totalNeurons ?? 0.0);
        const inTok = Number(sums?.totalInputTokens ?? 0);
        const outTok = Number(sums?.totalOutputTokens ?? 0);
        const infMs = Number(sums?.totalInferenceTimeMs ?? 0);

        ai.mtd_requests += cnt;
        ai.mtd_neurons += neurons;
        ai.mtd_input_tokens += inTok;
        ai.mtd_output_tokens += outTok;
        ai.mtd_inference_time_ms += infMs;
        neuronsByDate[rDate] = (neuronsByDate[rDate] ?? 0.0) + neurons;

        if (rDate === todayStr) {
          ai.daily_neurons += neurons;
          ai.daily_requests += cnt;
        }

        if (!modelsMap[modelId]) {
          modelsMap[modelId] = {
            model_id: modelId,
            requests_mtd: 0,
            requests_today: 0,
            neurons_mtd: 0.0,
            input_tokens_mtd: 0,
            output_tokens_mtd: 0,
            inference_time_ms_mtd: 0,
          };
        }
        const mEntry = modelsMap[modelId];
        mEntry.requests_mtd += cnt;
        mEntry.neurons_mtd = roundTo(mEntry.neurons_mtd + neurons, 2);
        mEntry.input_tokens_mtd += inTok;
        mEntry.output_tokens_mtd += outTok;
        mEntry.inference_time_ms_mtd += infMs;
        if (rDate === todayStr) {
          mEntry.requests_today += cnt;
        }
      }

      const billableNeurons = Object.values(neuronsByDate).reduce(
        (acc, dayTotal) => acc + Math.max(0.0, dayTotal - QUOTAS.workers_ai_daily_neurons_limit),
        0.0,
      );
      ai.daily_neurons = roundTo(ai.daily_neurons, 2);
      ai.daily_neurons_pct = roundTo(
        (ai.daily_neurons / QUOTAS.workers_ai_daily_neurons_limit) * 100,
        2,
      );
      ai.mtd_neurons = roundTo(ai.mtd_neurons, 2);
      ai.mtd_billable_neurons = roundTo(billableNeurons, 2);
      ai.estimated_billable_usd = roundTo(
        (billableNeurons / 1000.0) * QUOTAS.workers_ai_cost_per_1k_neurons_usd,
        4,
      );
      ai.models = Object.values(modelsMap).sort((a, b) => b.neurons_mtd - a.neurons_mtd);

      // F. D1 Analytics
      const d1b = result.d1_billing;
      for (const row of acct?.d1AnalyticsAdaptiveGroups ?? []) {
        const dims = row?.dimensions ?? {};
        const sums = row?.sum ?? {};
        const dbId = String(dims?.databaseId || "");
        const rDate = String(dims?.date || "");
        const rRead = Number(sums?.rowsRead ?? 0);
        const rWritten = Number(sums?.rowsWritten ?? 0);
        const qRead = Number(sums?.readQueries ?? 0);
        const qWrite = Number(sums?.writeQueries ?? 0);

        d1b.mtd_rows_read += rRead;
        d1b.mtd_rows_written += rWritten;
        d1b.mtd_read_queries += qRead;
        d1b.mtd_write_queries += qWrite;

        if (rDate === todayStr) {
          d1b.daily_rows_read += rRead;
          d1b.daily_rows_written += rWritten;
        }

        if (dbId) {
          if (!d1StatsById[dbId]) {
            d1StatsById[dbId] = {
              rows_read_mtd: 0,
              rows_written_mtd: 0,
              rows_read_today: 0,
              rows_written_today: 0,
              read_queries_mtd: 0,
              write_queries_mtd: 0,
            };
          }
          const stEntry = d1StatsById[dbId];
          stEntry.rows_read_mtd += rRead;
          stEntry.rows_written_mtd += rWritten;
          stEntry.read_queries_mtd += qRead;
          stEntry.write_queries_mtd += qWrite;
          if (rDate === todayStr) {
            stEntry.rows_read_today += rRead;
            stEntry.rows_written_today += rWritten;
          }
        }
      }

      d1b.monthly_rows_read_limit = QUOTAS.d1_monthly_rows_read_limit;
      d1b.monthly_rows_read_pct = roundTo(
        (d1b.mtd_rows_read / QUOTAS.d1_monthly_rows_read_limit) * 100,
        4,
      );
      d1b.daily_rows_read_limit = QUOTAS.d1_monthly_rows_read_limit;
      d1b.daily_rows_read_pct = d1b.monthly_rows_read_pct;
      d1b.daily_rows_written_pct = roundTo(
        (d1b.daily_rows_written / QUOTAS.d1_daily_rows_written_limit) * 100,
        2,
      );

      // G. Durable Objects Analytics (Invocations, Periodic & Storage)
      const doUsage = result.durable_objects;
      for (const row of acct?.durableObjectsInvocationsAdaptiveGroups ?? []) {
        const dims = row?.dimensions ?? {};
        const sums = row?.sum ?? {};
        const nsId = String(dims?.namespaceId || "").trim();
        const scriptName = String(dims?.scriptName || "").trim();
        const doName = String(dims?.name || "").trim();
        const rDate = String(dims?.date || "");
        const reqs = Number(sums?.requests ?? 0);
        const errs = Number(sums?.errors ?? 0);

        doUsage.mtd_requests += reqs;
        doUsage.mtd_errors += errs;
        if (rDate === todayStr) {
          doUsage.daily_requests += reqs;
        }

        const nsEntry = ensureDoNamespace(nsId, {
          name: doName,
          scriptName,
        });
        nsEntry.requests_mtd += reqs;
        nsEntry.errors_mtd += errs;
        if (rDate === todayStr) {
          nsEntry.requests_today += reqs;
        }
      }

      for (const row of acct?.durableObjectsPeriodicGroups ?? []) {
        const dims = row?.dimensions ?? {};
        const sums = row?.sum ?? {};
        const nsId = String(dims?.namespaceId || "").trim();
        const doName = String(dims?.name || "").trim();
        const rDate = String(dims?.date || "");
        const activeUs = Number(sums?.activeTime ?? 0);
        const cpuUs = Number(sums?.cpuTime ?? 0);
        const durationGbs = Number(sums?.duration ?? 0.0);
        const rRead = Number(sums?.rowsRead ?? 0);
        const rWritten = Number(sums?.rowsWritten ?? 0);
        const subreqs = Number(sums?.subrequests ?? 0);
        const wsIn = Number(sums?.inboundWebsocketMsgCount ?? 0);
        const wsOut = Number(sums?.outboundWebsocketMsgCount ?? 0);

        doUsage.mtd_active_time_sec += activeUs / 1_000_000.0;
        doUsage.mtd_cpu_time_ms += cpuUs / 1000.0;
        doUsage.mtd_duration_gbs += durationGbs;
        doUsage.mtd_rows_read += rRead;
        doUsage.mtd_rows_written += rWritten;
        doUsage.mtd_subrequests += subreqs;
        doUsage.mtd_ws_messages += wsIn + wsOut;

        if (rDate === todayStr) {
          doUsage.daily_duration_gbs += durationGbs;
          doUsage.daily_rows_read += rRead;
          doUsage.daily_rows_written += rWritten;
        }

        const nsEntry = ensureDoNamespace(nsId, {
          name: doName,
          useSqlite: rRead > 0 || rWritten > 0,
        });
        nsEntry.duration_gbs_mtd = roundTo(nsEntry.duration_gbs_mtd + durationGbs, 2);
        nsEntry.rows_read_mtd += rRead;
        nsEntry.rows_written_mtd += rWritten;
        nsEntry.subrequests_mtd += subreqs;
        nsEntry.ws_inbound_mtd += wsIn;
        nsEntry.ws_outbound_mtd += wsOut;
        if (rDate === todayStr) {
          nsEntry.duration_gbs_today = roundTo(nsEntry.duration_gbs_today + durationGbs, 2);
          nsEntry.rows_read_today += rRead;
          nsEntry.rows_written_today += rWritten;
        }
      }

      for (const row of acct?.durableObjectsSqlStorageGroups ?? []) {
        const dims = row?.dimensions ?? {};
        const maxVals = row?.max ?? {};
        const nsId = String(dims?.namespaceId || "").trim();
        const rDate = String(dims?.date || "");
        const storedBytes = Number(maxVals?.storedBytes ?? 0);
        if (!nsId) continue;

        const nsEntry = ensureDoNamespace(nsId, { useSqlite: true });
        const prevDate = nsEntry._latestStorageDate || "";
        if (!prevDate || rDate > prevDate) {
          nsEntry._latestStorageDate = rDate;
          nsEntry._latestStorageBytes = storedBytes;
        } else if (rDate === prevDate) {
          nsEntry._latestStorageBytes = Math.max(nsEntry._latestStorageBytes || 0, storedBytes);
        }
      }

      for (const row of acct?.durableObjectsStorageGroups ?? []) {
        const dims = row?.dimensions ?? {};
        const maxVals = row?.max ?? {};
        const nsIds = Array.isArray(dims?.namespaceIds) ? dims.namespaceIds : [];
        const nsId = String(nsIds[0] || dims?.namespaceId || "").trim();
        const rDate = String(dims?.date || "");
        const storedBytes = Number(maxVals?.storedBytes ?? 0);
        if (!nsId) continue;

        const nsEntry = ensureDoNamespace(nsId);
        const prevDate = nsEntry._latestStorageDate || "";
        if (!prevDate || rDate > prevDate) {
          nsEntry._latestStorageDate = rDate;
          nsEntry._latestStorageBytes = Math.max(nsEntry._latestStorageBytes || 0, storedBytes);
        } else if (rDate === prevDate) {
          nsEntry._latestStorageBytes = Math.max(nsEntry._latestStorageBytes || 0, storedBytes);
        }
      }

      let totalDoStorageBytes = 0;
      const doNamespacesList: DurableObjectNamespaceUsage[] = [];
      for (const rawNs of Object.values(doNamespacesMap)) {
        const bytes = Number(rawNs._latestStorageBytes || 0);
        totalDoStorageBytes += bytes;
        const { _latestStorageDate: _d, _latestStorageBytes: _b, ...cleanNs } = rawNs;
        cleanNs.storage_mb = roundTo(bytes / (1024 * 1024), 3);
        doNamespacesList.push(cleanNs);
      }

      doUsage.daily_duration_gbs = roundTo(doUsage.daily_duration_gbs, 2);
      doUsage.mtd_duration_gbs = roundTo(doUsage.mtd_duration_gbs, 2);
      doUsage.mtd_active_time_sec = roundTo(doUsage.mtd_active_time_sec, 2);
      doUsage.mtd_cpu_time_ms = roundTo(doUsage.mtd_cpu_time_ms, 2);
      doUsage.daily_requests_pct = roundTo(
        (doUsage.daily_requests / QUOTAS.do_daily_requests_limit) * 100,
        2,
      );
      doUsage.daily_duration_gbs_pct = roundTo(
        (doUsage.daily_duration_gbs / QUOTAS.do_daily_duration_gbs_limit) * 100,
        2,
      );
      doUsage.monthly_rows_read_limit = QUOTAS.do_monthly_rows_read_limit;
      doUsage.monthly_rows_read_pct = roundTo(
        (doUsage.mtd_rows_read / QUOTAS.do_monthly_rows_read_limit) * 100,
        4,
      );
      doUsage.daily_rows_read_limit = QUOTAS.do_monthly_rows_read_limit;
      doUsage.daily_rows_read_pct = doUsage.monthly_rows_read_pct;
      doUsage.daily_rows_written_pct = roundTo(
        (doUsage.daily_rows_written / QUOTAS.do_daily_rows_written_limit) * 100,
        2,
      );
      doUsage.total_storage_mb = roundTo(totalDoStorageBytes / (1024 * 1024), 3);
      doUsage.storage_pct = roundTo(
        (doUsage.total_storage_mb / QUOTAS.do_storage_limit_mb) * 100,
        3,
      );
      doUsage.namespaces = doNamespacesList.sort((a, b) =>
        b.requests_mtd !== a.requests_mtd ? b.requests_mtd - a.requests_mtd : a.name.localeCompare(b.name),
      );

      // H. Workers KV Analytics (Operations & Storage)
      const kvb = result.kv_billing;
      let totalKvObjectBytesMtd = 0;

      for (const row of acct?.kvOperationsAdaptiveGroups ?? []) {
        const dims = row?.dimensions ?? {};
        const sums = row?.sum ?? {};
        const actionType = String(dims?.actionType || "").trim().toLowerCase();
        const nsId = String(dims?.namespaceId || "").trim();
        const rDate = String(dims?.date || "");
        const reqs = Number(sums?.requests ?? 0);
        const objBytes = Number(sums?.objectBytes ?? 0);

        totalKvObjectBytesMtd += objBytes;
        const nsEntry = ensureKvNamespace(nsId);

        if (actionType.includes("write") || actionType === "put") {
          kvb.mtd_writes += reqs;
          nsEntry.writes_mtd += reqs;
          if (rDate === todayStr) {
            kvb.daily_writes += reqs;
            nsEntry.writes_today += reqs;
          }
        } else if (actionType.includes("delete")) {
          kvb.mtd_deletes += reqs;
          nsEntry.deletes_mtd += reqs;
          if (rDate === todayStr) {
            kvb.daily_deletes += reqs;
            nsEntry.deletes_today += reqs;
          }
        } else if (actionType.includes("list")) {
          kvb.mtd_lists += reqs;
          nsEntry.lists_mtd += reqs;
          if (rDate === todayStr) {
            kvb.daily_lists += reqs;
            nsEntry.lists_today += reqs;
          }
        } else {
          kvb.mtd_reads += reqs;
          nsEntry.reads_mtd += reqs;
          if (rDate === todayStr) {
            kvb.daily_reads += reqs;
            nsEntry.reads_today += reqs;
          }
        }
      }

      for (const row of acct?.kvStorageAdaptiveGroups ?? []) {
        const dims = row?.dimensions ?? {};
        const maxVals = row?.max ?? {};
        const nsId = String(dims?.namespaceId || "").trim();
        const rDate = String(dims?.date || "");
        const byteCount = Number(maxVals?.byteCount ?? 0);
        const keyCount = Number(maxVals?.keyCount ?? 0);
        if (!nsId) continue;

        const nsEntry = ensureKvNamespace(nsId);
        const prevDate = nsEntry._latestStorageDate || "";
        if (!prevDate || rDate > prevDate) {
          nsEntry._latestStorageDate = rDate;
          nsEntry._latestStorageBytes = byteCount;
          nsEntry.key_count = keyCount;
        } else if (rDate === prevDate) {
          nsEntry._latestStorageBytes = Math.max(nsEntry._latestStorageBytes || 0, byteCount);
          nsEntry.key_count = Math.max(nsEntry.key_count || 0, keyCount);
        }
      }

      let totalKvStorageBytes = 0;
      let totalKvKeys = 0;
      const kvNamespacesList: KvNamespaceUsage[] = [];
      for (const rawKv of Object.values(kvNamespacesMap)) {
        const bytes = Number(rawKv._latestStorageBytes || 0);
        totalKvStorageBytes += bytes;
        totalKvKeys += Number(rawKv.key_count || 0);
        const { _latestStorageDate: _d, _latestStorageBytes: _b, ...cleanKv } = rawKv;
        cleanKv.storage_mb = roundTo(bytes / (1024 * 1024), 3);
        kvNamespacesList.push(cleanKv);
      }

      kvb.mtd_object_bytes_mb = roundTo(totalKvObjectBytesMtd / (1024 * 1024), 2);
      kvb.total_keys = totalKvKeys;
      kvb.total_storage_mb = roundTo(totalKvStorageBytes / (1024 * 1024), 3);
      kvb.storage_pct = roundTo((kvb.total_storage_mb / QUOTAS.kv_storage_limit_mb) * 100, 2);
      kvb.daily_reads_pct = roundTo((kvb.daily_reads / QUOTAS.kv_daily_reads_limit) * 100, 2);
      kvb.daily_writes_pct = roundTo((kvb.daily_writes / QUOTAS.kv_daily_writes_limit) * 100, 2);
      kvb.daily_deletes_pct = roundTo((kvb.daily_deletes / QUOTAS.kv_daily_deletes_limit) * 100, 2);
      kvb.daily_lists_pct = roundTo((kvb.daily_lists / QUOTAS.kv_daily_lists_limit) * 100, 2);
      kvb.namespaces = kvNamespacesList.sort((a, b) => {
        const aOps = a.reads_mtd + a.writes_mtd + a.deletes_mtd + a.lists_mtd;
        const bOps = b.reads_mtd + b.writes_mtd + b.deletes_mtd + b.lists_mtd;
        return bOps !== aOps ? bOps - aOps : a.title.localeCompare(b.title);
      });

      // I. R2 Object Storage Analytics (Operations & Storage)
      const r2b = result.r2_billing;
      let totalR2EgressBytesMtd = 0;

      for (const row of acct?.r2OperationsAdaptiveGroups ?? []) {
        const dims = row?.dimensions ?? {};
        const sums = row?.sum ?? {};
        const actionType = String(dims?.actionType || "").trim();
        const bucketName = String(dims?.bucketName || "account-level").trim() || "account-level";
        const rDate = String(dims?.date || "");
        const reqs = Number(sums?.requests ?? 0);
        const respBytes = Number(sums?.responseBytes ?? 0);

        totalR2EgressBytesMtd += respBytes;
        const bucketEntry = ensureR2Bucket(bucketName);
        bucketEntry.egress_mb_mtd = roundTo(bucketEntry.egress_mb_mtd + respBytes / (1024 * 1024), 2);

        const opClass = classifyR2ActionType(actionType);
        if (opClass === "class_a") {
          r2b.mtd_class_a_ops += reqs;
          bucketEntry.class_a_ops_mtd += reqs;
          if (rDate === todayStr) {
            r2b.daily_class_a_ops += reqs;
            bucketEntry.class_a_ops_today += reqs;
          }
        } else if (opClass === "class_b") {
          r2b.mtd_class_b_ops += reqs;
          bucketEntry.class_b_ops_mtd += reqs;
          if (rDate === todayStr) {
            r2b.daily_class_b_ops += reqs;
            bucketEntry.class_b_ops_today += reqs;
          }
        } else {
          r2b.mtd_free_ops += reqs;
          bucketEntry.free_ops_mtd += reqs;
        }
      }

      for (const row of acct?.r2StorageAdaptiveGroups ?? []) {
        const dims = row?.dimensions ?? {};
        const maxVals = row?.max ?? {};
        const bucketName = String(dims?.bucketName || "").trim();
        const rDate = String(dims?.date || "");
        const payloadBytes = Number(maxVals?.payloadSize ?? 0);
        const metadataBytes = Number(maxVals?.metadataSize ?? 0);
        const objCount = Number(maxVals?.objectCount ?? 0);
        const upCount = Number(maxVals?.uploadCount ?? 0);
        if (!bucketName) continue;

        const bucketEntry = ensureR2Bucket(bucketName);
        const prevDate = bucketEntry._latestStorageDate || "";
        if (!prevDate || rDate > prevDate) {
          bucketEntry._latestStorageDate = rDate;
          bucketEntry._latestPayloadBytes = payloadBytes;
          bucketEntry._latestMetadataBytes = metadataBytes;
          bucketEntry.object_count = objCount;
          bucketEntry.upload_count = upCount;
        } else if (rDate === prevDate) {
          bucketEntry._latestPayloadBytes = Math.max(bucketEntry._latestPayloadBytes || 0, payloadBytes);
          bucketEntry._latestMetadataBytes = Math.max(bucketEntry._latestMetadataBytes || 0, metadataBytes);
          bucketEntry.object_count = Math.max(bucketEntry.object_count || 0, objCount);
          bucketEntry.upload_count = Math.max(bucketEntry.upload_count || 0, upCount);
        }
      }

      let totalR2StorageBytes = 0;
      let totalR2Objects = 0;
      const r2BucketsList: R2BucketUsage[] = [];
      for (const rawB of Object.values(r2BucketsMap)) {
        const pBytes = Number(rawB._latestPayloadBytes || 0);
        const mBytes = Number(rawB._latestMetadataBytes || 0);
        totalR2StorageBytes += pBytes + mBytes;
        totalR2Objects += Number(rawB.object_count || 0);
        const {
          _latestStorageDate: _d,
          _latestPayloadBytes: _p,
          _latestMetadataBytes: _m,
          ...cleanB
        } = rawB;
        cleanB.payload_size_mb = roundTo(pBytes / (1024 * 1024), 2);
        cleanB.metadata_size_mb = roundTo(mBytes / (1024 * 1024), 3);
        r2BucketsList.push(cleanB);
      }

      r2b.mtd_egress_mb = roundTo(totalR2EgressBytesMtd / (1024 * 1024), 2);
      r2b.total_objects = totalR2Objects;
      r2b.total_storage_mb = roundTo(totalR2StorageBytes / (1024 * 1024), 2);
      r2b.storage_pct = roundTo((r2b.total_storage_mb / QUOTAS.r2_storage_limit_mb) * 100, 2);
      r2b.monthly_class_a_pct = roundTo(
        (r2b.mtd_class_a_ops / QUOTAS.r2_monthly_class_a_limit) * 100,
        2,
      );
      r2b.monthly_class_b_pct = roundTo(
        (r2b.mtd_class_b_ops / QUOTAS.r2_monthly_class_b_limit) * 100,
        3,
      );
      const r2BillableStorageGb = Math.max(0.0, (r2b.total_storage_mb - QUOTAS.r2_storage_limit_mb) / 1000.0);
      const r2BillableClassAM = Math.max(0.0, (r2b.mtd_class_a_ops - QUOTAS.r2_monthly_class_a_limit) / 1_000_000.0);
      const r2BillableClassBM = Math.max(0.0, (r2b.mtd_class_b_ops - QUOTAS.r2_monthly_class_b_limit) / 1_000_000.0);
      r2b.estimated_billable_usd = roundTo(
        r2BillableStorageGb * 0.015 + r2BillableClassAM * 4.5 + r2BillableClassBM * 0.36,
        2,
      );
      r2b.buckets = r2BucketsList.sort((a, b) =>
        b.payload_size_mb !== a.payload_size_mb
          ? b.payload_size_mb - a.payload_size_mb
          : a.name.localeCompare(b.name),
      );
    }
  }

  // D1 Database inventory & storage sizes from REST API
  if (d1Rest.status === "fulfilled" && d1Rest.value.status === 200) {
    const databases = d1Rest.value.body?.result ?? [];
    let totalBytes = 0;
    for (const db of databases) {
      const uuid = String(db?.uuid ?? "");
      const fileSize = Number(db?.file_size ?? 0);
      totalBytes += fileSize;
      const sizeMb = roundTo(fileSize / (1024 * 1024), 2);
      const storagePct = fileSize > 0 ? roundTo((sizeMb / QUOTAS.d1_per_db_storage_limit_mb) * 100, 1) : 0.0;
      const dbStats = d1StatsById[uuid] ?? {
        rows_read_mtd: 0,
        rows_written_mtd: 0,
        rows_read_today: 0,
        rows_written_today: 0,
        read_queries_mtd: 0,
        write_queries_mtd: 0,
      };
      const dbEntry: D1DatabaseUsage = {
        name: String(db?.name || "Unknown"),
        uuid,
        file_size_mb: sizeMb,
        capacity_pct: storagePct,
        rows_read: dbStats.rows_read_mtd,
        rows_written: dbStats.rows_written_mtd,
        rows_read_today: dbStats.rows_read_today,
        rows_written_today: dbStats.rows_written_today,
        read_queries: dbStats.read_queries_mtd,
        write_queries: dbStats.write_queries_mtd,
      };
      result.d1_databases.push(dbEntry);
    }
    const totalMb = roundTo(totalBytes / (1024 * 1024), 2);
    result.d1_billing.total_storage_mb = totalMb;
    result.d1_billing.account_storage_pct = roundTo(
      (totalMb / QUOTAS.d1_account_storage_limit_mb) * 100,
      2,
    );
  }

  return result;
}

export async function collectCloudflareTelemetry(
  env: Env,
  zoneNameCache: Record<string, string>,
  nowUtc: Date = new Date(),
): Promise<CloudMetricsPayload> {
  const apiToken = String(env.CLOUDFLARE_API_TOKEN ?? "").trim();
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };

  const monitoredZones = discoverMonitoredZones(env);

  const [acctUsage, zoneEntries] = await Promise.all([
    fetchAccountBillingAndUsage(accountId, headers, nowUtc),
    Promise.all(
      monitoredZones.map(async ({ defaultName, zoneId }) => {
        const actualName = await resolveZoneName(defaultName, zoneId, headers, zoneNameCache);
        const metrics = await fetchZoneMetrics(zoneId, headers, nowUtc);
        return [actualName, metrics] as const;
      }),
    ),
  ]);

  const domains: Record<string, ZoneMetrics> = {};
  for (const [name, metrics] of zoneEntries) {
    domains[name] = metrics;
  }

  return {
    last_updated: formatUtcTimestamp(nowUtc),
    domains,
    billing_period: acctUsage.billing_period,
    workers_and_pages: acctUsage.workers_and_pages,
    workers_ai: acctUsage.workers_ai,
    d1_billing: acctUsage.d1_billing,
    d1_databases: acctUsage.d1_databases,
    durable_objects: acctUsage.durable_objects,
    kv_billing: acctUsage.kv_billing,
    r2_billing: acctUsage.r2_billing,
  };
}
