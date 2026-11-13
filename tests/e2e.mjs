// きりとりAI の E2E テスト。実ブラウザ（ヘッドレス Chrome）で index.html を file:// から開き、
// 画面共有と AI の API だけを差し替えて、画面操作 → 切り抜き → 送信 → 表示 → 履歴 までを通す。
// 実行: node tests/e2e.mjs（引数は省略可: <index.html のパス、または公開先の URL> <出力フォルダ>）。出力フォルダに画面写真も残す。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pageUrl, outDir, chromePath } from './env.mjs';

const CHROME = chromePath();
const PORT = 9333 + Math.floor(Math.random() * 400);
const profile = path.join(outDir, 'profile-' + Date.now());

const results = [];
let failed = 0;
function check(name, cond, detail) {
  results.push((cond ? 'ok   ' : 'FAIL ') + name + (cond || detail === undefined ? '' : '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
  if (!cond) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- ページに先回りして差し込むスタブ（画面共有と fetch） ----
const STUB = `(() => {
  window.__real = { gdm: typeof (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia), secure: window.isSecureContext, cc: typeof window.CaptureController };
  window.__reqs = []; window.__mock = { mode: 'ok' };
  if (navigator.mediaDevices) navigator.mediaDevices.getDisplayMedia = async (opts) => {
    window.__gdmOpts = opts;
    const c = document.createElement('canvas'); c.width = 1600; c.height = 900;
    const g = c.getContext('2d');
    const paint = () => {
      g.fillStyle = '#ff0000'; g.fillRect(0, 0, 800, 450); g.fillStyle = '#00ff00'; g.fillRect(800, 0, 800, 450);
      g.fillStyle = '#0000ff'; g.fillRect(0, 450, 800, 450); g.fillStyle = '#ffff00'; g.fillRect(800, 450, 800, 450);
      g.fillStyle = '#000'; g.font = '40px sans-serif'; g.fillText('T' + (Date.now() % 1000), 740, 465);
    };
    paint(); window.__fakeTimer = setInterval(paint, 100);
    return (window.__fakeStream = c.captureStream(15));
  };
  const enc = new TextEncoder();
  function sse(text, size, delay, signal) {
    const chunks = []; for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    let i = 0, timer = 0;
    return new ReadableStream({ start(controller) {
      const onAbort = () => { clearTimeout(timer); try { controller.error(new DOMException('The user aborted a request.', 'AbortError')); } catch (e) {} };
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort); }
      const push = () => { if (i >= chunks.length) { try { controller.close(); } catch (e) {} return; } controller.enqueue(enc.encode(chunks[i++])); timer = setTimeout(push, delay); };
      push();
    } });
  }
  const ev = (name, obj, nl) => 'event: ' + name + nl + 'data: ' + JSON.stringify(obj) + nl + nl;
  function claudeStream(model, mode) {
    const nl = '\\n'; let s = '';
    s += ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 1500, output_tokens: 1 } } }, nl);
    s += ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, nl);
    s += ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '画像を読み取っています。' } }, nl);
    s += ev('content_block_stop', { type: 'content_block_stop', index: 0 }, nl);
    s += ev('ping', { type: 'ping' }, nl);
    s += ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, nl);
    if (mode === 'fallback') {
      s += ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '前半' } }, nl);
      s += ev('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'fallback', from: { model }, to: { model: 'claude-opus-4-8' } } }, nl);
      s += ev('content_block_start', { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } }, nl);
      s += ev('content_block_delta', { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: '後半' } }, nl);
    } else {
      const parts = ['答えは **42** です。\\n\\n', '| 項目 | 金額 |\\n|---|--:|\\n| 現金 | 1,000 |\\n', '\\n<script>window.__xss=1</scr' + 'ipt><img src=x onerror="window.__xss=2">'];
      if (mode === 'slow') for (let k = 0; k < 60; k++) parts.push(' 続き' + k);
      for (const p of parts) s += ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: p } }, nl);
    }
    s += ev('content_block_stop', { type: 'content_block_stop', index: 1 }, nl);
    s += ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 321 } }, nl);
    s += ev('message_stop', { type: 'message_stop' }, nl);
    return s;
  }
  function geminiStream(model) {
    const nl = '\\r\\n'; let s = '';
    s += ev('interaction.created', { interaction: { id: 'v1_x', status: 'in_progress', object: 'interaction', model }, event_type: 'interaction.created' }, nl);
    s += ev('interaction.status_update', { interaction_id: 'v1_x', status: 'in_progress', event_type: 'interaction.status_update' }, nl);
    s += ev('step.start', { index: 0, step: { type: 'thought' }, event_type: 'step.start' }, nl);
    s += ev('step.delta', { index: 0, delta: { content: { text: '**計画** を立てています', type: 'text' }, type: 'thought_summary' }, event_type: 'step.delta' }, nl);
    s += ev('step.delta', { index: 0, delta: { signature: 'sig', type: 'thought_signature' }, event_type: 'step.delta' }, nl);
    s += ev('step.stop', { index: 0, event_type: 'step.stop' }, nl);
    s += ev('step.start', { index: 1, step: { type: 'model_output' }, event_type: 'step.start' }, nl);
    s += ev('step.delta', { index: 1, delta: { text: 'Gemini の回答です。\\n\\n1. 手順A\\n', type: 'text' }, event_type: 'step.delta' }, nl);
    s += ev('step.delta', { index: 1, delta: { text: '2. 手順B', type: 'text' }, event_type: 'step.delta' }, nl);
    s += ev('step.stop', { index: 1, event_type: 'step.stop' }, nl);
    s += ev('interaction.completed', { interaction: { id: 'v1_x', status: 'completed', usage: { total_tokens: 346, total_input_tokens: 1211, total_output_tokens: 90, total_thought_tokens: 245 }, object: 'interaction', model }, event_type: 'interaction.completed' }, nl);
    s += 'event: done' + nl + 'data: [DONE]' + nl + nl;
    return s;
  }
  const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
  const caps = (efforts) => ({ image_input: { supported: true }, thinking: { supported: true, types: { enabled: { supported: false }, adaptive: { supported: true } } },
    effort: Object.assign({ supported: true }, Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max'].map((l) => [l, { supported: efforts.includes(l) }]))) });
  window.fetch = async (input, init) => {
    init = init || {};
    const url = String(input); let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch (e) { body = String(init.body); }
    window.__reqs.push({ url, method: init.method || 'GET', headers: Object.assign({}, init.headers || {}), body, opts: { cache: init.cache, credentials: init.credentials, referrerPolicy: init.referrerPolicy } });
    if (init.signal && init.signal.aborted) throw new DOMException('The user aborted a request.', 'AbortError');
    const mode = window.__mock.mode;
    if (url.startsWith('https://api.anthropic.com/v1/models')) {
      if (mode === 'http401') return json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
      return json({ data: [
        { type: 'model', id: 'claude-fable-5-2', display_name: 'Claude Fable 5.2', max_tokens: 128000, capabilities: caps(['low', 'medium', 'high', 'xhigh', 'max']), allowed_fallback_models: ['claude-opus-5', 'claude-opus-4-8'] },
        { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_tokens: 128000, capabilities: caps(['low', 'medium', 'high', 'xhigh', 'max']), allowed_fallback_models: ['claude-opus-4-8'] },
        { type: 'model', id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', max_tokens: 64000, capabilities: { image_input: { supported: true }, thinking: { supported: true, types: { enabled: { supported: true }, adaptive: { supported: false } } }, effort: { supported: false } }, allowed_fallback_models: [] },
        { type: 'model', id: 'claude-text-only', display_name: 'Text Only', max_tokens: 1000, capabilities: { image_input: { supported: false } } },
      ], has_more: false, first_id: 'claude-fable-5-2', last_id: 'claude-text-only' });
    }
    if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models')) {
      return json({ models: [
        { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', supportedGenerationMethods: ['generateContent'], thinking: true },
        { name: 'models/gemini-4-carbon', displayName: 'Gemini 4 Carbon', supportedGenerationMethods: ['generateContent'], thinking: true },
        { name: 'models/gemini-3.1-flash-image', displayName: 'Nano Banana 2', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-embedding-2', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
      ] });
    }
    if (url === 'https://api.anthropic.com/v1/messages') {
      if (mode === 'http401') return json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' }, request_id: 'req_1' }, 401);
      return new Response(sse(claudeStream(body.model, mode), 53, mode === 'slow' ? 60 : 4, init.signal), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url === 'https://generativelanguage.googleapis.com/v1beta/interactions') {
      return new Response(sse(geminiStream(body.model), 41, 4, init.signal), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    throw new TypeError('unexpected fetch: ' + url);
  };
})();`;

// ---- CDP の最小クライアント ----
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id) { const p = this.pending.get(msg.id); if (p) { this.pending.delete(msg.id); if (msg.error) p.reject(new Error(msg.error.message + ' ' + (msg.error.data || ''))); else p.resolve(msg.result); } }
      else this.listeners.forEach((l) => l(msg));
    });
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--window-size=1400,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let exitCode = 1;
try {
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); } catch (e) { await sleep(250); } }
  if (!ver) throw new Error('Chrome に接続できません');
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
  await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

  async function ev(expression) {
    const r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('evaluate failed: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text) + '\n  in: ' + expression.slice(0, 200));
    return r.result.value;
  }
  async function waitFor(expression, label, timeout = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (await ev(expression)) return true; await sleep(60); }
    check('wait: ' + label, false, 'timeout; state=' + JSON.stringify(await ev(`({status: document.getElementById('curStatus').textContent, flash: document.getElementById('flash').textContent})`)));
    return false;
  }
  async function shot(name) {
    const r = await S('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(r.data, 'base64'));
  }
  const click = (id) => ev(`document.getElementById(${JSON.stringify(id)}).click()`);
  const setInput = (id, value, events = ['input']) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(value)}; ${JSON.stringify(events)}.forEach((n) => e.dispatchEvent(new Event(n, { bubbles: true }))); })()`);
  const text = (id) => ev(`document.getElementById(${JSON.stringify(id)}).textContent`);
  async function navigate() {
    const loaded = new Promise((res) => { const l = (m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { cdp.listeners.splice(cdp.listeners.indexOf(l), 1); res(); } }; cdp.listeners.push(l); });
    await S('Page.navigate', { url: pageUrl });
    await loaded; await sleep(300);
  }
  async function drag(fx0, fy0, fx1, fy1, targetExpr = `document.getElementById('stage')`) {
    const r = await ev(`(() => { const b = ${targetExpr}.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
    const p = (fx, fy) => ({ x: r.x + r.w * fx, y: r.y + r.h * fy });
    const a = p(fx0, fy0), b = p(fx1, fy1);
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 8; i++) await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + (b.x - a.x) * i / 8, y: a.y + (b.y - a.y) * i / 8, button: 'left', buttons: 1 });
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(50);
    return r;
  }
  const stored = () => ev(`(async () => { await new Promise((r) => setTimeout(r, 350)); return JSON.parse(localStorage.getItem('kiritori-ai.v1') || 'null'); })()`);
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const lastReq = (prefix) => ev(`(() => { const r = window.__reqs.filter((q) => q.url.startsWith(${JSON.stringify(prefix)})); return r.length ? r[r.length - 1] : null; })()`);
  // 送った base64 画像を復号して、大きさと四隅の色を調べる
  const inspectImage = (b64, mime) => ev(`(async () => {
    const bin = atob(${JSON.stringify(b64)}); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u8], { type: ${JSON.stringify(mime)} }));
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0);
    const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    return { w: bmp.width, h: bmp.height, tl: px(8, 8), tr: px(bmp.width - 9, 8), bl: px(8, bmp.height - 9), br: px(bmp.width - 9, bmp.height - 9), magic: Array.from(u8.slice(0, 4)) };
  })()`);
  const isColor = (p, c) => p && near(p[0], c[0], 40) && near(p[1], c[1], 40) && near(p[2], c[2], 40);

  // ===== A. 起動直後 =====
  await navigate();
  check('A タイトル', (await ev('document.title')) === 'きりとりAI');
  const real = await ev('window.__real');
  check('A file:// でも画面共有 API が使える（セキュアコンテキスト）', real.gdm === 'function' && real.secure === true, real);
  check('A CaptureController がある', real.cc === 'function', real);
  check('A API キー未設定のお知らせ', await ev(`!document.getElementById('banner').hidden && document.getElementById('banner').textContent.includes('API キー')`));
  check('A 範囲の行は、出すものがないときは隠れる', await ev(`document.getElementById('regionRow').hidden`));
  check('A 送信ボタンは共有前は押せない', await ev(`document.getElementById('sendBtn').disabled`));
  check('A 内蔵モデル一覧 12 件・既定は Opus 5.5', await ev(`document.querySelectorAll('#modelSelect option').length === 12 && document.getElementById('modelSelect').value === 'claude-opus-5-5'`));
  check('A 使い方の案内が出ている', await ev(`!document.getElementById('guide').hidden`));
  check('A 履歴は空（IndexedDB が file:// で使える）', (await text('historyCount')).includes('まだありません'), await text('historyCount'));
  await shot('01-initial-light');

  // ===== B. 設定 =====
  await click('openSettings');
  check('B 設定が開く', await ev(`document.getElementById('settingsDialog').open`));
  await setInput('keyClaude', 'sk-ant-test-key', ['input', 'change']);
  await waitFor(`document.getElementById('modelsStatus').textContent.includes('Claude：3 件')`, 'Claude のモデル一覧取得');
  check('B お知らせが消える', await ev(`document.getElementById('banner').hidden`));
  const mreq = await lastReq('https://api.anthropic.com/v1/models');
  check('B モデル一覧リクエストのヘッダー', mreq && mreq.headers['x-api-key'] === 'sk-ant-test-key' && mreq.headers['anthropic-version'] === '2026-10-21' && mreq.headers['anthropic-dangerous-direct-browser-access'] === 'true' && mreq.headers['anthropic-beta'] === 'server-side-fallback-2026-07-01' && mreq.url.includes('limit=1000'), mreq);
  check('B 画像非対応モデルは一覧に出ない', await ev(`JSON.stringify(Array.from(document.querySelectorAll('#modelSelect optgroup')[0].querySelectorAll('option')).map((o) => o.value))`) === JSON.stringify(['claude-fable-5-2', 'claude-opus-5-5', 'claude-haiku-4-5-20251001']));
  check('B 思考の深さの選択肢（Opus 5.5）', await ev(`JSON.stringify(Array.from(document.querySelectorAll('#effortSelect option')).map((o) => o.value)) + '|' + document.getElementById('effortSelect').value`) === JSON.stringify(['', 'low', 'medium', 'high', 'xhigh', 'max']) + '|high');
  await setInput('systemPrompt', 'テスト用のシステムプロンプト\n二行目');
  await shot('02-settings-light');
  await click('closeSettings');
  check('B 設定が閉じる', !(await ev(`document.getElementById('settingsDialog').open`)));

  // ===== C. 共有 =====
  await click('shareBtn');
  await waitFor(`document.getElementById('video').videoWidth === 1600`, '映像が届く');
  check('C 共有中の表示', await ev(`!document.getElementById('stage').classList.contains('empty') && !document.getElementById('stopBtn').hidden && !document.getElementById('sendBtn').disabled && document.getElementById('shareBtn').textContent === '共有先を変える'`));
  check('C 範囲は全体', (await text('regionInfo')) === '範囲：映像の全体（1600 × 900 px）', await text('regionInfo'));
  const gdm = await ev(`({ keys: Object.keys(window.__gdmOpts), audio: window.__gdmOpts.audio, ctrl: !!window.__gdmOpts.controller, video: window.__gdmOpts.video })`);
  check('C 共有の指定（タブ優先・解像度の上限 3840×2160・15fps）', gdm.audio === false && gdm.ctrl && gdm.video && gdm.video.displaySurface === 'browser' && gdm.video.width.max === 3840 && gdm.video.height.max === 2160 && gdm.video.frameRate.max === 15, gdm);
  check('C プレビューは縦横比どおり', await ev(`(() => { const b = document.getElementById('stage').getBoundingClientRect(); return Math.abs(b.width / b.height - 1600 / 900) < 0.02 && b.width <= 402; })()`));

  // ===== D. ドラッグで範囲を決める =====
  await drag(0.25, 0.25, 0.75, 0.75);
  let st = await stored();
  check('D ドラッグで範囲が決まり、保存される', st && st.region && near(st.region.x, 0.25, 0.01) && near(st.region.y, 0.25, 0.01) && near(st.region.w, 0.5, 0.01) && near(st.region.h, 0.5, 0.01), st && st.region);
  check('D 範囲の表示', /^範囲 80\d × 4[45]\d px（映像は 1600 × 900）$/.test(await text('regionInfo')) || /^範囲 79\d × 4[45]\d px/.test(await text('regionInfo')), await text('regionInfo'));
  check('D 枠が出ている', await ev(`!document.getElementById('sel').hidden && Math.abs(parseFloat(document.getElementById('sel').style.left) - 25) < 1`));
  // クリックだけ（ドラッグなし）では範囲は変わらない
  await drag(0.1, 0.1, 0.1, 0.1);
  st = await stored();
  check('D クリックだけでは範囲は変わらない', st.region && near(st.region.x, 0.25, 0.01));
  // 枠の中をつかんで移動（右下へ 10%）
  await drag(0.5, 0.5, 0.6, 0.6);
  st = await stored();
  check('D 枠をつかんで移動できる', near(st.region.x, 0.35, 0.012) && near(st.region.y, 0.35, 0.012) && near(st.region.w, 0.5, 0.012), st.region);
  // 右下の角をつかんで縮める（85%,85% → 75%,75%）
  await drag(0.5, 0.5, 0.5, 0.5, `document.querySelector('#sel .h.se')`);
  const seRect = await ev(`(() => { const s = document.getElementById('stage').getBoundingClientRect(), h = document.querySelector('#sel .h.se').getBoundingClientRect(); return { fx: (h.left + h.width / 2 - s.left) / s.width, fy: (h.top + h.height / 2 - s.top) / s.height }; })()`);
  await drag(seRect.fx, seRect.fy, 0.75, 0.75);
  st = await stored();
  check('D 角をつかんで大きさを変えられる', near(st.region.x, 0.35, 0.012) && near(st.region.w, 0.4, 0.015) && near(st.region.h, 0.4, 0.015), st.region);
  // 新しくドラッグし直して 25%〜75% に戻す
  await drag(0.02, 0.02, 0.03, 0.03); // 枠の外でわずかに動かす → クリック扱い
  await ev(`document.getElementById('fullBtn').click()`);
  check('D 「全体に戻す」', (await text('regionInfo')).startsWith('範囲：映像の全体'));
  await drag(0.25, 0.25, 0.75, 0.75);
  await shot('03-sharing-light');

  // ===== E. Claude に送る =====
  await setInput('userText', 'テスト指示');
  await click('sendBtn');
  await waitFor(`document.getElementById('curStatus').textContent.startsWith('完了')`, 'Claude の回答完了');
  const ans = await ev(`document.getElementById('curAnswer').innerHTML`);
  check('E 回答が Markdown で表示される', ans.includes('<p>答えは <strong>42</strong> です。</p>') && ans.includes('<td style="text-align:right">1,000</td>'), ans);
  check('E AI の出力に混ざった script/img は実行も挿入もされない', await ev(`window.__xss === undefined && !document.querySelector('#curAnswer script') && !document.querySelector('#curAnswer img')`) && ans.includes('&lt;script&gt;'));
  check('E 状態の表示', /^完了 ・ \d+\.\d 秒 ・ 入力 1,500・出力 321 トークン$/.test(await text('curStatus')), await text('curStatus'));
  check('E タイトルはモデル名のみ', (await text('curTitle')) === 'Claude Opus 5.5', await text('curTitle'));
  check('E 思考の要約が開ける', await ev(`(() => { const d = document.getElementById('curThinking'); if (d.hidden) return false; return document.getElementById('curThinkingBody').textContent.includes('画像を読み取っています'); })()`));
  const creq = await lastReq('https://api.anthropic.com/v1/messages');
  const cb = creq.body;
  check('E Claude リクエストのヘッダー', creq.method === 'POST' && creq.headers['x-api-key'] === 'sk-ant-test-key' && creq.headers['anthropic-version'] === '2026-10-21' && creq.headers['anthropic-dangerous-direct-browser-access'] === 'true' && creq.headers['anthropic-beta'] === 'server-side-fallback-2026-07-01' && creq.headers['content-type'] === 'application/json' && creq.opts.referrerPolicy === 'no-referrer' && creq.opts.credentials === 'omit', { h: creq.headers, o: creq.opts });
  check('E Claude リクエストの本文', cb.model === 'claude-opus-5-5' && cb.max_tokens === 64000 && cb.stream === true && cb.system === 'テスト用のシステムプロンプト\n二行目' && cb.thinking.type === 'adaptive' && cb.output_config.effort === 'high' && cb.fallbacks === 'default'
    && cb.messages.length === 1 && cb.messages[0].role === 'user' && cb.messages[0].content.length === 2 && cb.messages[0].content[0].type === 'image' && cb.messages[0].content[0].source.type === 'base64' && cb.messages[0].content[0].source.media_type === 'image/png' && cb.messages[0].content[1].text === 'テスト指示',
    Object.assign({}, cb, { messages: '(省略)' }));
  const img = await inspectImage(cb.messages[0].content[0].source.data, 'image/png');
  check('E 送った画像は PNG で、範囲どおりの大きさ', img.magic.join() === '137,80,78,71' && near(img.w, 800, 8) && near(img.h, 450, 8), img);
  check('E 送った画像の四隅が、映像の中央 50% と一致（赤・緑・青・黄）', isColor(img.tl, [255, 0, 0]) && isColor(img.tr, [0, 255, 0]) && isColor(img.bl, [0, 0, 255]) && isColor(img.br, [255, 255, 0]), img);
  check('E 履歴に 1 件', (await text('historyCount')) === '1 件' && await ev(`document.querySelectorAll('#historyList .hist').length === 1`), await text('historyCount'));
  check('E 送信後はボタンが元に戻る', await ev(`document.getElementById('sendBtn').textContent === '送信' && !document.getElementById('sendBtn').disabled`));
  await shot('04-answer-light');

  // ===== F. Gemini に送る =====
  await click('openSettings');
  await setInput('keyGemini', 'AIza-test-key', ['input', 'change']);
  await waitFor(`document.getElementById('modelsStatus').textContent.includes('Gemini：2 件')`, 'Gemini のモデル一覧取得');
  const greqm = await lastReq('https://generativelanguage.googleapis.com/v1beta/models');
  check('F Gemini モデル一覧リクエスト', greqm && greqm.headers['x-goog-api-key'] === 'AIza-test-key' && greqm.url.includes('pageSize=1000') && !greqm.url.includes('AIza'), greqm);
  check('F Gemini の一覧は対話用モデルだけ・新しい順', await ev(`JSON.stringify(Array.from(document.querySelectorAll('#modelSelect optgroup')[1].querySelectorAll('option')).map((o) => o.value))`) === JSON.stringify(['gemini-4-carbon', 'gemini-3.5-flash']));
  check('F キーを入れてもモデルは勝手に変わらない', await ev(`document.getElementById('modelSelect').value === 'claude-opus-5-5'`));
  await click('closeSettings');
  await ev(`(() => { const s = document.getElementById('modelSelect'); s.value = 'gemini-4-carbon'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await click('openSettings');
  check('F 思考の深さは Gemini 用に切り替わる', await ev(`JSON.stringify(Array.from(document.querySelectorAll('#effortSelect option')).map((o) => o.value)) + '|' + document.getElementById('effortSelect').value + '|' + document.getElementById('effortLabel').textContent`) === JSON.stringify(['', 'minimal', 'low', 'medium', 'high', 'xhigh']) + '||思考の深さ（Gemini のモデルを使うとき）');
  await setInput('effortSelect', 'low', ['change']);
  await click('closeSettings');
  // Ctrl+Enter で送る
  await S('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await waitFor(`document.getElementById('curTitle').textContent === 'Gemini 4 Carbon' && document.getElementById('curStatus').textContent.startsWith('完了')`, 'Gemini の回答完了（Ctrl+Enter）');
  const gans = await ev(`document.getElementById('curAnswer').innerHTML`);
  check('F Gemini の回答表示', gans.includes('<p>Gemini の回答です。</p>') && gans.includes('<ol><li>手順A</li><li>手順B</li></ol>'), gans);
  check('F Gemini の状態表示', /入力 1,211・出力 90 トークン（別に思考 245）$/.test(await text('curStatus')), await text('curStatus'));
  const greq = await lastReq('https://generativelanguage.googleapis.com/v1beta/interactions');
  const gb = greq.body;
  check('F Gemini リクエスト', greq.method === 'POST' && greq.headers['x-goog-api-key'] === 'AIza-test-key' && Object.keys(greq.headers).length === 2 && gb.model === 'gemini-4-carbon' && gb.stream === true && gb.store === false && gb.system_instruction === 'テスト用のシステムプロンプト\n二行目'
    && gb.generation_config.thinking_summaries === 'auto' && gb.generation_config.thinking_level === 'low' && gb.input.length === 2 && gb.input[0].type === 'text' && gb.input[0].text === 'テスト指示' && gb.input[1].type === 'image' && gb.input[1].mime_type === 'image/png' && gb.input[1].data.length > 100,
    Object.assign({}, gb, { input: '(省略)' }));
  check('F 履歴に 2 件・新しい順', (await text('historyCount')) === '2 件' && await ev(`document.querySelector('#historyList .hist .snippet').textContent === 'Gemini の回答です。'`));

  // ===== G. エラー =====
  await ev(`window.__mock.mode = 'http401'`);
  await ev(`(() => { const s = document.getElementById('modelSelect'); s.value = 'claude-fable-5-2'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await setInput('userText', '');
  await click('sendBtn');
  await waitFor(`document.getElementById('curStatus').textContent.startsWith('エラー')`, 'エラー表示');
  check('G エラーの説明が出る', await ev(`(() => { const n = document.querySelector('#curNotes .note.error'); return !!n && n.textContent.includes('Claude の API キーが正しくない') && n.textContent.includes('invalid x-api-key'); })()`), await text('curNotes'));
  check('G エラーは履歴に残さない・ボタンは戻る', (await text('historyCount')) === '2 件' && await ev(`document.getElementById('sendBtn').textContent === '送信' && !document.getElementById('sendBtn').disabled`));
  const freq = await lastReq('https://api.anthropic.com/v1/messages');
  check('G 追加の指示が空なら画像だけ送る（Fable）', freq.body.model === 'claude-fable-5-2' && freq.body.messages[0].content.length === 1 && freq.body.fallbacks === 'default' && freq.body.output_config.effort === 'high');

  // ===== H. 中止 =====
  await ev(`window.__mock.mode = 'slow'`);
  await click('sendBtn');
  await waitFor(`document.getElementById('curAnswer').textContent.includes('続き3')`, '回答の途中まで届く');
  check('H 送信中は「中止する」になる', await ev(`document.getElementById('sendBtn').textContent === '中止する' && !document.getElementById('sendBtn').disabled`));
  await click('sendBtn');
  await waitFor(`document.getElementById('curStatus').textContent.startsWith('中止')`, '中止');
  check('H 中止の表示・途中までの回答は残る・履歴には残さない', (await text('curNotes')).includes('中止しました') && (await text('curAnswer')).includes('42') && (await text('historyCount')) === '2 件');

  // ===== I. 別モデルへの引き継ぎ・古いモデル =====
  await ev(`window.__mock.mode = 'fallback'`);
  await click('sendBtn');
  await waitFor(`document.getElementById('curStatus').textContent.startsWith('完了')`, '引き継ぎ応答の完了');
  check('I 引き継ぎの表示', (await text('curAnswer')) === '前半後半' && (await text('curNotes')).includes('claude-opus-4-8 が代わりに答えました') && (await text('curTitle')) === 'Claude Fable 5.2（実際に答えたモデル：claude-opus-4-8）', { t: await text('curTitle'), n: await text('curNotes') });
  await ev(`window.__mock.mode = 'ok'`);
  await ev(`(() => { const s = document.getElementById('modelSelect'); s.value = 'claude-haiku-4-5-20251001'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await click('sendBtn');
  await waitFor(`document.getElementById('curTitle').textContent === 'Claude Haiku 4.5' && document.getElementById('curStatus').textContent.startsWith('完了')`, '古いモデルの完了');
  const hreq = await lastReq('https://api.anthropic.com/v1/messages');
  check('I 対応していない指定は送らない（Haiku 4.5）', hreq.body.model === 'claude-haiku-4-5-20251001' && !('thinking' in hreq.body) && !('output_config' in hreq.body) && !('fallbacks' in hreq.body) && !('anthropic-beta' in hreq.headers) && hreq.body.max_tokens === 64000, hreq.body && Object.keys(hreq.body));
  check('I 履歴は 4 件', (await text('historyCount')) === '4 件', await text('historyCount'));

  // ===== J. ためる（何枚か取っておいて、まとめて送る） =====
  const queued = () => ev(`document.querySelectorAll('#queueList .queue-item').length`);
  const holdOnce = async (n) => { await click('holdBtn'); await waitFor(`document.querySelectorAll('#queueList .queue-item').length === ${n}`, n + ' 枚目をためる'); };
  check('J 範囲を名前で保存する機能はない', await ev(`!document.getElementById('presetSelect') && !document.getElementById('presetSaveBtn')`));
  check('J ためる前は「送信」で、ためた画像の枠は出ない', await ev(`document.getElementById('sendBtn').textContent === '送信' && document.getElementById('queueBox').hidden && !document.getElementById('holdBtn').disabled`));
  await holdOnce(1);
  check('J 1 枚ためても表示は「送信」のまま', (await text('sendBtn')) === '送信' && (await text('queueInfo')).includes('ためた画像 1 枚'), [await text('sendBtn'), await text('queueInfo')]);
  await click('fullBtn');
  await drag(0.05, 0.05, 0.45, 0.45); // 左上（赤）だけの範囲に変えて、2 枚目をためる
  await holdOnce(2);
  check('J 2 枚たまると「送信（2枚）」', (await text('sendBtn')) === '送信（2枚）' && (await text('queueInfo')).includes('この 2 枚だけを送ります'), [await text('sendBtn'), await text('queueInfo')]);
  await shot('04b-queue-light');
  await click('sendBtn');
  await waitFor(`document.getElementById('curStatus').textContent.startsWith('完了') && document.getElementById('sendBtn').textContent === '送信'`, 'まとめて送信');
  const qreq = await lastReq('https://api.anthropic.com/v1/messages');
  const qc = qreq.body.messages[0].content;
  check('J 2 枚を順番どおりに、1 つの質問として送る', qc.length === 3 && qc[0].type === 'image' && qc[1].type === 'image' && qc[2].type === 'text' && qc[2].text === '画像は 2 枚あります。1 枚目から順に続く、ひと続きの内容として読んでください。', qc.map((c) => c.type + (c.text ? ':' + c.text : '')));
  const q1 = await inspectImage(qc[0].source.data, 'image/png'), q2 = await inspectImage(qc[1].source.data, 'image/png');
  check('J 1 枚目は中央（4 色）、2 枚目は左上（赤だけ）', isColor(q1.tl, [255, 0, 0]) && isColor(q1.br, [255, 255, 0]) && isColor(q2.tl, [255, 0, 0]) && isColor(q2.br, [255, 0, 0]) && near(q2.w, 640, 10), { q1, q2 });
  check('J 送れたら、ためた分は空になる', (await queued()) === 0 && await ev(`document.getElementById('queueBox').hidden`));
  check('J 送った 2 枚が回答の横に並び、履歴にも 2 枚と出る', await ev(`document.querySelectorAll('#curThumbs img').length === 2 && document.querySelector('#historyList .hist .badge').textContent === '2枚'`) && (await text('historyCount')) === '5 件', await text('historyCount'));
  await ev(`document.querySelectorAll('#curThumbs img')[1].click()`);
  check('J 回答の横の画像を押すと拡大できる', await ev(`document.getElementById('imageDialog').open && document.getElementById('bigImage').src.startsWith('blob:')`));
  await click('closeImage');
  // 1 枚ずつ消す・全部消す
  await holdOnce(1); await holdOnce(2);
  await ev(`document.querySelector('#queueList .queue-item .x').click()`);
  check('J × で 1 枚だけ消せる', (await queued()) === 1 && (await text('sendBtn')) === '送信');
  await click('queueClear');
  check('J 「全部消す」で空になる', (await queued()) === 0 && await ev(`document.getElementById('queueBox').hidden`) && (await text('sendBtn')) === '送信');
  // 送信に失敗したときは、ためた分を残して送り直せる
  await holdOnce(1); await holdOnce(2);
  await ev(`window.__mock.mode = 'http401'`);
  await click('sendBtn');
  await waitFor(`document.getElementById('curStatus').textContent.startsWith('エラー') && document.getElementById('sendBtn').textContent === '送信（2枚）'`, '送信の失敗');
  check('J 失敗したら、ためた 2 枚は残る', (await queued()) === 2 && (await text('historyCount')) === '5 件');
  await ev(`window.__mock.mode = 'ok'`);
  await click('sendBtn');
  await waitFor(`document.getElementById('curStatus').textContent.startsWith('完了') && document.getElementById('sendBtn').textContent === '送信'`, '送り直し');
  check('J そのまま送り直せる', (await queued()) === 0 && (await text('historyCount')) === '6 件', await text('historyCount'));
  await click('fullBtn');
  await drag(0.25, 0.25, 0.75, 0.75); // 範囲を元（中央）に戻す
  check('J 範囲を中央に戻した', /^範囲 (79|80)\d × 4[45]\d px/.test(await text('regionInfo')), await text('regionInfo'));

  // ===== K. 表示（暗いテーマ・狭い画面・大きく表示） =====
  await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await shot('05-answer-dark');
  await click('zoomBtn');
  check('K 大きく表示', await ev(`document.body.classList.contains('wide') && document.getElementById('stage').getBoundingClientRect().width > 700 && document.getElementById('zoomBtn').textContent === '小さく戻す'`));
  await shot('06-wide-dark');
  await click('zoomBtn');
  await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await S('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(150);
  check('K 狭い画面で横にはみ出さない', await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), await ev(`[document.documentElement.scrollWidth, document.documentElement.clientWidth]`));
  await shot('07-narrow-light');
  await S('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });

  // ===== L. 共有の停止 =====
  await ev(`window.__fakeStream.getVideoTracks()[0].dispatchEvent(new Event('ended'))`);
  check('L ブラウザ側で共有が止められたら元に戻して知らせる', await ev(`document.getElementById('stage').classList.contains('empty') && document.getElementById('sendBtn').disabled && document.getElementById('flash').textContent === '共有が終わりました。'`), await text('flash'));
  await click('shareBtn');
  await waitFor(`document.getElementById('video').videoWidth === 1600`, '共有し直す');
  check('L 覚えていた範囲がそのまま使われる', /^範囲 (79|80)\d × 4[45]\d px/.test(await text('regionInfo')) && (await text('flash')).startsWith('前に決めた範囲を使います'), [await text('regionInfo'), await text('flash')]);
  await click('stopBtn');
  check('L 共有を止めると元に戻る', await ev(`document.getElementById('stage').classList.contains('empty') && document.getElementById('sendBtn').disabled && document.getElementById('shareBtn').textContent === '共有するタブを選ぶ' && window.__fakeStream.getTracks().every((t) => t.readyState === 'ended')`));
  check('L 範囲は覚えている', (await text('regionInfo')).includes('覚えています'), await text('regionInfo'));

  // ===== M. 開き直しても残る =====
  await sleep(400);
  await ev(`(() => { const o = JSON.parse(localStorage.getItem('kiritori-ai.v1')); o.modelsAt.claude = Date.now() - 25 * 3600 * 1000; localStorage.setItem('kiritori-ai.v1', JSON.stringify(o)); })()`);
  await navigate();
  await waitFor(`window.__reqs.some((q) => q.url.startsWith('https://api.anthropic.com/v1/models'))`, '古い一覧の自動更新');
  check('M 一覧が古いほうだけ裏で取り直す', await ev(`window.__reqs.filter((q) => q.url.includes('/models')).length === 1`), await ev(`window.__reqs.map((q) => q.url)`));
  st = await stored();
  check('M 設定が残る', st.keys.claude === 'sk-ant-test-key' && st.keys.gemini === 'AIza-test-key' && st.model === 'claude-haiku-4-5-20251001' && st.systemPrompt === 'テスト用のシステムプロンプト\n二行目' && st.effort.gemini === 'low' && !('presets' in st) && st.region && near(st.region.x, 0.25, 0.01), st && { model: st.model, effort: st.effort, region: st.region });
  check('M モデル一覧と選択が残る', await ev(`document.getElementById('modelSelect').value === 'claude-haiku-4-5-20251001' && document.querySelectorAll('#modelSelect option').length === 5`));
  await waitFor(`document.querySelectorAll('#historyList .hist').length === 6`, '履歴の読み込み');
  check('M 履歴が残る・案内は出ない・お知らせも出ない', (await text('historyCount')) === '6 件' && await ev(`document.getElementById('guide').hidden && document.getElementById('banner').hidden`));
  // いちばん古い 1 件（最初の Claude の回答・画像 1 枚）
  await ev(`document.querySelectorAll('#historyList .hist')[5].open = true`);
  await waitFor(`!!document.querySelectorAll('#historyList .hist')[5].querySelector('.body')`, '履歴を開く');
  const hb = await ev(`(() => { const b = document.querySelectorAll('#historyList .hist')[5].querySelector('.body'); return { answer: b.querySelector('.md').innerHTML, text: b.textContent, thumbs: b.querySelectorAll('.thumbs img').length }; })()`);
  check('M 履歴の中身（最初の Claude の回答）', hb.answer.includes('<strong>42</strong>') && !/<script|<img/i.test(hb.answer) && hb.text.includes('Claude Opus 5.5') && hb.text.includes('追加の指示：テスト指示') && hb.text.includes('思考の深さ：high') && hb.text.includes('テスト用のシステムプロンプト') && hb.thumbs === 1, hb);
  await ev(`document.querySelectorAll('#historyList .hist')[5].querySelector('.body .thumbs img').click()`);
  await waitFor(`document.getElementById('imageDialog').open && document.getElementById('bigImage').naturalWidth > 700`, '履歴の画像を開く');
  check('M 保存された画像を開ける', await ev(`document.getElementById('bigImage').src.startsWith('blob:')`));
  await shot('08-history-image');
  await click('closeImage');
  // 2 枚まとめて送った 1 件（上から 2 番目）は、2 枚とも保存されていて、2 枚目（赤だけ）も開ける
  await ev(`document.querySelectorAll('#historyList .hist')[1].open = true`);
  await waitFor(`document.querySelectorAll('#historyList .hist')[1].querySelectorAll('.body .thumbs img').length === 2`, '2 枚の履歴を開く');
  check('M 2 枚の履歴に「画像 2 枚」と出る', await ev(`document.querySelectorAll('#historyList .hist')[1].querySelector('.body .small-meta').textContent.includes('画像 2 枚')`));
  await ev(`document.querySelectorAll('#historyList .hist')[1].querySelectorAll('.body .thumbs img')[1].click()`);
  await waitFor(`document.getElementById('imageDialog').open && document.getElementById('bigImage').naturalWidth > 500`, '履歴の 2 枚目を開く');
  check('M 履歴の 2 枚目は左上（赤だけ）の画像', await ev(`(() => { const im = document.getElementById('bigImage'); const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0); const a = g.getImageData(8, 8, 1, 1).data, b = g.getImageData(c.width - 9, c.height - 9, 1, 1).data; return a[0] > 200 && a[1] < 60 && b[0] > 200 && b[1] < 60 && Math.abs(c.width - 640) < 12; })()`));
  await click('closeImage');
  // 1 件消す（2 回押し）
  const delBtn = `Array.from(document.querySelectorAll('#historyList .hist')[5].querySelectorAll('button')).find((b) => b.classList.contains('danger'))`;
  await ev(`${delBtn}.click()`);
  check('M 1 回目は確認になる', (await ev(`${delBtn}.textContent`)) === 'もう一度押すと消えます' && (await text('historyCount')) === '6 件');
  await ev(`${delBtn}.click()`);
  await waitFor(`document.querySelectorAll('#historyList .hist').length === 5`, '履歴を 1 件消す');
  check('M 1 件消える', (await text('historyCount')) === '5 件');
  await click('clearHistoryBtn'); await click('clearHistoryBtn');
  await waitFor(`document.querySelectorAll('#historyList .hist').length === 0`, '履歴をすべて消す');
  check('M すべて消える・案内が戻る', (await text('historyCount')).includes('まだありません') && await ev(`document.getElementById('clearHistoryBtn').hidden && !document.getElementById('guide').hidden`));
  check('M 画像の保存領域も空になる', await ev(`new Promise((res) => { const rq = indexedDB.open('kiritori-ai'); rq.onsuccess = () => { const c = rq.result.transaction('images').objectStore('images').count(); c.onsuccess = () => res(c.result === 0); }; })`));

  // ===== N. 履歴を残さない設定・キーの消去 =====
  await click('openSettings');
  await ev(`(() => { const c = document.getElementById('keepHistory'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await setInput('keyGemini', '');
  check('N キーを消すと、そのキーで取った一覧は捨てる', await ev(`document.querySelectorAll('#modelSelect optgroup')[1].label === 'Gemini（キー未設定）' && document.querySelectorAll('#modelSelect optgroup')[1].querySelectorAll('option').length === 6`));
  await click('closeSettings');
  await click('shareBtn');
  await waitFor(`document.getElementById('video').videoWidth === 1600`, '再共有');
  await click('sendBtn');
  await waitFor(`document.getElementById('curStatus').textContent.startsWith('完了')`, '履歴なしで送信');
  check('N 履歴を残さない設定では保存しない', (await text('historyCount')).includes('残さない設定') && await ev(`document.querySelectorAll('#historyList .hist').length === 0`), await text('historyCount'));
  // キーがないモデルで送ろうとすると設定が開く
  await ev(`(() => { const s = document.getElementById('modelSelect'); s.value = 'gemini-4-carbon'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await click('sendBtn');
  check('N キーがなければ設定を開いて知らせる', await ev(`document.getElementById('settingsDialog').open && document.getElementById('settingsMsg').textContent === 'Gemini の API キーを入れてください。' && document.activeElement === document.getElementById('keyGemini')`));

  check('ページ内のエラーや警告なし', problems.length === 0, problems);
  exitCode = failed ? 1 : 0;
  ws.close();
} catch (err) {
  results.push('ERROR ' + (err && err.stack || err));
} finally {
  chrome.kill();
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* プロファイルの後片付けは失敗しても構わない */ }
}
console.log(results.join('\n'));
console.log(exitCode === 0 ? `\ne2e: all ${results.length} checks passed` : `\ne2e: ${failed} FAILED`);
process.exit(exitCode);
