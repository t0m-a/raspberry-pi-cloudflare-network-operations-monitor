import {
  type AiAnalysisPayload,
  type AnomalyFinding,
  type CloudMetricsPayload,
  type Env,
  type NocPersistentState,
  type SnoozedAnomaly,
  QUOTAS,
  THRESHOLDS,
} from "./types.ts";

const TG_API_BASE = "https://api.telegram.org";
const MAX_TG_MSG_LEN = 3900;

export const TELEGRAM_BOT_COMMANDS = [
  { command: "status", description: "Master NOC overview across CF, RPi5 & ESP-32S" },
  { command: "full", description: "Exhaustive multi-section deep telemetry dump" },
  { command: "alerts", description: "Active anomalies, snoozed items & 5xx streak state" },
  { command: "cf", description: "Cloudflare Edge domains (traffic, CHR, threats, 5xx)" },
  { command: "5xx", description: "Dedicated HTTP 5xx hourly audit & 100/hr x 2h rule" },
  { command: "quotas", description: "All Cloudflare platform quotas & MTD billing" },
  { command: "workers", description: "Workers & Pages scripts, CPU, errors & assets" },
  { command: "do", description: "Durable Objects namespaces & 50B/mo SQL read quota" },
  { command: "d1", description: "D1 databases, storage & 50B/mo rows read quota" },
  { command: "ai", description: "Workers AI daily Neurons, tokens & per-model stats" },
  { command: "kv", description: "Workers KV operations, keys & namespaces" },
  { command: "r2", description: "R2 buckets, Class A/B ops, storage & egress" },
  { command: "pi", description: "Raspberry Pi 5 full vitals (CPU, temp, fan, RAM, disk, NIC)" },
  { command: "qdrant", description: "RPi5 Qdrant vector DB status" },
  { command: "sync", description: "Brain Edge Sync daemon, chunks & Qdrant federation" },
  { command: "services", description: "RPi5 critical systemd units, timers & Docker containers" },
  { command: "esp32", description: "ESP-32S ping, latency, 24h uptime, vitals & OOB probes" },
  { command: "snooze", description: "Snooze active findings (24h, 72h, 7d)" },
  { command: "unsnooze", description: "Reactivate snoozed findings" },
  { command: "analyze", description: "Run a fresh Workers AI NOC analysis right now" },
  { command: "refresh", description: "Force live Cloudflare GraphQL/REST refresh now" },
  { command: "ask", description: "Ask Workers AI NOC Engineer anything about live metrics" },
  { command: "help", description: "List all exhaustive NOC commands & usage" },
];

export function escapeTgHtml(raw: unknown): string {
  return String(raw ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Deterministic 8-hex-char short hash for Telegram 64-byte callback_data safety */
export function shortKeyHash(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function resolveShortKey(hashOrKey: string, candidates: string[]): string {
  if (candidates.includes(hashOrKey)) {
    return hashOrKey;
  }
  for (const c of candidates) {
    if (shortKeyHash(c) === hashOrKey) {
      return c;
    }
  }
  return hashOrKey;
}

export function splitTelegramMessage(htmlText: string, maxLen: number = MAX_TG_MSG_LEN): string[] {
  const clean = htmlText.trim();
  if (clean.length <= maxLen) {
    return [clean];
  }
  const chunks: string[] = [];
  const lines = clean.split("\n");
  let current = "";

  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen) {
      if (current.trim()) {
        chunks.push(current.trimEnd());
      }
      if (line.length > maxLen) {
        let rest = line;
        while (rest.length > maxLen) {
          chunks.push(rest.slice(0, maxLen));
          rest = rest.slice(maxLen);
        }
        current = rest;
      } else {
        current = line;
      }
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current.trim()) {
    chunks.push(current.trimEnd());
  }
  return chunks.length > 0 ? chunks : [clean.slice(0, maxLen)];
}

export function getAllowedChatIds(env: Env): string[] {
  return String(env.TELEGRAM_CHAT_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAuthorizedTelegramUser(env: Env, chatId: string, senderId?: string): boolean {
  const allowed = getAllowedChatIds(env);
  if (allowed.length === 0) {
    // Fail-closed: refuse commands if TELEGRAM_CHAT_ID is not configured
    return false;
  }
  return allowed.includes(chatId) || (Boolean(senderId) && allowed.includes(String(senderId)));
}

export async function telegramApiCall(
  env: Env,
  method: string,
  payload?: Record<string, unknown>,
): Promise<{ ok: boolean; result?: any; description?: string; status?: number }> {
  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) {
    return { ok: false, description: "TELEGRAM_BOT_TOKEN secret is not configured" };
  }
  const url = `${TG_API_BASE}/bot${token}/${method}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    const body = (await resp.json().catch(() => ({}))) as Record<string, any>;
    return {
      ok: Boolean(body.ok),
      result: body.result,
      description: body.description,
      status: resp.status,
    };
  } catch (err: any) {
    return { ok: false, description: String(err?.message ?? err) };
  }
}

export async function sendTelegramHtml(
  env: Env,
  htmlText: string,
  options: {
    chatId?: string;
    replyToMessageId?: number;
    replyMarkup?: Record<string, unknown>;
  } = {},
): Promise<{ ok: boolean; messageIds: number[]; error?: string }> {
  const targetChatId = options.chatId || getAllowedChatIds(env)[0];
  if (!targetChatId) {
    return { ok: false, messageIds: [], error: "TELEGRAM_CHAT_ID not configured" };
  }

  const chunks = splitTelegramMessage(htmlText);
  const messageIds: number[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const payload: Record<string, unknown> = {
      chat_id: targetChatId,
      text: chunks[i],
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (i === 0 && options.replyToMessageId) {
      payload.reply_to_message_id = options.replyToMessageId;
    }
    if (isLast && options.replyMarkup) {
      payload.reply_markup = options.replyMarkup;
    }
    const res = await telegramApiCall(env, "sendMessage", payload);
    if (!res.ok) {
      return {
        ok: false,
        messageIds,
        error: res.description || `Telegram HTTP ${res.status}`,
      };
    }
    if (res.result?.message_id) {
      messageIds.push(Number(res.result.message_id));
    }
  }
  return { ok: true, messageIds };
}

export async function setupTelegramWebhookAndCommands(
  env: Env,
  webhookUrlOverride?: string,
): Promise<{ ok: boolean; webhookUrl: string; webhookRes: any; commandsRes: any; botInfo?: any }> {
  const hookHost = String(env.NOC_WEBHOOK_HOST || "noc-hook.tsimon.me").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const webhookUrl = webhookUrlOverride || `https://${hookHost}/api/telegram/webhook`;
  const secretToken = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();

  const webhookPayload: Record<string, unknown> = {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  };
  if (secretToken) {
    webhookPayload.secret_token = secretToken;
  }

  const [webhookRes, commandsRes, meRes] = await Promise.all([
    telegramApiCall(env, "setWebhook", webhookPayload),
    telegramApiCall(env, "setMyCommands", { commands: TELEGRAM_BOT_COMMANDS }),
    telegramApiCall(env, "getMe"),
  ]);

  return {
    ok: Boolean(webhookRes.ok && commandsRes.ok),
    webhookUrl,
    webhookRes,
    commandsRes,
    botInfo: meRes.ok ? meRes.result : undefined,
  };
}

// ============================================================================
// INLINE KEYBOARD BUILDERS
// ============================================================================

export function buildQuickNavKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: "📊 Status", callback_data: "nav:status" },
        { text: "☁️ CF Edge", callback_data: "nav:cf" },
        { text: "📈 Quotas", callback_data: "nav:quotas" },
      ],
      [
        { text: "🍓 Pi 5", callback_data: "nav:pi" },
        { text: "🔍 Qdrant", callback_data: "nav:qdrant" },
        { text: "🔄 Sync", callback_data: "nav:sync" },
      ],
      [
        { text: "⚙️ Services", callback_data: "nav:services" },
        { text: "📡 ESP-32S", callback_data: "nav:esp32" },
        { text: "🚨 Alerts", callback_data: "nav:alerts" },
      ],
    ],
  };
}

export function buildSnoozeKeyboard(
  activeAnomalies: AnomalyFinding[],
  snoozedAnomalies: SnoozedAnomaly[] = [],
  includeQuickNav: boolean = true,
): Record<string, unknown> | undefined {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  for (const a of activeAnomalies.slice(0, 6)) {
    const h = shortKeyHash(a.key);
    const label = a.title.length > 22 ? `${a.title.slice(0, 21)}…` : a.title;
    rows.push([
      { text: `💤 24h: ${label}`, callback_data: `snz:${h}:24h` },
      { text: "72h", callback_data: `snz:${h}:72h` },
      { text: "7d", callback_data: `snz:${h}:7d` },
    ]);
  }

  if (activeAnomalies.length > 1) {
    rows.push([
      { text: "💤 Snooze All 24h", callback_data: "snz_all:24h" },
      { text: "All 72h", callback_data: "snz_all:72h" },
      { text: "All 7d", callback_data: "snz_all:7d" },
    ]);
  }

  if (snoozedAnomalies.length > 0) {
    rows.push([{ text: `🔔 Unsnooze All (${snoozedAnomalies.length})`, callback_data: "unsnz:all" }]);
  }

  if (includeQuickNav) {
    rows.push([
      { text: "🍓 Pi 5", callback_data: "nav:pi" },
      { text: "📡 ESP-32S", callback_data: "nav:esp32" },
      { text: "☁️ CF Edge", callback_data: "nav:cf" },
    ]);
  }

  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

// ============================================================================
// EXHAUSTIVE TELEMETRY FORMATTERS (HTML)
// ============================================================================

function fmtNum(n: unknown): string {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v.toLocaleString("en-US") : "0";
}

function pctIcon(pct: number): string {
  if (pct >= 80) return "🔴";
  if (pct >= 60) return "🟡";
  return "🟢";
}

export function formatAlertNotificationHtml(
  metrics: CloudMetricsPayload,
  aiPayload: AiAnalysisPayload,
  reasonCode: string,
  dashboardUrl: string = "https://noc.tsimon.me/",
): string {
  const anomalies = aiPayload.anomalies || [];
  const snoozed = aiPayload.snoozed_anomalies || [];
  const hasCrit = anomalies.some((a) => a.severity === "CRITICAL");
  const hasWarn = anomalies.some((a) => a.severity === "WARNING");

  let header = "🟢 <b>NOC STATUS REPORT: HEALTHY</b>";
  if (reasonCode === "ALL_CLEAR_RESOLVED") {
    header = "✅ <b>NOC RECOVERY: ALL SYSTEMS HEALTHY</b>";
  } else if (reasonCode === "ESCALATED_CRITICAL" || hasCrit) {
    header = "🚨 <b>NOC ALERT: CRITICAL CONDITION DETECTED</b>";
  } else if (hasWarn) {
    header = "⚠️ <b>NOC ALERT: WARNING CONDITION DETECTED</b>";
  } else if (reasonCode === "TEST_ALERT") {
    header = "🧪 <b>NOC TELEGRAM ALERT TEST</b>";
  }

  const lines: string[] = [
    header,
    `<i>Trigger: <code>${escapeTgHtml(reasonCode)}</code> • Sync: ${escapeTgHtml(metrics.last_updated)}</i>`,
    "",
  ];

  if (anomalies.length > 0) {
    lines.push(`<b>Active Findings (${anomalies.length}):</b>`);
    anomalies.forEach((a, idx) => {
      const icon = a.severity === "CRITICAL" ? "🔴" : "🟡";
      lines.push(
        `${idx + 1}. ${icon} <b>[${escapeTgHtml(a.category)}] ${escapeTgHtml(a.title)}</b>\n   <i>${escapeTgHtml(a.detail)}</i>`,
      );
    });
    lines.push("");
  }

  if (snoozed.length > 0) {
    lines.push(`💤 <b>Snoozed (${snoozed.length}):</b>`);
    for (const s of snoozed) {
      lines.push(`• ${escapeTgHtml(s.title)} <i>(${escapeTgHtml(s.duration_str)} • ${escapeTgHtml(s.remaining_human || "")} left)</i>`);
    }
    lines.push("");
  }

  // Multi-layer quick pulse
  const domEntries = Object.entries(metrics.domains || {});
  if (domEntries.length > 0) {
    const domStr = domEntries
      .map(([d, m]) => {
        const ok = m.status === "HEALTHY" && !m.errors_5xx_2h_consecutive_over_100;
        return `${ok ? "🟢" : "🟠"} ${escapeTgHtml(d)} (${fmtNum(m.hit_volume)}r, ${m.errors_5xx} 5xx)`;
      })
      .join(" | ");
    lines.push(`<b>☁️ Edge (1h):</b> ${domStr}`);
  }

  if (metrics.rpi5) {
    const r = metrics.rpi5;
    const rootFs = (r.storage || []).find((s) => s.mountpoint === "/") || r.storage?.[0];
    lines.push(
      `<b>🍓 RPi5:</b> CPU ${r.cpu?.usage_pct ?? 0}% | SoC ${r.thermals?.soc_temp_c ?? "?"}°C | RAM ${r.memory?.ram_usage_pct ?? 0}% | ` +
        `Disk ${rootFs?.usage_pct ?? "?"}% | Qdrant ${escapeTgHtml((r.qdrant?.status || "offline").toUpperCase())} (${fmtNum(r.qdrant?.points_count)} pts) | ` +
        `Sync ${r.sync?.service_active ? "ACTIVE" : "DOWN"}`,
    );
  }

  if (metrics.esp32) {
    const e = metrics.esp32;
    lines.push(
      `<b>📡 ESP-32S:</b> ${e.ping?.reachable ? "🟢 ONLINE" : "🔴 OFFLINE"} (${escapeTgHtml(e.ping?.target_ip || "--")}) | ` +
        `RTT ${e.ping?.rtt_avg_ms ?? "N/A"}ms | Loss ${e.ping?.packet_loss_pct ?? "?"}%` +
        (e.history ? ` | 24h ${e.history.uptime_pct_24h}%` : ""),
    );
  }

  if (aiPayload.analysis) {
    lines.push("");
    lines.push(`🤖 <b>Workers AI Assessment</b> <i>(${escapeTgHtml(aiPayload.model)}, ${aiPayload.inference_duration_sec}s)</i>:`);
    lines.push(escapeTgHtml(aiPayload.analysis));
  }

  lines.push("");
  lines.push(`🔗 <a href="${escapeTgHtml(dashboardUrl)}">Open Live NOC Dashboard</a> • /full • /help`);
  return lines.join("\n");
}

export function formatHelpHtml(): string {
  return [
    "🛡️ <b>Cloudflare, Raspberry Pi 5 &amp; ESP-32S NOC Bot</b>",
    "<i>Deep, exhaustive telemetry queries + Workers AI NOC Assistant</i>",
    "",
    "<b>📋 Executive &amp; Alerting</b>",
    "• <code>/status</code> — Master executive overview + latest AI verdict",
    "• <code>/full</code> — Exhaustive dump across ALL subsystems",
    "• <code>/alerts</code> — Active anomalies, snoozes &amp; alert history",
    "• <code>/snooze [num|key|all] [24h|72h|7d]</code> — Silence findings",
    "• <code>/unsnooze [num|key|all]</code> — Reactivate snoozed findings",
    "• <code>/analyze</code> — Force live refresh + fresh Workers AI evaluation",
    "• <code>/refresh</code> — Force live Cloudflare GraphQL/REST sync",
    "",
    "<b>☁️ Cloudflare Edge &amp; Serverless Quotas</b>",
    "• <code>/cf [domain]</code> — Edge zones traffic, bandwidth, CHR, WAF &amp; 5xx",
    "• <code>/5xx</code> — Dedicated HTTP 5xx hourly audit (≥100/hr × 2h rule)",
    "• <code>/quotas</code> — Account billing &amp; quotas across all 6 services",
    "• <code>/workers</code> — Every Worker/Pages script, CPU, errors &amp; static hosts",
    "• <code>/do</code> — Durable Objects namespaces &amp; 50B/mo SQL reads",
    "• <code>/d1</code> — D1 SQL clusters, storage &amp; 50B/mo rows read",
    "• <code>/ai</code> — Workers AI daily Neurons, tokens &amp; model breakdown",
    "• <code>/kv</code> — Workers KV daily R/W/D/L quotas &amp; namespaces",
    "• <code>/r2</code> — R2 Object Storage buckets, Class A/B ops &amp; egress",
    "",
    "<b>🍓 Raspberry Pi 5 (15m Cron Agent)</b>",
    "• <code>/pi</code> — Full system vitals (CPU, per-core, thermals, fan, RAM, swap, disks, NICs, Wi-Fi)",
    "• <code>/qdrant</code> — Qdrant vector DB, points, segments, disk &amp; latency",
    "• <code>/sync</code> — Gemini Brain watcher, synced chunks, federation &amp; uplink",
    "• <code>/services</code> — All critical systemd units, timers &amp; Docker containers",
    "",
    "<b>📡 ESP-32S Out-of-Band Watchdog</b>",
    "• <code>/esp32</code> — ICMP ping, RTT min/avg/max/jitter, loss, 24h uptime, Wi-Fi/heap &amp; OOB Cloudflare probes",
    "",
    "<b>🤖 Interactive Workers AI Q&amp;A</b>",
    "• <code>/ask &lt;question&gt;</code> or send <b>any plain-text question</b> directly in this chat!",
  ].join("\n");
}

export function formatCfDomainsHtml(metrics: CloudMetricsPayload, filterDomain?: string): string {
  const domains = metrics.domains || {};
  const entries = Object.entries(domains).filter(([d]) =>
    !filterDomain ? true : d.toLowerCase().includes(filterDomain.toLowerCase()),
  );

  const lines: string[] = [
    "☁️ <b>Cloudflare Edge Domains Telemetry (Past 1h)</b>",
    `<i>Sync: ${escapeTgHtml(metrics.last_updated)} • 5xx Alert Policy: ≥${THRESHOLDS.domain_5xx_warn}/hr for ${THRESHOLDS.domain_5xx_sustained_hours}h consecutive</i>`,
    "",
  ];

  if (entries.length === 0) {
    lines.push("No matching Cloudflare domains found.");
    return lines.join("\n");
  }

  for (const [dname, dm] of entries) {
    const ok = dm.status === "HEALTHY" && !dm.errors_5xx_2h_consecutive_over_100;
    const icon = ok ? "🟢" : "🟠";
    lines.push(`${icon} <b>${escapeTgHtml(dname)}</b> — <code>${escapeTgHtml(dm.status)}</code>`);
    lines.push(
      `   • Traffic: <b>${fmtNum(dm.hit_volume)}</b> reqs | Bandwidth: <b>${dm.bandwidth_gb} GB</b> | Cache Hit: <b>${dm.cache_hit_ratio}%</b>`,
    );
    lines.push(
      `   • WAF Threats: <b>${fmtNum(dm.security_events)}</b> | 5xx (latest 1h / prev 1h): <b>${fmtNum(dm.errors_5xx)}</b> / ${fmtNum(dm.errors_5xx_prev_hour)} | 2h≥100 Alert: <b>${dm.errors_5xx_2h_consecutive_over_100 ? "YES" : "No"}</b>`,
    );
    if (dm.errors_5xx_hourly && dm.errors_5xx_hourly.length > 0) {
      const bucketStr = dm.errors_5xx_hourly
        .map((b) => `${escapeTgHtml((b.hour_utc || "").slice(11, 16) || b.hour_utc)}=${b.errors_5xx}`)
        .join(", ");
      lines.push(`   • Hourly 5xx Buckets: <code>${bucketStr}</code>`);
    }
  }

  return lines.join("\n");
}

export function format5xxAuditHtml(metrics: CloudMetricsPayload, state: NocPersistentState): string {
  const streaks = state.domain_5xx_streak || {};
  const lines: string[] = [
    "🔎 <b>HTTP 5xx Error Audit &amp; Alert Rule Verification</b>",
    `<i>Active Policy: Do NOT alert unless ≥ ${THRESHOLDS.domain_5xx_warn} 5xx errors/hr across a ${THRESHOLDS.domain_5xx_sustained_hours}-hour consecutive span.</i>`,
    `<i>Sync: ${escapeTgHtml(metrics.last_updated)}</i>`,
    "",
  ];

  for (const [dname, dm] of Object.entries(metrics.domains || {})) {
    const streak = streaks[dname];
    const icon = dm.errors_5xx_2h_consecutive_over_100 ? "🔴" : (dm.errors_5xx >= 100 ? "🟡" : "🟢");
    lines.push(`${icon} <b>${escapeTgHtml(dname)}</b>`);
    lines.push(
      `   • Latest 1h: <b>${fmtNum(dm.errors_5xx)}</b> | Prev 1h: <b>${fmtNum(dm.errors_5xx_prev_hour)}</b> | 2h Consecutive ≥100: <b>${dm.errors_5xx_2h_consecutive_over_100 ? "TRIGGERED" : "No"}</b>`,
    );
    if (dm.errors_5xx_hourly?.length) {
      lines.push(
        `   • Buckets (UTC): <code>${dm.errors_5xx_hourly.map((b) => `${escapeTgHtml(b.hour_utc)}: ${b.errors_5xx}`).join(" | ")}</code>`,
      );
    }
    if (streak) {
      lines.push(
        `   • Active Streak: started ${escapeTgHtml(streak.first_exceeded_utc)} (${(streak.sustained_seconds / 3600).toFixed(2)}h elapsed)`,
      );
    }
  }
  return lines.join("\n");
}

export function formatQuotasHtml(metrics: CloudMetricsPayload): string {
  const wp = metrics.workers_and_pages;
  const ai = metrics.workers_ai;
  const d1 = metrics.d1_billing;
  const doU = metrics.durable_objects;
  const kv = metrics.kv_billing;
  const r2 = metrics.r2_billing;

  const d1ReadPct = d1?.monthly_rows_read_pct ?? d1?.daily_rows_read_pct ?? 0;
  const doReadPct = doU?.monthly_rows_read_pct ?? doU?.daily_rows_read_pct ?? 0;
  const totalUsd =
    Number(wp?.estimated_billable_usd || 0) +
    Number(ai?.estimated_billable_usd || 0) +
    Number(d1?.estimated_billable_usd || 0) +
    Number(doU?.estimated_billable_usd || 0) +
    Number(kv?.estimated_billable_usd || 0) +
    Number(r2?.estimated_billable_usd || 0);

  return [
    "📈 <b>Cloudflare Account Quotas &amp; MTD Billing</b>",
    `<i>Period: ${escapeTgHtml(metrics.billing_period?.month_start)} → ${escapeTgHtml(metrics.billing_period?.current_date_utc)} • Est. Billable: <b>$${totalUsd.toFixed(4)}</b></i>`,
    "",
    "<b>⚡ Workers &amp; Pages</b>",
    `• ${pctIcon(wp.daily_requests_pct)} Daily Reqs: <b>${fmtNum(wp.daily_requests)}</b> / ${fmtNum(wp.daily_requests_limit)} (${wp.daily_requests_pct}%)`,
    `• ${pctIcon(wp.monthly_build_minutes_pct)} Builds MTD: <b>${wp.mtd_build_minutes}m</b> / ${fmtNum(wp.monthly_build_minutes_limit)}m (${wp.monthly_build_minutes_pct}%)`,
    `• MTD Invocations: ${fmtNum(wp.mtd_worker_requests + wp.mtd_pages_requests)} | Subreqs: ${fmtNum(wp.mtd_subrequests)} | Errors: <b>${fmtNum(wp.mtd_errors)}</b> | Assets: ${fmtNum(wp.mtd_assets_requests)}`,
    "",
    "<b>🧱 Durable Objects</b>",
    `• ${pctIcon(doU.daily_requests_pct)} Daily Reqs: <b>${fmtNum(doU.daily_requests)}</b> / ${fmtNum(doU.daily_requests_limit)} (${doU.daily_requests_pct}%) | MTD: ${fmtNum(doU.mtd_requests)}`,
    `• ${pctIcon(doU.daily_duration_gbs_pct)} Daily Duration: <b>${doU.daily_duration_gbs}</b> / ${fmtNum(doU.daily_duration_gbs_limit)} GB-s (${doU.daily_duration_gbs_pct}%)`,
    `• ${pctIcon(doReadPct)} SQL Rows Read (Monthly 50B): <b>${fmtNum(doU.mtd_rows_read)}</b> / ${fmtNum(QUOTAS.do_monthly_rows_read_limit)} (${doReadPct}%) | Today: ${fmtNum(doU.daily_rows_read)}`,
    `• ${pctIcon(doU.daily_rows_written_pct)} SQL Rows Written (Daily): <b>${fmtNum(doU.daily_rows_written)}</b> / ${fmtNum(doU.daily_rows_written_limit)} (${doU.daily_rows_written_pct}%) | MTD: ${fmtNum(doU.mtd_rows_written)}`,
    `• ${pctIcon(doU.storage_pct)} Storage: <b>${doU.total_storage_mb} MB</b> / ${fmtNum(doU.storage_limit_mb)} MB (${doU.storage_pct}%) | Errors MTD: ${fmtNum(doU.mtd_errors)}`,
    "",
    "<b>🧠 Workers AI</b>",
    `• ${pctIcon(ai.daily_neurons_pct)} Daily Neurons: <b>${fmtNum(ai.daily_neurons)}</b> / ${fmtNum(ai.daily_neurons_limit)} (${ai.daily_neurons_pct}%)`,
    `• MTD Neurons: ${fmtNum(ai.mtd_neurons)} (Billable: ${fmtNum(ai.mtd_billable_neurons)}, $${ai.estimated_billable_usd.toFixed(4)}) | Reqs MTD: ${fmtNum(ai.mtd_requests)}`,
    "",
    "<b>🗄️ D1 Serverless SQL</b>",
    `• ${pctIcon(d1ReadPct)} Rows Read (Monthly 50B): <b>${fmtNum(d1.mtd_rows_read)}</b> / ${fmtNum(QUOTAS.d1_monthly_rows_read_limit)} (${d1ReadPct}%) | Today: ${fmtNum(d1.daily_rows_read)}`,
    `• ${pctIcon(d1.daily_rows_written_pct)} Rows Written (Daily): <b>${fmtNum(d1.daily_rows_written)}</b> / ${fmtNum(d1.daily_rows_written_limit)} (${d1.daily_rows_written_pct}%) | MTD: ${fmtNum(d1.mtd_rows_written)}`,
    `• ${pctIcon(d1.account_storage_pct)} Storage: <b>${d1.total_storage_mb} MB</b> / ${fmtNum(d1.account_storage_limit_mb)} MB (${d1.account_storage_pct}%)`,
    "",
    "<b>🔑 Workers KV</b>",
    `• Daily R/W/D/L: <b>${fmtNum(kv.daily_reads)}</b> (${kv.daily_reads_pct}%) / <b>${fmtNum(kv.daily_writes)}</b> (${kv.daily_writes_pct}%) / ${fmtNum(kv.daily_deletes)} (${kv.daily_deletes_pct}%) / ${fmtNum(kv.daily_lists)} (${kv.daily_lists_pct}%)`,
    `• ${pctIcon(kv.storage_pct)} Storage: <b>${kv.total_storage_mb} MB</b> / ${fmtNum(kv.storage_limit_mb)} MB (${kv.storage_pct}%) | Keys: ${fmtNum(kv.total_keys)}`,
    "",
    "<b>🪣 R2 Object Storage</b>",
    `• ${pctIcon(r2.monthly_class_a_pct)} Class A (MTD): <b>${fmtNum(r2.mtd_class_a_ops)}</b> / ${fmtNum(r2.monthly_class_a_limit)} (${r2.monthly_class_a_pct}%)`,
    `• ${pctIcon(r2.monthly_class_b_pct)} Class B (MTD): <b>${fmtNum(r2.mtd_class_b_ops)}</b> / ${fmtNum(r2.monthly_class_b_limit)} (${r2.monthly_class_b_pct}%)`,
    `• ${pctIcon(r2.storage_pct)} Storage: <b>${r2.total_storage_mb} MB</b> / ${fmtNum(r2.storage_limit_mb)} MB (${r2.storage_pct}%) | Objects: ${fmtNum(r2.total_objects)} | Egress: ${r2.mtd_egress_mb} MB ($0)`,
  ].join("\n");
}

export function formatWorkersDetailHtml(metrics: CloudMetricsPayload): string {
  const wp = metrics.workers_and_pages;
  const lines: string[] = [
    "⚡ <b>Workers &amp; Pages Detailed Breakdown</b>",
    `<i>Daily Reqs: ${fmtNum(wp.daily_requests)}/${fmtNum(wp.daily_requests_limit)} (${wp.daily_requests_pct}%) • MTD CPU: ${fmtNum(wp.mtd_cpu_time_ms)}ms • Errors: ${fmtNum(wp.mtd_errors)}</i>`,
    "",
    `<b>Scripts (${wp.scripts.length}):</b>`,
  ];
  for (const s of wp.scripts) {
    const icon = s.errors_mtd > 0 ? "🟡" : "🟢";
    lines.push(
      `${icon} <b>${escapeTgHtml(s.name)}</b> <i>[${escapeTgHtml(s.type)}]</i> — Today: ${fmtNum(s.requests_today)} | MTD: ${fmtNum(s.requests_mtd)} | Sub: ${fmtNum(s.subrequests_mtd)} | CPU: ${fmtNum(s.cpu_time_ms_mtd)}ms | Err: <b>${fmtNum(s.errors_mtd)}</b>`,
    );
  }
  if (wp.assets_hosts.length > 0) {
    lines.push("");
    lines.push(`<b>Static Asset Hostnames (${wp.assets_hosts.length}):</b>`);
    for (const a of wp.assets_hosts) {
      lines.push(`• <code>${escapeTgHtml(a.hostname)}</code> — Today: ${fmtNum(a.requests_today)} | MTD: ${fmtNum(a.requests_mtd)}`);
    }
  }
  return lines.join("\n");
}

export function formatDoDetailHtml(metrics: CloudMetricsPayload): string {
  const d = metrics.durable_objects;
  const readPct = d.monthly_rows_read_pct ?? d.daily_rows_read_pct;
  const lines: string[] = [
    "🧱 <b>Durable Objects Detailed Breakdown</b>",
    `<i>Daily Reqs: ${fmtNum(d.daily_requests)} (${d.daily_requests_pct}%) • Duration: ${d.daily_duration_gbs} GB-s (${d.daily_duration_gbs_pct}%)</i>`,
    `<i>SQL Reads (50B/mo): ${fmtNum(d.mtd_rows_read)} (${readPct}%) • Today: ${fmtNum(d.daily_rows_read)} • Storage: ${d.total_storage_mb} MB</i>`,
    "",
    `<b>Namespaces (${d.namespaces.length}):</b>`,
  ];
  for (const ns of d.namespaces) {
    const icon = ns.errors_mtd > 0 ? "🟡" : "🟢";
    lines.push(
      `${icon} <b>${escapeTgHtml(ns.name)}</b> <i>[${ns.use_sqlite ? "SQLite" : "KV"}]</i>\n` +
        `   Reqs: ${fmtNum(ns.requests_today)} today / ${fmtNum(ns.requests_mtd)} MTD | Dur: ${ns.duration_gbs_mtd} GB-s | Storage: ${ns.storage_mb} MB | Err: ${fmtNum(ns.errors_mtd)}\n` +
        `   SQL R/W Today: ${fmtNum(ns.rows_read_today)} / ${fmtNum(ns.rows_written_today)} | MTD: ${fmtNum(ns.rows_read_mtd)} / ${fmtNum(ns.rows_written_mtd)}`,
    );
  }
  return lines.join("\n");
}

export function formatD1DetailHtml(metrics: CloudMetricsPayload): string {
  const d1 = metrics.d1_billing;
  const readPct = d1.monthly_rows_read_pct ?? d1.daily_rows_read_pct;
  const lines: string[] = [
    "🗄️ <b>D1 Serverless SQL Detailed Breakdown</b>",
    `<i>Monthly Rows Read (50B/mo): <b>${fmtNum(d1.mtd_rows_read)}</b> (${readPct}%) • Today: ${fmtNum(d1.daily_rows_read)}</i>`,
    `<i>Daily Writes: ${fmtNum(d1.daily_rows_written)}/${fmtNum(d1.daily_rows_written_limit)} (${d1.daily_rows_written_pct}%) • Storage: ${d1.total_storage_mb}/${fmtNum(d1.account_storage_limit_mb)} MB (${d1.account_storage_pct}%)</i>`,
    "",
    `<b>Databases (${metrics.d1_databases.length}):</b>`,
  ];
  for (const db of metrics.d1_databases) {
    lines.push(
      `${pctIcon(db.capacity_pct)} <b>${escapeTgHtml(db.name)}</b> (<code>${escapeTgHtml(db.uuid.slice(0, 8))}</code>)\n` +
        `   Size: <b>${db.file_size_mb} MB</b> (${db.capacity_pct}% of 500 MB) | Queries MTD: ${fmtNum(db.read_queries)} R / ${fmtNum(db.write_queries)} W\n` +
        `   Rows Today: ${fmtNum(db.rows_read_today)} R / ${fmtNum(db.rows_written_today)} W | MTD: ${fmtNum(db.rows_read)} R / ${fmtNum(db.rows_written)} W`,
    );
  }
  return lines.join("\n");
}

export function formatAiDetailHtml(metrics: CloudMetricsPayload): string {
  const ai = metrics.workers_ai;
  const lines: string[] = [
    "🧠 <b>Workers AI Detailed Breakdown</b>",
    `<i>Daily Neurons: <b>${fmtNum(ai.daily_neurons)}</b> / ${fmtNum(ai.daily_neurons_limit)} (${ai.daily_neurons_pct}%) • Est. Billable: $${ai.estimated_billable_usd.toFixed(4)}</i>`,
    `<i>MTD: ${fmtNum(ai.mtd_neurons)} neurons | ${fmtNum(ai.mtd_requests)} reqs | Tokens: ${fmtNum(ai.mtd_input_tokens)} in / ${fmtNum(ai.mtd_output_tokens)} out | Compute: ${(ai.mtd_inference_time_ms / 1000).toFixed(1)}s</i>`,
    "",
    `<b>Models (${ai.models.length}):</b>`,
  ];
  for (const m of ai.models) {
    lines.push(
      `• <code>${escapeTgHtml(m.model_id)}</code>\n   Reqs: ${fmtNum(m.requests_today)} today / ${fmtNum(m.requests_mtd)} MTD | Neurons: ${fmtNum(m.neurons_mtd)} | Tokens: ${fmtNum(m.input_tokens_mtd)} in / ${fmtNum(m.output_tokens_mtd)} out | ${(m.inference_time_ms_mtd / 1000).toFixed(2)}s`,
    );
  }
  if (ai.models.length === 0) {
    lines.push("No model invocations recorded this billing period.");
  }
  return lines.join("\n");
}

export function formatKvDetailHtml(metrics: CloudMetricsPayload): string {
  const kv = metrics.kv_billing;
  const lines: string[] = [
    "🔑 <b>Workers KV Detailed Breakdown</b>",
    `<i>Today R/W/D/L: ${fmtNum(kv.daily_reads)} / ${fmtNum(kv.daily_writes)} / ${fmtNum(kv.daily_deletes)} / ${fmtNum(kv.daily_lists)} • Storage: ${kv.total_storage_mb} MB (${kv.storage_pct}%) • Keys: ${fmtNum(kv.total_keys)}</i>`,
    "",
    `<b>Namespaces (${kv.namespaces.length}):</b>`,
  ];
  for (const ns of kv.namespaces) {
    lines.push(
      `• <b>${escapeTgHtml(ns.title)}</b> (<code>${escapeTgHtml(ns.namespace_id.slice(0, 8))}</code>)\n` +
        `   Today: ${fmtNum(ns.reads_today)} R / ${fmtNum(ns.writes_today)} W | MTD: ${fmtNum(ns.reads_mtd)} R / ${fmtNum(ns.writes_mtd)} W / ${fmtNum(ns.deletes_mtd)} D / ${fmtNum(ns.lists_mtd)} L | ${fmtNum(ns.key_count)} keys (${ns.storage_mb} MB)`,
    );
  }
  return lines.join("\n");
}

export function formatR2DetailHtml(metrics: CloudMetricsPayload): string {
  const r2 = metrics.r2_billing;
  const lines: string[] = [
    "🪣 <b>R2 Object Storage Detailed Breakdown</b>",
    `<i>Class A: ${fmtNum(r2.mtd_class_a_ops)} (${r2.monthly_class_a_pct}%) • Class B: ${fmtNum(r2.mtd_class_b_ops)} (${r2.monthly_class_b_pct}%) • Storage: ${r2.total_storage_mb} MB (${r2.storage_pct}%) • Egress: ${r2.mtd_egress_mb} MB ($0)</i>`,
    "",
    `<b>Buckets (${r2.buckets.length}):</b>`,
  ];
  for (const b of r2.buckets) {
    lines.push(
      `• <b>${escapeTgHtml(b.name)}</b> — ${b.payload_size_mb} MB (+${b.metadata_size_mb} MB meta) | ${fmtNum(b.object_count)} objs\n` +
        `   Today: ${fmtNum(b.class_a_ops_today)} A / ${fmtNum(b.class_b_ops_today)} B | MTD: ${fmtNum(b.class_a_ops_mtd)} A / ${fmtNum(b.class_b_ops_mtd)} B | Egress: ${b.egress_mb_mtd} MB`,
    );
  }
  return lines.join("\n");
}

export function formatRpi5VitalsHtml(metrics: CloudMetricsPayload): string {
  const r = metrics.rpi5;
  if (!r) {
    return "🍓 <b>Raspberry Pi 5 Telemetry</b>\n\n⏳ Awaiting first 15-minute cron report from `/opt/noc-agent/rpi5_noc_reporter.py`.";
  }

  const h = r.host;
  const c = r.cpu;
  const t = r.thermals;
  const m = r.memory;
  const n = r.network;

  const lines: string[] = [
    `🍓 <b>Raspberry Pi 5 System Vitals (${escapeTgHtml(h.hostname)})</b>`,
    `<i>Reported: ${escapeTgHtml(r.reported_at_utc)} • Cron: every ${Math.round((r.cron_interval_sec || 900) / 60)}m • Uptime: ${escapeTgHtml(h.uptime_human)}</i>`,
    `<i>${escapeTgHtml(h.model)} • ${escapeTgHtml(h.os_pretty)} (${escapeTgHtml(h.kernel)})</i>`,
    "",
    "<b>⚙️ Compute &amp; Thermals</b>",
    `• ${pctIcon(c.usage_pct)} <b>CPU:</b> ${c.usage_pct}% @ ${c.freq_mhz}/${c.max_freq_mhz} MHz (${escapeTgHtml(c.governor)}) | Per-core: [${(c.per_core_pct || []).map((v) => `${v}%`).join(", ")}]`,
    `• ${pctIcon(c.load_pct)} <b>Load Avg (1m/5m/15m):</b> ${c.load_1m} / ${c.load_5m} / ${c.load_15m} (${c.load_pct}% of ${c.cores} cores) | Procs: ${h.processes_running}/${h.processes_total}`,
    `• ${t.soc_temp_c !== null && t.soc_temp_c >= 70 ? "🟠" : "🟢"} <b>Temps &amp; Cooling:</b> SoC <b>${t.soc_temp_c ?? "N/A"}°C</b> | RP1 ${t.rp1_temp_c ?? "N/A"}°C | Fan <b>${t.fan_rpm ?? "N/A"} RPM</b>${t.fan_pwm !== null ? ` (PWM ${t.fan_pwm})` : ""}`,
    `• ${t.throttled_now ? "🔴" : "🟢"} <b>Power &amp; Throttle:</b> Core ${t.core_volts ?? "N/A"}V | <code>${escapeTgHtml(t.throttled_hex)}</code> — ${escapeTgHtml(t.throttled_status)}`,
    "",
    "<b>💾 Memory &amp; Swap</b>",
    `• ${pctIcon(m.ram_usage_pct)} <b>RAM:</b> ${m.ram_usage_pct}% (${fmtNum(m.ram_used_mb)} / ${fmtNum(m.ram_total_mb)} MB • Avail: ${fmtNum(m.ram_available_mb)} MB • Cache: ${fmtNum(m.ram_cached_mb)} MB)`,
    `• ${pctIcon(m.swap_usage_pct)} <b>Swap:</b> ${m.swap_usage_pct}% (${fmtNum(m.swap_used_mb)} / ${fmtNum(m.swap_total_mb)} MB • Free: ${fmtNum(m.swap_free_mb)} MB)`,
    "",
    "<b>💽 Storage Filesystems</b>",
  ];

  for (const fs of r.storage || []) {
    lines.push(
      `• ${pctIcon(fs.usage_pct)} <code>${escapeTgHtml(fs.mountpoint)}</code> (${escapeTgHtml(fs.device)}): <b>${fs.usage_pct}%</b> (${fs.used_gb}/${fs.total_gb} GB, ${fs.free_gb} GB free${fs.inode_usage_pct !== null ? `, inodes ${fs.inode_usage_pct}%` : ""})`,
    );
  }

  lines.push("");
  lines.push(`<b>🌐 Network</b> (Primary: <code>${escapeTgHtml(n.primary_ip)}</code> | GW: <code>${escapeTgHtml(n.gateway_ip)}</code> ${n.gateway_rtt_ms !== null ? `• ${n.gateway_rtt_ms}ms` : ""})`);
  for (const nic of n.interfaces || []) {
    const ipv4 = (nic.ipv4 || []).join(", ") || "-";
    let wifiPart = "";
    if (nic.wifi_ssid) {
      wifiPart = ` | Wi-Fi: <b>${escapeTgHtml(nic.wifi_ssid)}</b> ${nic.wifi_rssi_dbm ?? "?"}dBm @ ${nic.wifi_freq_mhz ?? "?"}MHz`;
    }
    lines.push(
      `• <code>${escapeTgHtml(nic.name)}</code> [${escapeTgHtml(nic.operstate)}]: <code>${escapeTgHtml(ipv4)}</code> | ↓${nic.rx_mb}MB ↑${nic.tx_mb}MB | err ${nic.rx_errors}/${nic.tx_errors}${wifiPart}`,
    );
  }

  lines.push("");
  lines.push("💡 Deep dive: /qdrant • /sync • /services");
  return lines.join("\n");
}

export function formatQdrantHtml(metrics: CloudMetricsPayload): string {
  const q = metrics.rpi5?.qdrant;
  if (!q) {
    return "🔍 <b>Qdrant Vector DB Status</b>\n\n⏳ Awaiting RPi5 cron telemetry.";
  }

  const icon = q.reachable && q.healthz_ok && q.status.toLowerCase() === "green" ? "🟢" : "🔴";
  const lines = [
    `${icon} <b>RPi5 Qdrant Vector DB</b>`,
    `<i>Reported: ${escapeTgHtml(metrics.rpi5?.reported_at_utc)}</i>`,
    "",
    `• <b>Service Status:</b> <code>${escapeTgHtml(q.status.toUpperCase())}</code> | Healthz: ${q.healthz_ok ? "OK" : "FAIL"} | Version: <code>v${escapeTgHtml(q.version)}</code>`,
    `• <b>Collection:</b> <code>${escapeTgHtml(q.collection)}</code> (${q.collections_count} total collection(s))`,
    `• <b>Points Count:</b> <b>${fmtNum(q.points_count)}</b> | Indexed Vectors: ${fmtNum(q.indexed_vectors_count)}`,
    `• <b>Segments &amp; Optimizer:</b> ${q.segments_count} segment(s) | Optimizer: <code>${escapeTgHtml(q.optimizer_status)}</code>`,
    `• <b>Vector Space:</b> ${q.vector_size} dims • ${escapeTgHtml(q.distance)} similarity`,
    `• <b>Disk Storage:</b> <b>${q.disk_usage_mb} MB</b> | API Latency: <b>${q.api_latency_ms ?? "N/A"} ms</b>`,
    `• <b>Container (edge-qdrant):</b> ${escapeTgHtml(q.container_status)} (${escapeTgHtml(q.container_uptime)})${q.container_rss_mb !== null ? ` • RSS ${q.container_rss_mb} MB` : ""}`,
  ];
  if (q.error) {
    lines.push(`• ⚠️ <b>Error:</b> <code>${escapeTgHtml(q.error)}</code>`);
  }
  return lines.join("\n");
}

export function formatSyncHtml(metrics: CloudMetricsPayload): string {
  const s = metrics.rpi5?.sync;
  if (!s) {
    return "🔄 <b>Gemini Brain Edge Sync Status</b>\n\n⏳ Awaiting RPi5 cron telemetry.";
  }

  const icon = s.service_active && s.brain_uplink_ok ? "🟢" : "🔴";
  const prefixLines = Object.entries(s.chunks_by_prefix || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<code>${escapeTgHtml(k)}</code>: <b>${fmtNum(v)}</b>`)
    .join(" • ");

  const lines = [
    `${icon} <b>RPi5 Brain Edge Sync (gemini-brain-watcher)</b>`,
    `<i>Reported: ${escapeTgHtml(metrics.rpi5?.reported_at_utc)}</i>`,
    "",
    `• <b>Daemon Status:</b> ${s.service_active ? "🟢 ACTIVE" : "🔴 INACTIVE"} (<code>${escapeTgHtml(s.service_substate)}</code> • since ${escapeTgHtml(s.service_uptime || "--")}${s.service_rss_mb !== null ? ` • RSS ${s.service_rss_mb} MB` : ""})`,
    `• <b>Feature Flags:</b> RPI_SYNC=${s.enabled ? "ON" : "OFF"} | CLI_SYNC=${s.cli_sync_enabled ? "ON" : "OFF"}`,
    `• <b>Brain Uplink (brain.tsimon.me):</b> ${s.brain_uplink_ok ? "🟢 REACHABLE" : "🔴 UNREACHABLE"} (HTTP ${s.brain_uplink_http_code ?? "ERR"}, ${s.brain_uplink_latency_ms ?? "?"}ms)`,
    "",
    "<b>📦 Synced State Cache (SQLite)</b>",
    `• <b>Total Synced Chunks:</b> <b>${fmtNum(s.total_synced_chunks)}</b> (DB size: ${s.state_db_size_mb} MB)`,
    `• <b>Breakdown:</b> ${prefixLines || "none"}`,
    `• <b>Last Chunk Synced:</b> <code>${escapeTgHtml(s.last_chunk_synced_utc || "N/A")}</code>`,
    "",
    "<b>🔁 Qdrant Federation Pass</b>",
    `• <b>Last Pass:</b> <code>${escapeTgHtml(s.last_qdrant_pass_utc || "N/A")}</code>`,
    `• <b>Scanned:</b> ${fmtNum(s.last_qdrant_scanned)} pts | <b>Newly Synced:</b> ${fmtNum(s.last_qdrant_newly_synced)}`,
    `• <b>Watch Dirs:</b> <code>${escapeTgHtml((s.watch_dirs || []).join(", ") || "N/A")}</code>`,
    `• <b>Recent Errors (journald):</b> ${s.recent_errors_count > 0 ? `🟡 ${s.recent_errors_count}` : "🟢 0"}`,
  ];
  if (s.recent_error_sample) {
    lines.push(`   ↳ <code>${escapeTgHtml(s.recent_error_sample.slice(0, 180))}</code>`);
  }
  return lines.join("\n");
}

export function formatServicesHtml(metrics: CloudMetricsPayload): string {
  const services = metrics.rpi5?.services;
  if (!services || services.length === 0) {
    return "⚙️ <b>RPi5 Critical Services</b>\n\n⏳ Awaiting RPi5 cron telemetry.";
  }

  const activeCnt = services.filter((s) => s.active).length;
  const critDown = services.filter((s) => s.critical && !s.active).length;
  const lines = [
    `${critDown > 0 ? "🚨" : "🟢"} <b>RPi5 Critical Services (${activeCnt}/${services.length} Active)</b>`,
    `<i>Reported: ${escapeTgHtml(metrics.rpi5?.reported_at_utc)}</i>`,
    "",
  ];

  for (const s of services) {
    const icon = s.active ? "🟢" : (s.critical ? "🔴" : "🟡");
    const critBadge = s.critical ? " [CRIT]" : "";
    const meta: string[] = [];
    if (s.rss_mb !== null) meta.push(`${s.rss_mb} MB`);
    if (s.pid) meta.push(`PID ${s.pid}`);
    if (s.restarts > 0) meta.push(`${s.restarts} restarts`);
    lines.push(
      `${icon} <b>${escapeTgHtml(s.display_name || s.name)}</b> <i>(${escapeTgHtml(s.type)}${critBadge})</i> — <code>${escapeTgHtml(s.status)}/${escapeTgHtml(s.substate)}</code>` +
        (meta.length ? ` • ${meta.join(", ")}` : "") +
        (s.health_detail ? `\n   ↳ <i>${escapeTgHtml(s.health_detail)}</i>` : ""),
    );
  }
  return lines.join("\n");
}

export function formatEsp32Html(metrics: CloudMetricsPayload): string {
  const e = metrics.esp32;
  if (!e) {
    return "📡 <b>ESP-32S Out-of-Band Watchdog</b>\n\n⏳ Awaiting initial LAN ping probe from RPi5 or direct heartbeat push.";
  }

  const p = e.ping;
  const d = e.device;
  const oob = e.oob_watchdog;
  const h = e.history;

  const topIcon = p?.reachable === false ? "🔴" : "🟢";
  const lines: string[] = [
    `${topIcon} <b>ESP-32S Out-of-Band Watchdog Monitor</b>`,
    `<i>Updated: ${escapeTgHtml(e.last_updated_utc)}</i>`,
    "",
  ];

  if (p) {
    lines.push("<b>🏓 ICMP Ping &amp; LAN Presence</b>");
    lines.push(
      `• <b>Status:</b> ${p.reachable ? "🟢 REACHABLE" : "🔴 UNREACHABLE"} | IP: <code>${escapeTgHtml(p.target_ip)}</code> | MAC: <code>${escapeTgHtml(p.mac)}</code> (${escapeTgHtml(p.vendor)})`,
    );
    lines.push(
      `• <b>Latency (ms):</b> Avg <b>${p.rtt_avg_ms ?? "N/A"}</b> | Min ${p.rtt_min_ms ?? "N/A"} | Max ${p.rtt_max_ms ?? "N/A"} | Jitter ${p.rtt_jitter_ms ?? "N/A"}`,
    );
    lines.push(
      `• <b>Packet Loss:</b> <b>${p.packet_loss_pct}%</b> (${p.packets_received}/${p.packets_sent}) | TTL: ${p.ttl ?? "?"} | ARP: <code>${escapeTgHtml(p.arp_state)}</code> via <code>${escapeTgHtml(p.interface)}</code>`,
    );
    lines.push(`• <b>Probed:</b> ${escapeTgHtml(p.probed_at_utc)} from <code>${escapeTgHtml(p.probed_from)}</code>`);
  }

  if (h) {
    lines.push("");
    lines.push("<b>📊 24h Availability &amp; Trend</b>");
    lines.push(
      `• <b>24h Uptime:</b> <b>${h.uptime_pct_24h}%</b> (${h.samples_24h} samples) | Streak: ${h.consecutive_failures > 0 ? `🔴 ${h.consecutive_failures} fails` : `🟢 ${h.consecutive_successes} ok`}`,
    );
    lines.push(
      `• <b>24h RTT (ms):</b> Avg ${h.avg_rtt_24h_ms ?? "N/A"} | Min ${h.min_rtt_24h_ms ?? "N/A"} | Max ${h.max_rtt_24h_ms ?? "N/A"} | Last Online: ${escapeTgHtml(h.last_seen_online_utc || "--")}`,
    );
  }

  if (d) {
    lines.push("");
    lines.push("<b>📟 ESP-32S Hardware &amp; Wi-Fi Vitals</b>");
    lines.push(
      `• <b>SoC:</b> ${escapeTgHtml(d.chip_model)} @ ${d.cpu_freq_mhz} MHz | Flash: ${d.flash_size_mb} MB | FW: <code>${escapeTgHtml(d.firmware_version)}</code> (SDK ${escapeTgHtml(d.sdk_version)})`,
    );
    lines.push(
      `• <b>Uptime &amp; Boot:</b> <b>${escapeTgHtml(d.uptime_human)}</b> | Reset: <code>${escapeTgHtml(d.reset_reason)}</code>` +
        (d.internal_temp_c !== null ? ` | Temp: ${d.internal_temp_c}°C` : ""),
    );
    lines.push(
      `• <b>Wi-Fi Radio:</b> SSID <b>${escapeTgHtml(d.wifi_ssid)}</b> (Ch ${d.wifi_channel}) | RSSI <b>${d.wifi_rssi_dbm} dBm</b> (${d.wifi_signal_pct}%) | Reconnects: ${d.wifi_reconnects}`,
    );
    lines.push(
      `• <b>SRAM Heap:</b> Free <b>${d.free_heap_kb} KB</b> / ${d.total_heap_kb} KB | Min: ${d.min_free_heap_kb} KB | MaxBlk: ${d.max_alloc_heap_kb} KB | Frag: ${d.heap_frag_pct}%`,
    );
    lines.push(
      `• <b>Watchdog Counters:</b> Polls: ${fmtNum(d.poll_cycles)} | Probe Fails: ${fmtNum(d.total_probe_failures)} | OOB Alerts: ${fmtNum(d.telegram_alerts_sent)}`,
    );
  } else {
    lines.push("");
    lines.push("<i>ℹ️ Flash updated esp32-monitor firmware to unlock live Wi-Fi RSSI, SRAM heap, uptime, reset reason, and OOB Cloudflare probe telemetry.</i>");
  }

  if (oob) {
    lines.push("");
    lines.push(
      `<b>☁️ OOB Cloudflare Global:</b> ${oob.cf_global_indicator === "none" ? "✅" : "⚠️"} <code>${escapeTgHtml(oob.cf_global_indicator)}</code> — ${escapeTgHtml(oob.cf_global_description)}` +
        (oob.cf_global_incident ? `\n   ↳ <i>${escapeTgHtml(oob.cf_global_incident)}</i>` : ""),
    );
    for (const ep of oob.endpoints || []) {
      const eIcon = ep.state === "UP" ? "✅" : ep.state === "SLOW" ? "🟡" : ep.state === "DOWN" ? "🔴" : "⚪";
      lines.push(
        `${eIcon} <b>${escapeTgHtml(ep.name)}</b> — <code>${ep.state}</code> (HTTP ${ep.http_code}, ${ep.latency_ms}ms${ep.last_error ? `, ${escapeTgHtml(ep.last_error)}` : ""})`,
      );
    }
  }

  return lines.join("\n");
}

export function formatAlertsDetailHtml(
  aiPayload: AiAnalysisPayload,
  state: NocPersistentState,
): string {
  const active = aiPayload.anomalies || [];
  const snoozed = aiPayload.snoozed_anomalies || [];
  const tg = state.telegram || {};

  const lines: string[] = [
    `${active.length > 0 ? "🚨" : "🟢"} <b>NOC Alerts, Snoozes &amp; Notification Telemetry</b>`,
    `<i>Overall: <b>${aiPayload.overall_status}</b> • Last Alert: ${escapeTgHtml(tg.last_alert_utc || "None")} (${tg.alerts_sent_total ?? 0} sent)</i>`,
    "",
  ];

  if (active.length > 0) {
    lines.push(`<b>Active Anomalies (${active.length}):</b>`);
    active.forEach((a, i) => {
      const icon = a.severity === "CRITICAL" ? "🔴" : "🟡";
      lines.push(
        `${i + 1}. ${icon} <b>[${escapeTgHtml(a.category)}] ${escapeTgHtml(a.title)}</b>\n   Key: <code>${escapeTgHtml(a.key)}</code>\n   <i>${escapeTgHtml(a.detail)}</i>`,
      );
    });
  } else {
    lines.push("🟢 <b>0 Active Anomalies</b> — All systems healthy.");
  }

  lines.push("");
  if (snoozed.length > 0) {
    lines.push(`<b>💤 Snoozed Assessments (${snoozed.length}):</b>`);
    snoozed.forEach((s, i) => {
      lines.push(
        `${i + 1}. <b>${escapeTgHtml(s.title)}</b> (<code>${escapeTgHtml(s.key)}</code>)\n   <i>${escapeTgHtml(s.duration_str)} • ${escapeTgHtml(s.remaining_human || "")} left • expires ${escapeTgHtml(s.snoozed_until_utc)} • by ${escapeTgHtml(s.snoozed_by)}</i>`,
      );
    });
  } else {
    lines.push("<i>No snoozed findings.</i>");
  }

  return lines.join("\n");
}

export function formatFullReportHtml(
  metrics: CloudMetricsPayload,
  aiPayload: AiAnalysisPayload,
  state: NocPersistentState,
  dashboardUrl: string,
): string {
  return [
    formatAlertNotificationHtml(metrics, aiPayload, "FULL_REPORT", dashboardUrl),
    "━━━━━━━━━━━━━━━━━━━━",
    formatCfDomainsHtml(metrics),
    "━━━━━━━━━━━━━━━━━━━━",
    formatQuotasHtml(metrics),
    "━━━━━━━━━━━━━━━━━━━━",
    formatRpi5VitalsHtml(metrics),
    "━━━━━━━━━━━━━━━━━━━━",
    formatQdrantHtml(metrics),
    "━━━━━━━━━━━━━━━━━━━━",
    formatSyncHtml(metrics),
    "━━━━━━━━━━━━━━━━━━━━",
    formatServicesHtml(metrics),
    "━━━━━━━━━━━━━━━━━━━━",
    formatEsp32Html(metrics),
  ].join("\n\n");
}

// ============================================================================
// COMMAND PARSER
// ============================================================================

export type ParsedTelegramAction =
  | { type: "HELP" }
  | { type: "STATUS" }
  | { type: "FULL" }
  | { type: "ALERTS" }
  | { type: "CF"; arg: string }
  | { type: "FIVE_XX" }
  | { type: "QUOTAS" }
  | { type: "WORKERS" }
  | { type: "DO" }
  | { type: "D1" }
  | { type: "AI" }
  | { type: "KV" }
  | { type: "R2" }
  | { type: "PI" }
  | { type: "QDRANT" }
  | { type: "SYNC" }
  | { type: "SERVICES" }
  | { type: "ESP32" }
  | { type: "SNOOZE"; arg: string }
  | { type: "UNSNOOZE"; arg: string }
  | { type: "ANALYZE" }
  | { type: "REFRESH" }
  | { type: "ASK"; question: string };

export function parseTelegramCommand(text: string, isPrivateChat: boolean): ParsedTelegramAction | null {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;

  const cmdMatch = trimmed.match(/^\/([a-zA-Z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (cmdMatch) {
    const cmd = cmdMatch[1].toLowerCase();
    const arg = (cmdMatch[2] || "").trim();
    switch (cmd) {
      case "start":
      case "help":
      case "commands":
        return { type: "HELP" };
      case "status":
      case "summary":
      case "noc":
        return { type: "STATUS" };
      case "full":
      case "report":
      case "all":
      case "dump":
        return { type: "FULL" };
      case "alerts":
      case "anomalies":
      case "findings":
        return { type: "ALERTS" };
      case "cf":
      case "cloudflare":
      case "domains":
      case "edge":
        return { type: "CF", arg };
      case "5xx":
      case "errors5xx":
        return { type: "FIVE_XX" };
      case "quotas":
      case "billing":
      case "limits":
        return { type: "QUOTAS" };
      case "workers":
      case "scripts":
      case "pages":
        return { type: "WORKERS" };
      case "do":
      case "durable":
      case "durableobjects":
        return { type: "DO" };
      case "d1":
      case "sql":
        return { type: "D1" };
      case "ai":
      case "neurons":
      case "workersai":
        return { type: "AI" };
      case "kv":
        return { type: "KV" };
      case "r2":
      case "buckets":
        return { type: "R2" };
      case "pi":
      case "rpi":
      case "rpi5":
      case "vitals":
      case "system":
      case "host":
        return { type: "PI" };
      case "qdrant":
      case "rag":
      case "vector":
        return { type: "QDRANT" };
      case "sync":
      case "watcher":
      case "brain":
        return { type: "SYNC" };
      case "services":
      case "svc":
      case "systemd":
      case "docker":
        return { type: "SERVICES" };
      case "esp32":
      case "esp":
      case "watchdog":
      case "ping":
        return { type: "ESP32" };
      case "snooze":
      case "mute":
      case "silence":
        return { type: "SNOOZE", arg };
      case "unsnooze":
      case "unmute":
      case "resume":
        return { type: "UNSNOOZE", arg };
      case "analyze":
      case "eval":
        return { type: "ANALYZE" };
      case "refresh":
      case "poll":
        return { type: "REFRESH" };
      case "ask":
      case "chat":
      case "gemma":
        return { type: "ASK", question: arg || "Give me a concise status summary across Cloudflare, Raspberry Pi 5, and ESP-32S." };
      default:
        return { type: "ASK", question: trimmed };
    }
  }

  // Natural language snooze/unsnooze shortcuts
  const snzNl = trimmed.match(/^(?:please\s+)?(?:snooze|silence|mute)\s+(.+?)(?:\s+for\s+|\s+)(\d+\s*(?:h|hr|hrs|hours|hour|d|day|days|w|week|weeks))?$/i);
  if (snzNl) {
    return { type: "SNOOZE", arg: `${snzNl[1].trim()} ${(snzNl[2] || "24h").trim()}` };
  }
  const unsnzNl = trimmed.match(/^(?:please\s+)?(?:unsnooze|unmute|reactivate)\s*(.*)$/i);
  if (unsnzNl) {
    return { type: "UNSNOOZE", arg: (unsnzNl[1] || "").trim() };
  }

  if (isPrivateChat) {
    return { type: "ASK", question: trimmed };
  }
  return null;
}
