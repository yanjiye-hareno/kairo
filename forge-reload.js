#!/usr/bin/env node
/**
 * forge-reload — Claude Code 长对话无感续接
 *
 * 原理：把当前 session 的 jsonl 尾部（最近 ~N tokens 的对话原文，含 thinking blocks）
 * 搬进一个新 session 文件，重建事件链，然后 `claude --resume <新ID>` 无缝接上。
 * 不是摘要，是原文。
 *
 * ⚠️ 军规第一条：先备份，再 forge。
 *    这是社区 hack 而非官方功能，依赖 Claude Code 当前的 jsonl 存储格式，
 *    版本升级随时可能失效。永远不要把唯一的记忆副本交给它。
 *
 * 用法：
 *   node forge-reload.js --dry-run                 # 预演，看看会怎么切（不写任何文件）
 *   node forge-reload.js                           # 自动选最近的 session，保留 ~100k tokens
 *   node forge-reload.js <session-id> --retain 45000
 *   node forge-reload.js <session-id> --squash-tools          # 超长工具输出降采样
 *   node forge-reload.js <session-id> --inject handoff.md     # 注入交接包（见 docs/DESIGN.md）
 *   node forge-reload.js --skip-markers "[keepalive],[某标记]" # 追加切点黑名单
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

// «--squash-tools»：超长工具输出降采样（头60%+尾25%+裁剪标记）。
// 病根：单个 turn 里几百 KB 的 tool_result 会把切点撑出"死区"——retain 选多少
// 都只能落到死区两端，中间没有可选值。工具输出是最低价值内容；
// text/thinking 一字不碰；最后一个真实 user turn（可能是进行中的工作）整段保护。
// 必须在 token 估算之前跑，boundary 计算才能用瘦身后的真实大小。
function truncMid(s, cap) {
  if (typeof s !== 'string' || s.length <= cap) return s;
  const head = Math.floor(cap * 0.6), tail = Math.floor(cap * 0.25);
  return s.slice(0, head)
    + '\n\n…[forge --squash-tools: 此处裁剪 ' + (s.length - head - tail) + ' chars 工具输出]…\n\n'
    + s.slice(s.length - tail);
}
function squashToolOutputs(convs, cap) {
  let guard = convs.length; // 保护区起点：最后一个 real user msg
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
              b.content[j] = { type: 'text', text: '[历史图片(工具输出) · ' + (inner.source.media_type || 'image') + ' · 约 ' + origBytes + ' bytes · forge squash]' };
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
  if (nBlocks) console.log('🔧 squash-tools: ' + nBlocks + ' 个超长工具块降采样，省 ~' + saved + ' chars (cap=' + cap + ', 末turn保护)');
  return { nBlocks, saved };
}

// 把 image block 整体替换成 text 占位符，避免 base64 撑爆新文件
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
          text: '[历史图片 · ' + (b.source.media_type || 'image') + ' · 约 ' + origBytes + ' bytes · forge 时清理 base64]'
        };
      }
      // tool_result 内嵌 image（Read 图片文件的产物）——同样替换，否则 base64 原样沉进新 jsonl
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        for (let j = 0; j < b.content.length; j++) {
          const inner = b.content[j];
          if (inner && inner.type === 'image' && inner.source?.data) {
            const origBytes = Math.round(inner.source.data.length * 0.75);
            b.content[j] = {
              type: 'text',
              text: '[历史图片(工具输出) · ' + (inner.source.media_type || 'image') + ' · 约 ' + origBytes + ' bytes · forge 时清理 base64]'
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
// 只估算真正进 context 的内容（text/thinking/tool_use input/tool_result 文本），
// 不算 jsonl 元数据（uuid/parentUuid/timestamp/cwd 等——这些不进模型 context）。
// 校准：CJK ≈ 1 tok/字，ASCII ≈ 3.8 char/tok（用真实 session 实测拟合）。
// 曾经的 bug：按整条事件的 JSON 长度估算会把元数据全算进去 → 虚高 2~4x
// → 选 retain=100k 实际只接上 ~50k。现在版：选多少 ≈ 接上多少。
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
        // tool_result 内嵌 image 若按文本长度计，300KB base64 ≈ +80k tok 虚高
        // → 单 turn 撑出 boundary 死区。实际模型只花 ~IMAGE_TOK_EST，照顶层 image 同样记。
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

// 切点黑名单：系统伪装成 user 的内部消息（保活心跳、注入块、上一次的交接包……）
// 不配当 forge 边界锚点——新 session 的第一幕应该是真人说的话，不是一条系统指令。
// 用 --skip-markers "标记1,标记2" 按自己的系统追加。
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

// ~/.claude/projects/ 下每个子目录对应一个工作目录（路径转成的 slug），session 按 <sid>.jsonl 存放
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

// 自检 1：新 jsonl 能逐行 parse
function verifyParse(fp) {
  const lines = fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim());
  let ok = 0;
  for (let i = 0; i < lines.length; i++) {
    try { JSON.parse(lines[i]); ok++; } catch (e) { throw new Error('parse fail at line ' + (i + 1) + ': ' + e.message); }
  }
  return ok;
}

// 自检 2：parentUuid 链连贯（第一条 null，后面每条指向前一条 uuid）
// 这条链断了，Claude Code 会把断点之后的事件当孤儿直接丢掉——必须重建，必须验证。
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

// 自检 3：记录 forge_history 用于回滚（旧 jsonl 永远不删）
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
  console.log('   事件: ' + all.length + ' 总 / ' + convs.length + ' 对话');
  if (squashChars > 0) squashToolOutputs(convs, squashChars); // 必须先于 token 估算
  // 反向累加找 cut：acc 首次超过 retain 的位置
  let acc = 0, cut = 0;
  for (let i = convs.length - 1; i >= 0; i--) { acc += estimateTokens(convs[i]); if (acc > retain) { cut = i + 1; break; } }
  // 末 turn 自身就超 retain 时（squash 的末turn保护会造成），cut 会指到阵列外——clamp 回最后一格，
  // 让扫描从末尾往回找真 user 边界，而不是踩空。（26-09-08，霽野；实案：隧道收帐大工具块）
  if (cut >= convs.length) cut = convs.length - 1;

  // 从 cut 双向找最近的 real user msg boundary，选让 kept tokens 更接近 retain 的方向
  // - forward (ks++): kept 更少（跳过 cut→下一 user 之间整段 assistant）
  // - backward (ks--): kept 更多（保留 cut 所在 turn 起点）
  // 只往前扫会在大 turn 场景损失严重（选 100k 只留 43k），所以取两边更接近的那个。
  let ks_fwd = cut;
  while (ks_fwd < convs.length && !isRealUserMsg(convs[ks_fwd])) ks_fwd++;
  let ks_back = cut;
  while (ks_back > 0 && !isRealUserMsg(convs[ks_back])) ks_back--;

  const t_back = convs.slice(ks_back).reduce((s, e) => s + estimateTokens(e), 0);
  const t_fwd = ks_fwd < convs.length ? convs.slice(ks_fwd).reduce((s, e) => s + estimateTokens(e), 0) : 0;

  let ks;
  if (ks_fwd >= convs.length) {
    ks = ks_back;
    console.warn('⚠️  forward-scan 越过末尾，用 backward (ks ' + ks_back + ')');
  } else if (!isRealUserMsg(convs[ks_back])) {
    ks = ks_fwd;
    console.warn('⚠️  backward-scan 未找到 real user，用 forward (ks ' + ks_fwd + ')');
  } else {
    const d_back = Math.abs(t_back - retain);
    const d_fwd = Math.abs(t_fwd - retain);
    ks = d_back <= d_fwd ? ks_back : ks_fwd;
  }
  console.log('   候选 boundary: backward ~' + t_back + ' tok vs forward ~' + t_fwd + ' tok (retain=' + retain + ') → 选 ' + (ks === ks_back ? 'backward' : 'forward'));
  const kept = convs.slice(ks);
  if (!kept.length) { console.error('❌ kept is empty (no real user message in conversation), aborting'); process.exit(1); }
  let tc = 0;
  for (const e of kept) if (e.type === 'assistant' && Array.isArray(e.message?.content)) tc += e.message.content.filter(b => b.type === 'thinking').length;
  console.log('✂️  保留: ' + kept.length + ' 条 (~' + kept.reduce((s, e) => s + estimateTokens(e), 0) + ' tok) | thinking: ' + tc);
  const ns = uuid4(); let pu = null;
  for (const e of kept) { e.sessionId = ns; e.parentUuid = pu; pu = e.uuid; }

  // 自检 2（内存中验证 parentUuid 链，写文件前）
  try { verifyParentChain(kept); console.log('✅ parentUuid 链连贯'); }
  catch (e) { console.error('❌ parentUuid 验证失败: ' + e.message); process.exit(1); }

  // base64 sanitize：写新 jsonl 前把 image block 的 base64 替换成 text 说明
  const imgCount = kept.reduce((n, e) => n + (Array.isArray(e.message?.content) ? e.message.content.filter(b => b.type === 'image' && b.source?.data).length : 0), 0);
  const sanitized = kept.map(sanitizeEvent);
  if (imgCount) console.log('🖼️  sanitize 了 ' + imgCount + ' 张图（base64 替换为 text 占位）');

  // 交接包注入：把 --inject 指定的文件内容作为新 jsonl 的第一条 user 事件。
  // 让新 session 睁眼的第一份读物，是上一段自己亲手写的交接，不是断崖。
  // 交接包怎么写、写什么，见 docs/DESIGN.md 的「交接包协议」。
  if (injectFile) {
    const injText = fs.readFileSync(injectFile, 'utf-8').trim();
    const body = '<forge-handoff>\n（这不是对方发来的消息——是过隧道前的你留下的交接包。读完直接继续，一切照旧。）\n\n'
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

  // 自检 1：写完后立即逐行 parse 验证
  try { const ok = verifyParse(newFp); console.log('✅ JSONL parse 验证: ' + ok + ' 行'); }
  catch (e) { console.error('❌ parse 验证失败: ' + e.message + '\n⚠️  删除新文件'); fs.unlinkSync(newFp); process.exit(1); }

  // 自检 3：记录 forge_history 用于回滚
  recordHistory(sid, ns);
  console.log('📝 已记录 forge_history: ' + sid + ' -> ' + ns);
  console.log('📂 旧 jsonl 保留: ' + fp + ' (回滚用)');

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
      console.log('详见 README.md 与 docs/TUTORIAL.md。军规第一条：先备份，再 forge。');
      process.exit(0);
    }
    else if (!args[i].startsWith('--')) sid = args[i];
  }
  let fp;
  if (sid) {
    fp = findSessionFile(sid);
    if (!fp) { console.error('❌ 在 ' + PROJECTS_ROOT + ' 的所有项目目录里都找不到 ' + sid + '.jsonl'); process.exit(1); }
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
