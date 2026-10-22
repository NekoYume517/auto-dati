/** Passive badges must only reflect configured question rules, and must be dismissible. */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { launchBrowser, createTarget, attachTo, waitForExtension, until, sleep } from './cdp.mjs';

const ID = 'mbiopgafffcabionpcmhoonphdpbgmia';
const PORT = 11900 + Math.floor(Math.random() * 100);
let count = 0;
function ok(label, condition) { assert.ok(condition, label); count++; console.log('  ✓ ' + label); }
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:16px sans-serif}header{height:72px;background:#05f;color:white}main{padding:30px}.course{height:120px}
#question{width:460px;padding:20px;border:1px solid #ddd}label{display:block;margin:10px 0}
</style><header><span id="logo">在线大学 · 课程首页</span><label style="display:none">搜索课程<input type="text" name="search"></label></header>
<main><section class="course"><h2 id="course-title">共享课</h2><a href="#">心理健康 · 课程进度 52%</a></section>
<div style="display:none"><span>登录信息</span><input type="text" name="tracking"></div>
<div id="question"><div class="stem">请选择以下属于质数的选项。</div><label class="opt"><input type="radio" name="q">A. 4</label><label class="opt"><input type="radio" name="q">B. 7</label></div>
<div id="hidden-only">普通说明文字<input type="text" style="display:none"></div></main>`;
const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
const browser = await launchBrowser({ extensionPath: path.resolve('extension'), port: PORT, headless: true, extraArgs: ['--window-size=1280,960'] });
const clients = [];
async function open(url) { await createTarget(PORT, url); const { cdp } = await attachTo(PORT, v => v === url); clients.push(cdp); return cdp; }
try {
  await waitForExtension(PORT, ID, { stderrFn: browser.stderr });
  const options = await open('chrome-extension://' + ID + '/ui/options.html');
  const popup = await open('chrome-extension://' + ID + '/ui/popup.html');
  const page = await open(url + '/dashboard');
  await page.captureMainFrameId();
  const ex = expression => page.evalInExtension(expression, ID);
  await until(() => ex('!!globalThis.AD?.App?.state.settings'));
  ok('题目角标默认隐藏，插件弹窗提供独立显示开关', await popup.eval('AD.Settings.DEFAULTS.mode.hoverHint===false && !!document.querySelector("#swHoverHint")'));
  await options.eval('AD.Settings.save({mode:{autoAnswer:false,popup:false,hoverHint:true},detect:{customRules:[]}})');
  await until(() => ex('AD.App.state.settings.mode.hoverHint'));
  function hint() { return ex('!!document.querySelector("#dati-overlay-host")?.shadowRoot.querySelector(".dati-hint.is-show")'); }
  async function move(selector) {
    const p = await page.eval(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+12,y:r.top+12}})()`);
    await page.send('Page.bringToFront');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    await sleep(240);
  }
  await move('#logo');
  ok('导航栏和隐藏搜索框不会生成全局填空题标识', !await hint());
  await move('#course-title');
  ok('课程首页不会被向上归并为整页题块', !await hint() && await ex('!AD.Detector.buildFromElement(document.querySelector("#course-title")) && !AD.Detector.buildFromElement(document.body) && !AD.Detector.buildFromElement(document.documentElement)'));
  await move('#question .stem');
  ok('未配置规则的普通题块不会触发通用被动识别', !await hint());
  ok('主动拾取仍能推断真实题目结构', await ex('AD.Detector.buildFromElement(document.querySelector("#question .stem"))?.kind==="choice"'));
  ok('仅含隐藏输入框的说明块不能被识别成填空题', await ex('!AD.Detector.buildFromElement(document.querySelector("#hidden-only"))'));
  const rule = { id: 'hint-test', enabled: true, kind: 'choice', rootSelector: '#question', stemSelector: '.stem', optionSelector: '.opt' };
  await options.eval(`AD.Settings.save({detect:{customRules:[${JSON.stringify(rule)}]}})`);
  await until(() => ex('AD.App.state.settings.detect.customRules.length===1'));
  await move('#course-title'); await move('#question .stem');
  ok('配置的题块显示正确题型角标', await hint() && await ex('document.querySelector("#dati-overlay-host").shadowRoot.querySelector(".dati-hint").textContent.startsWith("单选题")'));
  await move('#course-title');
  ok('离开命中题块后角标立即消失，不停留在页面右上角', !await hint());
  await move('#question .stem');
  await popup.eval('document.querySelector("#swHoverHint").click()');
  await until(() => ex('!AD.App.state.settings.mode.hoverHint'));
  ok('从插件弹窗关闭角标后，无需移动鼠标或刷新页面就隐藏', !await hint());
  ok('关闭角标不会关闭辅助面板或修改识别规则', await ex('AD.Settings.snapshot().detect.customRules.length===1 && AD.Detector.scan(document,{}).length===1'));
  await popup.eval('document.querySelector("#swHoverHint").click()');
  await until(() => ex('AD.App.state.settings.mode.hoverHint'));
  await move('#course-title'); await move('#question .stem');
  ok('重新打开开关后，真实题块的角标能够再次显示', await hint());
  await page.eval('document.querySelector("#question").style.display="none"');
  await until(async () => !await hint());
  ok('题块隐藏后，无需再移动鼠标也会清理角标', true);
  await page.eval('document.querySelector("#question").style.display=""');
  await move('#course-title'); await move('#question .stem');
  await page.eval('document.querySelector("#question").remove()');
  await until(async () => !await hint());
  ok('SPA 移除题块后清理角标，不产生残留标识', true);
  const broadRules = [
    { id: 'body-rule', kind: 'blank', rootSelector: 'body', inputSelector: 'input' },
    { id: 'header-rule', kind: 'blank', rootSelector: 'header', inputSelector: 'input' },
    { id: 'hidden-rule', kind: 'blank', rootSelector: '#hidden-only', stemSelector: '', inputSelector: 'input' },
    { id: 'empty-rule', kind: 'blank', rootSelector: '.course', stemSelector: 'h2', inputSelector: '.missing' }
  ];
  await options.eval(`AD.Settings.save({detect:{customRules:${JSON.stringify(broadRules)}}})`);
  await until(() => ex('AD.App.state.settings.detect.customRules.length===4'));
  ok('错误模板不能把整页、导航、隐藏控件或缺失输入框识别成填空题', await ex('AD.Detector.scan(document,{}).length===0'));
  ok('工具栏弹窗增加开关后布局仍能完整显示', await popup.eval('document.querySelector(".pop").getBoundingClientRect().height<=600'));
  await popup.send('Emulation.setDeviceMetricsOverride', { width: 376, height: 600, deviceScaleFactor: 1, mobile: false });
  await popup.send('Page.bringToFront');
  await sleep(200);
  const shot = await popup.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.resolve('test/screens/automation-quick-settings.png'), Buffer.from(shot.data, 'base64'));
} finally {
  for (const client of clients) client.close();
  browser.kill(); server.close();
}
console.log('\n题目角标回归：' + count + ' 通过');
process.exit(0);
