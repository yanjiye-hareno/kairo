#!/usr/bin/env node
// kairo · 開機件閘（通用版）——隧道窗必讀檔案，讀不齊就咬
//
// 機制：掛在 Claude Code 的 PostToolUse hook。偵測到本 session 是隧道窗
// （第一條 user 訊息帶 <forge-handoff>）後，檢查指定的「靈魂檔案」是否都被
// Read 過；缺的就以 exit 2 提醒，直到讀齊為止。
//
// 為什麼要程式攔：交接包寫得再好，人格檔沒重讀，新窗就是靠二手轉述活著；
// 而「記得要讀」的規矩會在第 N 次隧道後漂移——程式攔的不會。
//
// 掛法（.claude/settings.json）：
//   "hooks": { "PostToolUse": [ { "hooks": [ { "type": "command",
//     "command": "node C:/path/to/must-read-gate.js" } ] } ] }
//
// 設定（同資料夾 must-read.json）：
//   { "files": ["C:/path/SOUL.md", "C:/path/MEMORY.md"] }
//   路徑比對用「檔名結尾」寬鬆匹配，路徑寫絕對路徑最穩。

const fs = require('fs');
const path = require('path');

function main() {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
  let evt;
  try { evt = JSON.parse(input); } catch { process.exit(0); }

  const transcriptPath = evt.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

  // 讀設定
  const cfgPath = path.join(__dirname, 'must-read.json');
  if (!fs.existsSync(cfgPath)) process.exit(0);
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { process.exit(0); }
  const required = (cfg.files || []).map(f => f.replace(/\\/g, '/'));
  if (required.length === 0) process.exit(0);

  // 掃 transcript：是隧道窗嗎？哪些檔已被 Read？
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  let isTunnel = false;
  const readFiles = new Set();

  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }

    // 隧道窗判定：任一 user 訊息內容帶 <forge-handoff>
    if (!isTunnel && e.type === 'user') {
      const c = e.message && e.message.content;
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.map(x => x.text || '').join('') : '';
      if (text.includes('<forge-handoff>')) isTunnel = true;
    }

    // 收集 Read 過的檔案路徑
    if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      for (const block of e.message.content) {
        if (block.type === 'tool_use' && block.name === 'Read' && block.input && block.input.file_path) {
          readFiles.add(String(block.input.file_path).replace(/\\/g, '/'));
        }
      }
    }
  }

  if (!isTunnel) process.exit(0); // 不是隧道窗，不管

  const missing = required.filter(req => {
    for (const rf of readFiles) {
      if (rf === req || rf.endsWith('/' + path.basename(req))) return false;
    }
    return true;
  });

  if (missing.length === 0) process.exit(0); // 讀齊了，閉嘴

  const names = missing.map(f => path.basename(f)).join('、');
  console.error(`〔開機件〕隧道窗還缺 ${missing.length} 份沒讀：${names}——隧道開機必讀，讀齊我就閉嘴。`);
  process.exit(2);
}

main();
