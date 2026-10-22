/**
 * 真实站点回归：bansonic 表单页
 * 验证未配置站点规则或自定义规则时，普通表单不会被自动猜测或弹窗
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, attachTo, createTarget, sleep, until, waitForExtension } from './cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(path.resolve(__dirname, '..'), 'extension');
const EXT_ID = 'mbiopgafffcabionpcmhoonphdpbgmia';
const PORT = 10500 + Math.floor(Math.random() * 80);
const URL = 'https://upload.bansonic.top/BW0N6wN0';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? ' — ' + extra : '')); }
}

const mock = spawn(process.execPath, [path.join(__dirname, 'mock-llm-server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
const mockUrl = await new Promise((res) => {
  mock.stdout.on('data', (d) => { const m = /MOCK_LLM_URL=(\S+)/.exec(String(d)); if (m) res(m[1]); });
});

const browser = await launchBrowser({ extensionPath: EXT, port: PORT, headless: true, extraArgs: ['--window-size=1400,1000'] });
await waitForExtension(PORT, EXT_ID, { stderrFn: browser.stderr });

const optT = await createTarget(PORT, `chrome-extension://${EXT_ID}/ui/options.html`);
const { cdp: opt } = await attachTo(PORT, (u) => u.includes('/ui/options.html'));
await sleep(600);
const SETTINGS = {
  enabled: true,
  mode: { autoAnswer: false, popup: true, autoFillAfterStream: false, scanDebounceMs: 250, minIntervalMs: 250, maxPerPage: 20, skipAnswered: false, cooldownMs: 0, noticeToast: true, hoverHint: false },
  api: { activeId: 'e2e', profiles: [{ id: 'e2e', name: 'mock', format: 'openai-chat', baseUrl: mockUrl, path: '', apiKey: 'k', model: 'mock', temperature: 0.2, maxTokens: 512, stream: true, vision: true, extraHeaders: {}, extraBody: {}, timeoutMs: 15000, lastTest: null }] },
  prompt: { system: 'x', extraInstruction: '', kindHint: {}, language: 'zh', includeExplain: false, imageInstruction: 'x' },
  detect: { sitePresets: {}, customRules: [], minTextLen: 4, viewportOnly: true, shadowDom: true },
  hotkey: { enabled: true, capture: 'Alt+Q', hover: 'Alt+Shift+Q', picker: 'Alt+Shift+E', toggleAuto: 'Alt+Shift+Z', togglePopup: 'Alt+Shift+X' },
  ui: { theme: 'dark', accent: '#6366f1', panelWidth: 384, fontSize: 13, radius: 14, blur: true, animate: true, panelPosition: 'auto' },
  advanced: { log: true, areaPicker: true, maxImageSide: 1200, screenshotFormat: 'png', showScreenshotThumb: true }
};
await opt.eval('new Promise(function(r){chrome.storage.local.set({ad_settings:' + JSON.stringify(SETTINGS) + '},r)})');

await createTarget(PORT, URL);
const { cdp: page } = await attachTo(PORT, (u) => u.includes('bansonic.top'));
await page.captureMainFrameId();
await sleep(3000);
await until(async () => {
  try { return await page.evalInExtension('!!(globalThis.AD && AD.Overlay)', EXT_ID); }
  catch (e) { return false; }
}, { timeout: 20000, interval: 400, label: 'ctx' }).catch(() => false);

function panelInfo() {
  return page.evalInExtension(`(function(){
    var h = document.getElementById('dati-overlay-host');
    if (!h || !h.shadowRoot) return { n: 0, stems: [] };
    var list = h.shadowRoot.querySelectorAll('.dati-panel');
    var stems = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i].querySelector('.dati-panel__stem');
      if (s) stems.push(s.textContent.slice(0, 26));
    }
    return { n: list.length, stems: stems };
  })()`, EXT_ID);
}

console.log('\n[1] 未配置规则时不自动识别普通表单');
await sleep(5000);
const defaultScan = await page.evalInExtension('AD.Detector.scan(document,{}).length', EXT_ID);
const defaultPanels = await panelInfo();
ok('普通表单默认没有自动识别结果', defaultScan === 0, 'count=' + defaultScan);
ok('普通表单默认不弹出答题面板', defaultPanels.n === 0, JSON.stringify(defaultPanels));

console.log('\n[2] 视觉留档');
await page.eval(`window.scrollTo(0, 0); 'ok'`);
await sleep(800);
const shot = await page.send('Page.captureScreenshot', { format: 'png' });
fs.mkdirSync(path.join(__dirname, 'screens'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'screens', 'bansonic-fixed.png'), Buffer.from(shot.data, 'base64'));
console.log('  已保存 test/screens/bansonic-fixed.png');

console.log('\n' + '='.repeat(52));
console.log(`结果：${pass} 通过, ${fail} 失败`);
if (fail) { console.log('\n失败项：'); failures.forEach((f) => console.log('  - ' + f)); }
browser.kill(); mock.kill();
process.exit(fail ? 1 : 0);