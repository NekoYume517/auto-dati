/**
 * AutoDati · 覆盖层（Shadow DOM）
 * 负责流式答题面板、轻提示、悬停角标。
 */
(function (AD) {
  'use strict';

  const HOST_ID = 'dati-overlay-host';
  const Z = 2147483000;

  const sessions = new Map();  // id -> session
  let host = null;
  let root = null;
  let layer = null;
  let cssReady = null;
  let cssText = AD.OVERLAY_CSS || '';
  let toastEl = null;
  let hintEl = null;
  let rafPending = new Map();
  let lifecycleObserver = null;
  let initialized = false;
  let contentChanged = false;
  let detectionBoxes = new Map();

  // Toasts can be the first UI shown, before init or the stylesheet fetch resolves.
  // Keep their essential appearance synchronous and independent of the page CSS.
  const FALLBACK_CSS = [
    ':host{all:initial}*{box-sizing:border-box}',
    '.dati-toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,10px);',
    'max-width:calc(100vw - 32px);padding:10px 16px;border-radius:12px;',
    'font:500 13px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#f0f2f4;',
    'background:#202327;border:1px solid #49505a;box-shadow:0 8px 28px #0004;',
    'opacity:0;pointer-events:none;z-index:2;white-space:normal;overflow-wrap:anywhere;',
    'transition:opacity 180ms ease,transform 180ms cubic-bezier(.23,1,.32,1)}',
    '.dati-toast.is-show{opacity:1;transform:translate(-50%,0)}',
    '.dati-toast[data-theme="light"]{background:#fff;color:#20242d;border-color:#d8dde5}',
    '.dati-toast--success,.dati-toast--ok{border-color:#45a48a}',
    '.dati-toast--warn{border-color:#bf9641}.dati-toast--danger{border-color:#cf7070}',
    '.dati-toast[data-noanim="1"]{transition:none}',
    '@media(prefers-reduced-motion:reduce){.dati-toast{transition:none}}'
  ].join('');

  function ensureHost() {
    if (host && document.documentElement.contains(host)) return host;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-dati-ignore', '1');
    host.style.cssText = 'position:fixed;inset:0 auto auto 0;width:0;height:0;margin:0;padding:0;border:0;overflow:visible;background:transparent;z-index:' + Z + ';pointer-events:none;';
    root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = cssText || FALLBACK_CSS;
    root.appendChild(style);
    // A local stylesheet link is a second loading path if a fetch is denied or
    // interrupted. Critical Toast styling above remains available immediately.
    if (!cssText && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = chrome.runtime.getURL('content/overlay.css');
      root.appendChild(link);
    }

    layer = document.createElement('div');
    layer.className = 'dati-layer';
    root.appendChild(layer);

    const appendTarget = document.documentElement;
    appendTarget.appendChild(host);
    // 顶层承载，避免被宿主页的 transform、overflow 或弹出层裁切。
    if (typeof host.showPopover === 'function') {
      try { host.setAttribute('popover', 'manual'); host.showPopover(); }
      catch (e) { host.removeAttribute('popover'); }
    }

    // 异步补全完整样式（通常早已就绪）
    prefetchCSS().then(function (css) {
      if (!css) return;
      style.textContent = css;
      cssText = css;
    });
    return host;
  }

  function prefetchCSS() {
    if (cssText) return Promise.resolve(cssText);
    if (cssReady) return cssReady;
    cssReady = new Promise(function (resolve) {
      try {
        const url = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
          ? chrome.runtime.getURL('content/overlay.css') : '';
        if (!url || typeof fetch !== 'function') return resolve('');
        fetch(url).then(function (r) { return r.text(); })
          .then(function (t) { cssText = t || ''; resolve(cssText); })
          .catch(function () { resolve(''); });
      } catch (e) { resolve(''); }
    });
    return cssReady;
  }

  /* ------------------------------ 工具 ------------------------------ */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** 轻量 Markdown → HTML（全部转义后再拼接，杜绝注入） */
  function renderMarkdown(src) {
    const codes = [];
    let text = String(src || '');
    text = text.replace(/```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/g, function (m, lang, code) {
      codes.push({ lang: lang || '', code: code.replace(/\s+$/, '') });
      return '\u0000C' + (codes.length - 1) + '\u0000';
    });

    const lines = text.split(/\r?\n/);
    const out = [];
    let listType = null;
    let para = [];

    function flushPara() {
      if (!para.length) return;
      out.push('<p>' + inline(para.join(' ')) + '</p>');
      para = [];
    }
    function closeList() {
      if (listType) { out.push('</' + listType + '>'); listType = null; }
    }
    function inline(s) {
      let t = esc(s);
      t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,，。]|$)/g, '$1<em>$2</em>');
      t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
      // 答案行高亮
      t = t.replace(/(正确答案|答案|答)\s*[:：]/g, '<span class="dati-md-ans">$1：</span>');
      // 独立选项字母高亮
      t = t.replace(/(^|[\s（(])([A-H])(?=[\s,，。、)）]|$)/g, '$1<span class="dati-md-opt">$2</span>');
      return t;
    }

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();
      const codeToken = /^\u0000C(\d+)\u0000$/.exec(line);

      if (codeToken) {
        flushPara(); closeList();
        const c = codes[Number(codeToken[1])];
        out.push('<pre><code>' + esc(c.code) + '</code></pre>');
        continue;
      }
      if (!line) { flushPara(); closeList(); continue; }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { flushPara(); closeList(); out.push('<hr>'); continue; }

      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) { flushPara(); closeList(); out.push('<h' + (h[1].length + 2) + '>' + inline(h[2]) + '</h' + (h[1].length + 2) + '>'); continue; }

      const ul = /^[-*•·]\s+(.*)$/.exec(line);
      if (ul) {
        flushPara();
        if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
        out.push('<li>' + inline(ul[1]) + '</li>');
        continue;
      }
      const ol = /^(\d{1,2})[.)、]\s+(.*)$/.exec(line);
      if (ol) {
        flushPara();
        if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
        out.push('<li>' + inline(ol[2]) + '</li>');
        continue;
      }
      const q = /^>\s?(.*)$/.exec(line);
      if (q) { flushPara(); closeList(); out.push('<blockquote>' + inline(q[1]) + '</blockquote>'); continue; }

      para.push(line);
    }
    flushPara(); closeList();
    return out.join('');
  }

  function getAccent(settings) {
    return (settings && settings.ui && settings.ui.accent) || '#6366f1';
  }

  function applyTheme(node, settings) {
    const ui = (settings && settings.ui) || {};
    node.setAttribute('data-theme', ui.theme || 'dark');
    node.style.setProperty('--dati-accent', getAccent(settings));
    node.style.setProperty('--dati-accent-2', getAccent(settings));
    node.style.setProperty('--dati-accent-soft', 'color-mix(in srgb, ' + getAccent(settings) + ' 14%, transparent)');
    node.style.setProperty('--dati-font-size', (ui.fontSize || 13) + 'px');
    node.style.setProperty('--dati-radius', (ui.radius || 14) + 'px');
    node.toggleAttribute('data-noblur', ui.blur === false);
    node.toggleAttribute('data-noanim', ui.animate === false);
  }

  /* ------------------------------ 定位 ------------------------------ */

  function viewport() {
    return { w: document.documentElement.clientWidth || window.innerWidth, h: window.innerHeight };
  }

  function panelSize(panel) {
    const w = panel.offsetWidth || 384;
    const h = panel.offsetHeight || 220;
    return { w: w, h: h };
  }

  /** 与已打开面板是否重叠 */
  function overlaps(a, b, pad) {
    pad = pad || 6;
    return !(a.left + a.width + pad <= b.left ||
      b.left + b.width + pad <= a.left ||
      a.top + a.height + pad <= b.top ||
      b.top + b.height + pad <= a.top);
  }

  /** 收集其它已打开面板的矩形 */
  function siblingRects(selfId) {
    const out = [];
    sessions.forEach(function (s) {
      if (s.id === selfId || s.closed || s.suspended || !s.panel) return;
      const r = s.panel.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push(r);
    });
    return out;
  }

  function placePanel(session) {
    const panel = session.panel;
    const vp = viewport();
    panel.style.maxWidth = Math.max(240, vp.w - 24) + 'px';
    const size = panelSize(panel);
    const settings = AD.Settings.snapshot();
    const pref = (settings.ui && settings.ui.panelPosition) || 'auto';
    const margin = 10;

    if (session.dragged) {
      panel.style.left = session.dragX + 'px';
      panel.style.top = session.dragY + 'px';
      return;
    }

    let anchor = session.rect;
    const target = session.question && (session.question.root || session.question.anchor);
    if (target && target.isConnected) {
      const rect = target.getBoundingClientRect();
      anchor = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
      session.rect = anchor;
    }
    if (!anchor || anchor.w < 1) {
      anchor = { x: vp.w - size.w - 24, y: 72, w: 0, h: 0 };
      panel.style.left = Math.max(margin, vp.w - size.w - 24) + 'px';
      panel.style.top = '72px';
      return;
    }

    let top, left;
    const below = anchor.y + anchor.h + 8;
    const above = anchor.y - size.h - 8;
    const canBelow = below + size.h <= vp.h - margin;
    const canAbove = above >= margin;

    if (pref === 'auto' || pref === 'dock') top = anchor.y;
    else if (pref === 'below') top = canBelow ? below : Math.max(margin, vp.h - size.h - margin);
    else if (pref === 'above') top = canAbove ? above : Math.min(below, vp.h - size.h - margin);
    else top = canBelow ? below : (canAbove ? above : Math.max(margin, vp.h - size.h - margin));

    left = (pref === 'auto' || pref === 'dock') ? vp.w - size.w - 16 : anchor.x + Math.min(anchor.w, 40) - 8;
    left = AD.clamp(left, margin, Math.max(margin, vp.w - size.w - margin));
    top = AD.clamp(top, margin, Math.max(margin, vp.h - Math.min(size.h, vp.h - margin * 2) - margin));

    // 避让：与其它面板重叠时，向下（再向左）寻找空位
    const others = siblingRects(session.id);
    if (others.length) {
      const stepY = Math.min(56, size.h * 0.34);
      let tries = 0;
      let cand = { left: left, top: top, width: size.w, height: size.h };
      while (tries < 14 && others.some(function (r) { return overlaps(cand, r); })) {
        tries++;
        let ny = top + stepY * tries;
        if (ny + size.h > vp.h - margin) {
          // 换到左侧再试
          const nx = left - size.w - 14;
          if (nx >= margin) { cand = { left: nx, top: top, width: size.w, height: size.h }; }
          else { ny = top - stepY * tries; }
        }
        cand = { left: cand.left, top: AD.clamp(ny, margin, Math.max(margin, vp.h - Math.min(size.h, vp.h - 2 * margin) - margin)), width: size.w, height: size.h };
      }
      left = cand.left;
      top = cand.top;
    }

    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
  }

  function repositionAll() {
    if (hintEl && hintEl.classList.contains('is-show') && hintEl._datiTarget) {
      const target = hintEl._datiTarget;
      if (!target.isConnected || !visibleInScrollport(target) || contentChanged) Overlay.hideHint();
    }
    sessions.forEach(function (s) {
      if (!s.panel || s.closed) return;
      const target = s.question && (s.question.root || s.question.anchor);
      if (target) {
        if (!target.isConnected) {
          Overlay.close(s.id, { reason: 'question-gone' });
          return;
        }
        if (contentChanged && AD.Detector && AD.Detector.buildFromElement && AD.Detector.isVisible(target, { viewportOnly: false })) {
          const fresh = AD.Detector.buildFromElement(target);
          if ((!fresh && target.matches('.examPaper_subject')) ||
              (fresh && fresh.root === target && fresh.id !== s.question.id)) {
            Overlay.close(s.id, { reason: 'question-changed' });
            return;
          }
        }
        const visible = visibleInScrollport(target);
        s.suspended = !visible;
        s.panel.classList.toggle('is-suspended', !visible);
        s.panel.setAttribute('aria-hidden', String(!visible));
        s.panel.inert = !visible;
        if (!visible) return;
      }
      placePanel(s);
    });
    contentChanged = false;
  }

  function visibleInScrollport(target) {
    if (AD.Detector && !AD.Detector.isVisible(target, { viewportOnly: true })) return false;
    const rect = target.getBoundingClientRect();
    let top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom);
    let left = Math.max(0, rect.left), right = Math.min(viewport().w, rect.right);
    let parent = target.parentElement;
    while (parent) {
      const style = getComputedStyle(parent);
      const box = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, box.top + parent.clientTop);
        bottom = Math.min(bottom, box.top + parent.clientTop + parent.clientHeight);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, box.left + parent.clientLeft);
        right = Math.min(right, box.left + parent.clientLeft + parent.clientWidth);
      }
      parent = parent.parentElement || (parent.getRootNode && parent.getRootNode().host);
    }
    return bottom > top && right > left;
  }

  let scrollRaf = 0;
  function onViewportChange() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function () {
      scrollRaf = 0;
      repositionAll();
      detectionBoxes.forEach(function (box) {
        const target = box._datiTarget;
        if (!target || !target.isConnected) { box.style.display = 'none'; return; }
        const rect = target.getBoundingClientRect();
        box.style.left = Math.round(rect.left) + 'px';
        box.style.top = Math.round(rect.top) + 'px';
        box.style.width = Math.round(rect.width) + 'px';
        box.style.height = Math.round(rect.height) + 'px';
        box.style.display = rect.width && rect.height && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth ? '' : 'none';
      });
    });
  }

  function watchQuestions() {
    if (lifecycleObserver || typeof MutationObserver === 'undefined') return;
    lifecycleObserver = new MutationObserver(function (changes) {
      if (!changes.some(function (change) {
        if (change.type === 'childList' && AD.Detector) {
          const nodes = Array.from(change.addedNodes).concat(Array.from(change.removedNodes));
          if (nodes.length && nodes.every(function (node) { return node.nodeType === 1 && AD.Detector.isIgnoredNode(node); })) return false;
        }
        const target = change.target.nodeType === 1 ? change.target : change.target.parentElement;
        return target && !(AD.Detector && AD.Detector.isIgnoredNode(target));
      })) return;
      contentChanged = true;
      onViewportChange();
    });
    lifecycleObserver.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'] });
  }

  /* ------------------------------ 面板 ------------------------------ */

  function renderOptions(session) {
    if (!session.optionsEl) return;
    const options = (session.question && session.question.options) || [];
    session.optionsEl.replaceChildren();
    session.optionRows = [];
    session.optionsEl.hidden = options.length === 0;
    if (!options.length) return;
    session.optionsEl.appendChild(el('div', 'dati-question-options__title', '选项 · ' + options.length));
    const list = el('ul', 'dati-question-options__list');
    options.forEach(function (option, index) {
      const label = String(option.label || (AD.PresetKit && AD.PresetKit.letterFromIndex(index)) || (index + 1));
      const row = el('li', 'dati-question-option');
      row.appendChild(el('span', 'dati-question-option__label', label + '.'));
      row.appendChild(el('span', 'dati-question-option__text', option.text || '（未识别到选项正文）'));
      list.appendChild(row);
      session.optionRows.push({ el: row, label: label, text: option.text || '' });
    });
    session.optionsEl.appendChild(list);
  }

  function buildPanel(session) {
    const settings = AD.Settings.snapshot();
    const q = session.question || {};
    const kindLabel = AD.KIND_LABEL[q.kind] || '题目';

    const panel = el('div', 'dati-panel');
    panel.setAttribute('data-dati-ignore', '1');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'AutoDati 答题面板');
    applyTheme(panel, settings);
    if (q.answered) panel.setAttribute('data-answered', '1');
    panel.style.width = Math.max(280, Math.min(720, (settings.ui && settings.ui.panelWidth) || 384)) + 'px';
    panel.style.transformOrigin = 'top left';
    if (session.source === 'hotkey') panel.setAttribute('data-instant', '1');

    /* 头部 */
    const head = el('div', 'dati-panel__head');
    const titleWrap = el('div', 'dati-panel__titlewrap');
    const identity = el('span', 'dati-panel__mark');
    identity.setAttribute('aria-hidden', 'true');
    identity.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6h10M5 11h7M5 16h4m5-1 3 3 5-7"/></svg>';
    const identityText = el('div', 'dati-panel__identity');
    identityText.appendChild(el('strong', '', 'AutoDati'));
    identityText.appendChild(el('span', '', '题目助手'));
    titleWrap.appendChild(identity);
    titleWrap.appendChild(identityText);
    const meta = el('div', 'dati-panel__meta');
    const badge = el('span', 'dati-badge', kindLabel);
    const modelChip = el('span', 'dati-chip dati-chip--model', session.model || '…');
    meta.appendChild(badge);
    meta.appendChild(modelChip);
    if (q.answered) {
      const answeredChip = el('span', 'dati-chip dati-chip--answered', '已作答');
      meta.appendChild(answeredChip);
    }

    const actions = el('div', 'dati-panel__actions');
    const btnMin = el('button', 'dati-btn dati-btn--icon');
    btnMin.type = 'button';
    btnMin.title = '收起 / 展开';
    btnMin.setAttribute('data-act', 'min');
    btnMin.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 6.5h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>';
    const btnClose = el('button', 'dati-btn dati-btn--icon');
    btnClose.type = 'button';
    btnClose.title = '关闭 (Esc)';
    btnClose.setAttribute('data-act', 'close');
    btnClose.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>';
    actions.appendChild(btnMin);
    actions.appendChild(btnClose);

    head.appendChild(titleWrap);
    head.appendChild(actions);

    /* 主体 */
    const body = el('div', 'dati-panel__body dati-scroll');
    body.appendChild(meta);
    const stem = el('div', 'dati-panel__stem');
    stem.textContent = q.stem || '（无题干文本）';
    if ((q.stem || '').length > 140) stem.classList.add('is-clip');
    body.appendChild(stem);
    session.optionsEl = el('div', 'dati-question-options');
    body.appendChild(session.optionsEl);
    renderOptions(session);

    let shotBox = null;
    if (session.screenshot) {
      shotBox = el('div', 'dati-panel__shot');
      const img = document.createElement('img');
      img.src = session.screenshot;
      img.alt = '题目截图';
      const tag = el('span', 'dati-panel__shot-tag', '截图');
      shotBox.appendChild(img);
      shotBox.appendChild(tag);
      if ((settings.advanced && settings.advanced.showScreenshotThumb) === false) shotBox.style.display = 'none';
      body.appendChild(shotBox);
    }

    const chips = el('div', 'dati-answer-chips');
    chips.style.display = 'none';
    body.appendChild(chips);

    const stream = el('div', 'dati-stream');
    stream.setAttribute('aria-live', 'polite');
    body.appendChild(stream);

    const errBox = el('div', 'dati-panel__err');
    errBox.style.display = 'none';
    body.appendChild(errBox);

    /* 底部 */
    const foot = el('div', 'dati-panel__foot');
    const status = el('div', 'dati-status');
    const spinner = el('span', 'dati-spinner');
    const statusText = el('span', 'dati-status__text', '准备中…');
    status.appendChild(spinner);
    status.appendChild(statusText);

    const btns = el('div', 'dati-panel__btns');
    const mkBtn = function (act, label, cls, title) {
      const b = el('button', 'dati-btn dati-btn--sm ' + (cls || 'dati-btn--ghost'), label);
      b.type = 'button';
      b.setAttribute('data-act', act);
      if (title) b.title = title;
      btns.appendChild(b);
      return b;
    };
    const btnFill = mkBtn('fill', '填入答案', 'dati-btn--primary', '把答案写入页面 (Ctrl+Enter)');
    const btnCopy = mkBtn('copy', '复制', 'dati-btn--ghost');
    const btnRetry = mkBtn('retry', '重试', 'dati-btn--ghost', '重新作答');
    const btnStop = mkBtn('stop', '停止', 'dati-btn--ghost');
    btnFill.disabled = true;
    btnRetry.disabled = true;
    btnStop.style.display = 'none';

    foot.appendChild(status);
    foot.appendChild(btns);

    const resize = el('div', 'dati-resize');
    resize.title = '拖动调整大小';

    panel.appendChild(head);
    panel.appendChild(body);
    panel.appendChild(foot);
    panel.appendChild(resize);

    session.panel = panel;
    session.body = body;
    session.stream = stream;
    session.chips = chips;
    session.errBox = errBox;
    session.statusText = statusText;
    session.spinner = spinner;
    session.modelChip = modelChip;
    session.btnFill = btnFill;
    session.btnCopy = btnCopy;
    session.btnRetry = btnRetry;
    session.btnStop = btnStop;
    session.btnMin = btnMin;
    session.btnClose = btnClose;
    session.shotBox = shotBox;
    session.stemEl = stem;
    session.text = '';
    session.renderedLen = 0;

    /* --- 交互 --- */
    btnClose.addEventListener('click', function (e) {
      e.stopPropagation();
      Overlay.close(session.id);
    });
    btnMin.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.classList.toggle('is-collapsed');
      requestAnimationFrame(function () { placePanel(session); });
    });
    btnCopy.addEventListener('click', function (e) {
      e.stopPropagation();
      const text = session.answerText || session.text || '';
      if (!text) return;
      try {
        navigator.clipboard.writeText(text).then(function () {
          flash(btnCopy, '已复制');
        }).catch(function () { fallbackCopy(text); flash(btnCopy, '已复制'); });
      } catch (err) { fallbackCopy(text); flash(btnCopy, '已复制'); }
    });
    btnFill.addEventListener('click', function (e) {
      e.stopPropagation();
      if (session.onFill) session.onFill(session, session.answerText || session.text || '');
    });
    btnRetry.addEventListener('click', function (e) {
      e.stopPropagation();
      if (session.onRetry) session.onRetry(session);
    });
    btnStop.addEventListener('click', function (e) {
      e.stopPropagation();
      if (session.onStop) session.onStop(session);
    });

    // 题干展开
    stem.addEventListener('click', function () {
      stem.classList.toggle('is-clip');
    });

    // 拖拽
    let dragging = false, startX = 0, startY = 0, baseLeft = 0, baseTop = 0;
    head.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('button')) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const r = panel.getBoundingClientRect();
      baseLeft = r.left; baseTop = r.top;
      try { head.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      panel.classList.add('is-dragging');
      e.preventDefault();
    });
    head.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      const vp = viewport();
      const size = panelSize(panel);
      const nx = AD.clamp(baseLeft + (e.clientX - startX), 4, Math.max(4, vp.w - size.w - 4));
      const ny = AD.clamp(baseTop + (e.clientY - startY), 4, Math.max(4, vp.h - Math.min(size.h, vp.h - 8) - 4));
      session.dragged = true;
      session.dragX = nx;
      session.dragY = ny;
      panel.style.left = nx + 'px';
      panel.style.top = ny + 'px';
    });
    const endDrag = function (e) {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('is-dragging');
      try { head.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
    };
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);

    // 缩放
    let resizing = false, rsX = 0, rsY = 0, rsW = 0, rsH = 0;
    resize.addEventListener('pointerdown', function (e) {
      resizing = true;
      rsX = e.clientX; rsY = e.clientY;
      const r = panel.getBoundingClientRect();
      rsW = r.width; rsH = r.height;
      try { resize.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      e.preventDefault();
      e.stopPropagation();
    });
    resize.addEventListener('pointermove', function (e) {
      if (!resizing) return;
      const w = AD.clamp(rsW + (e.clientX - rsX), 280, Math.min(760, viewport().w - 16));
      panel.style.width = w + 'px';
    });
    const endResize = function (e) {
      if (!resizing) return;
      resizing = false;
      try { resize.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
    };
    resize.addEventListener('pointerup', endResize);
    resize.addEventListener('pointercancel', endResize);

    // 键盘：Ctrl+Enter 填入，Esc 关闭
    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); Overlay.close(session.id); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault(); e.stopPropagation();
        if (!btnFill.disabled) btnFill.click();
      }
    });
    panel.tabIndex = -1;

    return panel;
  }

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    btn.classList.add('is-flash');
    setTimeout(function () {
      btn.textContent = old;
      btn.classList.remove('is-flash');
    }, 1100);
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { /* noop */ }
  }

  /* --------------------------- 渲染调度 --------------------------- */

  function scheduleRender(session) {
    if (rafPending.has(session.id)) return;
    const id = session.id;
    rafPending.set(id, true);
    requestAnimationFrame(function () {
      rafPending.delete(id);
      if (session.closed) return;
      const html = renderMarkdown(session.text);
      session.stream.innerHTML = html;
      // 自动滚到底（用户手动上滚时暂停）
      if (!session.userScrolled) {
        session.body.scrollTop = session.body.scrollHeight;
      }
      session.stream.classList.add('is-streaming');
    });
  }

  function parseChips(session) {
    if (!session.chips || !session.answerText) return;
    let answers = [];
    try {
      if (AD.Filler && AD.Filler.parse) {
        const r = AD.Filler.parse((session.question && session.question.kind) || 'generic', session.answerText, session.question);
        if (r && r.answers && r.answers.length) answers = r.answers;
      }
    } catch (e) { /* noop */ }
    if (!answers.length) return;
    (session.optionRows || []).forEach(function (row) {
      const matched = answers.some(function (answer) {
        return String(answer).toUpperCase() === row.label.toUpperCase() || String(answer) === row.text;
      });
      row.el.classList.toggle('is-answer', matched);
    });
    session.chips.innerHTML = '';
    const label = el('span', 'dati-answer-chips__label', '建议答案');
    session.chips.appendChild(label);
    answers.slice(0, 8).forEach(function (a) {
      const option = (session.optionRows || []).find(function (row) {
        return row.label.toUpperCase() === String(a).toUpperCase();
      });
      const text = option ? option.label + ' · ' + option.text : String(a);
      const chip = el('span', 'dati-answer-chip', text);
      chip.title = text;
      session.chips.appendChild(chip);
    });
    session.chips.style.display = 'flex';
  }

  /* ------------------------------ API ------------------------------ */

  function Overlay() { }

  Overlay.init = function () {
    prefetchCSS();
    if (initialized) return Overlay;
    initialized = true;
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange, true);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      const list = Array.from(sessions.values()).filter(function (s) { return !s.closed; });
      if (!list.length) return;
      Overlay.close(list[list.length - 1].id);
    }, true);
    return Overlay;
  };

  Overlay.show = function (opts) {
    opts = opts || {};
    ensureHost();
    const id = AD.uid('panel');
    const settings = AD.Settings.snapshot();
    const session = {
      id: id,
      question: opts.question || null,
      rect: opts.rect || (opts.question && opts.question.rect) || null,
      source: opts.source || 'detect',
      screenshot: opts.screenshot || null,
      model: opts.model || '',
      pinned: !!opts.pinned,
      createdAt: Date.now(),
      text: '',
      answerText: '',
      closed: false,
      onFill: opts.onFill || null,
      onRetry: opts.onRetry || null,
      onStop: opts.onStop || null,
      onClose: opts.onClose || null
    };

    // 同题复用：同一道题已有面板则直接复用
    const key = opts.question && opts.question.id;
    if (key) {
      const exist = Array.from(sessions.values()).filter(function (s) {
        return !s.closed && s.question && s.question.id === key;
      })[0];
      if (exist) {
        exist.rect = session.rect;
        exist.dragged = false;
        placePanel(exist);
        exist.panel.classList.remove('is-enter');
        void exist.panel.offsetWidth;
        exist.panel.classList.add('is-enter');
        return exist.id;
      }
    }

    const panel = buildPanel(session);
    sessions.set(id, session);
    watchQuestions();
    layer.appendChild(panel);

    session.body.addEventListener('scroll', function () {
      const nearBottom = session.body.scrollHeight - session.body.scrollTop - session.body.clientHeight < 28;
      session.userScrolled = !nearBottom;
      session.userInteracted = true;
    }, { passive: true });

    // 用户与面板产生交互（点按钮/拖动/聚焦）后不自动关闭
    panel.addEventListener('pointerdown', function () {
      session.userInteracted = true;
    }, { capture: true, passive: true });

    placePanel(session);
    requestAnimationFrame(function () {
      panel.classList.add('is-enter');
      // 进入动画结束后尺寸才稳定，再校正一次位置避免重叠
      setTimeout(function () {
        if (!session.closed && !session.dragged) placePanel(session);
      }, 220);
      try { panel.focus({ preventScroll: true }); } catch (e) { /* noop */ }
    });

    // 数量上限，避免刷屏
    const max = Math.max(1, Number((AD.Settings.snapshot().mode || {}).maxPerPage) || 6);
    const open = Array.from(sessions.values()).filter(function (s) { return !s.closed; });
    if (open.length > max) {
      open.sort(function (a, b) { return a.createdAt - b.createdAt; });
      while (open.length > max) Overlay.close(open.shift().id);
    }

    return id;
  };

  /** 截图晚到时补挂缩略图 */
  Overlay.updateScreenshot = function (id, dataUrl) {
    const s = sessions.get(id);
    if (!s || s.closed || !s.body || !s.stream) return;
    s.screenshot = dataUrl;
    if (!s.shotBox) {
      s.shotBox = el('div', 'dati-panel__shot');
      const img = document.createElement('img');
      img.src = dataUrl;
      img.alt = '题目截图';
      const tag = el('span', 'dati-panel__shot-tag', '截图');
      s.shotBox.appendChild(img);
      s.shotBox.appendChild(tag);
      s.body.insertBefore(s.shotBox, s.stream);
      img.addEventListener('click', function () {
        try { window.open(dataUrl, '_blank'); } catch (e) { /* noop */ }
      });
    } else {
      const img = s.shotBox.querySelector('img');
      if (img) img.src = dataUrl;
    }
    if (s.panel) requestAnimationFrame(function () { placePanel(s); });
  };

  Overlay.setQuestion = function (id, question, rect) {    const s = sessions.get(id);
    if (!s || s.closed) return;
    s.question = question;
    if (rect) s.rect = rect;
    if (s.stemEl && question) s.stemEl.textContent = question.stem || '（无题干文本）';
    renderOptions(s);
    parseChips(s);
    if (s.panel) placePanel(s);
  };

  Overlay.ready = function (id, info) {
    const s = sessions.get(id);
    if (!s || s.closed) return;
    if (info && info.model) {
      s.model = info.model;
      if (s.modelChip) s.modelChip.textContent = info.model;
    }
    if (s.statusText) s.statusText.textContent = '生成中…';
    if (s.spinner) s.spinner.style.display = '';
    if (s.btnStop) s.btnStop.style.display = '';
  };

  Overlay.append = function (id, delta) {
    const s = sessions.get(id);
    if (!s || s.closed) return;
    s.text += delta;
    if (s.statusText && s.text.length) s.statusText.textContent = '生成中 · ' + s.text.length + ' 字';
    scheduleRender(s);
  };

  Overlay.setReasoning = function (id, delta) {
    const s = sessions.get(id);
    if (!s || s.closed) return;
    if (!s.reasoningEl) {
      s.reasoningEl = el('div', 'dati-reasoning');
      const t = el('div', 'dati-reasoning__title', '思考过程');
      s.reasoningEl.appendChild(t);
      s.reasoningText = el('div', 'dati-reasoning__body');
      s.reasoningEl.appendChild(s.reasoningText);
      s.reasoningEl.classList.add('is-open');
      if (s.body && s.stream) s.body.insertBefore(s.reasoningEl, s.stream);
    }
    s.reasoningText.textContent += delta;
  };

  Overlay.done = function (id, result) {
    const s = sessions.get(id);
    if (!s || s.closed) return;
    result = result || {};
    if (result.text) s.text = result.text;
    s.answerText = result.text || s.text;
    s.stream.innerHTML = renderMarkdown(s.answerText);
    s.stream.hidden = !!((s.question && s.question.options && s.question.options.length) &&
      /^[A-Z](?:[\s,、]*[A-Z])*$/i.test(s.answerText.trim()));
    s.stream.classList.remove('is-streaming');
    s.stream.classList.add('is-done');
    if (s.spinner) s.spinner.style.display = 'none';
    if (s.btnStop) s.btnStop.style.display = 'none';
    if (s.btnFill) s.btnFill.disabled = !s.answerText;
    if (s.btnRetry) s.btnRetry.disabled = false;
    if (s.statusText) {
      const parts = ['完成'];
      if (result.ms) parts.push((result.ms / 1000).toFixed(1) + 's');
      if (result.usage) {
        const u = result.usage;
        const tin = u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens;
        const tout = u.completion_tokens != null ? u.completion_tokens : u.output_tokens;
        if (tin != null || tout != null) parts.push('↑' + (tin || 0) + ' ↓' + (tout || 0));
      }
      if (result.warning) parts.push('⚠ ' + result.warning);
      s.statusText.textContent = parts.join(' · ');
    }
    if (s.panel) {
      s.panel.classList.add('is-done');
      requestAnimationFrame(function () { placePanel(s); });
    }
    parseChips(s);
    if (s.onDone) { try { s.onDone(s, result); } catch (e) { /* noop */ } }
  };

  Overlay.fail = function (id, error) {
    const s = sessions.get(id);
    if (!s || s.closed) return;
    if (s.spinner) s.spinner.style.display = 'none';
    if (s.btnStop) s.btnStop.style.display = 'none';
    if (s.btnRetry) s.btnRetry.disabled = false;
    if (s.statusText) s.statusText.textContent = '失败';
    if (s.errBox) {
      s.errBox.style.display = '';
      s.errBox.textContent = String(error || '请求失败');
    }
    s.panel && s.panel.classList.add('is-error');
    if (s.onFail) { try { s.onFail(s, error); } catch (e) { /* noop */ } }
  };

  Overlay.text = function (id) {
    const s = sessions.get(id);
    return s ? (s.answerText || s.text) : '';
  };

  Overlay.session = function (id) { return sessions.get(id) || null; };

  Overlay.close = function (id, info) {
    if (!id) { return Overlay.closeAll(); }
    const s = sessions.get(id);
    if (!s || s.closed) return;
    s.closed = true;
    if (s.onStop) { try { s.onStop(s); } catch (e) { /* noop */ } }
    // 用户点 × / Esc 关闭时 userClosed 为 true；程序化关闭（重试/填入完成等）为 false
    const userClosed = !(info && info.reason) && !s._autoClosing && !s._retrying;
    if (s.onClose) { try { s.onClose(s, { userClosed: userClosed, reason: info && info.reason }); } catch (e) { /* noop */ } }
    const panel = s.panel;
    sessions.delete(id);
    if (!sessions.size && lifecycleObserver) {
      lifecycleObserver.disconnect();
      lifecycleObserver = null;
    }
    if (panel) {
      panel.classList.remove('is-enter');
      panel.classList.add('is-leave');
      setTimeout(function () {
        try { panel.remove(); } catch (e) { /* noop */ }
      }, 180);
    }
  };

  Overlay.closeAll = function () {
    Array.from(sessions.keys()).forEach(function (id) { Overlay.close(id); });
  };

  Overlay.count = function () {
    let n = 0;
    sessions.forEach(function (s) { if (!s.closed) n++; });
    return n;
  };

  Overlay.toast = function (text, opts) {
    opts = opts || {};
    ensureHost();
    const settings = AD.Settings.snapshot();
    if (!toastEl || !root.contains(toastEl)) {
      toastEl = el('div', 'dati-toast');
      toastEl.setAttribute('data-dati-ignore', '1');
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      root.appendChild(toastEl);
    }
    applyTheme(toastEl, settings);
    toastEl.className = 'dati-toast is-show' + (opts.tone ? ' dati-toast--' + opts.tone : '');
    toastEl.textContent = String(text || '');
    clearTimeout(toastEl._t);
    const currentToast = toastEl;
    currentToast._t = setTimeout(function () {
      currentToast.classList.remove('is-show');
    }, Math.max(1200, opts.ms || 2600));
  };

  Overlay.hint = function (rect, text, target) {
    ensureHost();
    if (!hintEl || !root.contains(hintEl)) {
      hintEl = el('div', 'dati-hint');
      hintEl.setAttribute('data-dati-ignore', '1');
      root.appendChild(hintEl);
    }
    if (!rect) {
      hintEl.classList.remove('is-show');
      return;
    }
    const settings = AD.Settings.snapshot();
    applyTheme(hintEl, settings);
    hintEl.textContent = text || '';
    hintEl._datiTarget = target || null;
    const vp = viewport();
    const x = AD.clamp(rect.x + rect.w - 4, 8, vp.w - 160);
    const y = AD.clamp(rect.y - 26, 8, vp.h - 32);
    hintEl.style.left = Math.round(x) + 'px';
    hintEl.style.top = Math.round(y) + 'px';
    hintEl.classList.add('is-show');
    watchQuestions();
  };

  Overlay.hideHint = function () {
    if (hintEl) { hintEl.classList.remove('is-show'); hintEl._datiTarget = null; }
  };

  // 可选的题目位置调试框：在 Shadow DOM 内绘制，避免被宿主页面样式覆盖。
  Overlay.setDetectionBoxes = function (questions, enabled) {
    if (!enabled || !Array.isArray(questions) || !questions.length) {
      detectionBoxes.forEach(function (el) { el.remove(); });
      detectionBoxes.clear();
      return;
    }
    ensureHost();
    const live = new Set();
    questions.forEach(function (q) {
      if (!q || !q.id) return;
      const el = q.root || q.anchor;
      if (!el || !el.isConnected || typeof el.getBoundingClientRect !== 'function') return;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return;
      live.add(q.id);
      let box = detectionBoxes.get(q.id);
      if (!box) {
        box = document.createElement('div');
        box.className = 'dati-detection-box';
        box.setAttribute('data-dati-ignore', '1');
        box.style.cssText = 'position:fixed;z-index:3;pointer-events:none;box-sizing:border-box;border:2px solid #22c55e;border-radius:8px;background:rgba(34,197,94,.045);box-shadow:0 0 0 1px rgba(255,255,255,.7),0 4px 14px rgba(34,197,94,.16);transition:top 120ms ease,left 120ms ease,width 120ms ease,height 120ms ease;';
        const tag = document.createElement('span');
        tag.textContent = '识别到的题目';
        tag.style.cssText = 'position:absolute;right:-2px;top:-23px;padding:3px 8px;border-radius:6px 6px 0 0;background:#16a34a;color:#fff;font:600 11px/1.4 system-ui,"Microsoft YaHei",sans-serif;white-space:nowrap;';
        box.appendChild(tag);
        box._datiTarget = el;
        layer.appendChild(box);
        detectionBoxes.set(q.id, box);
      }
      box._datiTarget = el;
      box.style.display = '';
      box.style.left = Math.round(rect.left) + 'px';
      box.style.top = Math.round(rect.top) + 'px';
      box.style.width = Math.round(rect.width) + 'px';
      box.style.height = Math.round(rect.height) + 'px';
    });
    detectionBoxes.forEach(function (el, id) {
      if (!live.has(id)) { el.remove(); detectionBoxes.delete(id); }
    });
  };

  Overlay.retheme = function (settings) {
    sessions.forEach(function (s) {
      if (s.panel) applyTheme(s.panel, settings);
    });
    if (toastEl) applyTheme(toastEl, settings);
    if (hintEl) applyTheme(hintEl, settings);
    repositionAll();
  };

  Overlay.destroy = function () {
    Overlay.closeAll();
    Overlay.setDetectionBoxes([], false);
    if (toastEl) clearTimeout(toastEl._t);
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null; root = null; layer = null;
    toastEl = null; hintEl = null;
  };

  Overlay.renderMarkdown = renderMarkdown;

  AD.Overlay = Overlay;
}(globalThis.AD = globalThis.AD || {}));
