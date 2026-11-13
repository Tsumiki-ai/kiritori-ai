// きりとりAI の core（画面に触らないロジック）の単体テスト。
// index.html の 1 つ目の <script> をそのまま取り出して実行するので、アプリ側にテスト用の仕掛けは要らない。
// 実行: node tests/core.test.mjs（引数は省略可: <index.html のパス、または公開先の URL>）
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { loadHtml } from './env.mjs';

const html = await loadHtml();
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.equal(scripts.length, 2, 'script ブロックは 2 つ');
for (const [i, src] of scripts.entries()) new vm.Script(src, { filename: `inline-${i}.js` }); // 構文チェック

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(scripts[0], sandbox);
const C = sandbox.window.KiritoriCore;
assert.ok(C, 'KiritoriCore が公開されている');

let n = 0;
function t(name, fn) { try { fn(); n++; } catch (e) { console.error('FAIL: ' + name + '\n  ' + (e && e.message)); process.exitCode = 1; } }
const md = C.renderMarkdown;

// ---------- Markdown: 安全性 ----------
t('script タグは文字として出る', () => {
  const h = md('<script>alert(1)</script>');
  assert.ok(!/<script/i.test(h)); assert.ok(h.includes('&lt;script&gt;'));
});
t('img onerror は文字として出る', () => {
  const h = md('<img src=x onerror=alert(1)>');
  assert.ok(!/<img/i.test(h));
});
t('javascript: リンクはリンクにならない', () => {
  const h = md('[x](javascript:alert(1))');
  assert.ok(!/<a /.test(h));
});
t('リンクの URL に引用符を混ぜても属性から抜け出せない', () => {
  const h = md('[x](https://a.example/"onmouseover="alert(1))');
  assert.ok(!/onmouseover="/.test(h), h);
  const h2 = md('[x](https://a.example/?q=1&r=2)');
  assert.ok(h2.includes('<a href="https://a.example/?q=1&amp;r=2" target="_blank" rel="noopener noreferrer">x</a>'), h2);
});
t('コードブロック内の HTML はエスケープ', () => {
  const h = md('```html\n<b onclick="x">hi</b>\n```');
  assert.equal(h, '<pre><code>&lt;b onclick=&quot;x&quot;&gt;hi&lt;/b&gt;</code></pre>');
});
t('表のセルや見出しの HTML もエスケープ', () => {
  const h = md('# <i>x</i>\n\n| a |\n|---|\n| <svg onload=1> |');
  assert.ok(!/<i>|<svg/i.test(h), h);
});
t('生成されるタグは許可した種類だけ', () => {
  const nasty = '# h\n**b** *i* ~~s~~ `c` [l](https://x.y) <u>u</u> <a href=1>z</a>\n- a\n  1. b\n\n> q\n\n| a | b |\n|:-|-:|\n| 1 | 2<br>3 |\n\n```\nx\n```\n---\nH<sub>2</sub>O x<sup>2</sup>';
  const h = md(nasty);
  const tags = new Set([...h.matchAll(/<\/?([a-zA-Z0-9]+)/g)].map((m) => m[1].toLowerCase()));
  const allowed = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'sub', 'sup']);
  for (const tag of tags) assert.ok(allowed.has(tag), 'unexpected tag: ' + tag);
  const attrs = new Set([...h.matchAll(/\s([a-z-]+)="/g)].map((m) => m[1]));
  for (const a of attrs) assert.ok(['href', 'target', 'rel', 'class', 'style', 'start'].includes(a), 'unexpected attr: ' + a);
});

// ---------- Markdown: 表示 ----------
t('強調', () => {
  assert.equal(md('これは**重要**です'), '<p>これは<strong>重要</strong>です</p>');
  assert.equal(md('これは*強調*です'), '<p>これは<em>強調</em>です</p>');
  assert.equal(md('~~消す~~'), '<p><del>消す</del></p>');
  assert.equal(md('`a < b`'), '<p><code>a &lt; b</code></p>');
});
t('計算式の * は斜体にしない', () => {
  assert.equal(md('100*1.1*2 = 220'), '<p>100*1.1*2 = 220</p>');
  assert.equal(md('a * b * c'), '<p>a * b * c</p>');
});
t('バックスラッシュのエスケープ', () => {
  assert.equal(md('\\*そのまま\\*'), '<p>&#42;そのまま&#42;</p>');
});
t('改行は <br>', () => {
  assert.equal(md('一行目\n二行目\n\n次の段落'), '<p>一行目<br>二行目</p>\n<p>次の段落</p>');
});
t('見出しと罫線', () => {
  assert.equal(md('## 結論\n---\n本文'), '<h2>結論</h2>\n<hr>\n<p>本文</p>');
});
t('入れ子のリスト', () => {
  assert.equal(md('- a\n  - b\n    - c\n- d'), '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>');
  assert.equal(md('1. a\n   - b\n2. c'), '<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>');
});
t('番号付きリストの開始番号と種類の切り替え', () => {
  assert.equal(md('3. a\n4. b'), '<ol start="3"><li>a</li><li>b</li></ol>');
  assert.equal(md('- a\n1. b'), '<ul><li>a</li></ul><ol><li>b</li></ol>');
});
t('リストの続きの行と空行', () => {
  assert.equal(md('- a\n  続き\n\n- b'), '<ul><li>a<br>続き</li><li>b</li></ul>');
});
t('段落の途中の「2024. 」はリストにしない', () => {
  assert.equal(md('当期は\n2024. 年度です'), '<p>当期は<br>2024. 年度です</p>');
  assert.equal(md('**手順**\n1. 最初'), '<p><strong>手順</strong></p>\n<ol><li>最初</li></ol>');
});
t('表', () => {
  const h = md('| 借方 | 金額 |\n|:--|--:|\n| 現金 | 1,000 |\n| `a|b` | x\\|y |');
  assert.equal(h, '<div class="table-wrap"><table><thead><tr><th style="text-align:left">借方</th><th style="text-align:right">金額</th></tr></thead><tbody><tr><td style="text-align:left">現金</td><td style="text-align:right">1,000</td></tr><tr><td style="text-align:left"><code>a|b</code></td><td style="text-align:right">x|y</td></tr></tbody></table></div>');
});
t('表の前後の段落', () => {
  const h = md('前\n| a |\n|---|\n| 1 |\n\n後');
  assert.ok(h.startsWith('<p>前</p>\n<div class="table-wrap">') && h.endsWith('<p>後</p>'), h);
});
t('引用', () => {
  assert.equal(md('> 引用\n> 続き'), '<blockquote><p>引用<br>続き</p></blockquote>');
});
t('閉じていないコードブロック（ストリーミング途中）', () => {
  assert.equal(md('```\nabc'), '<pre><code>abc</code></pre>');
});
t('空や null', () => { assert.equal(md(''), ''); assert.equal(md(null), ''); });
t('大きな入力でも固まらない', () => {
  const big = ('**a** `b` *c* [d](https://e.f) | x\n').repeat(4000) + '`'.repeat(3000);
  const t0 = Date.now(); md(big);
  assert.ok(Date.now() - t0 < 3000, 'took ' + (Date.now() - t0) + 'ms');
});

// ---------- SSE ----------
function sseAll(text, sizes) {
  const got = [];
  const p = C.createSSEParser((ev) => got.push(ev));
  let i = 0, k = 0;
  while (i < text.length) { const len = sizes[k++ % sizes.length]; p.feed(text.slice(i, i + len)); i += len; }
  p.end();
  return got;
}
t('SSE: どこで分割されても同じ結果', () => {
  const text = 'event: a\r\ndata: {"x":1}\r\n\r\n: comment\r\nevent: b\ndata: line1\ndata: line2\n\ndata: [DONE]\n\nevent: tail\ndata: last';
  const want = [{ event: 'a', data: '{"x":1}' }, { event: 'b', data: 'line1\nline2' }, { event: 'message', data: '[DONE]' }, { event: 'tail', data: 'last' }];
  for (const sizes of [[1], [2], [3], [5, 1, 7], [1000]]) assert.deepEqual(JSON.parse(JSON.stringify(sseAll(text, sizes))), want, 'sizes=' + sizes);
});

// ---------- Claude ----------
function feed(acc, events) { for (const e of events) acc.onEvent({ event: e.type || e.event_type, data: JSON.stringify(e) }); }
t('Claude: 通常の応答', () => {
  const acc = C.createClaudeAccumulator();
  feed(acc, [
    { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 1200, cache_read_input_tokens: 30, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '検討中' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'xx' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'ping' },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '答えは' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' 42 です' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 345 } },
    { type: 'message_stop' },
  ]);
  const st = acc.state;
  assert.equal(st.text, '答えは 42 です'); assert.equal(st.thinking, '検討中');
  assert.equal(st.usage.input, 1230); assert.equal(st.usage.output, 345);
  assert.equal(st.stopReason, 'end_turn'); assert.equal(st.finished, true);
  assert.equal(C.servedBy('claude', st), 'claude-opus-5-5');
  assert.equal(C.finalNotes('claude', st).length, 0);
});
t('Claude: 途中で別モデルに引き継ぎ', () => {
  const acc = C.createClaudeAccumulator();
  feed(acc, [
    { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '前半' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } } },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '後半' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]);
  assert.equal(acc.state.text, '前半後半');
  assert.equal(C.servedBy('claude', acc.state), 'claude-opus-4-8');
  const notes = C.finalNotes('claude', acc.state);
  assert.equal(notes.length, 1); assert.equal(notes[0].kind, 'info');
});
t('Claude: 拒否・上限・切断・エラー', () => {
  let acc = C.createClaudeAccumulator();
  feed(acc, [{ type: 'message_start', message: { model: 'm' } }, { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } }, { type: 'message_stop' }]);
  let notes = C.finalNotes('claude', acc.state);
  assert.equal(notes.length, 1); assert.ok(notes[0].text.includes('cyber'));
  acc = C.createClaudeAccumulator();
  feed(acc, [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }]);
  assert.ok(C.finalNotes('claude', acc.state)[0].text.includes('上限'));
  acc = C.createClaudeAccumulator();
  feed(acc, [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }]);
  assert.ok(C.finalNotes('claude', acc.state)[0].text.includes('接続'));
  acc = C.createClaudeAccumulator();
  feed(acc, [{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]);
  assert.equal(acc.state.error.type, 'overloaded_error');
  assert.ok(C.streamErrorMessage(acc.state.error).includes('混み合'));
  acc.onEvent({ event: 'x', data: 'not json' }); // 壊れた行で落ちない
});
t('Claude: リクエストの形', () => {
  const full = C.BUILTIN_MODELS.claude.find((m) => m.id === 'claude-opus-5-5');
  const r = C.buildClaudeRequest({ model: full, apiKey: 'K', system: 'SYS', userText: 'Q', imageB64: 'AAAA', mime: 'image/png', effort: 'high' });
  assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual({ ...r.headers }, { 'x-api-key': 'K', 'anthropic-version': '2026-10-21', 'anthropic-dangerous-direct-browser-access': 'true', 'anthropic-beta': 'server-side-fallback-2026-07-01', 'content-type': 'application/json' });
  assert.deepEqual(JSON.parse(JSON.stringify(r.body)), {
    model: 'claude-opus-5-5', max_tokens: 64000, stream: true,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'Q' }] }],
    system: 'SYS', thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' }, fallbacks: 'default',
  });
  // 機能が分からないモデル: 余計な指定を付けない
  const bare = { id: 'claude-x', label: 'x', provider: 'claude', adaptive: false, efforts: [], fallback: false, maxOut: 32000 };
  const r2 = C.buildClaudeRequest({ model: bare, apiKey: 'K', system: '', userText: '', imageB64: 'AAAA', mime: 'image/jpeg', effort: 'xhigh' });
  assert.deepEqual(JSON.parse(JSON.stringify(r2.body)), { model: 'claude-x', max_tokens: 32000, stream: true, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }] }] });
  assert.ok(!('anthropic-beta' in r2.headers));
  for (const k of ['temperature', 'top_p', 'top_k']) assert.ok(!(k in r.body));
  const haiku = C.BUILTIN_MODELS.claude.find((m) => m.id === 'claude-haiku-5-5');
  assert.equal(haiku.fallback, false); assert.ok(!('fallbacks' in C.buildClaudeRequest({ model: haiku, apiKey: 'K', imageB64: 'A', mime: 'image/png' }).body));
});
t('Claude: モデル一覧の読み替え', () => {
  const m = C.claudeModelFromApi({ id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', max_tokens: 128000, allowed_fallback_models: [],
    capabilities: { image_input: { supported: true }, thinking: { supported: true, types: { enabled: { supported: false }, adaptive: { supported: true } } }, effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: false } } } });
  assert.deepEqual(JSON.parse(JSON.stringify(m)), { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'claude', vision: true, adaptive: true, efforts: ['low', 'medium', 'high', 'xhigh'], fallback: false, maxOut: 128000 });
  const f = C.claudeModelFromApi({ id: 'claude-fable-5-2', display_name: 'Claude Fable 5.2', max_tokens: 128000, allowed_fallback_models: ['claude-opus-5', 'claude-opus-4-8'], capabilities: {} });
  assert.equal(f.fallback, true); assert.equal(f.adaptive, false);
  const old = C.claudeModelFromApi({ id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' }); // capabilities なし
  assert.deepEqual([old.adaptive, old.efforts.length, old.fallback, old.maxOut], [false, 0, false, null]);
  const novision = C.claudeModelFromApi({ id: 'x', capabilities: { image_input: { supported: false } } });
  assert.equal(novision.vision, false);
  assert.equal(C.effectiveEffort(m, 'max'), ''); assert.equal(C.effectiveEffort(m, 'xhigh'), 'xhigh'); assert.equal(C.effectiveEffort(m, ''), '');
});

// ---------- Gemini ----------
t('Gemini: 公式ドキュメントの例どおりのストリーム', () => {
  const acc = C.createGeminiAccumulator();
  const raw = [
    'event: interaction.created\ndata: {"interaction":{"id":"v1_x","status":"in_progress","object":"interaction","model":"gemini-4-hydrogen"},"event_type":"interaction.created"}',
    'event: interaction.status_update\ndata: {"interaction_id":"v1_x","status":"in_progress","event_type":"interaction.status_update"}',
    'event: step.start\ndata: {"index":0,"step":{"type":"thought"},"event_type":"step.start"}',
    'event: step.delta\ndata: {"index":0,"delta":{"content":{"text":"**考え中**","type":"text"},"type":"thought_summary"},"event_type":"step.delta"}',
    'event: step.delta\ndata: {"index":0,"delta":{"signature":"sig","type":"thought_signature"},"event_type":"step.delta"}',
    'event: step.stop\ndata: {"index":0,"event_type":"step.stop"}',
    'event: step.start\ndata: {"index":1,"step":{"type":"model_output"},"event_type":"step.start"}',
    'event: step.delta\ndata: {"index":1,"delta":{"text":"1, 2, 3, ","type":"text"},"event_type":"step.delta"}',
    'event: step.delta\ndata: {"index":1,"delta":{"text":"4, 5","type":"text"},"event_type":"step.delta"}',
    'event: step.stop\ndata: {"index":1,"event_type":"step.stop"}',
    'event: interaction.completed\ndata: {"interaction":{"id":"v1_x","status":"completed","usage":{"total_tokens":346,"total_input_tokens":11,"total_output_tokens":90,"total_thought_tokens":245},"model":"gemini-4-hydrogen"},"event_type":"interaction.completed"}',
    'event: done\ndata: [DONE]',
  ].join('\n\n') + '\n\n';
  const p = C.createSSEParser((ev) => acc.onEvent(ev));
  for (let i = 0; i < raw.length; i += 17) p.feed(raw.slice(i, i + 17));
  p.end();
  const st = acc.state;
  assert.equal(st.text, '1, 2, 3, 4, 5'); assert.equal(st.thinking, '**考え中**');
  assert.deepEqual(JSON.parse(JSON.stringify(st.usage)), { input: 11, output: 90, thought: 245 });
  assert.equal(st.status, 'completed'); assert.equal(st.finished, true);
  assert.equal(C.servedBy('gemini', st), 'gemini-4-hydrogen');
  assert.equal(C.finalNotes('gemini', st).length, 0);
});
t('Gemini: 途中打ち切り・エラー・切断', () => {
  let acc = C.createGeminiAccumulator();
  feed(acc, [{ event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'x' } }, { event_type: 'interaction.completed', interaction: { status: 'incomplete' } }]);
  assert.ok(C.finalNotes('gemini', acc.state)[0].text.includes('途中'));
  acc = C.createGeminiAccumulator();
  feed(acc, [{ event_type: 'error', error: { message: 'Deadline expired before operation could complete.', code: 'gateway_timeout' } }]);
  assert.ok(C.streamErrorMessage(acc.state.error).includes('gateway_timeout'));
  acc = C.createGeminiAccumulator();
  feed(acc, [{ event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'x' } }]);
  assert.ok(C.finalNotes('gemini', acc.state)[0].text.includes('接続'));
  acc = C.createGeminiAccumulator(); // 関数呼び出しなど本文でないステップの text は無視
  feed(acc, [{ event_type: 'step.start', index: 0, step: { type: 'google_search_call' } }, { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'ignored' } }]);
  assert.equal(acc.state.text, '');
});
t('Gemini: リクエストの形', () => {
  const m = C.BUILTIN_MODELS.gemini[0];
  const r = C.buildGeminiRequest({ model: m, apiKey: 'G', system: 'SYS', userText: 'Q', imageB64: 'AAAA', mime: 'image/png', effort: 'high' });
  assert.equal(r.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.deepEqual({ ...r.headers }, { 'content-type': 'application/json', 'x-goog-api-key': 'G' });
  assert.deepEqual(JSON.parse(JSON.stringify(r.body)), {
    model: m.id, input: [{ type: 'text', text: 'Q' }, { type: 'image', data: 'AAAA', mime_type: 'image/png' }], stream: true, store: false,
    system_instruction: 'SYS', generation_config: { thinking_summaries: 'auto', thinking_level: 'high' },
  });
  const r2 = C.buildGeminiRequest({ model: { id: 'gemini-flash-latest', provider: 'gemini', thinking: false }, apiKey: 'G', system: '', userText: '', imageB64: 'AAAA', mime: 'image/jpeg', effort: 'high' });
  assert.deepEqual(JSON.parse(JSON.stringify(r2.body)), { model: 'gemini-flash-latest', input: [{ type: 'image', data: 'AAAA', mime_type: 'image/jpeg' }], stream: true, store: false });
  const r3 = C.buildGeminiRequest({ model: m, apiKey: 'G', imageB64: 'A', mime: 'image/png', effort: '' });
  assert.deepEqual(JSON.parse(JSON.stringify(r3.body.generation_config)), { thinking_summaries: 'auto' });
  assert.equal(C.effectiveEffort(m, 'max'), '');
});
t('Gemini: モデル一覧の絞り込みと並び', () => {
  const list = C.geminiModelsFromApi([
    { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'], thinking: true },
    { name: 'models/gemini-4-carbon', displayName: 'Gemini 4 Carbon', supportedGenerationMethods: ['generateContent'], thinking: true },
    { name: 'models/gemini-4-argon', displayName: 'Gemini 4 Argon', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash-image', displayName: 'Nano Banana 2', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-flash-latest', displayName: 'Gemini Flash Latest', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemma-4-31b-it', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-4-carbon', displayName: 'dup' },
    { name: 'models/gemini-9-x', supportedGenerationMethods: ['somethingElse'] },
    null,
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(list.map((m) => m.id))), ['gemini-4-argon', 'gemini-4-carbon', 'gemini-3.5-flash', 'gemini-flash-latest']);
  assert.deepEqual(JSON.parse(JSON.stringify(list.map((m) => m.thinking))), [true, true, true, false]);
  assert.equal(list[1].label, 'Gemini 4 Carbon');
});

// ---------- エラー文言 ----------
t('エラーの説明', () => {
  const a = C.friendlyHttpError('claude', 401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_1"}');
  assert.ok(a.includes('Claude の API キー') && a.includes('invalid x-api-key'), a);
  const g = C.friendlyHttpError('gemini', 400, '[{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"@type":"x","reason":"API_KEY_INVALID"}]}}]');
  assert.ok(g.includes('Gemini の API キー'), g);
  assert.ok(C.friendlyHttpError('claude', 429, '{}').includes('上限'));
  assert.ok(C.friendlyHttpError('claude', 529, '<html>').includes('混み合'));
  assert.ok(C.friendlyHttpError('gemini', 404, '{"error":{"message":"models/x is not found","status":"NOT_FOUND"}}').includes('一覧を更新'));
  assert.ok(C.friendlyHttpError('claude', 400, '{"type":"error","error":{"type":"invalid_request_error","message":"bad effort"}}').includes('bad effort'));
});

// ---------- 範囲 ----------
t('範囲の計算', () => {
  assert.equal(C.sanitizeRegion(null), null);
  assert.equal(C.sanitizeRegion({ x: 0, y: 0, w: 1, h: 1 }), null); // 全体は「範囲なし」
  assert.equal(C.sanitizeRegion({ x: 'a', y: 0, w: 1, h: 1 }), null);
  assert.deepEqual({ ...C.sanitizeRegion({ x: 0.9, y: 0.5, w: 0.5, h: 0.9 }) }, { x: 0.9, y: 0.5, w: 0.09999999999999998, h: 0.5 });
  assert.deepEqual({ ...C.regionToPixels(null, 1920, 1080) }, { sx: 0, sy: 0, sw: 1920, sh: 1080 });
  assert.deepEqual({ ...C.regionToPixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 1920, 1080) }, { sx: 480, sy: 540, sw: 960, sh: 270 });
  const px = C.regionToPixels({ x: 0.999, y: 0.999, w: 0.003, h: 0.003 }, 100, 100);
  assert.ok(px.sx + px.sw <= 100 && px.sy + px.sh <= 100 && px.sw >= 1 && px.sh >= 1);
  assert.deepEqual({ ...C.rectFromPoints({ x: 0.8, y: 0.2 }, { x: 0.3, y: 0.6 }) }, { x: 0.3, y: 0.2, w: 0.5, h: 0.39999999999999997 });
  assert.deepEqual({ ...C.moveRegion({ x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, 0.5, -1) }, { x: 0.6, y: 0, w: 0.4, h: 0.4 });
  const o = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  assert.deepEqual({ ...C.resizeRegion(o, 'se', { x: 0.9, y: 0.8 }, 0.01, 0.01) }, { x: 0.2, y: 0.2, w: 0.7, h: 0.6000000000000001 });
  const flipped = C.resizeRegion(o, 'w', { x: 0.9, y: 0 }, 0.01, 0.01); // 左辺を右辺より右へ → 反転
  assert.ok(Math.abs(flipped.x - 0.6) < 1e-9 && Math.abs(flipped.w - 0.3) < 1e-9 && flipped.y === 0.2 && Math.abs(flipped.h - 0.4) < 1e-9);
  const tiny = C.resizeRegion(o, 'e', { x: 0.2, y: 0 }, 0.05, 0.05);
  assert.ok(Math.abs(tiny.w - 0.05) < 1e-9);
});
t('同じモデルかどうか', () => {
  assert.equal(C.sameModel('claude-haiku-4-5', 'claude-haiku-4-5-20251001'), true);
  assert.equal(C.sameModel('claude-opus-5-5', 'claude-opus-5'), false);
  assert.equal(C.sameModel('claude-opus-5', 'claude-opus-5-5'), false);
  assert.equal(C.sameModel('claude-opus-5-5', 'claude-opus-4-8'), false);
  assert.equal(C.sameModel('gemini-3.5-flash', 'gemini-3.5-flash-001'), true);
  assert.equal(C.sameModel('gemini-flash-latest', 'gemini-3.8-flash'), false);
  assert.equal(C.sameModel('x', ''), true);
});

t('送る画像の縮小率', () => {
  const fits = (w, h) => { const sc = C.fitScale(w, h); const W = Math.max(1, Math.round(w * sc)), H = Math.max(1, Math.round(h * sc)); return { sc, W, H, p: C.imagePatches(W, H) }; };
  assert.equal(C.fitScale(1600, 900), 1);            // 小さい画像は拡大も縮小もしない
  assert.equal(C.fitScale(10, 10), 1);
  let r = fits(3840, 2160); assert.deepEqual([r.W, r.H, r.p], [2576, 1449, 4784]);   // 16:9 はちょうど上限
  r = fits(2600, 1500); assert.ok(r.W <= 2576 && r.p <= 4784 && r.p > 4500, JSON.stringify(r));
  r = fits(2576, 2576); assert.ok(r.W === r.H && r.p <= 4784 && r.p > 4500, JSON.stringify(r));
  r = fits(1000, 8000); assert.ok(r.H <= 2576 && r.p <= 4784, JSON.stringify(r));
  let x = 42; const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  for (let i = 0; i < 3000; i++) {
    const w = 1 + Math.floor(rnd() * 9000), h = 1 + Math.floor(rnd() * 6000); r = fits(w, h);
    assert.ok(r.sc > 0 && r.sc <= 1 && Math.max(r.W, r.H) <= 2576 && r.p <= 4784, w + 'x' + h + ' ' + JSON.stringify(r));
    if (r.sc < 1 && Math.max(r.W, r.H) < 2560) assert.ok(r.p > 4300, '縮めすぎ: ' + w + 'x' + h + ' ' + JSON.stringify(r)); // 上限近くまで使う
  }
});

console.log(process.exitCode ? 'SOME TESTS FAILED' : `core: ${n} tests passed`);
