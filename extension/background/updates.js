/** Checks release metadata; never downloads or executes extension code. */
(function (AD) {
  'use strict';
  const KEY = 'dati_release_update', ALARM = 'dati_release_check', INTERVAL = 6 * 60 * 60 * 1000;
  let pending = null;
  function base() {
    return { current: chrome.runtime.getManifest().version, latest: '', available: false,
      releaseUrl: AD.Release.latest, checkedAt: 0, lastAttemptAt: 0, error: '' };
  }
  async function status() {
    const stored = (await chrome.storage.local.get(KEY))[KEY] || {};
    const state = Object.assign(base(), stored, { current: chrome.runtime.getManifest().version });
    state.available = !!(AD.Release.version(state.latest) && AD.Release.compare(state.latest, state.current) > 0);
    if (!String(state.releaseUrl).startsWith(AD.Release.home + '/releases/')) state.releaseUrl = AD.Release.latest;
    return state;
  }
  async function check(force) {
    if (pending) return pending;
    pending = (async function () {
      const previous = await status();
      const now = Date.now();
      // Manual checks share a short cooldown, automatic checks use a six-hour cache.
      if (previous.lastAttemptAt && now - previous.lastAttemptAt < (force ? 60000 : INTERVAL)) return previous;
      const next = Object.assign({}, previous, { lastAttemptAt: now, error: '' });
      const abort = new AbortController(), timeout = setTimeout(function () { abort.abort(); }, 12000);
      try {
        const response = await fetch(AD.Release.api, { headers: { Accept: 'application/vnd.github+json' },
          credentials: 'omit', cache: 'no-store', signal: abort.signal });
        if (response.status === 404) throw new Error('仓库尚未发布正式版本，请稍后重试');
        if (response.status === 403 || response.status === 429) throw new Error('GitHub 请求受限，请稍后重试');
        if (!response.ok) throw new Error('GitHub 返回 HTTP ' + response.status);
        const release = await response.json();
        if (release.draft || release.prerelease || !AD.Release.version(release.tag_name)) throw new Error('未找到有效的正式版本');
        if (typeof release.html_url !== 'string' || !release.html_url.startsWith(AD.Release.home + '/releases/tag/')) throw new Error('发布地址无效');
        next.latest = release.tag_name.replace(/^v/, '');
        next.releaseUrl = release.html_url;
        next.checkedAt = Date.now();
        next.available = AD.Release.compare(next.latest, next.current) > 0;
      } catch (e) {
        next.error = e.name === 'AbortError' ? '连接 GitHub 超时，请检查网络后重试' : (e.message || '检查更新失败');
      } finally { clearTimeout(timeout); }
      await chrome.storage.local.set({ [KEY]: next });
      return next;
    }());
    try { return await pending; } finally { pending = null; }
  }
  async function automatic() {
    const settings = await AD.Settings.get();
    if (!settings.updates || settings.updates.autoCheck !== false) await check(false);
  }
  chrome.alarms.onAlarm.addListener(function (alarm) { if (alarm.name === ALARM) automatic().catch(function () {}); });
  chrome.alarms.create(ALARM, { periodInMinutes: 360 });
  automatic().catch(function () {});
  AD.Updates = { status: status, check: check };
}(globalThis.AD = globalThis.AD || {}));
