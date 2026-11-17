// Render the dashboard's three screenshots with headless Chromium over CDP.
// Node standard library only (built-in WebSocket client). Usage:
//   node tools/shoot.mjs <out-dir> <shots-dir>
// Chromium is launched with --remote-debugging-port; each shot is one target.
import { spawn, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME_BIN ||
  `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`;

const outDir = process.argv[2];
const shotsDir = process.argv[3];
if (!outDir || !shotsDir) {
  console.error('usage: node tools/shoot.mjs <out-dir> <shots-dir>');
  process.exit(2);
}
mkdirSync(shotsDir, { recursive: true });

const PORT = 9333;
const chrome = spawn(CHROME, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--hide-scrollbars',
  '--allow-file-access-from-files',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/radar-chrome-profile',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('chromium did not answer on port ' + PORT);
}

let msgId = 0;
const pending = new Map();
let ws;
function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function shoot(url, file, format, quality, scrollSel) {
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const attach = await send('Target.attachToTarget', { targetId: target.id, flatten: true });
  const sessionId = attach.result.sessionId;
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  await sleep(2500); // let data.js render, fonts settle, detail scroll finish
  if (scrollSel) {
    await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(scrollSel)}).scrollIntoView({block:'start',behavior:'instant'})` }, sessionId);
    await sleep(600);
  }
  const shot = await send('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality } : {}) }, sessionId);
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
  await send('Target.closeTarget', { targetId: target.id });
}

try {
  const version = await getJson('/json/version');
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m);
    }
  };

  const base = `file://${outDir}/dashboard/index.html`;
  const shots = [
    { url: base, file: '1-board.png', scroll: '.controls' },
    { url: `${base}#p=steakhouse-financial`, file: '2-detail.png', scroll: '#detail' },
    { url: `${base}#f=Dexs`, file: '3-filtered.png', scroll: '.controls' },
  ];
  for (const s of shots) {
    await shoot(s.url, join(shotsDir, s.file), 'png', undefined, s.scroll);
    const size = (await import('node:fs')).statSync(join(shotsDir, s.file)).size;
    console.log(`${s.file}: ${size} bytes (png)`);
    if (size > 450_000) {
      // Re-shoot as JPEG to stay comfortably inside the 512 KiB cap.
      await shoot(s.url, join(shotsDir, s.file.replace('.png', '.jpg')), 'jpeg', 82, s.scroll);
      const jsize = (await import('node:fs')).statSync(join(shotsDir, s.file.replace('.png', '.jpg'))).size;
      console.log(`${s.file.replace('.png', '.jpg')}: ${jsize} bytes (jpeg)`);
      (await import('node:fs')).unlinkSync(join(shotsDir, s.file));
    }
  }
} finally {
  try { ws?.close(); } catch { /* already closed */ }
  chrome.kill('SIGKILL');
}
console.log('shots done');
