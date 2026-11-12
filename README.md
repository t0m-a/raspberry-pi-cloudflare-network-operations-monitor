![Edge RAG Hub Banner](https://tsimon.me/edge-lab-logo.png)


# Raspberry Pi 5 — Cloudflare Edge & Local LAN NOC Monitor (Gemma 4 AI Edition)

[![Platform](https://img.shields.io/badge/Hardware-Raspberry_Pi_5_(ARM64)-C51A4A?style=flat-square&logo=raspberry-pi&logoColor=white)](#)
[![Edge Security](https://img.shields.io/badge/Zero_Trust-Cloudflare_Tunnels-F38020?style=flat-square&logo=cloudflare&logoColor=white)](#)
[![AI Engine](https://img.shields.io/badge/Edge_AI-Gemma_4_(Ollama)-4285F4?style=flat-square&logo=google&logoColor=white)](#)
[![Alerting](https://img.shields.io/badge/Notifications-Telegram_Bot_API-26A5E4?style=flat-square&logo=telegram&logoColor=white)](#)
[![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB?style=flat-square&logo=python&logoColor=white)](#)

> **A sovereign, 24/7 Network Operations Center (NOC) observability and AI diagnostics daemon engineered for Raspberry Pi 5.** Monitors local host vitals, internal LAN endpoints, and Cloudflare Zero-Trust edge infrastructure—synthesizing anomalies through local **Gemma 4** inference and dispatching actionable incident briefs via **Telegram**.

---

## Architectural Evolution (v2.0)

Originally built to track Cloudflare Zero-Trust tunnel connectors and external web endpoints, this platform now operates as a **full-spectrum Edge + LAN NOC appliance**:

1. **Local System & Docker Vitals:** Tracks ARM64 CPU load, thermal throttling headroom, memory/swap pressure, disk I/O, and live Docker container states (Qdrant, FastEmbed, `cloudflared`).
2. **Local LAN & Gateway Reconnaissance:** Executes low-overhead ARP/ICMP sweeps, gateway/ISP latency checks, DNS resolution benchmarks, and critical local device availability checks.
3. **Cloudflare Zero-Trust & Edge Telemetry:** Validates outbound `cloudflared` tunnel health, TLS certificate expiration windows, and HTTP status/latency across production Cloudflare Workers and edge domains.
4. **Gemma 4 Autonomous Diagnostics:** Pipes multi-layer telemetry anomalies into a local **Gemma 4** model to correlate symptoms (e.g., isolating local ISP jitter from an upstream Cloudflare PoP issue) and generate immediate remediation steps with zero external data leakage.
5. **Stateful Telegram Incident Dispatch:** Pushes structured alerts, recovery confirmations, and scheduled NOC digests to Telegram with built-in cooldown deduplication to eliminate alert fatigue.

---

## System Architecture

```text
╔═══════════════════════════════════════════════════════════════════════════╗
║                     TELEMETRY COLLECTION SURFACES                         ║
╠═══════════════════════╦═══════════════════════════╦═══════════════════════╣
║   1. RPi 5 Host &     ║     2. Local LAN &        ║  3. Cloudflare Edge   ║
║   Docker Containers   ║     Gateway Subnet        ║  & Zero-Trust Tunnels ║
║ • CPU / Thermal / RAM ║ • Gateway ICMP & Jitter   ║ • cloudflared Daemon  ║
║ • NVMe / SD Disk I/O  ║ • Active ARP / Host Sweep ║ • HTTPS / TLS Expiry  ║
║ • Qdrant / RAG Stack  ║ • Local DNS Resolution    ║ • Worker Endpoints    ║
╚═══════════╤═══════════╩═════════════╤═════════════╩═══════════╤═══════════╝
            │                         │                         │
            └─────────────────────────┼─────────────────────────┘
                                      ▼
                     ┌─────────────────────────────────┐
                     │   Python NOC Telemetry Engine   │
                     │  (Threshold & State Evaluator)  │
                     └────────┬───────────────┬────────┘
                              │               │
         [ Normal / Digest ]  │               │  [ Anomaly / State Change ]
                              │               ▼
                              │      ┌─────────────────────────────────┐
                              │      │   Gemma 4 Diagnostic Engine     │
                              │      │  • Multi-layer RCA correlation  │
                              │      │  • Remediation command synthesis│
                              │      └────────────────┬────────────────┘
                              │                       │
                              ▼                       ▼
                     ┌─────────────────────────────────────────┐
                     │       Telegram Bot Dispatcher           │
                     │  • Cooldown & Flap Deduplication        │
                     │  • Real-Time Incident + RCA Push Alerts │
                     └─────────────────────────────────────────┘
```

---

## 3-Tier Observability Matrix

| Tier | Target Surface | Monitored Metrics | Failure Trigger Example |
|---|---|---|---|
| **Tier 1: Edge Host** | Raspberry Pi 5 (ARM64) & Docker Engine | CPU %, SoC Temp (`°C`), RAM/Swap %, Disk usage, Container healthchecks | SoC Temp `> 75°C`, Disk `> 85%`, or `qdrant` / `cloudflared` container restart |
| **Tier 2: Local LAN** | Default Gateway, Local Subnet & DNS | Gateway RTT (ms), Packet Loss %, Active LAN hosts, DNS query time | Gateway packet loss `> 5%`, DNS timeout, or critical LAN node unreachable |
| **Tier 3: Cloud Edge** | Cloudflare Tunnels & Production Domains | `cloudflared` metrics endpoint, HTTP status codes, TTFB (ms), TLS days remaining | Tunnel connector degraded, HTTP `5xx`, TTFB `> 1500ms`, or TLS `< 14 days` |

---

## Gemma 4 Intelligence & Telegram Alert Payload

When the telemetry collector detects a threshold breach, it constructs a structured JSON state snapshot across all three tiers and queries the local **Gemma 4** runtime before dispatching the Telegram notification.

### Example Telegram Push Notification

```text
🚨 [NOC ALERT - DEGRADED] Edge Node: rpi5-lapaz-01
⏱ Timestamp: 2026-11-12 17:45:02 UTC-4

📊 TELEMETRY SNAPSHOT
• Host Vitals: CPU 34% | Temp 58.2°C | RAM 61% (OK)
• Local LAN: Gateway (192.168.0.1) RTT 142ms | Loss: 8.0% (WARN)
• Edge Tunnel: cloudflared QUIC conn flapping | brain.tsimon.me TTFB 1840ms

🧠 GEMMA 4 ROOT-CAUSE ANALYSIS
Upstream Cloudflare tunnel instability correlates directly with 8% packet loss and elevated RTT (142ms) at the local LAN gateway (192.168.0.1). Local RPi5 compute and Docker containers remain healthy. Root cause is local ISP last-mile congestion rather than Cloudflare Edge or host exhaustion.

🛠 RECOMMENDED ACTION
1. Verify DOCSIS/gateway upstream SNR on local router (192.168.0.1).
2. Keep cloudflared running; QUIC protocol will auto-recover once gateway packet loss drops below 2%.
```

---

## Repository Structure

```text
raspberry-pi-cloudflare-network-operations-monitor/
├── src/
│   ├── monitor.py             # Main event loop, scheduler & state machine
│   ├── collectors/
│   │   ├── host_vitals.py     # RPi 5 CPU, thermal, disk & Docker socket checks
│   │   ├── lan_scanner.py     # Gateway ICMP, DNS benchmark & local subnet sweep
│   │   └── edge_tunnels.py    # cloudflared metrics & HTTPS/TLS domain probes
│   ├── ai/
│   │   └── gemma_analyzer.py  # Local Ollama / Gemma 4 prompt builder & RCA parser
│   └── notifiers/
│       └── telegram_bot.py    # Telegram Bot API client with alert deduplication
├── config/
│   └── config.example.yaml    # Thresholds, target LAN IPs & domain inventory
├── systemd/
│   └── noc-monitor.service    # Hardened systemd unit for 24/7 background execution
├── .env.example               # Environment variables template
├── requirements.txt           # Python dependencies (psutil, httpx, pyyaml)
└── README.md
```

---

## Quickstart & Deployment

### 1. Prerequisites
* **Hardware:** Raspberry Pi 5 (4GB or 8GB RAM) running Raspberry Pi OS / Debian Bookworm (64-bit ARM64).
* **AI Runtime:** [Ollama](https://ollama.com/) installed locally with `gemma4` pulled, or configured via API endpoint:
  ```bash
  ollama pull gemma4
  ```
* **Cloudflare Tunnel:** Active `cloudflared` service running with metrics enabled (`--metrics 127.0.0.1:20241`).
* **Telegram Bot:** A Bot Token from `@BotFather` and your target `TELEGRAM_CHAT_ID`.

### 2. Installation
```bash
git clone [https://github.com/t0m-a/raspberry-pi-cloudflare-network-operations-monitor.git](https://github.com/t0m-a/raspberry-pi-cloudflare-network-operations-monitor.git)
cd raspberry-pi-cloudflare-network-operations-monitor

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 3. Configuration
Copy the environment and configuration templates:
```bash
cp .env.example .env
cp config/config.example.yaml config/config.yaml
```

Populate `.env` with your credentials and runtime parameters:
```ini
# Telegram Notification Settings
TELEGRAM_BOT_TOKEN="your_botfather_token_here"
TELEGRAM_CHAT_ID="your_chat_id_here"

# Gemma 4 / Ollama Inference Endpoint
OLLAMA_HOST="[http://127.0.0.1:11434](http://127.0.0.1:11434)"
OLLAMA_MODEL="gemma4"

# Local Network & Edge Parameters
LAN_GATEWAY_IP="192.168.0.1"
LAN_SUBNET="192.168.0.0/24"
CLOUDFLARED_METRICS_URL="[http://127.0.0.1:20241/metrics](http://127.0.0.1:20241/metrics)"
ALERT_COOLDOWN_SECONDS="900"
```

### 4. Run as a 24/7 `systemd` Service
```bash
sudo cp systemd/noc-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now noc-monitor.service

# Inspect live NOC telemetry and Gemma 4 diagnostics
sudo journalctl -u noc-monitor.service -f
```

---

## Related Ecosystem Projects

* **[`gemini-brain`](https://github.com/t0m-a/gemini-brain) (`brain.tsimon.me`):** Stateful Cloudflare Durable Objects & SQLite cognitive memory server (MCP).
* **[`scout-analyst-pipelines-agents`](https://github.com/t0m-a/scout-analyst-pipelines-agents) (`boliviaremote.work`):** Agentic opportunity reconnaissance and 100-point remote role evaluation platform.
* **[`Edge-Semantic-Search-RAG-Knowledge-Hub`](https://github.com/t0m-a/Edge-Semantic-Search-RAG-Knowledge-Hub):** Sovereign Qdrant + FastEmbed RAG documentation system running on Raspberry Pi 5.
* **[`MinkaLab`](https://github.com/t0m-a/MinkaLab) (`minkalab.net`):** Trilingual digital hygiene, cloud security auditing, and edge telemetry frameworks.

---

## Author

**Thomas Simon** — Senior Systems Engineer, NOC Specialist & Edge AI Architect  
🌐 [tsimon.me](https://tsimon.me) | 🛡 [minkalab.net](https://minkalab.net) | 💼 [boliviaremote.work](https://boliviaremote.work)
