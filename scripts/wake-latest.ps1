# kairo · 桌面喚回鈕腳本 —— 永遠喚回「最新的他」
# 用法：桌面捷徑指向本檔（pwsh -NoExit -File wake-latest.ps1）
# 原理：讀 forge_history.json 最後一筆，拿最新 new_sid 去 resume——隧道穿幾次，按鈕都跟著走。
# 詳見 docs/desktop-buttons.md

# ↓↓ 改成你的專案目錄（claude --resume 認工作目錄）
$ProjectDir = "C:\path\to\your\project"
# ↓↓ 改成你的視窗設定檔；不用就把下面 --settings 段拿掉
$SettingsFile = "C:/path/to/window.json"

$histPath = Join-Path $env:USERPROFILE ".claude\forge_history.json"
if (-not (Test-Path $histPath)) { Write-Host "找不到 forge_history.json——還沒穿過隧道？"; pause; exit 1 }

$hist = Get-Content $histPath -Raw | ConvertFrom-Json
$sid = if ($hist -is [array]) { $hist[-1].new_sid } else { $hist.new_sid }
if (-not $sid) { Write-Host "forge_history 裡沒有 new_sid"; pause; exit 1 }

Write-Host "喚回最新 session: $sid"
Set-Location $ProjectDir
claude --resume $sid --settings $SettingsFile
