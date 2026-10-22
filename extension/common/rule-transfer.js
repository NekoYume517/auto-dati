/** Single-rule sharing and validated import; shared by settings and the page editor. */
(function(AD){
  'use strict';
  let active=null;
  function encode(rules){const bytes=new TextEncoder().encode(JSON.stringify({format:'autodati-custom-site-rules',version:1,rules:rules}));let binary='';for(const b of bytes)binary+=String.fromCharCode(b);return btoa(binary);}
  function decode(text){
    text=text.replace(/\s/g,'');if(text.length>2800000)throw Error('编码过长');
    const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(text),c=>c.charCodeAt(0))));
    if(data.format!=='autodati-custom-site-rules'||data.version!==1||!Array.isArray(data.rules)||!data.rules.length||data.rules.length>500)throw Error('规则编码格式无效');
    return data.rules.map(function(r,i){
      if(!r||typeof r.name!=='string'||!r.name.trim()||typeof r.rootSelector!=='string'||!r.rootSelector.trim()||!['auto','choice','multi','judge','blank','qa','generic'].includes(r.kind))throw Error('第 '+(i+1)+' 条规则缺少名称、题型或题块容器');
      const clean={id:typeof r.id==='string'&&r.id.length<120?r.id:'rule_'+crypto.randomUUID(),name:r.name.trim().slice(0,120),kind:r.kind,enabled:r.enabled!==false,nextPageEnabled:r.nextPageEnabled!==false};
      for(const key of ['rootSelector','stemSelector','optionSelector','inputSelector','nextPageSelector']){const s=r[key]||'';if(typeof s!=='string'||s.length>500)throw Error('第 '+(i+1)+' 条规则选择器无效');try{if(s)document.querySelector(s);}catch(e){throw Error('第 '+(i+1)+' 条规则选择器语法无效');}clean[key]=s.trim();}
      clean.domains=Array.isArray(r.domains)?r.domains.slice(0,100).map(d=>String(d).slice(0,300)):typeof r.domains==='string'?r.domains.slice(0,2000):'';return clean;
    });
  }
  function open(opts){
    if(active)active();opts=opts||{};const exporting=opts.mode==='export';
    const host=document.createElement('div');host.setAttribute('data-dati-ignore','1');const root=host.attachShadow({mode:'open'});
    root.innerHTML='<style>:host{all:initial}*{box-sizing:border-box;font-family:system-ui,"Microsoft YaHei",sans-serif}dialog{width:min(560px,calc(100vw - 32px));max-height:85vh;overflow:auto;margin:auto;padding:24px;border:1px solid #d9dde5;border-radius:14px;background:#fff;color:#20242d;box-shadow:0 20px 80px #0005}dialog::backdrop{background:#0007}header,footer{display:flex;align-items:center;gap:12px}h2{font-size:18px;flex:1;margin:0}textarea{width:100%;height:160px;resize:vertical;margin:16px 0;padding:12px;border:1px solid #b9c0cd;border-radius:8px;font:12px/1.6 monospace;background:transparent;color:inherit}button{cursor:pointer;border:1px solid #c9cfdb;border-radius:7px;padding:8px 14px;background:transparent;color:inherit}button:disabled{opacity:.5;cursor:default}button:focus-visible,textarea:focus-visible{outline:2px solid #6366f1;outline-offset:2px}footer{justify-content:flex-end}p,ul{font-size:13px;line-height:1.7;overflow-wrap:anywhere}ul{max-height:150px;overflow:auto;padding-left:20px}dialog[data-theme=dark]{background:#202327;color:#f0f2f4;border-color:#ffffff26}@media(prefers-color-scheme:dark){dialog[data-theme=auto]{background:#202327;color:#f0f2f4}}</style><dialog><header><h2></h2><button data-close aria-label="关闭">✕</button></header><p data-description></p><textarea spellcheck="false" aria-label="规则 Base64 编码"></textarea><ul></ul><p role="status" aria-live="polite"></p><footer><button data-cancel>关闭</button><button data-confirm></button></footer></dialog>';
    document.documentElement.append(host);const dialog=root.querySelector('dialog'),area=root.querySelector('textarea'),status=root.querySelector('[role=status]'),list=root.querySelector('ul'),confirm=root.querySelector('[data-confirm]');
    dialog.dataset.theme=AD.Settings.snapshot().ui.theme;dialog.setAttribute('aria-label',exporting?'导出规则':'导入规则');root.querySelector('h2').textContent=exporting?'导出规则':'导入规则';
    root.querySelector('[data-description]').textContent=exporting?'此编码仅包含下方列出的规则，可复制后分享。':'粘贴 Base64 编码，检查预览后确认导入。已有规则 ID 将跳过。';
    let parsed=[],closed=false,selected=new Set();
    function showNames(rules){list.replaceChildren();for(const r of rules){const li=document.createElement('li');li.textContent=r.name;list.append(li);}}
    function selection(){confirm.disabled=!selected.size;confirm.textContent=parsed.length===1?'确认导入此规则':'确认导入（'+selected.size+' 条）';status.textContent='共 '+parsed.length+' 条规则，已选 '+selected.size+' 条；确认后才会保存';}
    function importPreview(){
      list.replaceChildren();list.style.maxHeight='280px';
      for(let index=0;index<parsed.length;index++){
        const r=parsed[index],item=document.createElement('li'),label=document.createElement('label'),check=document.createElement('input'),details=document.createElement('details'),summary=document.createElement('summary');
        item.style.marginBottom='12px';check.type='checkbox';check.checked=true;check.dataset.importIndex=index;label.append(check,document.createTextNode(' '+r.name));item.append(label);
        check.onchange=function(){if(check.checked)selected.add(index);else selected.delete(index);selection();};
        details.open=parsed.length===1;summary.textContent='预览规则配置';details.append(summary);
        const info={名称:r.name,题型:r.kind,生效域名:Array.isArray(r.domains)?r.domains.join(', '):r.domains||'所有网站',启用:r.enabled?'是':'否',题块容器:r.rootSelector,题干:r.stemSelector||'自动识别',选项:r.optionSelector||'自动识别',输入框:r.inputSelector||'未配置',自动翻页:r.nextPageEnabled?'允许':'关闭',下一页按钮:r.nextPageSelector||'未配置'};
        const dl=document.createElement('dl');for(const [key,value] of Object.entries(info)){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=key;dt.style.fontWeight='600';dd.textContent=value;dd.style.cssText='margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere';dl.append(dt,dd);}details.append(dl);item.append(details);list.append(item);
      }
      selection();
    }
    function close(){if(closed)return;closed=true;window.removeEventListener('keydown',onKey,true);dialog.close();host.remove();if(active===close)active=null;}
    function onKey(event){if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();}}
    window.addEventListener('keydown',onKey,true);
    active=close;root.querySelector('[data-close]').onclick=close;root.querySelector('[data-cancel]').onclick=close;dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
    if(exporting){parsed=opts.rules||[];area.value=encode(parsed);area.readOnly=true;showNames(parsed);status.textContent='共 '+parsed.length+' 条规则';confirm.textContent='复制编码';}
    else{confirm.textContent='确认导入';confirm.disabled=true;area.addEventListener('input',function(){confirm.disabled=true;list.replaceChildren();parsed=[];selected.clear();try{parsed=decode(area.value);selected=new Set(parsed.map((_,i)=>i));importPreview();}catch(e){status.textContent=area.value.trim()?'编码无效：'+e.message:'请粘贴规则编码';}});}
    confirm.onclick=async function(){
      if(exporting){area.focus();area.select();try{await navigator.clipboard.writeText(area.value);status.textContent='编码已复制';}catch(e){status.textContent='请按 Ctrl+C 复制已选中的编码';}return;}
      if(!selected.size)return;
      const chosen=parsed.filter((_,i)=>selected.has(i));confirm.disabled=true;try{const latest=await AD.Settings.get(),rules=JSON.parse(JSON.stringify(latest.detect.customRules)),ids=new Set(rules.map(r=>r.id));let added=0;for(const r of chosen){if(ids.has(r.id))continue;rules.push(r);ids.add(r.id);added++;}const saved=await AD.Settings.save({detect:{customRules:rules}});if(opts.onImported)opts.onImported(saved);if(!closed)status.textContent='导入完成：新增 '+added+' 条，跳过重复 '+(chosen.length-added)+' 条';}catch(e){if(!closed){status.textContent='导入失败：'+e.message;confirm.disabled=false;}}
    };
    dialog.showModal();area.focus();if(exporting)area.select();
  }
  AD.RuleTransfer={isOpen:function(){return !!active;},open:open,encode:encode,decode:decode};
}(globalThis.AD=globalThis.AD||{}));
