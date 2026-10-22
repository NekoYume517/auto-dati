/**
 * AutoDati · 题目检测器（AD.Detector）
 *
 * 经典脚本，无 import/export，只挂载 globalThis.AD。
 * 依赖：AD.PRESETS / AD.PresetKit（content/presets.js）、AD.Settings（common/settings.js，可选）。
 * 不依赖 chrome.*，可在普通页面与 fixture 中直接运行。
 *
 * 契约（docs/CONTRACT.md §4）：
 *   AD.Detector.scan(root = document, opts = {}) -> ADQuestion[]
 *   AD.Detector.observe(cb) -> stop()
 *   AD.Detector.isVisible(el) -> boolean
 *   AD.Detector.elementKind(el) -> kind|null
 *   AD.Detector.buildFromElement(el) -> ADQuestion|null
 */
(function (AD) {
  'use strict';

  if (!AD) return;

  /* ======================================================================
   * 0. 依赖兜底
   * ==================================================================== */

  function kit() {
    return AD.PresetKit || null;
  }

  function norm(s) {
    var k = kit();
    if (k) return k.norm(s);
    return s == null ? '' : String(s).replace(/\s+/g, ' ').trim();
  }

  function clamp01(v) {
    v = Number(v);
    if (!isFinite(v)) return 0;
    return Math.min(1, Math.max(0, v));
  }

  var DEFAULT_DETECT = {
    sitePresets: {},
    customRules: [],
    minTextLen: 4,
    viewportOnly: true,
    shadowDom: true
  };

  /** 读取设置快照（未加载 / 无 chrome 时回落默认值） */
  function readSettings() {
    var snap = null;
    try {
      if (AD.Settings && typeof AD.Settings.snapshot === 'function') snap = AD.Settings.snapshot();
    } catch (e) { snap = null; }
    var s = snap || {};
    var detect = s.detect || {};
    var mode = s.mode || {};
    return {
      detect: {
        sitePresets: detect.sitePresets || {},
        customRules: Array.isArray(detect.customRules) ? detect.customRules : [],
        minTextLen: typeof detect.minTextLen === 'number' ? detect.minTextLen : DEFAULT_DETECT.minTextLen,
        viewportOnly: detect.viewportOnly !== false,
        shadowDom: detect.shadowDom !== false
      },
      mode: {
        maxPerPage: typeof mode.maxPerPage === 'number' ? mode.maxPerPage : 6,
        skipAnswered: mode.skipAnswered !== false,
        scanDebounceMs: typeof mode.scanDebounceMs === 'number' ? mode.scanDebounceMs : 600,
        minIntervalMs: typeof mode.minIntervalMs === 'number' ? mode.minIntervalMs : 1500
      }
    };
  }

  /* ======================================================================
   * 1. 可见性
   * ==================================================================== */

  var IGNORE_SEL = '[data-dati-ignore], #dati-overlay-host';

  function isIgnoredNode(el) {
    var k = kit();
    if (k) return k.isIgnored(el);
    try {
      return !!(el && el.closest && el.closest(IGNORE_SEL));
    } catch (e) {
      return false;
    }
  }

  function styleOf(el) {
    try {
      var win = el.ownerDocument && el.ownerDocument.defaultView;
      if (!win || !win.getComputedStyle) return null;
      return win.getComputedStyle(el);
    } catch (e) {
      return null;
    }
  }

  /** 元素（或其祖先）是否正在跑 CSS animation/transition */
  function isAnimating(el) {
    var node = el;
    var guard = 0;
    while (node && node.nodeType === 1 && guard++ < 6) {
      try {
        if (typeof node.getAnimations === 'function') {
          var anims = node.getAnimations({ subtree: false });
          for (var i = 0; i < anims.length; i++) {
            var a = anims[i];
            if (!a) continue;
            if (a.playState === 'running' || a.playState === 'pending') return true;
          }
        }
      } catch (e) { /* noop */ }
      node = node.parentElement;
    }
    return false;
  }

  function inViewport(rect) {    if (!rect) return false;
    var win = (typeof window !== 'undefined') ? window : null;
    var vw = win ? (win.innerWidth || (win.document && win.document.documentElement.clientWidth) || 0) : 0;
    var vh = win ? (win.innerHeight || (win.document && win.document.documentElement.clientHeight) || 0) : 0;
    if (!vw || !vh) return true;
    if (rect.w <= 0 || rect.h <= 0) return false;
    return rect.x < vw && rect.x + rect.w > 0 && rect.y < vh && rect.y + rect.h > 0;
  }

  /**
   * 可见性判定：尺寸 + 计算样式 + （可选）视口相交。
   * 未显式传 viewportOnly 时，按 AD.Settings 快照的 detect.viewportOnly 决定。
   * @param {Element} el
   * @param {{viewportOnly?:boolean, allowZeroSize?:boolean}} [opts]
   */
  function isVisible(el, opts) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden) return false;
    if (isIgnoredNode(el)) return false;

    var o = opts || {};
    var viewportOnly = o.viewportOnly;
    if (viewportOnly == null) {
      try { viewportOnly = readSettings().detect.viewportOnly; } catch (e) { viewportOnly = true; }
    }
    var rect = null;
    try {
      var b = el.getBoundingClientRect();
      rect = { x: b.left, y: b.top, w: b.width, h: b.height };
    } catch (e) {
      rect = null;
    }
    if (!rect) return false;
    if (!o.allowZeroSize && (rect.w < 1 || rect.h < 1)) return false;

    var st = styleOf(el);
    if (st) {
      if (st.display === 'none') return false;
      if (st.visibility === 'hidden' || st.visibility === 'collapse') return false;
      var op = parseFloat(st.opacity);
      if (isFinite(op) && op < 0.05) {
        // 入场动画期间（元素正在向 opacity:1 过渡）不要判为隐藏，
        // 否则 stagger 淡入页面会在首扫时全军覆没且不再重扫。
        if (!isAnimating(el)) return false;
      }
    }

    // 祖先隐藏（display:none 会让 rect 归零，这里再兜一层）
    var node = el.parentElement;
    var guard = 0;
    while (node && node.nodeType === 1 && guard++ < 30) {
      if (node.hidden) return false;
      var pst = styleOf(node);
      if (pst && (pst.display === 'none' || pst.visibility === 'hidden')) return false;
      node = node.parentElement;
    }

    if (viewportOnly) return inViewport(rect);
    return true;
  }

  /* ======================================================================
   * 2. DOM 遍历（含 open shadow root）
   * ==================================================================== */

  /**
   * 收集匹配作用域：document/root 本身 + 所有 open shadow root。
   * 同时建立 element -> 文档顺序索引。
   */
  function collectScopes(root, useShadow) {
    var scopes = [];
    var order = new Map();
    var counter = { i: 0 };
    var MAX_DEPTH = 400;

    function walkContainer(container, depth) {
      if (!container || depth > MAX_DEPTH) return;
      var list = container.children;
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (!el || el.nodeType !== 1) continue;
        if (!order.has(el)) order.set(el, counter.i++);
        var shadow = useShadow && kit() && kit().shadowRootOf(el);
        if (shadow) {
          scopes.push(shadow);
          walkContainer(shadow, depth + 1);
        }
        walkContainer(el, depth + 1);
      }
    }

    scopes.unshift(root);
    walkContainer(root, 0);
    return { scopes: scopes, order: order };
  }

  function orderOf(order, el) {
    if (!el) return Number.MAX_SAFE_INTEGER;
    var v = order.get(el);
    if (v != null) return v;
    // root 本身不在 order 里（例如 root 是 document）
    var p = el.parentElement;
    var guard = 0;
    while (p && guard++ < 20) {
      var pv = order.get(p);
      if (pv != null) return pv + 0.5;
      p = p.parentElement;
    }
    return Number.MAX_SAFE_INTEGER;
  }

  /* ======================================================================
   * 3. 预设启用判定
   * ==================================================================== */

  function presetsList() {
    var list = AD.PRESETS;
    if (!Array.isArray(list)) return [];
    return list;
  }

  function isPresetEnabled(preset, settings, opts) {
    if (!preset || !preset.id) return false;
    var forced = opts && opts.presets;
    if (Array.isArray(forced)) return forced.indexOf(preset.id) >= 0;
    if (forced && typeof forced === 'object') {
      if (Object.prototype.hasOwnProperty.call(forced, preset.id)) return !!forced[preset.id];
    }
    // 站点预设：URL 命中即启用（默认开）；sitePresets 里显式设为 false 可强制关闭
    if (preset.site) {
      var sp = settings.detect.sitePresets || {};
      if (sp[preset.id] === false) return false;
      var urls = preset.urls || [];
      if (!urls.length) return sp[preset.id] === true;
      try {
        var host = location.hostname || '';
        for (var u = 0; u < urls.length; u++) {
          var pat = String(urls[u] || '').replace(/^\*\./, '').replace(/^\*:/, '').replace(/\/\*$/, '');
          var bare = pat.split('/')[0].toLowerCase();
          if (!bare) continue;
          if (host === bare || host.slice(-(bare.length + 1)) === '.' + bare) return true;
        }
      } catch (e) { /* noop */ }
      return sp[preset.id] === true;
    }
    // Automatic detection only runs validated site presets. Generic type heuristics
    // remain available to explicit element picking, never as a page-wide scan.
    return false;
  }

  /* ======================================================================
   * 4. 自定义规则
   * ==================================================================== */

  /**
   * 域名匹配：支持多域名（数组或逗号/换行分隔的字符串）。
   * 每项可以是：
   *   example.com            → 匹配 example.com 及其任意子域
   *   *.example.com          → 仅子域（不含裸域）
   *   https://exam.example.com/x  → 按前缀匹配完整 URL
   *   /正则/                 → 按正则匹配完整 URL
   * 留空 = 所有站点生效。
   */
  function hostMatches(patternList, location) {
    if (!patternList) return true;
    var patterns = [];
    if (Array.isArray(patternList)) patterns = patternList;
    else if (typeof patternList === 'string') patterns = patternList.split(/[,\n;]+/);
    patterns = patterns.map(function (s) { return String(s || '').trim(); }).filter(Boolean);
    if (!patterns.length) return true;

    var href = '';
    var host = '';
    try {
      href = location.href || '';
      host = location.hostname || '';
    } catch (e) { /* noop */ }
    if (!host) return true; // 无法判断时不限制

    for (var i = 0; i < patterns.length; i++) {
      var p = patterns[i];
      // 正则 /.../
      if (p.length > 2 && p.charAt(0) === '/' && p.charAt(p.length - 1) === '/') {
        try { if (new RegExp(p.slice(1, -1), 'i').test(href)) return true; } catch (e) { /* noop */ }
        continue;
      }
      // 完整 URL 前缀
      if (/^https?:\/\//i.test(p)) {
        if (href.indexOf(p) === 0) return true;
        continue;
      }
      // 通配子域 *.example.com
      var bare = p.replace(/^\*\./, '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
      if (!bare) continue;
      if (p.indexOf('*.') === 0) {
        if (host !== bare && host.slice(-(bare.length + 1)) === '.' + bare) return true;
      } else {
        if (host === bare || host.slice(-(bare.length + 1)) === '.' + bare) return true;
      }
    }
    return false;
  }

  function matchCustomRule(rule, scope, ctx) {
    var k = kit();
    if (!k || !rule || !rule.rootSelector) return [];
    // 域名限定：不匹配当前页则整条规则跳过
    if (rule.domains && !hostMatches(rule.domains, (typeof location !== 'undefined') ? location : {})) return [];
    var out = [];
    var roots = k.all(scope, rule.rootSelector);
    for (var i = 0; i < roots.length; i++) {
      var rootEl = roots[i];
      if (!rootEl || rootEl.nodeType !== 1) continue;
      if (rootEl.tagName === 'BODY' || rootEl.tagName === 'HTML' || k.isIgnored(rootEl) || k.isNavish(rootEl)) continue;

      // 历史模板可能框住整张试卷/章节，包含多个题块时不能合成一道题。
      var siteBlocks = k.all(rootEl, '.examPaper_subject');
      if (siteBlocks.length > 1) continue;
      var siteRoot = rootEl.closest('.examPaper_subject') || siteBlocks[0];
      if (siteRoot) {
        var siteQ = k.analyzeZhihuishu(siteRoot, ctx);
        if (siteQ) {
          siteQ.presetId = 'custom:' + (rule.id || rule.name || 'rule');
          out.push(siteQ);
        }
        continue;
      }

      var kind = rule.kind && rule.kind !== 'auto' ? rule.kind : '';
      var stem = '';
      if (rule.stemSelector) {
        var stemEl = null;
        try { stemEl = rootEl.querySelector(rule.stemSelector); } catch (e) { stemEl = null; }
        if (stemEl) stem = k.stripStem(k.txt(stemEl));
      }

      var options = [];
      var inputs = [];

      if (rule.optionSelector) {
        var optEls = [];
        try { optEls = k.all(rootEl, rule.optionSelector); } catch (e) { optEls = []; }
        for (var j = 0; j < optEls.length; j++) {
          var el = optEls[j];
          if (!el || el.nodeType !== 1) continue;
          if (!isVisible(el, { viewportOnly: false })) continue;
          var parsed = k.stripOptionLabel(k.txt(el));
          var input = null;
          try {
            input = el.matches('input[type="radio"], input[type="checkbox"]')
              ? el
              : el.querySelector('input[type="radio"], input[type="checkbox"]');
          } catch (e2) { input = null; }
          options.push({
            label: parsed.label || k.letterFromIndex(options.length),
            text: parsed.text || k.txt(el),
            el: el,
            input: input || null,
            checked: input ? !!input.checked : k.isMarkedSelected(el)
          });
        }
      }

      if (rule.inputSelector) {
        var inEls = [];
        try { inEls = k.all(rootEl, rule.inputSelector); } catch (e) { inEls = []; }
        for (var n = 0; n < inEls.length; n++) {
          var ie = inEls[n];
          if (!ie || ie.nodeType !== 1) continue;
          if (!isVisible(ie, { viewportOnly: false }) || ie.disabled || ie.readOnly) continue;
          var tag = ie.tagName;
          if ((tag === 'INPUT' && !k.isTextField(ie)) ||
              (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && !ie.isContentEditable)) continue;
          var type = 'text';
          if (tag === 'TEXTAREA') type = 'textarea';
          else if (tag === 'SELECT') type = 'select';
          else if (ie.isContentEditable) type = 'contenteditable';
          inputs.push({
            el: ie,
            type: type,
            name: ie.getAttribute('name') || '',
            placeholder: ie.getAttribute('placeholder') || ''
          });
        }
      }

      if (!stem) stem = k.fallbackStem(options.length ? options[0].el : (inputs.length ? inputs[0].el : rootEl));

      if (!kind) {
        if (options.length) {
          if (k.isJudgePair(options)) kind = 'judge';
          else if (options.some(function (o) { return o.input && o.input.type === 'checkbox'; })) kind = 'multi';
          else if (/(multi|多选)/i.test(k.classStr(rootEl))) kind = 'multi';
          else kind = 'choice';
        } else if (inputs.some(function (x) { return x.type === 'textarea' || x.type === 'contenteditable'; })) {
          kind = 'qa';
        } else {
          kind = 'blank';
        }
      }

      if (k.stemLooksEmpty(stem) || norm(stem).length < ctx.minTextLen) continue;
      if ((kind === 'blank' || kind === 'qa') && !inputs.length) continue;
      if ((kind === 'choice' || kind === 'multi' || kind === 'judge') &&
          (options.length < 2 || options.some(function (o) { return !norm(o.text) || /^[A-Z][.、．]?$/i.test(norm(o.text)); }))) continue;

      var q = k.buildQuestion({
        kind: kind,
        root: rootEl,
        anchor: rootEl,
        stem: stem,
        options: options,
        inputs: inputs,
        presetId: 'custom:' + (rule.id || rule.name || 'rule'),
        confidence: 0.85
      });
      out.push(q);
    }
    return out;
  }

  /* ======================================================================
   * 5. scan
   * ==================================================================== */

  function dedupeQuestions(list) {
    // 1) 同 root 取最高置信度
    var byRoot = new Map();
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      if (!q || !q.root) continue;
      var key = q.root;
      var cur = byRoot.get(key);
      if (!cur || q.confidence > cur.confidence ||
          (q.confidence === cur.confidence && (q.options.length + q.inputs.length) > (cur.options.length + cur.inputs.length))) {
        byRoot.set(key, q);
      }
    }
    var uniq = Array.from(byRoot.values());

    // 2) 同 id 取最高置信度
    var byId = new Map();
    for (var j = 0; j < uniq.length; j++) {
      var u = uniq[j];
      var c = byId.get(u.id);
      if (!c || u.confidence > c.confidence) byId.set(u.id, u);
    }
    var stage2 = Array.from(byId.values());

    // 3) 嵌套剪枝：外层容器包含已接受题目时丢弃（避免「整个表单」压过单题）
    stage2.sort(function (a, b) {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return (b.options.length + b.inputs.length) - (a.options.length + a.inputs.length);
    });
    var accepted = [];
    for (var m = 0; m < stage2.length; m++) {
      var cand = stage2[m];
      var conflict = false;
      for (var n = 0; n < accepted.length; n++) {
        var acc = accepted[n];
        if (acc.root === cand.root) { conflict = true; break; }
        var contains = false;
        try { contains = acc.root.contains(cand.root) || cand.root.contains(acc.root); } catch (e) { contains = false; }
        if (contains) { conflict = true; break; }
      }
      if (!conflict) accepted.push(cand);
    }
    return accepted;
  }

  function sortByDocumentOrder(list, order) {
    var withIdx = list.map(function (q, i) {
      return { q: q, idx: orderOf(order, q.root), i: i };
    });
    withIdx.sort(function (a, b) {
      if (a.idx !== b.idx) return a.idx - b.idx;
      return a.i - b.i;
    });
    return withIdx.map(function (x) { return x.q; });
  }

  /**
   * 扫描题目。
   * @param {Document|Element|ShadowRoot} [root]
   * @param {object} [opts] {presets, maxPerPage, viewportOnly, shadowDom, minTextLen, skipAnswered, includeHidden, all}
   * @returns {Array} ADQuestion[]
   */
  function scan(root, opts) {
    var o = opts || {};
    var settings = readSettings();
    var useShadow = o.shadowDom != null ? !!o.shadowDom : settings.detect.shadowDom;
    var viewportOnly = o.viewportOnly != null ? !!o.viewportOnly : settings.detect.viewportOnly;
    var minTextLen = typeof o.minTextLen === 'number' ? o.minTextLen : settings.detect.minTextLen;
    var maxPerPage = typeof o.maxPerPage === 'number' ? o.maxPerPage : settings.mode.maxPerPage;
    var skipAnswered = o.skipAnswered != null ? !!o.skipAnswered : false;

    var doc = (typeof document !== 'undefined') ? document : null;
    var scopeRoot = root || doc;
    if (!scopeRoot) return [];

    var k = kit();
    if (!k) {
      try { AD.warn('Detector.scan: AD.PresetKit 缺失（presets.js 未加载）'); } catch (e) { /* noop */ }
      return [];
    }

    var ctx = {
      minTextLen: Math.max(2, minTextLen),
      viewportOnly: viewportOnly,
      settings: settings,
      shadowDom: useShadow
    };

    var collected = collectScopes(scopeRoot, useShadow);
    var scopes = collected.scopes;
    var order = collected.order;

    var presets = presetsList();
    var enabled = presets.filter(function (p) { return isPresetEnabled(p, settings, o); });

    var raw = [];
    for (var s = 0; s < scopes.length; s++) {
      var scope = scopes[s];
      if (!scope) continue;
      for (var p = 0; p < enabled.length; p++) {
        var preset = enabled[p];
        if (typeof preset.match !== 'function') continue;
        var got = null;
        try {
          got = preset.match(scope, ctx);
        } catch (e) {
          try { AD.warn('preset match failed:', preset.id, e && e.message); } catch (e2) { /* noop */ }
          got = null;
        }
        if (!Array.isArray(got)) continue;
        for (var g = 0; g < got.length; g++) {
          var q = got[g];
          if (!q || !q.root) continue;
          if (!q.presetId) q.presetId = preset.id;
          if (preset.kind && q.kind !== preset.kind && preset.id !== 'choice' && preset.id !== 'multi' && preset.id !== 'judge') {
            // 站点预设的 kind 由结构决定，不做强改
          }
          raw.push(q);
        }
      }

      // 自定义规则
      var rules = settings.detect.customRules || [];
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        if (!rule || rule.enabled === false) continue;
        try {
          var rq = matchCustomRule(rule, scope, ctx);
          for (var r2 = 0; r2 < rq.length; r2++) raw.push(rq[r2]);
        } catch (e3) { /* noop */ }
      }
    }

    // 可见性过滤
    var visible = [];
    for (var v = 0; v < raw.length; v++) {
      var cand = raw[v];
      if (!cand.root) continue;
      var vis = o.includeHidden ? true : isVisible(cand.root, { viewportOnly: viewportOnly });
      if (!vis) {
        // 容器不可见但题干元素可见的情况（例如 root 是隐藏包装层）→ 用 anchor 再判一次
        if (!o.includeHidden && cand.anchor && cand.anchor !== cand.root &&
            isVisible(cand.anchor, { viewportOnly: viewportOnly })) {
          vis = true;
        }
      }
      if (!vis) continue;
      visible.push(cand);
    }

    var deduped = dedupeQuestions(visible);
    var sorted = sortByDocumentOrder(deduped, order);

    if (skipAnswered) {
      sorted = sorted.filter(function (q) { return !q.answered; });
    }

    if (typeof maxPerPage === 'number' && maxPerPage > 0 && sorted.length > maxPerPage) {
      sorted = sorted.slice(0, maxPerPage);
    }

    return sorted;
  }

  /* ======================================================================
   * 6. elementKind / buildFromElement
   * ==================================================================== */

  function kindOfInput(el) {
    var k = kit();
    if (!k) return null;
    if (el.tagName === 'INPUT') {
      var type = String(el.type || '').toLowerCase();
      if (type === 'radio' || type === 'checkbox') {
        var groups = k.optionInputGroups(el.ownerDocument || document);
        for (var i = 0; i < groups.length; i++) {
          var g = groups[i];
          if (g.inputs.indexOf(el) < 0) continue;
          var q = k.analyzeOptionGroup(g.container, g.inputs, { minTextLen: 2 });
          if (q) return q.kind;
          return type === 'radio' ? 'choice' : 'multi';
        }
        return type === 'radio' ? 'choice' : 'multi';
      }
      if (k.isTextField(el)) return 'blank';
      return null;
    }
    if (el.tagName === 'TEXTAREA') return 'qa';
    if (el.tagName === 'SELECT') return 'blank';
    if (el.isContentEditable) return 'qa';
    return null;
  }

  /**
   * 对鼠标下元素判定 kind（快捷键用）。
   * @param {Element} el
   * @returns {string|null}
   */
  function elementKind(el) {
    if (!el || el.nodeType !== 1) return null;
    var k = kit();
    if (!k || k.isIgnored(el) || k.isNavish(el) || !isVisible(el, { viewportOnly: false })) return null;
    var direct = kindOfInput(el);
    if (direct) return direct;


    // 伪选项：先尝试用真实分组（pseudoGroups）拿到准确 kind，再退回结构推断
    if (k.isOptionLike(el)) {
      var pgs = k.pseudoGroups(el.ownerDocument || document);
      for (var i = 0; i < pgs.length; i++) {
        var g = pgs[i];
        var mine = false;
        for (var j = 0; j < g.members.length; j++) {
          if (g.members[j] === el || g.members[j].contains(el) || el.contains(g.members[j])) { mine = true; break; }
        }
        if (!mine) continue;
        var qq = k.analyzeOptionGroup(g.parent, g.members, { minTextLen: 2 });
        if (qq) return qq.kind;
      }
      return 'choice';
    }

    // 从元素向上找题块
    var q2 = buildFromElement(el);
    if (q2) return q2.kind;
    return null;
  }

  /**
   * 把任意元素向上归并成题块（快捷键 Alt+Shift+Q 用）。
   * @param {Element} el
   * @returns {object|null}
   */
  function buildFromElement(el) {
    if (!el || el.nodeType !== 1) return null;
    var k = kit();
    if (!k) return null;
    var doc = el.ownerDocument || document;
    if (el === doc.body || el === doc.documentElement || k.isIgnored(el) || k.isNavish(el) ||
        !isVisible(el, { viewportOnly: false })) return null;

    function localQuestion(q) {
      if (!q || !q.root || q.root === doc.body || q.root === doc.documentElement ||
          k.isIgnored(q.root) || k.isNavish(q.root) || !q.root.contains(el)) return false;
      var targets = (q.options || []).concat(q.inputs || []);
      return targets.some(function (item) {
        if (!item.el || !isVisible(item.el, { viewportOnly: false })) return false;
        const fieldRoot = k.findFieldContainer(item.input || item.el, ctx);
        return fieldRoot && fieldRoot.contains(el);
      });
    }

    var ctx = { minTextLen: 2, viewportOnly: false };
    var siteRoot = el.closest('.examPaper_subject');
    if (siteRoot) {
      return k.analyzeZhihuishu(siteRoot, ctx);
    }
    var node = el;
    var guard = 0;

    // 1) 直接输入项 / 伪选项：先确定一个起点容器
    var start = el;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) {
      var fc = k.findFieldContainer(el, ctx);
      if (fc) start = fc;
    } else if (k.isOptionLike(el)) {
      var p = el.parentElement;
      if (p) start = p;
    }

    node = start;
    guard = 0;
    while (node && node.nodeType === 1 && guard++ < 12) {
      if (node === doc.body || node === doc.documentElement || k.isNavish(node)) break;
      var q = null;
      try {
        q = k.analyzeAuto(node, ctx);
      } catch (e) { q = null; }
      if (localQuestion(q) && norm(q.stem).length >= 2) return q;
      node = node.parentElement;
    }

    // 2) 兜底：用 label / 前兄弟 / 父级文本拼一个最小题块
    var stem = k.fallbackStem(el);
    var direct = kindOfInput(el);
    if (direct && norm(stem) && start !== doc.body && start !== doc.documentElement) {
      var options = [];
      var inputs = [];
      if (direct === 'blank' || direct === 'qa') {
        inputs.push({
          el: el,
          type: el.tagName === 'TEXTAREA' ? 'textarea' : (el.isContentEditable ? 'contenteditable' : 'text'),
          name: el.getAttribute('name') || '',
          placeholder: el.getAttribute('placeholder') || ''
        });
      }
      return k.buildQuestion({
        kind: direct,
        root: start,
        anchor: el,
        stem: stem,
        options: options,
        inputs: inputs,
        presetId: 'element',
        confidence: 0.4
      });
    }
    return null;
  }

  // 被动提示只使用用户启用的规则；结构推断保留给主动拾取和快捷键。
  function questionAt(el) {
    var k = kit();
    if (!el || !k || k.isIgnored(el) || k.isNavish(el)) return null;
    var questions = scan(el.ownerDocument || document, { viewportOnly: true, skipAnswered: false, maxPerPage: 0 });
    for (var i = 0; i < questions.length; i++) {
      var q = questions[i];
      if (q.root && q.root.tagName !== 'BODY' && q.root.tagName !== 'HTML' && q.root.contains(el)) return q;
    }
    return null;
  }

  /* ======================================================================
   * 7. observe
   * ==================================================================== */

  function mutationTouchesForeign(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      var t = m.target;
      if (!t) continue;
      var el = t.nodeType === 1 ? t : t.parentElement;
      if (!el) continue;
      if (isIgnoredNode(el)) continue;             // 自己覆盖层产生的变化 → 忽略
      if (m.type === 'characterData') return true;
      // 只关心元素/文本的增删
      if (m.type === 'attributes') {
        var an = m.attributeName || '';
        if (an === 'style' || an === 'class' || an === 'hidden' || an === 'aria-checked' ||
            an === 'aria-selected' || an === 'checked' || an === 'data-selected') return true;
        continue;
      }
      if (m.addedNodes && m.addedNodes.length) {
        for (var a = 0; a < m.addedNodes.length; a++) {
          var an2 = m.addedNodes[a];
          var ae = an2 && an2.nodeType === 1 ? an2 : (an2 && an2.parentElement);
          if (ae && isIgnoredNode(ae)) continue;
          if (an2 && an2.nodeType === 3 && !norm(an2.nodeValue)) continue;
          return true;
        }
      }
      if (m.removedNodes && m.removedNodes.length) {
        for (var r = 0; r < m.removedNodes.length; r++) {
          var rn = m.removedNodes[r];
          var re = rn && rn.nodeType === 1 ? rn : null;
          if (re && re.id === 'dati-overlay-host') continue;
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 监听 DOM 变化并回调检测结果。
   * @param {(payload:{questions:Array, added:Array, removed:Array})=>void} cb
   * @param {object} [opts] {root, scanOpts, immediate}
   * @returns {function} stop
   */
  function observe(cb, opts) {
    if (typeof cb !== 'function') return function () {};
    var o = opts || {};
    var settings = readSettings();
    var debounce = Math.max(80, settings.mode.scanDebounceMs || 600);
    var minInterval = Math.max(0, settings.mode.minIntervalMs || 0);
    var doc = (typeof document !== 'undefined') ? document : null;
    if (!doc || typeof MutationObserver === 'undefined') return function () {};

    var stopped = false;
    var timer = null;
    var lastRun = 0;
    var prev = new Map();
    var observers = [];

    function currentRoot() {
      return o.root || doc.body || doc.documentElement;
    }

    function attach() {
      var root = currentRoot();
      if (!root) return;
      detach();
      addObserver(root);
      // open shadow roots 一并监听
      var found = [];
      try {
        var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (var i = 0; i < all.length && i < 4000; i++) {
          var shadow = kit() && kit().shadowRootOf(all[i]);
          if (shadow) found.push(shadow);
        }
      } catch (e) { /* noop */ }
      for (var s = 0; s < found.length; s++) addObserver(found[s]);
    }

    function addObserver(target) {
      try {
        var mo = new MutationObserver(onMutations);
        mo.observe(target, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
          attributeFilter: ['class', 'style', 'hidden', 'checked', 'aria-checked', 'aria-selected', 'data-selected']
        });
        observers.push(mo);
      } catch (e) { /* noop */ }
    }

    function detach() {
      for (var i = 0; i < observers.length; i++) {
        try { observers[i].disconnect(); } catch (e) { /* noop */ }
      }
      observers = [];
    }

    function run() {
      if (stopped) return;
      timer = null;
      lastRun = Date.now();
      var questions = [];
      try {
        questions = scan(currentRoot(), o.scanOpts || {});
      } catch (e) {
        try { AD.warn('observe scan failed:', e && e.message); } catch (e2) { /* noop */ }
        questions = [];
      }
      var next = new Map();
      for (var i = 0; i < questions.length; i++) next.set(questions[i].id, questions[i]);
      var added = [];
      var removed = [];
      next.forEach(function (q, id) { if (!prev.has(id)) added.push(q); });
      prev.forEach(function (q, id) { if (!next.has(id)) removed.push(q); });
      prev = next;
      try {
        cb({ questions: questions, added: added, removed: removed });
      } catch (e3) {
        try { AD.warn('observe cb failed:', e3 && e3.message); } catch (e4) { /* noop */ }
      }
    }

    function schedule() {
      if (stopped) return;
      if (timer) return;
      var since = Date.now() - lastRun;
      var wait = debounce;
      if (since < minInterval) wait = Math.max(debounce, minInterval - since);
      timer = setTimeout(function () {
        // 重新绑定（页面可能新增 shadow root / 重绘根节点）
        attach();
        run();
        armAnimationWatch();
      }, wait);
    }

    /**
     * 入场动画兼容：很多站点（如 stagger/淡入）初始 opacity:0，
     * CSS 动画不会触发 MutationObserver，动画结束后若不重扫就会永远漏检。
     * 这里在每次扫描后监听该帧的 animation/transition，结束后补一次扫描。
     */
    function armAnimationWatch() {
      if (stopped) return;
      var root = currentRoot();
      if (!root || !root.getAnimations) return;
      var pending = [];
      try {
        var anims = root.getAnimations({ subtree: true });
        for (var i = 0; i < anims.length; i++) {
          var a = anims[i];
          if (a && a.pending !== true && a.playState === 'running') pending.push(a);
        }
      } catch (e) { return; }
      if (!pending.length) return;
      var fired = false;
      var fire = function () {
        if (fired || stopped) return;
        fired = true;
        schedule();
      };
      // 任一动画结束就补扫；同时兜一个上限（动画总时长可能很长）
      var maxDur = 0;
      for (var j = 0; j < pending.length; j++) {
        try {
          var ev = pending[j].effect && pending[j].effect.getTiming ? pending[j].effect.getTiming() : null;
          var dur = (ev && (ev.duration || 0)) || 0;
          var delay = (ev && (ev.delay || 0)) || 0;
          maxDur = Math.max(maxDur, (typeof dur === 'number' ? dur : 0) + delay);
        } catch (e) { /* noop */ }
        try { pending[j].addEventListener('finish', fire, { once: true }); } catch (e) { /* noop */ }
      }
      setTimeout(fire, Math.min(4000, Math.max(400, maxDur + 250)));
    }

    function onMutations(mutations) {
      if (stopped) return;
      if (!mutationTouchesForeign(mutations)) return;
      schedule();
    }

    attach();
    doc.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    window.addEventListener('hashchange', schedule);
    window.addEventListener('popstate', schedule);
    doc.addEventListener('visibilitychange', schedule);
    if (o.immediate) run();

    return function stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      detach();
      doc.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('hashchange', schedule);
      window.removeEventListener('popstate', schedule);
      doc.removeEventListener('visibilitychange', schedule);
      prev = new Map();
    };
  }

  /* ======================================================================
   * 8. 导出
   * ==================================================================== */

  AD.Detector = {
    scan: scan,
    observe: observe,
    isVisible: isVisible,
    elementKind: elementKind,
    buildFromElement: buildFromElement,
    questionAt: questionAt,

    // 附加工具（非契约，供 content.js / fixture 使用）
    version: 1,
    readSettings: readSettings,
    isIgnoredNode: isIgnoredNode,
    isPresetEnabled: isPresetEnabled
  };
}(globalThis.AD = globalThis.AD || {}));
