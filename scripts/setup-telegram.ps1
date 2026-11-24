<#
.SYNOPSIS
    Configures the dedicated Telegram Bot for cloudflare-noc-monitor in one step:
      1. Stores TELEGRAM_BOT_TOKEN (and optionally refreshes TELEGRAM_WEBHOOK_SECRET & TELEGRAM_CHAT_ID)
         as encrypted Cloudflare Worker secrets.
      2. Registers the Telegram webhook on https://noc-hook.tsimon.me/api/telegram/webhook
         with cryptographic X-Telegram-Bot-Api-Secret-Token verification.
      3. Registers all 23 exhaustive NOC slash commands via setMyCommands.
      4. Sends a live confirmation message to your Telegram chat.

.EXAMPLE
    .\scripts\setup-telegram.ps1
#>
[CmdletBinding()]
param(
    [string]$WebhookHost = "noc-hook.tsimon.me",
    [string]$ChatId = "8590242462"
)

$ErrorActionPreference = "Stop"

Write-Host "=== Cloudflare NOC Monitor — Telegram Bot Setup ===" -ForegroundColor Cyan
$secureTok = Read-Host -Prompt "Paste your dedicated @BotFather Bot Token" -AsSecureString
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureTok)
try {
    $botToken = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr).Trim()
} finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if (-not $botToken -or $botToken -notmatch '^\d+:[A-Za-z0-9_-]{20,}$') {
    throw "Invalid Telegram Bot Token format. Expected format: 123456789:AA..."
}

# Generate a fresh webhook secret and sync it to both Cloudflare Worker & Telegram API
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 24
$rng.GetBytes($bytes)
$webhookSecret = ([BitConverter]::ToString($bytes) -replace '-', '').ToLower()

Write-Host "`n[1/4] Uploading encrypted Worker secrets via Wrangler..." -ForegroundColor Yellow
$botToken      | npx wrangler secret put TELEGRAM_BOT_TOKEN
$webhookSecret | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
$ChatId        | npx wrangler secret put TELEGRAM_CHAT_ID

$webhookUrl = "https://$WebhookHost/api/telegram/webhook"
Write-Host "`n[2/4] Registering Telegram webhook -> $webhookUrl ..." -ForegroundColor Yellow
$whBody = @{
    url                  = $webhookUrl
    secret_token         = $webhookSecret
    allowed_updates      = @("message", "callback_query")
    drop_pending_updates = $false
} | ConvertTo-Json -Depth 4
$whRes = Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$botToken/setWebhook" -ContentType "application/json" -Body $whBody
if (-not $whRes.ok) { throw "setWebhook failed: $($whRes | ConvertTo-Json)" }
Write-Host "Webhook registered successfully." -ForegroundColor Green

Write-Host "`n[3/4] Registering 23 exhaustive NOC slash commands..." -ForegroundColor Yellow
$commands = @(
    @{ command = "status";   description = "Master NOC overview across CF, RPi5 & ESP-32S" },
    @{ command = "full";     description = "Exhaustive multi-section deep telemetry dump" },
    @{ command = "alerts";   description = "Active anomalies, snoozed items & 5xx streak state" },
    @{ command = "cf";       description = "Cloudflare Edge domains (traffic, CHR, threats, 5xx)" },
    @{ command = "5xx";      description = "Dedicated HTTP 5xx hourly audit & 100/hr x 2h rule" },
    @{ command = "quotas";   description = "All Cloudflare platform quotas & MTD billing" },
    @{ command = "workers";  description = "Workers & Pages scripts, CPU, errors & assets" },
    @{ command = "do";       description = "Durable Objects namespaces & 50B/mo SQL read quota" },
    @{ command = "d1";       description = "D1 databases, storage & 50B/mo rows read quota" },
    @{ command = "ai";       description = "Workers AI daily Neurons, tokens & per-model stats" },
    @{ command = "kv";       description = "Workers KV operations, keys & namespaces" },
    @{ command = "r2";       description = "R2 buckets, Class A/B ops, storage & egress" },
    @{ command = "pi";       description = "Raspberry Pi 5 full vitals (CPU, temp, fan, RAM, disk, NIC)" },
    @{ command = "qdrant";   description = "RPi5 Qdrant vector DB status" },
    @{ command = "sync";     description = "Brain Edge Sync daemon, chunks & Qdrant federation" },
    @{ command = "services"; description = "RPi5 critical systemd units, timers & Docker containers" },
    @{ command = "esp32";    description = "ESP-32S ping, latency, 24h uptime, vitals & OOB probes" },
    @{ command = "snooze";   description = "Snooze active findings (24h, 72h, 7d)" },
    @{ command = "unsnooze"; description = "Reactivate snoozed findings" },
    @{ command = "analyze";  description = "Run a fresh Workers AI NOC analysis right now" },
    @{ command = "refresh";  description = "Force live Cloudflare GraphQL/REST refresh now" },
    @{ command = "ask";      description = "Ask Workers AI NOC Engineer anything about live metrics" },
    @{ command = "help";     description = "List all exhaustive NOC commands & usage" }
)
$cmdBody = @{ commands = $commands } | ConvertTo-Json -Depth 5
$cmdRes = Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$botToken/setMyCommands" -ContentType "application/json" -Body $cmdBody
if (-not $cmdRes.ok) { throw "setMyCommands failed: $($cmdRes | ConvertTo-Json)" }

$me = Invoke-RestMethod -Method Get -Uri "https://api.telegram.org/bot$botToken/getMe"
Write-Host "Registered 23 commands on @$($me.result.username)." -ForegroundColor Green

Write-Host "`n[4/4] Sending confirmation message to chat $ChatId..." -ForegroundColor Yellow
$helloBody = @{
    chat_id    = $ChatId
    parse_mode = "HTML"
    text       = "✅ <b>Cloudflare, RPi5 &amp; ESP-32S NOC Bot Online!</b>`nWebhook: <code>$webhookUrl</code>`nSend <code>/status</code>, <code>/full</code>, <code>/pi</code>, <code>/qdrant</code>, <code>/sync</code>, <code>/esp32</code>, or <code>/help</code> to begin."
} | ConvertTo-Json -Depth 4
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$botToken/sendMessage" -ContentType "application/json" -Body $helloBody | Out-Null

Write-Host "`nDone! Open Telegram and message @$($me.result.username) with /status or /help." -ForegroundColor Cyan
