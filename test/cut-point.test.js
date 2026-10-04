// 切點規則的測試：剪刀下刀的位置，一定要是一個回合的開頭。
// 用法：node test/cut-point.test.js
// 全部走乾跑，而且不寫任何檔——假的對話內容直接餵給讀檔函式，唯讀環境也能跑。
//
// 為什麼要測這個：新 session 的歷史裡，每個工具結果都要找得到它前面的工具呼叫。
// 切點落在回合中間（工具呼叫與結果之間，或是一則同時帶著工具結果的訊息上），
// 結果留下來、呼叫被切掉，新 session 一開口 API 就拒收。
const fs = require('fs');
const path = require('path');
const F = require(path.join(__dirname, '..', 'forge-reload.js'));

const T = '2026-01-01T00:00:00.000Z';
const user = (uuid, content) => ({ type: 'user', uuid, sessionId: 's', parentUuid: null, timestamp: T, message: { role: 'user', content } });
const asst = (uuid, content) => ({ type: 'assistant', uuid, sessionId: 's', parentUuid: null, timestamp: T, message: { role: 'assistant', content } });
const use = (id) => ({ type: 'tool_use', id, name: 'Read', input: {} });
const res = (id) => ({ type: 'tool_result', tool_use_id: id, content: 'r' });
const txt = (t) => ({ type: 'text', text: t });

// cut：指定切點的 uuid；null＝讓剪刀自己找。expect：ok（剪得下去）／fail（要被擋下）
const cases = [
  { name: '正常回合開頭', cut: 'cut', expect: 'ok',
    rows: [user('u0', 'hi'), asst('a0', [txt('hello')]), user('cut', 'continue'), asst('a1', [txt('done')])] },
  { name: '切點那則同時帶工具結果與文字', cut: 'cut', expect: 'fail',
    rows: [user('u0', 'hi'), asst('a0', [use('t0')]), user('cut', [res('t0'), txt('reminder')]), asst('a1', [txt('done')])] },
  { name: '切點在工具呼叫與結果之間', cut: 'cut', expect: 'fail',
    rows: [user('u0', 'hi'), asst('a0', [use('t0')]), user('cut', 'interjected'), user('r0', [res('t0')]), asst('a1', [txt('done')])] },
  { name: '段尾有還沒結果的工具呼叫', cut: 'cut', expect: 'ok',
    rows: [user('u0', 'hi'), asst('a0', [txt('x')]), user('cut', 'go'), asst('a1', [use('t9')])] },
  { name: '保留段內呼叫與結果成對', cut: 'cut', expect: 'ok',
    rows: [user('u0', 'hi'), asst('a0', [txt('x')]), user('cut', 'go'), asst('a1', [use('t1')]), user('r1', [res('t1')]), asst('a2', [txt('done')])] },
  { name: '平行兩個呼叫、結果分兩則', cut: 'cut', expect: 'ok',
    rows: [user('u0', 'hi'), asst('a0', [txt('x')]), user('cut', 'go'), asst('a1', [use('t1')]), asst('a1b', [use('t2')]), user('r1', [res('t1')]), user('r2', [res('t2')]), asst('a2', [txt('done')])] },
  { name: '切點是純工具結果', cut: 'r0', expect: 'fail',
    rows: [user('u0', 'hi'), asst('a0', [use('t0')]), user('r0', [res('t0')]), asst('a1', [txt('done')])] },
  { name: '切點指到助理訊息', cut: 'a0', expect: 'fail',
    rows: [user('u0', 'hi'), asst('a0', [txt('x')]), user('u1', 'go'), asst('a1', [txt('done')])] },
  { name: '切點的 uuid 不存在', cut: 'nope', expect: 'fail',
    rows: [user('u0', 'hi'), asst('a0', [txt('x')])] },
  { name: '不指定、有真人訊息', cut: null, expect: 'ok',
    rows: [user('u0', 'hi'), asst('a0', [use('t0')]), user('r0', [res('t0')]), asst('a1', [txt('done')]), user('u1', 'next'), asst('a2', [txt('ok')])] },
  { name: '不指定、整扇沒有真人訊息', cut: null, expect: 'fail',
    rows: [asst('a0', [use('t0')]), user('r0', [res('t0')]), asst('a1', [txt('done')])] },
];

// 假檔案：路徑以 FX: 開頭的，讀到的是上面的假對話；其他路徑照常讀。
const fake = new Map();
const realRead = fs.readFileSync;
fs.readFileSync = (p, ...rest) => (fake.has(String(p)) ? fake.get(String(p)) : realRead(p, ...rest));
const realWrite = fs.writeFileSync;
fs.writeFileSync = (p) => { throw new Error('乾跑不該寫檔：' + p); };

let allOk = true;
cases.forEach((c, i) => {
  const fp = 'FX:' + i;
  fake.set(fp, c.rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const keep = { exit: process.exit, log: console.log, error: console.error, warn: console.warn };
  const logs = [];
  console.log = console.error = console.warn = s => logs.push(String(s));
  process.exit = code => { throw new Error('EXIT ' + code); };
  let outcome = 'ok';
  try { F.forge(fp, 'sid', 100000, true, 0, null, c.cut); }
  catch (e) { outcome = /^EXIT 1$/.test(e.message) ? 'fail' : 'crash: ' + e.message; }
  Object.assign(process, { exit: keep.exit }); console.log = keep.log; console.error = keep.error; console.warn = keep.warn;
  const pass = outcome === c.expect;
  allOk = allOk && pass;
  const why = logs.filter(l => l.includes('❌')).map(l => l.replace(/\s+/g, ' ').slice(0, 64)).join(' / ');
  console.log((pass ? '[過]   ' : '[不過] ') + c.name + '：預期 ' + c.expect + '、實得 ' + outcome + (why ? '｜' + why : ''));
});
fs.readFileSync = realRead; fs.writeFileSync = realWrite;
console.log('全部：' + (allOk ? '過' : '有不過') + '（' + cases.length + ' 例）');
process.exitCode = allOk ? 0 : 1;
