/** New interaction + supplier + usage + backup + cosmetic filtering regressions. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { launchBrowser, createTarget, attachTo, until, sleep, waitForExtension } from './cdp.mjs';
const ID = 'mbiopgafffcabionpcmhoonphdpbgmia', PORT = 11500 + Math.floor(Math.random() * 70);
let count = 0, listFailure = false, requests = [], streamBody;
function ok(name, condition) { assert.ok(condition, name); count++; console.log('  ✓ ' + name); }
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://local');
  if (u.pathname.endsWith('/models')) {
    requests.push({ path: req.url, headers: req.headers, method: req.method });
    res.setHeader('Content-Type', 'application/json');
    if (listFailure) { res.writeHead(401); res.end('{"error":"bad auth"}'); return; }
    if (u.pathname.startsWith('/anthropic')) {
      return res.end(JSON.stringify(u.searchParams.has('after_id') ? { data: [{ id: 'claude-two', display_name: 'Claude Two' }], has_more: false } : { data: [{ id: 'claude-one' }], has_more: true, last_id: 'claude-one' }));
    }
    if (u.pathname.startsWith('/gemini')) return res.end(JSON.stringify({ models: [{ name: 'models/gemini-one', displayName: 'Gemini One' }] }));
    return res.end(JSON.stringify({ data: [{ id: 'model-alpha', owned_by: 'test' }, { id: 'model-beta' }, { id: 'model-beta' }, { id: '<img src=x onerror=alert(1)>' }] }));
  }
  if (u.pathname.endsWith('/chat/completions')) {
    let body = ''; for await (const chunk of req) body += chunk; streamBody = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'B' } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 25 } } }) + '\n\ndata: [DONE]\n\n'); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:80px;font:16px system-ui}#question{width:440px;padding:24px;border:1px solid #ddd;border-radius:12px}#tail{height:1500px}</style><div id="question">一加一等于几？<label><input type="radio" name="q">A. 一</label><label><input type="radio" name="q">B. 二</label></div><div id="tail"></div>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
const browser = await launchBrowser({ extensionPath: path.resolve('extension'), port: PORT, headless: true, extraArgs: ['--window-size=1360,960'] });
const clients = [];
async function open(url) { await createTarget(PORT, url); const { cdp } = await attachTo(PORT, v => v === url); clients.push(cdp); return cdp; }
async function shot(page, name) { await sleep(240); const result = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join('test/screens', name + '.png'), Buffer.from(result.data, 'base64')); }
try {
  await waitForExtension(PORT, ID, { stderrFn: browser.stderr });
  const options = await open('chrome-extension://' + ID + '/ui/options.html');
  await until(() => options.eval('!!AD.StatisticsClient && document.querySelector("#pModel")'));
  ok('题目识别只展示智慧树站点预设且默认开启', await options.eval('document.querySelectorAll("[data-site]").length===0 && AD.Settings.snapshot().detect.customRules.some(r=>r.id==="site-zhihuishu"&&r.enabled)'));
  ok('旧版通用题型配置会被清除', await options.eval('(()=>{const d=AD.Settings.normalize({detect:{presets:{choice:false,generic:true}}}).detect;return !Object.prototype.hasOwnProperty.call(d,"presets")})()'));
  ok('旧站点预设设置会迁移清理', await options.eval('(()=>{const s=AD.Settings.normalize({detect:{sitePresets:{chaoxing:true,yuketang:true}}}).detect.sitePresets;return Object.keys(s).length===1&&s.zhihuishu===false})()'));
  ok('设置集中到一个一级入口，包含关于更新的六个二级 Tab', await options.eval('document.querySelector("[data-nav=behavior]").textContent.trim()==="设置" && !document.querySelector("[data-nav=hotkey]") && !document.querySelector("[data-nav=appearance]") && document.querySelectorAll("[data-settings-tab]").length===6'));
  ok('完整设置每个配置仅出现一次，没有工作台重复开关', await options.eval('(()=>{const paths=Array.from(document.querySelectorAll("[data-path]")).map(el=>el.dataset.path);return paths.length===new Set(paths).size})()'));
  await options.eval('document.querySelector("[data-nav=behavior]").click()');
  ok('进入设置默认常规，显示二级 Tab', await options.eval('!document.querySelector("#settingsTabs").hidden && document.querySelector("[data-view=behavior]").classList.contains("is-active")'));
  await shot(options, 'settings-general');
  await options.eval('document.querySelector("[data-settings-tab=feedback]").click()');
  ok('弹窗与反馈页集中所有标识和点击高亮，一级设置保持选中', await options.eval('document.querySelector("[data-nav=behavior]").classList.contains("is-active") && ["mode.hoverHint","mode.highlightNextPage","detect.showDetectionBoxes","mode.noticeToast"].every(path=>document.querySelector("[data-view=feedback] [data-path=\\""+path+"\\"]"))'));
  await shot(options, 'settings-feedback');
  ok('弹窗布局与提示设置集中，宽度和停靠位置不再分散', await options.eval('!!document.querySelector("[data-view=feedback] #uiPanelWidth") && !!document.querySelector("[data-view=feedback] #uiPanelPosition")'));
  await options.eval('document.querySelector("[data-settings-tab=feedback]").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))');
  ok('二级 Tab 支持方向键并正确维护焦点与选中状态', await options.eval('document.activeElement.dataset.settingsTab==="hotkey" && document.activeElement.getAttribute("aria-selected")==="true" && document.querySelectorAll("[data-settings-tab][tabindex=\\"0\\"]").length===1'));
  await options.eval('document.querySelector("[data-settings-tab=hotkey]").click()');
  ok('截图选项与快捷键位于同一二级设置页', await options.eval('!!document.querySelector("[data-view=hotkey] [data-path=\\"advanced.areaPicker\\"]") && !!document.querySelector("[data-view=hotkey] #hkCapture")'));
  await options.eval('document.querySelector("[data-nav=detect]").click()');
  ok('离开设置隐藏二级 Tab，翻页选择器在统一规则编辑器中', await options.eval('document.querySelector("#settingsTabs").hidden && !!document.querySelector("#ruleNextPage") && !document.querySelector("[data-site]")'));
  ok('旧全局按钮选择器迁入已有规则', await options.eval('(()=>{const s=AD.Settings.normalize({mode:{nextPageSelector:"#legacy-next"},detect:{customRules:[{id:"legacy",rootSelector:".q"}]}});return !s.mode.nextPageSelector && s.detect.customRules.find(r=>r.id==="legacy").nextPageSelector==="#legacy-next"})()'));
  const customRulesText = await options.eval(`AD.Settings.save({detect:{customRules:[{id:'share-rule',name:'分享规则',kind:'choice',rootSelector:'.q',stemSelector:'.stem',optionSelector:'.opt',inputSelector:'',domains:['example.com'],enabled:true,nextPageSelector:'#rule-next',nextPageEnabled:false}]}}).then(()=>{
    document.querySelector('#btnExportRules').click();
    return document.querySelector('#ruleTransferText').value;
  })`);
  ok('自定义站点规则导出为可复制的 UTF-8 Base64 文本', await options.eval(`(()=>{const raw=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(${JSON.stringify(customRulesText)}),c=>c.charCodeAt(0))));return raw.format==='autodati-custom-site-rules'&&raw.rules[0].name==='分享规则'})()`));
  await options.eval(`AD.Settings.save({detect:{customRules:[]}}).then(()=>{
    document.querySelector('#ruleTransferText').value=${JSON.stringify(customRulesText)};
    document.querySelector('#btnApplyRules').click();
  })`);
  await until(() => options.eval('AD.Settings.snapshot().detect.customRules[0]?.id==="share-rule"'));
  ok('粘贴 Base64 导入规则并合并保存', await options.eval('AD.Settings.snapshot().detect.customRules.length===1 && document.querySelector("#ruleTransferStatus").textContent.includes("新增 1 条")'));
  ok('规则编码往返保留下一页选择器和开关', await options.eval('AD.Settings.snapshot().detect.customRules[0].nextPageSelector==="#rule-next" && AD.Settings.snapshot().detect.customRules[0].nextPageEnabled===false'));
  await options.eval('document.querySelector("[data-rule-act=edit]").click()');
  ok('规则编辑器读取翻页配置', await options.eval('document.querySelector("#ruleNextPage").value==="#rule-next" && !document.querySelector("#ruleNextPageEnabled").checked'));
  await options.eval('document.querySelector("#ruleNextPage").value="#edited-next";document.querySelector("#ruleNextPageEnabled").checked=true;document.querySelector("#btnRuleSave").click()');
  await until(() => options.eval('AD.Settings.snapshot().detect.customRules[0].nextPageSelector==="#edited-next"'));
  ok('编辑规则后保留题目字段并更新翻页配置', await options.eval('AD.Settings.snapshot().detect.customRules[0].nextPageEnabled && AD.Settings.snapshot().detect.customRules[0].optionSelector===".opt"'));
  await options.eval(`AD.Settings.save({mode:{autoAnswer:false,popup:false,cooldownMs:0},api:{activeId:'p1',profiles:[{id:'p1',name:'测试供应商',format:'openai-chat',baseUrl:${JSON.stringify(url + '/v1')},apiKey:'mock-feature-key',model:'old-model',stream:true,timeoutMs:10000}]},ui:{theme:'light'}})`);
  await options.eval('document.querySelector(\'[data-nav="api"]\').click()');
  await options.eval('document.querySelector("#btnFetchModels").click()');
  await until(() => options.eval('document.querySelectorAll("#modelsList input").length===3'));
  ok('按 Base URL 拼接 GET /v1/models，使用配置中的 Bearer Key', requests[0].path === '/v1/models' && requests[0].method === 'GET' && requests[0].headers.authorization === 'Bearer mock-feature-key');
  ok('原生模态框聚焦搜索框，未知旧模型不能直接确认', await options.eval('document.querySelector("#modelsDialog").open && document.activeElement.id==="modelsSearch" && document.querySelector("#btnUseModel").disabled'));
  ok('模型 ID 按纯文本显示，不执行供应商返回的 HTML', await options.eval('!document.querySelector("#modelsList img") && document.querySelector("#modelsList").textContent.includes("<img")'));
  await shot(options, 'redesign-model-picker');
  await options.eval('const search=document.querySelector("#modelsSearch");search.value="beta";search.dispatchEvent(new Event("input"));document.querySelector("#modelsList input").click();document.querySelector("#btnUseModel").click()');
  await until(() => options.eval('!document.querySelector("#modelsDialog").open && AD.Settings.snapshot().api.profiles[0].model==="model-beta"'));
  ok('搜索、单选并使用模型，保存到当前供应商', await options.eval('document.querySelector("#pModel").value==="model-beta"'));
  listFailure = true;
  await options.eval('document.querySelector("#btnFetchModels").click()');
  await until(() => options.eval('document.querySelector("#modelsCount").textContent.includes("失败")'));
  ok('401 明确显示鉴权错误并支持重试', await options.eval('document.querySelector("#modelsList").textContent.includes("鉴权失败") && document.querySelector("#btnUseModel").disabled'));
  listFailure = false;
  await options.eval('document.querySelector("#btnRefreshModels").click()');
  await until(() => options.eval('document.querySelectorAll("#modelsList input").length===3'));
  await options.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await options.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  ok('Esc 关闭模型选择且不改变已保存模型', await until(() => options.eval('!document.querySelector("#modelsDialog").open && AD.Settings.snapshot().api.profiles[0].model==="model-beta"'), { timeout: 2000 }));
  const provider = async (format, base) => options.eval(`new Promise(r=>chrome.runtime.sendMessage({type:AD.MSG.LIST_PROVIDER_MODELS,profile:{format:${JSON.stringify(format)},baseUrl:${JSON.stringify(url + base)},apiKey:'mock-key'}},r))`);
  const anthropic = await provider('anthropic', '/anthropic');
  ok('Claude x-api-key 鉴权，翻页后合并模型', anthropic.models.length === 2 && requests.some(r => r.path.includes('after_id=claude-one') && r.headers['x-api-key'] === 'mock-key'));
  const gemini = await provider('gemini', '/gemini');
  ok('Gemini x-goog-api-key 鉴权并去掉 models/ 前缀', gemini.models[0].id === 'gemini-one' && requests.at(-1).headers['x-goog-api-key'] === 'mock-key');
  await options.eval(`new Promise(resolve=>{const p=chrome.runtime.connect({name:AD.STREAM.PORT});p.onMessage.addListener(m=>{if(m.type===AD.STREAM.DONE||m.type===AD.STREAM.ERROR){p.disconnect();resolve(m)}});p.postMessage({type:AD.STREAM.START,reqId:'stats-feature-test',request:{text:'一加一等于几',kind:'choice'},options:{force:true}})})`);
  const statistics = await until(async () => { const v = await options.eval('AD.StatisticsClient.get()'); return v.groups.length && v.groups[0].success ? v : null; });
  ok('流式请求主动请求 usage，最终空 choices 用量块仍被统计', streamBody.stream_options.include_usage === true && statistics.groups[0].metrics.total.sum === 140);
  ok('模型列表和测试连接不进入答题统计', statistics.groups[0].requests === 1);
  await options.eval('document.querySelector(\'[data-nav="statistics"]\').click()');
  await until(() => options.eval('document.querySelector("#statsTotal").textContent==="140" && !!document.querySelector("#statsTokensChart svg")'));
  ok('ECharts 本地图表已绘制，统计指标与实际接口一致', await options.eval('document.querySelector("#statsRequests").textContent==="1" && document.querySelector("#statsMetrics").textContent.includes("80") && document.querySelector("#statsMetrics").textContent.includes("未提供")'));
  await shot(options, 'redesign-statistics-light');
  await options.eval('AD.Settings.save({ui:{theme:"dark"}})');
  await shot(options, 'redesign-statistics-dark');
  await options.eval('document.querySelector("#statsPeriod").value="7";document.querySelector("#statsPeriod").dispatchEvent(new Event("change"))');
  ok('切换时间范围后保留当前数据且图表同步', await options.eval('document.querySelector("#statsUpdated").textContent.includes("7 天") && document.querySelector("#statsTotal").textContent==="140"'));
  await options.send('Emulation.setDeviceMetricsOverride', { width: 540, height: 850, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  ok('统计窄屏布局无横向溢出', await options.eval('document.querySelector("#main").scrollWidth<=document.querySelector("#main").clientWidth+1'));
  await shot(options, 'redesign-statistics-mobile');
  await options.eval('document.querySelector("[data-nav=behavior]").click();document.querySelector("[data-settings-tab=feedback]").click()');
  ok('窄屏设置页无横向溢出，二级 Tab 可在自身范围内滚动', await options.eval('document.querySelector("#main").scrollWidth<=document.querySelector("#main").clientWidth+1 && document.querySelector("#settingsTabs").getBoundingClientRect().right<=innerWidth'));
  await shot(options, 'settings-mobile');
  await options.eval('document.querySelector("[data-nav=statistics]").click()');
  // Observe the actual export Blob, without replacing export implementation.
  await options.eval('globalThis.__oldCreate=URL.createObjectURL;URL.createObjectURL=function(blob){globalThis.__backup=blob.text();return __oldCreate.call(this,blob)};document.querySelector("#btnExport").click()');
  const backup = await until(() => options.eval('globalThis.__backup ? __backup.then(JSON.parse) : null'));
  ok('导出文件包含配置和完整统计数据', backup.backupVersion === 2 && backup.api.profiles[0].model === 'model-beta' && backup.statistics.groups[0].metrics.total.sum === 140);
  async function importBackup(data) {
    await options.eval(`(()=>{const file=new File([${JSON.stringify(JSON.stringify(data))}],'test-backup.json',{type:'application/json'});const dt=new DataTransfer();dt.items.add(file);const input=document.querySelector('#importFile');input.files=dt.files;input.dispatchEvent(new Event('change'));})()`);
  }
  await options.eval('AD.StatisticsClient.replace(AD.Statistics.empty())');
  await importBackup(backup);
  await until(() => options.eval('document.querySelector("#importStatus").textContent.includes("test-backup.json")'));
  let restored = await options.eval('AD.StatisticsClient.get()');
  ok('真实文件导入同时恢复统计量', restored.groups[0].requests === 1 && restored.groups[0].metrics.total.sum === 140);
  await importBackup(backup); await sleep(150);
  restored = await options.eval('AD.StatisticsClient.get()');
  ok('重复导入不叠加请求量', restored.groups[0].requests === 1);
  const old = structuredClone(backup); delete old.statistics; delete old.backupVersion;
  await importBackup(old); await sleep(150);
  ok('旧版配置导入保留已有统计', (await options.eval('AD.StatisticsClient.get()')).groups[0].requests === 1);
  const invalid = structuredClone(backup); invalid.statistics.groups[0].requests = -1; invalid.api.profiles[0].model = 'must-not-save';
  await importBackup(invalid); await sleep(150);
  ok('无效统计导入在写入前拒绝，配置和统计均不损坏', await options.eval('AD.Settings.snapshot().api.profiles[0].model==="model-beta" && document.querySelector("#importStatus").textContent.includes("校验未通过")'));
  const page = await open(url + '/page');
  await until(() => page.evalInExtension('!!(globalThis.AD && AD.Capture && AD.App.state.settings)', ID));
  const ex = code => page.evalInExtension(code, ID);
  const toast = await ex(`(()=>{
    globalThis.__originalFetch=globalThis.fetch;globalThis.__cssReads=0;
    globalThis.fetch=function(){__cssReads++;throw new Error('stylesheet fetch blocked for regression')};
    AD.Overlay.toast('样式加载验证',{tone:'success',ms:1200});
    const host=document.querySelector('#dati-overlay-host'),node=host.shadowRoot.querySelector('.dati-toast'),style=getComputedStyle(node);
    return {fixed:style.position==='fixed',bg:style.backgroundColor,css:host.shadowRoot.querySelector('style').textContent===AD.OVERLAY_CSS,fetches:__cssReads,panels:AD.Overlay.count(),role:node.getAttribute('role')};
  })()`);
  ok('没有答题弹窗、CSS 请求被阻断时，首次 Toast 仍立即具有完整样式', toast.fixed && toast.css && toast.fetches === 0 && toast.panels === 0 && toast.role === 'status' && toast.bg !== 'rgba(0, 0, 0, 0)');
  const rebuilt = await ex(`(()=>{document.querySelector('#dati-overlay-host').remove();AD.Overlay.toast('宿主重建后样式仍然完整',{ms:5000});const node=document.querySelector('#dati-overlay-host').shadowRoot.querySelector('.dati-toast');return {fixed:getComputedStyle(node).position==='fixed',css:node.getRootNode().querySelector('style').textContent===AD.OVERLAY_CSS}})()`);
  ok('SPA 删除注入宿主后，Toast 重建时同步恢复样式', rebuilt.fixed && rebuilt.css);
  await sleep(1250);
  ok('旧 Toast 的定时器不会提前关闭新宿主里的 Toast', await ex('document.querySelector("#dati-overlay-host").shadowRoot.querySelector(".dati-toast").classList.contains("is-show")'));
  await options.eval('AD.Settings.save({ui:{theme:"light",animate:false,blur:false}})');
  await until(() => ex('document.querySelector("#dati-overlay-host").shadowRoot.querySelector(".dati-toast").dataset.theme==="light"'));
  ok('Toast 独立响应主题、关闭动效和毛玻璃设置', await ex('(()=>{const node=document.querySelector("#dati-overlay-host").shadowRoot.querySelector(".dati-toast"),s=getComputedStyle(node);return s.transitionDuration==="0s"&&s.backdropFilter==="none"&&s.backgroundColor==="rgba(255, 255, 255, 0.97)"})()'));
  await shot(page, 'redesign-toast');
  await ex('globalThis.fetch=__originalFetch;AD.Overlay.destroy()');
  await page.eval(`document.head.insertAdjacentHTML('beforeend','<style>[id^="ad-"],[id^="ad_"],[class^="ad-"],[class*=" ad-"],[data-ad-ignore]{display:none!important}</style>')`);
  await ex(`AD._panel=AD.Overlay.show({question:{id:'filter-case',kind:'choice',text:'题目预览',options:[{label:'A',text:'甲'},{label:'B',text:'乙'}],root:document.querySelector('#question')}});AD.Overlay.done(AD._panel,{text:'B'});`);
  await sleep(250);
  ok('模拟广告前缀过滤规则时，答题面板仍正常显示', await ex('getComputedStyle(document.querySelector("#dati-overlay-host")).display!=="none" && getComputedStyle(AD.Overlay.session(AD._panel).panel).visibility!=="hidden"'));
  ok('页面 UI 不再使用 ad- / ad_ class、ID 或 data-ad 属性', await ex('!document.querySelector("[id^=ad-],[id^=ad_],[data-ad-ignore]") && !document.querySelector("#dati-overlay-host").shadowRoot.querySelector("[class^=ad-],[class*=\\" ad-\\"]")'));
  async function startPick() { await ex('AD._pickResult="pending";AD.Capture.pickElement().then(r=>{AD._pickResult=r?{mode:r.mode||"element",rect:r.rect,id:r.el&&r.el.id}:null});void 0'); }
  await startPick();
  const noBlur = await ex('getComputedStyle(document.querySelector("#dati-elem-picker-host").shadowRoot.querySelector(".wrap")).backdropFilter==="none"');
  ok('统一拾取仅压暗背景，没有全局模糊', noBlur);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 160, y: 110 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 160, y: 110, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 160, y: 110, button: 'left', clickCount: 1 });
  const picked = await until(() => ex('AD._pickResult!=="pending" && AD._pickResult'));
  ok('单击选择真实页面元素，选择后移除遮罩', picked.mode === 'element' && picked.rect.w > 0 && await ex('!document.querySelector("#dati-elem-picker-host")'));
  await startPick();
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 90, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 460, y: 220, buttons: 1 });
  await shot(page, 'redesign-unified-picker');
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 460, y: 220, button: 'left', clickCount: 1 });
  const region = await until(() => ex('AD._pickResult!=="pending" && AD._pickResult'));
  ok('同一入口拖动得到精确自由矩形', region.mode === 'region' && region.rect.w === 360 && region.rect.h === 130);
  await startPick();
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 220, y: 180, button: 'right', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 220, y: 180, button: 'right', clickCount: 1 });
  ok('右键退出拾取并清理遮罩', await until(() => ex('AD._pickResult===null && !document.querySelector("#dati-elem-picker-host")')));
  await startPick();
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  ok('Esc 退出拾取', await until(() => ex('AD._pickResult===null')));
  await ex('AD._firstPick="pending";AD.Capture.pickElement().then(r=>AD._firstPick=r);AD._secondPick="pending";AD.Capture.pickElement().then(r=>AD._secondPick=r);void 0');
  ok('重复开启会结束上一个拾取，遮罩只保留一份', await ex('AD._firstPick===null && document.querySelectorAll("#dati-elem-picker-host").length===1'));
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await ex('AD.Picker.open();void 0');
  ok('模板拾取遮罩也只压暗背景', await ex('getComputedStyle(document.querySelector("#dati-template-picker").shadowRoot.querySelector(".veil")).backdropFilter==="none"'));
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 160, y: 110 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 160, y: 110, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 160, y: 110, button: 'left', clickCount: 1 });
  ok('模板配置弹窗使用统一浅色主题并关闭动效', await until(() => ex('(()=>{const h=document.querySelector("#dati-template-picker"),c=h.shadowRoot.querySelector(".card");return h.dataset.theme==="light"&&c.classList.contains("show")&&getComputedStyle(c).backgroundColor==="rgb(255, 255, 255)"&&getComputedStyle(c).animationName==="none"})()')));
  await sleep(180);
  ok('拾取期间不冒出额外的题目快捷键提示', await ex('!document.querySelector("#dati-overlay-host")?.shadowRoot.querySelector(".dati-hint.is-show")'));
  await shot(page, 'redesign-template-picker');
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 220, y: 180, button: 'right', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 220, y: 180, button: 'right', clickCount: 1 });
  ok('右键退出模板拾取并清理状态', await until(() => ex('!AD.Picker.isOpen()')));
  await ex('AD.Picker.open();void 0');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  ok('模板拾取也支持 Esc 退出', await until(() => ex('!AD.Picker.isOpen()')));
  await page.eval('window.nextClicks=0;const box=document.createElement("div");box.style="position:fixed;left:80px;top:300px";box.innerHTML="<button class=navbtn>上一题</button><button class=navbtn id=pick-next-button>下一题</button>";document.body.append(box);box.lastElementChild.onclick=()=>nextClicks++');
  await ex('AD.Picker.open({element:document.querySelector("#question")});void 0');
  await ex('document.querySelector("#dati-template-picker").shadowRoot.querySelector("[data-act=pick-next]").click()');
  const nextRect = await page.eval('(()=>{const r=document.querySelector("#pick-next-button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, ...nextRect, button: 'left', clickCount: 1 });
  ok('模板中可点选下一页按钮，选择过程不触发页面按钮', await until(() => ex('(()=>{const s=document.querySelector("#dati-template-picker").shadowRoot;const selector=s.querySelector("[data-role=nextPage]").value;return !!selector && document.querySelectorAll(selector).length===1 && document.querySelector(selector).id==="pick-next-button" && s.querySelector(".card").classList.contains("show")})()')) && await page.eval('nextClicks===0'));
  await ex('document.querySelector("#dati-template-picker").shadowRoot.querySelector("[data-act=save]").click()');
  await until(() => ex('!AD.Picker.isOpen()'));
  ok('点选的按钮配置随题目模板保存到规则', await ex('AD.Settings.snapshot().detect.customRules.some(r=>r.nextPageSelector==="#pick-next-button" && r.nextPageEnabled===true)'));
} finally {
  for (const c of clients) c.close();
  browser.kill(); server.close();
}
console.log('\n交互与数据测试：' + count + ' 通过');
process.exit(0);
