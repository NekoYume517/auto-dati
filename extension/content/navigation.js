/** Global next-question/page adapter. Only inspects configured questions and visible controls. */
(function (AD) {
  'use strict';
  if (AD.Navigation && AD.Navigation.version >= 3) return;
  let notificationTimer = 0, retryTimer = 0, lastNotified = '', removeHighlight = null;

  function normalizedLabel(value) {
    return String(value || '').normalize('NFKC').replace(/[\u200b-\u200f\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  }

  function highlight(button) {
    if (removeHighlight) removeHighlight();
    const r = button.getBoundingClientRect();
    const host = document.createElement('div');
    host.id = 'dati-navigation-highlight';
    host.setAttribute('data-dati-ignore', '1');
    host.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;pointer-events:none;z-index:2147483646;';
    const shadow = host.attachShadow({ mode: 'open' });
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;box-sizing:border-box;pointer-events:none;border:3px solid #f59e0b;border-radius:7px;background:rgba(245,158,11,.16);box-shadow:0 0 0 4px rgba(245,158,11,.16);left:' + (r.left - 4) + 'px;top:' + (r.top - 4) + 'px;width:' + (r.width + 8) + 'px;height:' + (r.height + 8) + 'px;';
    const label = document.createElement('span');
    label.textContent = '自动翻页 · ' + normalizedLabel(button.getAttribute('aria-label') || button.textContent || '点击这里');
    label.style.cssText = 'position:absolute;right:-3px;' + (r.top > 32 ? 'bottom:calc(100% + 5px);' : 'top:calc(100% + 5px);') + 'padding:4px 8px;white-space:nowrap;border-radius:5px;background:#f59e0b;color:#1c1917;font:600 12px/1.5 system-ui,"Microsoft YaHei",sans-serif;';
    box.append(label); shadow.append(box); document.documentElement.append(host);
    if (typeof host.showPopover === 'function') {
      try { host.setAttribute('popover', 'manual'); host.showPopover(); } catch (e) { host.removeAttribute('popover'); }
    }
    const remove = function () { host.remove(); if (removeHighlight === remove) removeHighlight = null; };
    removeHighlight = remove;
    setTimeout(remove, 1800);
    return remove;
  }

  function ruleFor(id) {
    const settings = AD.Settings.snapshot();
    return id.startsWith('custom:') ? (settings.detect.customRules || []).find(function (r) {
      return 'custom:' + (r.id || r.name || 'rule') === id && r.enabled !== false;
    }) : settings.detect.sitePresets[id] !== false && (settings.detect.siteRules || {})[id];
  }

  function navigationFor(questions) {
    const configs = [];
    questions.forEach(function (q) {
      const id = q.presetId || '';
      const rule = ruleFor(id);
      if (!rule || rule.nextPageEnabled === false || !String(rule.nextPageSelector || '').trim()) return;
      const selector = String(rule.nextPageSelector).trim();
      if (!configs.some(function (c) { return c.selector === selector; })) configs.push({ ruleId: id, selector: selector });
    });
    return configs;
  }

  function nextControl(configs) {
    if (!configs || !configs.length) return null;
    let candidates;
    try {
      candidates = [];
      const scopes = [document];
      for (let i = 0; i < scopes.length; i++) {
        configs.forEach(function (config) {
          candidates.push.apply(candidates, AD.PresetKit.all(scopes[i], config.selector));
        });
        AD.PresetKit.all(scopes[i], '*').forEach(function (el) { const root = AD.PresetKit.shadowRootOf(el); if (root) scopes.push(root); });
      }
    } catch (e) { return null; }
    return candidates.find(function (el) {
      if (AD.PresetKit.isIgnored(el) || !AD.Detector.isVisible(el, { viewportOnly: false })) return false;
      const labels = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('value'), el.textContent]
        .filter(Boolean).map(normalizedLabel);
      if (labels.some(function (text) { return /提交|交卷|结束考试|完成考试|submit|finish\s*(exam|test)?/i.test(text); })) return false;
      if (labels.some(function (text) { return /^(上一题|上一页|上一个|上一步|previous|prev|back)(\s*[<‹«←])?$/i.test(text.replace(/\s+/g, '')); })) return false;
      return true;
    }) || null;
  }

  function inspect(inheritedNavigation) {
    const questions = AD.Detector.scan(document, { viewportOnly: false, skipAnswered: false, maxPerPage: 0 });
    const navigation = questions.length ? navigationFor(questions) : (inheritedNavigation || []).filter(function (config) {
      const rule = ruleFor(config.ruleId || '');
      return rule && rule.nextPageEnabled !== false && String(rule.nextPageSelector || '').trim() === config.selector;
    });
    const button = nextControl(navigation);
    return {
      questions: questions.map(function (q) { return { id: q.id, answered: !!q.answered }; }),
      fingerprint: questions.length ? AD.hash(location.href + questions.map(function (q) {
        return q.id + ':' + AD.PresetKit.txt(q.root);
      }).join('|')) : '',
      hasNext: !!button,
      navigation: navigation,
      nextLabel: button ? normalizedLabel(button.getAttribute('aria-label') || button.textContent || button.getAttribute('value')) : '',
      nextDisabled: !!(button && (button.disabled || button.closest('[disabled],[aria-disabled="true"],.is-disabled,.disabled')))
    };
  }

  async function clickIfCurrent(expected, inheritedNavigation) {
    const settings = AD.Settings.snapshot();
    if (settings.enabled === false || !settings.mode.autoNextPage) return { ok: false, reason: '已关闭自动翻页' };
    const current = inspect(inheritedNavigation);
    if (current.fingerprint !== expected || current.questions.some(function (q) { return !q.answered; })) {
      return { ok: false, reason: '题目已变化或尚未填入完成' };
    }
    const button = nextControl(current.navigation);
    if (!button || current.nextDisabled) return { ok: false, reason: button ? '下一页按钮不可用' : '未找到下一页按钮' };
    if (settings.mode.highlightNextPage) {
      const r = button.getBoundingClientRect();
      if (r.bottom > innerHeight || r.top < 0 || r.right > innerWidth || r.left < 0) button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      highlight(button);
      await AD.sleep(400);
      const latest = AD.Settings.snapshot();
      const latestPage = inspect(inheritedNavigation);
      if (latest.enabled === false || !latest.mode.autoNextPage || !button.isConnected || nextControl(latestPage.navigation) !== button || latestPage.nextDisabled || latestPage.fingerprint !== expected || latestPage.questions.some(function (q) { return !q.answered; })) {
        if (removeHighlight) removeHighlight();
        return { ok: false, reason: '翻页已取消或题目已变化' };
      }
    }
    button.click();
    return { ok: true };
  }

  // 包括先填答案再开启、Vue 异步更新选中标记、页面脚本早于扩展更新等情况。
  function schedule() {
    if (!AD.Settings.snapshot().mode.autoNextPage || AD.Settings.snapshot().enabled === false) return;
    clearTimeout(notificationTimer);
    notificationTimer = setTimeout(notifyIfReady, 180);
  }
  async function notifyIfReady() {
    const settings = AD.Settings.snapshot();
    if (!settings.mode.autoNextPage || settings.enabled === false) return;
    const page = inspect();
    if (!page.questions.length || page.questions.some(function (q) { return !q.answered; })) return;
    const key = page.fingerprint + ':' + page.hasNext + ':' + page.nextDisabled + ':' + JSON.stringify(page.navigation);
    if (key === lastNotified) return;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'DATI_NAV_FILLED', qid: page.questions[0].id });
      if (result && result.ok && result.accepted !== false) lastNotified = key;
      else { clearTimeout(retryTimer); retryTimer = setTimeout(schedule, 500); }
    } catch (e) { /* 扩展重载后由新页面脚本接管 */ }
  }
  document.addEventListener('input', schedule, true);
  document.addEventListener('change', schedule, true);
  document.addEventListener('click', schedule, true);
  const observer = new MutationObserver(function (changes) {
    if (!AD.Settings.snapshot().mode.autoNextPage) return;
    if (changes.some(function (change) {
      const target = change.target.nodeType === 1 ? change.target : change.target.parentElement;
      if (!target || AD.PresetKit.isIgnored(target)) return false;
      const nodes = Array.from(change.addedNodes).concat(Array.from(change.removedNodes));
      return !nodes.length || !nodes.every(function (n) { return n.nodeType === 1 && AD.PresetKit.isIgnored(n); });
    })) schedule();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['class', 'checked', 'aria-checked', 'aria-selected', 'disabled', 'style'] });
  let configKey = '';
  function onSettings(settings) {
    const key = settings.enabled + ':' + settings.mode.autoNextPage + ':' + JSON.stringify(settings.detect);
    if (key !== configKey) { lastNotified = ''; configKey = key; }
    if (!settings.mode.highlightNextPage && removeHighlight) removeHighlight();
    if (!settings.mode.autoNextPage || settings.enabled === false) {
      clearTimeout(notificationTimer); clearTimeout(retryTimer);
      if (removeHighlight) removeHighlight();
      return;
    }
    schedule();
  }
  AD.Settings.subscribe(onSettings);
  AD.Settings.get().then(onSettings);
  AD.Navigation = { version: 3, inspect: inspect, clickIfCurrent: clickIfCurrent, check: schedule };
}(globalThis.AD = globalThis.AD || {}));
