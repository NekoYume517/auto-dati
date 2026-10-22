/**
 * 集成校验：默认不做通用题型扫描，仅按已验证站点规则和自定义规则检测。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, attachTo, createTarget, sleep, waitForExtension } from './cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(path.resolve(__dirname, '..'), 'extension');
const EXT_ID = 'mbiopgafffcabionpcmhoonphdpbgmia';
const PORT = 9800 + Math.floor(Math.random() * 100);

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? ' — ' + extra : '')); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const site = await new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const f = path.join(__dirname, 'e2e', u.pathname === '/' ? 'page.html' : u.pathname);
    fs.readFile(f, (e, b) => {
      if (e) { res.writeHead(404); return res.end(); }
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

const browser = await launchBrowser({ extensionPath: EXT, port: PORT, headless: true, extraArgs: ['--window-size=1280,1600'] });
await waitForExtension(PORT, EXT_ID, { stderrFn: browser.stderr });

const optT = await createTarget(PORT, `chrome-extension://${EXT_ID}/ui/options.html`);
const { cdp: opt } = await attachTo(PORT, (u) => u.includes('/ui/options.html'));
await sleep(700);

const base = {
  enabled: true,
  mode: { autoAnswer: false, popup: false, autoFillAfterStream: false, scanDebounceMs: 600, minIntervalMs: 1500, maxPerPage: 30, skipAnswered: false, cooldownMs: 0, noticeToast: false, hoverHint: false },
  api: { activeId: 'e2e', profiles: [{ id: 'e2e', name: 'mock', format: 'openai-chat', baseUrl: mockUrl, path: '', apiKey: 'k', model: 'm', temperature: 0.2, maxTokens: 512, stream: true, vision: true, extraHeaders: {}, extraBody: {}, timeoutMs: 15000, lastTest: null }] },
  prompt: { system: '答题助手', extraInstruction: '', kindHint: {}, language: 'zh', includeExplain: false, imageInstruction: '截图' },
  detect: { sitePresets: { zhihuishu: true }, customRules: [], minTextLen: 4, viewportOnly: true, shadowDom: true },
  hotkey: { enabled: true, capture: 'Alt+Q', hover: 'Alt+Shift+Q', toggleAuto: 'Alt+Shift+Z', togglePopup: 'Alt+Shift+X' },
  ui: { theme: 'dark', accent: '#6366f1', panelWidth: 384, fontSize: 13, radius: 14, blur: true, animate: true, panelPosition: 'auto' },
  advanced: { log: false, areaPicker: true, maxImageSide: 1200, screenshotFormat: 'png', showScreenshotThumb: true }
};

async function setRules(customRules) {
  const s = JSON.parse(JSON.stringify(base));
  s.detect.customRules = customRules || [];
  await opt.eval(`new Promise(r=>chrome.storage.local.set({ad_settings:${JSON.stringify(s)}},r))`);
  await sleep(450);
}

await createTarget(PORT, site.url + '/page.html');
const { cdp: page } = await attachTo(PORT, (u) => u.includes('/page.html'));
await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1600, deviceScaleFactor: 1, mobile: false }).catch(() => null);
await sleep(1200);

async function scanQuestions() {
  return page.evalInExtension(`(function(){
    var AD = globalThis.AD;
    return AD.Detector.scan(document, {}).map(function(q){ return {kind:q.kind, id:q.root && q.root.id, preset:q.presetId}; });
  })()`, EXT_ID);
}

console.log('[1] 没有站点规则或自定义规则时不做通用扫描');
await setRules([]);
{
  const list = await scanQuestions();
  ok('普通页面默认不自动猜测题目', list.length === 0, JSON.stringify(list));
}

console.log('\n[2] 添加自定义规则后按规则识别');
await setRules([{ id: 'manual-q1', name: '测试页单题规则', enabled: true, kind: 'choice', rootSelector: '#q1', stemSelector: '.stem', optionSelector: '.opt' }]);
{
  const list = await scanQuestions();
  ok('仅命中手动配置的题块', list.length === 1 && list[0].id === 'q1' && list[0].preset === 'custom:manual-q1', JSON.stringify(list));
}

console.log('\n[3] 移除自定义规则后停止扫描');
await setRules([]);
{
  const list = await scanQuestions();
  ok('移除规则后不再检测普通题目', list.length === 0, JSON.stringify(list));
}

console.log('\n[4] 仅注册智慧树站点预设');
{
  const ids = await page.evalInExtension('AD.PRESETS.map(function(p){return p.id})', EXT_ID);
  ok('自动检测只包含智慧树站点规则', JSON.stringify(ids) === '["zhihuishu"]', JSON.stringify(ids));
}

console.log('\n' + '='.repeat(52));
console.log(`结果：${pass} 通过, ${fail} 失败`);
if (fail) { console.log('\n失败项：'); failures.forEach((f) => console.log('  - ' + f)); }

browser.kill(); mock.kill(); site.server.close();
process.exit(fail ? 1 : 0);
