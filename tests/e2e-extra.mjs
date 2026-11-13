// きりとりAI の E2E（追加分）: 失敗時の表示、履歴のページ送り、大きすぎる画像の JPEG 化、こまかい操作。
// 実行: node tests/e2e-extra.mjs（引数は省略可: <index.html のパス、または公開先の URL> <出力フォルダ>）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pageUrl, outDir, chromePath } from './env.mjs';

const CHROME = chromePath();
const PORT = 10400 + Math.floor(Math.random() * 300);
const profile = path.join(outDir, 'profile-extra-' + Date.now());
const results = [];
let failed = 0;
function check(name, cond, detail) {
  results.push((cond ? 'ok   ' : 'FAIL ') + name + (cond || detail === undefined ? '' : '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
  if (!cond) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STUB = `(() => {
  try { if (!localStorage.getItem('kiritori-ai.v1')) localStorage.setItem('kiritori-ai.v1', JSON.stringify({ keys: { claude: 'sk-ant-k1', gemini: 'AIza-k2' } })); } catch (e) {}
  window.__reqs = []; window.__mock = { mode: 'ok', noise: false };
  navigator.mediaDevices.getDisplayMedia = async () => {
    const noise = window.__mock.noise;
    const c = document.createElement('canvas'); c.width = noise ? 2600 : 1600; c.height = noise ? 1500 : 900;
    const g = c.getContext('2d');
    if (noise) {
      const im = g.createImageData(c.width, c.height); const d = im.data;
      let x = 123456789;
      for (let i = 0; i < d.length; i += 4) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; d[i] = x & 255; d[i + 1] = (x >>> 8) & 255; d[i + 2] = (x >>> 16) & 255; d[i + 3] = 255; }
      g.putImageData(im, 0, 0);
    } else { g.fillStyle = '#336699'; g.fillRect(0, 0, c.width, c.height); }
    let k = 0;
    window.__fakeTimer = setInterval(() => { g.fillStyle = (k++ % 2) ? '#000' : '#fff'; g.fillRect(0, 0, 2, 2); }, 100);
    return (window.__fakeStream = c.captureStream(15));
  };
  const ev = (name, obj) => 'event: ' + name + '\\ndata: ' + JSON.stringify(obj) + '\\n\\n';
  const sseRes = (text) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
  let n = 0;
  window.fetch = async (input, init) => {
    init = init || {};
    const url = String(input); let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch (e) { body = null; }
    window.__reqs.push({ url, body });
    const mode = window.__mock.mode;
    if (url.startsWith('https://api.anthropic.com/v1/models')) return json({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_tokens: 128000 }], has_more: false });
    if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models')) return json({ models: [{ name: 'models/gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen', supportedGenerationMethods: ['generateContent'], thinking: true }] });
    if (mode === 'network') throw new TypeError('Failed to fetch');
    if (url === 'https://api.anthropic.com/v1/messages') {
      if (mode === 'streamerror') return sseRes(ev('message_start', { type: 'message_start', message: { model: body.model, usage: { input_tokens: 5 } } }) + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '途中まで' } }) + ev('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
      if (mode === 'empty') return new Response('<html>gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      n++;
      return sseRes(ev('message_start', { type: 'message_start', message: { model: body.model, usage: { input_tokens: 5 } } }) + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '回答 ' + n } }) + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) + ev('message_stop', { type: 'message_stop' }));
    }
    if (url === 'https://generativelanguage.googleapis.com/v1beta/interactions') {
      if (mode === 'gemini400') return json([{ error: { code: 400, message: 'Thinking level xhigh is not supported for this model.', status: 'INVALID_ARGUMENT' } }], 400);
      if (mode === 'geminiStreamError') return sseRes(ev('interaction.created', { interaction: { id: 'v1', status: 'in_progress', model: body.model }, event_type: 'interaction.created' }) + ev('error', { error: { message: 'Deadline expired before operation could complete.', code: 'gateway_timeout' }, event_type: 'error' }));
      if (mode === 'geminiIncomplete') return sseRes(ev('step.start', { index: 0, step: { type: 'model_output' }, event_type: 'step.start' }) + ev('step.delta', { index: 0, delta: { type: 'text', text: '途中' }, event_type: 'step.delta' }) + ev('interaction.completed', { interaction: { id: 'v1', status: 'incomplete', usage: { total_input_tokens: 3, total_output_tokens: 4 } }, event_type: 'interaction.completed' }));
    }
    throw new TypeError('unexpected fetch: ' + url);
  };
})();`;

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id) { const p = this.pending.get(msg.id); if (p) { this.pending.delete(msg.id); if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result); } }
      else this.listeners.forEach((l) => l(msg));
    });
  }
  send(method, params, sessionId) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId })); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
}
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
let exitCode = 1;
try {
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); } catch (e) { await sleep(250); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p, sessionId);
  const problems = [];
  cdp.listeners.push((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (msg.params.exceptionDetails.exception && msg.params.exceptionDetails.exception.description || msg.params.exceptionDetails.text));
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(msg.params.type)) problems.push('console.' + msg.params.type + ': ' + msg.params.args.map((a) => a.value || a.description).join(' '));
    if (msg.method === 'Log.entryAdded' && ['error', 'warning'].includes(msg.params.entry.level)) problems.push('log.' + msg.params.entry.level + ': ' + msg.params.entry.text);
  });
  await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await S('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  async function ev(expression) {
    const r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('evaluate failed: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text) + '\n  in: ' + expression.slice(0, 200));
    return r.result.value;
  }
  async function waitFor(expression, label, timeout = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (await ev(expression)) return true; await sleep(50); }
    check('wait: ' + label, false, 'timeout; status=' + (await ev(`document.getElementById('curStatus').textContent + ' | ' + document.getElementById('flash').textContent`)));
    return false;
  }
  const click = (id) => ev(`document.getElementById(${JSON.stringify(id)}).click()`);
  const text = (id) => ev(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const setModel = (id) => ev(`(() => { const s = document.getElementById('modelSelect'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  async function navigate() {
    const loaded = new Promise((res) => { const l = (m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { cdp.listeners.splice(cdp.listeners.indexOf(l), 1); res(); } }; cdp.listeners.push(l); });
    await S('Page.navigate', { url: pageUrl });
    await loaded; await sleep(300);
  }
  async function sendAndWait(prefix) {
    await click('sendBtn');
    return waitFor(`document.getElementById('curStatus').textContent.startsWith(${JSON.stringify(prefix)}) && document.getElementById('sendBtn').textContent === 'この範囲を AI に送る'`, '送信 → ' + prefix);
  }

  // ---- 1. 起動時: キーはあるが一覧が未取得 → 裏で取得 ----
  await navigate();
  await waitFor(`window.__reqs.filter((q) => q.url.includes('/models')).length === 2 && document.querySelectorAll('#modelSelect option').length === 2`, '起動時のモデル一覧取得');
  check('1 起動時に両方の一覧を取得して反映', await ev(`JSON.stringify(Array.from(document.querySelectorAll('#modelSelect option')).map((o) => o.value))`) === JSON.stringify(['claude-opus-5-5', 'gemini-4-hydrogen']));
  check('1 お知らせは出ない', await ev(`document.getElementById('banner').hidden`));
  await click('shareBtn');
  await waitFor(`document.getElementById('video').videoWidth === 1600`, '共有');

  // ---- 2. 失敗時の表示（Claude） ----
  await ev(`window.__mock.mode = 'network'`);
  await sendAndWait('エラー');
  check('2 通信できないとき', (await text('curNotes')).includes('通信できませんでした') && (await text('curNotes')).includes('Failed to fetch'), await text('curNotes'));
  await ev(`window.__mock.mode = 'streamerror'`);
  await sendAndWait('エラー');
  check('2 応答の途中でエラーが来たとき（途中までの文章は残す）', (await text('curNotes')).includes('混み合っています') && (await text('curNotes')).includes('overloaded_error') && (await text('curAnswer')) === '途中まで', [await text('curNotes'), await text('curAnswer')]);
  await ev(`window.__mock.mode = 'empty'`);
  await sendAndWait('エラー');
  check('2 SSE でない応答が返ったとき', (await text('curNotes')).includes('読み取れない形式') && (await text('curNotes')).includes('gateway'), await text('curNotes'));
  check('2 失敗は履歴に残らない', (await text('historyCount')).includes('まだありません'), await text('historyCount'));

  // ---- 3. 失敗時の表示（Gemini） ----
  check('3 Gemini に切り替え', (await setModel('gemini-4-hydrogen')) === 'gemini-4-hydrogen');
  await ev(`window.__mock.mode = 'gemini400'`);
  await sendAndWait('エラー');
  check('3 Gemini の HTTP エラー（配列で包まれた本文）', (await text('curNotes')).includes('API がリクエストを受け付けませんでした') && (await text('curNotes')).includes('Thinking level xhigh is not supported'), await text('curNotes'));
  await ev(`window.__mock.mode = 'geminiStreamError'`);
  await sendAndWait('エラー');
  check('3 Gemini の応答途中のエラー', (await text('curNotes')).includes('gateway_timeout') && (await text('curNotes')).includes('混み合っています'), await text('curNotes'));
  await ev(`window.__mock.mode = 'geminiIncomplete'`);
  await sendAndWait('完了');
  check('3 Gemini が途中で打ち切ったとき（注意書きつきで履歴に残る）', (await text('curNotes')).includes('途中で切れている可能性') && (await text('curAnswer')) === '途中' && (await text('historyCount')) === '1 件', [await text('curNotes'), await text('historyCount')]);

  // ---- 4. 履歴のページ送り ----
  await setModel('claude-opus-5-5');
  await ev(`window.__mock.mode = 'ok'`);
  for (let i = 2; i <= 23; i++) {
    await click('sendBtn');
    if (!(await waitFor(`document.getElementById('historyCount').textContent === '${i} 件' && document.getElementById('sendBtn').textContent === 'この範囲を AI に送る'`, `送信 ${i} 回目`))) break;
  }
  check('4 23 件たまる（開いたままでも全部見える）', (await text('historyCount')) === '23 件' && await ev(`document.querySelectorAll('#historyList .hist').length === 23`));
  await sleep(400);
  await navigate();
  await waitFor(`document.querySelectorAll('#historyList .hist').length === 20`, '履歴の最初の 20 件');
  check('4 開き直すと新しい順に 20 件 + 「さらに表示」', (await text('historyCount')) === '23 件' && await ev(`!document.getElementById('moreHistoryBtn').hidden && document.querySelector('#historyList .hist .snippet').textContent === '回答 22'`), await ev(`document.querySelector('#historyList .hist .snippet').textContent`));
  await click('moreHistoryBtn');
  await waitFor(`document.querySelectorAll('#historyList .hist').length === 23`, '残りの履歴');
  check('4 「さらに表示」で残りが出て、ボタンは消える', await ev(`document.getElementById('moreHistoryBtn').hidden && Array.from(document.querySelectorAll('#historyList .hist .snippet')).pop().textContent === '途中'`));

  // ---- 5. 大きすぎる画像は縮小 + JPEG ----
  await ev(`window.__mock.noise = true`);
  await click('shareBtn');
  await waitFor(`document.getElementById('video').videoWidth === 2600`, '大きな映像の共有', 15000);
  await sendAndWait('完了');
  const big = await ev(`(async () => {
    const src = window.__reqs[window.__reqs.length - 1].body.messages[0].content[0].source;
    const bin = atob(src.data); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u8], { type: src.media_type }));
    return { type: src.media_type, bytes: u8.length, b64: src.data.length, w: bmp.width, h: bmp.height };
  })()`);
  check('5 圧縮しにくい大きな画像は JPEG にして上限内に収める（長辺 2576px・4784 マス以内）', big.type === 'image/jpeg' && big.bytes <= 7000000 && big.b64 < 10 * 1024 * 1024 && Math.max(big.w, big.h) <= 2576 && Math.ceil(big.w / 28) * Math.ceil(big.h / 28) <= 4784 && big.w >= 2450, big);

  // ---- 6. こまかい操作 ----
  await click('openSettings');
  check('6 キーは伏せ字で表示', await ev(`document.getElementById('keyClaude').type === 'password' && document.getElementById('keyClaude').value === 'sk-ant-k1'`));
  await ev(`document.querySelector('[data-reveal="keyClaude"]').click()`);
  check('6 「表示」で見える・「隠す」で戻る', await ev(`document.getElementById('keyClaude').type === 'text' && document.querySelector('[data-reveal="keyClaude"]').textContent === '隠す'`));
  await ev(`document.querySelector('[data-reveal="keyClaude"]').click()`);
  check('6 伏せ字に戻る', await ev(`document.getElementById('keyClaude').type === 'password'`));
  await ev(`(() => { const e = document.getElementById('systemPrompt'); e.value = '自分の文面'; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click('resetPrompt');
  check('6 文面の初期化は 1 回目では実行されない', await ev(`document.getElementById('systemPrompt').value === '自分の文面' && document.getElementById('resetPrompt').classList.contains('armed')`));
  await click('resetPrompt');
  check('6 2 回目で初期の文面に戻る', await ev(`document.getElementById('systemPrompt').value.startsWith('あなたは、画面の一部を切り抜いた画像を受け取るアシスタントです。') && !document.getElementById('resetPrompt').classList.contains('armed')`));
  // 背景（ダイアログの外側）を押すと閉じる
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: 30, y: 450, button: 'left', clickCount: 1 });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 30, y: 450, button: 'left', clickCount: 1 });
  check('6 ダイアログの外側を押すと閉じる', !(await ev(`document.getElementById('settingsDialog').open`)));
  await click('curCopy'); await click('curCopy');
  await sleep(1900);
  check('6 コピーのボタンは連打しても表示が元に戻る', (await text('curCopy')) === 'コピー', await text('curCopy'));
  await click('curThumb');
  check('6 送った画像を拡大できる', await ev(`document.getElementById('imageDialog').open && document.getElementById('bigImage').src.startsWith('blob:')`));
  await click('closeImage');

  check('ページ内のエラーや警告なし', problems.length === 0, problems);
  exitCode = failed ? 1 : 0;
  ws.close();
} catch (err) {
  results.push('ERROR ' + (err && err.stack || err));
} finally {
  chrome.kill();
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 後片付けの失敗は無視 */ }
}
console.log(results.join('\n'));
console.log(exitCode === 0 ? `\ne2e-extra: all ${results.length} checks passed` : `\ne2e-extra: ${failed} FAILED`);
process.exit(exitCode);
