/** Unified rule editor and frame-local preview; draft edits never alter detection until saved. */
(function(AD){
  'use strict';
  let editor=null, previewHost=null, activePreview=null;
  const fields={name:'规则名称',domains:'生效域名（逗号分隔）',rootSelector:'题块容器',stemSelector:'题干',optionSelector:'选项',inputSelector:'输入框',nextPageSelector:'下一页按钮'};
  function clear(){if(previewHost)previewHost.remove();previewHost=null;}
  function paint(rule){
    clear(); activePreview=rule;
    if(!rule)return 0;
    const host=document.createElement('div');host.setAttribute('data-dati-ignore','1');host.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483646';
    const shadow=host.attachShadow({mode:'open'});let count=0;
    const scopes=[document];for(let i=0;i<scopes.length;i++)AD.PresetKit.all(scopes[i],'*').forEach(function(el){const root=AD.PresetKit.shadowRootOf(el);if(root)scopes.push(root);});
    for(const [key,color] of [['rootSelector','#22c55e'],['nextPageSelector','#f59e0b']])for(const scope of scopes)for(const el of AD.PresetKit.all(scope,rule[key]||':not(*)')){
      if(AD.PresetKit.isIgnored(el)||!AD.Detector.isVisible(el,{viewportOnly:true}))continue;
      const r=el.getBoundingClientRect(),box=document.createElement('div');box.style.cssText='position:fixed;box-sizing:border-box;pointer-events:none;border:2px solid '+color+';background:'+color+'16;left:'+r.x+'px;top:'+r.y+'px;width:'+r.width+'px;height:'+r.height+'px';
      const label=document.createElement('span');label.textContent=rule.name+' · '+fields[key];label.style.cssText='position:absolute;top:0;left:0;background:'+color+';color:#fff;font:12px system-ui;padding:2px 6px';box.append(label);shadow.append(box);count++;
    }
    document.documentElement.append(host);previewHost=host;return count;
  }
  function requestPreview(rule){return chrome.runtime.sendMessage({type:'DATI_RULE_PREVIEW',rule:rule});}
  async function open(){
    if(editor){editor.dialog.focus();return;}
    const host=document.createElement('div');host.setAttribute('data-dati-ignore','1');const shadow=host.attachShadow({mode:'open'});
    host.style.cssText='position:fixed;inset:0;background:transparent;border:0;margin:0;padding:0;pointer-events:none;z-index:2147483647';
    shadow.innerHTML='<style>'+AD.OVERLAY_CSS+'</style><style>:host{all:initial}*{box-sizing:border-box;font-family:system-ui,"Microsoft YaHei",sans-serif}dialog{width:min(760px,calc(100vw - 32px));max-height:85vh;overflow:auto;border:1px solid #d9dde5;border-radius:16px;background:#fff;color:#20242d;padding:24px;box-shadow:0 24px 80px #0005}dialog::backdrop{background:#0005}header,footer,.field{display:flex;gap:10px;align-items:center}header h2{flex:1;font-size:19px;margin:0}main{display:grid;grid-template-columns:170px 1fr;gap:20px;margin:20px 0}aside{display:flex;flex-direction:column;gap:6px}button,input,select{font:inherit;font-size:13px;padding:9px;border:1px solid #d9dde5;border-radius:7px;background:#fff;color:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible{outline:2px solid #6366f1}button[aria-current=true]{background:#eef0ff;border-color:#6366f1}label{font-size:12px;display:block;margin:12px 0 5px}.field input{flex:1;min-width:0;width:100%}footer{justify-content:flex-end}p{font-size:12px;color:#606b7b}.primary{background:#6366f1;color:white;border-color:#6366f1}@media(max-width:560px){main{grid-template-columns:1fr}aside{flex-direction:row;overflow:auto}}</style><div data-rule-panel class="dati-panel is-enter" role="dialog" tabindex="-1" aria-label="预设编辑器"><header><h2>预设编辑器</h2><button data-close aria-label="关闭">✕</button></header><p>选择规则查看当前网页上的匹配框；编辑和拾取不会立即修改已保存的配置。</p><main><aside></aside><section></section></main><p role="status"></p><footer><button data-new>新增规则</button><button data-preview>显示匹配框</button><button class="primary" data-save>保存规则</button></footer></div>';
    document.documentElement.append(host);const dialog=shadow.querySelector('[role=dialog]'),body=shadow.querySelector('section'),list=shadow.querySelector('aside'),status=shadow.querySelector('[role=status]');
    let rules=JSON.parse(JSON.stringify((await AD.Settings.get()).detect.customRules)),draft=null,selected=-1,closed=false,revision=0;
    editor={dialog:dialog};
    function read(){for(const key of Object.keys(fields)){const value=body.querySelector('[data-field="'+key+'"]').value.trim();draft[key]=key==='domains'?value.split(/[,;\n]+/).map(s=>s.trim()).filter(Boolean):value;}draft.enabled=body.querySelector('[data-enabled]').checked;draft.nextPageEnabled=body.querySelector('[data-next-enabled]').checked;draft.kind=body.querySelector('select').value;return draft;}
    async function preview(){const seq=++revision;const r=await requestPreview(read());if(!closed && seq===revision)status.textContent=r.ok?'当前网页匹配 '+r.count+' 个位置（绿色：题块，橙色：翻页按钮）':'无法读取当前网页';}
    function renderList(){list.replaceChildren();rules.forEach(function(rule,index){const button=document.createElement('button');button.textContent=rule.name;button.setAttribute('aria-current',String(index===selected));button.onclick=()=>select(index);list.append(button);});}
    function select(index){selected=index;draft=JSON.parse(JSON.stringify(index<0?{id:'rule_'+crypto.randomUUID(),name:'新规则',kind:'auto',enabled:true,nextPageEnabled:true,domains:[location.hostname]}:rules[index]));body.replaceChildren();renderList();
      for(const [key,labelText] of Object.entries(fields)){const label=document.createElement('label');label.textContent=labelText;const row=document.createElement('div');row.className='field';const input=document.createElement('input');input.dataset.field=key;input.value=Array.isArray(draft[key])?draft[key].join(', '):(draft[key]||'');row.append(input);
        if(key.endsWith('Selector')){const pick=document.createElement('button');pick.textContent='选元素';pick.onclick=async function(){read();dialog.hidden=true;host.style.display='none';try{const result=await AD.Capture.pickElement({exact:true});if(closed)return;if(result && result.selector)input.value=result.selector;else if(result)status.textContent='请选择元素，框选区域不能作为选择器';}finally{if(!closed){host.style.display='';dialog.hidden=false;await preview();}}};row.append(pick);}input.onchange=()=>preview();body.append(label,row);}
      const kind=document.createElement('select');for(const value of ['auto','choice','multi','judge','blank','qa','generic']){const option=document.createElement('option');option.value=value;option.textContent=value==='auto'?'自动判断':(AD.KIND_LABEL[value]||value);kind.append(option);}kind.value=draft.kind||'auto';body.append(kind);
      for(const [attr,text,value] of [['data-enabled','启用规则',draft.enabled!==false],['data-next-enabled','允许自动翻页',draft.nextPageEnabled!==false]]){const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.setAttribute(attr,'');check.checked=value;label.append(check,document.createTextNode(text));body.append(label);}preview();
    }
    function close(){closed=true;revision++;requestPreview(null);if(unsubscribe)unsubscribe();window.removeEventListener('keydown',onKey,true);window.removeEventListener('resize',clamp);host.remove();editor=null;}
    shadow.querySelector('[data-close]').onclick=close;dialog.addEventListener('contextmenu',function(e){e.preventDefault();close();});
    shadow.querySelector('[data-new]').onclick=()=>select(-1);shadow.querySelector('[data-preview]').onclick=preview;
    shadow.querySelector('[data-save]').onclick=async function(){read();if(!draft.name||!draft.rootSelector){status.textContent='请填写名称和题块容器';return;}for(const key of Object.keys(fields).filter(k=>k.endsWith('Selector')))try{if(draft[key])document.querySelector(draft[key]);}catch(e){status.textContent=fields[key]+'选择器语法无效';return;}
      const latest=await AD.Settings.get();const saved=latest.detect.customRules.filter(r=>r.id!==draft.id).concat([draft]);await AD.Settings.save({detect:{customRules:saved}});rules=JSON.parse(JSON.stringify(saved));selected=rules.findIndex(r=>r.id===draft.id);renderList();status.textContent='规则已保存';};
    const style=document.createElement('style');style.textContent='.dati-panel{width:min(620px,calc(100vw - 24px));max-height:calc(100vh - 32px);right:16px;top:16px;padding:20px;pointer-events:auto}.dati-panel[hidden]{display:none!important}.dati-panel header{cursor:grab;touch-action:none;flex-shrink:0}.dati-panel main{overflow:auto;min-height:0}.dati-panel input,.dati-panel select,.dati-panel button{background:var(--dati-bg-elev);color:var(--dati-text);border-color:var(--dati-border)}.dati-panel p{color:var(--dati-text-dim)}.dati-panel .primary{background:var(--dati-accent);color:white}.dati-panel button[aria-current=true]{background:var(--dati-accent-soft);border-color:var(--dati-accent)}';shadow.append(style);
    function theme(settings){AD.Overlay.applyTheme(dialog,settings);}
    theme(AD.Settings.snapshot());const unsubscribe=AD.Settings.subscribe(theme);
    function onKey(e){if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close();}}
    window.addEventListener('keydown',onKey,true);
    function clamp(){const r=dialog.getBoundingClientRect();if(dialog.style.left){dialog.style.left=Math.max(8,Math.min(innerWidth-r.width-8,r.left))+'px';dialog.style.top=Math.max(8,Math.min(innerHeight-r.height-8,r.top))+'px';}}
    window.addEventListener('resize',clamp);
    const header=dialog.querySelector('header');let drag=null;
    header.addEventListener('pointerdown',function(e){if(e.button!==0||e.target.closest('button'))return;const r=dialog.getBoundingClientRect();drag={x:e.clientX-r.left,y:e.clientY-r.top};header.setPointerCapture(e.pointerId);e.preventDefault();});
    header.addEventListener('pointermove',function(e){if(!drag)return;dialog.style.right='auto';dialog.style.left=Math.max(8,Math.min(innerWidth-dialog.offsetWidth-8,e.clientX-drag.x))+'px';dialog.style.top=Math.max(8,Math.min(innerHeight-dialog.offsetHeight-8,e.clientY-drag.y))+'px';});
    function endDrag(){drag=null;}header.addEventListener('pointerup',endDrag);header.addEventListener('pointercancel',endDrag);
    if(host.showPopover){host.setAttribute('popover','manual');host.showPopover();}
    select(rules.length?0:-1);
  }
  let queued=false;function refresh(){if(queued||!activePreview)return;queued=true;requestAnimationFrame(function(){queued=false;if(activePreview)paint(activePreview);});}window.addEventListener('scroll',refresh,true);window.addEventListener('resize',refresh);
  AD.RuleEditor={open:open,paint:paint};
}(globalThis.AD=globalThis.AD||{}));
