import { type AnomalyFinding, type Env } from "./types.ts";

const DEFAULT_PRIMARY_MODEL = "@cf/google/gemma-3-12b-it";
const DEFAULT_FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function extractAiText(rawResponse: any): string {
  if (!rawResponse) {
    return "";
  }
  if (typeof rawResponse === "string") {
    return rawResponse.trim();
  }
  if (typeof rawResponse.response === "string") {
    return rawResponse.response.trim();
  }
  const choiceContent = rawResponse?.choices?.[0]?.message?.content;
  if (typeof choiceContent === "string") {
    return choiceContent.trim();
  }
  if (Array.isArray(choiceContent)) {
    return choiceContent
      .map((part: any) => (typeof part === "string" ? part : part?.text || ""))
      .join("")
      .trim();
  }
  return "";
}

async function runWorkersAiChat(
  env: Env,
  systemInstruction: string,
  userPrompt: string,
  maxTokens: number = 320,
): Promise<{ text: string; modelUsed: string; elapsedSec: number }> {
  const primaryModel = String(env.AI_MODEL || DEFAULT_PRIMARY_MODEL).trim();
  const fallbackModel = String(env.AI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL).trim();
  const candidates = Array.from(new Set([primaryModel, fallbackModel].filter(Boolean)));

  const t0 = performance.now();
  let lastError: unknown = null;

  if (env.AI && typeof env.AI.run === "function") {
    for (const modelId of candidates) {
      try {
        const res = await (env.AI as any).run(modelId, {
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: userPrompt },
          ],
          max_tokens: maxTokens,
          temperature: 0.2,
        });
        const text = extractAiText(res);
        if (text) {
          const elapsedSec = Math.round(((performance.now() - t0) / 1000) * 100) / 100;
          return {
            text,
            modelUsed: `${modelId} (Workers AI)`,
            elapsedSec,
          };
        }
      } catch (err) {
        lastError = err;
      }
    }
  }

  throw new Error(
    `Workers AI inference unavailable (${lastError instanceof Error ? lastError.message : String(lastError || "no AI binding")})`,
  );
}

export function buildDeterministicFallbackAnalysis(
  compactBrief: string,
  activeAnomalies: AnomalyFinding[],
): string {
  if (activeAnomalies.length === 0) {
    return [
      "* **Status**: All monitored Cloudflare zones, Serverless quotas (including 50B/mo D1 & DO SQL read ceilings), Raspberry Pi 5 edge host (vitals, Qdrant, sync, services), and ESP-32S watchdog are HEALTHY with 0 active warnings.",
      "* **Edge & Platform Summary**: All configured zones are routing normally with nominal HTTP 5xx rates (below the 100/hr × 2h alert rule) and no threat spikes.",
      "* **Edge Nodes Summary**: Raspberry Pi 5 vitals, Qdrant vector DB, Brain sync daemon, critical services, and ESP-32S ping/watchdog metrics are within nominal operating bounds.",
    ].join("\n");
  }

  const topFindings = activeAnomalies
    .map((a) => `[${a.severity}] ${a.title} (${a.detail})`)
    .join("; ");
  return [
    `* **Active Anomalies (${activeAnomalies.length})**: ${topFindings}`,
    `* **Telemetry Context**: ${compactBrief.split("\n").slice(1, 5).join(" | ")}`,
    `* **Recommended Action**: Inspect affected Cloudflare, Raspberry Pi 5, or ESP-32S components in the dashboard or snooze acknowledged findings via Web UI or Telegram.`,
  ].join("\n");
}

export async function runAutomatedNocAnalysis(
  env: Env,
  compactBrief: string,
  reasonCode: string,
  activeAnomalies: AnomalyFinding[],
): Promise<{ text: string; modelUsed: string; elapsedSec: number }> {
  const hasActiveAnomalies = activeAnomalies.length > 0;

  const systemInstruction = hasActiveAnomalies
    ? [
        "You are the Autonomous Cloudflare, Raspberry Pi 5 & ESP-32S Network Operations Center (NOC) AI Engineer running on Cloudflare Workers AI.",
        "Analyze the provided multi-layer telemetry snapshot accurately using ONLY the exact numbers given.",
        "STRICT CLOUDFLARE 5XX POLICY: Warn or advise on Cloudflare HTTP 5xx errors ONLY if a domain reaches >= 100 errors/hour across a 2-hour consecutive time span (listed under [DETECTED ACTIVE ANOMALIES]).",
        "If Cloudflare 5xx errors are not listed as an active anomaly, do NOT warn or advise about 5xx errors.",
        "Note: D1 and Durable Objects SQL Rows Read thresholds are 50 billion rows/month.",
        "Write a concise, high-signal assessment in 4 short bullet points covering:",
        "(1) Active Warning/Critical anomalies & root cause,",
        "(2) Cloudflare Edge domains & Serverless quotas status (Workers, DO, Workers AI, D1, KV, R2),",
        "(3) Raspberry Pi 5 (vitals, Qdrant, Brain sync, critical services) & ESP-32S watchdog status, and",
        "(4) Immediate recommended action for the active anomalies only.",
        "Keep total output under 170 words. Do not invent metrics.",
      ].join(" ")
    : [
        "You are the Autonomous Cloudflare, Raspberry Pi 5 & ESP-32S Network Operations Center (NOC) AI Engineer running on Cloudflare Workers AI.",
        "Analyze the provided multi-layer telemetry snapshot accurately using ONLY the exact numbers given.",
        "STRICT POLICY: Warn on Cloudflare HTTP 5xx errors ONLY if a domain reaches >= 100 errors/hour across a 2-hour consecutive time span.",
        "Because no domain has reached >= 100 5xx errors/hr for 2 consecutive hours and there are no active anomalies, do NOT warn, do NOT flag any issues, and do NOT advise or recommend any actions.",
        "Write a concise status summary in 4 short bullet points covering ONLY:",
        "(1) Status: Confirm all active Cloudflare, Raspberry Pi 5, and ESP-32S systems are healthy with no active warnings,",
        "(2) Cloudflare Edge domains traffic, cache hit ratio & security summary,",
        "(3) Serverless quotas summary (Workers & Pages, Durable Objects, Workers AI Neurons, D1 SQL, KV, R2), and",
        "(4) Raspberry Pi 5 (CPU/thermal/RAM/Qdrant/sync/services) & ESP-32S ping/watchdog summary.",
        "Do NOT include an Action or Recommendation bullet. Keep total output under 150 words.",
      ].join(" ");

  const userPrompt = hasActiveAnomalies
    ? `Trigger Type: ${reasonCode}\nTelemetry Snapshot:\n${compactBrief}\n\nProvide your concise 4-bullet NOC AI assessment:`
    : `Trigger Type: ${reasonCode}\nTelemetry Snapshot:\n${compactBrief}\n\nProvide your concise 4-bullet healthy NOC status summary (do not warn or advise):`;

  try {
    return await runWorkersAiChat(env, systemInstruction, userPrompt, 300);
  } catch {
    return {
      text: buildDeterministicFallbackAnalysis(compactBrief, activeAnomalies),
      modelUsed: "Deterministic Rule Engine (Fallback)",
      elapsedSec: 0.0,
    };
  }
}

export async function runInteractiveNocQuestion(
  env: Env,
  question: string,
  compactBrief: string,
): Promise<{ answer: string; modelUsed: string; elapsedSec: number }> {
  const systemInstruction = [
    "You are the Hybrid Edge NOC AI Assistant running on Cloudflare Workers AI.",
    "You have live access to the current NOC telemetry snapshot below covering Cloudflare Edge domains, Serverless Quotas (Workers & Pages, Durable Objects [50B/mo SQL reads], Workers AI Neurons, D1 SQL [50B/mo reads], Workers KV, R2), Raspberry Pi 5 (system vitals, Qdrant vector DB, Brain sync daemon, critical services), and the ESP-32S Out-of-Band Watchdog (ICMP ping, latency, Wi-Fi/heap, OOB Cloudflare probes).",
    "Cloudflare 5xx policy: Warn or advise on Cloudflare HTTP 5xx errors ONLY if a domain reaches >= 100 errors/hour across a 2-hour consecutive time span; otherwise do NOT warn or advise about 5xx errors.",
    "Answer the operator's question directly, accurately, and concisely using ONLY the live telemetry provided.",
    "Keep your response clear and under 220 words.",
  ].join(" ");

  const userPrompt = `Live NOC Telemetry:\n${compactBrief}\n\nOperator Question:\n${question}\n\nYour Answer:`;

  const res = await runWorkersAiChat(env, systemInstruction, userPrompt, 380);
  return {
    answer: res.text,
    modelUsed: res.modelUsed,
    elapsedSec: res.elapsedSec,
  };
}
