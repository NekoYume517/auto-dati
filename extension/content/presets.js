/**
 * AutoDati · 检测预设（AD.PRESETS / AD.PresetKit）
 *
 * 经典脚本：无 import/export，只挂载 globalThis.AD。
 * 依赖：AD.hash / AD.clamp（common/protocol.js）；不依赖 chrome.*，可在普通页面直接运行。
 *
 * 设计要点
 *  1) 所有预设统一走「容器 → 选项/输入 → 题干」三步，避免每个站点各写一套玩具规则。
 *  2) 选项既支持 input[type=radio|checkbox]（含 label 包裹），也支持纯 div 伪选项（问卷星/智慧树等）。
 *  3) 题干提取 = 容器文本 − 选项分支文本，再剥掉「1.」「（1）」「第1题」等编号。
 *  4) 自动扫描只注册经过验证的站点规则；通用结构推断仅供用户手动拾取。
 */
(function (AD) {
  'use strict';

  if (!AD) return;

  /* ======================================================================
   * 0. 常量与正则
   * ==================================================================== */

  var OPTION_INPUT_SEL = 'input[type="radio"], input[type="checkbox"]';
  var TEXT_INPUT_SEL = 'input';
  var SELECT_SEL = 'select';
  var TEXTAREA_SEL = 'textarea';
  var EDITABLE_SEL = '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';

  /** 这些 input 永远不当成答题输入 */
  var BAD_INPUT_TYPES = {
    hidden: 1, submit: 1, button: 1, reset: 1, file: 1, image: 1, range: 1, color: 1,
    password: 1, search: 1, date: 1, time: 1, 'datetime-local': 1, month: 1, week: 1,
    radio: 1, checkbox: 1
  };
  var GOOD_TEXT_TYPES = { text: 1, number: 1, tel: 1, email: 1, url: 1, '': 1 };

  /** 看起来像题块的 class 片段 */
  var QUESTION_CLASS_RE = /(question|subject|exam|problem|timu|ti[-_]?mu|topic|quiz|stem|field|answer[-_]?(wrap|area|list)|q[-_]?item|paper|test[-_]?item)/i;
  /** 导航/页脚等噪声容器 */
  var NAV_CLASS_RE = /(^|[\s_-])(nav|navbar|menu|sidebar|breadcrumb|pagination|pager|tabbar|tabs|footer|header|toolbar|comment|comments|reply|advert|advertisement|ads|share|social|login[-_]?bar)([\s_-]|$)/i;

  /** 伪选项候选（叶子再过滤） */
  var PSEUDO_SEL = [
    '[class*="option"]', '[class*="Option"]', '[class*="OPTION"]',
    '[class*="answer"]', '[class*="Answer"]',
    '[class*="choice"]', '[class*="Choice"]',
    '[class*="xuanxiang"]', '[class*="XuanXiang"]',
    '[class*="opt-"]', '[class*="opt_"]',
    '[class*="radio"]', '[class*="Radio"]',
    '[class*="checkbox"]', '[class*="Checkbox"]',
    '[class*="select-item"]', '[class*="selectItem"]',
    '[role="radio"]', '[role="checkbox"]', '[role="option"]',
    'li'
  ].join(',');

  var JUDGE_TRUE = ['对', '正确', '是', '√', '✓', '✔', '☑', 't', 'true', 'yes', 'y', '对的', '正确的', '正解', '√对'];
  var JUDGE_FALSE = ['错', '错误', '否', '×', '✗', '✘', '☒', 'f', 'false', 'no', 'n', '不对', '错的', '不正确', '×错'];

  var KIND_HINTS = [
    { kind: 'multi', re: /(多项选择|多选|不定项|选出所有|全部符合|所有正确|至少两项)/ },
    { kind: 'judge', re: /(判断题|判断正误|是否正确|对错|请判断)/ },
    { kind: 'blank', re: /(填空题|请填写|填入|填空)/ },
    { kind: 'qa', re: /(简答题|问答题|论述题|名词解释|案例分析|计算题|请简述|请说明|请分析|请论述|综合题)/ },
    { kind: 'choice', re: /(单项选择|单选|选择一个|最恰当|最合适)/ }
  ];

  /* ======================================================================
   * 1. 文本与 DOM 基础工具
   * ==================================================================== */

  function norm(s) {
    if (s == null) return '';
    return String(s)
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200b-\u200f\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function txt(el) {
    if (!el) return '';
    var s = '';
    try {
      s = (typeof el.innerText === 'string' && el.innerText !== '') ? el.innerText : el.textContent;
    } catch (e) {
      s = el.textContent || '';
    }
    // innerText 会应用 CSS text-transform，可能把 \\frac / \\lim 甚至变量大小写改坏。
    // 公式使用原始文本节点读取，保留 LaTeX 的大小写与反斜线。
    if (/\\[([]|\\(?:frac|lim|sum|int|begin)\b|\$\$/.test(el.textContent || '')) s = composedText(el);
    // 智慧树的题干组件使用 mode:closed，innerText/textContent 均读不到。
    // 使用浏览器提供给扩展的 DOM API，不改写宿主页的 attachShadow。
    var roots = [el].concat(all(el, '*'));
    if (roots.some(function (node) { return !!shadowRootOf(node); })) {
      s = composedText(el);
    }
    return norm(s);
  }

  function shadowRootOf(el) {
    if (!el || el.nodeType !== 1 || isIgnored(el)) return null;
    try {
      var settings = AD.Settings && AD.Settings.snapshot && AD.Settings.snapshot();
      if (settings && settings.detect && settings.detect.shadowDom === false) return null;
      if (el.shadowRoot) return el.shadowRoot;
      if (typeof chrome !== 'undefined' && chrome.dom && chrome.dom.openOrClosedShadowRoot) {
        return chrome.dom.openOrClosedShadowRoot(el);
      }
    } catch (e) { /* 非扩展环境只支持 open shadow root */ }
    return null;
  }

  function composedText(root) {
    var count = 0;
    function walk(node, depth) {
      if (!node || depth > 100 || ++count > 10000) return '';
      if (node.nodeType === 3) return node.nodeValue || '';
      if (node.nodeType === 1 && (/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(node.tagName) ||
          isIgnored(node) || node.hidden || (node.style && node.style.display === 'none'))) return '';
      var content = shadowRootOf(node) || node;
      return Array.prototype.map.call(content.childNodes || [], function (child) { return walk(child, depth + 1); }).join(' ');
    }
    return norm(walk(root, 0));
  }

  function all(root, sel) {
    if (!root || !root.querySelectorAll) return [];
    try {
      return Array.prototype.slice.call(root.querySelectorAll(sel));
    } catch (e) {
      return [];
    }
  }

  function classStr(el) {
    if (!el || el.nodeType !== 1) return '';
    var c = el.className;
    if (typeof c === 'string') return c;
    if (c && typeof c.baseVal === 'string') return c.baseVal;
    return el.getAttribute('class') || '';
  }

  function isIgnored(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (el.closest('[data-dati-ignore], #dati-overlay-host, .dati-root, .dati-overlay')) return true;
    } catch (e) { /* noop */ }
    return false;
  }

  function isNavish(el) {
    var n = el, guard = 0;
    while (n && n.nodeType === 1 && guard++ < 5) {
      var tag = n.tagName;
      if (tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER' || tag === 'ASIDE') return true;
      if (NAV_CLASS_RE.test(classStr(n))) return true;
      var role = n.getAttribute('role') || '';
      if (role === 'navigation' || role === 'banner' || role === 'contentinfo') return true;
      n = n.parentElement;
    }
    return false;
  }

  function rectOf(el) {
    var r = { x: 0, y: 0, w: 0, h: 0 };
    if (!el || !el.getBoundingClientRect) return r;
    try {
      var b = el.getBoundingClientRect();
      r.x = Math.round(b.left);
      r.y = Math.round(b.top);
      r.w = Math.round(b.width);
      r.h = Math.round(b.height);
    } catch (e) { /* noop */ }
    return r;
  }

  /** 元素唯一键（用于分组，不污染 DOM） */
  var keySeq = 0;
  var keyMap = typeof WeakMap === 'function' ? new WeakMap() : null;
  function elKey(el) {
    if (!el) return 'null';
    if (!keyMap) return 'k' + (keySeq++);
    var k = keyMap.get(el);
    if (!k) {
      k = 'e' + (++keySeq);
      keyMap.set(el, k);
    }
    return k;
  }

  function letterFromIndex(i) {
    if (i < 26) return String.fromCharCode(65 + i);
    return String(i + 1);
  }

  function clamp(v, a, b) {
    if (typeof AD.clamp === 'function') return AD.clamp(v, a, b);
    v = Number(v);
    if (!isFinite(v)) v = a;
    return Math.min(b, Math.max(a, v));
  }

  /* ---------------------------- 文本清洗 ---------------------------- */

  /**
   * 题型词基（不带「题」后缀，后缀由调用处可选拼接）。
   * 覆盖：单项选择 / 多项选择 / 不定项选择 / 选择 / 单选 / 多选 / 判断 / 填空 /
   *       简答 / 问答 / 论述 / 计算 / 名词解释 / 分析 / 综合 / 是非 / 正误 / 辨析 / 材料
   */
  var KIND_WORD = '(?:单项选择|多项选择|不定项选择|单项|多项|选择|单选|多选|判断|填空|简答|问答|论述|计算|名词解释|分析|综合|是非|正误|辨析|材料)';

  var STEM_PREFIX_RES = [
    /^\s*第\s*[0-9一二三四五六七八九十百]{1,4}\s*题\s*[\.、．:：\)）]?\s*/,
    /^\s*[\(（]\s*[0-9]{1,3}\s*[\)）]\s*/,
    /^\s*[0-9]{1,3}\s*[\.、．\)）:：]\s*/,
    /^\s*[\(（]\s*[一二三四五六七八九十]{1,3}\s*[\)）]\s*/,
    /^\s*[一二三四五六七八九十]{1,3}\s*[、\.．\)）]\s*/,
    /^\s*[\(（]\s*[0-9]{1,3}(?:\.[0-9])?\s*分\s*[\)）]\s*/,
    /^\s*[\[【]\s*[^\]】]{1,12}\s*[\]】]\s*/,
    /^\s*[0-9]{1,3}\s*[\.、．]\s*(?=[\(（]?\s*[0-9]{1,2}\s*分)/,
    // 题型前缀 + 编号：「单选题 10. 」「多选题 3、」「判断题 2」
    new RegExp('^\\s*' + KIND_WORD + '\\s*题?\\s*[0-9]{1,3}\\s*[\\.、．\\)）:：]?\\s*'),
    // 题型前缀 + 分隔符：「单选题：」「单选、」
    new RegExp('^\\s*' + KIND_WORD + '\\s*题?\\s*[:：、]\\s*'),
    // 题型前缀 + 空白：「单选题 在 CSS 中…」
    new RegExp('^\\s*' + KIND_WORD + '\\s*题?\\s+(?=\\S)')
  ];

  /** 去掉题干编号：「1.」「1、」「（1）」「第1题」「一、」「【单选题】」「(5分)」 */
  function stripStem(s) {
    var t = norm(s);
    for (var round = 0; round < 4; round++) {
      var hit = false;
      for (var i = 0; i < STEM_PREFIX_RES.length; i++) {
        var next = t.replace(STEM_PREFIX_RES[i], '');
        if (next !== t && norm(next).length >= 2) {
          t = norm(next);
          hit = true;
        }
      }
      if (!hit) break;
    }
    return t;
  }

  /**
   * 题干质量守卫：剥掉编号/类型标签后只剩「单选题 (2分)」「判断题」这类
   * 纯元信息的，视为题干未渲染（Vue 异步站点常见），不应出题。
   */
  var STEM_META_ONLY_RE = /^【?(单选题|多选题|判断题|填空题|问答题|简答题|论述题|单选|多选|判断|不定项选择题?)】?(\s*[（(]\s*\d+\s*分\s*[)）])?$/;

  function stemLooksEmpty(stem) {
    var t = stripStem(norm(stem));
    if (!t) return true;
    if (STEM_META_ONLY_RE.test(t)) return true;
    // 剥完类型标签后长度 < 4 且不含实际内容
    var stripped = t
      .replace(/【[^】]*】/g, '')
      .replace(/[（(]\s*\d+\s*分\s[))]|[（(]\s*\d+\s*分\s*[))]/g, '')
      .replace(/(单选题|多选题|判断题|填空题|问答题|简答题|论述题|单选|多选|判断|不定项选择题?)/g, '')
      .replace(/[\s\d.、分（）()]/g, '');
    return stripped.length < 2;
  }

  var OPT_LETTER_RES = [
    /^\s*[\(（\[【]\s*([A-Za-z])\s*[\)）\]】]\s*[\.、．:：,，]?\s*/,
    /^\s*([A-Za-z])\s*[\.、．\)）:：,，]\s*/,
    /^\s*([A-Za-z])\s+(?=[^\s])/
  ];
  var OPT_NUM_RES = [
    /^\s*[\(（]\s*([0-9]{1,2})\s*[\)）]\s*[\.、．:：]?\s*/,
    /^\s*([0-9]{1,2})\s*[\.、．\)）:：]\s*/
  ];

  /** 剥掉选项字母前缀：「A. 」「A、」「(A)」「[A]」「A）」「A 选项」 */
  function stripOptionLabel(s) {
    var t = norm(s);
    for (var i = 0; i < OPT_LETTER_RES.length; i++) {
      var m = t.match(OPT_LETTER_RES[i]);
      if (m) {
        var rest = norm(t.slice(m[0].length));
        if (rest) return { label: m[1].toUpperCase(), text: rest };
        return { label: m[1].toUpperCase(), text: t };
      }
    }
    for (var j = 0; j < OPT_NUM_RES.length; j++) {
      var n = t.match(OPT_NUM_RES[j]);
      if (n) {
        var rest2 = norm(t.slice(n[0].length));
        if (rest2) return { label: n[1], text: rest2 };
      }
    }
    return { label: '', text: t };
  }

  /**
   * 结构化选项文本：很多站点把「A」和「Cache-Control」放在两个并排 span 里，
   * innerText 会把它们粘成 "ACache-Control"。此时把首个子元素的单字母当 label，
   * 其余子元素文本拼成选项正文。
   * @returns {{label:string, text:string}|null} 无法结构化拆分时返回 null
   */
  function splitLabelNode(branch) {
    if (!branch || branch.nodeType !== 1) return null;
    var kids = branch.children;
    if (!kids || kids.length < 2) return null;
    var first = kids[0];
    var ft = norm(txt(first));
    if (!/^[A-Za-z]$/.test(ft)) return null;
    var restParts = [];
    for (var i = 1; i < kids.length; i++) {
      var t = norm(txt(kids[i]));
      if (t) restParts.push(t);
    }
    // 首个子元素之外的直接文本节点也算
    for (var n = branch.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        var d = norm(n.nodeValue);
        if (d) restParts.push(d);
      }
    }
    var rest = norm(restParts.join(' '));
    if (!rest) return null;
    return { label: ft.toUpperCase(), text: rest };
  }

  function hasLetterPrefix(s) {
    var t = norm(s);
    for (var i = 0; i < OPT_LETTER_RES.length; i++) {
      if (OPT_LETTER_RES[i].test(t)) return true;
    }
    return false;
  }

  /** 判断题选项归一化：对 / 错 / '' */
  function judgeNorm(s) {
    var t = norm(s).toLowerCase();
    if (!t) return '';
    var p = stripOptionLabel(t);
    if (p.label) t = p.text.toLowerCase();
    t = t.replace(/[\s。\.\!！,，;；:：、]/g, '');
    if (!t) return '';
    // 精确匹配优先
    if (JUDGE_TRUE.indexOf(t) >= 0) return '对';
    if (JUDGE_FALSE.indexOf(t) >= 0) return '错';
    // 含糊匹配仅当文本非常短（≤4 字符）且是纯对错词的变体，
    // 防止「完成率」「第1部分」「12345678」这类答题卡文本被误判成判断题。
    if (t.length <= 4 && !/[0-9]/.test(t)) {
      for (var i = 0; i < JUDGE_FALSE.length; i++) {
        if (JUDGE_FALSE[i].length >= 2 && t === JUDGE_FALSE[i]) return '错';
      }
      for (var j = 0; j < JUDGE_TRUE.length; j++) {
        if (JUDGE_TRUE[j].length >= 2 && t === JUDGE_TRUE[j]) return '对';
      }
      // 带修饰词的组合（「完全正确」「完全错误」）
      if (/^(完全|绝对|大致|大概|基本)?(正确|对)$/.test(t)) return '对';
      if (/^(完全|绝对|大致|大概|基本)?(错误|错)$/.test(t)) return '错';
    }
    return '';
  }

  /** 从题干推断 kind */
  function kindHint(stem) {
    var t = norm(stem);
    if (!t) return '';
    for (var i = 0; i < KIND_HINTS.length; i++) {
      if (KIND_HINTS[i].re.test(t)) return KIND_HINTS[i].kind;
    }
    return '';
  }

  /* --------------------------- 文本排除 --------------------------- */

  /**
   * 收集 root 的文本，但跳过 skip 集合中的子树。
   */
  function textExcluding(root, skip) {
    if (!root) return '';
    var out = [];
    (function walk(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        out.push(node.nodeValue);
        return;
      }
      if (node.nodeType !== 1) return;
      if (skip && skip.has(node)) return;
      var tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'SVG') return;
      if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return;
      for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
    })(root);
    return norm(out.join(' '));
  }

  function countMembersIn(el, members) {
    var n = 0;
    for (var i = 0; i < members.length; i++) {
      if (el === members[i] || el.contains(members[i])) n++;
    }
    return n;
  }

  /**
   * 选项分支：从成员向上找到「只包含它自己」的最大祖先（不含 container）。
   * 这样 input 在 label/li 里时，整段 label 文本都会被当作选项文本排除出题干。
   */
  function branchOf(member, container, members) {
    var b = member;
    var n = member;
    var guard = 0;
    while (n && n.parentElement && n.parentElement !== container && guard++ < 12) {
      var p = n.parentElement;
      if (countMembersIn(p, members) > 1) break;
      b = p;
      n = p;
    }
    return b;
  }

  function stemWith(container, members, mergeBranch, noStrip) {
    var skip = new Set();
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      if (!container.contains(m)) continue;
      var b = mergeBranch ? branchOf(m, container, members) : m;
      if (b && b !== container) skip.add(b);
    }
    var t = textExcluding(container, skip);
    return noStrip ? t : stripStem(t);
  }

  /**
   * 题干提取：逐级向上尝试「排除选项分支」与「只排除成员自身」两种策略，
   * 取第一个长度达标的；都不达标则取最长的那个。
   * 返回 {root, stem（已剥编号）, raw（未剥，供题型推断）, mode}
   */
  function stemFor(container, members, minLen) {
    var need = Math.max(2, Number(minLen) || 2);
    var el = container;
    var guard = 0;
    var best = { root: container, stem: '', raw: '', mode: 'none' };
    while (el && el.nodeType === 1 && guard++ < 8) {
      var inside = true;
      for (var i = 0; i < members.length; i++) {
        if (!el.contains(members[i])) { inside = false; break; }
      }
      if (!inside) break;
      var a = stemWith(el, members, true);
      if (a.length >= need) {
        return { root: el, stem: a, raw: stemWith(el, members, true, true), mode: 'branch' };
      }
      var b = stemWith(el, members, false);
      if (b.length > best.stem.length) {
        best = { root: el, stem: b, raw: stemWith(el, members, false, true), mode: 'self' };
      }
      el = el.parentElement;
    }
    return best;
  }

  /* ======================================================================
   * 2. 选项识别
   * ==================================================================== */

  function countType(el, type) {
    var n = 0;
    var list = all(el, 'input[type="' + type + '"]');
    for (var i = 0; i < list.length; i++) if (!list[i].disabled) n++;
    return n;
  }

  /** 从某个选项 input 向上找「最低的、包含 ≥2 个同类 input 的祖先」 */
  function groupAnchor(inp, type) {
    var doc = inp.ownerDocument || document;
    var el = inp.parentElement;
    var guard = 0;
    while (el && el !== doc.body && el !== doc.documentElement && guard++ < 20) {
      if (countType(el, type) >= 2) return el;
      el = el.parentElement;
    }
    return null;
  }

  /** 多个节点的最低公共祖先（含边界检查） */
  function lowestCommonAncestor(nodes) {
    if (!nodes || !nodes.length) return null;
    var lca = nodes[0];
    for (var i = 1; i < nodes.length; i++) {
      var n = nodes[i];
      var guard = 0;
      while (lca && !lca.contains(n) && guard++ < 40) lca = lca.parentElement;
      if (!lca) return null;
    }
    return lca;
  }

  /** 按 name / 结构把 radio、checkbox 分组 */
  function optionInputGroups(root) {
    var inputs = all(root, OPTION_INPUT_SEL).filter(function (inp) {
      if (inp.disabled) return false;
      if (isIgnored(inp)) return false;
      var role = inp.getAttribute('role') || '';
      if (role === 'switch') return false;
      return true;
    });
    var groups = [];
    var map = new Map();
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      var type = (inp.type || '').toLowerCase();
      var name = (inp.getAttribute('name') || '').trim();
      var key;
      if (name) {
        key = 'n|' + type + '|' + name + '|' + (inp.form ? elKey(inp.form) : '-');
      } else {
        var anchor = groupAnchor(inp, type);
        key = 'a|' + type + '|' + elKey(anchor || inp.parentElement);
      }
      var g = map.get(key);
      if (!g) {
        g = { key: key, type: type, name: name, inputs: [], container: null };
        map.set(key, g);
        groups.push(g);
      }
      g.inputs.push(inp);
    }
    // 计算每组容器：最低公共祖先（向上再收一层，把题干圈进来）
    for (var k = 0; k < groups.length; k++) {
      var grp = groups[k];
      var lca = lowestCommonAncestor(grp.inputs);
      var doc = (grp.inputs[0] && grp.inputs[0].ownerDocument) || document;
      var up = lca ? lca.parentElement : null;
      // 只有当上层的 input 数量没变（说明没有跨题混入）时才向上收
      if (up && up !== doc.body && up !== doc.documentElement) {
        var cntUp = up.querySelectorAll(OPTION_INPUT_SEL).length;
        if (cntUp === grp.inputs.length) lca = up;
      }
      grp.container = lca || (grp.inputs[0] ? grp.inputs[0].parentElement : null);
    }
    return groups.filter(function (g) { return g.inputs.length >= 2; });
  }

  /** 明显不是题目的容器（答题卡/计时器/页脚/评分/统计等） */
  var NON_QUESTION_RE = /(answer[-_]?card|answerCard|time[-_]?countdown|countdown|remaining|剩余时间|完成率|答题卡|倒计时|progress[-_]?bar|score[-_]?panel|pagination|pager|page[-_]?num|breadcrumb|copyright|beian|icp|footer|sidebar|toc|catalog|chapter[-_]?list|nav[-_]?tab|player[-_]?control|video[-_]?control|danmu|comment[-_]?list|ranking|leaderboard|statistic)/i;

  function isOptionLike(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'OPTION') return false;
    if (tag === 'A' && el.getAttribute('href')) return false;
    // 纯数字 / 单字符 / 序号：几乎不可能是选项正文（答题卡题号、分页数字）
    var t = txt(el);
    if (!t || t.length > 300) return false;
    if (/^[0-9]+$/.test(t.replace(/\s/g, ''))) return false;
    if (t.length <= 2 && !hasLetterPrefix(t)) return false;
    // 容器或祖先带答题卡/计时器类名 → 排除
    var scope = el;
    var guard = 0;
    while (scope && scope.nodeType === 1 && guard++ < 4) {
      if (NON_QUESTION_RE.test(classStr(scope))) return false;
      scope = scope.parentElement;
    }
    if (el.querySelector('input[type="radio"], input[type="checkbox"]')) return true;
    var role = el.getAttribute('role') || '';
    if (role === 'radio' || role === 'checkbox' || role === 'option') return true;
    var cls = classStr(el);
    if (/(option|answer|choice|xuanxiang|opt[-_]|select[-_]?item|ui[-_]?radio|ui[-_]?checkbox)/i.test(cls)) return true;
    if (hasLetterPrefix(t)) return true;
    return false;
  }

  /** 伪选项组（同一父级 ≥2 个选项型子元素才算一组；去掉包含其它组成员的外层） */
  function pseudoGroups(root) {
    var list = all(root, PSEUDO_SEL);
    var cands = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (isIgnored(el)) continue;
      // 内含 radio/checkbox 的交给 optionInputGroups，避免重复
      if (el.querySelector(OPTION_INPUT_SEL)) continue;
      if (el.tagName === 'INPUT' || el.tagName === 'LABEL' || el.tagName === 'OPTION') continue;
      if (el.tagName === 'SELECT' || el.tagName === 'OPTGROUP') continue;
      if (!isOptionLike(el)) continue;
      cands.push(el);
    }

    var byParent = new Map();
    for (var j = 0; j < cands.length; j++) {
      var p = cands[j].parentElement;
      if (!p) continue;
      if (p.tagName === 'SELECT' || p.tagName === 'OPTGROUP') continue;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(cands[j]);
    }

    var groups = [];
    byParent.forEach(function (members, parent) {
      if (members.length >= 2) groups.push({ parent: parent, members: members });
    });
    if (groups.length < 2) return groups;

    // 去掉「嵌在别的选项内部」的内层组：例如 .option-list > .option-item > (.option-label + .option-text)
    // 内层组的 parent 落在外层组的某个 member 上（或其中）→ 丢弃内层，保留外层。
    return groups.filter(function (g) {
      for (var b = 0; b < groups.length; b++) {
        if (groups[b] === g) continue;
        var om = groups[b].members;
        for (var c = 0; c < om.length; c++) {
          var outer = om[c];
          if (outer === g.parent) return false;          // 内层组正好长在外层选项里
          if (outer.contains && outer.contains(g.parent)) return false;
        }
      }
      return true;
    });
  }

  function isMarkedSelected(el) {
    if (!el || el.nodeType !== 1) return false;
    var nodes = [el];
    var kids = el.querySelectorAll('[class], [aria-checked], [data-selected]');
    for (var i = 0; i < kids.length && i < 8; i++) nodes.push(kids[i]);
    for (var k = 0; k < nodes.length; k++) {
      var n = nodes[k];
      if (!n.getAttribute) continue;
      if (n.getAttribute('aria-checked') === 'true') return true;
      if (n.getAttribute('aria-selected') === 'true') return true;
      if (n.getAttribute('data-selected') === 'true') return true;
      var cls = classStr(n);
      if (/(^|[\s_-])(selected|is-selected|checked|is-checked|onChecked|choosed|chosen|current)([\s_-]|$)/i.test(cls)) return true;
    }
    return false;
  }

  /* ======================================================================
   * 3. 题目构建
   * ==================================================================== */

  function qid(q) {
    var parts = [q.kind || '', q.stem || ''];
    var opts = q.options || [];
    for (var i = 0; i < opts.length; i++) parts.push((opts[i].label || '') + '.' + (opts[i].text || ''));
    var ins = q.inputs || [];
    for (var j = 0; j < ins.length; j++) {
      parts.push((ins[j].type || '') + ':' + (ins[j].name || '') + ':' + (ins[j].placeholder || ''));
    }
    var fn = typeof AD.hash === 'function' ? AD.hash : function (s) { return String(s.length); };
    return 'q_' + fn(parts.join('|'));
  }

  function isAnswered(q) {
    if (!q) return false;
    var opts = q.options || [];
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      if (o.input && o.input.checked) return true;
      if (o.checked) return true;
      if (o.el && isMarkedSelected(o.el)) return true;
    }
    var ins = q.inputs || [];
    for (var j = 0; j < ins.length; j++) {
      var it = ins[j];
      var el = it.el;
      if (!el) continue;
      if (it.type === 'select') {
        if (el.selectedIndex >= 0 && el.options && el.options[el.selectedIndex]) {
          var ot = norm(el.options[el.selectedIndex].textContent);
          if (el.value && !/^(请选择|请选|--|-|全部|不限)/.test(ot)) return true;
        }
      } else if (it.type === 'contenteditable') {
        if (norm(el.textContent).length > 0) return true;
      } else if (norm(el.value).length > 0) {
        return true;
      }
    }
    return false;
  }

  function buildQuestion(spec) {
    var q = {
      id: '',
      kind: spec.kind || 'generic',
      root: spec.root || null,
      anchor: spec.anchor || spec.root || null,
      stem: norm(spec.stem),
      options: spec.options || [],
      inputs: spec.inputs || [],
      presetId: spec.presetId || '',
      confidence: clamp(spec.confidence == null ? 0.5 : spec.confidence, 0.01, 0.99),
      rect: rectOf(spec.anchor || spec.root),
      answered: false
    };
    q.id = qid(q);
    q.answered = isAnswered(q);
    return q;
  }

  /* ======================================================================
   * 4. 容器分析：选项组
   * ==================================================================== */

  function isJudgePair(options) {
    if (options.length !== 2) return false;
    var a = judgeNorm(options[0].text);
    var b = judgeNorm(options[1].text);
    return !!a && !!b && a !== b;
  }

  function analyzeOptionGroup(container, members, ctx) {
    if (!container || !members || members.length < 2) return null;
    if (isIgnored(container) || isNavish(container)) return null;
    // 站点专用结构交给站点预设处理（避免内置预设用类型标签凑题干造成重复/误判）
    try {
      if (container.closest && container.closest('.examPaper_subject')) return null;
    } catch (e) { /* noop */ }

    var isInput = members[0].tagName === 'INPUT';
    var inputType = isInput ? String(members[0].type || '').toLowerCase() : '';

    var stemInfo = stemFor(container, members, ctx.minTextLen);
    var stem = stemInfo.stem;
    if (norm(stem).length < ctx.minTextLen) return null;
    // 题干只是类型标签（Vue 未渲染完）→ 不出题
    if (stemLooksEmpty(stem)) return null;

    var options = [];
    var lettered = 0;
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      var branch = isInput ? branchOf(m, stemInfo.root || container, members) : m;
      if (!branch || branch.nodeType !== 1) branch = m;
      var raw = txt(branch);
      // 结构化拆分优先（「A」与选项正文分处不同子节点的站点）
      var split = splitLabelNode(branch);
      var parsed = split || stripOptionLabel(raw);
      if (parsed.label) lettered++;
      var input = null;
      if (isInput) input = m;
      else {
        input = branch.querySelector('input[type="radio"], input[type="checkbox"]');
      }
      var checked = false;
      if (input) checked = !!input.checked;
      else checked = isMarkedSelected(branch);
      var label = parsed.label || letterFromIndex(i);
      var text = parsed.text || raw || ('选项' + (i + 1));
      options.push({
        label: label,
        text: text,
        el: branch,
        input: input || null,
        checked: checked
      });
    }

    // 选项全空 / 全是同一段文字 → 不是选项组
    var texts = options.map(function (o) { return o.text; });
    var uniq = {};
    for (var u = 0; u < texts.length; u++) uniq[texts[u]] = 1;
    if (Object.keys(uniq).length < 2 && !lettered) return null;

    var kind;
    if (isInput) {
      kind = inputType === 'checkbox' ? 'multi' : 'choice';
    } else {
      var sig = classStr(container) + ' ' + classStr(members[0]);
      kind = /(checkbox|multi|多选)/i.test(sig) ? 'multi' : 'choice';
    }

    // 题干提示词（含被剥掉的「单选题」「【多选】」等类型前缀）
    var hint = kindHint(stem) || kindHint(stemInfo.raw || '');
    if (hint === 'multi' && !isInput) kind = 'multi';
    // 判断题：结构（两个 对/错 选项）优先于提示词；提示词为 judge 时也认
    if (isJudgePair(options)) kind = 'judge';
    else if (hint === 'judge' && options.length === 2) kind = 'judge';
    // radio 组里题干明确说「多选」→ 不改成 multi（radio 天然单选），保持 choice
    if (isInput && inputType === 'radio' && kind === 'multi') kind = 'choice';

    var conf = 0.6;
    if (isInput) conf += 0.06;
    if (lettered >= Math.min(options.length, 2)) conf += 0.09;
    if (QUESTION_CLASS_RE.test(classStr(container))) conf += 0.06;
    if (hint && hint === kind) conf += 0.07;
    if (kind === 'judge' && options.length === 2) conf += 0.09;
    if (options.length >= 3) conf += 0.03;
    if (kind === 'multi' && options.length < 3 && !lettered && !QUESTION_CLASS_RE.test(classStr(container))) conf -= 0.18;
    if (container.tagName === 'BODY' || container.tagName === 'FORM' || container.tagName === 'HTML') conf -= 0.16;

    return buildQuestion({
      kind: kind,
      root: stemInfo.root || container,
      anchor: stemInfo.root || container,
      stem: stem,
      options: options,
      inputs: [],
      presetId: '',
      confidence: conf
    });
  }

  /* ======================================================================
   * 5. 容器分析：填空 / 大题 / 通用表单
   * ==================================================================== */

  function isTextField(inp) {
    if (!inp || inp.tagName !== 'INPUT') return false;
    if (inp.disabled || inp.readOnly) return false;
    var type = String(inp.type || '').toLowerCase();
    if (BAD_INPUT_TYPES[type]) return false;
    if (!GOOD_TEXT_TYPES[type]) return false;
    return true;
  }

  function fieldSignature(inp) {
    return [
      inp.getAttribute('name') || '',
      inp.getAttribute('id') || '',
      inp.getAttribute('placeholder') || '',
      inp.getAttribute('aria-label') || ''
    ].join('|').toLowerCase();
  }

  function dedupeFields(fields) {
    var out = [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var dup = false;
      for (var j = 0; j < out.length; j++) {
        if (out[j].el === f.el) { dup = true; break; }
        if (out[j].el.contains(f.el)) { dup = true; break; }
      }
      if (!dup) out.push(f);
    }
    return out;
  }

  function collectFields(container) {
    var fields = [];

    all(container, TEXT_INPUT_SEL).forEach(function (inp) {
      if (!isTextField(inp)) return;
      if (isIgnored(inp)) return;
      fields.push({
        el: inp,
        type: 'text',
        name: inp.getAttribute('name') || '',
        placeholder: inp.getAttribute('placeholder') || ''
      });
    });

    all(container, SELECT_SEL).forEach(function (sel) {
      if (!sel.options || sel.options.length < 2) return;
      if (sel.disabled || isIgnored(sel)) return;
      fields.push({
        el: sel,
        type: 'select',
        name: sel.getAttribute('name') || '',
        placeholder: ''
      });
    });

    all(container, TEXTAREA_SEL).forEach(function (ta) {
      if (ta.disabled || ta.readOnly || isIgnored(ta)) return;
      fields.push({
        el: ta,
        type: 'textarea',
        name: ta.getAttribute('name') || '',
        placeholder: ta.getAttribute('placeholder') || ''
      });
    });

    all(container, EDITABLE_SEL).forEach(function (ed) {
      if (ed.isContentEditable === false) return;
      if (isIgnored(ed)) return;
      fields.push({
        el: ed,
        type: 'contenteditable',
        name: ed.getAttribute('data-name') || '',
        placeholder: ed.getAttribute('data-placeholder') || ed.getAttribute('placeholder') || ''
      });
    });

    return dedupeFields(fields);
  }

  /** select 的选项作为提示词素材塞进 options（el 指向 <option>，input 为 null） */
  function selectOptions(sel) {
    var out = [];
    var list = sel.options || [];
    var start = 0;
    var first = norm(list[0] ? list[0].textContent : '');
    if (/^(请选择|请选|--|-|全部|不限|select)/i.test(first) || (list[0] && !list[0].value)) start = 1;
    for (var i = start; i < list.length; i++) {
      var t = norm(list[i].textContent);
      if (!t) continue;
      out.push({
        label: letterFromIndex(out.length),
        text: t,
        el: list[i],
        input: null,
        checked: false
      });
    }
    return out;
  }

  function analyzeFieldGroup(container, ctx, forceKind) {
    if (!container || isIgnored(container) || isNavish(container)) return null;
    var fields = collectFields(container);
    if (!fields.length) return null;

    var members = fields.map(function (f) { return f.el; });
    var stemInfo = stemFor(container, members, ctx.minTextLen);
    var stem = stemInfo.stem;

    if (norm(stem).length < ctx.minTextLen && !forceKind) return null;
    // 题干只是类型标签（Vue 未渲染完）→ 不出题（qa/blank 的整段写作同样受益）
    if (stemLooksEmpty(stem)) return null;

    var hasQA = false;
    var selects = [];
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].type === 'textarea' || fields[i].type === 'contenteditable') hasQA = true;
      if (fields[i].type === 'select') selects.push(fields[i]);
    }

    var kind = forceKind || (hasQA ? 'qa' : 'blank');
    var options = [];
    if (selects.length === 1) options = selectOptions(selects[0].el);

    var conf = 0.55;
    if (QUESTION_CLASS_RE.test(classStr(container))) conf += 0.08;
    if (kindHint(stem) === kind) conf += 0.08;
    if (hasQA) conf += 0.06;
    if (fields.length > 1 && kind === 'blank') conf += 0.04;
    if (container.tagName === 'BODY' || container.tagName === 'HTML') conf -= 0.2;
    if (container.tagName === 'FORM') conf -= 0.1;
    if (forceKind === 'generic') conf = Math.min(conf, 0.45);

    return buildQuestion({
      kind: kind,
      root: stemInfo.root || container,
      anchor: stemInfo.root || container,
      stem: stem,
      options: options,
      inputs: fields,
      presetId: '',
      confidence: conf
    });
  }

  /* ======================================================================
   * 6. 容器自动分析（站点预设复用）
   * ==================================================================== */

  function analyzeAuto(container, ctx) {
    if (!container || container.nodeType !== 1) return null;
    if (isIgnored(container) || isNavish(container)) return null;

    // 1) 原生选项组
    var groups = optionInputGroups(container);
    if (groups.length) {
      var best = null;
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        var q = analyzeOptionGroup(g.container || container, g.inputs, ctx);
        if (q && (!best || q.confidence > best.confidence)) best = q;
      }
      if (best) return best;
    }

    // 2) 伪选项组
    var pgs = pseudoGroups(container);
    if (pgs.length) {
      var best2 = null;
      for (var p = 0; p < pgs.length; p++) {
        var q3 = analyzeOptionGroup(pgs[p].parent, pgs[p].members, ctx);
        if (q3 && (!best2 || q3.confidence > best2.confidence)) best2 = q3;
      }
      if (best2) return best2;
    }

    // 3) 填空 / 大题 / 下拉
    return analyzeFieldGroup(container, ctx);
  }

  /* ======================================================================
   * 7. 预设实现
   * ==================================================================== */

  function matchOptionInputs(root, ctx, wanted) {
    var out = [];
    var groups = optionInputGroups(root);
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (wanted === 'radio' && g.type !== 'radio') continue;
      if (wanted === 'checkbox' && g.type !== 'checkbox') continue;
      var q = analyzeOptionGroup(g.container, g.inputs, ctx);
      if (!q) continue;
      if (q.kind === 'judge' && wanted === 'checkbox') continue;
      out.push(q);
    }
    return out;
  }

  function matchPseudo(root, ctx, wantMulti) {
    var out = [];
    var pgs = pseudoGroups(root);
    for (var i = 0; i < pgs.length; i++) {
      var q = analyzeOptionGroup(pgs[i].parent, pgs[i].members, ctx);
      if (!q) continue;
      if (q.kind === 'judge') { out.push(q); continue; }
      if (wantMulti && q.kind !== 'multi') continue;
      if (!wantMulti && q.kind === 'multi') continue;
      out.push(q);
    }
    return out;
  }

  /* ---------------------------- 站点预设 ---------------------------- */

  // 智慧树：.examPaper_subject 是一道题（题干 .subject_describe / 选项 .nodeLab，
  // 隐藏 radio + 图片选中标记；右侧 .answerCard 答题卡必须排除）
  var SITE_ZHIHUISHU = '.examPaper_subject';

  /** 智慧树专用：只读取实际题干，不用题号、分值和类型标签补齐空占位。 */
  function analyzeZhihuishu(container, ctx) {
    if (!container || container.nodeType !== 1) return null;
    if (isIgnored(container) || isNavish(container)) return null;
    // 必须包含选项节点，否则不是题
    var nodes = all(container, '.nodeLab');
    if (nodes.length < 2) return null;

    // 题干：.subject_describe 优先；为空（Vue 异步渲染）时用整个 .subject_stem 文本
    var stemEl = container.querySelector('.subject_describe');
    var stem = stemEl ? txt(stemEl) : '';
    if (!stemEl) {
      var stemWrap = container.querySelector('.subject_stem');
      if (stemWrap) stem = txt(stemWrap);
    }
    stem = stripStem(stem);
    // 题干为空或只剩类型标签（数据未加载）→ 不出题，避免 LLM 对空题干瞎猜
    if (stemLooksEmpty(stem)) return null;
    if (stem.length < (ctx.minTextLen || 2)) return null;

    // 题型：.subject_type 文本（【单选题】/【多选题】/【判断题】…）
    var typeText = '';
    var typeEl = container.querySelector('.subject_type');
    if (typeEl) typeText = txt(typeEl);
    var kind = kindHint(typeText) || kindHint(stem) ||
      (/多选/.test(typeText) ? 'multi' : /判断/.test(typeText) ? 'judge' : 'choice');

    // 选项：.nodeLab 直接子结构（不依赖内层 radio，radio 是 display:none 的）
    var options = [];
    var checkedCount = 0;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var parsed = splitLabelNode(node) || stripOptionLabel(txt(node));
      var detail = node.querySelector('.node_detail');
      var optionText = detail ? txt(detail) : parsed.text;
      if (!optionText || /^[A-Z][.、．]?$/i.test(optionText)) return null;
      // 选中标记：智慧树用 flagChecked 图片显隐，radio 的 checked 同步
      var radio = node.querySelector('input[type="radio"], input[type="checkbox"]');
      var checked = !!(radio && radio.checked);
      if (!checked) checked = isMarkedSelected(node);
      if (checked) checkedCount++;
      options.push({
        label: parsed.label || letterFromIndex(i),
        text: optionText,
        el: node,
        input: radio || null,
        checked: checked
      });
    }

    var q = buildQuestion({
      kind: kind,
      root: container,
      anchor: container,
      stem: stem,
      options: options,
      inputs: [],
      presetId: 'zhihuishu',
      confidence: 0.92
    });
    if (checkedCount > 0) q.answered = true;
    return q;
  }

  function makeSitePreset(id, name, desc, selector, urls, confidence, customAnalyze) {
    return {
      id: id,
      name: name,
      desc: desc,
      kind: '',
      enabledByDefault: false,
      site: id,
      urls: urls,
      match: function (root, ctx) {
        var out = [];
        var containers = containerList(root, selector);
        for (var i = 0; i < containers.length; i++) {
          var c = containers[i];
          if (isIgnored(c) || isNavish(c)) continue;
          var q = customAnalyze ? customAnalyze(c, ctx) : analyzeAuto(c, ctx);
          if (!q) continue;
          q.presetId = id;
          q.confidence = clamp(Math.max(q.confidence, confidence), 0.05, 0.99);
          out.push(q);
        }
        return out;
      }
    };
  }

  /* ======================================================================
   * 8. 容器聚类辅助
   * ==================================================================== */

  /** 查询容器，并去掉被已选容器包含的嵌套项（保留外层） */
  function containerList(root, selector) {
    var list = all(root, selector);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!el || el.nodeType !== 1) continue;
      var nested = false;
      for (var j = 0; j < out.length; j++) {
        if (out[j] === el || out[j].contains(el)) { nested = true; break; }
      }
      if (!nested) out.push(el);
    }
    return out;
  }

  var FIELD_CONTAINER_SEL = [
    '.field', '.field-item', '.question', '.question-item', '.questionLi', '.subject_node',
    '.exam-item', '.q-item', '.problem-item', '.timu', '.item', 'li', 'tr', 'dd', 'fieldset',
    '[class*="question"]', '[class*="subject"]', '[class*="exam"]', '[class*="problem"]',
    '[class*="field"]', '[class*="timu"]', '[data-questionid]'
  ].join(',');

  /**
   * 给一个输入元素找题块容器：
   *  - 优先用已知题块选择器 closest
   *  - 否则向上爬，取第一个「题干够长」的祖先
   */
  function findFieldContainer(el, ctx) {
    var doc = el.ownerDocument || document;
    var known = null;
    try { known = el.closest(FIELD_CONTAINER_SEL); } catch (e) { known = null; }
    if (known && known !== doc.body) {
      var stemKnown = stemFor(known, [el], ctx.minTextLen);
      if (norm(stemKnown.stem).length >= ctx.minTextLen) return known;
    }
    var node = el.parentElement;
    var guard = 0;
    while (node && node !== doc.body && node !== doc.documentElement && guard++ < 10) {
      var stem = stemFor(node, [el], ctx.minTextLen);
      if (norm(stem.stem).length >= ctx.minTextLen) {
        // 再向上合并一层，让「题干 + 选项」落在同一个块里
        var up = node.parentElement;
        if (up && up !== doc.body) {
          var stemUp = stemFor(up, [el], ctx.minTextLen);
          if (norm(stemUp.stem).length >= ctx.minTextLen &&
              norm(stemUp.stem).length <= norm(stem.stem).length + 120) {
            return up;
          }
        }
        return node;
      }
      node = node.parentElement;
    }
    return known || el.parentElement || null;
  }

  /** 兜底题干：label / legend / 前一个兄弟 */
  function fallbackStem(el) {
    if (!el || el.nodeType !== 1) return '';
    var doc = el.ownerDocument || document;
    try {
      if (el.id) {
        // 原生 labels 支持数学公式等包含反斜线、引号的 ID，避免拼接 CSS 选择器。
        var lab = el.labels && el.labels[0];
        if (lab) {
          var t = txt(lab);
          if (t) return stripStem(t);
        }
      }
      var wrap = el.closest('label');
      if (wrap) {
        var t2 = txt(wrap);
        if (t2) return stripStem(t2);
      }
      var p = el.previousElementSibling;
      var guard = 0;
      while (p && guard++ < 3) {
        var t3 = txt(p);
        if (t3 && t3.length >= 2) return stripStem(t3);
        p = p.previousElementSibling;
      }
      var par = el.parentElement;
      if (par) {
        var t4 = txt(par);
        if (t4) return stripStem(t4);
      }
    } catch (e) { /* noop */ }
    return '';
  }

  /* ======================================================================
   * 9. 导出
   * ==================================================================== */

  var PRESETS = [
    makeSitePreset('zhihuishu', '智慧树', '智慧树考试/作业：.examPaper_subject（题干 .subject_describe + 选项 .nodeLab），已排除右侧答题卡', SITE_ZHIHUISHU,
      ['*://*.zhihuishu.com/*', '*://*.zhihuishu.cn/*'], 0.92, analyzeZhihuishu)
  ];

  AD.PRESETS = PRESETS;

  AD.PresetKit = {
    norm: norm,
    txt: txt,
    shadowRootOf: shadowRootOf,
    all: all,
    classStr: classStr,
    isIgnored: isIgnored,
    isNavish: isNavish,
    rectOf: rectOf,
    elKey: elKey,
    letterFromIndex: letterFromIndex,
    clamp: clamp,
    stripStem: stripStem,
    stemLooksEmpty: stemLooksEmpty,
    stripOptionLabel: stripOptionLabel,
    hasLetterPrefix: hasLetterPrefix,
    judgeNorm: judgeNorm,
    kindHint: kindHint,
    textExcluding: textExcluding,
    branchOf: branchOf,
    stemFor: stemFor,
    stemWith: stemWith,
    isMarkedSelected: isMarkedSelected,
    isAnswered: isAnswered,
    buildQuestion: buildQuestion,
    qid: qid,
    optionInputGroups: optionInputGroups,
    pseudoGroups: pseudoGroups,
    collectFields: collectFields,
    selectOptions: selectOptions,
    analyzeAuto: analyzeAuto,
    analyzeZhihuishu: analyzeZhihuishu,
    analyzeOptionGroup: analyzeOptionGroup,
    analyzeFieldGroup: analyzeFieldGroup,
    containerList: containerList,
    findFieldContainer: findFieldContainer,
    fallbackStem: fallbackStem,
    isOptionLike: isOptionLike,
    isTextField: isTextField,
    isJudgePair: isJudgePair
  };
}(globalThis.AD = globalThis.AD || {}));
