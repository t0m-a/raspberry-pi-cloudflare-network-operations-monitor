<div align="center">

<img src="public/favicon.svg" alt="Cloudflare NOC Logo" width="92" height="92" />

# ☁️ Cloudflare, Raspberry Pi 5 & ESP-32S Network Operations Center (NOC)

**Self-Contained Real-Time Cloudflare Multi-Zone Edge, Serverless Quotas, Raspberry Pi 5 (Vitals, Qdrant, Brain Sync & Critical Services), ESP-32S Out-of-Band Watchdog, Autonomous Workers AI & Exhaustive Telegram Bot Platform**

[![Runtime: Cloudflare Workers](https://img.shields.io/badge/Runtime-Cloudflare%20Workers%20(TypeScript)-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![State: Durable Objects SQLite](https://img.shields.io/badge/State-Durable%20Objects%20(SQLite)-F59E0B?style=for-the-badge&logo=sqlite&logoColor=white)](https://developers.cloudflare.com/durable-objects/)
[![AI Engine: Workers AI](https://img.shields.io/badge/AI%20Analyst-Cloudflare%20Workers%20AI%20(Gemma%204%20%2F%20Llama%203.1)-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white)](https://developers.cloudflare.com/workers-ai/)
[![Edge Node: Raspberry Pi 5](https://img.shields.io/badge/Edge%20Node-Raspberry%20Pi%205%20(15m%20Cron)-C51A4A?style=for-the-badge&logo=raspberrypi&logoColor=white)](#)
[![Alerting: Telegram Bot](https://img.shields.io/badge/Alerting%20%26%20Chat-Telegram%20Webhook%20Bot-26A5E4?style=for-the-badge&logo=telegram&logoColor=white)](#)

</div>

---

## ✨ 1. Executive Overview

**Cloudflare NOC Monitor (v2.1.0)** is a unified edge-to-hardware **Network Operations Center (NOC)** running natively on **Cloudflare Workers**, **Durable Objects (Embedded SQLite)**, **Workers Static Assets**, and **Workers AI**:

- **`https://noc.tsimon.me/`** — Full glassmorphic NOC dashboard and operator APIs protected by **Cloudflare Zero Trust Access**.
- **`https://noc-hook.tsimon.me/`** — Strictly isolated machine-to-machine Worker domain serving **only** cryptographically authenticated webhook & ingest endpoints (`/api/telegram/webhook`, `/api/ingest/rpi5`, `/api/ingest/esp32`, `/health`), returning `404` for all dashboard/UI routes.

### 🎯 Operational Pillars

| Pillar | Component | Cadence | Key Capabilities |
| :--- | :--- | :---: | :--- |
| **1. Multi-Zone Edge Operations** | [`src/collector.ts`](src/collector.ts) | **60s SWR** + **15m Cron** | Per-domain edge routing (`tsimon.me`, `minkalab.net`, `tsimon.app`, `boliviaremote.work`), 1h traffic, bandwidth, cache hit ratio, WAF threats, and strict HTTP `5xx` monitoring (**alerts ONLY when ≥ 100 errors/hour across a 2-hour consecutive time span**). |
| **2. Serverless Quotas & Billing** | [`src/collector.ts`](src/collector.ts) | **60s SWR** + **15m Cron** | Workers & Pages, Workers AI Neurons, Workers KV, R2 Object Storage, plus **50 Billion rows/month** ceilings for both **D1 Monthly Rows Read** and **Durable Objects SQL Monthly Rows Read**. |
| **3. Raspberry Pi 5 Edge Monitoring** | [`agents/rpi5/rpi5_noc_reporter.py`](agents/rpi5/rpi5_noc_reporter.py) | **15m Cron** (`/etc/cron.d/rpi5-noc-reporter`) | Full Linux system vitals (CPU/per-core, clock, load, SoC & RP1 temps, PWM fan RPM, core voltage, `vcgencmd` throttling flags, RAM/Swap, filesystems+inodes, NICs & Wi-Fi RSSI), **Qdrant** vector DB health, **Gemini Brain Sync** (`gemini-brain-watcher`, SQLite `sync_state.db`, Qdrant federation passes, `brain.tsimon.me` uplink), and **Critical Services** (systemd units, timers, Docker containers). |
| **4. ESP-32S Out-of-Band Watchdog** | [`agents/rpi5/rpi5_noc_reporter.py`](agents/rpi5/rpi5_noc_reporter.py) + `esp32-monitor` | **15m LAN Probe** + **5m Heartbeat** | ICMP ping reachability, RTT min/avg/max/jitter, packet loss, TTL, ARP/MAC auto-discovery, 24h availability sparkline, plus rich device vitals (chip, 64-bit uptime, reset reason, internal temp, Wi-Fi RSSI/channel/reconnects, SRAM heap & fragmentation) and OOB Cloudflare probe matrix (`brain`, `kb`, `boliviaremote`, `minkalab` + CF Global Statuspage). |
| **5. Foldable Autonomous Workers AI NOC Analyst** | [`src/evaluator.ts`](src/evaluator.ts) + [`src/ai-analyst.ts`](src/ai-analyst.ts) | **Every 15m** + **On-Demand** | Deterministic multi-layer anomaly matrix + `@cf/google/gemma-4-26b-a4b-it` (fallback `@cf/meta/llama-3.1-8b-instruct-fast`) assessment presented in a **foldable UI section** (persisted in `localStorage`) with interactive Q&A and `24h`/`72h`/`7d` snooze manager. |
| **6. Exhaustive Telegram Alerting & Bot** | [`src/telegram.ts`](src/telegram.ts) | **Real-Time Webhook** + **Proactive Alerts** | Proactive alerts with cooldown, recovery notifications, inline `[24h][72h][7d]` snooze keyboards, and **23 deep slash commands** + natural-language Workers AI chat. |

---

## 📊 2. Deterministic Alerting Rules & Thresholds

| Category | Key Pattern | Warning (`WARNING`) | Critical (`CRITICAL`) |
| :--- | :--- | :---: | :---: |
| **Edge Origin `5xx` (Strict Rule)** | `cf_domain_5xx:<domain>` | **≥ 100 HTTP `5xx` errors/hour across 2 consecutive hours** (never alerts below this threshold) | — |
| **Edge Domain Routing** | `cf_domain_status:<domain>` | — | Zone status `!= HEALTHY` |
| **Edge WAF Threats** | `cf_domain_threats:<domain>` | `>= 15` / 1h | `>= 100` / 1h |
| **D1 Monthly Rows Read** | `quota:d1_reads_monthly` | `>= 60%` of **50,000,000,000 / mo** | `>= 80%` of **50,000,000,000 / mo** |
| **DO SQL Monthly Rows Read** | `quota:do_reads_monthly` | `>= 60%` of **50,000,000,000 / mo** | `>= 80%` of **50,000,000,000 / mo** |
| **Workers / AI / D1 Write / DO / KV / R2** | `quota:*` | `>= 60%` of tier limit | `>= 80%` of tier limit |
| **RPi5 Telemetry Freshness** | `rpi5:stale_report` | — | Last cron push `> 35 min` old |
| **RPi5 CPU / Load / SoC Temp** | `rpi5:cpu`, `rpi5:load`, `rpi5:thermal` | `80%` / `80%` / `70°C` | `92%` / `95%` / `80°C` |
| **RPi5 Power/Thermal Throttling** | `rpi5:throttled` | — | Active `vcgencmd` throttle bits (`0x0`..`0xf`) |
| **RPi5 RAM / Swap / Disk** | `rpi5:ram`, `rpi5:swap`, `rpi5:disk:<mp>` | `85%` / `85%` / `80%` | `93%` / `95%` / `90%` |
| **RPi5 Qdrant Vector DB** | `rpi5:qdrant_down`, `rpi5:qdrant_status` | `yellow` | Unreachable / `healthz` fail / `red` |
| **RPi5 Brain Sync Daemon** | `rpi5:sync_*` | Qdrant pass `> 45m` stale or `>= 5` errors | Daemon down or `brain.tsimon.me` uplink down |
| **RPi5 Critical Services** | `rpi5:svc:<service>` | — | Any critical systemd/Docker service inactive |
| **ESP-32S Ping / Loss / Latency** | `esp32:unreachable`, `esp32:packet_loss`, `esp32:high_latency` | `>= 20%` loss or `>= 150ms` avg RTT | Unreachable, `>= 60%` loss, or `>= 400ms` avg RTT |
| **ESP-32S Radio / Heap / OOB Probes** | `esp32:weak_wifi`, `esp32:low_heap`, `esp32:oob_down:<ep>` | RSSI `<= -78 dBm` or heap `< 40 KB` | OOB endpoint `DOWN` or CF Global major/critical incident |

---

## 💬 3. Exhaustive Telegram Bot Commands

Dedicated bot token (keeps `@minkalab_alert_bot` isolated on the ESP-32S watchdog). Run `.\scripts\setup-telegram.ps1` after creating your BotFather bot to upload `TELEGRAM_BOT_TOKEN`, register the webhook on `https://noc-hook.tsimon.me/api/telegram/webhook`, and sync all 23 commands:

| Command | Scope |
| :--- | :--- |
| `/status` | Master executive NOC overview across Cloudflare, RPi5 & ESP-32S + AI verdict |
| `/full` (`/report`, `/all`) | Exhaustive multi-part dump of every subsystem (auto-chunked safely under 4,096 chars) |
| `/alerts` (`/anomalies`) | Active anomalies, snoozed items with countdowns & inline snooze/unsnooze buttons |
| `/cf [domain]` | Cloudflare Edge zones traffic, bandwidth, cache hit ratio, WAF threats & 5xx |
| `/5xx` | Dedicated HTTP 5xx hourly audit, active streaks & `>= 100/hr × 2h` policy check |
| `/quotas` (`/billing`) | All 6 Cloudflare platform quotas (including 50B/mo D1 & DO reads) & MTD billable USD |
| `/workers`, `/do`, `/d1`, `/ai`, `/kv`, `/r2` | Deep per-script, per-namespace, per-DB, per-model, and per-bucket breakdowns |
| `/pi` (`/rpi5`, `/vitals`) | Full Raspberry Pi 5 vitals (CPU/per-core, thermals, fan, voltage, RAM/swap, disks, NICs, Wi-Fi) |
| `/qdrant` | Qdrant status, version, collection points, segments, optimizer, disk MB & latency |
| `/sync` | `gemini-brain-watcher` status, SQLite synced chunks by prefix, last Qdrant pass, errors & uplink |
| `/services` (`/svc`) | Full table of critical systemd units, timers & Docker containers with PID & RSS MB |
| `/esp32` (`/watchdog`, `/ping`) | ESP-32S ICMP ping, RTT min/avg/max/jitter, loss, 24h uptime, Wi-Fi/heap & OOB Cloudflare probes |
| `/snooze`, `/unsnooze` | Interactive or CLI snoozing (`24h`, `72h`, `7d`) |
| `/analyze`, `/refresh` | Force live Workers AI evaluation or Cloudflare telemetry collection |
| `/ask <question>` or plain text | Interactive Workers AI NOC Engineer Q&A grounded in full live telemetry |

---

## 🚀 4. Deployment & Testing

```bash
# Typecheck & run all 10 unit + integration tests
npm run typecheck
npm test

# Deploy Cloudflare Worker + Static Assets + Custom Domains (noc.tsimon.me & noc-hook.tsimon.me)
npm run deploy

# Configure dedicated Telegram bot + webhook + 23 slash commands
.\scripts\setup-telegram.ps1
```

### Worker Secrets Reference
- `CLOUDFLARE_API_TOKEN` — Scoped read-only Cloudflare Analytics/REST API token
- `NOC_INGEST_TOKEN` — Bearer token used by Raspberry Pi 5 cron agent and ESP-32S heartbeat push
- `TELEGRAM_BOT_TOKEN` — Dedicated `@BotFather` bot token for `cloudflare-noc-monitor`
- `TELEGRAM_CHAT_ID` — Authorized operator Telegram Chat ID (fail-closed allowlist)
- `TELEGRAM_WEBHOOK_SECRET` — Cryptographic `X-Telegram-Bot-Api-Secret-Token` verified on `/api/telegram/webhook`
