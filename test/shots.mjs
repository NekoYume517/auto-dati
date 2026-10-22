/**
 * AutoDati · 视觉回归：在真实扩展环境里截取 UI
 *   node test/shots.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, attachTo, createTarget, sleep, waitForExtension } from './cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const EXT_ID = 'mbiopgafffcabionpcmhoonphdpbgmia';
const PORT = 10000 + Math.floor(Math.random() * 90);
const OUT = path.join(__dirname, 'screens');
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const site = await new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const f = path.join(__dirname, 'e2e', u.pathname === '/' ? 'page.html' : u.pathname);
    fs.readFile(f, (e, b) => {
      if (e) { res.writeHead(404); return res.end('404'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      res.end(b);
    });
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
});

const mock = spawn(process.execPath, [path.join(__dirname, 'mock-llm-server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
const mockUrl = await new Promise((res) => {
  mock.stdout.on('data', (d) => { const m = /MOCK_LLM_URL=(\S+)/.exec(String(d)); if (m) res(m[1]); });
});

const browser = await launchBrowser({ extensionPath: EXT, port: PORT, headless: true, extraArgs: ['--window-size=1280,900'] });
await waitForExtension(PORT, EXT_ID, { stderrFn: browser.stderr });

const settings = {
  enabled: true,
  mode: { autoAnswer: true, popup: true, autoFillAfterStream: false, scanDebounceMs: 250, minIntervalMs: 250, maxPerPage: 20, skipAnswered: true, cooldownMs: 0, noticeToast: true, hoverHint: true },
  api: { activeId: 'p1', profiles: [{ id: 'p1', name: 'OpenAI 官方', format: 'openai-chat', baseUrl: mockUrl, path: '', apiKey: 'sk-demo-key-for-screenshot', model: 'gpt-4o-mini', temperature: 0.2, maxTokens: 2048, stream: true, vision: true, extraHeaders: {}, extraBody: {}, timeoutMs: 60000, lastTest: { ok: true, ms: 842, text: '连接成功', error: '', at: Date.now() } }] },
  prompt: { system: '你是一名严谨的答题助手。', extraInstruction: '', kindHint: {}, language: 'zh', includeExplain: false, imageInstruction: '截图作答' },
  detect: { sitePresets: {}, customRules: [
      { id: 'e2e-choice', enabled: true, kind: 'choice', rootSelector: '#q1,#q6,#q7,#q8,#q9', stemSelector: '.stem', optionSelector: '.opt' },
      { id: 'e2e-multi', enabled: true, kind: 'multi', rootSelector: '#q2', stemSelector: '.stem', optionSelector: '.opt' },
      { id: 'e2e-judge', enabled: true, kind: 'judge', rootSelector: '#q3', stemSelector: '.stem', optionSelector: '.opt' },
      { id: 'e2e-blank', enabled: true, kind: 'blank', rootSelector: '#q4', stemSelector: '.stem', inputSelector: 'input' },
      { id: 'e2e-qa', enabled: true, kind: 'qa', rootSelector: '#q5', stemSelector: '.stem', inputSelector: 'textarea' }
    ], minTextLen: 4, viewportOnly: true, shadowDom: true },
  hotkey: { enabled: true, capture: 'Alt+Q', hover: 'Alt+Shift+Q', picker: 'Alt+Shift+E', toggleAuto: 'Alt+Shift+Z', togglePopup: 'Alt+Shift+X' },
  ui: { theme: 'dark', accent: '#6366f1', panelWidth: 384, fontSize: 13, radius: 14, blur: true, animate: true, panelPosition: 'auto' },
  advanced: { log: false, areaPicker: true, maxImageSide: 1600, screenshotFormat: 'png', showScreenshotThumb: true }
};

const optT = await createTarget(PORT, `chrome-extension://${EXT_ID}/ui/options.html`);
const { cdp: opt } = await attachTo(PORT, (u) => u.includes('/ui/options.html'));
await sleep(900);
await opt.eval(`new Promise(r=>chrome.storage.local.set({ad_settings:${JSON.stringify(settings)}},r))`);
await sleep(500);

async function shoot(cdp, name, { width = 1280, height = 900, full = false } = {}) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }).catch(() => null);
  await sleep(450);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(shot.data, 'base64'));
  console.log('  ✓', name + '.png');
}

console.log('截取设置页…');
await opt.eval(`location.hash = '#overview'; 'ok'`);
await shoot(opt, 'final-options-overview', { height: 940 });
await opt.eval(`location.hash = '#api'; 'ok'`);
await shoot(opt, 'final-options-api', { height: 1100 });
await opt.eval(`location.hash = '#detect'; 'ok'`);
await shoot(opt, 'final-options-detect', { height: 1200 });
await opt.eval(`location.hash = '#hotkey'; 'ok'`);
await shoot(opt, 'final-options-hotkey', { height: 1000 });
await opt.eval(`location.hash = '#appearance'; 'ok'`);
await shoot(opt, 'final-options-appearance', { height: 1000 });

console.log('截取 popup…');
const popT = await createTarget(PORT, `chrome-extension://${EXT_ID}/ui/popup.html`);
const { cdp: pop } = await attachTo(PORT, (u) => u.includes('/ui/popup.html'));
await sleep(800);
await shoot(pop, 'final-popup', { width: 380, height: 660 });

console.log('截取页面内覆盖层 + 拾取器…');
await createTarget(PORT, site.url + '/page.html');
const { cdp: page } = await attachTo(PORT, (u) => u.includes('/page.html'));
await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1500, deviceScaleFactor: 2, mobile: false }).catch(() => null);
await sleep(2600);
await shoot(page, 'final-overlay', { width: 1280, height: 1500 });

// 打开模板拾取器并截图（先清掉已有面板，避免遮挡）
await page.evalInExtension(`(function(){ AD.Overlay.closeAll(); return true; })()`, EXT_ID).catch(() => null);
await sleep(400);
await page.evalInExtension(`(function(){ AD.Picker.open(); return true; })()`, EXT_ID).catch(() => null);
await sleep(700);
const pickerShot = await page.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(OUT, 'final-picker.png'), Buffer.from(pickerShot.data, 'base64'));
console.log('  ✓ final-picker.png');

// 选中一个题块，展示配置卡片
const stemRect = await page.eval(`(function(){
  var el = document.querySelector('#q1 .stem');
  var r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
})()`);
await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stemRect.x, y: stemRect.y, button: 'none' });
await sleep(220);
await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: stemRect.x, y: stemRect.y, button: 'left', clickCount: 1 });
await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: stemRect.x, y: stemRect.y, button: 'left', clickCount: 1 });
await sleep(900);

const cardState = await page.evalInExtension(`(function(){
  var host = document.getElementById('dati-template-picker');
  if (!host || !host.shadowRoot) return { open: false };
  var card = host.shadowRoot.querySelector('.card');
  var rootSel = host.shadowRoot.querySelector('[data-role=rootPreview]');
  var kind = host.shadowRoot.querySelector('[data-role=kind]');
  var stem = host.shadowRoot.querySelector('[data-role=stem]');
  var opt = host.shadowRoot.querySelector('[data-role=option]');
  return {
    open: !!(card && card.classList.contains('show')),
    rootSelector: rootSel ? rootSel.textContent : '',
    kind: kind ? kind.value : '',
    stemSelector: stem ? stem.value : '',
    optionSelector: opt ? opt.value : ''
  };
})()`, EXT_ID).catch((e) => ({ error: e.message }));
console.log('    拾取器状态:', JSON.stringify(cardState));

const pickerCard = await page.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(OUT, 'final-picker-card.png'), Buffer.from(pickerCard.data, 'base64'));
console.log('  ✓ final-picker-card.png');

// 截图搜题的点选态
await page.evalInExtension(`(function(){
  var h = document.getElementById('dati-template-picker');
  if (h) h.remove();
  AD.Capture.pickElement({ hint: '点击要识别的题目区域' });
  return true;
})()`, EXT_ID).catch(() => null);
await sleep(600);
const shotPick = await page.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(OUT, 'final-capture-pick.png'), Buffer.from(shotPick.data, 'base64'));
console.log('  ✓ final-capture-pick.png');

// 面板高度是否贴合内容（避免大片空白）
const panelMetrics = await page.evalInExtension(`(function(){
  var h = document.getElementById('dati-overlay-host');
  if (!h || !h.shadowRoot) return null;
  var p = h.shadowRoot.querySelector('.dati-panel');
  if (!p) return null;
  var body = p.querySelector('.dati-panel__body');
  return { panelH: Math.round(p.getBoundingClientRect().height), bodyScroll: body ? body.scrollHeight : 0, bodyH: body ? Math.round(body.getBoundingClientRect().height) : 0 };
})()`, EXT_ID).catch(() => null);
console.log('    面板尺寸:', JSON.stringify(panelMetrics));

console.log('\n完成。输出目录：' + OUT);
browser.kill(); mock.kill(); site.server.close();
process.exit(0);
