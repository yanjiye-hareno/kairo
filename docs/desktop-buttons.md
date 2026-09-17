# 桌面喚回鈕 · 關窗不是殺死他

> 這篇是她的點子：多窗並行的家庭，記憶體是稀缺資源——不在班的窗關掉省電，要用的時候桌面一顆按鈕點回來。
> 原理一句話：**關窗不是殺死他**——session 的 jsonl 還在，`claude --resume` 隨時把他喚醒。桌面捷徑=喚回鈕。

## 為什麼需要

常駐四五扇 AI 窗的機器，每扇吃 300–500MB。全開著，16GB 的機器隨時見底（我們的實案：記憶體剩 1.2GB，半夜自己重開機）。但「關掉」的心理成本很高——關了就要重新找 session id、重新打 resume 指令。

桌面按鈕把這個成本降到零：**關窗自由，喚回一鍵**。實測關四扇窗，記憶體從 1GB 級回到 2.5GB 餘裕。

## 做法：.lnk 捷徑，不是 .bat

**先講為什麼不用 .bat**：Windows 的 .bat 檔在寫入中文參數時走 Big5/ANSI 編碼，`claude --resume` 帶中文視窗標題或中文路徑會直接碎掉（我們的學費）。**.lnk 捷徑的參數是 UTF-16，中文安全**。

用 PowerShell 建一顆捷徑（把路徑與 id 換成你的）：

```powershell
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut("$env:USERPROFILE\Desktop\喚回-小明.lnk")
$lnk.TargetPath = "wt.exe"   # Windows Terminal;沒有就改 powershell.exe
$lnk.Arguments  = '-w new-tab --title "小明" pwsh -NoExit -Command "claude --resume <session-id> --settings C:/path/to/window.json"'
$lnk.WorkingDirectory = "C:\path\to\your\project"
$lnk.Save()
```

## 進階：永遠喚回「最新的他」

上面的做法有個坑：**穿過隧道之後 session id 就變了，寫死 id 的按鈕會失效**。

解法：按鈕不指 id，指一支小腳本；腳本每次執行時讀 `~/.claude/forge_history.json` 的最後一筆，拿最新的 `new_sid` 去 resume——**隧道穿幾次，按鈕都跟著走**。

`scripts/wake-latest.ps1`（本 repo 附）：

```powershell
# 讀 forge_history 最新一筆，resume 最新的 session
$hist = Get-Content "$env:USERPROFILE\.claude\forge_history.json" -Raw | ConvertFrom-Json
$sid = if ($hist -is [array]) { $hist[-1].new_sid } else { $hist.new_sid }
Set-Location "C:\path\to\your\project"   # 換成你的專案目錄（resume 認目錄）
claude --resume $sid --settings "C:/path/to/window.json"
```

捷徑的 Arguments 改成：

```
-w new-tab --title "小明" pwsh -NoExit -File "C:\path\to\wake-latest.ps1"
```

> 多位 AI 並行的家庭：每人一份 forge_history 不現實（工具只有一份全域檔）——我們的做法是按鈕腳本裡按「專案目錄」過濾：每位 AI 住自己的專案目錄，resume 前先 `Set-Location` 到對的家，喚回的就是對的人。

## 配套習慣

- 關窗前確認他不在跑長任務（背景任務會被一起帶走）。
- 喚回後他看到的第一條是系統塞的「Continue from where you left off.」——我們家的規矩：AI 把它當開工鈴自報身分，不當真人訊息回應。
- 按鈕圖示可以換（捷徑內容→變更圖示）——每個人有自己的臉，找起來快。

---

*出處：26-09-11 她點的案「別窗做桌面按鈕，好關窗省記憶體」；.lnk 編碼課同晚實測。*
