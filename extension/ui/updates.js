/** Shared UI for release checks in settings and the toolbar popup. */
(function (AD) {
  'use strict';
  const hasRuntime = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  function render(state) {
    document.querySelectorAll('[data-update-status]').forEach(function (node) {
      node.textContent = state.error || (state.available ? '发现新版本 v' + state.latest : state.checkedAt ? '当前已是最新版本 v' + state.current : '当前版本 v' + state.current + '，尚未检查更新');
    });
    document.querySelectorAll('[data-update-open]').forEach(function (node) {
      node.textContent = state.available ? '前往 Releases 更新 ↗' : 'GitHub Releases ↗';
    });
    document.querySelectorAll('[data-update-time]').forEach(function (node) {
      node.textContent = state.checkedAt ? '上次成功检查：' + new Date(state.checkedAt).toLocaleString() : '自动检查每 6 小时进行一次，仅获取公开版本信息。';
    });
  }
  async function request(type, extra) {
    if (!hasRuntime) return { ok: true, state: { current: '本地预览', checkedAt: 0 } };
    const result = await chrome.runtime.sendMessage(Object.assign({ type: type }, extra));
    if (!result || !result.ok) throw new Error((result && result.error) || '无法连接更新服务');
    return result;
  }
  document.querySelectorAll('[data-update-check]').forEach(function (button) {
    button.addEventListener('click', async function () {
      button.disabled = true;
      document.querySelectorAll('[data-update-status]').forEach(function (node) { node.textContent = '正在检查 GitHub Releases…'; });
      try { render((await request('DATI_CHECK_UPDATE')).state); }
      catch (e) { document.querySelectorAll('[data-update-status]').forEach(function (node) { node.textContent = e.message; }); }
      finally { button.disabled = false; }
    });
  });
  document.querySelectorAll('[data-update-open]').forEach(function (button) {
    button.addEventListener('click', function () { request('DATI_OPEN_RELEASE').catch(function () {}); });
  });
  request('DATI_UPDATE_STATUS').then(function (result) { render(result.state); }).catch(function () {});
  if (hasRuntime) chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes.dati_release_update) request('DATI_UPDATE_STATUS').then(function (result) { render(result.state); }).catch(function () {});
  });
}(globalThis.AD = globalThis.AD || {}));
