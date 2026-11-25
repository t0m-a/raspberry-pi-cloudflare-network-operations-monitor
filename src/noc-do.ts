import {
  buildDeterministicFallbackAnalysis,
  runAutomatedNocAnalysis,
  runInteractiveNocQuestion,
} from "./ai-analyst.ts";
import { collectCloudflareTelemetry, formatUtcTimestamp } from "./collector.ts";
import {
  decideTelegramAlertAction,
  determineEvaluationTrigger,
  evaluateCloudTelemetry,
  formatDurationHuman,
  normalizeSnoozeDuration,
} from "./evaluator.ts";
import {
  buildQuickNavKeyboard,
  buildSnoozeKeyboard,
  escapeTgHtml,
  format5xxAuditHtml,
  formatAiDetailHtml,
  formatAlertNotificationHtml,
  formatAlertsDetailHtml,
  formatCfDomainsHtml,
  formatD1DetailHtml,
  formatDoDetailHtml,
  formatEsp32Html,
  formatFullReportHtml,
  formatHelpHtml,
  formatKvDetailHtml,
  formatQdrantHtml,
  formatQuotasHtml,
  formatR2DetailHtml,
  formatRpi5VitalsHtml,
  formatServicesHtml,
  formatSyncHtml,
  formatWorkersDetailHtml,
  isAuthorizedTelegramUser,
  parseTelegramCommand,
  resolveShortKey,
  sendTelegramHtml,
  setupTelegramWebhookAndCommands,
  telegramApiCall,
} from "./telegram.ts";
import {
  THRESHOLDS,
  type AiAnalysisPayload,
  type AnomalyFinding,
  type CloudMetricsPayload,
  type Env,
  type Esp32DeviceVitals,
  type Esp32HistorySample,
  type Esp32HistorySummary,
  type Esp32OobWatchdogStatus,
  type Esp32PingTelemetry,
  type Esp32TelemetryPayload,
  type NocPersistentState,
  type Rpi5TelemetryPayload,
  type SnoozedAnomaly,
} from "./types.ts";

interface CachedMetricsEnvelope {
  fetchedAtMs: number;
  payload: CloudMetricsPayload;
}

const MAX_ESP32_HISTORY_SAMPLES = 96; // 24 hours at 15-minute cadence

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function updateEsp32History(
  prev: Esp32HistorySummary | undefined,
  sample: Esp32HistorySample,
): Esp32HistorySummary {
  const samples = [...(prev?.recent_samples || []), sample].slice(-MAX_ESP32_HISTORY_SAMPLES);
  const okCount = samples.filter((s) => s.ok).length;
  const uptimePct = samples.length > 0 ? round2((okCount / samples.length) * 100) : 0;

  const rtts = samples
    .map((s) => s.rtt_ms)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const avgRtt = rtts.length > 0 ? round2(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null;
  const minRtt = rtts.length > 0 ? round2(Math.min(...rtts)) : null;
  const maxRtt = rtts.length > 0 ? round2(Math.max(...rtts)) : null;

  const consecutiveFailures = sample.ok ? 0 : (prev?.consecutive_failures || 0) + 1;
  const consecutiveSuccesses = sample.ok ? (prev?.consecutive_successes || 0) + 1 : 0;
  const lastSeenOnlineUtc = sample.ok ? sample.ts_utc : (prev?.last_seen_online_utc || "");

  return {
    samples_24h: samples.length,
    uptime_pct_24h: uptimePct,
    avg_rtt_24h_ms: avgRtt,
    min_rtt_24h_ms: minRtt,
    max_rtt_24h_ms: maxRtt,
    consecutive_failures: consecutiveFailures,
    consecutive_successes: consecutiveSuccesses,
    last_seen_online_utc: lastSeenOnlineUtc,
    recent_samples: samples,
  };
}

export class NocMonitorDO implements DurableObject {
  private ctx: DurableObjectState;
  private env: Env;
  private sqlReady: boolean = false;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.initSql();
  }

  private initSql(): void {
    try {
      if (this.ctx.storage?.sql) {
        this.ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS noc_kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `);
        this.sqlReady = true;
      }
    } catch {
      this.sqlReady = false;
    }
  }

  private async readStore<T>(key: string, fallback: T): Promise<T> {
    if (this.sqlReady && this.ctx.storage?.sql) {
      try {
        const rows = this.ctx.storage.sql
          .exec("SELECT value FROM noc_kv WHERE key = ? LIMIT 1", key)
          .toArray();
        if (rows.length > 0 && typeof rows[0].value === "string") {
          return JSON.parse(rows[0].value) as T;
        }
        return fallback;
      } catch {
        // Fallback to KV storage API
      }
    }
    const val = await this.ctx.storage.get<T>(key);
    return val !== undefined ? val : fallback;
  }

  private async writeStore<T>(key: string, value: T): Promise<void> {
    if (this.sqlReady && this.ctx.storage?.sql) {
      try {
        const serialized = JSON.stringify(value);
        this.ctx.storage.sql.exec(
          `INSERT INTO noc_kv (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          key,
          serialized,
          Date.now(),
        );
        return;
      } catch {
        // Fallback to KV storage API
      }
    }
    await this.ctx.storage.put(key, value);
  }

  private getTtlMs(): number {
    const raw = Number(this.env.METRICS_TTL_SECONDS ?? 60);
    return Math.max(10, Number.isFinite(raw) ? raw : 60) * 1000;
  }

  private getDashboardUrl(): string {
    return String(this.env.NOC_DASHBOARD_URL || "https://noc.tsimon.me/").trim();
  }

  private getTelegramCooldownSec(): number {
    const raw = Number(this.env.TELEGRAM_ALERT_COOLDOWN_SEC ?? THRESHOLDS.telegram_alert_cooldown_seconds);
    return Number.isFinite(raw) && raw >= 300 ? raw : THRESHOLDS.telegram_alert_cooldown_seconds;
  }

  private async attachEdgeNodeTelemetry(payload: CloudMetricsPayload): Promise<CloudMetricsPayload> {
    const [rpi5, esp32] = await Promise.all([
      this.readStore<Rpi5TelemetryPayload | null>("rpi5_telemetry", null),
      this.readStore<Esp32TelemetryPayload | null>("esp32_telemetry", null),
    ]);
    return {
      ...payload,
      rpi5: rpi5 ?? payload.rpi5 ?? null,
      esp32: esp32 ?? payload.esp32 ?? null,
    };
  }

  public async getOrCollectMetrics(forceRefresh: boolean = false): Promise<CloudMetricsPayload> {
    const nowMs = Date.now();
    const ttlMs = this.getTtlMs();
    const cached = await this.readStore<CachedMetricsEnvelope | null>("metrics_cache", null);

    if (!forceRefresh && cached && nowMs - cached.fetchedAtMs < ttlMs) {
      return this.attachEdgeNodeTelemetry(cached.payload);
    }

    const state = await this.readStore<NocPersistentState>("noc_state", {});
    const zoneNameCache: Record<string, string> = { ...(state.zone_name_cache || {}) };

    const cloudPayload = await collectCloudflareTelemetry(this.env, zoneNameCache, new Date(nowMs));
    state.zone_name_cache = zoneNameCache;

    await this.writeStore("metrics_cache", { fetchedAtMs: nowMs, payload: cloudPayload });
    await this.writeStore("noc_state", state);

    const unified = await this.attachEdgeNodeTelemetry(cloudPayload);

    // Keep public ai_analysis active/snoozed status synced with latest metrics
    const existingAi = await this.readStore<AiAnalysisPayload | null>("ai_analysis_cache", null);
    if (!existingAi) {
      await this.runEvaluationCycle({
        forceAi: true,
        forceRefreshMetrics: false,
        reasonOverride: "INITIAL_BOOT",
        allowTelegramAlert: false,
      });
    } else {
      await this.refreshPublicAiVerdict(unified, state, "METRICS_SYNC");
    }

    return unified;
  }

  public async refreshPublicAiVerdict(
    metrics?: CloudMetricsPayload,
    state?: NocPersistentState,
    reasonOverride?: string,
  ): Promise<AiAnalysisPayload> {
    const activeMetrics = metrics ?? (await this.getOrCollectMetrics(false));
    const activeState = state ?? (await this.readStore<NocPersistentState>("noc_state", {}));
    const nowUtc = new Date();
    const nowTs = nowUtc.getTime() / 1000.0;

    const evalRes = evaluateCloudTelemetry(activeMetrics, activeState, nowUtc);
    const snoozedList = evalRes.snoozedAnomalies.map((s) => {
      const remSec = Math.max(0, Number(s.snoozed_until_ts || 0) - nowTs);
      return {
        ...s,
        remaining_seconds: Math.floor(remSec),
        remaining_human: formatDurationHuman(remSec),
      };
    });

    const critCount = evalRes.activeAnomalies.filter((a) => a.severity === "CRITICAL").length;
    const warnCount = evalRes.activeAnomalies.filter((a) => a.severity === "WARNING").length;
    const overallStatus: "HEALTHY" | "WARNING" | "CRITICAL" =
      critCount > 0 ? "CRITICAL" : warnCount > 0 ? "WARNING" : "HEALTHY";

    const prevPublic = await this.readStore<AiAnalysisPayload | null>("ai_analysis_cache", null);
    const analysisText =
      prevPublic?.analysis ||
      activeState.last_ai_analysis ||
      buildDeterministicFallbackAnalysis(evalRes.compactBrief, evalRes.activeAnomalies);

    const payload: AiAnalysisPayload = {
      last_analyzed_utc: prevPublic?.last_analyzed_utc || formatUtcTimestamp(nowUtc),
      metrics_sync_utc: activeMetrics.last_updated || formatUtcTimestamp(nowUtc),
      model:
        prevPublic?.model ||
        activeState.last_ai_model ||
        `${this.env.AI_MODEL || "@cf/google/gemma-4-26b-a4b-it"} (Workers AI)`,
      inference_duration_sec: Number(prevPublic?.inference_duration_sec ?? activeState.last_inference_sec ?? 0.0),
      overall_status: overallStatus,
      reason_code: reasonOverride || prevPublic?.reason_code || activeState.last_reason_code || "SCHEDULED",
      anomalies_count: evalRes.activeAnomalies.length,
      anomalies: evalRes.activeAnomalies,
      snoozed_count: snoozedList.length,
      snoozed_anomalies: snoozedList,
      analysis: analysisText,
    };

    await this.writeStore("ai_analysis_cache", payload);
    return payload;
  }

  public async runEvaluationCycle(
    options: {
      forceAi?: boolean;
      forceRefreshMetrics?: boolean;
      reasonOverride?: string;
      allowTelegramAlert?: boolean;
      forceTelegramAlert?: boolean;
    } = {},
  ): Promise<AiAnalysisPayload> {
    const metrics = await this.getOrCollectMetrics(options.forceRefreshMetrics ?? true);
    const prevState = await this.readStore<NocPersistentState>("noc_state", {});
    const nowUtc = new Date();
    const nowTs = nowUtc.getTime() / 1000.0;
    const nowUtcStr = formatUtcTimestamp(nowUtc);

    const evalRes = evaluateCloudTelemetry(metrics, prevState, nowUtc);
    const trigger = determineEvaluationTrigger(evalRes.activeAnomalies, prevState, nowTs, {
      forceAi: options.forceAi,
      reasonOverride: options.reasonOverride,
    });

    let aiAnalysisText = prevState.last_ai_analysis || "";
    let aiModelUsed =
      prevState.last_ai_model || `${this.env.AI_MODEL || "@cf/google/gemma-4-26b-a4b-it"} (Workers AI)`;
    let inferenceSec = Number(prevState.last_inference_sec || 0.0);
    let lastLlmTs = Number(prevState.last_llm_ts || 0.0);

    if (trigger.shouldRunAi) {
      const aiRes = await runAutomatedNocAnalysis(
        this.env,
        evalRes.compactBrief,
        trigger.reasonCode,
        evalRes.activeAnomalies,
      );
      aiAnalysisText = aiRes.text;
      aiModelUsed = aiRes.modelUsed;
      inferenceSec = aiRes.elapsedSec;
      lastLlmTs = nowTs;
    }

    const critCount = evalRes.activeAnomalies.filter((a) => a.severity === "CRITICAL").length;
    const warnCount = evalRes.activeAnomalies.filter((a) => a.severity === "WARNING").length;
    const overallStatus: "HEALTHY" | "WARNING" | "CRITICAL" =
      critCount > 0 ? "CRITICAL" : warnCount > 0 ? "WARNING" : "HEALTHY";

    const aiPayload: AiAnalysisPayload = {
      last_analyzed_utc: nowUtcStr,
      metrics_sync_utc: metrics.last_updated,
      model: aiModelUsed,
      inference_duration_sec: inferenceSec,
      overall_status: overallStatus,
      reason_code: trigger.reasonCode,
      anomalies_count: evalRes.activeAnomalies.length,
      anomalies: evalRes.activeAnomalies,
      snoozed_count: evalRes.snoozedAnomalies.length,
      snoozed_anomalies: evalRes.snoozedAnomalies,
      analysis: aiAnalysisText,
    };

    const nextTelegram = { ...(prevState.telegram || {}) };

    // Smart Proactive Telegram Alerting (respecting strict 5xx 100/hr x 2h rule & snoozes)
    const allowTg = options.allowTelegramAlert !== false;
    if (allowTg && this.env.TELEGRAM_BOT_TOKEN && this.env.TELEGRAM_CHAT_ID) {
      const decision = options.forceTelegramAlert
        ? { shouldAlert: true, reasonCode: options.reasonOverride || trigger.reasonCode }
        : decideTelegramAlertAction(
            evalRes.activeAnomalies,
            prevState,
            nowTs,
            this.getTelegramCooldownSec(),
          );

      if (decision.shouldAlert) {
        const htmlMsg = formatAlertNotificationHtml(
          metrics,
          aiPayload,
          decision.reasonCode,
          this.getDashboardUrl(),
        );
        const keyboard = buildSnoozeKeyboard(evalRes.activeAnomalies, evalRes.snoozedAnomalies, true);
        const sent = await sendTelegramHtml(this.env, htmlMsg, { replyMarkup: keyboard });
        if (sent.ok) {
          nextTelegram.last_alert_ts = nowTs;
          nextTelegram.last_alert_utc = nowUtcStr;
          nextTelegram.last_alert_reason = decision.reasonCode;
          nextTelegram.last_alerted_keys = evalRes.activeAnomalies.map((a) => a.key);
          nextTelegram.alerts_sent_total = Number(nextTelegram.alerts_sent_total || 0) + 1;
        }
      }
    }

    const nextState: NocPersistentState = {
      ...prevState,
      ...evalRes.stateUpdates,
      active_alerts: trigger.nextActiveAlerts,
      telegram: nextTelegram,
      last_check_utc: nowUtcStr,
      last_reason_code: trigger.reasonCode,
      last_ai_analysis: aiAnalysisText,
      last_ai_model: aiModelUsed,
      last_inference_sec: inferenceSec,
      last_llm_ts: lastLlmTs,
    };

    await this.writeStore("noc_state", nextState);
    await this.writeStore("ai_analysis_cache", aiPayload);
    return aiPayload;
  }

  // ============================================================================
  // RASPBERRY PI 5 & ESP-32S TELEMETRY INGESTION
  // ============================================================================

  public async ingestRpi5Telemetry(
    rawPayload: Record<string, any>,
  ): Promise<{ ok: boolean; received_at_utc: string; anomalies_count: number }> {
    const nowUtc = new Date();
    const nowUtcStr = formatUtcTimestamp(nowUtc);

    const rpi5Data: Rpi5TelemetryPayload = {
      ...(rawPayload as Rpi5TelemetryPayload),
      reported_at_utc: String(rawPayload.reported_at_utc || nowUtcStr),
      received_at_utc: nowUtcStr,
      agent_version: String(rawPayload.agent_version || "1.0.0"),
      cron_interval_sec: Number(rawPayload.cron_interval_sec || 900),
    };
    // Strip embedded esp32_probe before storing pure rpi5 object
    const cleanRpi5: any = { ...rpi5Data };
    const esp32Probe = rawPayload.esp32_probe || rawPayload.esp32 || null;
    delete cleanRpi5.esp32_probe;
    delete cleanRpi5.esp32;

    await this.writeStore("rpi5_telemetry", cleanRpi5 as Rpi5TelemetryPayload);

    // If the RPi5 cron agent included a LAN probe of the ESP-32S, merge it into esp32_telemetry
    if (esp32Probe && typeof esp32Probe === "object") {
      const existingEsp = await this.readStore<Esp32TelemetryPayload | null>("esp32_telemetry", null);
      const pingData = (esp32Probe.ping || esp32Probe) as Esp32PingTelemetry;
      const sample: Esp32HistorySample = {
        ts_utc: String(pingData.probed_at_utc || nowUtcStr),
        ok: Boolean(pingData.reachable),
        rtt_ms: typeof pingData.rtt_avg_ms === "number" ? pingData.rtt_avg_ms : null,
        loss_pct: Number(pingData.packet_loss_pct ?? (pingData.reachable ? 0 : 100)),
      };
      const nextHistory = updateEsp32History(existingEsp?.history, sample);

      const mergedEsp: Esp32TelemetryPayload = {
        last_updated_utc: nowUtcStr,
        sources: {
          ...(existingEsp?.sources || {}),
          rpi5_probe_utc: nowUtcStr,
          ...(esp32Probe.device ? { local_http_utc: nowUtcStr } : {}),
        },
        ping: {
          reachable: Boolean(pingData.reachable),
          target_ip: String(pingData.target_ip || existingEsp?.ping?.target_ip || ""),
          mac: String(pingData.mac || existingEsp?.ping?.mac || ""),
          vendor: String(pingData.vendor || existingEsp?.ping?.vendor || "Espressif Inc."),
          arp_state: String(pingData.arp_state || "UNKNOWN"),
          interface: String(pingData.interface || "eth0"),
          packets_sent: Number(pingData.packets_sent ?? 5),
          packets_received: Number(pingData.packets_received ?? 0),
          packet_loss_pct: Number(pingData.packet_loss_pct ?? 100),
          rtt_min_ms: pingData.rtt_min_ms ?? null,
          rtt_avg_ms: pingData.rtt_avg_ms ?? null,
          rtt_max_ms: pingData.rtt_max_ms ?? null,
          rtt_jitter_ms: pingData.rtt_jitter_ms ?? null,
          ttl: pingData.ttl ?? null,
          probed_at_utc: String(pingData.probed_at_utc || nowUtcStr),
          probed_from: String(pingData.probed_from || cleanRpi5.host?.hostname || "rpi"),
        },
        device: (esp32Probe.device as Esp32DeviceVitals | undefined) ?? existingEsp?.device,
        oob_watchdog: (esp32Probe.oob_watchdog as Esp32OobWatchdogStatus | undefined) ?? existingEsp?.oob_watchdog,
        history: nextHistory,
      };
      await this.writeStore("esp32_telemetry", mergedEsp);
    }

    // Re-evaluate immediately using cached Cloudflare metrics + fresh RPi5/ESP-32S data
    const aiPayload = await this.runEvaluationCycle({
      forceAi: false,
      forceRefreshMetrics: false,
      allowTelegramAlert: true,
    });

    return {
      ok: true,
      received_at_utc: nowUtcStr,
      anomalies_count: aiPayload.anomalies_count,
    };
  }

  public async ingestEsp32Telemetry(
    rawPayload: Record<string, any>,
  ): Promise<{ ok: boolean; received_at_utc: string; anomalies_count: number }> {
    const nowUtcStr = formatUtcTimestamp(new Date());
    const existingEsp = await this.readStore<Esp32TelemetryPayload | null>("esp32_telemetry", null);

    const device = (rawPayload.device as Esp32DeviceVitals | undefined) ?? existingEsp?.device;
    const oob = (rawPayload.oob_watchdog as Esp32OobWatchdogStatus | undefined) ?? existingEsp?.oob_watchdog;
    const nextHistory = existingEsp?.history
      ? { ...existingEsp.history, last_seen_online_utc: nowUtcStr }
      : undefined;

    const merged: Esp32TelemetryPayload = {
      last_updated_utc: nowUtcStr,
      sources: {
        ...(existingEsp?.sources || {}),
        direct_push_utc: nowUtcStr,
      },
      ping: existingEsp?.ping,
      device,
      oob_watchdog: oob,
      history: nextHistory,
    };

    await this.writeStore("esp32_telemetry", merged);

    const aiPayload = await this.runEvaluationCycle({
      forceAi: false,
      forceRefreshMetrics: false,
      allowTelegramAlert: true,
    });

    return {
      ok: true,
      received_at_utc: nowUtcStr,
      anomalies_count: aiPayload.anomalies_count,
    };
  }

  // ============================================================================
  // SNOOZE / UNSNOOZE & INTERACTIVE ASK
  // ============================================================================

  public async snoozeFinding(
    keyOrPattern: string,
    durationStr: string = "24h",
    source: string = "web_ui",
  ): Promise<{ snoozed: SnoozedAnomaly[]; count: number }> {
    const { seconds, label, code } = normalizeSnoozeDuration(durationStr);
    const nowUtc = new Date();
    const nowTs = nowUtc.getTime() / 1000.0;
    const untilTs = nowTs + seconds;
    const untilUtcStr = formatUtcTimestamp(new Date(untilTs * 1000));

    const metrics = await this.getOrCollectMetrics(false);
    const state = await this.readStore<NocPersistentState>("noc_state", {});
    const rawEval = evaluateCloudTelemetry(metrics, { ...state, snoozed_anomalies: {} }, nowUtc);
    const rawAnomalies = rawEval.rawAnomalies;

    const cleanTarget = keyOrPattern.trim();
    const snoozes: Record<string, SnoozedAnomaly> = { ...(state.snoozed_anomalies || {}) };
    const newlySnoozed: SnoozedAnomaly[] = [];

    const createSnoozeEntry = (anomaly: AnomalyFinding): SnoozedAnomaly => ({
      key: anomaly.key,
      title: anomaly.title,
      severity: anomaly.severity,
      category: anomaly.category,
      detail: anomaly.detail,
      duration_str: code,
      duration_label: label,
      duration_seconds: seconds,
      snoozed_at_ts: nowTs,
      snoozed_at_utc: formatUtcTimestamp(nowUtc),
      snoozed_until_ts: untilTs,
      snoozed_until_utc: untilUtcStr,
      snoozed_by: source,
      remaining_seconds: seconds,
      remaining_human: formatDurationHuman(seconds),
    });

    if (cleanTarget.toLowerCase() === "all" || cleanTarget === "*") {
      for (const a of rawAnomalies) {
        const entry = createSnoozeEntry(a);
        snoozes[a.key] = entry;
        newlySnoozed.push(entry);
      }
    } else {
      let targetAnomaly: AnomalyFinding | undefined;

      if (/^\d+$/.test(cleanTarget)) {
        const idx = parseInt(cleanTarget, 10) - 1;
        if (idx >= 0 && idx < rawAnomalies.length) {
          targetAnomaly = rawAnomalies[idx];
        }
      }

      if (!targetAnomaly) {
        const lower = cleanTarget.toLowerCase();
        targetAnomaly = rawAnomalies.find(
          (a) =>
            a.key === cleanTarget ||
            a.key.toLowerCase().includes(lower) ||
            a.title.toLowerCase().includes(lower),
        );
      }

      if (!targetAnomaly) {
        const prevAlert = state.active_alerts?.[cleanTarget];
        if (prevAlert) {
          targetAnomaly = {
            key: cleanTarget,
            title: prevAlert.title || cleanTarget,
            severity: prevAlert.severity || "WARNING",
            category: "NOC Finding",
            detail: prevAlert.detail || "",
          };
        } else {
          targetAnomaly = {
            key: cleanTarget,
            title: cleanTarget,
            severity: "WARNING",
            category: "Custom",
            detail: "Operator-defined assessment key",
          };
        }
      }

      const entry = createSnoozeEntry(targetAnomaly);
      snoozes[targetAnomaly.key] = entry;
      newlySnoozed.push(entry);
    }

    state.snoozed_anomalies = snoozes;
    await this.writeStore("noc_state", state);
    await this.refreshPublicAiVerdict(metrics, state, "SNOOZE_UPDATED");

    return { snoozed: newlySnoozed, count: newlySnoozed.length };
  }

  public async unsnoozeFinding(keyOrPattern: string): Promise<SnoozedAnomaly[]> {
    const metrics = await this.getOrCollectMetrics(false);
    const state = await this.readStore<NocPersistentState>("noc_state", {});
    const snoozes: Record<string, SnoozedAnomaly> = { ...(state.snoozed_anomalies || {}) };
    const cleanTarget = keyOrPattern.trim();
    const removed: SnoozedAnomaly[] = [];

    if (Object.keys(snoozes).length === 0) {
      return [];
    }

    if (cleanTarget.toLowerCase() === "all" || cleanTarget === "*") {
      removed.push(...Object.values(snoozes));
      for (const k of Object.keys(snoozes)) {
        delete snoozes[k];
      }
    } else {
      let matchKey: string | undefined;
      const keysList = Object.keys(snoozes);

      if (/^\d+$/.test(cleanTarget)) {
        const idx = parseInt(cleanTarget, 10) - 1;
        if (idx >= 0 && idx < keysList.length) {
          matchKey = keysList[idx];
        }
      }

      if (!matchKey) {
        const lower = cleanTarget.toLowerCase();
        for (const [k, entry] of Object.entries(snoozes)) {
          if (k === cleanTarget || k.toLowerCase().includes(lower) || entry.title.toLowerCase().includes(lower)) {
            matchKey = k;
            break;
          }
        }
      }

      if (matchKey && snoozes[matchKey]) {
        removed.push(snoozes[matchKey]);
        delete snoozes[matchKey];
      }
    }

    state.snoozed_anomalies = snoozes;
    await this.writeStore("noc_state", state);
    await this.refreshPublicAiVerdict(metrics, state, "SNOOZE_UPDATED");

    return removed;
  }

  public async askAnalyst(question: string): Promise<{
    answer: string;
    model: string;
    elapsed_sec: number;
    metrics_sync_utc: string;
  }> {
    const metrics = await this.getOrCollectMetrics(false);
    const state = await this.readStore<NocPersistentState>("noc_state", {});
    const evalRes = evaluateCloudTelemetry(metrics, state, new Date());

    const cleanQ = question.trim() || "Provide a concise summary of current Cloudflare, Raspberry Pi 5, and ESP-32S telemetry.";
    const res = await runInteractiveNocQuestion(this.env, cleanQ, evalRes.compactBrief);

    return {
      answer: res.answer,
      model: res.modelUsed,
      elapsed_sec: res.elapsedSec,
      metrics_sync_utc: metrics.last_updated,
    };
  }

  // ============================================================================
  // EXHAUSTIVE TELEGRAM WEBHOOK COMMAND & CALLBACK ENGINE
  // ============================================================================

  public async handleTelegramUpdate(update: Record<string, any>): Promise<{ ok: boolean; handled: string }> {
    const nowUtcStr = formatUtcTimestamp(new Date());

    const recordCommandMetric = async () => {
      const st = await this.readStore<NocPersistentState>("noc_state", {});
      st.telegram = {
        ...(st.telegram || {}),
        commands_handled_total: Number(st.telegram?.commands_handled_total || 0) + 1,
        last_command_utc: nowUtcStr,
      };
      await this.writeStore("noc_state", st);
    };

    // 1. Inline Keyboard Callback Queries
    if (update.callback_query) {
      const cq = update.callback_query;
      const cqId = String(cq.id || "");
      const senderId = String(cq.from?.id || "");
      const chatId = String(cq.message?.chat?.id || senderId);
      const data = String(cq.data || "");

      if (!isAuthorizedTelegramUser(this.env, chatId, senderId)) {
        await telegramApiCall(this.env, "answerCallbackQuery", {
          callback_query_id: cqId,
          text: "Unauthorized operator",
          show_alert: true,
        });
        return { ok: true, handled: "unauthorized_callback" };
      }

      await recordCommandMetric();

      if (data.startsWith("nav:")) {
        const target = data.slice(4);
        await telegramApiCall(this.env, "answerCallbackQuery", { callback_query_id: cqId });
        const metrics = await this.getOrCollectMetrics(false);
        const state = await this.readStore<NocPersistentState>("noc_state", {});
        const aiPayload = await this.refreshPublicAiVerdict(metrics, state);
        let htmlOut = "";
        let markup: Record<string, unknown> | undefined = buildQuickNavKeyboard();
        if (target === "status") {
          htmlOut = formatAlertNotificationHtml(metrics, aiPayload, "STATUS_CHECK", this.getDashboardUrl());
          markup = buildSnoozeKeyboard(aiPayload.anomalies, aiPayload.snoozed_anomalies, true);
        } else if (target === "cf") {
          htmlOut = formatCfDomainsHtml(metrics);
        } else if (target === "quotas") {
          htmlOut = formatQuotasHtml(metrics);
        } else if (target === "pi") {
          htmlOut = formatRpi5VitalsHtml(metrics);
        } else if (target === "qdrant") {
          htmlOut = formatQdrantHtml(metrics);
        } else if (target === "sync") {
          htmlOut = formatSyncHtml(metrics);
        } else if (target === "services") {
          htmlOut = formatServicesHtml(metrics);
        } else if (target === "esp32") {
          htmlOut = formatEsp32Html(metrics);
        } else if (target === "alerts") {
          htmlOut = formatAlertsDetailHtml(aiPayload, state);
          markup = buildSnoozeKeyboard(aiPayload.anomalies, aiPayload.snoozed_anomalies, true);
        } else if (target === "full") {
          htmlOut = formatFullReportHtml(metrics, aiPayload, state, this.getDashboardUrl());
        }
        if (htmlOut) {
          await sendTelegramHtml(this.env, htmlOut, { chatId, replyMarkup: markup });
        }
        return { ok: true, handled: `callback:${data}` };
      }

      if (data.startsWith("snz_all:")) {
        const dur = data.slice("snz_all:".length) || "24h";
        const res = await this.snoozeFinding("all", dur, `tg_${senderId}`);
        await telegramApiCall(this.env, "answerCallbackQuery", {
          callback_query_id: cqId,
          text: `💤 Snoozed ${res.count} finding(s) for ${dur}`,
        });
        await sendTelegramHtml(
          this.env,
          `💤 <b>Snoozed All Active Findings (${escapeTgHtml(dur)})</b>\nMuted <b>${res.count}</b> finding(s).`,
          { chatId },
        );
        return { ok: true, handled: `callback:${data}` };
      }

      if (data.startsWith("snz:")) {
        const parts = data.split(":");
        const keyHash = parts[1] || "";
        const dur = parts[2] || "24h";
        const metrics = await this.getOrCollectMetrics(false);
        const state = await this.readStore<NocPersistentState>("noc_state", {});
        const evalRes = evaluateCloudTelemetry(metrics, { ...state, snoozed_anomalies: {} }, new Date());
        const candidateKeys = [
          ...evalRes.rawAnomalies.map((a) => a.key),
          ...Object.keys(state.active_alerts || {}),
        ];
        const resolvedKey = resolveShortKey(keyHash, candidateKeys);
        const res = await this.snoozeFinding(resolvedKey, dur, `tg_${senderId}`);
        const first = res.snoozed[0];
        await telegramApiCall(this.env, "answerCallbackQuery", {
          callback_query_id: cqId,
          text: first ? `💤 Snoozed for ${first.duration_label}` : "Snoozed",
        });
        if (first) {
          await sendTelegramHtml(
            this.env,
            `💤 <b>Assessment Snoozed (${escapeTgHtml(first.duration_label)})</b>\n• <b>${escapeTgHtml(first.title)}</b>\n<i>Silenced until ${escapeTgHtml(first.snoozed_until_utc)}</i>`,
            { chatId },
          );
        }
        return { ok: true, handled: `callback:${data}` };
      }

      if (data.startsWith("unsnz:")) {
        const keyHash = data.slice("unsnz:".length);
        const state = await this.readStore<NocPersistentState>("noc_state", {});
        const resolvedKey =
          keyHash === "all" ? "all" : resolveShortKey(keyHash, Object.keys(state.snoozed_anomalies || {}));
        const removed = await this.unsnoozeFinding(resolvedKey);
        await telegramApiCall(this.env, "answerCallbackQuery", {
          callback_query_id: cqId,
          text: `🔔 Unsnoozed ${removed.length} finding(s)`,
        });
        await sendTelegramHtml(
          this.env,
          removed.length > 0
            ? `🔔 <b>Unsnoozed (${removed.length})</b>\nReactivated: ${removed.map((r) => `<b>${escapeTgHtml(r.title)}</b>`).join(", ")}`
            : "ℹ️ No matching snoozed findings found.",
          { chatId },
        );
        return { ok: true, handled: `callback:${data}` };
      }

      await telegramApiCall(this.env, "answerCallbackQuery", { callback_query_id: cqId });
      return { ok: true, handled: "callback:unknown" };
    }

    // 2. Incoming Text Messages & Slash Commands
    const msg = update.message || update.edited_message;
    if (!msg) {
      return { ok: true, handled: "ignored_update" };
    }

    const chatId = String(msg.chat?.id || "");
    const senderId = String(msg.from?.id || "");
    const msgId = Number(msg.message_id || 0) || undefined;
    const isPrivate = String(msg.chat?.type || "") === "private";
    const text = String(msg.text || msg.caption || "").trim();

    if (!isAuthorizedTelegramUser(this.env, chatId, senderId)) {
      return { ok: true, handled: "unauthorized_chat" };
    }

    const action = parseTelegramCommand(text, isPrivate);
    if (!action) {
      return { ok: true, handled: "no_action" };
    }

    await recordCommandMetric();

    if (action.type === "HELP") {
      await sendTelegramHtml(this.env, formatHelpHtml(), {
        chatId,
        replyToMessageId: msgId,
        replyMarkup: buildQuickNavKeyboard(),
      });
      return { ok: true, handled: "HELP" };
    }

    if (action.type === "REFRESH") {
      const fresh = await this.getOrCollectMetrics(true);
      await sendTelegramHtml(
        this.env,
        `🔄 <b>Live Cloudflare Telemetry Refreshed</b>\nSync: <code>${escapeTgHtml(fresh.last_updated)}</code>\nDomains: ${Object.keys(fresh.domains || {}).length} | Workers Today: ${fresh.workers_and_pages.daily_requests.toLocaleString()} | AI Neurons Today: ${fresh.workers_ai.daily_neurons}`,
        { chatId, replyToMessageId: msgId, replyMarkup: buildQuickNavKeyboard() },
      );
      return { ok: true, handled: "REFRESH" };
    }

    if (action.type === "ANALYZE") {
      await telegramApiCall(this.env, "sendChatAction", { chat_id: chatId, action: "typing" });
      const aiPayload = await this.runEvaluationCycle({
        forceAi: true,
        forceRefreshMetrics: true,
        reasonOverride: "TELEGRAM_MANUAL_ANALYSIS",
        allowTelegramAlert: false,
      });
      const metrics = await this.getOrCollectMetrics(false);
      const htmlOut = formatAlertNotificationHtml(metrics, aiPayload, "MANUAL_ANALYSIS", this.getDashboardUrl());
      await sendTelegramHtml(this.env, htmlOut, {
        chatId,
        replyToMessageId: msgId,
        replyMarkup: buildSnoozeKeyboard(aiPayload.anomalies, aiPayload.snoozed_anomalies, true),
      });
      return { ok: true, handled: "ANALYZE" };
    }

    if (action.type === "SNOOZE") {
      const arg = action.arg.trim();
      if (!arg) {
        const metrics = await this.getOrCollectMetrics(false);
        const state = await this.readStore<NocPersistentState>("noc_state", {});
        const aiPayload = await this.refreshPublicAiVerdict(metrics, state);
        await sendTelegramHtml(this.env, formatAlertsDetailHtml(aiPayload, state), {
          chatId,
          replyToMessageId: msgId,
          replyMarkup: buildSnoozeKeyboard(aiPayload.anomalies, aiPayload.snoozed_anomalies, false),
        });
        return { ok: true, handled: "SNOOZE_MENU" };
      }
      const parts = arg.split(/\s+/);
      const target = parts[0];
      const dur = parts.slice(1).join(" ") || "24h";
      try {
        const res = await this.snoozeFinding(target, dur, `tg_${senderId}`);
        const summary = res.snoozed
          .map((s) => `• <b>${escapeTgHtml(s.title)}</b> (${escapeTgHtml(s.duration_label)} — until ${escapeTgHtml(s.snoozed_until_utc)})`)
          .join("\n");
        await sendTelegramHtml(
          this.env,
          `💤 <b>Snoozed ${res.count} Finding(s)</b>\n${summary || "No active anomalies matched."}`,
          { chatId, replyToMessageId: msgId },
        );
      } catch (err: any) {
        await sendTelegramHtml(
          this.env,
          `⚠️ <b>Snooze Error:</b> ${escapeTgHtml(err?.message ?? err)}\nUsage: <code>/snooze 1 24h</code> | <code>/snooze all 72h</code> | <code>/snooze rpi5:qdrant_down 7d</code>`,
          { chatId, replyToMessageId: msgId },
        );
      }
      return { ok: true, handled: "SNOOZE" };
    }

    if (action.type === "UNSNOOZE") {
      const target = action.arg.trim() || "all";
      const removed = await this.unsnoozeFinding(target);
      await sendTelegramHtml(
        this.env,
        removed.length > 0
          ? `🔔 <b>Unsnoozed ${removed.length} Finding(s)</b>\n${removed.map((r) => `• <b>${escapeTgHtml(r.title)}</b>`).join("\n")}`
          : "ℹ️ No matching snoozed findings to reactivate.",
        { chatId, replyToMessageId: msgId },
      );
      return { ok: true, handled: "UNSNOOZE" };
    }

    const metrics = await this.getOrCollectMetrics(false);
    const state = await this.readStore<NocPersistentState>("noc_state", {});

    if (action.type === "STATUS") {
      const aiPayload = await this.refreshPublicAiVerdict(metrics, state);
      const htmlOut = formatAlertNotificationHtml(metrics, aiPayload, "STATUS_CHECK", this.getDashboardUrl());
      await sendTelegramHtml(this.env, htmlOut, {
        chatId,
        replyToMessageId: msgId,
        replyMarkup: buildSnoozeKeyboard(aiPayload.anomalies, aiPayload.snoozed_anomalies, true),
      });
      return { ok: true, handled: "STATUS" };
    }

    if (action.type === "FULL") {
      const aiPayload = await this.refreshPublicAiVerdict(metrics, state);
      const htmlOut = formatFullReportHtml(metrics, aiPayload, state, this.getDashboardUrl());
      await sendTelegramHtml(this.env, htmlOut, {
        chatId,
        replyToMessageId: msgId,
        replyMarkup: buildQuickNavKeyboard(),
      });
      return { ok: true, handled: "FULL" };
    }

    if (action.type === "ALERTS") {
      const aiPayload = await this.refreshPublicAiVerdict(metrics, state);
      await sendTelegramHtml(this.env, formatAlertsDetailHtml(aiPayload, state), {
        chatId,
        replyToMessageId: msgId,
        replyMarkup: buildSnoozeKeyboard(aiPayload.anomalies, aiPayload.snoozed_anomalies, true),
      });
      return { ok: true, handled: "ALERTS" };
    }

    if (action.type === "CF") {
      await sendTelegramHtml(this.env, formatCfDomainsHtml(metrics, action.arg), {
        chatId,
        replyToMessageId: msgId,
      });
      return { ok: true, handled: "CF" };
    }

    if (action.type === "FIVE_XX") {
      await sendTelegramHtml(this.env, format5xxAuditHtml(metrics, state), {
        chatId,
        replyToMessageId: msgId,
      });
      return { ok: true, handled: "FIVE_XX" };
    }

    if (action.type === "QUOTAS") {
      await sendTelegramHtml(this.env, formatQuotasHtml(metrics), {
        chatId,
        replyToMessageId: msgId,
      });
      return { ok: true, handled: "QUOTAS" };
    }

    if (action.type === "WORKERS") {
      await sendTelegramHtml(this.env, formatWorkersDetailHtml(metrics), {
        chatId,
        replyToMessageId: msgId,
      });
      return { ok: true, handled: "WORKERS" };
    }

    if (action.type === "DO") {
      await sendTelegramHtml(this.env, formatDoDetailHtml(metrics), {
        chatId,
        replyToMessageId: msgId,
      });
      return { ok: true, handled: "DO" };
    }

    if (action.type === "D1") {
      await sendTelegramHtml(this.env, formatD1DetailHtml(metrics), {
        chatId,
        replyToMessageId: msgId,
      });
      return { ok: true, handled: "D1" };
    }

    if (action.type === "AI") {
      await sendTelegramHtml(this.env, formatAiDetailHtml(metrics), {
        chatId,
        replyToMessageId: msgId,
      });
      return { ok: true, handled: "AI" };
    }

    if (action.type === "KV") {
      await sendTelegramHtml(this.env, formatKvDetailHtml(metrics), {
        chatId,
        replyToMessageId: msgId,
      });
      return { ok: true, handled: "KV" };
    }

    if (action.type === "R2") {
      await sendTelegramHtml(this.env, formatR2DetailHtml(metrics), {
        chatId,
        replyToMessageId: msgId,
      });
      return { ok: true, handled: "R2" };
    }

    if (action.type === "PI") {
      await sendTelegramHtml(this.env, formatRpi5VitalsHtml(metrics), {
        chatId,
        replyToMessageId: msgId,
      });
      return { ok: true, handled: "PI" };
    }

    if (action.type === "QDRANT") {
      await sendTelegramHtml(this.env, formatQdrantHtml(metrics), {
        chatId,
        replyToMessageId: msgId,
      });
      return { ok: true, handled: "QDRANT" };
    }

    if (action.type === "SYNC") {
      await sendTelegramHtml(this.env, formatSyncHtml(metrics), {
        chatId,
        replyToMessageId: msgId,
      });
      return { ok: true, handled: "SYNC" };
    }

    if (action.type === "SERVICES") {
      await sendTelegramHtml(this.env, formatServicesHtml(metrics), {
        chatId,
        replyToMessageId: msgId,
      });
      return { ok: true, handled: "SERVICES" };
    }

    if (action.type === "ESP32") {
      await sendTelegramHtml(this.env, formatEsp32Html(metrics), {
        chatId,
        replyToMessageId: msgId,
      });
      return { ok: true, handled: "ESP32" };
    }

    // Interactive Workers AI Q&A (/ask or direct chat)
    await telegramApiCall(this.env, "sendChatAction", { chat_id: chatId, action: "typing" });
    try {
      const res = await this.askAnalyst(action.question);
      await sendTelegramHtml(
        this.env,
        `🤖 <b>Workers AI NOC Engineer</b> <i>(${escapeTgHtml(res.model)}, ${res.elapsed_sec}s)</i>\n\n${escapeTgHtml(res.answer)}\n\n<i>Sync: ${escapeTgHtml(res.metrics_sync_utc)}</i>`,
        { chatId, replyToMessageId: msgId },
      );
    } catch (err: any) {
      await sendTelegramHtml(
        this.env,
        `⚠️ <b>AI Query Error:</b> <code>${escapeTgHtml(err?.message ?? err)}</code>`,
        { chatId, replyToMessageId: msgId },
      );
    }
    return { ok: true, handled: "ASK" };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const operator = request.headers.get("X-Authenticated-Operator") || "operator";

    try {
      if (request.method === "GET" && path === "/metrics") {
        const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
        const data = await this.getOrCollectMetrics(forceRefresh);
        return Response.json(data);
      }

      if (request.method === "GET" && path === "/ai-analysis") {
        const existing = await this.readStore<AiAnalysisPayload | null>("ai_analysis_cache", null);
        if (!existing) {
          const fresh = await this.runEvaluationCycle({
            forceAi: true,
            forceRefreshMetrics: false,
            allowTelegramAlert: false,
          });
          return Response.json(fresh);
        }
        const refreshed = await this.refreshPublicAiVerdict(undefined, undefined, existing.reason_code);
        return Response.json(refreshed);
      }

      if (request.method === "GET" && path === "/status") {
        const metrics = await this.getOrCollectMetrics(false);
        const state = await this.readStore<NocPersistentState>("noc_state", {});
        const evalRes = evaluateCloudTelemetry(metrics, state, new Date());
        return Response.json({
          ok: true,
          operator,
          active_anomalies: evalRes.activeAnomalies,
          snoozed_anomalies: evalRes.snoozedAnomalies,
          metrics_sync_utc: metrics.last_updated,
          rpi5_last_reported_utc: metrics.rpi5?.reported_at_utc || null,
          esp32_last_updated_utc: metrics.esp32?.last_updated_utc || null,
          telegram: {
            configured: Boolean(this.env.TELEGRAM_BOT_TOKEN && this.env.TELEGRAM_CHAT_ID),
            webhook_secret_set: Boolean(this.env.TELEGRAM_WEBHOOK_SECRET),
            ...(state.telegram || {}),
          },
          server_time_utc: formatUtcTimestamp(new Date()),
        });
      }

      if (request.method === "POST" && path === "/snooze") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const key = String(body.key ?? "").trim();
        const duration = String(body.duration ?? "24h").trim();
        if (!key) {
          return Response.json({ ok: false, error: "Missing required field 'key'" }, { status: 400 });
        }
        const res = await this.snoozeFinding(key, duration, operator);
        return Response.json({
          ok: true,
          snoozed: res.snoozed.length === 1 ? res.snoozed[0] : res.snoozed,
          snoozed_list: res.snoozed,
          count: res.count,
        });
      }

      if (request.method === "POST" && path === "/unsnooze") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const key = String(body.key ?? "").trim();
        if (!key) {
          return Response.json({ ok: false, error: "Missing required field 'key'" }, { status: 400 });
        }
        const removed = await this.unsnoozeFinding(key);
        return Response.json({ ok: true, unsnoozed: removed });
      }

      if (request.method === "POST" && path === "/analyze") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const refreshMetrics = body.refreshMetrics !== false;
        const aiPayload = await this.runEvaluationCycle({
          forceAi: true,
          forceRefreshMetrics: refreshMetrics,
          reasonOverride: "MANUAL_ANALYSIS",
          allowTelegramAlert: false,
        });
        return Response.json({ ok: true, ai_analysis: aiPayload });
      }

      if (request.method === "POST" && path === "/ask") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const question = String(body.question ?? "").trim();
        if (!question) {
          return Response.json({ ok: false, error: "Missing required field 'question'" }, { status: 400 });
        }
        const res = await this.askAnalyst(question);
        return Response.json({ ok: true, ...res });
      }

      if (request.method === "POST" && path === "/ingest/rpi5") {
        const body = (await request.json().catch(() => null)) as Record<string, any> | null;
        if (!body || typeof body !== "object") {
          return Response.json({ ok: false, error: "Invalid JSON payload for RPi5 ingest" }, { status: 400 });
        }
        const res = await this.ingestRpi5Telemetry(body);
        return Response.json(res);
      }

      if (request.method === "POST" && path === "/ingest/esp32") {
        const body = (await request.json().catch(() => null)) as Record<string, any> | null;
        if (!body || typeof body !== "object") {
          return Response.json({ ok: false, error: "Invalid JSON payload for ESP-32S ingest" }, { status: 400 });
        }
        const res = await this.ingestEsp32Telemetry(body);
        return Response.json(res);
      }

      if (request.method === "POST" && path === "/telegram/webhook") {
        const update = (await request.json().catch(() => null)) as Record<string, any> | null;
        if (!update || typeof update !== "object") {
          return Response.json({ ok: false, error: "Invalid Telegram update JSON" }, { status: 400 });
        }
        const res = await this.handleTelegramUpdate(update);
        return Response.json(res);
      }

      if (request.method === "POST" && path === "/telegram/setup") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const overrideUrl = typeof body.webhookUrl === "string" && body.webhookUrl.trim() ? body.webhookUrl.trim() : undefined;
        const res = await setupTelegramWebhookAndCommands(this.env, overrideUrl);
        return Response.json(res, { status: res.ok ? 200 : 400 });
      }

      if (request.method === "POST" && path === "/telegram/test") {
        const metrics = await this.getOrCollectMetrics(false);
        const state = await this.readStore<NocPersistentState>("noc_state", {});
        const aiPayload = await this.refreshPublicAiVerdict(metrics, state);
        const htmlOut = formatAlertNotificationHtml(metrics, aiPayload, "TEST_ALERT", this.getDashboardUrl());
        const sent = await sendTelegramHtml(this.env, htmlOut, {
          replyMarkup: buildQuickNavKeyboard(),
        });
        return Response.json(sent, { status: sent.ok ? 200 : 400 });
      }

      if (request.method === "GET" && path === "/telegram/status") {
        const state = await this.readStore<NocPersistentState>("noc_state", {});
        const configured = Boolean(this.env.TELEGRAM_BOT_TOKEN && this.env.TELEGRAM_CHAT_ID);
        let webhookInfo: any = null;
        if (configured) {
          const wh = await telegramApiCall(this.env, "getWebhookInfo");
          if (wh.ok) {
            webhookInfo = {
              url: wh.result?.url || "",
              pending_update_count: wh.result?.pending_update_count ?? 0,
              last_error_message: wh.result?.last_error_message || null,
            };
          }
        }
        return Response.json({
          ok: true,
          configured,
          webhook_secret_set: Boolean(this.env.TELEGRAM_WEBHOOK_SECRET),
          webhook_host: String(this.env.NOC_WEBHOOK_HOST || "noc-hook.tsimon.me"),
          webhook_info: webhookInfo,
          stats: state.telegram || {},
        });
      }

      if (request.method === "POST" && path === "/cron") {
        const aiPayload = await this.runEvaluationCycle({
          forceAi: false,
          forceRefreshMetrics: true,
          allowTelegramAlert: true,
        });
        return Response.json({ ok: true, ai_analysis: aiPayload });
      }

      return Response.json({ ok: false, error: `Unknown DO route: ${path}` }, { status: 404 });
    } catch (err: any) {
      return Response.json(
        { ok: false, error: String(err?.message ?? err) },
        { status: 400 },
      );
    }
  }
}
