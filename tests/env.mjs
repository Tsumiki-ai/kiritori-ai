// テスト共通: 対象のページ・出力フォルダ・ブラウザの場所を決める。
// どのテストも引数は省略できる（省略時: ../index.html と OS の一時フォルダ）。
// 1 つ目の引数には、手元の index.html のパスのほか、公開先の URL（https://…）も渡せる。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const target = args[0] || path.join(here, '..', 'index.html');
const remote = /^https?:\/\//i.test(target);

// ブラウザで開くアドレス。手元のファイルなら file://…、公開先ならその URL。
export const pageUrl = remote ? target : pathToFileURL(path.resolve(target)).href;

// ページの HTML の中身（単体テストが <script> を取り出すのに使う）。
export async function loadHtml() {
  if (!remote) return fs.readFileSync(path.resolve(target), 'utf8');
  const res = await fetch(pageUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(pageUrl + ' を取得できませんでした（HTTP ' + res.status + '）');
  return res.text();
}

export const outDir = path.resolve(args[1] || path.join(os.tmpdir(), 'kiritori-ai-tests'));
fs.mkdirSync(outDir, { recursive: true });

// Chrome（なければ Edge）の実行ファイル。別の場所にある場合は環境変数 CHROME_PATH で指定する。
export function chromePath() {
  const e = process.env;
  const candidates = [
    e.CHROME_PATH,
    e.PROGRAMFILES && path.join(e.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    e['PROGRAMFILES(X86)'] && path.join(e['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    e.LOCALAPPDATA && path.join(e.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    e['PROGRAMFILES(X86)'] && path.join(e['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
    e.PROGRAMFILES && path.join(e.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error('Chrome / Edge が見つかりません。環境変数 CHROME_PATH に実行ファイルの場所を指定してください。');
}
