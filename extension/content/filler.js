/**
 * AutoDati · 答案填入器（AD.Filler）
 *
 * 经典脚本，无 import/export，只挂载 globalThis.AD。
 * 契约（docs/CONTRACT.md §4）：
 *   AD.Filler.parse(kind, text, question) -> { answers: string[], raw, ok }
 *   AD.Filler.apply(question, text, opts = {}) -> { ok, applied, detail }
 *
 * 铁律：**绝不提交表单**（不点 submit、不调 form.submit()、不触发 submit 事件）。
 */
(function (AD) {
  'use strict';

  if (!AD) return;

  /* ======================================================================
   * 0. 工具
   * ==================================================================== */

  function norm(s) {
    if (AD.PresetKit && typeof AD.PresetKit.norm === 'function') return AD.PresetKit.norm(s);
    return s == null ? '' : String(s).replace(/\s+/g, ' ').trim();
  }

  function stripOptionLabel(s) {
    if (AD.PresetKit && typeof AD.PresetKit.stripOptionLabel === 'function') return AD.PresetKit.stripOptionLabel(s);
    var t = norm(s);
    var m = t.match(/^\s*[\(（\[【]?\s*([A-Za-z])\s*[\)）\]】]?\s*[\.、．:：,，]?\s*/);
    if (m) return { label: m[1].toUpperCase(), text: norm(t.slice(m[0].length)) };
    return { label: '', text: t };
  }

  function judgeNorm(s) {
    if (AD.PresetKit && typeof AD.PresetKit.judgeNorm === 'function') return AD.PresetKit.judgeNorm(s);
    return '';
  }

  var JUDGE_TRUE = ['对', '正确', '是', '√', '✓', '✔', '☑', 't', 'true', 'yes', 'y', '对的', '正确的'];
  var JUDGE_FALSE = ['错', '错误', '否', '×', '✗', '✘', '☒', 'f', 'false', 'no', 'n', '不对', '错的'];

  var CN_NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

  function toJudge(s) {
    var t = norm(s).toLowerCase();
    if (!t) return '';
    var p = stripOptionLabel(t);
    if (p.label) t = p.text.toLowerCase();
    t = t.replace(/[\s。\.\!！,，;；:：、]/g, '');
    if (!t) return '';
    if (JUDGE_TRUE.indexOf(t) >= 0) return '对';
    if (JUDGE_FALSE.indexOf(t) >= 0) return '错';
    if (t.length <= 10) {
      for (var i = 0; i < JUDGE_FALSE.length; i++) {
        if (JUDGE_FALSE[i].length >= 2 && t.indexOf(JUDGE_FALSE[i]) >= 0) return '错';
      }
      for (var j = 0; j < JUDGE_TRUE.length; j++) {
        if (JUDGE_TRUE[j].length >= 2 && t.indexOf(JUDGE_TRUE[j]) >= 0) return '对';
      }
    }
    return '';
  }

  function uniq(arr) {
    var out = [];
    var seen = {};
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (v == null) continue;
      var s = String(v);
      if (seen[s]) continue;
      seen[s] = 1;
      out.push(s);
    }
    return out;
  }

  /* ======================================================================
   * 1. parse
   * ==================================================================== */

  /** 去掉 LLM 常见的开场废话与结尾解析 */
  function stripPreamble(text) {
    var t = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    // 代码块围栏
    t = t.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '');
    // 开头的「好的/当然/以下是…」一行
    var lines = t.split('\n');
    while (lines.length && /^\s*(好的|当然|没问题|以下是|这是|ok|OK|Sure|Here|根据|答案如下|解析[:：]?$)/.test(lines[0]) && lines.length > 1) {
      // 「答案如下：」这类标题行也丢掉
      lines.shift();
    }
    t = lines.join('\n');
    // 去掉「解析/说明/解释」段落（从该行到结尾）
    var cut = t.search(/\n\s*(\*\*)?\s*(解析|解释|说明|分析|思路|理由|考点|知识点)\s*(\*\*)?\s*[:：]/);
    if (cut > 0) t = t.slice(0, cut);
    return t.trim();
  }

  /** 提取「答案：xxx」右侧内容 */
  function afterAnswerLabel(line) {
    var m = line.match(/^[\s\-\*•·>#]*\s*(?:\*\*)?\s*(?:正确)?(?:参考)?答案\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*([\s\S]*)$/);
    if (m) return norm(m[1].replace(/\*\*/g, ''));
    return null;
  }

  /** 解析 JSON 形态 */
  function tryJSON(text) {
    var t = String(text || '').trim();
    if (!t) return null;
    var cand = t;
    if (!/^[\[{]/.test(cand)) {
      var s = cand.indexOf('{');
      var e = cand.lastIndexOf('}');
      if (s >= 0 && e > s) cand = cand.slice(s, e + 1);
      else {
        var s2 = cand.indexOf('[');
        var e2 = cand.lastIndexOf(']');
        if (s2 >= 0 && e2 > s2) cand = cand.slice(s2, e2 + 1);
      }
    }
    if (!/^[\[{]/.test(cand)) return null;
    var obj;
    try { obj = JSON.parse(cand); } catch (e) { return null; }
    if (obj == null) return null;

    function flat(v) {
      if (v == null) return [];
      if (Array.isArray(v)) {
        var out = [];
        for (var i = 0; i < v.length; i++) {
          if (v[i] == null) continue;
          if (typeof v[i] === 'object') out = out.concat(flat(v[i].answer != null ? v[i].answer : (v[i].text != null ? v[i].text : v[i].value)));
          else out.push(String(v[i]));
        }
        return out;
      }
      if (typeof v === 'object') {
        if (v.answers != null) return flat(v.answers);
        if (v.answer != null) return flat(v.answer);
        if (v.value != null) return flat(v.value);
        return [];
      }
      return [String(v)];
    }

    if (Array.isArray(obj)) {
      var a = flat(obj);
      return a.length ? a : null;
    }
    var got = flat(obj);
    return got.length ? got : null;
  }

  /** 从文本里抽取选项字母：支持 "B"、"BD"、"A,B,D"、"A、B 和 D"、"选B"、"答案：AC" */
  function extractLetters(text, maxLetters) {
    var t = norm(text);
    if (!t) return [];
    // 去掉「答案」标签
    var m = t.match(/^(?:正确)?(?:参考)?答案\s*[:：]?\s*([\s\S]*)$/);
    if (m) t = norm(m[1]);
    t = t.replace(/^\s*(?:应?选|选择|选)\s*[:：]?\s*/, '');
    // 只保留字母与分隔符，判断是否「纯字母型」
    var pure = t.replace(/[\s,，、;；\/\|和及与\.．]/g, '');
    if (/^[A-Za-z]+$/.test(pure) && pure.length <= Math.max(1, maxLetters || 26)) {
      return uniq(pure.toUpperCase().split(''));
    }
    // 混合型：抓取独立的单个字母 token
    var out = [];
    var re = /(?:^|[\s,，、;；\/\|和及与\(（\[【])([A-Za-z])(?=$|[\s,，、;；\/\|和及与\)）\]】\.．:：])/g;
    var mm;
    while ((mm = re.exec(t))) out.push(mm[1].toUpperCase());
    if (out.length) return uniq(out);
    // "B. 选项文本" / "B、xxx"
    var m2 = t.match(/^\s*[\(（\[【]?\s*([A-Za-z])\s*[\)）\]】]?\s*[\.、．:：,，]\s*\S/);
    if (m2) return [m2[1].toUpperCase()];
    return [];
  }

  /** 多空拆分："1. xx\n2. yy"、"①xx ②yy"、"第一空：xx" */
  function splitBlanks(text) {
    var t = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
    if (!t) return [];
    var lines = t.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    var numbered = [];
    var reNum = /^\s*[\(（]?\s*([0-9]{1,2})\s*[\)）]?\s*[\.、．:：\)）]?\s*([\s\S]+)$/;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(reNum);
      if (m) numbered.push(norm(m[2]));
    }
    if (numbered.length >= 2 && numbered.length === lines.length) return numbered;

    // 圆圈数字
    if (/[①②③④⑤⑥⑦⑧⑨⑩]/.test(t)) {
      var parts = t.split(/[①②③④⑤⑥⑦⑧⑨⑩]/).map(norm).filter(Boolean);
      if (parts.length >= 2) return parts;
    }
    // 「第1空」「第一空」
    if (/第\s*[0-9一二三四五六七八九十]+\s*空/.test(t)) {
      var segs = t.split(/第\s*[0-9一二三四五六七八九十]+\s*空\s*[:：]?/).map(norm).filter(Boolean);
      if (segs.length >= 2) return segs;
    }
    // 单行多空：用 "；" ";" "|" 分隔
    if (lines.length === 1) {
      var sep = lines[0].split(/\s*[;；\|]\s*/).map(norm).filter(Boolean);
      if (sep.length >= 2) return sep;
    }
    return lines.map(function (l) {
      var a = afterAnswerLabel(l);
      return a != null ? a : l;
    }).map(norm).filter(Boolean);
  }

  /**
   * 解析 LLM 输出为答案数组。
   * @param {string} kind choice|multi|judge|blank|qa|generic
   * @param {string} text
   * @param {object} [question]
   * @returns {{answers:string[], raw:string, ok:boolean}}
   */
  function parse(kind, text, question) {
    var raw = String(text == null ? '' : text);
    var k = kind || 'generic';
    var result = { answers: [], raw: raw, ok: false };

    if (!norm(raw)) return result;

    // 1) JSON
    var json = tryJSON(raw);
    if (json && json.length) {
      result.answers = json.map(norm).filter(Boolean);
      result.ok = result.answers.length > 0;
      if (k === 'judge') {
        var j = toJudge(result.answers[0]);
        if (j) result.answers = [j];
      }
      if (k === 'choice' || k === 'multi') {
        var letters = [];
        for (var i = 0; i < result.answers.length; i++) {
          var piece = extractLetters(result.answers[i], 26);
          if (piece.length === 1) letters.push(piece[0]);
          else if (piece.length > 1) letters = letters.concat(piece);
        }
        if (letters.length) result.answers = uniq(letters);
      }
      return result;
    }

    var body = stripPreamble(raw);

    // 2) 判断题
    if (k === 'judge') {
      var line0 = body.split('\n').map(norm).filter(Boolean)[0] || '';
      var after = afterAnswerLabel(line0);
      var cand = after != null ? after : line0;
      var jd = toJudge(cand);
      if (!jd) jd = toJudge(body);
      if (jd) {
        result.answers = [jd];
        result.ok = true;
      }
      return result;
    }

    // 3) 选择题 / 多选题：抽字母
    if (k === 'choice' || k === 'multi') {
      var optCount = question && question.options ? question.options.length : 0;
      var letters2 = extractLetters(body, Math.max(optCount, 8));
      if (!letters2.length) {
        // 尝试用选项文本反查
        letters2 = matchByOptionText(body, question);
      }
      if (letters2.length) {
        if (k === 'choice') letters2 = [letters2[0]];
        result.answers = letters2;
        result.ok = true;
      } else {
        // 实在没有字母：把整行当答案（可能是选项文本本身）
        var t = norm(body.split('\n')[0] || body);
        if (t) {
          result.answers = [t];
          result.ok = true;
        }
      }
      return result;
    }

    // 4) 填空题：按空拆分
    if (k === 'blank') {
      var blanks = splitBlanks(body);
      if (blanks.length) {
        result.answers = blanks;
        result.ok = true;
      }
      return result;
    }

    // 5) 问答题：整段保留（保留换行）
    if (k === 'qa' || k === 'generic') {
      var whole = body.trim();
      if (whole) {
        result.answers = [whole];
        result.ok = true;
      }
      return result;
    }

    // 6) 未知 kind：按行
    var lines = body.split('\n').map(norm).filter(Boolean);
    if (lines.length) {
      result.answers = lines;
      result.ok = true;
    }
    return result;
  }

  /** 用选项文本反查字母 */
  function matchByOptionText(text, question) {
    var out = [];
    var opts = (question && question.options) || [];
    if (!opts.length) return out;
    var t = norm(text);
    for (var i = 0; i < opts.length; i++) {
      var ot = norm(opts[i].text);
      if (!ot) continue;
      if (ot.length >= 2 && t.indexOf(ot) >= 0) out.push(opts[i].label || String.fromCharCode(65 + i));
    }
    return uniq(out);
  }

  /* ======================================================================
   * 2. apply 底层动作
   * ==================================================================== */

  function fire(el, type, init) {
    if (!el || !el.dispatchEvent) return false;
    try {
      var ev;
      var isMouse = /^(pointer|mouse|click)/.test(type);
      var isPointer = /^pointer/.test(type);
      if (isPointer && typeof PointerEvent === 'function') {
        ev = new PointerEvent(type, Object.assign({
          bubbles: true, cancelable: true, composed: true,
          pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1
        }, init || {}));
      } else if (isMouse && typeof MouseEvent === 'function') {
        ev = new MouseEvent(type, Object.assign({
          bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, view: window
        }, init || {}));
      } else if (/^(input|beforeinput)$/.test(type) && typeof InputEvent === 'function') {
        ev = new InputEvent(type, Object.assign({ bubbles: true, cancelable: false, composed: true }, init || {}));
      } else {
        ev = new Event(type, Object.assign({ bubbles: true, cancelable: true, composed: true }, init || {}));
      }
      el.dispatchEvent(ev);
      return true;
    } catch (e) {
      try {
        el.dispatchEvent(new Event(type, { bubbles: true }));
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  /** 完整鼠标事件序列（尽量贴近真实点击，触发框架的事件委托） */
  function mouseSequence(el) {
    if (!el) return;
    var r = null;
    try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
    var cx = r ? Math.round(r.left + r.width / 2) : 0;
    var cy = r ? Math.round(r.top + r.height / 2) : 0;
    var base = { clientX: cx, clientY: cy, screenX: cx, screenY: cy, detail: 1 };

    fire(el, 'pointerover', base);
    fire(el, 'pointerenter', base);
    fire(el, 'mouseover', base);
    fire(el, 'mouseenter', base);
    fire(el, 'pointerdown', base);
    fire(el, 'mousedown', base);
    try { if (el.focus) el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) { /* noop */ } }
    fire(el, 'pointerup', Object.assign({}, base, { buttons: 0 }));
    fire(el, 'mouseup', Object.assign({}, base, { buttons: 0 }));
    fire(el, 'click', Object.assign({}, base, { buttons: 0, detail: 1 }));
  }

  /** 给 input[type=radio|checkbox] 设置 checked 并派发事件 */
  function setCheckbox(input, want) {
    if (!input) return false;
    var before = !!input.checked;
    if (before !== !!want) {
      // 走原生 click 让浏览器处理 radio 的互斥（同 name 自动取消其他项）
      try {
        mouseSequence(input);
        if (!!input.checked !== !!want) {
          input.checked = !!want;
          fire(input, 'input', {});
          fire(input, 'change', {});
        }
      } catch (e) {
        input.checked = !!want;
        fire(input, 'input', {});
        fire(input, 'change', {});
      }
    } else {
      // 状态已正确，仍补一次 change 让页面框架感知
      fire(input, 'input', {});
      fire(input, 'change', {});
    }
    return !!input.checked === !!want;
  }

  /** 原型 setter 赋值（绕过 React/Vue 的 value 拦截） */
  function setNativeValue(el, value) {
    var proto = null;
    try {
      if (el.tagName === 'TEXTAREA') proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
      else if (el.tagName === 'INPUT') proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
      else if (el.tagName === 'SELECT') proto = window.HTMLSelectElement && window.HTMLSelectElement.prototype;
    } catch (e) { proto = null; }

    var setter = null;
    if (proto) {
      try {
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && typeof desc.set === 'function') setter = desc.set;
      } catch (e2) { setter = null; }
    }
    if (setter) {
      try {
        setter.call(el, value);
        return true;
      } catch (e3) { /* fallthrough */ }
    }
    try {
      el.value = value;
      return true;
    } catch (e4) {
      return false;
    }
  }

  /** 文本输入：原型 setter + input/change/blur */
  function fillText(el, value) {
    if (!el) return false;
    var v = String(value == null ? '' : value);
    try { if (el.focus) el.focus({ preventScroll: true }); } catch (e) { /* noop */ }

    var ok = setNativeValue(el, v);
    if (!ok) return false;

    fire(el, 'input', { inputType: 'insertText', data: v });
    fire(el, 'change', {});
    try {
      fire(el, 'blur', {});
      if (el.blur) el.blur();
    } catch (e2) { /* noop */ }
    // 再补一次 input（部分框架在 blur 后才读值）
    fire(el, 'input', { inputType: 'insertText', data: v });
    return norm(el.value) === norm(v) || el.value === v;
  }

  /** contenteditable：textContent + input */
  function fillEditable(el, value) {
    if (!el) return false;
    var v = String(value == null ? '' : value);
    try { if (el.focus) el.focus({ preventScroll: true }); } catch (e) { /* noop */ }
    try {
      el.textContent = v;
    } catch (e2) {
      return false;
    }
    fire(el, 'input', { inputType: 'insertText', data: v });
    fire(el, 'change', {});
    try { fire(el, 'blur', {}); } catch (e3) { /* noop */ }
    return norm(el.textContent) === norm(v);
  }

  /** select：按文本/值匹配 */
  function fillSelect(el, value) {
    if (!el || !el.options) return false;
    var want = norm(value);
    if (!want) return false;
    var target = -1;
    var list = el.options;
    var wantLetter = stripOptionLabel(want);

    // 1) 精确文本 / 值
    for (var i = 0; i < list.length; i++) {
      if (norm(list[i].textContent) === want) { target = i; break; }
    }
    if (target < 0) {
      for (var j = 0; j < list.length; j++) {
        if (norm(list[j].value) === want) { target = j; break; }
      }
    }
    // 2) 字母前缀（A / B）→ 第 n 个有效项
    if (target < 0 && /^[A-Za-z]$/.test(want)) {
      var idx = want.toUpperCase().charCodeAt(0) - 65;
      var valid = [];
      for (var m = 0; m < list.length; m++) {
        var t = norm(list[m].textContent);
        if (!t) continue;
        if (/^(请选择|请选|--|-|全部|不限|select)/i.test(t)) continue;
        if (!list[m].value && m === 0) continue;
        valid.push(m);
      }
      if (idx >= 0 && idx < valid.length) target = valid[idx];
    }
    // 3) 去掉字母前缀后再比对
    if (target < 0) {
      for (var n = 0; n < list.length; n++) {
        var nt = stripOptionLabel(norm(list[n].textContent));
        if (nt.text && nt.text === wantLetter.text) { target = n; break; }
      }
    }
    // 4) 包含匹配
    if (target < 0 && want.length >= 2) {
      for (var p = 0; p < list.length; p++) {
        var pt = norm(list[p].textContent);
        if (pt && (pt.indexOf(want) >= 0 || want.indexOf(pt) >= 0)) { target = p; break; }
      }
    }
    if (target < 0) return false;

    try {
      el.selectedIndex = target;
      fire(el, 'input', {});
      fire(el, 'change', {});
      return el.selectedIndex === target;
    } catch (e4) {
      return false;
    }
  }

  /* ======================================================================
   * 3. apply
   * ==================================================================== */

  function normLabel(s) {
    return norm(s).toUpperCase().replace(/[\.、．:：\)）\]】]/g, '');
  }

  /** 找到答案对应的选项对象 */
  function pickOptions(question, answers, opts) {
    var list = question.options || [];
    var picked = [];
    var used = {};
    for (var a = 0; a < answers.length; a++) {
      var ans = norm(answers[a]);
      if (!ans) continue;
      var letter = stripOptionLabel(ans).label || (/^[A-Za-z]$/.test(ans) ? ans.toUpperCase() : '');
      var text = stripOptionLabel(ans).text || ans;
      var hit = -1;

      // 1) label 精确
      if (letter) {
        for (var i = 0; i < list.length; i++) {
          if (normLabel(list[i].label) === normLabel(letter)) { hit = i; break; }
        }
      }
      // 2) 选项文本精确
      if (hit < 0) {
        for (var j = 0; j < list.length; j++) {
          if (norm(list[j].text) === text) { hit = j; break; }
        }
      }
      // 3) 选项文本包含（答案里带选项全文）
      if (hit < 0 && text.length >= 2) {
        for (var k = 0; k < list.length; k++) {
          var lt = norm(list[k].text);
          if (!lt) continue;
          if (text.indexOf(lt) >= 0 || lt.indexOf(text) >= 0) { hit = k; break; }
        }
      }
      // 4) 判断题语义
      if (hit < 0 && question.kind === 'judge') {
        var jn = toJudge(text);
        if (jn) {
          for (var m = 0; m < list.length; m++) {
            if (toJudge(list[m].text) === jn) { hit = m; break; }
          }
        }
      }
      if (hit >= 0 && !used[hit]) {
        used[hit] = 1;
        picked.push(list[hit]);
      }
    }
    if (!picked.length && opts && opts.fallbackIndex != null && list[opts.fallbackIndex]) {
      picked.push(list[opts.fallbackIndex]);
    }
    return picked;
  }

  /** 点击伪选项，并校验状态变化 */
  function clickPseudo(el) {
    if (!el) return { ok: false, changed: false };
    var before = AD.PresetKit && AD.PresetKit.isMarkedSelected
      ? AD.PresetKit.isMarkedSelected(el)
      : /(selected|checked|active)/i.test(el.className || '');
    var beforeCls = String(el.className || '');
    var beforeAria = el.getAttribute ? (el.getAttribute('aria-checked') || '') : '';

    // 优先点内部的可点击体（部分站点的 li 只有内部 span 绑了事件）
    mouseSequence(el);

    var after = AD.PresetKit && AD.PresetKit.isMarkedSelected
      ? AD.PresetKit.isMarkedSelected(el)
      : /(selected|checked|active)/i.test(el.className || '');
    var afterCls = String(el.className || '');
    var afterAria = el.getAttribute ? (el.getAttribute('aria-checked') || '') : '';
    var changed = before !== after || beforeCls !== afterCls || beforeAria !== afterAria;

    if (!changed) {
      // 再试内部第一个可交互子元素
      var inner = null;
      try {
        inner = el.querySelector('input[type="radio"], input[type="checkbox"], span, i, label, div');
      } catch (e) { inner = null; }
      if (inner && inner !== el) {
        mouseSequence(inner);
        after = AD.PresetKit && AD.PresetKit.isMarkedSelected
          ? AD.PresetKit.isMarkedSelected(el)
          : /(selected|checked|active)/i.test(el.className || '');
        changed = before !== after || beforeCls !== String(el.className || '');
      }
    }
    return { ok: changed, changed: changed };
  }

  /**
   * 把答案写入页面。
   * @param {object} question ADQuestion
   * @param {string|string[]} text LLM 输出或已解析数组
   * @param {object} [opts] {answers, dryRun, allowPartial}
   * @returns {{ok:boolean, applied:number, detail:string}}
   */
  function apply(question, text, opts) {
    var o = opts || {};
    var res = { ok: false, applied: 0, detail: '' };
    if (!question) {
      res.detail = 'question 为空';
      return res;
    }

    var kind = question.kind || 'generic';
    var answers = null;
    if (Array.isArray(o.answers)) answers = o.answers.map(String);
    else if (Array.isArray(text)) answers = text.map(String);
    else {
      var parsed = parse(kind, text, question);
      answers = parsed.answers;
      if (!parsed.ok) {
        res.detail = '解析失败：' + String(text || '').slice(0, 60);
        return res;
      }
    }
    answers = answers.map(norm).filter(Boolean);
    if (!answers.length) {
      res.detail = '答案为空';
      return res;
    }

    if (o.dryRun) {
      res.ok = true;
      res.applied = 0;
      res.detail = 'dryRun: ' + answers.join(' | ');
      return res;
    }

    var details = [];
    var applied = 0;
    var options = question.options || [];
    var inputs = question.inputs || [];

    /* ------------------------- 选项型题目 ------------------------- */
    if (options.length && (kind === 'choice' || kind === 'multi' || kind === 'judge' || kind === 'generic')) {
      var picked = pickOptions(question, answers, o);
      if (!picked.length) {
        res.detail = '未匹配到选项：' + answers.join(',');
        return res;
      }
      // 单选/判断：只允许一个
      if (kind === 'choice' || kind === 'judge') picked = [picked[0]];

      for (var i = 0; i < picked.length; i++) {
        var opt = picked[i];
        var done = false;

        if (opt.input) {
          done = setCheckbox(opt.input, true);
          if (done) {
            applied++;
            details.push((opt.label || '?') + '→checked');
          }
        } else if (opt.el) {
          var r = clickPseudo(opt.el);
          if (r.changed) {
            done = true;
            applied++;
            details.push((opt.label || '?') + '→clicked');
          } else {
            // 点击无状态变化：仍然算尝试（部分站点状态由父级管理）
            var parent = opt.el.parentElement;
            var r2 = parent ? clickPseudo(parent) : { changed: false };
            if (r2.changed) {
              applied++;
              details.push((opt.label || '?') + '→clicked(parent)');
            } else {
              details.push((opt.label || '?') + '→nochange');
            }
          }
        }
      }

      // 多选题：未被选中的要取消
      if (kind === 'multi') {
        for (var c = 0; c < options.length; c++) {
          var co = options[c];
          var shouldCheck = picked.indexOf(co) >= 0;
          if (!shouldCheck && co.input && co.input.checked) {
            setCheckbox(co.input, false);
            details.push((co.label || '?') + '→unchecked');
          }
        }
      }

      res.applied = applied;
      res.ok = applied > 0;
      res.detail = details.join(', ') || '未产生变化';
      return res;
    }

    /* ------------------------- 输入型题目 ------------------------- */
    if (inputs.length) {
      var n = Math.min(inputs.length, Math.max(answers.length, 1));
      var fieldDetails = [];
      for (var f = 0; f < n; f++) {
        var field = inputs[f];
        var val = answers[f] != null ? answers[f] : (answers.length === 1 ? answers[0] : '');
        if (!field || !field.el) continue;
        var ok = false;
        if (field.type === 'select') ok = fillSelect(field.el, val);
        else if (field.type === 'contenteditable') ok = fillEditable(field.el, val);
        else if (field.type === 'textarea') ok = fillText(field.el, val);
        else ok = fillText(field.el, val);
        if (ok) {
          applied++;
          fieldDetails.push('#' + (f + 1) + '=' + String(val).slice(0, 24));
        } else {
          fieldDetails.push('#' + (f + 1) + '=fail');
        }
      }
      res.applied = applied;
      res.ok = applied > 0;
      res.detail = fieldDetails.join(', ') || '未写入任何输入框';
      return res;
    }

    res.detail = '题目没有可填入的选项或输入框';
    return res;
  }

  /* ======================================================================
   * 4. 导出
   * ==================================================================== */

  AD.Filler = {
    parse: parse,
    apply: apply,

    // 附加工具（非契约）
    version: 1,
    toJudge: toJudge,
    extractLetters: extractLetters,
    splitBlanks: splitBlanks,
    fillText: fillText,
    fillSelect: fillSelect,
    fillEditable: fillEditable,
    setCheckbox: setCheckbox,
    mouseSequence: mouseSequence
  };
}(globalThis.AD = globalThis.AD || {}));
