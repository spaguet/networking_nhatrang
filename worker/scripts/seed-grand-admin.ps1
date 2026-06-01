# Post-deploy: seed grand_admin from ADMIN_TG_ID (admin profile v1.3 §4.1).
# Usage (from worker/):
#   $env:ADMIN_TG_ID = "123456789"; .\scripts\seed-grand-admin.ps1
#   $env:ADMIN_TG_ID = "123456789"; .\scripts\seed-grand-admin.ps1 -Remote

param(
  [switch]$Remote
)

$ErrorActionPreference = "Stop"

if (-not $env:ADMIN_TG_ID) {
  Write-Error "Set ADMIN_TG_ID environment variable (Telegram ID of grand_admin)."
}

$tgId = [int64]$env:ADMIN_TG_ID
if ($tgId -le 0) {
  Write-Error "ADMIN_TG_ID must be a positive integer."
}

$now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$sql = @"
INSERT OR IGNORE INTO admins (tg_id, role, password_hash, password_salt, created_at, created_by, updated_at)
VALUES ($tgId, 'grand_admin', NULL, NULL, '$now', NULL, '$now');
"@

$remoteFlag = if ($Remote) { "--remote" } else { "" }
Write-Host "Seeding grand_admin tg_id=$tgId $(if ($Remote) { '(remote)' } else { '(local)' })..."

npx wrangler d1 execute networking_nhatrang $remoteFlag --command $sql

Write-Host "Done. Verify: SELECT tg_id, role FROM admins WHERE role = 'grand_admin';"
