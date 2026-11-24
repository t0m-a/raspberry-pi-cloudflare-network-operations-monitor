import { NocMonitorDO } from "./noc-do.ts";
import { type Env } from "./types.ts";

export { NocMonitorDO };

const CORS_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "X-Content-Type-Options": "nosniff",
};

function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function extractBearerToken(request: Request): string {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const fallback = request.headers.get("X-NOC-Ingest-Token") || "";
  return fallback.trim();
}

function verifyIngestAuth(request: Request, env: Env): { ok: boolean; status: number; error?: string } {
  const expected = String(env.NOC_INGEST_TOKEN || "").trim();
  if (!expected) {
    return { ok: false, status: 503, error: "NOC_INGEST_TOKEN secret is not configured on Worker" };
  }
  const provided = extractBearerToken(request);
  if (!provided || !timingSafeEqualStr(provided, expected)) {
    return { ok: false, status: 401, error: "Unauthorized: invalid ingest bearer token" };
  }
  return { ok: true, status: 200 };
}

function verifyTelegramWebhookSecret(request: Request, env: Env): { ok: boolean; status: number; error?: string } {
  const expected = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  if (!expected) {
    return { ok: false, status: 503, error: "TELEGRAM_WEBHOOK_SECRET is not configured on Worker" };
  }
  const provided = String(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "").trim();
  if (!provided || !timingSafeEqualStr(provided, expected)) {
    return { ok: false, status: 401, error: "Unauthorized: invalid Telegram webhook secret token" };
  }
  return { ok: true, status: 200 };
}

function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

/**
 * Optional Defense-in-Depth Cloudflare Access JWT verification.
 * When the subdomain is protected by Cloudflare Zero Trust Access, Cloudflare's edge proxy
 * enforces authentication before invoking the Worker and attaches:
 *   - Cf-Access-Authenticated-User-Email
 *   - Cf-Access-Jwt-Assertion
 * If CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are set in wrangler.toml, this function also
 * cryptographically verifies the RS256 JWT signature and audience inside the Worker.
 */
async function verifyCloudflareAccessRequest(
  request: Request,
  env: Env,
): Promise<{ authorized: boolean; email: string; reason?: string }> {
  const emailHeader = request.headers.get("Cf-Access-Authenticated-User-Email") || "";
  const teamDomain = String(env.CF_ACCESS_TEAM_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const expectedAud = String(env.CF_ACCESS_AUD || "").trim();

  if (!teamDomain || !expectedAud) {
    return {
      authorized: true,
      email: emailHeader || "cloudflare-access-user",
    };
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion") || "";
  if (!token) {
    return {
      authorized: false,
      email: "",
      reason: "Missing Cf-Access-Jwt-Assertion header",
    };
  }

  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return { authorized: false, email: "", reason: "Malformed Access JWT" };
    }

    const headerObj = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(parts[0])));
    const payloadObj = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(parts[1])));

    const nowSec = Math.floor(Date.now() / 1000);
    if (payloadObj.exp && Number(payloadObj.exp) < nowSec) {
      return { authorized: false, email: "", reason: "Access JWT expired" };
    }

    const audList: string[] = Array.isArray(payloadObj.aud) ? payloadObj.aud : [String(payloadObj.aud || "")];
    if (!audList.includes(expectedAud)) {
      return { authorized: false, email: "", reason: "Access JWT audience mismatch" };
    }

    const certsResp = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!certsResp.ok) {
      return { authorized: false, email: "", reason: "Unable to fetch Cloudflare Access public certs" };
    }
    const certsBody = (await certsResp.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
    const jwk = (certsBody.keys || []).find((k) => k.kid === headerObj.kid);
    if (!jwk) {
      return { authorized: false, email: "", reason: "No matching JWK kid found" };
    }

    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = base64UrlToUint8Array(parts[2]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, signedData);
    if (!valid) {
      return { authorized: false, email: "", reason: "Invalid Access JWT signature" };
    }

    return {
      authorized: true,
      email: String(payloadObj.email || emailHeader || "cloudflare-access-user"),
    };
  } catch (err: any) {
    return {
      authorized: false,
      email: "",
      reason: `Access JWT verification error: ${String(err?.message ?? err)}`,
    };
  }
}

function getNocStub(env: Env): DurableObjectStub {
  const id = env.NOC_MONITOR_DO.idFromName("global-cloudflare-noc");
  return env.NOC_MONITOR_DO.get(id);
}

function withStandardHeaders(resp: Response): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const host = url.hostname.toLowerCase();
    const webhookHost = String(env.NOC_WEBHOOK_HOST || "noc-hook.tsimon.me").trim().toLowerCase();
    const isHookHost = host === webhookHost;
    const stub = getNocStub(env);

    const forwardToDo = async (
      doPath: string,
      method: string = request.method,
      operatorEmail: string = "machine-client",
    ): Promise<Response> => {
      const targetUrl = new URL(`https://noc-do${doPath}${url.search}`);
      const headers = new Headers(request.headers);
      headers.set("X-Authenticated-Operator", operatorEmail);
      const bodyText = method !== "GET" && method !== "HEAD" ? await request.text() : undefined;
      const doReq = new Request(targetUrl.toString(), {
        method,
        headers,
        body: bodyText,
      });
      const resp = await stub.fetch(doReq);
      return withStandardHeaders(resp);
    };

    // ------------------------------------------------------------------------
    // Machine-to-Machine Secret-Authenticated Routes
    // Served on noc-hook.tsimon.me (and also accepted on noc.tsimon.me if bypassed)
    // ------------------------------------------------------------------------
    if (request.method === "GET" && path === "/health") {
      return Response.json(
        { ok: true, service: "cloudflare-noc-monitor", host, version: "2.1.0" },
        { status: 200, headers: CORS_HEADERS },
      );
    }

    if (request.method === "POST" && path === "/api/telegram/webhook") {
      const tgAuth = verifyTelegramWebhookSecret(request, env);
      if (!tgAuth.ok) {
        return Response.json({ ok: false, error: tgAuth.error }, { status: tgAuth.status, headers: CORS_HEADERS });
      }
      return forwardToDo("/telegram/webhook", "POST", "telegram-webhook");
    }

    if (request.method === "POST" && path === "/api/ingest/rpi5") {
      const ingestAuth = verifyIngestAuth(request, env);
      if (!ingestAuth.ok) {
        return Response.json({ ok: false, error: ingestAuth.error }, { status: ingestAuth.status, headers: CORS_HEADERS });
      }
      return forwardToDo("/ingest/rpi5", "POST", "rpi5-cron-agent");
    }

    if (request.method === "POST" && path === "/api/ingest/esp32") {
      const ingestAuth = verifyIngestAuth(request, env);
      if (!ingestAuth.ok) {
        return Response.json({ ok: false, error: ingestAuth.error }, { status: ingestAuth.status, headers: CORS_HEADERS });
      }
      return forwardToDo("/ingest/esp32", "POST", "esp32s-watchdog");
    }

    // Strict Zero-Trust Boundary: Reject ALL dashboard / admin / UI traffic on the M2M webhook host!
    if (isHookHost) {
      return Response.json(
        { ok: false, error: "Not Found on machine-to-machine webhook host" },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    // ------------------------------------------------------------------------
    // Operator Dashboard & API Routes (Protected by Cloudflare Zero Trust Access)
    // ------------------------------------------------------------------------
    const auth = await verifyCloudflareAccessRequest(request, env);
    if (!auth.authorized) {
      return Response.json(
        { ok: false, error: `Unauthorized: ${auth.reason || "Cloudflare Access required"}` },
        { status: 403, headers: CORS_HEADERS },
      );
    }

    if (request.method === "GET" && (path === "/metrics.json" || path === "/api/metrics")) {
      return forwardToDo("/metrics", "GET", auth.email);
    }

    if (request.method === "GET" && (path === "/ai_analysis.json" || path === "/api/ai-analysis")) {
      return forwardToDo("/ai-analysis", "GET", auth.email);
    }

    if (request.method === "GET" && (path === "/api/status" || path === "/api/snooze")) {
      return forwardToDo("/status", "GET", auth.email);
    }

    if (request.method === "POST" && (path === "/api/snooze" || path === "/snooze")) {
      return forwardToDo("/snooze", "POST", auth.email);
    }

    if (request.method === "POST" && (path === "/api/unsnooze" || path === "/unsnooze")) {
      return forwardToDo("/unsnooze", "POST", auth.email);
    }

    if (request.method === "POST" && (path === "/api/analyze" || path === "/analyze")) {
      return forwardToDo("/analyze", "POST", auth.email);
    }

    if (request.method === "POST" && (path === "/api/ask" || path === "/ask")) {
      return forwardToDo("/ask", "POST", auth.email);
    }

    if (request.method === "GET" && path === "/api/telegram/status") {
      return forwardToDo("/telegram/status", "GET", auth.email);
    }

    if (request.method === "POST" && path === "/api/telegram/setup") {
      return forwardToDo("/telegram/setup", "POST", auth.email);
    }

    if (request.method === "POST" && path === "/api/telegram/test") {
      return forwardToDo("/telegram/test", "POST", auth.email);
    }

    // Serve static dashboard assets (index.html, favicon.svg)
    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const stub = getNocStub(env);
    ctx.waitUntil(
      stub.fetch("https://noc-do/cron", {
        method: "POST",
      }),
    );
  },
};
