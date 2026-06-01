# Messaging API smoke (user_messaging_TZ.md v1.5 §11, prompt 8)
# Usage: cd worker; .\scripts\messaging-api-smoke.ps1

param(
  [string]$ApiUrl = "https://tg-networking-nhatrang.albertkoall.workers.dev/api",
  [string]$Secret = "getting_more_money"
)

$ErrorActionPreference = "Stop"
$script:passed = 0
$script:failed = 0

function Invoke-ApiTest {
  param(
    [string]$Name,
    [string]$Body,
    [int[]]$ExpectedStatus = @(200),
    [string]$ExpectedSubstring = "",
    [switch]$StatusOnly
  )

  $status = 0
  $content = ""

  try {
    $response = Invoke-WebRequest -Uri $ApiUrl -Method POST -Body $Body -ContentType "application/json" -UseBasicParsing
    $status = [int]$response.StatusCode
    $content = $response.Content
  }
  catch {
    $resp = $_.Exception.Response
    if (-not $resp) {
      Write-Host "[FAIL] $Name - $($_.Exception.Message)" -ForegroundColor Red
      $script:failed++
      return
    }
    $status = [int]$resp.StatusCode
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $content = $sr.ReadToEnd()
  }

  $statusOk = $ExpectedStatus -contains $status
  $bodyOk = $StatusOnly -or (-not $ExpectedSubstring) -or ($content -like "*$ExpectedSubstring*")

  if ($statusOk -and $bodyOk) {
    Write-Host "[OK]   $Name - HTTP $status" -ForegroundColor Green
    $script:passed++
  }
  else {
    $preview = if ($content.Length -gt 300) { $content.Substring(0, 300) } else { $content }
    Write-Host "[FAIL] $Name - HTTP $status expected $($ExpectedStatus -join '|') body: $preview" -ForegroundColor Red
    $script:failed++
  }
}

Write-Host "Messaging API smoke -> $ApiUrl"
Write-Host ""

Invoke-ApiTest -Name "verify_telegram_contact no initData" `
  -Body (@{ action = "verify_telegram_contact"; secret = $Secret; contacts = "@ivan_spec"; tg_id = 1 } | ConvertTo-Json -Compress) `
  -ExpectedStatus @(200) `
  -ExpectedSubstring "Invalid initData"

Invoke-ApiTest -Name "get_messaging_unread no initData" `
  -Body (@{ action = "get_messaging_unread"; secret = $Secret; tg_id = 1 } | ConvertTo-Json -Compress) `
  -ExpectedStatus @(200) `
  -ExpectedSubstring "Invalid initData"

Invoke-ApiTest -Name "open_conversation no initData" `
  -Body (@{ action = "open_conversation"; secret = $Secret; listing_id = "test"; tg_id = 1 } | ConvertTo-Json -Compress) `
  -ExpectedStatus @(200) `
  -ExpectedSubstring "Invalid initData"

Invoke-ApiTest -Name "send_message no initData" `
  -Body (@{ action = "send_message"; secret = $Secret; conversation_id = "x"; body = "hi"; tg_id = 1 } | ConvertTo-Json -Compress) `
  -ExpectedStatus @(200) `
  -ExpectedSubstring "Invalid initData"

Invoke-ApiTest -Name "submit_message_complaint no initData" `
  -Body (@{ action = "submit_message_complaint"; secret = $Secret; conversation_id = "x"; body = "complaint"; tg_id = 1 } | ConvertTo-Json -Compress) `
  -ExpectedStatus @(200) `
  -ExpectedSubstring "Invalid initData"

Invoke-ApiTest -Name "resolve_telegram_chat no initData" `
  -Body (@{ action = "resolve_telegram_chat"; secret = $Secret; listing_id = "test"; tg_id = 1 } | ConvertTo-Json -Compress) `
  -ExpectedStatus @(200) `
  -ExpectedSubstring "Invalid initData"

$listingsBody = '{"action":"get_listings","category":"IT \u0438 \u0440\u0430\u0437\u0440\u0430\u0431\u043e\u0442\u043a\u0430","secret":"' + $Secret + '"}'
Invoke-ApiTest -Name "get_listings regression" `
  -Body $listingsBody `
  -ExpectedStatus @(200) `
  -ExpectedSubstring '"ok":true'

Write-Host ""
Write-Host "Done: $($script:passed) passed, $($script:failed) failed."
if ($script:failed -gt 0) { exit 1 }
