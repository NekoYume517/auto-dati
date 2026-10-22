/**
 * AutoDati · 截图 / 区域选择 / 页面内快捷键
 */
(function (AD) {
  'use strict';

  const PICKER_ID = 'dati-picker-host';
  const Z = 2147483001;
  let activeCancel = null;

  const KEYS = {
    alt: 'Alt', ctrl: 'Ctrl', shift: 'Shift', meta: 'Meta',
    altgraph: 'AltGraph', control: 'Ctrl'
  };

  /** "Alt+Shift+Q" → {alt:true, ctrl:false, shift:true, meta:false, key:'q'} */
  function parseCombo(str) {
    if (!str) return null;
    const parts = String(str).split('+').map(function (s) { return s.trim(); }).filter(Boolean);
    const out = { alt: false, ctrl: false, shift: false, meta: false, key: '' };
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i].toLowerCase();
      if (p === 'alt') out.alt = true;
      else if (p === 'ctrl' || p === 'control') out.ctrl = true;
      else if (p === 'shift') out.shift = true;
      else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'win') out.meta = true;
      else out.key = p;
    }
    return out.key ? out : null;
  }

  function comboMatches(combo, e) {
    if (!combo) return false;
    const key = String(e.key || '').toLowerCase();
    const code = String(e.code || '').toLowerCase();
    let k = combo.key;
    if (k === 'space') k = ' ';
    const sameKey = key === k || code === 'key' + k || code === 'digit' + k ||
      (k.length === 1 && code === k) || (k === '/' && code === 'slash');
    if (!sameKey) return false;
    // 修饰键精确匹配（允许 Shift 对字母的额外影响）
    return combo.alt === !!e.altKey && combo.ctrl === !!e.ctrlKey &&
      combo.meta === !!e.metaKey && combo.shift === !!e.shiftKey;
  }

  function comboSig(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.metaKey) parts.push('Meta');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    let k = e.key;
    if (k === ' ') k = 'Space';
    else if (k && k.length === 1) k = k.toUpperCase();
    parts.push(k);
    return parts.join('+');
  }

  /* ------------------------------ 区域选择器 ------------------------------ */

  let picker = null;

  function mountPicker(host) {
    host.tabIndex = -1;
    host.style.margin = '0'; host.style.padding = '0'; host.style.border = '0';
    host.style.background = 'transparent'; host.style.maxWidth = 'none'; host.style.maxHeight = 'none';
    host.style.width = '100vw'; host.style.height = '100vh'; host.style.overflow = 'visible';
    document.documentElement.appendChild(host);
    if (typeof host.showPopover === 'function') {
      try { host.setAttribute('popover', 'manual'); host.showPopover(); }
      catch (e) { host.removeAttribute('popover'); }
    }
    host.focus({ preventScroll: true });
  }

  function ensurePicker() {
    if (picker && document.documentElement.contains(picker.host)) return picker;
    const host = document.createElement('div');
    host.id = PICKER_ID;
    host.setAttribute('data-dati-ignore', '1');
    host.style.cssText = 'position:fixed;inset:0;z-index:' + Z + ';pointer-events:auto;';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = [
      ':host{all:initial}',
      '*{box-sizing:border-box;margin:0;padding:0;font-family:"Inter","PingFang SC","Microsoft YaHei",sans-serif}',
      '.wrap{position:fixed;inset:0;cursor:crosshair;background:rgba(10,11,18,.32);',
      '}',
      '.box{position:fixed;border:1.5px solid #6366f1;border-radius:4px;',
      '  background:rgba(99,102,241,.10);box-shadow:0 0 0 9999px rgba(8,9,15,.42),0 0 0 1px rgba(255,255,255,.16) inset;',
      '  pointer-events:none;display:none;}',
      '.size{position:fixed;padding:2px 7px;border-radius:5px;font-size:11px;font-weight:600;color:#fff;',
      '  background:linear-gradient(135deg,#6366f1,#8b5cf6);pointer-events:none;display:none;',
      '  box-shadow:0 4px 14px -6px rgba(99,102,241,.8);font-variant-numeric:tabular-nums;}',
      '.tip{position:fixed;left:50%;top:22px;transform:translateX(-50%);padding:8px 16px;border-radius:999px;',
      '  font-size:12.5px;color:#eceef6;background:rgba(22,23,32,.92);border:1px solid rgba(255,255,255,.14);',
      '  box-shadow:0 12px 32px -12px rgba(0,0,0,.8);display:flex;align-items:center;gap:8px;white-space:nowrap;}',
      '.tip b{color:#a5b4fc;font-weight:600}',
      '.kbd{padding:1px 6px;border-radius:4px;border:1px solid rgba(255,255,255,.18);',
      '  background:rgba(255,255,255,.06);font-size:11px;font-family:ui-monospace,monospace;}',
      '.esc{color:#8b90a8}'
    ].join('');

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const box = document.createElement('div');
    box.className = 'box';
    const size = document.createElement('div');
    size.className = 'size';
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.innerHTML = '<b>拖拽框选题目区域</b><span class="esc">Esc / 右键 退出</span>';

    wrap.appendChild(box);
    wrap.appendChild(size);
    wrap.appendChild(tip);
    shadow.appendChild(style);
    shadow.appendChild(wrap);
    mountPicker(host);

    picker = { host: host, shadow: shadow, wrap: wrap, box: box, size: size, tip: tip };
    return picker;
  }

  /**
   * 框选一个矩形。返回 Promise<rect|null>
   */
  function pickRegion(opts) {
    opts = opts || {};
    if (activeCancel) activeCancel();
    if (AD.Overlay) AD.Overlay.hideHint();
    return new Promise(function (resolve) {
      const p = ensurePicker();
      p.host.style.display = '';
      if (p.host.hasAttribute('popover') && !p.host.matches(':popover-open')) p.host.showPopover();
      p.wrap.style.display = '';
      p.host.focus({ preventScroll: true });
      let start = null;
      let rect = null;
      let done = false;

      function cleanup(result) {
        if (done) return;
        done = true;
        activeCancel = null;
        p.box.style.display = 'none';
        p.size.style.display = 'none';
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('contextmenu', onCancel, true);
        p.wrap.removeEventListener('pointerdown', onDown);
        p.wrap.removeEventListener('pointermove', onMove);
        p.wrap.removeEventListener('pointerup', onUp);
        window.removeEventListener('resize', onResize, true);
        p.host.style.display = 'none';
        if (p.host.hasAttribute('popover') && p.host.matches(':popover-open')) p.host.hidePopover();
        resolve(result);
      }

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          cleanup(null);
        }
      }
      function onResize() {
        p.box.style.display = 'none';
        p.size.style.display = 'none';
      }
      function onCancel(e) {
        e.preventDefault(); e.stopImmediatePropagation(); cleanup(null);
      }

      function paint() {
        if (!rect) return;
        const x = Math.min(rect.x, rect.x + rect.w);
        const y = Math.min(rect.y, rect.y + rect.h);
        const w = Math.abs(rect.w);
        const h = Math.abs(rect.h);
        p.box.style.display = 'block';
        p.box.style.left = x + 'px';
        p.box.style.top = y + 'px';
        p.box.style.width = w + 'px';
        p.box.style.height = h + 'px';
        p.size.style.display = 'block';
        p.size.textContent = Math.round(w) + ' × ' + Math.round(h);
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        p.size.style.left = Math.max(6, Math.min(vw - 90, x + w - 82)) + 'px';
        p.size.style.top = (y + h + 8 + 18 > vh ? Math.max(6, y - 28) : y + h + 8) + 'px';
      }

      function onDown(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        start = { x: e.clientX, y: e.clientY };
        rect = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
        p.tip.style.display = 'none';
        paint();
      }
      function onMove(e) {
        if (!start) return;
        rect = { x: start.x, y: start.y, w: e.clientX - start.x, h: e.clientY - start.y };
        paint();
      }
      function onUp(e) {
        if (!start || !rect) return;
        const x = Math.min(rect.x, rect.x + rect.w);
        const y = Math.min(rect.y, rect.y + rect.h);
        const w = Math.abs(rect.w);
        const h = Math.abs(rect.h);
        start = null;
        if (w < 8 || h < 8) {
          p.tip.style.display = '';
          p.box.style.display = 'none';
          p.size.style.display = 'none';
          rect = null;
          return;
        }
        cleanup({ x: x, y: y, w: w, h: h });
      }

      p.wrap.addEventListener('pointerdown', onDown);
      activeCancel = function () { cleanup(null); };
      p.wrap.addEventListener('pointermove', onMove);
      p.wrap.addEventListener('pointerup', onUp);
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('contextmenu', onCancel, true);
      window.addEventListener('resize', onResize, true);
      p.tip.style.display = '';
      p.box.style.display = 'none';
      p.size.style.display = 'none';
    });
  }

  /* --------------------------- 元素拾取（截图搜题用） --------------------------- */

  const PICKER_HOST_ID = 'dati-elem-picker-host';

  /**
   * 单击选择元素，拖动框选任意区域；Esc / 右键取消。
   * 返回 Promise<{el, rect, selector}|null>
   */
  function pickElement(opts) {
    opts = opts || {};
    if (activeCancel) activeCancel();
    if (AD.Overlay) AD.Overlay.hideHint();
    return new Promise(function (resolve) {
      const host = document.createElement('div');
      host.id = PICKER_HOST_ID;
      host.setAttribute('data-dati-ignore', '1');
      host.style.cssText = 'position:fixed;inset:0;z-index:' + (Z + 1) + ';pointer-events:auto;';
      const shadow = host.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = [
        ':host{all:initial}',
        '*{box-sizing:border-box;margin:0;padding:0;font-family:"Inter","PingFang SC","Microsoft YaHei",sans-serif}',
        '.wrap{position:fixed;inset:0;cursor:crosshair;background:rgba(10,11,18,.28);',
        '}',
        '.hl{position:fixed;border:1.5px solid #6366f1;border-radius:4px;background:rgba(99,102,241,.12);',
        '  box-shadow:0 0 0 9999px rgba(8,9,15,.36);pointer-events:none;display:none;',
        '}',
        '.tag{position:fixed;padding:2px 7px;border-radius:5px;font:600 11px/1.5 ui-monospace,monospace;',
        '  color:#fff;background:linear-gradient(135deg,#6366f1,#8b5cf6);pointer-events:none;display:none;',
        '  max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
        '  box-shadow:0 4px 12px -5px rgba(99,102,241,.9);}',
        '.tip{position:fixed;left:50%;top:20px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;',
        '  padding:9px 16px;border-radius:999px;font-size:12.5px;color:#eceef6;background:rgba(22,23,32,.94);',
        '  border:1px solid rgba(255,255,255,.14);box-shadow:0 16px 40px -14px rgba(0,0,0,.8);white-space:nowrap;}',
        '.tip b{color:#a5b4fc;font-weight:600}.tip .esc{color:#8b90a8}',
        '@media (prefers-reduced-motion: reduce){*{transition-duration:1ms !important}}'
      ].join('');

      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      const hl = document.createElement('div');
      hl.className = 'hl';
      const tag = document.createElement('div');
      tag.className = 'tag';
      const tip = document.createElement('div');
      tip.className = 'tip';
      tip.innerHTML = '<b>单击选择元素 · 拖动框选题目</b><span class="esc">Esc / 右键 退出</span>';

      wrap.appendChild(hl);
      wrap.appendChild(tag);
      wrap.appendChild(tip);
      shadow.appendChild(style);
      shadow.appendChild(wrap);
      mountPicker(host);

      let current = null;
      let done = false;
      let start = null;
      let dragging = false;
      let probeSequence = 0;
      let probeBusy = false;
      let selectingFrame = false;

      function cleanup(result) {
        if (done) return;
        done = true;
        activeCancel = null;
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('contextmenu', onCancel, true);
        window.removeEventListener('scroll', onScroll, true);
        try { host.remove(); } catch (e) { /* noop */ }
        resolve(result || null);
      }

      function paint(el) {
        if (!el) {
          hl.style.display = 'none';
          tag.style.display = 'none';
          return;
        }
        const r = el.remote ? { left: el.rect.x, top: el.rect.y, width: el.rect.w, height: el.rect.h, bottom: el.rect.y + el.rect.h }
          : el.getBoundingClientRect();
        hl.style.display = 'block';
        hl.style.left = r.left + 'px';
        hl.style.top = r.top + 'px';
        hl.style.width = r.width + 'px';
        hl.style.height = r.height + 'px';

        tag.style.display = 'block';
        let label = String(el.tag || el.tagName || '').toLowerCase();
        const cls = (el.className && typeof el.className === 'string') ? el.className.split(/\s+/).filter(Boolean).slice(0, 2) : [];
        if (cls.length) label += '.' + cls.join('.');
        const txt = String((el.text || el.innerText || el.textContent || '')).replace(/\s+/g, ' ').trim();
        if (txt) label += ' · ' + txt.slice(0, 40);
        tag.textContent = label;

        const ty = r.top > 26 ? r.top - 24 : r.bottom + 6;
        tag.style.left = Math.max(6, Math.min(window.innerWidth - 240, r.left)) + 'px';
        tag.style.top = ty + 'px';
      }

      async function onMove(e) {
        if (selectingFrame) return;
        if (start && (dragging || Math.hypot(e.clientX - start.x, e.clientY - start.y) >= 6)) {
          dragging = true;
          const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
          const w = Math.abs(e.clientX - start.x), h = Math.abs(e.clientY - start.y);
          hl.style.cssText = 'display:block;left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px';
          tag.style.display = 'block'; tag.textContent = Math.round(w) + ' × ' + Math.round(h);
          tag.style.left = Math.max(6, Math.min(window.innerWidth - 100, x)) + 'px';
          tag.style.top = Math.max(6, y - 27) + 'px';
          return;
        }
        const el = probeElement(e.clientX, e.clientY);
        if (!el) return;
        if (el.matches('iframe,frame') && AD.Frame) {
          if (probeBusy) return;
          const sequence = ++probeSequence;
          probeBusy = true;
          const target = await AD.Frame.probeAt(e.clientX, e.clientY).catch(function () { return null; });
          probeBusy = false;
          if (done || dragging || sequence !== probeSequence) return;
          if (target) { current = Object.assign({ remote: true }, target); paint(current); }
          return;
        }
        ++probeSequence;
        if (el === current) return;
        current = el;
        paint(el);
      }

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cleanup(null);
        }
      }

      function onScroll() { paint(current); }

      function onCancel(e) {
        e.preventDefault(); e.stopImmediatePropagation(); cleanup(null);
      }

      function onDown(e) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        start = { x: e.clientX, y: e.clientY };
        dragging = false;
        try { wrap.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      }

      function onUp(e) {
        if (e.button !== 0 || !start) return;
        e.preventDefault(); e.stopPropagation();
        try { wrap.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
        const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
        const w = Math.abs(e.clientX - start.x), h = Math.abs(e.clientY - start.y);
        start = null;
        if (dragging && w >= 8 && h >= 8) {
          cleanup({ el: null, rect: { x: x, y: y, w: w, h: h }, selector: '', mode: 'region' });
          return;
        }
        onClick(e);
      }

      async function onClick(e) {
        e.preventDefault();
        e.stopPropagation();
        const el = probeElement(e.clientX, e.clientY);
        if (!el) return;
        if (el.matches('iframe,frame') && AD.Frame) {
          if (selectingFrame) return;
          selectingFrame = true;
          const sequence = ++probeSequence;
          const target = await AD.Frame.probeAt(e.clientX, e.clientY, { whole: true }).catch(function () { return null; });
          selectingFrame = false;
          if (done || sequence !== probeSequence) return;
          if (!target || target.isFrame) {
            tip.textContent = '此框架暂时无法读取，可拖动框选题目；Esc / 右键退出';
            return;
          }
          cleanup({ el: null, rect: target.rect, selector: target.selector, remote: target });
          return;
        }

        // 尽量把「整道题」框进来：如果点在题干/选项内部，向上归并到题块
        let target = el;
        try {
          const q = AD.Detector && AD.Detector.buildFromElement ? AD.Detector.buildFromElement(el) : null;
          if (q && q.root) target = q.root;
        } catch (err) { /* 保持原元素 */ }

        const r = target.getBoundingClientRect();
        // 过大的容器（整页）退化回被点的元素
        const useEl = (r.height > window.innerHeight * 0.85 || r.width > window.innerWidth * 0.95) ? el : target;
        const rr = useEl.getBoundingClientRect();

        cleanup({
          el: useEl,
          rect: { x: rr.left, y: rr.top, w: rr.width, h: rr.height },
          selector: (AD.Picker && AD.Picker.patternSelector) ? AD.Picker.patternSelector(useEl) : ''
        });
      }

      wrap.addEventListener('pointermove', onMove);
      activeCancel = function () { cleanup(null); };
      wrap.addEventListener('pointerdown', onDown);
      wrap.addEventListener('pointerup', onUp);
      wrap.addEventListener('pointercancel', onCancel);
      wrap.addEventListener('click', function (e) { if (e.detail === 0 && !done) onClick(e); });
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('contextmenu', onCancel, true);
      window.addEventListener('scroll', onScroll, true);
    });
  }

  /* ------------------------------ 截图请求 ------------------------------ */

  function sendMessage(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(res || { ok: false, error: '无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: (e && e.message) || String(e) });
      }
    });
  }

  /** 请求当前标签页截图（可裁剪） */
  async function capture(rect, opts) {
    opts = opts || {};
    const settings = AD.Settings.snapshot();
    const adv = settings.advanced || {};
    // 等两帧，确保选择器等覆盖 UI 已经从画面上消失
    await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
    await AD.sleep(40);
    const geometry = AD.Frame && await AD.Frame.topGeometry({ x: 0, y: 0, w: innerWidth, h: innerHeight });
    const viewport = geometry && geometry.viewport || { w: window.innerWidth, h: window.innerHeight };
    return sendMessage({
      type: AD.MSG.CAPTURE_TAB,
      rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) } : null,
      viewport: viewport,
      dpr: window.devicePixelRatio || 1,
      crop: opts.crop !== false,
      format: opts.format || adv.screenshotFormat || 'png',
      maxSide: opts.maxSide || adv.maxImageSide || 1600,
      quality: opts.quality
    });
  }

  /** dataURL → {mime, dataBase64} */
  function splitDataUrl(dataUrl) {
    const m = /^data:([^;,]+);base64,(.*)$/.exec(String(dataUrl || ''));
    if (!m) return null;
    return { mime: m[1], dataBase64: m[2], dataUrl: dataUrl };
  }

  /* --------------------------- 元素定位与文本 --------------------------- */

  let lastMouse = { x: 0, y: 0 };

  const OWN_HOST_IDS = ['dati-overlay-host', 'dati-elem-picker-host', 'dati-picker-host', 'dati-template-picker'];

  /**
   * 命中测试：临时关掉扩展自己的全屏覆盖层，避免 elementFromPoint 只返回宿主节点。
   * （覆盖层是 position:fixed inset:0，pointer-events:auto 时会把下面所有元素挡住）
   */
  function probeElement(x, y) {
    const hosts = [];
    const focused = document.activeElement;
    for (let i = 0; i < OWN_HOST_IDS.length; i++) {
      const h = document.getElementById(OWN_HOST_IDS[i]);
      if (h) hosts.push([h, h.style.pointerEvents, h.style.visibility, h.style.getPropertyPriority('visibility')]);
    }
    for (let i = 0; i < hosts.length; i++) {
      hosts[i][0].style.pointerEvents = 'none';
      hosts[i][0].style.setProperty('visibility', 'hidden', 'important');
    }
    let el = null;
    try {
      el = document.elementFromPoint(x, y);
      // elementFromPoint 默认止于 Shadow host，继续在开放/封闭根里做命中测试。
      for (let depth = 0; el && depth < 64; depth++) {
        const root = AD.PresetKit && AD.PresetKit.shadowRootOf(el);
        if (!root || typeof root.elementFromPoint !== 'function') break;
        const inner = root.elementFromPoint(x, y);
        if (!inner || inner === el) break;
        el = inner;
      }
    } catch (e) {
      el = null;
    }
    for (let i = 0; i < hosts.length; i++) {
      hosts[i][0].style.pointerEvents = hosts[i][1];
      if (hosts[i][2]) hosts[i][0].style.setProperty('visibility', hosts[i][2], hosts[i][3]);
      else hosts[i][0].style.removeProperty('visibility');
    }
    if (focused && hosts.some(function (entry) { return entry[0] === focused; })) focused.focus({ preventScroll: true });
    if (!el) return null;
    if (el.closest && el.closest('[data-dati-ignore]')) return null;
    return el;
  }

  function trackMouse() {
    window.addEventListener('mousemove', function (e) {
      lastMouse = { x: e.clientX, y: e.clientY };
    }, { passive: true, capture: true });
  }

  function elementAt(x, y) {
    return probeElement(x, y);
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  function textNear(rect) {
    const el = elementAt(rect.x + rect.w / 2, rect.y + Math.min(rect.h / 2, 40));
    if (!el) return '';
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      const t = (node.innerText || node.textContent || '').trim();
      if (t.length > 8) return t.slice(0, 1200);
      node = node.parentElement;
    }
    return '';
  }

  AD.Capture = {
    parseCombo: parseCombo,
    comboMatches: comboMatches,
    comboSig: comboSig,
    pickRegion: pickRegion,
    pickElement: pickElement,
    mountPicker: mountPicker,
    isPicking: function () { return !!activeCancel; },
    capture: capture,
    sendMessage: sendMessage,
    splitDataUrl: splitDataUrl,
    trackMouse: trackMouse,
    elementAt: elementAt,
    rectOf: rectOf,
    textNear: textNear,
    lastMouse: function () { return lastMouse; }
  };
}(globalThis.AD = globalThis.AD || {}));
