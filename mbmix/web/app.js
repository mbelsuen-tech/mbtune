"use strict";
/* MB Soundtools · MBMix — interfaz táctil (estilo Mixing Station) para Behringer WING */

const $=s=>document.querySelector(s);
const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
const range=(a,b)=>Array.from({length:b-a+1},(_,i)=>a+i);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

/* ================================================================ estado */
let MODEL={layers:[],targets:[],colors:[],mains:[]},STRIPS=[],BY={},SPEC={},S={},M={},status={},scenes=[],layout={custom:[],groups:[],links:[],views:[]};
let locked=false;
let ws=null,wsTries=0;
let layer=load("layer","in1"),sendBus=+load("sendBus",0),detailId=null,detailTab=null,eqBand=null;
const active=new Set();          // parámetros que se están moviendo con el dedo (no se pisan con lo que llega)

function load(k,d){try{const n=window.MBNativeStore;if(n&&("ui."+k) in n)return n["ui."+k];const v=localStorage.getItem("mbmix."+k);return v==null?d:v}catch(e){return d}}
function store(k,v){try{if(window.MBNativeStore){MBNativeStore["ui."+k]=String(v);window.webkit.messageHandlers.mbmix.postMessage({op:"save",key:"ui."+k,value:String(v)})}
  localStorage.setItem("mbmix."+k,v)}catch(e){}}

/* ---- personalización (se guarda en cada iPad) ---- */
const PDEF={theme:"dark",zoom:1,cols:0,proc:1,pan:1,solo:1,scale:1,meter:1,big:0,dbl:1,fine:0,accent:"red",musician:0};
let P=Object.assign({},PDEF,(()=>{try{return JSON.parse(load("prefs","{}"))}catch(e){return{}}})());
const ACCENTS={red:["Rojo MB","#e3101c","#ef2430","#b80c16","#7a0710","227,16,28"],blue:["Azul","#2f7bf2","#4b8ff7","#1a5fd0","#0f3a80","47,123,242"],
  green:["Verde","#22b357","#34d27b","#16863f","#0c4a23","34,179,87"],amber:["Ámbar","#f29a0f","#ffb238","#c97800","#6a3f00","242,154,15"],
  purple:["Morado","#9b4de0","#b06ad8","#7330b0","#3f1a63","155,77,224"],cyan:["Cian","#14b8c8","#38d0de","#0c8a96","#064a50","20,184,200"]};
const ACC=()=>(ACCENTS[P.accent]||ACCENTS.red)[1],ACCRGB=()=>(ACCENTS[P.accent]||ACCENTS.red)[5];
const CVC={};
function tc(k){if(!(k in CVC))CVC[k]=getComputedStyle(document.documentElement).getPropertyValue("--cv-"+k).trim()||"#888";return CVC[k]}
const darkMQ=matchMedia("(prefers-color-scheme: dark)");
function applyTheme(){const t=P.theme==="auto"?(darkMQ.matches?"dark":"light"):P.theme;
  document.documentElement.dataset.theme=t;for(const k in CVC)delete CVC[k];
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content",t==="light"?"#e7e9ed":"#050505")}
darkMQ.addEventListener?.("change",()=>{if(P.theme==="auto"){applyTheme();notifyAll()}});
function savePrefs(){store("prefs",JSON.stringify(P));applyPrefs()}
function applyPrefs(){
  applyTheme();
  const b=document.body.classList;for(const k of["proc","pan","solo","scale","meter"])b.toggle("hide-"+k,!P[k]);
  b.toggle("bignames",!!P.big);b.toggle("musician",!!P.musician);
  const a=ACCENTS[P.accent]||ACCENTS.red,r=document.documentElement.style;
  r.setProperty("--red",a[1]);r.setProperty("--btn-red",`linear-gradient(180deg,${a[2]} 0%,${a[3]} 100%)`);r.setProperty("--red-deep",a[4]);
  r.setProperty("--glow",`0 0 14px rgba(${a[5]},.55)`);r.setProperty("--accent-rgb",a[5]);
  const st=document.getElementById("strips");if(st)st.style.gridAutoColumns=P.cols?`calc((100% - ${(P.cols-1)*4}px) / ${P.cols})`:"";
  const z=+P.zoom||1,bs=document.body.style;b.toggle("zoomed",z!==1);document.documentElement.style.setProperty("--zoom",z);
  bs.transform=z!==1?`scale(${z})`:"";bs.width=z!==1?`calc(100% / ${z})`:"";bs.height=z!==1?`calc(100% / ${z})`:"";
}
const ZOOM=()=>+P.zoom||1;
function musicianLayers(){
  if(!P.musician)return LAYERS;
  const ok=id=>BY[id]?.sends||(groupOf(id)&&groupOf(id).m.some(x=>BY[x]?.sends));
  return LAYERS.filter(L=>!L.add).map(L=>({...L,ids:()=>L.ids().filter(ok)})).filter(L=>L.ids().length);
}

/* ---- observadores: cada control se redibuja cuando cambia su parámetro ---- */
const W=new Map(),SCOPES=new Map();let METERS=[];
function watch(scope,keys,fn){const e={fn,keys};for(const p of keys){if(!W.has(p))W.set(p,new Set());W.get(p).add(e)}
  if(!SCOPES.has(scope))SCOPES.set(scope,[]);SCOPES.get(scope).push(e);fn();return e}
function unwatch(scope){for(const e of SCOPES.get(scope)||[])for(const p of e.keys)W.get(p)?.delete(e);SCOPES.delete(scope);METERS=METERS.filter(m=>m.scope!==scope)}
function notify(keys){const run=new Set();for(const p of keys)W.get(p)?.forEach(e=>run.add(e));run.forEach(e=>e.fn())}
function notifyAll(){SCOPES.forEach(l=>l.forEach(e=>e.fn()))}

function setP(k,v){const s=SPEC[k];if(!s||locked)return;if(s[0]==="n")v=Math.round(clamp(+v,s[1],s[2])*100)/100;S[k]=v;send({t:"set",p:k,v});notify([k])}
const tog=k=>setP(k,+S[k]?0:1);
function hold(k){active.add(k)} function release(k){setTimeout(()=>active.delete(k),350)}

/* ================================================================ valores: posición 0..1 <-> unidades reales */
const FD={
  pos(d){return d>=-10?(d+30)/40:d>=-30?(d+50)/80:d>=-60?(d+70)/160:d>-90?(d+90)/480:0},
  db(p){return p>=.5?p*40-30:p>=.25?p*80-50:p>=.0625?p*160-70:p>0?p*480-90:-144},
};
function norm(k){const s=SPEC[k],v=+S[k];if(!s)return 0;
  switch(s[3]){case"fdr":return FD.pos(v);case"enum":{const l=s[5];let i=0;l.forEach((x,j)=>{if(Math.abs(x-v)<Math.abs(l[i]-v))i=j});return i/(l.length-1)}case"log":return clamp(Math.log(v/s[1])/Math.log(s[2]/s[1]));
    case"log1":return clamp(Math.log1p(v)/Math.log1p(s[2]));default:return clamp((v-s[1])/(s[2]-s[1]))}}
function denorm(k,n){const s=SPEC[k];n=clamp(n);
  switch(s[3]){case"fdr":return FD.db(n);case"enum":return s[5][Math.round(n*(s[5].length-1))];case"log":return s[1]*Math.pow(s[2]/s[1],n);case"log1":return Math.expm1(n*Math.log1p(s[2]));
    default:return s[1]+n*(s[2]-s[1])}}
const setN=(k,n)=>setP(k,denorm(k,n));

const F={
  db(d){d=+d;return d<=-89.5?"-∞":(d>0?"+":"")+d.toFixed(Math.abs(d)>=10?0:1)},
  dbu(d){return F.db(d)+(d<=-89.5?"":" dB")},
  hz(h){h=+h;return h<1000?Math.round(h)+" Hz":(h/1000).toFixed(h<10000?2:1)+" kHz"},
  ms(m){m=+m;return m<10?m.toFixed(1)+" ms":m<1000?Math.round(m)+" ms":(m/1000).toFixed(2)+" s"},
  pan(p){p=Math.round(+p);return p===0?"Centro":p<0?"Izq "+(-p):"Der "+p},
};

const NOCOLOR="#4a4a52";

/* ================================================================ tiras */
const nameOf=s=>S[s.id+".name"]||s.label;
const colorOf=s=>(MODEL.colors[+S[s.id+".color"]||0]||[NOCOLOR])[0];
/* envíos: los canales envían a los buses (1-16); los buses y mains, a las matrices (101-108) */
const sendsTo=(s,bus)=>!!bus&&(bus>100?!!s.mtxSends:!!s.sends);
const faderKey=(s,bus)=>sendsTo(s,bus)?`${s.id}.send.${bus}.lvl`:s.id+".fader";
const mtxTargets=()=>MODEL.mtxTargets||[];
const target=n=>MODEL.targets.find(t=>t.n===n)||mtxTargets().find(t=>t.n===n);
const busStrip=n=>BY[target(n)?.id];
const busColor=n=>{const c=colorOf(busStrip(n));return c===NOCOLOR?"var(--red)":c};
function bandName(s,b){const i=s.eq.indexOf(b),n=s.eq.length;return b==="l"||(i===0&&s.eqTypes)?"Graves":b==="h"||(i===n-1&&s.eqTypes)?"Agudos":"Medios "+(s.eqTypes?i:b)}
function bandLetter(s,b){const i=s.eq.indexOf(b),n=s.eq.length;return i===0?"G":i===n-1?"A":String(s.eqTypes?i:b)}

let LAYERS=[];
function buildLayers(){LAYERS=[...MODEL.layers.map(l=>({id:l.id,name:l.name,ids:()=>l.ids})),
  ...(layout.groups.length?[{id:"grp",name:"Grupos",ids:()=>layout.groups.map(g=>"g:"+g.id)}]:[]),
  ...layout.views.map(v=>({id:"v:"+v.id,name:v.name,view:v,ids:()=>v.ids.filter(id=>BY[id]||groupOf(id))})),
  {id:"vnew",name:"＋ Capa",add:true,ids:()=>[]}];
  if(!LAYERS.some(l=>l.id===layer))layer=LAYERS[0].id}

function stripKeys(s,bus){
  const k=s.id+".",p=[k+"name",k+"color",faderKey(s,bus),k+"mute"];
  if(s.solo)p.push(k+"solo");if(s.pan)p.push(k+"pan");
  if(sendsTo(s,bus))p.push(`${k}send.${bus}.on`,`${target(bus).id}.color`);
  if(s.eq.length){p.push(k+"eq.on");for(const b of s.eq)for(const x of["g","f","q","type"])p.push(`${k}eq.${b}.${x}`)}
  if(s.inp)p.push(k+"lc",k+"lcf");
  if(s.gate)p.push(k+"gate.on");if(s.dyn)p.push(k+"dyn.on");
  return p;
}

const SCALE=[10,5,0,-5,-10,-20,-30,-40,-50,-60,-90];
const capPos=v=>`calc(22px + (100% - 44px) * ${(1-v).toFixed(4)})`;
const MUTE_ICON=`<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>`;

function makeStrip(scope,s,{bus=0,detail=false}={}){
  const el=document.createElement("div");
  const sendMode=sendsTo(s,bus);
  el.className="strip"+(sendMode?" sendmode":"");el.dataset.id=s.id;
  const cn=s.kind==="ch"?+s.id.slice(2):0,lodd=cn%2?cn:cn-1,lk=cn&&layout.links.includes(lodd);
  const num=s.kind==="ch"?(lk?`${lodd}–${lodd+1} ⛓`:String(cn)):s.label;
  el.innerHTML=`<button class="scribble" title="Abrir el canal"><span class="num">${esc(num)}</span><span class="nm"></span></button>
    <div class="proc${s.eq.length||s.dyn||s.gate?"":" none"}"><canvas></canvas><div class="tags"></div></div>
    <div class="pan${s.pan?"":" none"}" title="Panorama (doble toque: centro)"><b></b><span></span></div>
    <button class="sendon">ENVÍO</button>
    <div class="ms"><button class="mute" title="Silenciar">${MUTE_ICON}<small>MUTE</small></button><button class="solo" title="Escuchar solo este canal">SOLO</button></div>
    <div class="fader"><div class="scale">${SCALE.map(d=>`<span class="${d===0?"zero":""}" style="top:${capPos(FD.pos(d))}">${d===-90?"-∞":d>0?"+"+d:d}</span>`).join("")}</div>
      <div class="track"><div class="fill"></div></div><div class="meter"><b></b><i></i></div><div class="fader-cap"></div></div>
    <div class="db"></div>`;
  const q=c=>el.querySelector(c),k=s.id+".";
  const fk=faderKey(s,bus),sendOn=sendMode&&SPEC[`${k}send.${bus}.on`]?`${k}send.${bus}.on`:null;
  const cv=q(".proc canvas");

  watch(scope,stripKeys(s,bus),()=>{
    el.style.setProperty("--c",colorOf(s));q(".nm").textContent=nameOf(s);
    const v=norm(fk);q(".fader-cap").style.top=capPos(v);q(".fill").style.height=`calc((100% - 44px) * ${v.toFixed(4)})`;
    q(".db").textContent=F.db(S[fk]);
    const muted=!!+S[k+"mute"];el.classList.toggle("muted",muted);q(".mute").classList.toggle("on",muted);
    if(s.solo)q(".solo").classList.toggle("on",!!+S[k+"solo"]);
    if(s.pan){const p=+S[k+"pan"]/200+.5,b=q(".pan b");b.style.left=Math.min(50,p*100)+"%";b.style.width=Math.max(1.5,Math.abs(p-.5)*100)+"%";
      const r=Math.round(+S[k+"pan"]);q(".pan span").textContent=r===0?"C":r<0?"I"+(-r):"D"+r}
    if(sendMode){const so=sendOn?+S[sendOn]:1;q(".sendon").classList.toggle("on",!!so);el.classList.toggle("sendoff",!so);
      q(".sendon").style.visibility=sendOn?"":"hidden";el.style.setProperty("--bus",busColor(bus))}
    drawProc(s,cv,q(".tags"));
  });
  if(s.id===detailId&&!detail)el.classList.add("selected");
  if(lk&&!detail)el.classList.add("linked",cn===lodd?"lk-l":"lk-r");

  const fader=q(".fader");
  dragV(fader,()=>norm(fk),v=>setN(fk,v),{start:()=>hold(fk),end:()=>release(fk),dbl:()=>P.dbl&&setP(fk,0),travel:()=>(fader.clientHeight-44)*(P.fine?2.5:1)});
  q(".mute").onclick=()=>tog(k+"mute");
  q(".solo").onclick=()=>s.solo&&tog(k+"solo");
  q(".sendon").onclick=()=>sendOn&&tog(sendOn);
  if(s.pan){const pan=q(".pan");dragH(pan,()=>norm(k+"pan"),v=>setN(k+"pan",v),{start:()=>hold(k+"pan"),end:()=>release(k+"pan"),dbl:()=>setP(k+"pan",0),travel:()=>pan.clientWidth*1.5})}
  if(!detail){q(".scribble").onclick=()=>P.musician?toast("Modo músico: solo puedes mover tu mezcla"):openDetail(s.id);q(".proc").onclick=e=>openDetail(s.id,e.target.dataset?.tab||(s.eq.length?"eq":"dyn"))}
  addMeter(scope,s.id,0,q(".meter"));
  if(!s.solo)q(".solo").classList.add("none");
  return el;
}

/* mini EQ + indicadores de puerta (P), compresor (C) y ecualizador (EQ) */
function drawProc(s,cv,tags){
  if(!s.eq.length&&!s.dyn&&!s.gate)return;
  const k=s.id+".";
  tags.innerHTML=(s.gate?`<i data-tab="gate" class="${+S[k+"gate.on"]?"on":""}">P</i>`:"")+
                 (s.dyn?`<i data-tab="dyn" class="${+S[k+"dyn.on"]?"on":""}">C</i>`:"")+
                 (s.eq.length?`<i data-tab="eq" class="${+S[k+"eq.on"]?"on":""}">EQ</i>`:"");
  if(!s.eq.length)return;
  requestAnimationFrame(()=>{const r=fitCanvas(cv);if(!r)return;const[ctx,w,h]=r;ctx.clearRect(0,0,w,h);
    const on=+S[k+"eq.on"],pts=eqCurve(s,40);
    ctx.strokeStyle=tc("grid");ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();
    ctx.beginPath();pts.forEach(([x,d],i)=>{const X_=x*w,Y=h/2-clamp(d,-18,18)/18*(h/2-3);i?ctx.lineTo(X_,Y):ctx.moveTo(X_,Y)});
    const c=colorOf(s);ctx.strokeStyle=on?(c===NOCOLOR?ACC():c):tc("off");ctx.lineWidth=1.6;ctx.stroke()});
}

/* ================================================================ arrastre (relativo, como en la app original) */
function dragV(el,get,set,o){dragAxis(el,get,set,o,e=>-e.clientY)}
function dragH(el,get,set,o){dragAxis(el,get,set,o,e=>e.clientX)}
function dragAxis(el,get,set,{start,end,dbl,travel},axis){
  let id=null,p0=0,v0=0,last=0;
  el.addEventListener("pointerdown",e=>{
    if(id!==null)return;id=e.pointerId;try{el.setPointerCapture(id)}catch(_){}
    p0=axis(e);v0=get();start&&start();
    const now=Date.now();if(dbl&&now-last<320){dbl();last=0}else last=now;
    e.preventDefault();
  });
  el.addEventListener("pointermove",e=>{if(e.pointerId!==id)return;
    const fine=e.shiftKey||e.altKey?.15:1;set(clamp(v0+(axis(e)-p0)/ZOOM()/Math.max(40,travel())*fine))});
  const up=e=>{if(e.pointerId!==id)return;id=null;end&&end()};
  el.addEventListener("pointerup",up);el.addEventListener("pointercancel",up);
}

/* ================================================================ vúmetros */
function addMeter(scope,id,idx,el){METERS.push({scope,id,idx,b:el.querySelector("b"),i:el.querySelector("i"),v:0,pk:0,pkT:0})}
function meterLoop(){
  const now=performance.now();
  for(const m of METERS){
    const raw=M[m.id]?M[m.id][m.idx]:(m.idx?1:0);
    if(m.idx===0){const db=raw>0?20*Math.log10(raw):-100,t=clamp((db+60)/60);
      m.v=t>m.v?t:Math.max(t,m.v-.025);
      if(t>=m.pk||now-m.pkT>1500){m.pk=t;m.pkT=now}
      m.b.style.clipPath=`inset(${((1-m.v)*100).toFixed(1)}% 0 0 0)`;
      if(m.i){m.i.style.transform=`translateY(${-(m.pk*(m.b.parentNode.clientHeight-2)).toFixed(0)}px)`;m.i.style.opacity=m.pk>.02?.8:0}
    }else{const gr=raw>0?-20*Math.log10(raw):0,t=clamp(gr/24);m.v=t>m.v?t:Math.max(t,m.v-.02);
      m.b.style.clipPath=`inset(0 0 ${((1-m.v)*100).toFixed(1)}% 0)`;if(m.i)m.i.style.opacity=0}
  }
  if(liveGraph)liveGraph();
  applyPrefs();
requestAnimationFrame(meterLoop);
}

/* ================================================================ mesa */
function renderLayers(){
  const nav=$("#layers");nav.innerHTML="";
  for(const L of musicianLayers()){const b=document.createElement("button");b.textContent=L.name;b.classList.toggle("sel",L.id===layer);
    if(L.view)b.classList.add("view");if(L.add)b.classList.add("addlayer");
    b.onclick=()=>{if(L.add){openLayerEditor(null);return}if(L.view&&layer===L.id){openLayerEditor(L.view.id);return}layer=L.id;store("layer",layer);renderLayers();renderDesk()};
    nav.appendChild(b)}
}
function renderDesk(){
  unwatch("desk");unwatch("master");
  const box=$("#strips");box.innerHTML="";
  if(P.musician){if(!target(P.musician)){P.musician=0;savePrefs()}else sendBus=P.musician}
  const LL=musicianLayers();let L=LL.find(l=>l.id===layer)||LL[0]||LAYERS[0];
  if(sendBus>100&&!L.ids().some(id=>BY[id]?.mtxSends)){const alt=LL.find(l=>l.id==="out")||LL.find(l=>l.ids().some(id=>BY[id]?.mtxSends));
    if(alt){L=alt;store("layer",alt.id);setTimeout(renderLayers,0)}}
  layer=L.id;
  for(const id of L.ids())box.appendChild(groupOf(id)?makeGroupStrip("desk",groupOf(id)):makeStrip("desk",BY[id],{bus:sendBus}));
  if(layer==="grp"){const t=document.createElement("button");t.className="strip addtile";
    t.innerHTML=`<div><b>＋</b><br>Nuevo<br>grupo</div>`;t.onclick=()=>openGroupEditor(null);box.appendChild(t)}
  if(layer==="dca")box.appendChild(muteGroups());
  if(layer.startsWith("v:")){const t=document.createElement("button");t.className="strip";const vid=layer.slice(2);t.onclick=()=>openLayerEditor(vid);
    t.className="strip addtile";t.innerHTML=`<div><b>✎</b><br>Editar<br>capa</div>`;box.appendChild(t)}
  box.scrollLeft=0;
  if(sendBus&&!target(sendBus)){sendBus=0;store("sendBus",0)}
  const ms=sendBus?busStrip(sendBus):BY[MODEL.master];
  const mbox=$("#master");mbox.innerHTML="";mbox.appendChild(makeStrip("master",ms));
  const sel=$("#mixSel");sel.classList.toggle("busmode",!!sendBus);
  watch("desk",[ms.id+".name",ms.id+".color"],()=>{
    $("#mixName").textContent=sendBus?(nameOf(ms)===ms.label?ms.label:`${ms.label} · ${nameOf(ms)}`):"Principal";
    sel.style.setProperty("--bus",sendBus?busColor(sendBus):"var(--red)");
    sel.querySelector("small").textContent=P.musician?"Modo músico · tu mezcla":sendBus>100?"Envíos a matriz":sendBus?"Mezcla de monitor":"Estás mezclando";
  });
  renderMonRow();
}
function muteGroups(){
  const d=document.createElement("div");d.className="mgroups";d.innerHTML="<h4>Grupos de mute</h4>";
  for(let g=1;g<=MODEL.mgroups;g++){const b=document.createElement("button"),k=`mg${g}.mute`,nk=`mg${g}.name`;
    b.onclick=()=>tog(k);watch("desk",SPEC[nk]?[k,nk]:[k],()=>{b.textContent=S[nk]||"Grupo "+g;b.classList.toggle("on",!!+S[k])});d.appendChild(b)}
  return d;
}

/* ================================================================ vista de canal */
function tabsFor(s){
  const t=[],k=s.id+".";
  if(s.inp)t.push(["in","Entrada",k+"lc"]);
  if(s.gate)t.push(["gate","Puerta",k+"gate.on"]);
  if(s.dyn)t.push(["dyn","Compresor",k+"dyn.on"]);
  if(s.eq.length)t.push(["eq","Ecualizador",k+"eq.on"]);
  if(s.sends||s.mtxSends)t.push(["sends","Envíos",null]);
  t.push(["cfg","Canal",null]);
  return t;
}
function openDetail(id,tab){
  const s=BY[id];if(!s)return;
  const tabs=tabsFor(s);
  if(id!==detailId)eqBand=null;
  detailId=id;detailTab=tab&&tabs.some(t=>t[0]===tab)?tab:(tabs.some(t=>t[0]===detailTab)?detailTab:tabs[0][0]);
  unwatch("dhead");unwatch("dstrip");
  $("#detail").classList.add("show");document.body.classList.toggle("side",sidePanel());document.body.classList.add("dopen");
  watch("dhead",[s.id+".name",s.id+".color",...tabs.map(t=>t[2]).filter(Boolean)],()=>{
    $("#dName").style.setProperty("--c",colorOf(s));
    $("#dName").innerHTML=`<i></i><div><b>${esc(nameOf(s))}</b><small>${esc(s.label)}</small></div>`;
    const nav=$("#dTabs");nav.innerHTML="";
    for(const[t,label,onk]of tabs){const b=document.createElement("button");b.innerHTML=(onk?`<i class="${+S[onk]?"on":""}"></i>`:"")+label;
      b.classList.toggle("sel",t===detailTab);b.onclick=()=>{detailTab=t;openDetail(id)};nav.appendChild(b)}
  });
  const st=makeStrip("dstrip",s,{detail:true});$("#dStrip").replaceWith(st);st.id="dStrip";
  renderPane(s);
  document.querySelectorAll("#strips .strip,#master .strip").forEach(e=>e.classList.toggle("selected",e.dataset.id===id));
}
function closeDetail(){unwatch("dhead");unwatch("dstrip");unwatch("pane");liveGraph=null;detailId=null;$("#detail").classList.remove("show");
  document.body.classList.remove("side","dopen");requestAnimationFrame(notifyAll);
  document.querySelectorAll(".strip.selected").forEach(e=>e.classList.remove("selected"))}
function stepDetail(d){const i=STRIPS.findIndex(s=>s.id===detailId);openDetail(STRIPS[(i+d+STRIPS.length)%STRIPS.length].id)}

let liveGraph=null;
function renderPane(s){
  unwatch("pane");liveGraph=null;
  const pane=$("#dPane");pane.innerHTML="";pane.scrollTop=0;
  ({in:paneInput,gate:paneGate,dyn:paneDyn,eq:paneEq,sends:paneSends,cfg:paneCfg})[detailTab](s,pane);
}
function h(tag,cls,html){const e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e}
function toggle(scope,label,k,cls=""){const b=h("button","toggle "+cls,`<i></i>${label}`);b.onclick=()=>tog(k);
  watch(scope,[k],()=>b.classList.toggle("on",!!+S[k]));return b}
function bigToggle(scope,label,k,cls=""){const b=h("button","bigtoggle "+cls,label);b.onclick=()=>tog(k);
  watch(scope,[k],()=>b.classList.toggle("on",!!+S[k]));return b}
function head(pane,title,help,...extra){const d=h("div","phead",`<div class="ptitle"><h3>${title}</h3>${help?`<p>${help}</p>`:""}</div>`);
  extra.forEach(e=>d.appendChild(e));pane.appendChild(d);return d}

/* potenciómetro: arrastrar arriba/abajo, doble toque = valor por defecto */
let kid=0;
function knob(scope,{label,key,fmt,def}){
  const el=h("div","kn"),id="kg"+(kid++);
  el.innerHTML=`<h4>${label}</h4><svg viewBox="0 0 80 80"></svg><b></b>`;
  const svg=el.querySelector("svg");
  watch(scope,[key],()=>{const t=norm(key),a=-135+270*t,[px,py]=polar(40,40,22,a),[qx,qy]=polar(40,40,10,a);
    svg.innerHTML=`<defs><radialGradient id="${id}" cx="40%" cy="30%" r="75%"><stop offset="0" style="stop-color:var(--k1)"/><stop offset=".55" style="stop-color:var(--k2)"/><stop offset="1" style="stop-color:var(--k3)"/></radialGradient></defs>
      <path d="${arc(40,40,35,-135,135)}" style="stroke:var(--k-track)" stroke-width="7" fill="none" stroke-linecap="round"/>
      ${t>.003?`<path d="${arc(40,40,35,-135,a)}" stroke="var(--red)" stroke-width="5" fill="none" stroke-linecap="round" style="filter:drop-shadow(0 0 3px var(--red))"/>`:""}
      <circle cx="40" cy="41" r="27" fill="#000" opacity=".35"/><circle cx="40" cy="40" r="27" fill="url(#${id})" style="stroke:var(--k-edge)"/>
      <line x1="${qx.toFixed(1)}" y1="${qy.toFixed(1)}" x2="${px.toFixed(1)}" y2="${py.toFixed(1)}" style="stroke:var(--k-ptr)" stroke-width="3" stroke-linecap="round"/>`;
    el.querySelector("b").textContent=fmt(S[key])});
  const d=def!=null?def:SPEC[key][4];
  dragV(el,()=>norm(key),n=>setN(key,n),{start:()=>hold(key),end:()=>release(key),dbl:()=>setP(key,d),travel:()=>220});
  return el;
}
function polar(cx,cy,r,deg){const a=(deg-90)*Math.PI/180;return[cx+r*Math.cos(a),cy+r*Math.sin(a)]}
function arc(cx,cy,r,a0,a1){const[x0,y0]=polar(cx,cy,r,a0),[x1,y1]=polar(cx,cy,r,a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1-a0>180?1:0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`}
function fitCanvas(cv){const W=cv.clientWidth,H=cv.clientHeight;if(!W||!H)return null;const d=(devicePixelRatio||1)*ZOOM();
  const w=Math.round(W*d),hh=Math.round(H*d);if(cv.width!==w||cv.height!==hh){cv.width=w;cv.height=hh}
  const ctx=cv.getContext("2d");ctx.setTransform(d,0,0,d,0,0);return[ctx,W,H]}
const meterEl=(cls="")=>h("div","meter "+cls,"<b></b><i></i>");
const font=()=>getComputedStyle(document.body).fontFamily;

/* ---------- Entrada ---------- */
function paneInput(s,pane){
  const k=s.id+".";
  head(pane,"Entrada","Cuánta señal entra en el canal. Sube la ganancia hasta que el vúmetro se mueva bien sin llegar al rojo.");
  const wrap=h("div","inbig");const big=h("div","bigmeter");const m=meterEl();big.appendChild(m);addMeter("pane",s.id,0,m);wrap.appendChild(big);
  const col=h("div","incol");
  const ks=h("div","knobs left");
  if(SPEC[k+"gain"])ks.appendChild(knob("pane",{label:"Ganancia",key:k+"gain",fmt:F.dbu}));
  if(SPEC[k+"trim"])ks.appendChild(knob("pane",{label:"Trim",key:k+"trim",fmt:F.dbu,def:0}));
  if(SPEC[k+"lcf"])ks.appendChild(knob("pane",{label:"Quitar graves por debajo de",key:k+"lcf",fmt:F.hz}));
  const row=h("div","btnrow");
  if(SPEC[k+"p48"]){const b=bigToggle("pane","Phantom 48V",k+"p48","p48");
    b.onclick=()=>{if(locked)return;if(!+S[k+"p48"]&&!b.dataset.c){b.dataset.c=1;b.textContent="¿Activar 48V?";b.classList.add("confirm");
      setTimeout(()=>{delete b.dataset.c;b.textContent="Phantom 48V";b.classList.remove("confirm")},2500);return}
      delete b.dataset.c;b.textContent="Phantom 48V";b.classList.remove("confirm");tog(k+"p48");toast(+S[k+"p48"]?`+48V activado en ${nameOf(s)}`:`+48V apagado en ${nameOf(s)}`)};
    row.appendChild(b)}
  if(SPEC[k+"lc"])row.appendChild(bigToggle("pane","Quitar graves",k+"lc"));
  if(SPEC[k+"invert"])row.appendChild(bigToggle("pane","Invertir fase",k+"invert"));
  col.appendChild(ks);col.appendChild(row);
  col.appendChild(h("p","hint","<b>Phantom 48V</b>: solo para micrófonos de condensador y cajas DI activas. <b>Quitar graves</b>: limpia golpes y retumbes (útil en voces y guitarras)."));
  wrap.appendChild(col);pane.appendChild(wrap);
}

/* ---------- Puerta ---------- */
function paneGate(s,pane){
  const g=s.id+".gate.";
  head(pane,"Puerta de ruido","Cierra el canal cuando no suena (por ejemplo, los toms entre golpe y golpe).",toggle("pane","Activada",g+"on"));
  const split=h("div","split");const gr=h("div","graph","<canvas></canvas>");split.appendChild(gr);
  const bar=h("div","grbar");const gm=meterEl("gr");bar.appendChild(h("small","","Cierre"));bar.appendChild(gm);split.appendChild(bar);addMeter("pane",s.id,1,gm);
  pane.appendChild(split);
  const ks=h("div","knobs");
  ks.appendChild(knob("pane",{label:"Umbral",key:g+"thr",fmt:F.dbu}));
  ks.appendChild(knob("pane",{label:"Cuánto baja",key:g+"range",fmt:F.dbu}));
  ks.appendChild(knob("pane",{label:"Apertura",key:g+"att",fmt:F.ms}));
  ks.appendChild(knob("pane",{label:"Espera",key:g+"hld",fmt:F.ms}));
  ks.appendChild(knob("pane",{label:"Cierre",key:g+"rel",fmt:F.ms}));
  pane.appendChild(ks);
  const cv=gr.querySelector("canvas");
  liveGraph=()=>{const thr=+S[g+"thr"],rng=+S[g+"range"];transferGraph(cv,x=>x<thr?x-rng:x,thr,+S[g+"on"],s.id)};
  dragH(gr,()=>norm(g+"thr"),v=>setN(g+"thr",v),{start:()=>hold(g+"thr"),end:()=>release(g+"thr"),travel:()=>gr.clientWidth});
}

/* ---------- Compresor ---------- */
function paneDyn(s,pane){
  const d=s.id+".dyn.";
  head(pane,"Compresor","Iguala el volumen: baja lo que suena demasiado fuerte para que se entienda todo.",toggle("pane","Activado",d+"on"));
  const split=h("div","split");const gr=h("div","graph","<canvas></canvas>");split.appendChild(gr);
  const bar=h("div","grbar");const gm=meterEl("gr");bar.appendChild(h("small","","Reduce"));bar.appendChild(gm);split.appendChild(bar);addMeter("pane",s.id,2,gm);
  pane.appendChild(split);
  const ks=h("div","knobs");
  ks.appendChild(knob("pane",{label:"Umbral",key:d+"thr",fmt:F.dbu}));
  ks.appendChild(knob("pane",{label:"Fuerza",key:d+"ratio",fmt:v=>(+v).toFixed(+v<10?1:0)+" : 1"}));
  ks.appendChild(knob("pane",{label:"Suavidad",key:d+"knee",fmt:v=>(+v).toFixed(1)}));
  ks.appendChild(knob("pane",{label:"Rapidez",key:d+"att",fmt:F.ms}));
  ks.appendChild(knob("pane",{label:"Recuperación",key:d+"rel",fmt:F.ms}));
  ks.appendChild(knob("pane",{label:"Volumen extra",key:d+"gain",fmt:F.dbu}));
  ks.appendChild(knob("pane",{label:"Mezcla",key:d+"mix",fmt:v=>Math.round(+v)+" %"}));
  pane.appendChild(ks);
  const cv=gr.querySelector("canvas");
  liveGraph=()=>{const thr=+S[d+"thr"],r=+S[d+"ratio"]||2,kn=(+S[d+"knee"])*2,mg=+S[d+"gain"];
    transferGraph(cv,x=>{let y;if(2*(x-thr)<-kn)y=x;else if(2*(x-thr)>kn)y=thr+(x-thr)/r;else y=x+(1/r-1)*Math.pow(x-thr+kn/2,2)/(2*kn||1);return y+mg},thr,+S[d+"on"],s.id)};
  dragH(gr,()=>norm(d+"thr"),v=>setN(d+"thr",v),{start:()=>hold(d+"thr"),end:()=>release(d+"thr"),travel:()=>gr.clientWidth});
}

function transferGraph(cv,fn,thr,on,id){
  const r=fitCanvas(cv);if(!r)return;const[ctx,w,hh]=r;const lo=-80,span=-lo;
  const px=x=>(x-lo)/span*w,py=y=>hh-(clamp(y,lo-10,10)-lo)/span*hh;
  ctx.clearRect(0,0,w,hh);ctx.strokeStyle=tc("grid");ctx.lineWidth=1;ctx.font="11px "+font();ctx.fillStyle=tc("label");
  for(let d=lo;d<=0;d+=10){ctx.beginPath();ctx.moveTo(px(d),0);ctx.lineTo(px(d),hh);ctx.moveTo(0,py(d));ctx.lineTo(w,py(d));ctx.stroke();if(d>lo)ctx.fillText(d,px(d)+3,hh-4)}
  ctx.strokeStyle=tc("grid2");ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(px(lo),py(lo));ctx.lineTo(px(0),py(0));ctx.stroke();ctx.setLineDash([]);
  ctx.strokeStyle=`rgba(${ACCRGB()},.5)`;ctx.beginPath();ctx.moveTo(px(thr),0);ctx.lineTo(px(thr),hh);ctx.stroke();
  ctx.beginPath();for(let x=lo;x<=0;x+=.5){const y=fn(x);x===lo?ctx.moveTo(px(x),py(y)):ctx.lineTo(px(x),py(y))}
  ctx.strokeStyle=on?ACC():tc("label");ctx.lineWidth=3;ctx.shadowColor=ACC();ctx.shadowBlur=on?10:0;ctx.stroke();ctx.shadowBlur=0;
  const lv=M[id]?.[0]||0,ldb=lv>0?20*Math.log10(lv):-100;
  if(status.meters&&ldb>lo){ctx.fillStyle=tc("dot");ctx.beginPath();ctx.arc(px(ldb),py(fn(ldb)),6,0,7);ctx.fill()}
  ctx.fillStyle=tc("label2");ctx.fillText("Umbral "+(+thr).toFixed(1)+" dB  ·  desliza el dedo sobre el gráfico para moverlo",10,16);
}

/* ---------- Ecualizador ---------- */
function biquad(type,f0,g,q,fs=48000){   // type: hp, ls, hs, pk
  const A=Math.pow(10,g/40),w=2*Math.PI*Math.min(f0,fs*.45)/fs,cs=Math.cos(w),sn=Math.sin(w);
  let al=sn/(2*q),b0,b1,b2,a0,a1,a2;
  if(type==="hp"){al=sn/(2*.707);b0=(1+cs)/2;b1=-(1+cs);b2=b0;a0=1+al;a1=-2*cs;a2=1-al}
  else if(type==="lp"){al=sn/(2*.707);b0=(1-cs)/2;b1=1-cs;b2=b0;a0=1+al;a1=-2*cs;a2=1-al}
  else if(type==="ls"||type==="hs"){al=sn/(2*Math.min(q,1.2));const sq=2*Math.sqrt(A)*al;
    if(type==="ls"){b0=A*((A+1)-(A-1)*cs+sq);b1=2*A*((A-1)-(A+1)*cs);b2=A*((A+1)-(A-1)*cs-sq);a0=(A+1)+(A-1)*cs+sq;a1=-2*((A-1)+(A+1)*cs);a2=(A+1)+(A-1)*cs-sq}
    else{b0=A*((A+1)+(A-1)*cs+sq);b1=-2*A*((A-1)+(A+1)*cs);b2=A*((A+1)+(A-1)*cs-sq);a0=(A+1)-(A-1)*cs+sq;a1=2*((A-1)-(A+1)*cs);a2=(A+1)-(A-1)*cs-sq}}
  else{b0=1+al*A;b1=-2*cs;b2=1-al*A;a0=1+al/A;a1=-2*cs;a2=1-al/A}
  return[b0/a0,b1/a0,b2/a0,a1/a0,a2/a0];
}
function magDb(c,f,fs=48000){const w=2*Math.PI*f/fs,c1=Math.cos(w),c2=Math.cos(2*w),s1=Math.sin(w),s2=Math.sin(2*w);
  const nr=c[0]+c[1]*c1+c[2]*c2,ni=c[1]*s1+c[2]*s2,dr=1+c[3]*c1+c[4]*c2,di=c[3]*s1+c[4]*s2;
  return 10*Math.log10((nr*nr+ni*ni)/(dr*dr+di*di)+1e-20)}
const XTYPES=["hp","ls","pk","pk","hs","lp"];
const bandType=(s,b)=>s.eqTypes?XTYPES[+S[`${s.id}.eq.${b}.type`]]||"pk":b==="l"?"ls":b==="h"?"hs":"pk";
const hasGain=t=>t!=="hp"&&t!=="lp";
function bandCoef(s,b){const p=`${s.id}.eq.${b}.`;return biquad(bandType(s,b),+S[p+"f"],+S[p+"g"],+S[p+"q"])}
function eqCurve(s,n,only){
  const cs=[];for(const b of s.eq)if(only==null||only===b)cs.push(bandCoef(s,b));
  if(only==null&&s.inp&&+S[s.id+".lc"])cs.push(biquad("hp",+S[s.id+".lcf"],0,.707));
  const out=[];for(let k=0;k<n;k++){const x=k/(n-1),f=20*Math.pow(1000,x);let d=0;for(const c of cs)d+=magDb(c,f);out.push([x,d])}return out;
}
const hzX=f=>clamp(Math.log(f/20)/Math.log(1000));
function paneEq(s,pane){
  const k=s.id+".eq.";
  if(!eqBand||!s.eq.includes(eqBand))eqBand=s.eq[0];
  const reset=h("button","btn small","Dejar plano");reset.onclick=()=>{for(const b of s.eq)setP(`${k}${b}.g`,0)};
  head(pane,"Ecualizador","Toca un punto y arrástralo: a la izquierda los graves, a la derecha los agudos; arriba sube, abajo baja.",reset,toggle("pane","Activado",k+"on"));
  const g=h("div","graph","<canvas></canvas>");g.style.minHeight="260px";pane.appendChild(g);
  const bands=h("div","chips bands");
  s.eq.forEach((b,i)=>{const c=h("button","",bandName(s,b));c.style.setProperty("--bc",EQ_COL[i%EQ_COL.length]);c.classList.toggle("sel",b===eqBand);
    c.onclick=()=>{eqBand=b;renderPane(s)};bands.appendChild(c)});
  const bp=`${k}${eqBand}.`;
  if(s.eqTypes){const sp=h("span","");sp.style.flex="1";bands.appendChild(sp);
    const types=h("div","chips");EQ_TYPE_NAMES.forEach((n,t)=>{const c=h("button","",n);c.onclick=()=>setP(bp+"type",t);types.appendChild(c)});
    watch("pane",[bp+"type"],()=>[...types.children].forEach((c,t)=>c.classList.toggle("sel",t===+S[bp+"type"])));bands.appendChild(types)}
  pane.appendChild(bands);
  const ks=h("div","knobs");
  ks.appendChild(knob("pane",{label:"Frecuencia",key:bp+"f",fmt:F.hz}));
  ks.appendChild(knob("pane",{label:"Subir / bajar",key:bp+"g",fmt:F.dbu,def:0}));
  ks.appendChild(knob("pane",{label:"Anchura",key:bp+"q",fmt:v=>(+v<1.5?"Ancha ":+v>4?"Estrecha ":"Media ")+(+v).toFixed(1)}));
  pane.appendChild(ks);
  const cv=g.querySelector("canvas");
  const keys=[k+"on",s.id+".lc",s.id+".lcf"];for(const b of s.eq)for(const x of["g","f","q","type"])keys.push(`${k}${b}.${x}`);
  watch("pane",keys,()=>requestAnimationFrame(()=>drawEq(cv,s)));
  eqTouch(g,s);
}
const EQ_TYPE_NAMES=["Cortar graves","Estante graves","Campana","Campana suave","Estante agudos","Cortar agudos"];
const EQ_COL=["#ff3b45","#ffb020","#34d27b","#1fc2d4","#2f7bf2","#c23be0","#ff5fb0","#e8e8ec"];
function eqXY(s,b,w,hh){const p=`${s.id}.eq.${b}.`;return[hzX(+S[p+"f"])*w,hasGain(bandType(s,b))?hh/2-(+S[p+"g"])/18*(hh/2):hh/2]}
function drawEq(cv,s){
  const r=fitCanvas(cv);if(!r)return;const[ctx,w,hh]=r,on=+S[s.id+".eq.on"];
  ctx.clearRect(0,0,w,hh);ctx.lineWidth=1;ctx.font="11px "+font();
  for(const[f,l]of[[20,"20"],[50,"50"],[100,"100"],[200,"200"],[500,"500"],[1000,"1k"],[2000,"2k"],[5000,"5k"],[10000,"10k"]]){const x=hzX(f)*w;ctx.strokeStyle=tc("grid");ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,hh);ctx.stroke();
    ctx.fillStyle=tc("label");ctx.fillText(l,x+3,hh-5)}
  ctx.fillStyle=tc("off");ctx.font="12px "+font();ctx.fillText("GRAVES",hzX(60)*w,18);ctx.fillText("MEDIOS",hzX(900)*w,18);ctx.fillText("AGUDOS",hzX(9000)*w,18);ctx.font="11px "+font();
  for(const d of[-15,-10,-5,0,5,10,15]){const y=hh/2-d/18*(hh/2);ctx.strokeStyle=d?tc("grid"):tc("grid2");ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();
    if(d){ctx.fillStyle=tc("label");ctx.fillText((d>0?"+":"")+d,4,y-3)}}
  const Y=d=>hh/2-clamp(d,-20,20)/18*(hh/2);
  s.eq.forEach((b,i)=>{const pts=eqCurve(s,160,b);ctx.beginPath();pts.forEach(([x,d],k)=>k?ctx.lineTo(x*w,Y(d)):ctx.moveTo(x*w,Y(d)));
    ctx.strokeStyle=EQ_COL[i%EQ_COL.length]+(b===eqBand?"aa":"44");ctx.lineWidth=b===eqBand?1.6:1;ctx.stroke()});
  const pts=eqCurve(s,240);
  ctx.beginPath();ctx.moveTo(0,hh/2);pts.forEach(([x,d])=>ctx.lineTo(x*w,Y(d)));ctx.lineTo(w,hh/2);ctx.closePath();
  const gr=ctx.createLinearGradient(0,0,0,hh);gr.addColorStop(0,on?`rgba(${ACCRGB()},.35)`:"rgba(120,120,130,.2)");gr.addColorStop(.5,`rgba(${ACCRGB()},.04)`);gr.addColorStop(1,on?`rgba(${ACCRGB()},.35)`:"rgba(120,120,130,.2)");
  ctx.fillStyle=gr;ctx.fill();
  ctx.beginPath();pts.forEach(([x,d],k)=>k?ctx.lineTo(x*w,Y(d)):ctx.moveTo(x*w,Y(d)));
  ctx.strokeStyle=on?ACC():tc("off");ctx.lineWidth=3;ctx.shadowColor=ACC();ctx.shadowBlur=on?12:0;ctx.stroke();ctx.shadowBlur=0;
  s.eq.forEach((b,i)=>{const[x,y]=eqXY(s,b,w,hh),sel=b===eqBand,c=EQ_COL[i%EQ_COL.length];
    ctx.beginPath();ctx.arc(x,y,sel?16:13,0,7);ctx.fillStyle=sel?c:tc("node");ctx.fill();ctx.lineWidth=2.5;ctx.strokeStyle=c;ctx.stroke();
    ctx.fillStyle=sel?"#000":tc("nodetxt");ctx.font="bold 12px "+font();ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(bandLetter(s,b),x,y+1);
    ctx.textAlign="left";ctx.textBaseline="alphabetic";ctx.font="11px "+font()});
  if(s.inp&&+S[s.id+".lc"]){const x=hzX(+S[s.id+".lcf"])*w;ctx.fillStyle=tc("label2");ctx.fillText("Graves quitados hasta "+F.hz(S[s.id+".lcf"]),x+4,34)}
}
function eqTouch(g,s){
  const pts=new Map();let band=null,start=null,pinch=null;
  g.addEventListener("pointerdown",e=>{
    try{g.setPointerCapture(e.pointerId)}catch(_){}
    pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    const r=g.getBoundingClientRect(),zz=ZOOM();
    if(pts.size===1){
      let best=s.eq[0],bd=1e9;for(const b of s.eq){const[x,y]=eqXY(s,b,g.clientWidth,g.clientHeight);const d=Math.hypot(x-(e.clientX-r.left)/zz,(y-(e.clientY-r.top)/zz)*.6);if(d<bd){bd=d;best=b}}
      if(best!==eqBand){eqBand=best;renderPane(s);return}
      band=best;const p=`${s.id}.eq.${band}.`;start={x:e.clientX,y:e.clientY,f:norm(p+"f"),g:+S[p+"g"]};hold(p+"f");hold(p+"g");
    }else if(pts.size===2&&band){const a=[...pts.values()];pinch={d:Math.abs(a[0].x-a[1].x)+1,q:norm(`${s.id}.eq.${band}.q`)};start=null}
    e.preventDefault();
  });
  g.addEventListener("pointermove",e=>{if(!pts.has(e.pointerId)||!band)return;pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    const r=g.getBoundingClientRect(),p=`${s.id}.eq.${band}.`;
    if(pinch&&pts.size>=2){const a=[...pts.values()],d=Math.abs(a[0].x-a[1].x)+1;setN(p+"q",pinch.q-Math.log(d/pinch.d)*.35);return}
    if(!start)return;
    setN(p+"f",start.f+(e.clientX-start.x)/r.width);/* r ya está escalado igual que clientX */
    if(hasGain(bandType(s,band)))setP(p+"g",start.g-(e.clientY-start.y)/(r.height/2)*18);
  });
  const up=e=>{pts.delete(e.pointerId);if(!pts.size&&band){const p=`${s.id}.eq.${band}.`;release(p+"f");release(p+"g");band=null;start=null;pinch=null}};
  g.addEventListener("pointerup",up);g.addEventListener("pointercancel",up);
  g.addEventListener("wheel",e=>{const p=`${s.id}.eq.${eqBand}.q`;setN(p,norm(p)+(e.deltaY>0?-.02:.02));e.preventDefault()},{passive:false});
}

/* ---------- Envíos ---------- */
function paneSends(s,pane){
  if(s.mtxSends)head(pane,"Envíos a matrices","Cuánto de esta salida va a cada matriz (PA, delays, front fills, grabación…).");
  else head(pane,"Envíos a monitores","Cuánto de este canal va a cada bus (monitores, cascos, efectos).");
  const grid=h("div","sends");
  for(const{n}of(s.mtxSends?mtxTargets():MODEL.targets)){
    const bs=busStrip(n),lk=`${s.id}.send.${n}.lvl`,ok=SPEC[`${s.id}.send.${n}.on`]?`${s.id}.send.${n}.on`:null;
    const row=h("div","send"+(ok?"":" noon"),`<div class="who"><small>${esc(bs.label)}</small><span></span></div><div class="hslider"><b></b></div><div class="val"></div><button class="onbtn">ON</button>`);
    watch("pane",[lk,ok,bs.id+".name",bs.id+".color"].filter(Boolean),()=>{
      row.querySelector(".who").style.setProperty("--c",colorOf(bs));row.querySelector(".who span").textContent=S[bs.id+".name"]||bs.label;
      row.querySelector(".hslider b").style.width=(norm(lk)*100)+"%";row.querySelector(".val").textContent=F.db(S[lk]);
      const on=ok?!!+S[ok]:true;{const ob=row.querySelector(".onbtn");ob.classList.toggle("on",on);ob.textContent=on?"ON":"OFF"}row.classList.toggle("off",!on)});
    const sl=row.querySelector(".hslider");
    dragH(sl,()=>norm(lk),v=>setN(lk,v),{start:()=>hold(lk),end:()=>release(lk),dbl:()=>setP(lk,0),travel:()=>sl.clientWidth});
    row.querySelector(".onbtn").onclick=()=>ok&&tog(ok);
    grid.appendChild(row);
  }
  pane.appendChild(grid);
}

/* ---------- Nombre y color ---------- */
function paneCfg(s,pane){
  head(pane,"Canal","Nombre, color, a qué salida principal va y si va enlazado en estéreo con su pareja.");
  const nk=s.id+".name",ck=s.id+".color";
  const inp=h("input","field");inp.maxLength=16;inp.placeholder=s.label;inp.style.maxWidth="420px";inp.value=S[nk]||"";
  inp.maxLength=MODEL.kind==="xair"?12:16;inp.oninput=()=>setP(nk,inp.value);pane.appendChild(inp);
  const cols=h("div","colors");
  MODEL.colors.forEach(([c,name],i)=>{const b=h("button","",name);b.style.cssText=`background:#0b0b0d;color:${i?c:tc("label2")};box-shadow:inset 0 6px 0 ${c}`;
    b.onclick=()=>setP(ck,i);cols.appendChild(b)});
  watch("pane",[ck],()=>[...cols.children].forEach((b,i)=>b.classList.toggle("sel",i===+S[ck])));
  pane.appendChild(h("h3","sec","Color"));pane.appendChild(cols);
  const mk=MODEL.mains.filter(m=>SPEC[`${s.id}.main.${m.n}.on`]);
  if(mk.length){pane.appendChild(h("h3","sec",mk.length>1?"Envío a mains":"Envío al principal"));const row=h("div","btnrow");
    for(const m of mk){const k=`${s.id}.main.${m.n}.on`,ms=BY[m.id],b=h("button","bigtoggle main","");
      b.onclick=()=>tog(k);watch("pane",[k,ms.id+".name",ms.id+".color"],()=>{b.innerHTML=`${esc(nameOf(ms))}<small>${esc(ms.label)}</small>`;
        b.style.setProperty("--c",colorOf(ms));b.classList.toggle("on",!!+S[k])});row.appendChild(b)}
    pane.appendChild(row)}
  if(s.kind==="ch"){const n=+s.id.slice(2),odd=n%2?n:n-1;
    if(BY["ch"+(odd+1)]){pane.appendChild(h("h3","sec","Link estéreo"));
      const b=h("button","bigtoggle wide","");const paint=()=>{const on=layout.links.includes(odd);b.classList.toggle("on",on);
        b.innerHTML=`${on?"Enlazado":"Enlazar"} con ${n===odd?"canal "+(odd+1):"canal "+odd}<small>${on?"Se mueven juntos: fader, mute, envíos y procesado":"Fader, mute, envíos y procesado a la vez (la ganancia y +48V siguen separados)"}</small>`};
      paint();b.onclick=()=>{if(locked)return;send({t:"link",ch:odd,on:!layout.links.includes(odd)});layout.links=layout.links.includes(odd)?layout.links.filter(x=>x!==odd):[...layout.links,odd];paint();
        toast(layout.links.includes(odd)?`Canales ${odd}–${odd+1} enlazados`:"Canales separados")};pane.appendChild(b)}}
}

/* ================================================================ hojas */
function openSheet(id){$(id).classList.add("show")}
function closeSheets(){document.querySelectorAll(".sheet.show").forEach(s=>s.classList.remove("show"))}
document.querySelectorAll(".sheet").forEach(sh=>sh.addEventListener("pointerdown",e=>{if(e.target===sh||e.target.dataset.close!=null)closeSheets()}));

let connCard="rack",connDemo=false;
const CARD_KIND={rack:"wing",wing:"wing",xr18:"xair"};
function openConn(){connCard=load("card",status.kind==="xair"?"xr18":"rack");if(CARD_KIND[connCard]!==status.kind)connCard=status.kind==="xair"?"xr18":"rack";
  connDemo=status.mode!=="live";paintConn();openSheet("#connSheet")}
function paintConn(){document.querySelectorAll(".model").forEach(b=>b.classList.toggle("sel",b.dataset.card===connCard));
  $("#demoSw").classList.toggle("on",connDemo);$("#ipBox").style.display=connDemo?"none":"";
  const ip=$("#ip");if(!ip.dataset.edited)ip.value=(status.ips||{})[CARD_KIND[connCard]]||"";
  $("#connectBtn").textContent=connDemo?"Probar sin mesa":"Conectar"}
document.querySelectorAll(".model").forEach(b=>b.onclick=()=>{connCard=b.dataset.card;delete $("#ip").dataset.edited;paintConn()});
$("#ip").oninput=()=>{$("#ip").dataset.edited=1};
$("#demoSw").onclick=()=>{connDemo=!connDemo;paintConn()};
$("#connBtn").onclick=openConn;
$("#connectBtn").onclick=()=>{store("card",connCard);$("#connectBtn").textContent="Conectando…";send({t:"connect",kind:CARD_KIND[connCard],demo:connDemo,ip:$("#ip").value})};
$("#findBtn").onclick=()=>{$("#found").innerHTML='<div class="empty">Buscando la mesa en la red…</div>';send({t:"discover"})};

function openMix(){
  const list=$("#mixList");list.innerHTML="";
  const mk=(n,label,sub,c)=>{const b=h("button",n?"":"lr",`${esc(label)}<small>${esc(sub)}</small>`);b.style.setProperty("--c",c);b.classList.toggle("sel",n===sendBus);
    b.onclick=()=>{sendBus=n;store("sendBus",n);closeSheets();renderDesk()};list.appendChild(b)};
  mk(0,"Principal","La mezcla que oye el público","var(--red)");
  for(const t of MODEL.targets){const s=BY[t.id];mk(t.n,s.label,S[s.id+".name"]||"—",colorOf(s))}
  if(mtxTargets().length){list.appendChild(h("div","mixhead","Matrices <small>los faders de los Mains y de los buses pasan a ser sus envíos a esa matriz</small>"));
    for(const t of mtxTargets()){const s=BY[t.id];mk(t.n,s.label,S[s.id+".name"]||"—",colorOf(s))}}
  openSheet("#mixSheet");
}
$("#mixSel").onclick=()=>P.musician?toast("Modo músico activo: se cambia en Ajustes → Modo músico"):openMix();

function renderScenes(){
  const l=$("#sceneList");l.innerHTML="";
  if(!scenes.length){l.innerHTML='<div class="empty">Todavía no has guardado ninguna mezcla.</div>';return}
  scenes.forEach(sc=>{const i=sc.i;const it=h("div","item",`<span>${esc(sc.name)}<small>${esc(sc.time||"")}</small></span>`);
    const ld=h("button","btn small red","Cargar"),del=h("button","btn small","Borrar");
    ld.onclick=()=>{if(ld.dataset.c){send({t:"sceneLoad",i});closeSheets();toast(`Mezcla «${sc.name}» cargada`)}else{ld.dataset.c=1;ld.textContent="¿Seguro?";setTimeout(()=>{delete ld.dataset.c;ld.textContent="Cargar"},2500)}};
    del.onclick=()=>{if(del.dataset.c)send({t:"sceneDelete",i});else{del.dataset.c=1;del.textContent="¿Seguro?";setTimeout(()=>{delete del.dataset.c;del.textContent="Borrar"},2500)}};
    it.appendChild(ld);it.appendChild(del);l.appendChild(it)});
}
$("#scenesBtn").onclick=()=>{const r=$("#sceneRow");r.classList.toggle("show");$("#scenesBtn").classList.toggle("on",r.classList.contains("show"));renderSceneRow()};
$("#sceneSave").onclick=()=>{send({t:"sceneSave",name:$("#sceneName").value});$("#sceneName").value="";toast("Mezcla guardada")};
$("#setBtn").onclick=()=>openSettings();

let vEd=null;
function openLayerEditor(id){
  if(id!==undefined){const v=layout.views.find(x=>x.id===id);vEd=v?{...v,ids:[...v.ids]}:{id:"v"+Date.now().toString(36),name:"",ids:[]};
    $("#layerTitle").textContent=v?"Editar capa":"Nueva capa";$("#layerName").value=vEd.name;$("#layerDel").style.display=v?"":"none"}
  const box=$("#layerPick");box.innerHTML="";
  const groups=MODEL.layers.map(l=>[l.name==="1–16"?"Canales 1–16":l.name,l.ids.map(id=>BY[id])]).concat(
    [[MODEL.kind==="wing"?"":"Principal",[BY[MODEL.master]].filter(s=>!MODEL.layers.some(l=>l.ids.includes(s.id)))]]).filter(g=>g[1].length);
  if(layout.groups.length)groups.unshift(["Grupos",layout.groups.map(g=>({id:"g:"+g.id,label:g.n,grp:g}))]);
  for(const[t,list]of groups){box.appendChild(h("h3","sec",t));const g=h("div","pick");
    for(const s of list){const b=h("button","",esc(s.grp?s.grp.n:S[s.id+".name"]||s.label));b.style.setProperty("--c",s.grp?s.grp.c:colorOf(s));
      const paint=()=>{const i=vEd.ids.indexOf(s.id);b.classList.toggle("sel",i>=0);b.dataset.n=i>=0?i+1:""};paint();
      b.onclick=()=>{const i=vEd.ids.indexOf(s.id);i>=0?vEd.ids.splice(i,1):vEd.ids.push(s.id);box.querySelectorAll(".pick button").forEach(x=>x._paint());};b._paint=paint;g.appendChild(b)}
    box.appendChild(g)}
  openSheet("#layerSheet");
}
$("#layerName").oninput=()=>{vEd.name=$("#layerName").value};
$("#layerClear").onclick=()=>{vEd.ids=[];openLayerEditor()};
$("#layerDone").onclick=()=>{vEd.name=vEd.name.trim()||`Capa ${layout.views.length+1}`;
  const i=layout.views.findIndex(x=>x.id===vEd.id);i>=0?layout.views[i]=vEd:layout.views.push(vEd);
  sendLayout();closeSheets();buildLayers();layer="v:"+vEd.id;store("layer",layer);renderLayers();renderDesk();toast("Capa guardada")};
$("#layerDel").onclick=()=>{const b=$("#layerDel");if(!b.dataset.c){b.dataset.c=1;b.textContent="¿Seguro?";setTimeout(()=>{delete b.dataset.c;b.textContent="Borrar capa"},2500);return}
  delete b.dataset.c;b.textContent="Borrar capa";layout.views=layout.views.filter(x=>x.id!==vEd.id);sendLayout();closeSheets();buildLayers();renderLayers();renderDesk();toast("Capa borrada")};

$("#dClose").onclick=closeDetail;$("#dPrev").onclick=()=>stepDetail(-1);$("#dNext").onclick=()=>stepDetail(1);
document.addEventListener("keydown",e=>{if(e.target.tagName==="INPUT")return;
  if(e.key==="Escape"){closeSheets();closeDetail()}
  if(detailId&&(e.key==="ArrowDown"||e.key==="ArrowUp")){stepDetail(e.key==="ArrowDown"?1:-1);e.preventDefault()}});

function toast(msg){const t=$("#toast");t.textContent=msg;t.classList.add("show");clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove("show"),4000)}

/* ================================================================ grupos propios (un fader para varios canales) */
const GROUP_COLORS=["#e3101c","#ff8a1f","#f2c230","#2fbf5b","#1fc2d4","#2f7bf2","#b06ad8","#ff5fb0","#8b8b93"];
const groupOf=id=>typeof id==="string"&&id.startsWith("g:")?layout.groups.find(g=>"g:"+g.id===id):null;
function sendLayout(){send({t:"layout",v:{views:layout.views,groups:layout.groups}})}
/* nivel de un grupo en una mezcla (main o bus n): mueve sus canales manteniendo la distancia entre ellos */
const gKey=bus=>bus?"b"+bus:"main";
const grpMembers=g=>g.m.map(id=>BY[id]).filter(Boolean);
const grpKeys=(g,bus)=>grpMembers(g).filter(m=>!bus||sendsTo(m,bus)).map(m=>faderKey(m,bus));
const grpLevel=(g,bus)=>{const v=g.niv[gKey(bus)];return v==null?0:v};
function grpStart(g,bus){
  const gd=grpLevel(g,bus),prev=(g.off||{})[gKey(bus)]||{},off={};
  for(const k of grpKeys(g,bus)){const d=+S[k];off[k]=gd>-90?(d<=-89?null:d-gd):(prev[k]!==undefined?prev[k]:(d<=-89?null:d));hold(k)}
  g.off=g.off||{};g.off[gKey(bus)]=off;return off;
}
function grpSet(g,bus,gd,off){g.niv[gKey(bus)]=gd;for(const k in off){const o=off[k];setP(k,o===null||gd<=-90?-144:clamp(o+gd,-144,10))}}
function grpEnd(g,bus){grpKeys(g,bus).forEach(release);sendLayout()}

function makeGroupStrip(scope,g){
  const el=document.createElement("div");el.className="strip group";el.style.setProperty("--c",g.c);el.dataset.id="g:"+g.id;
  el.innerHTML=`<button class="scribble" title="Envíos y ajustes del grupo"><span class="num">Grupo · ${g.m.length}</span><span class="nm">${esc(g.n)}</span></button>
    <div class="members"></div>
    <div class="ms"><button class="mute" title="Silenciar todo el grupo">${MUTE_ICON}<small>MUTE</small></button></div>
    <div class="fader"><div class="scale">${SCALE.map(d=>`<span class="${d===0?"zero":""}" style="top:${capPos(FD.pos(d))}">${d===-90?"-∞":d>0?"+"+d:d}</span>`).join("")}</div>
      <div class="track"><div class="fill"></div></div><div class="gap"></div><div class="fader-cap"></div></div>
    <div class="db"></div>`;
  const q=c=>el.querySelector(c);
  if(sendBus){el.classList.add("sendmode");el.style.setProperty("--bus",busColor(sendBus))}
  watch(scope,[...grpMembers(g).map(m=>m.id+".mute"),...grpMembers(g).map(m=>m.id+".name")],()=>{
    const ms=grpMembers(g);q(".members").textContent=ms.map(nameOf).join(", ")||"Sin canales";
    const all=ms.length&&ms.every(m=>+S[m.id+".mute"]);q(".mute").classList.toggle("on",!!all);el.classList.toggle("muted",!!all)});
  const paint=()=>{const lv=grpLevel(g,sendBus),v=FD.pos(lv);q(".fader-cap").style.top=capPos(v);q(".fill").style.height=`calc((100% - 44px) * ${v.toFixed(4)})`;q(".db").textContent=F.db(lv)};
  paint();
  let off={};
  const fader=q(".fader");
  dragV(fader,()=>FD.pos(grpLevel(g,sendBus)),v=>{grpSet(g,sendBus,FD.db(v),off);paint()},
    {start:()=>{off=grpStart(g,sendBus)},end:()=>grpEnd(g,sendBus),dbl:null,travel:()=>fader.clientHeight-44});
  q(".mute").onclick=()=>{if(locked)return;const ms=grpMembers(g),all=ms.length&&ms.every(m=>+S[m.id+".mute"]);ms.forEach(m=>setP(m.id+".mute",all?0:1))};
  q(".scribble").onclick=()=>openGroupSends(g.id);
  return el;
}

/* envíos del grupo a cada monitor */
function openGroupSends(id){
  const g=layout.groups.find(x=>x.id===id);if(!g)return;
  $("#gsTitle").textContent=g.n;$("#gsTitle").style.setProperty("--c",g.c);
  $("#gsMembers").textContent=grpMembers(g).map(nameOf).join(", ");
  $("#gsEdit").style.display=P.musician?"none":"";$("#gsEdit").onclick=()=>{closeSheets();openGroupEditor(g.id)};
  const box=$("#gsList");box.innerHTML="";
  const rows=[[0,"Principal","Mezcla del público","var(--red)"],...MODEL.targets.concat(mtxTargets()).map(t=>{const s=BY[t.id];return[t.n,nameOf(s),s.label,colorOf(s)]})]
    .filter(r=>!P.musician||r[0]===P.musician);
  for(const[bus,name,sub,c]of rows){
    if(bus&&!grpKeys(g,bus).length)continue;
    const row=h("div","send noon",`<div class="who"><small>${esc(sub)}</small><span>${esc(name)}</span></div><div class="hslider"><b></b></div><div class="val"></div>`);
    row.querySelector(".who").style.setProperty("--c",c);
    const sl=row.querySelector(".hslider"),paint=()=>{const lv=grpLevel(g,bus);sl.querySelector("b").style.width=(FD.pos(lv)*100)+"%";row.querySelector(".val").textContent=F.db(lv)};
    paint();let off={};
    dragH(sl,()=>FD.pos(grpLevel(g,bus)),v=>{grpSet(g,bus,FD.db(v),off);paint()},{start:()=>{off=grpStart(g,bus)},end:()=>{grpEnd(g,bus);if(bus===sendBus)renderDesk()},travel:()=>sl.clientWidth});
    box.appendChild(row);
  }
  openSheet("#groupSendsSheet");
}

let gEd=null;
function openGroupEditor(id){
  const g=layout.groups.find(x=>x.id===id);
  gEd=g?{...g,m:[...g.m]}:{id:"g"+Date.now().toString(36),n:"",c:GROUP_COLORS[layout.groups.length%GROUP_COLORS.length],m:[],niv:{}};
  $("#grpTitle").textContent=g?"Editar grupo":"Nuevo grupo";$("#grpDel").style.display=g?"":"none";
  $("#grpName").value=gEd.n;paintGroupEditor();openSheet("#groupSheet");
}
function paintGroupEditor(){
  const cols=$("#grpColors");cols.innerHTML="";
  GROUP_COLORS.forEach(c=>{const b=h("button","");b.style.background=c;b.classList.toggle("sel",c===gEd.c);b.onclick=()=>{gEd.c=c;paintGroupEditor()};cols.appendChild(b)});
  const box=$("#grpPick");box.innerHTML="";
  for(const L of MODEL.layers){if(L.id==="dca")continue;box.appendChild(h("h3","sec",L.name==="1–16"?"Canales 1–16":L.name));const gr=h("div","pick");
    for(const id of L.ids){const s=BY[id],b=h("button","",esc(nameOf(s)));b.style.setProperty("--c",colorOf(s));b.classList.toggle("sel",gEd.m.includes(id));b.dataset.n=gEd.m.includes(id)?"✓":"";
      b.onclick=()=>{const i=gEd.m.indexOf(id);i>=0?gEd.m.splice(i,1):gEd.m.push(id);paintGroupEditor()};gr.appendChild(b)}
    box.appendChild(gr)}
}
$("#grpName").oninput=()=>{gEd.n=$("#grpName").value};
$("#grpSave").onclick=()=>{
  gEd.n=gEd.n.trim();if(!gEd.n){toast("Ponle un nombre al grupo");$("#grpName").focus();return}
  if(!gEd.m.length){toast("Elige al menos un canal");return}
  const i=layout.groups.findIndex(x=>x.id===gEd.id);
  if(i>=0)layout.groups[i]={...layout.groups[i],n:gEd.n,c:gEd.c,m:gEd.m};
  else layout.groups.push(gEd);
  sendLayout();closeSheets();buildLayers();renderLayers();renderDesk();toast("Grupo guardado")};
$("#grpDel").onclick=()=>{const b=$("#grpDel");if(!b.dataset.c){b.dataset.c=1;b.textContent="¿Seguro?";setTimeout(()=>{delete b.dataset.c;b.textContent="Eliminar grupo"},2500);return}
  delete b.dataset.c;b.textContent="Eliminar grupo";
  layout.groups=layout.groups.filter(x=>x.id!==gEd.id);layout.views.forEach(v=>v.ids=v.ids.filter(x=>x!=="g:"+gEd.id));
  sendLayout();closeSheets();buildLayers();renderLayers();renderDesk();toast("Grupo eliminado")};

/* ================================================================ filas rápidas: monitores y escenas */
function renderMonRow(){
  const r=$("#monRow");r.classList.toggle("show",!!sendBus&&!P.musician);if(!sendBus||P.musician)return;r.innerHTML="";
  const mk=(n,label,sub,c)=>{const b=h("button","chip",`${esc(label)}<small>${esc(sub)}</small>`);b.style.setProperty("--c",c);b.classList.toggle("sel",n===sendBus);
    b.onclick=()=>{sendBus=n;store("sendBus",n);renderDesk()};r.appendChild(b)};
  mk(0,"Principal","Volver a la mezcla del público","var(--red)");
  for(const t of(sendBus>100?mtxTargets():MODEL.targets)){const s=BY[t.id];mk(t.n,nameOf(s),s.label,colorOf(s))}
}
function renderSceneRow(){
  const r=$("#sceneRow");if(!r.classList.contains("show"))return;r.innerHTML="";
  if(!scenes.length)r.appendChild(h("span","rowhint","Aún no hay mezclas guardadas."));
  for(const sc of scenes){const b=h("button","chip",`${esc(sc.name)}<small>${esc(sc.time||"")}</small>`);
    b.onclick=()=>{if(locked){toast("Controles bloqueados");return}
      if(!b.dataset.c){r.querySelectorAll(".chip.confirm").forEach(x=>{x.classList.remove("confirm");delete x.dataset.c});b.dataset.c=1;b.classList.add("confirm");
        b.querySelector("small").textContent="Toca otra vez para cargar";setTimeout(()=>{if(b.isConnected){delete b.dataset.c;b.classList.remove("confirm");b.querySelector("small").textContent=sc.time||""}},3000);return}
      send({t:"sceneLoad",i:sc.i});toast(`Mezcla «${sc.name}» cargada`);renderSceneRow()};r.appendChild(b)}
  const g=h("button","chip ghost","＋ Guardar / gestionar");g.onclick=()=>{renderScenes();openSheet("#sceneSheet")};r.appendChild(g);
}

/* ================================================================ pantalla completa (versiones web) */
const fsEl=()=>document.fullscreenElement||document.webkitFullscreenElement;
function toggleFull(){
  const el=document.documentElement;
  try{if(fsEl()){(document.exitFullscreen||document.webkitExitFullscreen).call(document);return}
    const r=(el.requestFullscreen||el.webkitRequestFullscreen).call(el);
    if(r&&r.catch)r.catch(()=>fullHelp())}catch(e){fullHelp()}
}
function fullHelp(){toast("Aquí no se puede poner a pantalla completa. Usa «Tamaño» en Ajustes → Personalizar, o la app MBMix del iPad, que siempre va a pantalla completa.")}
if(window.MBEngine&&MBEngine.native)$("#fsBtn").remove();else $("#fsBtn").onclick=toggleFull;

/* ================================================================ bloqueo */
$("#lockBtn").onclick=()=>{locked=!locked;document.body.classList.toggle("locked",locked);$("#lockBtn").classList.toggle("on",locked);
  $("#lockBtn small").textContent=locked?"Bloqueado":"Bloquear";toast(locked?"Controles bloqueados: toca el candado para desbloquear":"Controles desbloqueados")};

/* ================================================================ ajustes */
const sidePanel=()=>load("panel",innerWidth>=1000?"lateral":"completa")==="lateral"&&innerWidth>=900;
let wake=null,setSec="perso";
const SECTIONS=[["perso","Personalizar"],["musico","Modo músico"],["vista","Mis capas"],["grupos","Grupos"],["links","Canales enlazados"],["pantalla","Pantalla"],["ayuda","Ayuda"],["datos","Datos"]];
function openSettings(sec){if(sec)setSec=sec;paintSettings();openSheet("#setSheet")}
function paintSettings(){
  const nav=$("#setNav");nav.innerHTML="<h2>Ajustes</h2>";
  for(const[id,t]of SECTIONS){const b=h("button","",t);b.classList.toggle("sel",id===setSec);b.onclick=()=>{setSec=id;paintSettings()};nav.appendChild(b)}
  const c=$("#setBody");c.innerHTML="";
  const sw=(label,sub,on,fn)=>{const r=h("div","setrow",`<div><b>${label}</b><small>${sub}</small></div>`);const b=h("button","switch mini"+(on?" on":""),"<i></i>");b.onclick=fn;r.appendChild(b);return r};
  const act=(label,fn,cls="btn red")=>{const b=h("button",cls,label);b.onclick=fn;return b};
  if(setSec==="perso"){
    c.appendChild(h("h3","","Personalizar"));c.appendChild(h("p","sub","Elige cómo se ve y cómo responde la mesa en este iPad. Cada iPad puede tenerlo a su gusto."));
    const seg=(label,sub,opts,cur,fn)=>{const r=h("div","setrow",`<div><b>${label}</b><small>${sub}</small></div>`);const g=h("div","segbar");
      for(const[v,t]of opts){const b=h("button",v===cur?"sel":"",t);b.onclick=()=>{fn(v);paintSettings()};g.appendChild(b)}r.appendChild(g);return r};
    c.appendChild(seg("Tamaño","Hazlo más grande si lo ves pequeño en el iPad.",[[1,"100 %"],[1.15,"115 %"],[1.3,"130 %"],[1.5,"150 %"]],+P.zoom||1,v=>{P.zoom=v;savePrefs();setTimeout(notifyAll,50)}));
    c.appendChild(seg("Tema","Oscuro para el escenario; claro para trabajar de día o al sol. Automático sigue al iPad.",[["auto","Automático"],["dark","Oscuro"],["light","Claro"]],P.theme,v=>{P.theme=v;savePrefs();notifyAll()}));
    c.appendChild(seg("Faders a la vista","Cuántas tiras caben en pantalla a la vez.",[[0,"Auto"],[8,"8"],[12,"12"],[16,"16"]],P.cols,v=>{P.cols=v;savePrefs()}));
    c.appendChild(h("h3","sec","Qué se ve en cada tira"));
    for(const[k,t,sub]of[["proc","Mini ecualizador y procesado","El dibujo del EQ y las marcas P · C · EQ."],["pan","Panorama","La barrita de izquierda / derecha."],
      ["solo","Botón SOLO",""],["scale","Escala de dB","Los números junto al fader."],["meter","Vúmetro",""]])
      c.appendChild(sw(t,sub,!!P[k],()=>{P[k]=P[k]?0:1;savePrefs();paintSettings()}));
    c.appendChild(sw("Nombres grandes","Letra más grande en los nombres de los canales.",!!P.big,()=>{P.big=P.big?0:1;savePrefs();paintSettings()}));
    c.appendChild(h("h3","sec","Faders"));
    c.appendChild(sw("Doble toque = 0 dB","Al tocar dos veces un fader vuelve a 0 dB.",!!P.dbl,()=>{P.dbl=P.dbl?0:1;savePrefs();paintSettings()}));
    c.appendChild(sw("Modo fino","Los faders se mueven más despacio para ajustes de precisión.",!!P.fine,()=>{P.fine=P.fine?0:1;savePrefs();paintSettings()}));
    c.appendChild(h("h3","sec","Color de acento"));
    const ac=h("div","accents");for(const[k,a]of Object.entries(ACCENTS)){const b=h("button",k===P.accent?"sel":"",`<i style="background:${a[1]}"></i>${a[0]}`);
      b.onclick=()=>{P.accent=k;savePrefs();paintSettings()};ac.appendChild(b)}c.appendChild(ac);
    c.appendChild(act("Volver a lo de fábrica",()=>{const m=P.musician;P=Object.assign({},PDEF,{musician:m});savePrefs();renderDesk();notifyAll();paintSettings()},"btn"));
  }else if(setSec==="musico"){
    c.appendChild(h("h3","","Modo músico"));
    c.appendChild(h("p","sub","Convierte este iPad en el control de monitor de un músico: solo ve su mezcla y solo puede subir y bajar lo que le llega. No puede tocar la mezcla principal, el procesado ni la conexión."));
    const l=h("div","list");
    const it0=h("div","item",`<span>Desactivado<small>Control completo de la mesa</small></span>`);const b0=h("button","switch mini"+(P.musician?"":" on"),"<i></i>");
    b0.onclick=()=>{P.musician=0;savePrefs();sendBus=0;store("sendBus",0);buildLayers();renderLayers();renderDesk();paintSettings()};it0.appendChild(b0);l.appendChild(it0);
    for(const t of MODEL.targets){const bs=BY[t.id];const it=h("div","item",`<span><i class="dot" style="background:${colorOf(bs)}"></i>${esc(nameOf(bs))}<small>${esc(bs.label)}</small></span>`);
      const b=h("button","switch mini"+(P.musician===t.n?" on":""),"<i></i>");
      b.onclick=()=>{P.musician=t.n;savePrefs();sendBus=t.n;store("sendBus",t.n);renderLayers();renderDesk();paintSettings();toast(`Modo músico: ${nameOf(bs)}`)};it.appendChild(b);l.appendChild(it)}
    c.appendChild(l);
  }else if(setSec==="vista"){
    c.appendChild(h("h3","","Mis capas"));c.appendChild(h("p","sub","Capas con nombre propio (por ejemplo «Batería», «Voces», «Mi monitor») con los canales y grupos que quieras, en el orden que elijas. Aparecen arriba, junto a las demás."));
    const l=h("div","list");if(!layout.views.length)l.appendChild(h("div","empty","Todavía no has creado ninguna capa."));
    for(const v of layout.views){const it=h("div","item",`<span>${esc(v.name)}<small>${esc(v.ids.map(id=>groupOf(id)?groupOf(id).n+" (grupo)":BY[id]?nameOf(BY[id]):"").filter(Boolean).join(", ")||"vacía")}</small></span>`);
      it.appendChild(act("Editar",()=>{closeSheets();openLayerEditor(v.id)},"btn small"));l.appendChild(it)}
    c.appendChild(l);c.appendChild(act("＋ Nueva capa",()=>{closeSheets();openLayerEditor(null)}));
  }else if(setSec==="grupos"){
    c.appendChild(h("h3","","Grupos"));c.appendChild(h("p","sub","Un fader que sube y baja varios canales a la vez manteniendo la mezcla entre ellos. Funciona en la mezcla principal y en cada monitor."));
    const l=h("div","list");if(!layout.groups.length)l.appendChild(h("div","empty","Todavía no hay grupos."));
    for(const g of layout.groups){const it=h("div","item",`<span><i class="dot" style="background:${g.c}"></i>${esc(g.n)}<small>${esc(g.m.map(id=>BY[id]?nameOf(BY[id]):"").join(", "))}</small></span>`);
      it.appendChild(act("Editar",()=>{closeSheets();openGroupEditor(g.id)},"btn small"));l.appendChild(it)}
    c.appendChild(l);c.appendChild(act("＋ Nuevo grupo",()=>{closeSheets();openGroupEditor(null)}));
  }else if(setSec==="links"){
    c.appendChild(h("h3","","Canales enlazados"));c.appendChild(h("p","sub","Dos canales enlazados se mueven juntos: fader, mute, envíos, ecualizador, compresor y puerta. La ganancia y el +48V siguen siendo de cada uno."));
    const l=h("div","list");
    for(const s of STRIPS.filter(x=>x.kind==="ch")){const n=+s.id.slice(2);if(n%2===0||!BY["ch"+(n+1)])continue;const on=layout.links.includes(n);
      const it=h("div","item",`<span>Canales ${n}–${n+1}<small>${esc(nameOf(s))} · ${esc(nameOf(BY["ch"+(n+1)]))}</small></span>`);
      const b=h("button","switch mini"+(on?" on":""),"<i></i>");b.onclick=()=>{if(locked)return;send({t:"link",ch:n,on:!on});layout.links=on?layout.links.filter(x=>x!==n):[...layout.links,n];paintSettings()};
      it.appendChild(b);l.appendChild(it)}
    c.appendChild(l);
  }else if(setSec==="pantalla"){
    c.appendChild(h("h3","","Pantalla"));
    c.appendChild(sw("Canal en panel lateral","Al tocar un canal se abre a la derecha y sigues viendo los faders. Si lo apagas, ocupa toda la pantalla.",sidePanel(),()=>{store("panel",sidePanel()?"completa":"lateral");paintSettings()}));
    c.appendChild(sw("Mantener pantalla encendida","Evita que el iPad se apague durante el bolo.",!!wake,async()=>{
      if(window.MBEngine&&MBEngine.native){wake=wake?null:{};send({t:"awake",on:!!wake});paintSettings();return}
      try{if(wake){await wake.release();wake=null}else{wake=await navigator.wakeLock.request("screen");wake.addEventListener("release",()=>{wake=null})}}
      catch(e){toast("Este navegador no permite mantener la pantalla encendida. En el iPad: Ajustes → Pantalla y brillo → Bloqueo automático → Nunca.")}paintSettings()}));
    if(!(window.MBEngine&&MBEngine.native))c.appendChild(sw("Pantalla completa","Oculta las barras del navegador (en el iPad, mejor «Añadir a pantalla de inicio»).",!!document.fullscreenElement,async()=>{
      try{document.fullscreenElement?await document.exitFullscreen():await document.documentElement.requestFullscreen()}catch(e){toast("Este navegador no permite pantalla completa")}setTimeout(paintSettings,300)}));
  }else if(setSec==="ayuda"){
    c.appendChild(h("h3","","Cómo se usa"));c.appendChild($("#helpList").cloneNode(true));
  }else{
    c.appendChild(h("p","sub","MBMix · MB Soundtools"));c.appendChild(h("h3","","Datos"));
    c.appendChild(h("p","sub",`Tus capas, grupos y canales enlazados se guardan ${STANDALONE?"en este iPad":"en el ordenador de MBMix y se comparten con todos los iPads"}. Las mezclas guardadas están en «Mezclas».`));
    c.appendChild(act("Restablecer vista, grupos y enlaces",function(){if(!this.dataset.c){this.dataset.c=1;this.textContent="¿Seguro? Toca otra vez";return}
      send({t:"reset"});["layer","sendBus","panel"].forEach(k=>{try{localStorage.removeItem("mbmix."+k)}catch(e){}});toast("Restablecido");closeSheets()},"btn danger"));
  }
}

/* ================================================================ conexión con el servidor MBMix */
/* En la app del iPad (o abriendo la página con ?local) el motor corre aquí mismo; si no, se usa el servidor del ordenador */
const STANDALONE=!!window.MBEngine&&(MBEngine.native||window.MBMIX_LOCAL||location.protocol==="file:"||new URLSearchParams(location.search).has("local"));
function send(o){if(STANDALONE)MBEngine.handle(o);else if(ws&&ws.readyState===1)ws.send(JSON.stringify(o))}
function connectWs(){
  if(STANDALONE){document.body.classList.add("standalone");MBEngine.start(handleMsg);return}
  ws=new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host+"/ws");
  ws.onopen=()=>{wsTries=0};
  ws.onmessage=e=>handleMsg(JSON.parse(e.data));
  ws.onclose=()=>{ws=null;$("#connDot").className="conn-dot";if(wsTries++>1)toast("Sin conexión con el ordenador de MBMix. Reintentando…");setTimeout(connectWs,Math.min(5000,500*wsTries))};
}
function handleMsg(m){
    switch(m.t){
      case"m":M=m.v;break;
      case"upd":{const ch=[];for(const p in m.v)if(!active.has(p)){S[p]=m.v[p];ch.push(p)}notify(ch);break}
      case"state":S=m.v;notifyAll();break;
      case"model":{const was=MODEL.kind;MODEL=m;STRIPS=m.strips;SPEC=m.spec;BY={};STRIPS.forEach(s=>BY[s.id]=s);
        layout={custom:[],groups:[],links:[],views:[]};buildLayers();if(was&&was!==m.kind){closeDetail();closeSheets();sendBus=0;store("sendBus",0)}
        if(status.t){renderLayers();renderDesk()}break}
      case"status":{const first=!status.t;status=m;const d=$("#connDot");d.className="conn-dot"+(m.mode==="demo"?" demo":m.connected?" on":"");
        document.body.classList.toggle("nometers",!m.meters);if(!m.meters)M={};
        $("#lanUrl").textContent=m.url;$("#connInfo").textContent=m.mode==="offline"?"Elige tu mesa. Con «Demo» puedes probarlo todo sin mesa.":
          m.connected?`Conectado a: ${m.info}`:`La mesa no responde${m.ip?" ("+m.ip+")":""}. Reintentando…`;
        $("#nl1").classList.add("ok");$("#nl2").classList.toggle("ok",m.mode==="live"&&m.connected);
        $("#nodeMixer").textContent=m.kind==="xair"?"XR18":"WING";$("#nodeIp").textContent=m.mode==="demo"?"simulada":m.ip||"sin IP";
        $("#connState").textContent=m.mode==="demo"?"Demo":m.connected?(m.kind==="xair"?"XR18":"WING"):"Sin mesa";
        if(first){renderLayers();renderDesk();if(m.mode==="demo"&&!load("seen",""))openConn(),store("seen",1)}
        else if(m.mode==="live"&&!m.connected)toast("Se ha perdido la conexión con la mesa");break}
      case"connectResult":$("#connectBtn").textContent="Conectar";if(m.ok){closeSheets();toast("Conectado")}else toast(m.msg);break;
      case"found":{const f=$("#found");f.innerHTML="";if(!m.v.length)f.innerHTML='<div class="empty">No he encontrado ninguna mesa. Comprueba que el ordenador está en la misma red y escribe la IP a mano.</div>';
        m.v.forEach(x=>{const b=h("button","",`${esc(x.name)} <small>${esc(x.model)} · ${esc(x.ip)}</small>`);
          b.onclick=()=>{connCard=x.kind==="xair"?"xr18":(connCard==="wing"?"wing":"rack");connDemo=false;paintConn();$("#ip").value=x.ip;$("#ip").dataset.edited=1};f.appendChild(b)});break}
      case"scenes":scenes=m.v;renderScenes();renderSceneRow();break;
      case"layout":{layout=Object.assign({custom:[],groups:[],links:[],views:[]},m.v||{});for(const k of["custom","groups","links","views"])if(!Array.isArray(layout[k]))layout[k]=[];
        if(!layout.views.length&&layout.custom.length)layout.views=[{id:"v1",name:"Mi vista",ids:layout.custom}];
        layout.views.forEach(v=>{v.ids=(v.ids||[]).filter(id=>BY[id]||id.startsWith("g:"))});
        layout.groups.forEach(g=>{g.niv=g.niv||{};g.m=(g.m||[]).filter(id=>BY[id])});layout.custom=layout.custom.filter(id=>BY[id]||groupOf(id));
        buildLayers();if(status.t){renderLayers();renderDesk();if(detailId&&detailTab==="cfg")renderPane(BY[detailId])}break}
    }
}
window.addEventListener("resize",()=>notifyAll());
applyPrefs();
requestAnimationFrame(meterLoop);
connectWs();
