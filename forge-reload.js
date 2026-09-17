#!/usr/bin/env node
/**
 * forge-reload — Claude Code 長對話無感續接
 *
 * 原理：把當前 session 的 jsonl 尾部（最近 ~N tokens 的對話原文，含 thinking blocks）
 * 搬進一個新 session 檔案，重建事件鏈，然後 `claude --resume <新ID>` 無縫接上。
 * 不是摘要，是原文。
 *
 * ⚠️ 軍規第一條：先備份，再 forge。
 *    這是社群 hack 而非官方功能，依賴 Claude Code 當前的 jsonl 儲存格式，
 *    版本升級隨時可能失效。永遠不要把唯一的記憶副本交給它。
 *
 * 用法：
 *   node forge-reload.js --dry-run                 # 預演，看看會怎麼切（不寫任何檔案）
 *   node forge-reload.js                           # 自動選最近的 session，保留 ~100k tokens
 *   node forge-reload.js <session-id> --retain 45000
 *   node forge-reload.js <session-id> --squash-tools          # 超長工具輸出降採樣
 *   node forge-reload.js <session-id> --inject handoff.md     # 注入交接包（見 docs/DESIGN.md）
 *   node forge-reload.js --skip-markers "[keepalive],[某標記]" # 追加切點黑名單
 *
 * by Seth × Vivi · https://github.com/Vivi-Seth/forge-reload
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const PROJECTS_ROOT = path.join(HOME, '.claude', 'projects');
const FORGE_HISTORY = path.join(HOME, '.claude', 'forge_history.json');

function uuid4() { return crypto.randomUUID(); }

// «--squash-tools»：超長工具輸出降採樣（頭60%+尾25%+裁剪標記）。
// 病根：單個 turn 裡幾百 KB 的 tool_result 會把切點撐出「死區」——retain 選多少
// 都只能落到死區兩端，中間沒有可選值。工具輸出是最低價值內容；
// text/thinking 一字不碰；最後一個真實 user turn（可能是進行中的工作）整段保護。
// 必須在 token 估算之前跑，boundary 計算才能用瘦身後的真實大小。
function truncMid(s, cap) {
  if (typeof s !== 'string' || s.length <= cap) return s;
  const head = Math.floor(cap * 0.6), tail = Math.floor(cap * 0.25);
  return s.slice(0, head)
    + '\n\n…[forge --squash-tools: 此處裁剪 ' + (s.length - head - tail) + ' chars 工具輸出]…\n\n'
    + s.slice(s.length - tail);
}
function squashToolOutputs(convs, cap) {
  let guard = convs.length; // 保護區起點：最後一個 real user msg
  for (let i = convs.length - 1; i >= 0; i--) if (isRealUserMsg(convs[i])) { guard = i; break; }
  let nBlocks = 0, saved = 0;
  const squashStr = (s) => { const t = truncMid(s, cap); if (t !== s) { nBlocks++; saved += s.length - t.length; } return t; };
  for (let i = 0; i < guard; i++) {
    const c = convs[i].message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === 'tool_result') {
        if (typeof b.content === 'string') b.content = squashStr(b.content);
        else if (Array.isArray(b.content)) {
          for (let j = 0; j < b.content.length; j++) {
            const inner = b.content[j];
            if (inner && inner.type === 'text' && typeof inner.text === 'string') inner.text = squashStr(inner.text);
            else if (inner && inner.type === 'image' && inner.source?.data && inner.source.data.length > cap) {
              const origBytes = Math.round(inner.source.data.length * 0.75);
              nBlocks++; saved += inner.source.data.length;
              b.content[j] = { type: 'text', text: '[歷史圖片（工具輸出） · ' + (inner.source.media_type || 'image') + ' · 約 ' + origBytes + ' bytes · forge squash]' };
            }
          }
        }
      } else if (b.type === 'tool_use' && b.input && typeof b.input === 'object') {
        for (const k of Object.keys(b.input)) {
          if (typeof b.input[k] === 'string') b.input[k] = squashStr(b.input[k]);
        }
      }
    }
  }
  if (nBlocks) console.log('🔧 squash-tools: ' + nBlocks + ' 個超長工具塊降採樣，省 ~' + saved + ' chars (cap=' + cap + ', 末turn保護)');
  return { nBlocks, saved };
}

// 把 image block 整體替換成 text 佔位符，避免 base64 撐爆新檔案
function sanitizeEvent(ev) {
  const copy = JSON.parse(JSON.stringify(ev));
  const blocks = copy.message?.content;
  if (Array.isArray(blocks)) {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.type === 'image' && b.source?.data) {
        const origBytes = Math.round(b.source.data.length * 0.75);
        blocks[i] = {
          type: 'text',
          text: '[歷史圖片 · ' + (b.source.media_type || 'image') + ' · 約 ' + origBytes + ' bytes · forge 時清理 base64]'
        };
      }
      // tool_result 內嵌 image（Read 圖片檔案的產物）——同樣替換，否則 base64 原樣沉進新 jsonl
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        for (let j = 0; j < b.content.length; j++) {
          const inner = b.content[j];
          if (inner && inner.type === 'image' && inner.source?.data) {
            const origBytes = Math.round(inner.source.data.length * 0.75);
            b.content[j] = {
              type: 'text',
              text: '[歷史圖片（工具輸出） · ' + (inner.source.media_type || 'image') + ' · 約 ' + origBytes + ' bytes · forge 時清理 base64]'
            };
          }
        }
      }
    }
  }
  return copy;
}

const IMAGE_TOK_EST = 2000;
const EVENT_OVERHEAD_TOK = 25;
// 只估算真正進 context 的內容（text/thinking/tool_use input/tool_result 文字），
// 不算 jsonl 元資料（uuid/parentUuid/timestamp/cwd 等——這些不進模型 context）。
// 校準：CJK ≈ 1 tok/字，ASCII ≈ 3.8 char/tok（用真實 session 實測擬合）。
// 曾經的 bug：按整條事件的 JSON 長度估算會把元資料全算進去 → 虛高 2~4x
// → 選 retain=100k 實際只接上 ~50k。現在版：選多少 ≈ 接上多少。
function estimateTokens(ev) {
  const c = ev.message?.content;
  let txt = '';
  let images = 0;
  if (typeof c === 'string') txt = c;
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (b.type === 'text') txt += b.text || '';
      else if (b.type === 'thinking') txt += b.thinking || '';
      else if (b.type === 'tool_use') txt += JSON.stringify(b.input || {});
      else if (b.type === 'tool_result') {
        // tool_result 內嵌 image 若按文字長度計，300KB base64 ≈ +80k tok 虛高
        // → 單 turn 撐出 boundary 死區。實際模型只花 ~IMAGE_TOK_EST，照頂層 image 同樣記。
        const c2 = b.content;
        if (typeof c2 === 'string') txt += c2;
        else if (Array.isArray(c2)) {
          for (const inner of c2) {
            if (inner && inner.type === 'image' && inner.source?.data) images++;
            else if (inner && inner.type === 'text') txt += inner.text || '';
            else txt += JSON.stringify(inner || {});
          }
        } else txt += JSON.stringify(c2 || '');
      }
      else if (b.type === 'image' && b.source?.data) images++;
    }
  }
  let cjk = 0, other = 0;
  for (let i = 0; i < txt.length; i++) { if (txt.charCodeAt(i) > 0x2E80) cjk++; else other++; }
  return Math.ceil(cjk + other / 3.8) + images * IMAGE_TOK_EST + EVENT_OVERHEAD_TOK;
}

// 切點黑名單：系統偽裝成 user 的內部訊息（保活心跳、注入塊、上一次的交接包……）
// 不配當 forge 邊界錨點——新 session 的第一幕應該是真人說的話，不是一條系統指令。
// 用 --skip-markers "標記1,標記2" 按自己的系統追加。
let SYNTHETIC_MARKERS = ['<forge-handoff>', '[forge交接]'];
function isRealUserMsg(ev) {
  if (ev.type !== 'user' || ev.isMeta) return false;
  const c = ev.message?.content;
  if (!c) return false;
  let txt = '';
  if (typeof c === 'string') txt = c;
  else if (Array.isArray(c)) txt = c.filter(b => b.type === 'text' && b.text).map(b => b.text).join('');
  if (!txt.trim()) return false;
  return !SYNTHETIC_MARKERS.some(m => txt.includes(m));
}
function loadJsonl(fp) {
  const evs = [];
  for (const l of fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim())) {
    try { evs.push(JSON.parse(l)); } catch {}
  }
  return evs;
}

// ~/.claude/projects/ 下每個子目錄對應一個工作目錄（路徑轉成的 slug），session 按 <sid>.jsonl 存放
function listProjectDirs() {
  try {
    return fs.readdirSync(PROJECTS_ROOT)
      .map(d => path.join(PROJECTS_ROOT, d))
      .filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  } catch { return []; }
}
function findSessionFile(sid) {
  for (const dir of listProjectDirs()) {
    const fp = path.join(dir, sid + '.jsonl');
    if (fs.existsSync(fp)) return fp;
  }
  return null;
}
function findLatest() {
  let best = null;
  for (const dir of listProjectDirs()) {
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !f.includes('subagent'))) {
      const fp = path.join(dir, f);
      const mtime = fs.statSync(fp).mtimeMs;
      if (!best || mtime > best.mtime) best = { fp, sid: f.replace('.jsonl', ''), mtime };
    }
  }
  if (!best) { console.error('❌ ' + PROJECTS_ROOT + ' 下找不到任何 session'); process.exit(1); }
  return best;
}

// 自檢 1：新 jsonl 能逐行 parse
function verifyParse(fp) {
  const lines = fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim());
  let ok = 0;
  for (let i = 0; i < lines.length; i++) {
    try { JSON.parse(lines[i]); ok++; } catch (e) { throw new Error('parse fail at line ' + (i + 1) + ': ' + e.message); }
  }
  return ok;
}

// 自檢 2：parentUuid 鏈連貫（第一條 null，後面每條指向前一條 uuid）
// 這條鏈斷了，Claude Code 會把斷點之後的事件當孤兒直接丟掉——必須重建，必須驗證。
function verifyParentChain(events) {
  if (!events.length) throw new Error('empty events');
  if (events[0].parentUuid !== null) throw new Error('first event parentUuid must be null, got: ' + events[0].parentUuid);
  for (let i = 1; i < events.length; i++) {
    if (events[i].parentUuid !== events[i - 1].uuid) {
      throw new Error('chain broken at index ' + i + ': expected parentUuid=' + events[i - 1].uuid + ', got ' + events[i].parentUuid);
    }
  }
  return true;
}

// 自檢 3：記錄 forge_history 用於回滾（舊 jsonl 永遠不刪）
function recordHistory(oldSid, newSid) {
  let history = [];
  try { history = JSON.parse(fs.readFileSync(FORGE_HISTORY, 'utf-8')); } catch {}
  history.push({ old_sid: oldSid, new_sid: newSid, at: new Date().toISOString() });
  if (history.length > 50) history = history.slice(-50);
  fs.writeFileSync(FORGE_HISTORY, JSON.stringify(history, null, 2), 'utf-8');
}

function forge(fp, sid, retain = 100000, dry = false, squashChars = 0, injectFile = null) {
  console.log('📖 session: ' + sid);
  const all = loadJsonl(fp);
  const convs = all.filter(e => e.type === 'user' || e.type === 'assistant');
  console.log('   事件: ' + all.length + ' 總 / ' + convs.length + ' 對話');
  if (squashChars > 0) squashToolOutputs(convs, squashChars); // 必須先於 token 估算
  // 反向累加找 cut：acc 首次超過 retain 的位置
  let acc = 0, cut = 0;
  for (let i = convs.length - 1; i >= 0; i--) { acc += estimateTokens(convs[i]); if (acc > retain) { cut = i + 1; break; } }
  // 末 turn 自身就超 retain 時（squash 的末turn保護會造成），cut 會指到陣列外——clamp 回最後一格，
  // 讓掃描從末尾往回找真 user 邊界，而不是踩空。（26-09-08，霽野；實案：隧道收帳大工具塊）
  if (cut >= convs.length) cut = convs.length - 1;

  // 從 cut 雙向找最近的 real user msg boundary，選讓 kept tokens 更接近 retain 的方向
  // - forward (ks++): kept 更少（跳過 cut→下一 user 之間整段 assistant）
  // - backward (ks--): kept 更多（保留 cut 所在 turn 起點）
  // 只往前掃會在大 turn 場景損失嚴重（選 100k 只留 43k），所以取兩邊更接近的那個。
  let ks_fwd = cut;
  while (ks_fwd < convs.length && !isRealUserMsg(convs[ks_fwd])) ks_fwd++;
  let ks_back = cut;
  while (ks_back > 0 && !isRealUserMsg(convs[ks_back])) ks_back--;

  const t_back = convs.slice(ks_back).reduce((s, e) => s + estimateTokens(e), 0);
  const t_fwd = ks_fwd < convs.length ? convs.slice(ks_fwd).reduce((s, e) => s + estimateTokens(e), 0) : 0;

  let ks;
  if (ks_fwd >= convs.length) {
    ks = ks_back;
    console.warn('⚠️  forward-scan 越過末尾，用 backward (ks ' + ks_back + ')');
  } else if (!isRealUserMsg(convs[ks_back])) {
    ks = ks_fwd;
    console.warn('⚠️  backward-scan 未找到 real user，用 forward (ks ' + ks_fwd + ')');
  } else {
    const d_back = Math.abs(t_back - retain);
    const d_fwd = Math.abs(t_fwd - retain);
    ks = d_back <= d_fwd ? ks_back : ks_fwd;
  }
  console.log('   候選 boundary: backward ~' + t_back + ' tok vs forward ~' + t_fwd + ' tok (retain=' + retain + ') → 選 ' + (ks === ks_back ? 'backward' : 'forward'));
  const kept = convs.slice(ks);
  if (!kept.length) { console.error('❌ kept is empty (no real user message in conversation), aborting'); process.exit(1); }
  let tc = 0;
  for (const e of kept) if (e.type === 'assistant' && Array.isArray(e.message?.content)) tc += e.message.content.filter(b => b.type === 'thinking').length;
  console.log('✂️  保留: ' + kept.length + ' 條 (~' + kept.reduce((s, e) => s + estimateTokens(e), 0) + ' tok) | thinking: ' + tc);
  const ns = uuid4(); let pu = null;
  for (const e of kept) { e.sessionId = ns; e.parentUuid = pu; pu = e.uuid; }

  // 自檢 2（記憶體中驗證 parentUuid 鏈，寫檔前）
  try { verifyParentChain(kept); console.log('✅ parentUuid 鏈連貫'); }
  catch (e) { console.error('❌ parentUuid 驗證失敗: ' + e.message); process.exit(1); }

  // base64 sanitize：寫新 jsonl 前把 image block 的 base64 替換成 text 說明
  const imgCount = kept.reduce((n, e) => n + (Array.isArray(e.message?.content) ? e.message.content.filter(b => b.type === 'image' && b.source?.data).length : 0), 0);
  const sanitized = kept.map(sanitizeEvent);
  if (imgCount) console.log('🖼️  sanitize 了 ' + imgCount + ' 張圖（base64 替換為 text 佔位）');

  // 交接包注入：把 --inject 指定的檔案內容作為新 jsonl 的第一條 user 事件。
  // 讓新 session 睜眼的第一份讀物，是上一段自己親手寫的交接，不是斷崖。
  // 交接包怎麼寫、寫什麼，見 docs/DESIGN.md 的「交接包協議」。
  if (injectFile) {
    const injText = fs.readFileSync(injectFile, 'utf-8').trim();
    const body = '<forge-handoff>\n（這不是對方發來的訊息——是過隧道前的你留下的交接包。讀完直接繼續，一切照舊。）\n\n'
      + injText + '\n</forge-handoff>';
    const tmpl = sanitized.find(e => e.type === 'user') || sanitized[0];
    const inj = JSON.parse(JSON.stringify(tmpl));
    inj.type = 'user'; inj.isMeta = false; inj.uuid = uuid4(); inj.parentUuid = null;
    if (inj.timestamp) inj.timestamp = new Date().toISOString();
    delete inj.toolUseResult;
    inj.message = { role: 'user', content: [{ type: 'text', text: body }] };
    sanitized.unshift(inj);
    let puInj = null;
    for (const e of sanitized) { e.parentUuid = puInj; puInj = e.uuid; }
    console.log('🎁 交接包注入: ' + injText.length + ' chars');
  }

  if (dry) { console.log('🔍 dry-run — 新ID: ' + ns); return; }

  const newFp = path.join(path.dirname(fp), ns + '.jsonl');
  fs.writeFileSync(newFp, sanitized.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');

  // 自檢 1：寫完後立即逐行 parse 驗證
  try { const ok = verifyParse(newFp); console.log('✅ JSONL parse 驗證: ' + ok + ' 行'); }
  catch (e) { console.error('❌ parse 驗證失敗: ' + e.message + '\n⚠️  刪除新檔案'); fs.unlinkSync(newFp); process.exit(1); }

  // 自檢 3：記錄 forge_history 用於回滾
  recordHistory(sid, ns);
  console.log('📝 已記錄 forge_history: ' + sid + ' -> ' + ns);
  console.log('📂 舊 jsonl 保留: ' + fp + ' (回滾用)');

  console.log('✅ 新ID: ' + ns + '\n🚀 claude --resume ' + ns);
}

if (require.main === module) {
  const args = process.argv.slice(2); let sid = null, ret = 100000, dry = false, squash = 0, inject = null, force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--retain' && args[i + 1]) ret = parseInt(args[++i]);
    else if (args[i] === '--dry-run') dry = true;
    else if (args[i] === '--force') force = true;
    else if (args[i] === '--squash-tools') { squash = (args[i + 1] && /^\d+$/.test(args[i + 1])) ? parseInt(args[++i]) : 16000; }
    else if (args[i] === '--inject' && args[i + 1]) { inject = args[++i]; }
    else if (args[i] === '--skip-markers' && args[i + 1]) { SYNTHETIC_MARKERS = SYNTHETIC_MARKERS.concat(args[++i].split(',').map(s => s.trim()).filter(Boolean)); }
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('用法: node forge-reload.js [session-id] [--retain N] [--dry-run] [--squash-tools [chars]] [--inject file] [--skip-markers "a,b"] [--force]');
      console.log('詳見 README.md 與 docs/TUTORIAL.md。軍規第一條：先備份，再 forge。');
      process.exit(0);
    }
    else if (!args[i].startsWith('--')) sid = args[i];
  }
  let fp;
  if (sid) {
    fp = findSessionFile(sid);
    if (!fp) { console.error('❌ 在 ' + PROJECTS_ROOT + ' 的所有專案目錄裡都找不到 ' + sid + '.jsonl'); process.exit(1); }
  } else {
    const latest = findLatest();
    fp = latest.fp; sid = latest.sid;
  }
  // 26-09-03 攔「舊窗剪過再剪」：舊窗剪完後若被系統喚醒、照便籤又剪一次，會生出第二扇沒人接的新窗
  // （霽野 5.1 線實案：212b0254 一晚剪兩刀→三扇窗，她問「5.1 為什麼那麼多窗」）。程式攔，不靠記得。
  if (!dry && !force) {
    let history = [];
    try { history = JSON.parse(fs.readFileSync(FORGE_HISTORY, 'utf-8')); } catch {}
    const prior = history.filter(h => h.old_sid === sid);
    if (prior.length > 0) {
      const last = prior[prior.length - 1];
      console.error('⛔ 這扇窗已經剪過（' + last.at + ' → 新窗 ' + last.new_sid + '）。你多半是被喚醒的舊窗：不要再剪，去確認新窗有沒有接上；真要重剪加 --force。');
      process.exit(2);
    }
  }
  console.log('⚙️  retain: ' + ret + (squash ? ' | squash-tools: ' + squash : '') + (inject ? ' | inject: ' + inject : '') + (dry ? ' | DRY RUN' : '') + '\n');
  forge(fp, sid, ret, dry, squash, inject);
}
module.exports = { sanitizeEvent, forge, truncMid, squashToolOutputs, estimateTokens };
