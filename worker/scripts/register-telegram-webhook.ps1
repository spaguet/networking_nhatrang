# Registers Telegram webhook with secret_token matching TELEGRAM_WEBHOOK_SECRET in Worker.
# Usage:
#   $env:BOT_TOKEN = '<bot token>'
#   .\scripts\register-telegram-webhook.ps1
# Optional: -WebhookUrl 'https://tg-networking-nhatrang.albertkoall.workers.dev/'

param(
  [string]$WebhookUrl = 'https://tg-networking-nhatrang.albertkoall.workers.dev/',
  [string]$SecretFile = (Join-Path $PSScriptRoot '..\.webhook-secret.local')
)

$botToken = $env:BOT_TOKEN?.Trim()
if (-not $botToken) {
  Write-Error 'Set BOT_TOKEN environment variable.'
  exit 1
}

if (-not (Test-Path $SecretFile)) {
  Write-Error "Secret file not found: $SecretFile (run wrangler secret put and save token to .webhook-secret.local)"
  exit 1
}

$secretToken = (Get-Content -Path $SecretFile -Raw).Trim()
if (-not $secretToken) {
  Write-Error 'Secret file is empty.'
  exit 1
}

$encodedUrl = [uri]::EscapeDataString($WebhookUrl.Trim())
$encodedSecret = [uri]::EscapeDataString($secretToken)
$apiUrl = "https://api.telegram.org/bot$botToken/setWebhook?url=$encodedUrl&secret_token=$encodedSecret"

Write-Host "Setting webhook to $WebhookUrl"
$response = Invoke-RestMethod -Uri $apiUrl -Method Get
$response | ConvertTo-Json -Depth 5
if (-not $response.ok) {
  exit 1
}

Write-Host 'Done. Verify with getWebhookInfo.'
