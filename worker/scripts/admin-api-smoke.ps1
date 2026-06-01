# Admin API smoke (admin_profile_TZ.md v1.3)
# Usage: cd worker; .\scripts\admin-api-smoke.ps1

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

Write-Host "Admin API smoke -> $ApiUrl"
Write-Host ""

Invoke-ApiTest -Name "admin_check_access no initData" `
  -Body (@{ action = "admin_check_access"; secret = $Secret } | ConvertTo-Json -Compress) `
  -ExpectedStatus @(401) `
  -StatusOnly

Invoke-ApiTest -Name "admin_list_banned invalid session" `
  -Body (@{ action = "admin_list_banned"; secret = $Secret; initData = "invalid"; adminToken = "deadbeef" } | ConvertTo-Json -Compress) `
  -ExpectedStatus @(401) `
  -StatusOnly

Invoke-ApiTest -Name "admin_update_settings invalid session" `
  -Body (@{ action = "admin_update_settings"; secret = $Secret; initData = "invalid"; adminToken = "deadbeef" } | ConvertTo-Json -Compress) `
  -ExpectedStatus @(401) `
  -StatusOnly

Invoke-ApiTest -Name "admin_get_settings invalid session" `
  -Body (@{ action = "admin_get_settings"; secret = $Secret; initData = "invalid"; adminToken = "deadbeef" } | ConvertTo-Json -Compress) `
  -ExpectedStatus @(401) `
  -StatusOnly

Invoke-ApiTest -Name "admin_add_admin invalid session" `
  -Body (@{ action = "admin_add_admin"; secret = $Secret; initData = "invalid"; adminToken = "deadbeef"; targetTgId = 1 } | ConvertTo-Json -Compress) `
  -ExpectedStatus @(401) `
  -StatusOnly

$listingsBody = '{"action":"get_listings","category":"IT \u0438 \u0440\u0430\u0437\u0440\u0430\u0431\u043e\u0442\u043a\u0430","secret":"' + $Secret + '"}'
Invoke-ApiTest -Name "get_listings regression" `
  -Body $listingsBody `
  -ExpectedStatus @(200) `
  -ExpectedSubstring '"ok":true'

Write-Host ""
Write-Host "Done: $($script:passed) passed, $($script:failed) failed."
if ($script:failed -gt 0) { exit 1 }
