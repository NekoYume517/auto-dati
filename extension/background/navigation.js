/** One tab-wide next-page controller, shared by every frame. */
(function (AD) {
  'use strict';
  const runs = new Map();
  function enabled() {
    const s = AD.Settings.snapshot();
    return s.enabled !== false && !!s.mode.autoNextPage;
  }
  async function inspect(tabId) {
    const frames = await chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: true },
      func: function () { return globalThis.AD && AD.Navigation ? AD.Navigation.inspect() : null; } });
    const configs = frames.filter(function (f) { return f.result; }).flatMap(function (f) { return f.result.navigation || []; });
    if (!configs.length) return frames.filter(function (f) { return f.result; });
    const resolved = await chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: true },
      func: function (navigation) { return globalThis.AD && AD.Navigation ? AD.Navigation.inspect(navigation) : null; }, args: [configs] });
    return resolved.filter(function (f) { return f.result; });
  }
  function signature(frames) {
    return frames.filter(function (f) { return f.result.questions.length; }).sort(function (a, b) { return a.frameId - b.frameId; })
      .map(function (f) { return f.documentId + ':' + f.result.fingerprint; }).join('|');
  }
  function stop(run, reason) { run.phase = 'stopped'; run.reason = reason; run.busy = false; }

  async function advance(tabId, run) {
    run.timer = 0;
    run.busy = true;
    try {
      if (!enabled()) return stop(run, '已关闭自动翻页');
      const frames = await inspect(tabId);
      if (runs.get(tabId) !== run) return;
      if (!enabled()) return stop(run, '已关闭自动翻页');
      const source = frames.find(function (f) { return f.documentId === run.documentId; });
      if (!source || !source.result.questions.some(function (q) { return q.id === run.qid; })) return stop(run, '题目已切换');
      const questions = frames.flatMap(function (f) { return f.result.questions; });
      if (!questions.length || questions.some(function (q) { return !q.answered; })) {
        run.phase = 'waiting-answers'; run.busy = false; return;
      }
      const before = signature(frames);
      if (run.lastClicked === before) return stop(run, '当前题目尚未翻页');
      // 优先当前题目文档，再查顶层或其他有题目的文档，支持按钮位于 iframe 外的页面。
      const target = [source].concat(frames.filter(function (f) { return f !== source && (f.frameId === 0 || f.result.questions.length); }))
        .find(function (f) { return f.result.hasNext; });
      if (!target) return stop(run, '未找到下一题或下一页按钮');
      if (target.result.nextDisabled) return stop(run, '下一页按钮不可用');
      if (!enabled() || runs.get(tabId) !== run) return;
      const clicked = await chrome.scripting.executeScript({ target: { tabId: tabId, documentIds: [target.documentId] },
        func: function (expected, navigation) { return AD.Navigation.clickIfCurrent(expected, navigation); }, args: [target.result.fingerprint, target.result.navigation] });
      if (!clicked[0] || !clicked[0].result || !clicked[0].result.ok) return stop(run, clicked[0]?.result?.reason || '翻页失败');
      run.lastClicked = before;
      run.phase = 'waiting-page';
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await AD.sleep(350);
        if (runs.get(tabId) !== run) return;
        if (!enabled()) return stop(run, '已关闭自动翻页');
        const next = await inspect(tabId);
        if (runs.get(tabId) !== run) return;
        const after = signature(next);
        if (after && after !== before) {
          run.phase = 'idle'; run.busy = false;
          // 仍走稳定题干与去重逻辑，不把加载中的空占位当成新题。
          chrome.tabs.sendMessage(tabId, { type: 'AD_CMD', cmd: 'auto-next-scan' }).catch(function () {});
          return;
        }
      }
      stop(run, '等待新题超时，已停止翻页');
    } catch (e) { stop(run, '页面已跳转或无法继续翻页'); }
  }

  function afterFill(tabId, documentId, qid) {
    if (!enabled()) return false;
    let run = runs.get(tabId);
    if (!run) { run = { timer: 0, busy: false, phase: 'idle' }; runs.set(tabId, run); }
    if (run.busy || run.timer) return false;
    run.documentId = documentId;
    run.qid = qid;
    run.phase = 'scheduled';
    const delay = Math.max(300, Math.min(10000, Number(AD.Settings.snapshot().mode.nextPageDelayMs) || 800));
    run.timer = setTimeout(function () { advance(tabId, run); }, delay);
    return true;
  }

  AD.Settings.subscribe(function () {
    if (enabled()) return;
    runs.forEach(function (run) {
      clearTimeout(run.timer); run.timer = 0; stop(run, '已关闭自动翻页');
    });
    runs.clear();
  });
  chrome.tabs.onRemoved.addListener(function (tabId) { const run = runs.get(tabId); if (run) clearTimeout(run.timer); runs.delete(tabId); });
  AD.AutoNavigation = { afterFill: afterFill };
}(globalThis.AD = globalThis.AD || {}));
