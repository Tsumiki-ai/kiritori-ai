// きりとりAI のテストをすべて順に実行する。
//   node tests/run-all.mjs                                           手元の index.html を調べる
//   node tests/run-all.mjs https://tsumiki-ai.github.io/kiritori-ai/  公開されているページを調べる
// 必要なもの: Node.js 22 以降と、Chrome か Edge（画面には何も出ないヘッドレスで動かす）。
// AI の API は差し替えてあるので、API キーも料金も不要。
//
//   core.test.mjs    画面に触らないロジック（Markdown 変換・SSE・リクエストの形・範囲の計算）
//   e2e.mjs          画面操作の通し（共有 → 範囲 → 送信 → 表示 → 履歴 → 開き直し）
//   e2e-extra.mjs    失敗時の表示・履歴のページ送り・大きすぎる画像・こまかい操作
//   real-capture.mjs 本物のタブ共有（getDisplayMedia）を通した切り抜き
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
for (const file of ['core.test.mjs', 'e2e.mjs', 'e2e-extra.mjs', 'real-capture.mjs']) {
  const r = spawnSync(process.execPath, [path.join(here, file), ...process.argv.slice(2)], { encoding: 'utf8' });
  const lines = ((r.stdout || '') + (r.stderr || '')).trim().split('\n');
  console.log((r.status === 0 ? 'ok   ' : 'FAIL ') + file + ' — ' + lines[lines.length - 1]);
  if (r.status !== 0) {
    failed++;
    console.log(lines.filter((l) => !l.startsWith('ok ')).map((l) => '     ' + l).join('\n'));
  }
}
process.exit(failed ? 1 : 0);
