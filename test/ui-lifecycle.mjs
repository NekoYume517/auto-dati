/** UI layouts and question-panel lifetime, using an isolated browser profile. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { launchBrowser, createTarget, attachTo, until, sleep, waitForExtension } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_ID = 'mbiopgafffcabionpcmhoonphdpbgmia';
const PORT = 11100 + Math.floor(Math.random() * 90);
let pass = 0, fail = 0;
const failures = [];
function ok(name, result, detail) {
  if (result) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name); console.log('  ✗ ' + name + ' ' + JSON.stringify(detail || '')); }
}
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>面板滚动验证</title><style>body{margin:0;padding:32px;font:14px/1.8 system-ui;background:#f5f6f8;color:#20242d}#before{height:190px}.examPaper_subject{width:520px;max-width:90%;padding:24px;background:white;border:1px solid #e1e4e9;border-radius:12px}.subject_describe{font-weight:600;margin:10px 0}.nodeLab{padding:8px 0}#tail{height:1600px}</style><div id="before"></div><div class="examPaper_subject"><div class="subject_type">【单选题】</div><div class="subject_describe">当我们感到焦虑时，背后可能隐藏的需求是（ ）。</div><div class="subject_node">' +
    ['被理解、被倾听', '陪伴、同情', '成就感、荣誉感', '安全感、掌控感'].map((text, i) => '<div class="nodeLab"><span class="ABCase">' + String.fromCharCode(65 + i) + '.</span> <span class="node_detail">' + text + '</span></div>').join('') + '</div></div><div id="tail"></div>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
const browser = await launchBrowser({ extensionPath: path.join(ROOT, 'extension'), port: PORT, headless: true, extraArgs: ['--window-size=1280,950'] });
const clients = [];
async function open(url) {
  await createTarget(PORT, url);
  const { cdp } = await attachTo(PORT, value => value === url);
  clients.push(cdp);
  return cdp;
}
async function metrics(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
}
async function shot(cdp, name) {
  await sleep(260);
  const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.join(ROOT, 'test/screens'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'test/screens', name + '.png'), Buffer.from(result.data, 'base64'));
}
try {
  await waitForExtension(PORT, EXT_ID, { stderrFn: browser.stderr });
  const options = await open('chrome-extension://' + EXT_ID + '/ui/options.html');
  await until(() => options.eval('!!(globalThis.AD && AD.Settings)'), { timeout: 8000 });
  await options.eval('AD.Settings.save({mode:{autoAnswer:false,popup:false},detect:{sitePresets:{zhihuishu:true}},ui:{theme:"light",animate:true,panelPosition:"auto",panelWidth:376}})');
  await metrics(options, 1360, 960);
  console.log('\n[1] Settings layout, navigation, themes and motion');
  for (const view of ['overview', 'api', 'prompt', 'detect', 'behavior', 'hotkey', 'appearance', 'statistics', 'data']) {
    await options.eval('document.querySelector(\'[data-nav="' + view + '"]\').click()');
    const state = await options.eval(`(() => {
      const main = document.querySelector('#main');
      const active = document.querySelector('.view.is-active');
      const nav = document.querySelector('.nav__item[aria-current="page"]');
      return {view:active.dataset.view, count:document.querySelectorAll('.view.is-active').length,
        overflow:main.scrollWidth > main.clientWidth + 1,
        crumb:document.querySelector('#currentSection').textContent === active.querySelector('h1').textContent,
        nav:nav && nav.dataset.nav};
    })()`);
    ok(view + ' 可切换，面包屑同步且无横向溢出', state.view === view && state.count === 1 && state.crumb && state.nav === view && !state.overflow, state);
  }
  await options.eval('document.querySelector(\'[data-nav="overview"]\').click()');
  await shot(options, 'redesign-workspace-light');
  await options.eval('AD.Settings.save({ui:{theme:"dark"}})');
  await until(() => options.eval('document.body.dataset.theme === "dark"'), { timeout: 3000 });
  await shot(options, 'redesign-workspace-dark');
  await metrics(options, 540, 850);
  await options.eval('document.querySelector(\'[data-nav="api"]\').click()');
  const mobile = await options.eval('({overflow:document.querySelector("#main").scrollWidth > document.querySelector("#main").clientWidth+1,width:innerWidth})');
  ok('窄屏设置页可用，无横向溢出', !mobile.overflow, mobile);
  await shot(options, 'redesign-workspace-mobile');
  await options.eval('AD.Settings.save({ui:{animate:false}})');
  await until(() => options.eval('document.body.hasAttribute("data-noanim")'), { timeout: 3000 });
  ok('关闭动效应用到整个设置页', await options.eval('getComputedStyle(document.querySelector(".view.is-active")).animationName === "none"'));

  const popup = await open('chrome-extension://' + EXT_ID + '/ui/popup.html');
  await metrics(popup, 376, 600);
  await until(() => popup.eval('document.body.hasAttribute("data-noanim")'), { timeout: 3000 });
  const pocket = await popup.eval(`(() => {
    const foot = document.querySelector('.pop-foot').getBoundingClientRect();
    return {height:document.querySelector('.pop').getBoundingClientRect().height, footer:foot.bottom, overflow:document.body.scrollWidth>innerWidth};
  })()`);
  ok('工具栏弹窗适配 600px 高度，完整显示底部操作', pocket.height <= 600 && pocket.footer <= 600 && !pocket.overflow, pocket);
  ok('工具栏弹窗尊重动效开关', await popup.eval('getComputedStyle(document.querySelector(".pop-head")).animationName === "none"'));
  await options.eval('AD.Settings.save({ui:{theme:"light",animate:true}})');
  await until(() => popup.eval('document.body.dataset.theme === "light" && !document.body.hasAttribute("data-noanim")'), { timeout: 3000 });
  await shot(popup, 'redesign-popup-light');
  await options.eval('AD.Settings.save({ui:{theme:"dark"}})');
  await until(() => popup.eval('document.body.dataset.theme === "dark"'), { timeout: 3000 });
  await shot(popup, 'redesign-popup-dark');
  await popup.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  ok('系统减少动态效果时禁用工具栏进场动画', await popup.eval('getComputedStyle(document.querySelector(".pop-head")).animationName === "none"'));

  console.log('\n[2] Panel follows its live question and disappears with it');
  const page = await open(url + '/');
  await metrics(page, 1280, 950);
  await until(() => page.evalInExtension('!!(globalThis.AD && AD.Overlay && AD.App.state.settings)', EXT_ID), { timeout: 10000 });
  const show = `(() => {
    const root = document.querySelector('.examPaper_subject');
    const question = AD.PresetKit.analyzeZhihuishu(root,{minTextLen:2});
    AD._uiPanel = AD.Overlay.show({question:question,onClose:function(s,info){AD._uiClose=info;}});
    AD.Overlay.done(AD._uiPanel,{text:'D',ms:900});
    return AD._uiPanel;
  })()`;
  await page.evalInExtension(show, EXT_ID);
  await sleep(280);
  const panelState = `(() => {
    const session=AD.Overlay.session(AD._uiPanel);
    if(!session)return {closed:true,info:AD._uiClose};
    const r=session.panel.getBoundingClientRect();
    return {closed:false,top:r.top,left:r.left,right:r.right,bottom:r.bottom,width:r.width,suspended:!!session.suspended,
      hidden:getComputedStyle(session.panel).visibility==='hidden',inert:session.panel.inert,
      viewportWidth:document.documentElement.clientWidth,
      topLayer:document.querySelector('#dati-overlay-host').matches(':popover-open')};
  })()`;
  const initial = await page.evalInExtension(panelState, EXT_ID);
  ok('面板在顶层显示且贴近右侧滚动条', initial.topLayer && Math.abs(initial.right - initial.viewportWidth + 16) < 3 && initial.bottom <= 950, initial);
  await shot(page, 'redesign-answer-dark');
  await page.eval('scrollTo(0,100)');
  const moved = await until(async () => {
    const state = await page.evalInExtension(panelState, EXT_ID);
    return Math.abs(state.top - initial.top + 100) < 3 ? state : null;
  }, { timeout: 2000 }).catch(() => null);
  ok('滚动后面板跟随题目实时位置', !!moved, moved);
  await page.eval('scrollTo(0,1000)');
  const hidden = await until(async () => {
    const state=await page.evalInExtension(panelState,EXT_ID);return state.hidden && state.suspended && state.inert;
  }, { timeout: 2000 }).catch(() => false);
  ok('题目滚出视口时面板隐藏且不能误点击', hidden);
  await page.eval('scrollTo(0,0)');
  const back = await until(async () => {
    const state=await page.evalInExtension(panelState,EXT_ID);return !state.closed && !state.suspended && !state.hidden;
  }, { timeout: 2000 }).catch(() => false);
  ok('滚回题目时恢复原面板和答案，无重复请求', back && await page.evalInExtension('AD.Overlay.text(AD._uiPanel)==="D" && AD.Overlay.count()===1', EXT_ID));
  await page.eval('document.querySelector(".examPaper_subject").style.display="none"');
  ok('CSS 隐藏题目时面板消失', await until(async () => (await page.evalInExtension(panelState, EXT_ID)).hidden, { timeout: 2000 }).catch(() => false));
  await page.eval('document.querySelector(".examPaper_subject").style.display=""');
  await until(async () => !(await page.evalInExtension(panelState, EXT_ID)).hidden, { timeout: 2000 });
  await page.eval('document.querySelector(".subject_describe").firstChild.nodeValue="同一个题块已经切换为另一道题？"');
  const replaced = await until(async () => (await page.evalInExtension(panelState, EXT_ID)).closed, { timeout: 2000 }).catch(() => false);
  ok('题块复用且题干变化时关闭旧面板', replaced);
  ok('自动关闭不记为用户手动拒绝', await page.evalInExtension('AD._uiClose && !AD._uiClose.userClosed && AD._uiClose.reason==="question-changed"', EXT_ID));
  await page.evalInExtension(show, EXT_ID);
  await page.eval('document.querySelector(".examPaper_subject").remove()');
  ok('题块从 DOM 删除后自动关闭面板', await until(async () => (await page.evalInExtension(panelState, EXT_ID)).closed, { timeout: 2000 }).catch(() => false));

  console.log('\n[3] Nested scroll containers, themes and reduced motion');
  await page.eval(`document.body.insertAdjacentHTML('afterbegin','<div id="nested" style="height:350px;overflow:auto;width:600px"><div style="height:150px"></div><div class="examPaper_subject"><div class="subject_type">【单选题】</div><div class="subject_describe">嵌套滚动区域中的题目？</div><div class="nodeLab"><span class="ABCase">A.</span><span class="node_detail">选项甲</span></div><div class="nodeLab"><span class="ABCase">B.</span><span class="node_detail">选项乙</span></div></div><div style="height:1000px"></div></div>')`);
  await page.evalInExtension(show, EXT_ID);
  await page.eval('document.querySelector("#nested").scrollTop=600');
  ok('题目被内层滚动容器裁切时面板隐藏', await until(async () => (await page.evalInExtension(panelState, EXT_ID)).hidden, { timeout: 2000 }).catch(() => false));
  await page.eval('document.querySelector("#nested").scrollTop=80');
  await until(async () => !(await page.evalInExtension(panelState, EXT_ID)).hidden, { timeout: 2000 });
  await options.eval('AD.Settings.save({ui:{theme:"light",animate:false,blur:false}})');
  const flat = await until(() => page.evalInExtension('(()=>{const s=AD.Overlay.session(AD._uiPanel);return s && s.panel.dataset.theme==="light" && s.panel.hasAttribute("data-noanim") && s.panel.hasAttribute("data-noblur")})()', EXT_ID), { timeout: 3000 }).catch(() => false);
  ok('面板实时同步主题、动效和毛玻璃设置', flat);
  await shot(page, 'redesign-answer-light');
  await options.eval('AD.Settings.save({ui:{animate:true,blur:true}})');
  ok('重新启用动效会移除旧的禁用标记', await until(() => page.evalInExtension('(()=>{const s=AD.Overlay.session(AD._uiPanel);return s && !s.panel.hasAttribute("data-noanim") && !s.panel.hasAttribute("data-noblur")})()', EXT_ID), { timeout: 3000 }).catch(() => false));
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  ok('面板尊重系统减少动态效果设置', await page.evalInExtension('parseFloat(getComputedStyle(AD.Overlay.session(AD._uiPanel).panel).transitionDuration)<=0.001', EXT_ID));
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  if (fail) console.log(failures.join('\n'));
} catch (error) {
  fail++;
  console.error(error.stack || error);
} finally {
  clients.forEach(client => client.close());
  browser.kill();
  server.close();
}
process.exit(fail ? 1 : 0);
