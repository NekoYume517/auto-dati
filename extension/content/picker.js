/**
 * AutoDati · 元素拾取器（识别不了题目时，手动框定并快速生成模板）
 *
 * 流程：拾取题块 → 选题型 → 自动推断题干/选项/输入框选择器 → 预览命中 → 保存为自定义规则
 * 全部 UI 在 Shadow DOM 内，自带样式，不污染宿主页。
 */
(function (AD) {
  'use strict';

  const HOST_ID = 'dati-template-picker';
  const Z = 2147483002;

  let inst = null;

  /* ------------------------------ 选择器生成 ------------------------------ */

  const UNSTABLE_CLASS = /^(is-|has-|active|selected|checked|hover|focus|disabled|ng-|css-|sc-|jsx-|_)|(^[a-z]+-[0-9a-f]{5,}$)|(^[0-9])/i;

  function stableClasses(el) {
    const out = [];
    const list = el.classList || [];
    for (let i = 0; i < list.length && out.length < 3; i++) {
      const c = list[i];
      if (!c || c.length > 40) continue;
      if (UNSTABLE_CLASS.test(c)) continue;
      if (/^(row|col|clearfix|d-flex|flex|container|wrapper|item|list)$/i.test(c) && list.length > 1) {
        // 过于通用的类名放后面
      }
      out.push(c);
    }
    return out;
  }

  function escIdent(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/([^\w-])/g, '\\$1');
  }

  function tagOf(el) {
    return String(el.tagName || '').toLowerCase();
  }

  function countMatches(sel, scope) {
    try {
      return (scope || document).querySelectorAll(sel).length;
    } catch (e) {
      return -1;
    }
  }

  function matches(sel, el) {
    try { return el.matches(sel); } catch (e) { return false; }
  }

  function uniq(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
  }

  /** 生成「模式选择器」：优先命中多个同类元素（模板用），退化为唯一定位 */
  function patternSelector(el, opts) {
    opts = opts || {};
    const scope = opts.scope || (el && el.getRootNode()) || document;
    const preferPattern = opts.preferPattern !== false; // 模板场景默认优先「能命中多个」
    if (!el || el.nodeType !== 1) return '';

    const tag = tagOf(el);
    const classes = stableClasses(el);
    const cands = [];

    // 1) 属性钩子（data-* / role / name）
    const attrs = ['data-id', 'data-type', 'data-question', 'role', 'name'];
    for (let i = 0; i < attrs.length; i++) {
      const v = el.getAttribute && el.getAttribute(attrs[i]);
      if (v && v.length < 40 && /^[\w-]+$/.test(v)) {
        cands.push(tag + '[' + attrs[i] + '="' + v + '"]');
      }
    }

    // 2) tag + 类组合
    if (classes.length) {
      cands.push(tag + '.' + classes.map(escIdent).join('.'));
      if (classes.length >= 2) cands.push('.' + classes.map(escIdent).join('.'));
      cands.push(tag + '.' + escIdent(classes[0]));
      cands.push('.' + escIdent(classes[0]));
      if (classes.length >= 2) cands.push('.' + escIdent(classes[1]));
    }

    // 3) 父级限定
    const parent = el.parentElement;
    if (parent && parent !== document.body) {
      const pTag = tagOf(parent);
      const pClasses = stableClasses(parent);
      const pBase = pClasses.length ? pTag + '.' + escIdent(pClasses[0]) : pTag;
      for (let i = 0; i < classes.length && i < 2; i++) {
        cands.push(pBase + ' > ' + tag + '.' + escIdent(classes[i]));
      }
      cands.push(pBase + ' > ' + tag);
    }

    // 4) 纯标签
    cands.push(tag);

    let best = null;
    let bestScore = -1;
    for (let i = 0; i < cands.length; i++) {
      const sel = cands[i];
      if (!sel || !matches(sel, el)) continue;
      const n = countMatches(sel, scope);
      if (n < 1 || n > 2000) continue;
      let score = 0;
      const classCount = (sel.match(/\./g) || []).length;
      score += classCount * 12;
      if (n >= 2 && n <= 400) score += 30;
      else if (n === 1) score += preferPattern ? 2 : 12;
      else if (n <= 800) score += 4;
      if (/\[/.test(sel)) score += 6;
      if (sel.indexOf(' > ') >= 0) score -= 4;
      if (n > 400) score -= 10;
      if (score > bestScore) { bestScore = score; best = sel; }
    }

    // 只有在「没有可用的模式选择器」时才退回唯一 id
    if (best && countMatches(best, scope) >= 2) return best;
    if (el.id && uniq('#' + escIdent(el.id))) return '#' + escIdent(el.id);
    return best || tag;
  }

  /** 生成 root 内部子元素的相对选择器 */
  function relativeSelector(root, el, opts) {
    opts = opts || {};
    if (!root || !el) return '';
    if (el === root) return '';
    const tag = tagOf(el);
    const classes = stableClasses(el);

    const cands = [];
    if (classes.length) {
      cands.push(tag + '.' + classes.map(escIdent).join('.'));
      cands.push('.' + classes.map(escIdent).join('.'));
      cands.push(tag + '.' + escIdent(classes[0]));
      cands.push('.' + escIdent(classes[0]));
    }
    if (el.getAttribute && el.getAttribute('role')) {
      cands.push(tag + '[role="' + el.getAttribute('role') + '"]');
    }
    cands.push(tag);

    const wantMany = !!opts.many;
    let best = '';
    let bestScore = -1;
    for (let i = 0; i < cands.length; i++) {
      const sel = cands[i];
      let n = -1;
      try { n = root.querySelectorAll(sel).length; } catch (e) { n = -1; }
      if (n < 1) continue;
      if (wantMany && n < 2) continue;
      let score = (sel.match(/\./g) || []).length * 10;
      if (wantMany) score += n >= 2 && n <= 30 ? 25 : 0;
      else score += n === 1 ? 20 : 0;
      if (score > bestScore) { bestScore = score; best = sel; }
    }
    return best;
  }

  /* ------------------------------ 结构推断 ------------------------------ */

  function isField(el) {
    const t = tagOf(el);
    if (t === 'input') {
      const type = String(el.type || 'text').toLowerCase();
      return ['hidden', 'submit', 'button', 'reset', 'file', 'image'].indexOf(type) < 0;
    }
    return t === 'textarea' || t === 'select' || el.isContentEditable === true;
  }

  function allDesc(root, sel) {
    const out = [];
    try {
      const list = root.querySelectorAll(sel);
      for (let i = 0; i < list.length; i++) out.push(list[i]);
    } catch (e) { /* noop */ }
    return out;
  }

  function textOf(el) {
    if (AD.PresetKit && AD.PresetKit.txt) return AD.PresetKit.txt(el);
    return String((el.innerText || el.textContent || '')).replace(/\s+/g, ' ').trim();
  }

  /** 猜测题块结构：返回 {kind, stemSelector, optionSelector, inputSelector, stem, counts} */
  function inferStructure(root) {
    const result = {
      kind: '', stemSelector: '', optionSelector: '', inputSelector: '',
      stem: '', counts: { options: 0, inputs: 0 }, notes: []
    };

    if (root.matches('.examPaper_subject')) {
      const type = textOf(root.querySelector('.subject_type'));
      result.kind = /多选/.test(type) ? 'multi' : /判断/.test(type) ? 'judge' : 'choice';
      result.stemSelector = '.subject_describe';
      result.optionSelector = '.nodeLab';
      result.stem = textOf(root.querySelector('.subject_describe'));
      result.counts.options = allDesc(root, '.nodeLab').length;
      if (!result.stem) result.notes.push('题干尚未加载，等待页面显示完整题干后再预览');
      return result;
    }

    const radios = allDesc(root, 'input[type="radio"]');
    const checks = allDesc(root, 'input[type="checkbox"]');
    const fields = allDesc(root, 'input, textarea, select').filter(isField);
    const textareas = allDesc(root, 'textarea');
    const editables = allDesc(root, '[contenteditable="true"],[contenteditable=""]');

    const choiceInputs = radios.concat(checks);

    // 选项容器：input 的 label / 父级
    if (choiceInputs.length >= 2) {
      const first = choiceInputs[0];
      let optEl = null;
      try { optEl = first.closest('label, .nodeLab, [role="radio"], [role="checkbox"], .option-item, .option'); } catch (e) { optEl = null; }
      if (!optEl) optEl = first.parentElement;
      if (optEl && optEl !== root) {
        result.optionSelector = relativeSelector(root, optEl, { many: true }) || '';
      }
      if (!result.optionSelector) {
        result.optionSelector = 'label';
      }
      result.counts.options = choiceInputs.length;
      if (checks.length >= 2) result.kind = 'multi';
      else result.kind = 'choice';
    } else {
      // 伪选项：文本节点型选项
      const pseudo = allDesc(root, '[class*="option"], [class*="answer"], [class*="choice"], li, [role="radio"], [role="checkbox"]')
        .filter(function (el) {
          if (isField(el) || el.querySelector && el.querySelector('input, textarea, select')) return false;
          const t = textOf(el);
          return t.length >= 1 && t.length <= 300;
        });
      // 同一父级下 ≥2 个才算选项组
      const byParent = new Map();
      pseudo.forEach(function (el) {
        const p = el.parentElement;
        if (!p) return;
        if (!byParent.has(p)) byParent.set(p, []);
        byParent.get(p).push(el);
      });
      let bestGroup = null;
      byParent.forEach(function (arr) {
        if (arr.length >= 2 && (!bestGroup || arr.length > bestGroup.length)) bestGroup = arr;
      });
      if (bestGroup) {
        result.optionSelector = relativeSelector(root, bestGroup[0], { many: true }) || '';
        result.counts.options = bestGroup.length;
        result.kind = 'choice';
        result.notes.push('检测到 ' + bestGroup.length + ' 个文本型选项');
      }
    }

    // 输入框
    const realFields = fields.filter(function (el) {
      if (choiceInputs.indexOf(el) >= 0) return false;
      return true;
    });
    if (realFields.length) {
      const hasTA = textareas.length > 0 || editables.length > 0;
      if (hasTA) {
        result.inputSelector = textareas.length ? 'textarea' : '[contenteditable="true"]';
        if (!result.kind) result.kind = 'qa';
      } else {
        result.inputSelector = relativeSelector(root, realFields[0], { many: true }) || 'input, select';
        if (!result.kind) result.kind = 'blank';
      }
      result.counts.inputs = realFields.length;
    }

    // 题干：root 内文本最多且不含选项/输入框的块
    const optEls = result.optionSelector ? allDesc(root, result.optionSelector) : [];
    const candidates = [root].concat(allDesc(root, 'div, p, h1, h2, h3, h4, h5, span, label, legend, dt, dd, strong, b'));
    let bestStem = null;
    let bestLen = 0;
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (!el || el.nodeType !== 1) continue;
      if (el === root) continue;
      let skip = false;
      for (let j = 0; j < optEls.length; j++) {
        if (el === optEls[j] || (optEls[j].contains && optEls[j].contains(el)) || (el.contains && el.contains(optEls[j]))) { skip = true; break; }
      }
      if (skip) continue;
      if (isField(el)) continue;
      if (el.querySelector && el.querySelector('input, textarea, select, [contenteditable="true"]')) continue;
      const t = textOf(el);
      if (t.length < 4) continue;
      // 太长的容器通常是整页包装
      if (t.length > 600) continue;
      if (t.length > bestLen) { bestLen = t.length; bestStem = el; }
    }
    if (bestStem) {
      result.stemSelector = relativeSelector(root, bestStem, { many: false }) || '';
      result.stem = textOf(bestStem).slice(0, 200);
    }
    if (!result.stem) {
      result.stem = textOf(root).slice(0, 200);
    }

    if (!result.kind) result.kind = result.counts.options ? 'choice' : (result.counts.inputs ? 'blank' : 'generic');
    return result;
  }

  /* ------------------------------ UI ------------------------------ */

  const STYLE = [    ':host{all:initial}',
    '*{box-sizing:border-box;margin:0;padding:0}',
    '.layer{position:fixed;inset:0;z-index:1;font-family:"Inter","SF Pro Text",-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.55;color:#eceef6;}',
    '.veil{position:fixed;inset:0;background:rgba(8,9,15,.34);}',
    '.hl{position:fixed;border:1.5px solid #6366f1;border-radius:5px;background:rgba(99,102,241,.12);',
    '  box-shadow:0 0 0 9999px rgba(8,9,15,.34),0 0 0 1px rgba(255,255,255,.18) inset;pointer-events:none;display:none;}',
    '.tip{position:fixed;left:50%;top:18px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;',
    '  padding:9px 16px;border-radius:999px;background:rgba(22,23,32,.94);border:1px solid rgba(255,255,255,.14);',
    '  box-shadow:0 16px 40px -14px rgba(0,0,0,.8);white-space:nowrap;}',
    '.tip b{color:#a5b4fc;font-weight:600}',
    '.tip .dim{color:#8b90a8;font-size:12px}',
    '.tag{position:fixed;padding:2px 8px;border-radius:5px;font:600 11px/1.5 ui-monospace,monospace;',
    '  background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;pointer-events:none;display:none;',
    '  max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;box-shadow:0 4px 12px -5px rgba(99,102,241,.9);}',
    '.card{position:fixed;right:20px;top:50%;transform:translateY(-50%);width:392px;max-height:calc(100vh - 40px);',
    '  display:none;flex-direction:column;border-radius:16px;overflow:hidden;',
    '  background:rgba(22,23,32,.97);border:1px solid rgba(255,255,255,.12);',
    '  box-shadow:0 32px 80px -24px rgba(0,0,0,.9),0 0 0 1px rgba(255,255,255,.04) inset;}',
    '.card.show{display:flex}',
    '.card::before{content:"";position:absolute;inset:0 0 auto 0;height:2px;background:linear-gradient(90deg,#6366f1,#8b5cf6,transparent 85%)}',
    '.head{display:flex;align-items:center;gap:8px;padding:14px 16px 10px;}',
    '.head h3{font-size:14px;font-weight:650;flex:1}',
    '.head .badge{padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;color:#a5b4fc;',
    '  background:rgba(99,102,241,.16);border:1px solid rgba(99,102,241,.3)}',
    '.body{padding:0 16px 4px;overflow-y:auto;flex:1;min-height:0}',
    '.body::-webkit-scrollbar{width:8px}.body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:99px;border:2px solid transparent;background-clip:padding-box}',
    '.f{margin-bottom:11px}',
    '.f label{display:block;font-size:11.5px;font-weight:600;color:#a9aec4;margin-bottom:5px;letter-spacing:.01em}',
    '.f input[type=text],.f select{width:100%;height:32px;padding:0 10px;border-radius:8px;font:inherit;font-size:12.5px;',
    '  color:#eceef6;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);outline:none;}',
    '.f input[type=text]:focus,.f select:focus{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.2)}',
    '.f input[type=text]{font-family:ui-monospace,monospace;font-size:12px}',
    '.f input[type=text].err{border-color:#f87171;box-shadow:0 0 0 3px rgba(248,113,113,.16)}',
    '.f .hint{font-size:11px;color:#7d829a;margin-top:4px}',
    '.row{display:flex;gap:8px}.row>*{flex:1}',
    '.stem{max-height:66px;overflow:auto;padding:8px 10px;border-radius:8px;font-size:12px;color:#a9aec4;',
    '  background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);white-space:pre-wrap;word-break:break-word}',
    '.res{margin-top:8px;padding:8px 10px;border-radius:8px;font-size:12px;display:none}',
    '.res.show{display:block}',
    '.res.ok{color:#34d399;background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.3)}',
    '.res.warn{color:#fbbf24;background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.3)}',
    '.res.bad{color:#f87171;background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.3)}',
    '.foot{display:flex;align-items:center;gap:8px;padding:12px 16px 14px;border-top:1px solid rgba(255,255,255,.09);flex-wrap:wrap}',
    '.foot .grow{flex:1}',
    'button{display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 13px;border-radius:8px;',
    '  font:inherit;font-size:12.5px;font-weight:550;color:#eceef6;background:transparent;border:1px solid rgba(255,255,255,.14);',
    '  cursor:pointer;transition:transform 120ms cubic-bezier(.23,1,.32,1),background-color 120ms ease,border-color 120ms ease,opacity 120ms ease}',
    'button:hover{background:rgba(255,255,255,.07)}button:active{transform:scale(.97)}',
    'button[disabled]{opacity:.42;cursor:not-allowed;transform:none}',
    'button.primary{color:#fff;background:linear-gradient(135deg,#6366f1,#8b5cf6);border-color:transparent;box-shadow:0 4px 14px -6px rgba(99,102,241,.85)}',
    'button.primary:hover{filter:brightness(1.08);background:linear-gradient(135deg,#6366f1,#8b5cf6)}',
    'button.ghost{color:#a9aec4}',
    'button.icon{width:26px;height:26px;padding:0;color:#7d829a;border-color:transparent}',
    'button.icon:hover{color:#eceef6;background:rgba(255,255,255,.08)}',
    '.picked{display:flex;align-items:center;gap:6px;padding:7px 10px;border-radius:8px;font-size:12px;',
    '  color:#a9aec4;background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.24);margin-bottom:11px}',
    '.picked code{font-family:ui-monospace,monospace;font-size:11.5px;color:#c7d2fe;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.step{display:flex;align-items:center;gap:6px;font-size:11px;color:#7d829a;margin-bottom:10px}',
    '.step i{width:16px;height:16px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;',
    '  font-style:normal;font-size:10px;font-weight:700;background:rgba(99,102,241,.2);color:#a5b4fc}',
    '.step i.on{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff}',
    ':host{--sf-bg:#202327;--sf-text:#f0f2f4;--sf-dim:#b4bac3;--sf-muted:#8f97a3;--sf-line:#ffffff18;--sf-field:#ffffff06;--sf-accent:#6366f1}',
    ':host([data-theme="light"]){--sf-bg:#fff;--sf-text:#20242d;--sf-dim:#525d6b;--sf-muted:#747e8d;--sf-line:#15192520;--sf-field:#f5f6f8}',
    '@media(prefers-color-scheme:light){:host([data-theme="auto"]){--sf-bg:#fff;--sf-text:#20242d;--sf-dim:#525d6b;--sf-muted:#747e8d;--sf-line:#15192520;--sf-field:#f5f6f8}}',
    '.card{width:min(400px,calc(100vw - 32px));right:16px;background:var(--sf-bg);color:var(--sf-text);border-color:var(--sf-line);border-radius:16px;box-shadow:0 16px 60px #0004}.card::before{display:none}',
    '.card.show{animation:sf-picker-in 200ms cubic-bezier(.23,1,.32,1)}@keyframes sf-picker-in{from{opacity:0;transform:translateY(calc(-50% + 8px)) scale(.985)}to{opacity:1;transform:translateY(-50%) scale(1)}}',
    '.head{padding:20px 20px 16px}.head h3{font-size:15px;letter-spacing:-.2px}.head .badge{color:var(--sf-accent);background:color-mix(in srgb,var(--sf-accent) 12%,transparent);border:0;font-size:10px}',
    '.body{padding:0 20px 8px}.foot{padding:16px 20px;border-color:var(--sf-line)}.step{color:var(--sf-muted);padding:0 0 12px;border-bottom:1px solid var(--sf-line)}',
    '.f{margin-bottom:16px}.f label{color:var(--sf-dim);font-weight:500;font-size:11px}.f input[type=text],.f select{height:36px;border-color:var(--sf-line);background:var(--sf-field);color:var(--sf-text);border-radius:7px}.f .hint{color:var(--sf-muted)}',
    '.stem{color:var(--sf-dim);background:var(--sf-field);border-color:var(--sf-line)}.picked{padding:10px;background:var(--sf-field);border-color:var(--sf-line);color:var(--sf-muted)}.picked code{color:var(--sf-dim)}',
    'button{height:34px;border-color:var(--sf-line);color:var(--sf-text)}button.primary,button.primary:hover{background:var(--sf-accent);box-shadow:none}button.icon,button.ghost{color:var(--sf-muted)}',
    ':host([data-noanim]) *{transition:none!important;animation:none!important}@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}'
  ].join('');

  /** 命中测试：临时关掉扩展自己的全屏宿主，否则 elementFromPoint 只会返回宿主 */
  const OWN_HOSTS = ['dati-overlay-host', 'dati-elem-picker-host', HOST_ID];

  function probe(x, y) {
    if (AD.Capture && AD.Capture.elementAt) return AD.Capture.elementAt(x, y);
    const saved = [];
    for (let i = 0; i < OWN_HOSTS.length; i++) {
      const h = document.getElementById(OWN_HOSTS[i]);
      if (h) { saved.push([h, h.style.pointerEvents]); h.style.pointerEvents = 'none'; }
    }
    let el = null;
    try { el = document.elementFromPoint(x, y); } catch (e) { el = null; }
    for (let i = 0; i < saved.length; i++) saved[i][0].style.pointerEvents = saved[i][1];
    if (!el) return null;
    if (el.closest && el.closest('[data-dati-ignore]')) return null;
    return el;
  }

  function build() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-dati-ignore', '1');
    const ui = (AD.Settings.snapshot() || {}).ui || {};
    host.setAttribute('data-theme', ui.theme || 'dark');
    host.toggleAttribute('data-noanim', ui.animate === false);
    host.style.cssText = 'position:fixed;inset:0;z-index:' + Z + ';pointer-events:none;';
    host.style.setProperty('--sf-accent', ui.accent || '#6366f1');
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;

    const layer = document.createElement('div');
    layer.className = 'layer';
    layer.innerHTML = [
      '<div class="veil" style="display:none"></div>',
      '<div class="hl"></div>',
      '<div class="tag"></div>',
      '<div class="tip"><b>点击选择题目所在的整块区域</b><span class="dim">Esc 取消</span></div>',
      '<div class="card" role="dialog" aria-modal="true" aria-label="添加题目模板">',
      '  <div class="head"><h3>添加题目模板</h3><span class="badge">自定义规则</span>',
      '    <button class="icon" data-act="close" title="关闭">✕</button></div>',
      '  <div class="body">',
      '    <div class="step"><i class="on">1</i><span>已框选题块</span><i>2</i><span>确认题型与结构</span><i>3</i><span>保存模板</span></div>',
      '    <div class="picked"><span>根选择器</span><code data-role="rootPreview">—</code></div>',
      '    <div class="f"><label>模板名称</label><input type="text" data-role="name" placeholder="例如：超星-单选题" /></div>',
      '    <div class="row">',
      '      <div class="f"><label>题型</label><select data-role="kind">',
      '        <option value="auto">自动判断</option>',
      '        <option value="choice">单选题</option>',
      '        <option value="multi">多选题</option>',
      '        <option value="judge">判断题</option>',
      '        <option value="blank">填空题</option>',
      '        <option value="qa">问答/大题</option>',
      '        <option value="generic">通用表单</option>',
      '      </select></div>',
      '      <div class="f"><label>题干选择器</label><input type="text" data-role="stem" placeholder="可留空" /></div>',
      '    </div>',
      '    <div class="row">',
      '      <div class="f"><label>选项选择器</label><input type="text" data-role="option" placeholder="可留空" /></div>',
      '      <div class="f"><label>输入框选择器</label><input type="text" data-role="input" placeholder="可留空" /></div>',
      '    </div>',
      '    <div class="f"><label>题干预览</label><div class="stem" data-role="stemPreview">—</div></div>',
      '    <div class="f"><label>下一页按钮选择器</label><input type="text" data-role="nextPage" placeholder="可留空，留空不翻页" /><div class="hint">随此规则保存；需要开启自动翻页总开关。</div><button type="button" data-act="pick-next">在页面上选择按钮</button></div>',
      '    <div class="f"><label><input type="checkbox" data-role="nextEnabled" checked /> 允许此规则自动翻页</label></div>',
      '    <div class="res" data-role="result"></div>',
      '  </div>',
      '  <div class="foot">',
      '    <button class="ghost" data-act="preview">预览命中</button>',
      '    <span class="grow"></span>',
      '    <button class="ghost" data-act="cancel">取消</button>',
      '    <button class="primary" data-act="save">保存模板</button>',
      '  </div>',
      '</div>'
    ].join('');

    shadow.appendChild(style);
    shadow.appendChild(layer);
    if (AD.Capture && AD.Capture.mountPicker) AD.Capture.mountPicker(host);
    else document.documentElement.appendChild(host);

    const $ = function (sel) { return layer.querySelector(sel); };
    return {
      host: host, shadow: shadow, layer: layer,
      veil: $('.veil'), hl: $('.hl'), tag: $('.tag'), tip: $('.tip'), card: $('.card'),
      rootPreview: $('[data-role=rootPreview]'),
      name: $('[data-role=name]'),
      kind: $('[data-role=kind]'),
      stemSel: $('[data-role=stem]'),
      optSel: $('[data-role=option]'),
      inputSel: $('[data-role=input]'),
      nextSel: $('[data-role=nextPage]'),
      nextEnabled: $('[data-role=nextEnabled]'),
      btnPickNext: $('[data-act=pick-next]'),
      stemPreview: $('[data-role=stemPreview]'),
      result: $('[data-role=result]'),
      btnPreview: $('[data-act=preview]'),
      btnSave: $('[data-act=save]'),
      btnCancel: $('[data-act=cancel]'),
      btnClose: $('[data-act=close]')
    };
  }

  function setResult(ui, tone, text) {    ui.result.className = 'res show ' + tone;
    ui.result.textContent = text;
  }

  function clearResult(ui) {
    ui.result.className = 'res';
    ui.result.textContent = '';
  }

  /* ------------------------------ 主流程 ------------------------------ */

  function open(opts) {
    opts = opts || {};
    if (inst) return inst.promise;
    if (AD.Overlay) AD.Overlay.hideHint();

    const ui = build();
    let stage = 'pick';       // pick | configure
    let pickedEl = null;
    let rootSelector = '';
    let inferred = null;
    let prevRules = null;
    let previewRuleId = null;
    let resolveFn = null;
    let lastHover = null;
    let probeBusy = false;
    let probeSequence = 0;

    const promise = new Promise(function (resolve) { resolveFn = resolve; });

    ui.host.style.pointerEvents = 'auto';
    ui.veil.style.display = 'block';

    function paintHighlight(el) {
      if (!el) {
        ui.hl.style.display = 'none';
        ui.tag.style.display = 'none';
        return;
      }
      const r = el.remote ? { left: el.rect.x, top: el.rect.y, width: el.rect.w, height: el.rect.h, bottom: el.rect.y + el.rect.h }
        : el.getBoundingClientRect();
      ui.hl.style.display = 'block';
      ui.hl.style.left = r.left + 'px';
      ui.hl.style.top = r.top + 'px';
      ui.hl.style.width = r.width + 'px';
      ui.hl.style.height = r.height + 'px';
      ui.tag.style.display = 'block';
      const sel = el.remote ? (el.selector || el.tag) : patternSelector(el);
      ui.tag.textContent = sel || tagOf(el);
      const ty = r.top > 28 ? r.top - 24 : r.bottom + 6;
      ui.tag.style.left = Math.max(6, Math.min(window.innerWidth - 220, r.left)) + 'px';
      ui.tag.style.top = ty + 'px';
    }

    async function onMove(e) {
      if (stage !== 'pick' && stage !== 'pick-next') return;
      const el = probe(e.clientX, e.clientY);
      if (!el) return;
      if (el.matches('iframe,frame') && AD.Frame) {
        if (probeBusy) return;
        probeBusy = true;
        const sequence = ++probeSequence;
        const target = await AD.Frame.probeAt(e.clientX, e.clientY).catch(function () { return null; });
        probeBusy = false;
        if (stage !== 'pick' || !ui.host.isConnected || sequence !== probeSequence) return;
        if (target) { lastHover = Object.assign({ remote: true }, target); paintHighlight(lastHover); }
        return;
      }
      ++probeSequence;
      if (el === lastHover) return;
      lastHover = el;
      paintHighlight(el);
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancel();
      }
      // 避免快捷键透传到页面
      if (stage === 'pick' && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
    }

    function cleanup() {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('contextmenu', onCancel, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll, true);
      try { ui.host.remove(); } catch (e) { /* noop */ }
      inst = null;
    }
    function onCancel(e) {
      e.preventDefault(); e.stopImmediatePropagation(); cancel();
    }

    function onScroll() {
      if (stage === 'pick') paintHighlight(lastHover);
    }

    function finish(saved) {
      cleanup();
      if (resolveFn) resolveFn(saved || null);
    }

    async function onClick(e) {
      if (stage !== 'pick' && stage !== 'pick-next') return;
      let el = probe(e.clientX, e.clientY);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      if (stage === 'pick-next') {
        if (el.matches('iframe,frame')) {
          ui.tip.textContent = '请在按钮所在页面内配置此规则，或手动填写按钮选择器；Esc / 右键退出';
          return;
        }
        el = el.closest('button,a,[role="button"],input[type="button"],input[type="submit"]') || el;
        // 唯一定位按钮，避免“上一题”和“下一题”共享 class 时选错。
        const scope = el.getRootNode();
        let node = el, selector = '';
        while (node && node.nodeType === 1) {
          const tag = tagOf(node);
          const part = node.id ? '#' + escIdent(node.id) : tag + ':nth-of-type(' + (Array.from(node.parentNode.children).filter(function (s) { return s.tagName === node.tagName; }).indexOf(node) + 1) + ')';
          selector = part + (selector ? ' > ' + selector : '');
          if (countMatches(selector, scope) === 1) break;
          node = node.parentElement;
        }
        ui.nextSel.value = selector;
        stage = 'configure'; ui.card.classList.add('show'); ui.tip.style.display = 'none'; ui.hl.style.display = 'none'; ui.tag.style.display = 'none';
        return;
      }
      if (el.matches('iframe,frame') && AD.Frame) {
        stage = 'resolving';
        ++probeSequence;
        const target = await AD.Frame.probeAt(e.clientX, e.clientY, { whole: true }).catch(function () { return null; });
        if (!ui.host.isConnected) return;
        if (!target || target.isFrame) {
          stage = 'pick';
          ui.tip.textContent = '此框架暂时无法读取，请等待内容加载后重试；Esc / 右键退出';
          return;
        }
        finish(null);
        const result = await AD.Frame.activateTarget(target, 'template');
        if (!result || !result.ok) AD.Overlay.toast((result && result.error) || '框架已更新，请重新选择', { tone: 'warn' });
        return;
      }

      // 点在题干/选项内部时，向上归并到「整道题」，否则模板只会框住一小段文本
      const siteRoot = el.closest('.examPaper_subject');
      try {
        const q = AD.Detector && AD.Detector.buildFromElement ? AD.Detector.buildFromElement(el) : null;
        if (siteRoot) {
          el = siteRoot;
        } else if (q && q.root && q.root !== document.body && q.root !== document.documentElement) {
          el = q.root;
        }
      } catch (err) { /* 保持原元素 */ }

      // 容器过大（整页/整个列表）时退一步：用被点元素的可视父级
      const r0 = el.getBoundingClientRect();
      if (!siteRoot && (r0.height > window.innerHeight * 0.8 || r0.width > window.innerWidth * 0.95)) {
        let up = el.parentElement;
        let guard = 0;
        while (up && guard++ < 4) {
          const rr = up.getBoundingClientRect();
          if (rr.height <= window.innerHeight * 0.8 && rr.width <= window.innerWidth * 0.95) { el = up; break; }
          up = up.parentElement;
        }
      }

      pickRoot(el);
    }

    function pickRoot(el) {
      pickedEl = el;
      rootSelector = patternSelector(el);
      inferred = inferStructure(el);

      stage = 'configure';
      ui.hl.style.display = 'none';
      ui.tag.style.display = 'none';
      ui.tip.style.display = 'none';
      ui.veil.style.display = 'block';

      ui.rootPreview.textContent = rootSelector || '（未生成）';
      const hostName = location.hostname.replace(/^www\./, '') || '本页';
      ui.name.value = hostName + '-' + (AD.KIND_LABEL[inferred.kind] || '题目');
      ui.kind.value = inferred.kind || 'auto';
      ui.stemSel.value = inferred.stemSelector || '';
      ui.optSel.value = inferred.optionSelector || '';
      ui.inputSel.value = inferred.inputSelector || '';
      ui.stemPreview.textContent = inferred.stem || '（未识别到题干文本）';

      ui.card.classList.add('show');
      ui.name.focus();
      ui.name.select();
      clearResult(ui);
    }

    /** 组装规则对象 */
    function buildRule() {
      return {
        id: 'rule_' + AD.hash(rootSelector + '|' + ui.name.value + '|' + Date.now()),
        name: String(ui.name.value || '').trim() || '自定义模板',
        enabled: true,
        kind: ui.kind.value === 'auto' ? 'auto' : ui.kind.value,
        rootSelector: rootSelector,
        stemSelector: String(ui.stemSel.value || '').trim(),
        optionSelector: String(ui.optSel.value || '').trim(),
        inputSelector: String(ui.inputSel.value || '').trim(),
        nextPageSelector: String(ui.nextSel.value || '').trim(),
        nextPageEnabled: ui.nextEnabled.checked
      };
    }

    function validateRule(rule) {
      if (!rule.rootSelector) return '根选择器为空，请重新框选';
      const n = countMatches(rule.rootSelector, pickedEl ? pickedEl.getRootNode() : document);
      if (n === 0) return '根选择器匹配不到任何元素';
      const bad = [];
      ['stemSelector', 'optionSelector', 'inputSelector', 'nextPageSelector'].forEach(function (key) {
        const sel = rule[key];
        if (!sel) return;
        try { document.querySelector(sel); } catch (e) { bad.push(key); }
      });
      if (bad.length) return '选择器语法有误：' + bad.join('、');
      return '';
    }

    async function previewRule() {
      const rule = buildRule();
      const err = validateRule(rule);
      if (err) return setResult(ui, 'bad', err);

      ui.btnPreview.disabled = true;
      setResult(ui, 'warn', '正在预览…');

      try {
        const settings = await AD.Settings.get();
        prevRules = JSON.parse(JSON.stringify(settings.detect.customRules || []));
        const list = prevRules.filter(function (r) { return r.id !== rule.id; }).concat([rule]);
        await AD.Settings.save({ detect: { customRules: list } });
        previewRuleId = rule.id;

        const found = AD.Detector.scan(document, {});
        const mine = found.filter(function (q) { return q.presetId === rule.id || q.ruleId === rule.id; });
        const list2 = (mine.length ? mine : found);

        if (!list2.length) {
          setResult(ui, 'bad', '没有命中任何题目。请检查根选择器，或尝试把范围选大一点（包含题干和选项）。');
        } else {
          const sample = list2[0];
          setResult(ui, 'ok',
            '命中 ' + list2.length + ' 道题 · 题型 ' + (AD.KIND_LABEL[sample.kind] || sample.kind) +
            ' · 选项 ' + (sample.options || []).length + ' · 输入 ' + (sample.inputs || []).length +
            (sample.stem ? '\n首题：' + String(sample.stem).slice(0, 60) : ''));
        }
      } catch (e) {
        setResult(ui, 'bad', '预览失败：' + ((e && e.message) || e));
      } finally {
        ui.btnPreview.disabled = false;
      }
    }

    async function saveRule() {
      const rule = buildRule();
      const err = validateRule(rule);
      if (err) return setResult(ui, 'bad', err);

      ui.btnSave.disabled = true;
      try {
        const settings = await AD.Settings.get();
        const list = (settings.detect.customRules || []).filter(function (r) {
          return r.id !== rule.id && r.id !== previewRuleId;
        }).concat([rule]);
        await AD.Settings.save({ detect: { customRules: list } });
        // 立即按新规则重扫
        try { AD.Detector.scan(document, {}); } catch (e) { /* noop */ }
        AD.Overlay.toast('模板已保存：' + rule.name + '（可在设置 → 题目预设 中管理）', { tone: 'success', ms: 3200 });
        finish(rule);
      } catch (e) {
        setResult(ui, 'bad', '保存失败：' + ((e && e.message) || e));
        ui.btnSave.disabled = false;
      }
    }

    function cancel() {
      if (prevRules && previewRuleId) {
        // 撤销预览时写入的规则
        AD.Settings.save({ detect: { customRules: prevRules } }).catch(function () { });
      }
      finish(null);
    }

    /* 绑定 */
    ui.host.addEventListener('mousemove', onMove, true);
    ui.host.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('contextmenu', onCancel, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll, true);

    ui.btnPreview.addEventListener('click', previewRule);
    ui.btnSave.addEventListener('click', saveRule);
    ui.btnCancel.addEventListener('click', cancel);
    ui.btnClose.addEventListener('click', cancel);
    ui.kind.addEventListener('change', function () {
      clearResult(ui);
      const k = ui.kind.value;
      // 按题型给出合理提示
      if (k === 'qa' && !ui.inputSel.value) ui.inputSel.value = 'textarea';
      if ((k === 'choice' || k === 'multi' || k === 'judge') && !ui.optSel.value) {
        ui.optSel.value = 'label';
      }
    });
    ui.stemSel.addEventListener('input', clearResult);
    ui.optSel.addEventListener('input', clearResult);
    ui.inputSel.addEventListener('input', clearResult);
    ui.btnPickNext.addEventListener('click', function () {
      stage = 'pick-next'; ui.card.classList.remove('show'); ui.tip.style.display = 'flex';
      ui.tip.textContent = '点击下一页按钮以保存位置（不会触发按钮）；Esc / 右键退出';
    });

    ui.tip.innerHTML = '<b>点击选择题目所在的整块区域</b><span class="dim">Esc / 右键 退出</span>';

    inst = { promise: promise, ui: ui };
    if (opts.element && opts.element.isConnected) pickRoot(opts.element);
    return promise;
  }

  AD.Picker = {
    open: open,
    patternSelector: patternSelector,
    relativeSelector: relativeSelector,
    inferStructure: inferStructure,
    isOpen: function () { return !!inst; }
  };
}(globalThis.AD = globalThis.AD || {}));
