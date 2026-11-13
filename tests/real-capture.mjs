// 本物の getDisplayMedia（タブの共有）を通す確認。共有先の選択だけ Chrome の起動オプションで自動化し、
// AI の API は差し替える。
// 実行: node tests/real-capture.mjs（引数は省略可: <index.html のパス、または公開先の URL> <出力フォルダ>。--headed を付けるとブラウザの窓を出して動かす）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pageUrl, outDir, chromePath } from './env.mjs';

const headed = process.argv.includes('--headed');
const targetPath = path.join(outDir, 'target.html');
fs.writeFileSync(targetPath, `<!doctype html><meta charset="utf-8"><title>KiritoriTarget</title>
<style>html,body{margin:0;height:100%}body{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}
div:nth-child(1){background:#f00}div:nth-child(2){background:#0f0}div:nth-child(3){background:#00f}div:nth-child(4){background:#ff0}
p{position:fixed;left:40%;top:45%;font:24px sans-serif;margin:0}</style>
<div></div><div></div><div></div><div></div><p id="t">0</p>
<script>setInterval(function(){document.getElementById('t').textContent=Date.now()%100000},200)</scr` + `ipt>`);
const CHROME = chromePath();
const PORT = 9800 + Math.floor(Math.random() * 150);
const profile = path.join(outDir, 'profile-real-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STUB = `(() => {
  try { if (!localStorage.getItem('kiritori-ai.v1')) localStorage.setItem('kiritori-ai.v1', JSON.stringify({ keys: { claude: 'sk-ant-test' } })); } catch (e) {}
  window.__reqs = [];
  window.fetch = async (input, init) => {
    init = init || {}; let body = null; try { body = JSON.parse(init.body); } catch (e) {}
    window.__reqs.push({ url: String(input), body });
    const ev = (n, o) => 'event: ' + n + '\\ndata: ' + JSON.stringify(o) + '\\n\\n';
    const s = ev('message_start', { type: 'message_start', message: { model: body.model, usage: { input_tokens: 1 } } }) + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }) + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) + ev('message_stop', { type: 'message_stop' });
    return new Response(s, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
})();`;
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }); }
  send(method, params, sessionId) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId })); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
}
const args = ['--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1300,850',
  '--auto-select-tab-capture-source-by-title=KiritoriTarget', '--auto-select-desktop-capture-source=KiritoriTarget', 'about:blank'];
if (!headed) args.unshift('--headless=new');
const chrome = spawn(CHROME, args, { stdio: 'ignore' });
let code = 1;
try {
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); } catch (e) { await sleep(250); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  const open = async (url, stub) => {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId); await cdp.send('Runtime.enable', {}, sessionId);
    if (stub) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: stub }, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    await sleep(800);
    return { targetId, sessionId };
  };
  const target = await open(pathToFileURL(targetPath).href);
  const app = await open(pageUrl, STUB);
  await cdp.send('Target.activateTarget', { targetId: app.targetId });
  const ev = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, app.sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text);
    return r.result.value;
  };
  console.log('browser:', ver.Browser, headed ? '(headed)' : '(headless)');
  await ev(`document.getElementById('shareBtn').click()`);
  let dims = null;
  for (let i = 0; i < 80; i++) { dims = await ev(`({ w: document.getElementById('video').videoWidth, h: document.getElementById('video').videoHeight, flash: document.getElementById('flash').textContent, empty: document.getElementById('stage').classList.contains('empty') })`); if (dims.w > 0) break; await sleep(150); }
  console.log('after share:', JSON.stringify(dims));
  if (!dims.w) throw new Error('本物の共有を始められませんでした（この実行環境では自動選択が効かない可能性）');
  const info = await ev(`(() => { const t = document.getElementById('video').srcObject.getVideoTracks()[0]; const s = t.getSettings(); return { label: t.label, displaySurface: s.displaySurface, width: s.width, height: s.height, frameRate: s.frameRate, focused: document.hasFocus(), visibility: document.visibilityState, region: document.getElementById('regionInfo').textContent }; })()`);
  console.log('track:', JSON.stringify(info));
  await sleep(700);
  // 右下 1/4 だけを範囲にして送る → 画像全体が黄色のはず
  const r = await ev(`(() => { const b = document.getElementById('stage').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  const pt = (fx, fy) => ({ x: r.x + r.w * fx, y: r.y + r.h * fy });
  const a = pt(0.55, 0.6), b = pt(0.97, 0.95);
  const M = (type, p, extra) => cdp.send('Input.dispatchMouseEvent', Object.assign({ type, x: p.x, y: p.y }, extra || {}), app.sessionId);
  await M('mouseMoved', a); await M('mousePressed', a, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 6; i++) await M('mouseMoved', { x: a.x + (b.x - a.x) * i / 6, y: a.y + (b.y - a.y) * i / 6 }, { button: 'left', buttons: 1 });
  await M('mouseReleased', b, { button: 'left', clickCount: 1 });
  await sleep(100);
  console.log('region:', await ev(`document.getElementById('regionInfo').textContent`));
  await ev(`document.getElementById('sendBtn').click()`);
  for (let i = 0; i < 60; i++) { if (await ev(`document.getElementById('curStatus').textContent.startsWith('完了')`)) break; await sleep(100); }
  console.log('status:', await ev(`document.getElementById('curStatus').textContent`), '| answer:', await ev(`document.getElementById('curAnswer').textContent`));
  const img = await ev(`(async () => {
    const src = window.__reqs[window.__reqs.length - 1].body.messages[0].content[0].source;
    const bin = atob(src.data); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u8], { type: src.media_type }));
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0);
    const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    return { type: src.media_type, bytes: u8.length, w: bmp.width, h: bmp.height, tl: px(4, 4), tr: px(bmp.width - 5, 4), bl: px(4, bmp.height - 5), br: px(bmp.width - 5, bmp.height - 5), mid: px(bmp.width >> 1, bmp.height >> 1) };
  })()`);
  console.log('sent image:', JSON.stringify(img));
  const yellow = (p) => p[0] > 200 && p[1] > 200 && p[2] < 60;
  const ok = [img.tl, img.tr, img.bl, img.br, img.mid].every(yellow);
  console.log(ok ? 'REAL CAPTURE: OK（本物のタブ共有から、決めた範囲だけが切り抜かれて送られた）' : 'REAL CAPTURE: 色が想定と違う');
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, app.sessionId);
  fs.writeFileSync(path.join(outDir, 'real-capture.png'), Buffer.from(shot.data, 'base64'));
  code = ok ? 0 : 1;
  ws.close();
} catch (err) {
  console.log('ERROR', err && err.message || err);
} finally {
  chrome.kill(); await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 後片付けの失敗は無視 */ }
}
process.exit(code);
