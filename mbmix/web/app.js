"use strict";
/* MB Soundtools · MBMix — interfaz táctil (estilo Mixing Station) */

const $=s=>document.querySelector(s);
const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
const pad2=n=>String(n).padStart(2,"0");
const range=(a,b)=>Array.from({length:b-a+1},(_,i)=>a+i);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

/* ================================================================ estado */
let STRIPS=[],BY={},TYPES={},DEF={},S={},M={},status={},scenes=[],layout={custom:[]};
let ws=null,wsTries=0;
let layer=load("layer","in1"),sendBus=+load("sendBus",0),detailId=null,detailTab=null,eqBand=1;
const active=new Set();          // parámetros que se están moviendo con el dedo (no se pisan con lo que llega)

function load(k,d){try{const v=localStorage.getItem("mbmix."+k);return v==null?d:v}catch(e){return d}}
function store(k,v){try{localStorage.setItem("mbmix."+k,v)}catch(e){}}

/* ---- observadores: cada control se redibuja cuando cambia su parámetro ---- */
const W=new Map(),SCOPES=new Map();let METERS=[];
function watch(scope,paths,fn){const e={fn,paths};for(const p of paths){if(!W.has(p))W.set(p,new Set());W.get(p).add(e)}
  if(!SCOPES.has(scope))SCOPES.set(scope,[]);SCOPES.get(scope).push(e);fn();return e}
function unwatch(scope){for(const e of SCOPES.get(scope)||[])for(const p of e.paths)W.get(p)?.delete(e);SCOPES.delete(scope);METERS=METERS.filter(m=>m.scope!==scope)}
function notify(paths){const run=new Set();for(const p of paths)W.get(p)?.forEach(e=>run.add(e));run.forEach(e=>e.fn())}
function notifyAll(){SCOPES.forEach(l=>l.forEach(e=>e.fn()))}

function setP(p,v){if(!(p in TYPES))return;if(TYPES[p]==="f")v=clamp(v);S[p]=v;send({t:"set",p,v});notify([p])}
function hold(p){active.add(p)} function release(p){setTimeout(()=>active.delete(p),350)}

/* ================================================================ conversión de valores X32 */
const X={
  db(f){return f>=.5?f*40-30:f>=.25?f*80-50:f>=.0625?f*160-70:f>0?f*480-90:-Infinity},
  fromDb(d){return d>=-10?(d+30)/40:d>=-30?(d+50)/80:d>=-60?(d+70)/160:d>-90?(d+90)/480:0},
  fmtDb(f){const d=X.db(f);return d<=-89.9?"-∞":(d>0?"+":"")+d.toFixed(d<=-10?0:1)},
  hz:f=>20*Math.pow(1000,f), hzN:h=>clamp(Math.log(h/20)/Math.log(1000)),
  q:f=>10*Math.pow(.03,f), qN:q=>clamp(Math.log(q/10)/Math.log(.03)),
  g:f=>-15+30*f, gN:g=>clamp((g+15)/30),
  hpf:f=>20*Math.pow(20,f), hold:f=>.02*Math.pow(1e5,f), rel:f=>5*Math.pow(800,f),
  fmtHz(h){return h<1000?Math.round(h)+" Hz":(h/1000).toFixed(h<10000?2:1)+" k"},
  fmtMs(ms){return ms<10?ms.toFixed(1)+" ms":ms<1000?Math.round(ms)+" ms":(ms/1000).toFixed(2)+" s"},
  sgn(v,d=1,u=" dB"){return (v>0?"+":"")+v.toFixed(d)+u},
};
const RATIOS=[1.1,1.3,1.5,2,2.5,3,4,5,7,10,20,100];
const GATE_MODES=["EXP 2","EXP 3","EXP 4","GATE","DUCK"];
const EQ_TYPES=["Corte grave","Shelf grave","Campana","Vintage","Shelf agudo","Corte agudo"];
const EQ_SHORT=["LC","LS","PEQ","VEQ","HS","HC"];
const COLORS=["#4a4a52","#e3101c","#2fbf5b","#f2c230","#2f7bf2","#c23be0","#1fc2d4","#e8e8ec"];
const COLOR_NAMES=["Sin color","Rojo","Verde","Amarillo","Azul","Magenta","Cian","Blanco"];

/* ================================================================ tiras */
const base=s=>s.base;
const nameOf=s=>S[s.base+"/config/name"]||s.label;
function colorOf(s){const i=+S[s.base+"/config/color"]||0;return{c:COLORS[i%8],inv:i>=8&&i!==8}}
const faderPath=(s,bus)=>s.kind==="dca"?s.base+"/fader":bus&&s.sends?`${s.base}/mix/${pad2(bus)}/level`:s.base+"/mix/fader";
const onPath=s=>s.kind==="dca"?s.base+"/on":s.base+"/mix/on";
const soloPath=s=>`/-stat/solosw/${pad2(s.solo)}`;
const busStrip=n=>BY["bus"+n];

const LAYERS=[
  {id:"in1",name:"1–16",ids:()=>range(1,16).map(n=>"ch"+n)},
  {id:"in2",name:"17–32",ids:()=>range(17,32).map(n=>"ch"+n)},
  {id:"auxfx",name:"Aux · FX",ids:()=>[...range(1,8).map(n=>"aux"+n),...range(1,8).map(n=>"fx"+n)]},
  {id:"bus",name:"Buses",ids:()=>range(1,16).map(n=>"bus"+n)},
  {id:"out",name:"Mtx · Main",ids:()=>[...range(1,6).map(n=>"mtx"+n),"lr","mono"]},
  {id:"dca",name:"DCA",ids:()=>range(1,8).map(n=>"dca"+n)},
  {id:"custom",name:"Mi capa",ids:()=>(layout.custom||[]).filter(id=>BY[id])},
];

function stripPaths(s,bus){
  const b=s.base,p=[b+"/config/name",b+"/config/color",faderPath(s,bus),onPath(s),soloPath(s)];
  if(s.pan)p.push(b+"/mix/pan");
  if(bus&&s.sends)p.push(`${b}/mix/${pad2(bus)}/on`,`${busStrip(bus).base}/config/color`);
  if(s.eq){p.push(b+"/eq/on");for(let i=1;i<=s.eq;i++)for(const k of["type","f","g","q"])p.push(`${b}/eq/${i}/${k}`)}
  if(s.kind==="ch")p.push(b+"/preamp/hpon",b+"/preamp/hpf");
  if(s.gate)p.push(b+"/gate/on");
  if(s.dyn)p.push(b+"/dyn/on");
  return p;
}

const SCALE=[10,5,0,-5,-10,-20,-30,-40,-50,-60,-90];
function capPos(v){return `calc(22px + (100% - 44px) * ${(1-v).toFixed(4)})`}

function makeStrip(scope,s,{bus=0,detail=false}={}){
  const el=document.createElement("div");
  const sendMode=!!(bus&&s.sends);
  el.className="strip"+(sendMode?" sendmode":"");el.dataset.id=s.id;
  const num=s.kind==="ch"?pad2(+s.id.slice(2)):s.label;
  el.innerHTML=`<button class="scribble"><span class="num">${esc(num)}</span><span class="nm"></span></button>
    <div class="proc${s.eq||s.dyn||s.gate?"":" none"}"><canvas></canvas><div class="tags"></div></div>
    <div class="pan${s.pan?"":" none"}"><b></b><span></span></div>
    <button class="sendon">ENVÍO</button>
    <div class="ms"><button class="mute">MUTE</button><button class="solo">SOLO</button></div>
    <div class="fader"><div class="scale">${SCALE.map(d=>`<span class="${d===0?"zero":""}" style="top:${capPos(X.fromDb(d))}">${d===-90?"-∞":d>0?"+"+d:d}</span>`).join("")}</div>
      <div class="track"><div class="fill"></div></div><div class="meter"><b></b><i></i></div><div class="fader-cap"></div></div>
    <div class="db"></div>`;
  const q=c=>el.querySelector(c);
  const fp=faderPath(s,bus),op=onPath(s),sp=soloPath(s),pp=s.base+"/mix/pan";
  const sendOn=sendMode?`${s.base}/mix/${pad2(bus)}/on`:null;
  const cv=q(".proc canvas");
  if(sendMode)el.style.setProperty("--bus",colorOf(busStrip(bus)).c);

  watch(scope,stripPaths(s,bus),()=>{
    const {c,inv}=colorOf(s);el.style.setProperty("--c",c);
    q(".scribble").classList.toggle("inv",inv);q(".nm").textContent=nameOf(s);
    const v=+S[fp]||0;q(".fader-cap").style.top=capPos(v);q(".fill").style.height=`calc((100% - 44px) * ${v.toFixed(4)})`;
    q(".fill").style.bottom="22px";q(".db").textContent=X.fmtDb(v);
    const on=+S[op];el.classList.toggle("muted",!on);q(".mute").classList.toggle("on",!on);
    q(".solo").classList.toggle("on",!!+S[sp]);
    if(s.pan){const p=+S[pp];const b=q(".pan b");b.style.left=Math.min(50,p*100)+"%";b.style.width=Math.max(1.5,Math.abs(p-.5)*100)+"%";
      const r=Math.round((p-.5)*200);q(".pan span").textContent=r===0?"C":r<0?"L"+(-r):"R"+r}
    if(sendMode){const so=+S[sendOn];q(".sendon").classList.toggle("on",!!so);el.classList.toggle("sendoff",!so);
      el.style.setProperty("--bus",colorOf(busStrip(bus)).c)}
    drawProc(s,cv,q(".tags"));
  });
  if(s.id===detailId&&!detail)el.classList.add("selected");

  // controles
  const fader=q(".fader");
  dragV(fader,()=>+S[fp]||0,v=>setP(fp,v),{start:()=>hold(fp),end:()=>release(fp),dbl:()=>setP(fp,.75),travel:()=>fader.clientHeight-44});
  q(".mute").onclick=()=>setP(op,+S[op]?0:1);
  q(".solo").onclick=()=>setP(sp,+S[sp]?0:1);
  q(".sendon").onclick=()=>sendOn&&setP(sendOn,+S[sendOn]?0:1);
  if(s.pan){const pan=q(".pan");dragH(pan,()=>+S[pp],v=>setP(pp,v),{start:()=>hold(pp),end:()=>release(pp),dbl:()=>setP(pp,.5),travel:()=>pan.clientWidth*1.5})}
  if(!detail){q(".scribble").onclick=()=>openDetail(s.id);
    q(".proc").onclick=e=>openDetail(s.id,e.target.dataset?.tab||(s.eq?"eq":"dyn"))}
  else q(".scribble").onclick=()=>{};
  addMeter(scope,s.id,0,q(".meter"));
  if(s.kind==="dca")q(".solo").classList.add("none");
  return el;
}

/* mini EQ + indicadores de puerta/compresor */
function drawProc(s,cv,tags){
  if(!s.eq&&!s.dyn&&!s.gate)return;
  const b=s.base;
  tags.innerHTML=(s.gate?`<i data-tab="gate" class="${+S[b+"/gate/on"]?"on":""}" data-g="1">G</i>`:"")+
                 (s.dyn?`<i data-tab="dyn" class="${+S[b+"/dyn/on"]?"on":""}" data-d="1">C</i>`:"")+
                 (s.eq?`<i data-tab="eq" class="${+S[b+"/eq/on"]?"on":""}">EQ</i>`:"");
  if(!s.eq)return;
  requestAnimationFrame(()=>{const r=fitCanvas(cv);if(!r)return;const[ctx,w,h]=r;ctx.clearRect(0,0,w,h);
    const on=+S[b+"/eq/on"],pts=eqCurve(s,40);
    ctx.strokeStyle="#222";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();
    ctx.beginPath();pts.forEach(([x,d],i)=>{const X_=x*w,Y=h/2-clamp(d,-18,18)/18*(h/2-3);i?ctx.lineTo(X_,Y):ctx.moveTo(X_,Y)});
    ctx.strokeStyle=on?colorOf(s).c==="#4a4a52"?"#e3101c":colorOf(s).c:"#3a3a40";ctx.lineWidth=1.6;ctx.stroke()});
}

/* ================================================================ arrastre (relativo, como en la app original) */
function dragV(el,get,set,o){dragAxis(el,get,set,o,e=>-e.clientY)}
function dragH(el,get,set,o){dragAxis(el,get,set,o,e=>e.clientX)}
function dragAxis(el,get,set,{start,end,dbl,travel,steps},axis){
  let id=null,p0=0,v0=0,last=0;
  el.addEventListener("pointerdown",e=>{
    if(id!==null)return;id=e.pointerId;try{el.setPointerCapture(id)}catch(_){}
    p0=axis(e);v0=get();start&&start();
    const now=Date.now();if(dbl&&now-last<320){dbl();last=0}else last=now;
    e.preventDefault();
  });
  el.addEventListener("pointermove",e=>{if(e.pointerId!==id)return;
    const fine=e.shiftKey||e.altKey?.15:1,d=(axis(e)-p0)/Math.max(40,travel())*fine;
    let v=clamp(v0+d);if(steps)v=Math.round(v*(steps-1))/(steps-1);set(v)});
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
      if(m.i)m.i.style.transform=`translateY(${-(m.pk*(m.b.parentNode.clientHeight-2)).toFixed(0)}px)`;
      if(m.i)m.i.style.opacity=m.pk>.02?.8:0;
    }else{const gr=raw>0?-20*Math.log10(raw):0,t=clamp(gr/24);m.v=t>m.v?t:Math.max(t,m.v-.02);
      m.b.style.clipPath=`inset(0 0 ${((1-m.v)*100).toFixed(1)}% 0)`;if(m.i)m.i.style.opacity=0}
  }
  if(liveGraph)liveGraph();
  requestAnimationFrame(meterLoop);
}

/* ================================================================ mesa */
function renderLayers(){
  const nav=$("#layers");nav.innerHTML="";
  for(const L of LAYERS){const b=document.createElement("button");b.textContent=L.name;b.classList.toggle("sel",L.id===layer);
    b.onclick=()=>{if(L.id==="custom"&&layer==="custom"){openLayerEditor();return}layer=L.id;store("layer",layer);renderLayers();renderDesk()};
    nav.appendChild(b)}
}
function renderDesk(){
  unwatch("desk");unwatch("master");
  const box=$("#strips");box.innerHTML="";
  const L=LAYERS.find(l=>l.id===layer)||LAYERS[0];
  for(const id of L.ids())box.appendChild(makeStrip("desk",BY[id],{bus:sendBus}));
  if(layer==="dca")box.appendChild(muteGroups());
  if(layer==="custom"){const t=document.createElement("button");t.className="strip";
    t.innerHTML=`<div style="margin:auto;text-align:center;color:var(--muted);font-size:13px;line-height:1.5"><b style="font-size:30px;color:var(--text)">＋</b><br>Editar<br>mi capa</div>`;
    t.onclick=openLayerEditor;box.appendChild(t)}
  box.scrollLeft=0;
  const ms=sendBus?busStrip(sendBus):BY.lr;
  const mbox=$("#master");mbox.innerHTML="";mbox.appendChild(makeStrip("master",ms));
  // selector de mezcla
  const sel=$("#mixSel");sel.classList.toggle("busmode",!!sendBus);
  watch("desk",sendBus?[ms.base+"/config/name",ms.base+"/config/color"]:[],()=>{
    $("#mixName").textContent=sendBus?`${pad2(sendBus)} · ${nameOf(ms)}`:"Main LR";
    sel.style.setProperty("--bus",sendBus?colorOf(ms).c:"var(--red)");
    sel.querySelector("small").textContent=sendBus?"Envíos a bus":"Faders";
  });
}
function muteGroups(){
  const d=document.createElement("div");d.className="mgroups";d.innerHTML="<h4>Grupos de mute</h4>";
  for(let g=1;g<=6;g++){const b=document.createElement("button"),p="/config/mute/"+g;b.textContent="Mute "+g;
    b.onclick=()=>setP(p,+S[p]?0:1);watch("desk",[p],()=>b.classList.toggle("on",!!+S[p]));d.appendChild(b)}
  return d;
}

/* ================================================================ vista de canal */
function tabsFor(s){
  const t=[];
  if(s.kind==="ch"||s.kind==="auxin")t.push(["in","Entrada",s.kind==="ch"?s.base+"/preamp/hpon":null]);
  if(s.gate)t.push(["gate","Puerta",s.base+"/gate/on"]);
  if(s.dyn)t.push(["dyn","Compresor",s.base+"/dyn/on"]);
  if(s.eq)t.push(["eq","EQ",s.base+"/eq/on"]);
  if(s.sends)t.push(["sends","Envíos",null]);
  t.push(["cfg","Nombre y color",null]);
  return t;
}
function openDetail(id,tab){
  const s=BY[id];if(!s)return;
  const tabs=tabsFor(s);
  if(id!==detailId)eqBand=1;
  detailId=id;detailTab=tab&&tabs.some(t=>t[0]===tab)?tab:(tabs.some(t=>t[0]===detailTab)?detailTab:tabs[0][0]);
  unwatch("dhead");unwatch("dstrip");
  $("#detail").classList.add("show");
  watch("dhead",[s.base+"/config/name",s.base+"/config/color",...tabs.map(t=>t[2]).filter(Boolean)],()=>{
    $("#dName").style.setProperty("--c",colorOf(s).c);
    $("#dName").innerHTML=`<i></i><div><b>${esc(nameOf(s))}</b><small>${esc(s.label)}</small></div>`;
    const nav=$("#dTabs");nav.innerHTML="";
    for(const[k,label,onp]of tabs){const b=document.createElement("button");b.innerHTML=(onp?`<i class="${+S[onp]?"on":""}"></i>`:"")+label;
      b.classList.toggle("sel",k===detailTab);b.onclick=()=>{detailTab=k;openDetail(id)};nav.appendChild(b)}
  });
  const ds=$("#dStrip");const st=makeStrip("dstrip",s,{detail:true});ds.replaceWith(st);st.id="dStrip";
  renderPane(s);
  document.querySelectorAll("#strips .strip,#master .strip").forEach(e=>e.classList.toggle("selected",e.dataset.id===id));
}
function closeDetail(){unwatch("dhead");unwatch("dstrip");unwatch("pane");liveGraph=null;detailId=null;$("#detail").classList.remove("show");
  document.querySelectorAll(".strip.selected").forEach(e=>e.classList.remove("selected"))}
function stepDetail(d){const i=STRIPS.findIndex(s=>s.id===detailId);const n=STRIPS[(i+d+STRIPS.length)%STRIPS.length];openDetail(n.id)}

let liveGraph=null;
function renderPane(s){
  unwatch("pane");liveGraph=null;
  const pane=$("#dPane");pane.innerHTML="";pane.scrollTop=0;
  ({in:paneInput,gate:paneGate,dyn:paneDyn,eq:paneEq,sends:paneSends,cfg:paneCfg})[detailTab](s,pane);
}
function h(tag,cls,html){const e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e}
function toggle(scope,label,path,cls=""){const b=h("button","toggle "+cls,`<i></i>${label}`);b.onclick=()=>setP(path,+S[path]?0:1);
  watch(scope,[path],()=>b.classList.toggle("on",!!+S[path]));return b}
function bigToggle(scope,label,path,cls=""){const b=h("button","bigtoggle "+cls,label);b.onclick=()=>setP(path,+S[path]?0:1);
  watch(scope,[path],()=>b.classList.toggle("on",!!+S[path]));return b}
function head(pane,title,...extra){const d=h("div","phead",`<h3>${title}</h3>`);extra.forEach(e=>d.appendChild(e));pane.appendChild(d);return d}

/* potenciómetro: arrastrar arriba/abajo, doble toque = valor por defecto */
let kid=0;
function knob(scope,{label,path,fmt,def,steps,onTap}){
  const el=h("div","kn"),id="kg"+(kid++);
  const isInt=TYPES[path]==="i";
  const norm=()=>isInt?(+S[path])/(steps-1):+S[path];
  el.innerHTML=`<h4>${label}</h4><svg viewBox="0 0 80 80"></svg><b></b>`;
  const svg=el.querySelector("svg");
  watch(scope,[path],()=>{const t=clamp(norm()),a=-135+270*t,[px,py]=polar(40,40,22,a),[qx,qy]=polar(40,40,10,a);
    svg.innerHTML=`<defs><radialGradient id="${id}" cx="40%" cy="30%" r="75%"><stop offset="0" stop-color="#3a3a40"/><stop offset=".55" stop-color="#18181b"/><stop offset="1" stop-color="#0b0b0c"/></radialGradient></defs>
      <path d="${arc(40,40,35,-135,135)}" stroke="#0b0b0d" stroke-width="7" fill="none" stroke-linecap="round"/>
      ${t>.003?`<path d="${arc(40,40,35,-135,a)}" stroke="var(--red)" stroke-width="5" fill="none" stroke-linecap="round" style="filter:drop-shadow(0 0 3px var(--red))"/>`:""}
      <circle cx="40" cy="41" r="27" fill="#000" opacity=".5"/><circle cx="40" cy="40" r="27" fill="url(#${id})" stroke="#2e2e34"/>
      <line x1="${qx.toFixed(1)}" y1="${qy.toFixed(1)}" x2="${px.toFixed(1)}" y2="${py.toFixed(1)}" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`;
    el.querySelector("b").textContent=fmt(S[path])});
  const setN=n=>setP(path,isInt?Math.round(n*(steps-1)):n);
  const d=def!=null?def:DEF[path];
  dragV(el,norm,setN,{start:()=>{hold(path);onTap&&onTap()},end:()=>release(path),dbl:()=>d!=null&&setP(path,d),travel:()=>isInt?steps*22:220,steps});
  return el;
}
function polar(cx,cy,r,deg){const a=(deg-90)*Math.PI/180;return[cx+r*Math.cos(a),cy+r*Math.sin(a)]}
function arc(cx,cy,r,a0,a1){const[x0,y0]=polar(cx,cy,r,a0),[x1,y1]=polar(cx,cy,r,a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1-a0>180?1:0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`}
function fitCanvas(cv){const r=cv.getBoundingClientRect();if(!r.width||!r.height)return null;const d=devicePixelRatio||1;
  const w=Math.round(r.width*d),hh=Math.round(r.height*d);if(cv.width!==w||cv.height!==hh){cv.width=w;cv.height=hh}
  const ctx=cv.getContext("2d");ctx.setTransform(d,0,0,d,0,0);return[ctx,r.width,r.height]}
function meterEl(cls=""){return h("div","meter "+cls,"<b></b><i></i>")}

/* ---------- Entrada ---------- */
function paneInput(s,pane){
  const b=s.base;
  const extra=[];
  if(s.kind==="ch")extra.push(toggle("pane","Corte de graves",b+"/preamp/hpon"));
  head(pane,"Entrada",...extra);
  const wrap=h("div","inbig");const big=h("div","bigmeter");const m=meterEl();big.appendChild(m);addMeter("pane",s.id,0,m);wrap.appendChild(big);
  const col=h("div","",null);col.style.cssText="display:flex;flex-direction:column;gap:16px";
  const ks=h("div","knobs");ks.style.justifyContent="flex-start";
  if(s.kind==="ch"){
    const ha="/headamp/"+String(s.headamp).padStart(3,"0");
    ks.appendChild(knob("pane",{label:"Ganancia",path:ha+"/gain",fmt:v=>X.sgn(-12+72*v,1),def:12/72}));
    ks.appendChild(knob("pane",{label:"Corte graves",path:b+"/preamp/hpf",fmt:v=>X.fmtHz(X.hpf(v)),def:.25}));
    const row=h("div","btnrow");row.appendChild(bigToggle("pane","+48V",ha+"/phantom","p48"));row.appendChild(bigToggle("pane","Ø Fase",b+"/preamp/invert"));
    col.appendChild(ks);col.appendChild(row);
    col.appendChild(h("p","hint","La ganancia corresponde al previo de la entrada local "+(s.headamp+1)+". Doble toque en un mando para volver a su valor por defecto."));
  }else{
    ks.appendChild(knob("pane",{label:"Trim",path:b+"/preamp/trim",fmt:v=>X.sgn(-18+36*v,1),def:.5}));
    const row=h("div","btnrow");row.appendChild(bigToggle("pane","Ø Fase",b+"/preamp/invert"));
    col.appendChild(ks);col.appendChild(row);
  }
  wrap.appendChild(col);pane.appendChild(wrap);
}

/* ---------- Puerta ---------- */
function paneGate(s,pane){
  const b=s.base+"/gate/";
  const modes=h("div","chips");GATE_MODES.forEach((n,i)=>{const c=h("button","",n);c.onclick=()=>setP(b+"mode",i);modes.appendChild(c)});
  watch("pane",[b+"mode"],()=>[...modes.children].forEach((c,i)=>c.classList.toggle("sel",i===+S[b+"mode"])));
  head(pane,"Puerta de ruido",modes,toggle("pane","Activa",b+"on"));
  const split=h("div","split");const g=h("div","graph","<canvas></canvas>");split.appendChild(g);
  const gr=h("div","grbar");const gm=meterEl("gr");gr.appendChild(h("small","","GR"));gr.appendChild(gm);split.appendChild(gr);addMeter("pane",s.id,1,gm);
  pane.appendChild(split);
  const ks=h("div","knobs");
  ks.appendChild(knob("pane",{label:"Umbral",path:b+"thr",fmt:v=>(-80+80*v).toFixed(1)+" dB"}));
  ks.appendChild(knob("pane",{label:"Rango",path:b+"range",fmt:v=>(3+57*v).toFixed(0)+" dB"}));
  ks.appendChild(knob("pane",{label:"Ataque",path:b+"attack",fmt:v=>X.fmtMs(120*v)}));
  ks.appendChild(knob("pane",{label:"Mantener",path:b+"hold",fmt:v=>X.fmtMs(X.hold(v))}));
  ks.appendChild(knob("pane",{label:"Liberación",path:b+"release",fmt:v=>X.fmtMs(X.rel(v))}));
  pane.appendChild(ks);
  const cv=g.querySelector("canvas");
  const draw=()=>{const thr=-80+80*S[b+"thr"],rng=3+57*S[b+"range"];
    transferGraph(cv,x=>x<thr?x-rng:x,thr,+S[b+"on"],s.id)};
  liveGraph=draw;
  dragH(g,()=>+S[b+"thr"],v=>setP(b+"thr",v),{start:()=>hold(b+"thr"),end:()=>release(b+"thr"),travel:()=>g.clientWidth});
}

/* ---------- Compresor ---------- */
function paneDyn(s,pane){
  const b=s.base+"/dyn/";
  head(pane,"Compresor",toggle("pane","Auto",b+"auto","warn"),toggle("pane","Activo",b+"on"));
  const split=h("div","split");const g=h("div","graph","<canvas></canvas>");split.appendChild(g);
  const gr=h("div","grbar");const gm=meterEl("gr");gr.appendChild(h("small","","GR"));gr.appendChild(gm);split.appendChild(gr);addMeter("pane",s.id,2,gm);
  pane.appendChild(split);
  const ks=h("div","knobs");
  ks.appendChild(knob("pane",{label:"Umbral",path:b+"thr",fmt:v=>(-60+60*v).toFixed(1)+" dB"}));
  ks.appendChild(knob("pane",{label:"Ratio",path:b+"ratio",steps:12,fmt:v=>RATIOS[v]+":1"}));
  ks.appendChild(knob("pane",{label:"Rodilla",path:b+"knee",fmt:v=>(5*v).toFixed(0)}));
  ks.appendChild(knob("pane",{label:"Ataque",path:b+"attack",fmt:v=>X.fmtMs(120*v)}));
  ks.appendChild(knob("pane",{label:"Liberación",path:b+"release",fmt:v=>X.fmtMs(X.rel(v))}));
  ks.appendChild(knob("pane",{label:"Ganancia",path:b+"mgain",fmt:v=>X.sgn(24*v,1)}));
  ks.appendChild(knob("pane",{label:"Mezcla",path:b+"mix",fmt:v=>Math.round(100*v)+" %",def:1}));
  pane.appendChild(ks);
  const cv=g.querySelector("canvas");
  liveGraph=()=>{const thr=-60+60*S[b+"thr"],r=RATIOS[+S[b+"ratio"]]||2,k=5*S[b+"knee"]*2,mg=24*S[b+"mgain"];
    transferGraph(cv,x=>{let y;if(2*(x-thr)<-k)y=x;else if(2*(x-thr)>k)y=thr+(x-thr)/r;else y=x+(1/r-1)*Math.pow(x-thr+k/2,2)/(2*k||1);return y+mg},thr,+S[b+"on"],s.id)};
  dragH(g,()=>+S[b+"thr"],v=>setP(b+"thr",v),{start:()=>hold(b+"thr"),end:()=>release(b+"thr"),travel:()=>g.clientWidth});
}

function transferGraph(cv,fn,thr,on,id){
  const r=fitCanvas(cv);if(!r)return;const[ctx,w,hh]=r;const lo=-80,span=-lo;
  const px=x=>(x-lo)/span*w,py=y=>hh-(clamp(y,lo-10,10)-lo)/span*hh;
  ctx.clearRect(0,0,w,hh);ctx.strokeStyle="#1d1d21";ctx.lineWidth=1;ctx.font="11px "+getComputedStyle(document.body).fontFamily;ctx.fillStyle="#55555c";
  for(let d=lo;d<=0;d+=10){ctx.beginPath();ctx.moveTo(px(d),0);ctx.lineTo(px(d),hh);ctx.moveTo(0,py(d));ctx.lineTo(w,py(d));ctx.stroke();if(d>lo)ctx.fillText(d,px(d)+3,hh-4)}
  ctx.strokeStyle="#2e2e34";ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(px(lo),py(lo));ctx.lineTo(px(0),py(0));ctx.stroke();ctx.setLineDash([]);
  ctx.strokeStyle="rgba(227,16,28,.5)";ctx.beginPath();ctx.moveTo(px(thr),0);ctx.lineTo(px(thr),hh);ctx.stroke();
  ctx.beginPath();for(let x=lo;x<=0;x+=.5){const y=fn(x);x===lo?ctx.moveTo(px(x),py(y)):ctx.lineTo(px(x),py(y))}
  ctx.strokeStyle=on?"#e3101c":"#55555c";ctx.lineWidth=3;ctx.shadowColor="#e3101c";ctx.shadowBlur=on?10:0;ctx.stroke();ctx.shadowBlur=0;
  const lv=M[id]?.[0]||0,ldb=lv>0?20*Math.log10(lv):-100;
  if(ldb>lo){ctx.fillStyle="#fff";ctx.beginPath();ctx.arc(px(ldb),py(fn(ldb)),6,0,7);ctx.fill()}
  ctx.fillStyle="#8b8b93";ctx.fillText("Umbral "+thr.toFixed(1)+" dB  ·  arrastra en el gráfico para moverlo",10,16);
}

/* ---------- EQ ---------- */
function biquad(type,f0,g,q,fs=48000){
  const A=Math.pow(10,g/40),w=2*Math.PI*Math.min(f0,fs*.45)/fs,cs=Math.cos(w),sn=Math.sin(w);
  let al=sn/(2*q),b0,b1,b2,a0,a1,a2;
  if(type===0||type===5){al=sn/(2*.707);const s=type===0?-1:1;
    b0=(1-s*cs)/2;b1=s*(1-s*cs);b2=b0;a0=1+al;a1=-2*cs;a2=1-al;if(type===0){b0=(1+cs)/2;b1=-(1+cs);b2=b0}}
  else if(type===1||type===4){al=sn/(2*Math.min(q,1.2));const sq=2*Math.sqrt(A)*al;
    if(type===1){b0=A*((A+1)-(A-1)*cs+sq);b1=2*A*((A-1)-(A+1)*cs);b2=A*((A+1)-(A-1)*cs-sq);a0=(A+1)+(A-1)*cs+sq;a1=-2*((A-1)+(A+1)*cs);a2=(A+1)+(A-1)*cs-sq}
    else{b0=A*((A+1)+(A-1)*cs+sq);b1=-2*A*((A-1)+(A+1)*cs);b2=A*((A+1)+(A-1)*cs-sq);a0=(A+1)-(A-1)*cs+sq;a1=2*((A-1)-(A+1)*cs);a2=(A+1)-(A-1)*cs-sq}}
  else{b0=1+al*A;b1=-2*cs;b2=1-al*A;a0=1+al/A;a1=-2*cs;a2=1-al/A}
  return[b0/a0,b1/a0,b2/a0,a1/a0,a2/a0];
}
function magDb(c,f,fs=48000){const w=2*Math.PI*f/fs,c1=Math.cos(w),c2=Math.cos(2*w),s1=Math.sin(w),s2=Math.sin(2*w);
  const nr=c[0]+c[1]*c1+c[2]*c2,ni=c[1]*s1+c[2]*s2,dr=1+c[3]*c1+c[4]*c2,di=c[3]*s1+c[4]*s2;
  return 10*Math.log10((nr*nr+ni*ni)/(dr*dr+di*di)+1e-20)}
function bandCoef(s,i){const p=`${s.base}/eq/${i}/`;return biquad(+S[p+"type"],X.hz(+S[p+"f"]),X.g(+S[p+"g"]),X.q(+S[p+"q"]))}
function eqCurve(s,n,only){
  const cs=[];for(let i=1;i<=s.eq;i++)if(only==null||only===i)cs.push(bandCoef(s,i));
  if(only==null&&s.kind==="ch"&&+S[s.base+"/preamp/hpon"])cs.push(biquad(0,X.hpf(+S[s.base+"/preamp/hpf"]),0,.707));
  const out=[];for(let k=0;k<n;k++){const x=k/(n-1),f=20*Math.pow(1000,x);let d=0;for(const c of cs)d+=magDb(c,f);out.push([x,d])}return out;
}
const hasGain=t=>t>=1&&t<=4;
function paneEq(s,pane){
  const b=s.base+"/eq/";
  const reset=h("button","btn small","Plano");reset.onclick=()=>{for(let i=1;i<=s.eq;i++)setP(`${b}${i}/g`,.5)};
  head(pane,"Ecualizador",reset,toggle("pane","Activo",b+"on"));
  const g=h("div","graph","<canvas></canvas>");g.style.minHeight="260px";pane.appendChild(g);
  const bands=h("div","chips bands");
  for(let i=1;i<=s.eq;i++){const c=h("button","",`${i}`);c.dataset.b=i;c.onclick=()=>{eqBand=i;renderPane(s)};bands.appendChild(c)}
  const types=h("div","chips");EQ_SHORT.forEach((n,t)=>{const c=h("button","",n);c.title=EQ_TYPES[t];c.onclick=()=>setP(`${b}${eqBand}/type`,t);types.appendChild(c)});
  const ctl=h("div","phead");ctl.appendChild(h("span","",`<span style="color:var(--muted);font-size:13px">Banda</span>`));ctl.appendChild(bands);
  const sp=h("span","");sp.style.flex="1";ctl.appendChild(sp);ctl.appendChild(types);pane.appendChild(ctl);
  const ks=h("div","knobs");const bp=`${b}${eqBand}/`;
  ks.appendChild(knob("pane",{label:"Frecuencia",path:bp+"f",fmt:v=>X.fmtHz(X.hz(v))}));
  const kg=knob("pane",{label:"Ganancia",path:bp+"g",fmt:v=>X.sgn(X.g(v),1),def:.5});ks.appendChild(kg);
  const kq=knob("pane",{label:"Q",path:bp+"q",fmt:v=>X.q(v).toFixed(1),def:.4648});ks.appendChild(kq);
  pane.appendChild(ks);
  watch("pane",[bp+"type"],()=>{const t=+S[bp+"type"];[...types.children].forEach((c,i)=>c.classList.toggle("sel",i===t));
    kg.style.opacity=hasGain(t)?1:.35;kq.style.opacity=t===0||t===5?.35:1;
    [...bands.children].forEach(c=>c.classList.toggle("sel",+c.dataset.b===eqBand))});
  const cv=g.querySelector("canvas");
  const paths=[b+"on",s.base+"/preamp/hpon",s.base+"/preamp/hpf"];for(let i=1;i<=s.eq;i++)for(const k of["type","f","g","q"])paths.push(`${b}${i}/${k}`);
  const draw=()=>drawEq(cv,s);
  watch("pane",paths,()=>requestAnimationFrame(draw));
  window.addEventListener("resize",draw,{once:true});
  eqTouch(g,s);
}
const EQ_COL=["#ff3b45","#ffb020","#34d27b","#1fc2d4","#2f7bf2","#c23be0"];
function eqXY(s,i,w,hh){const p=`${s.base}/eq/${i}/`,t=+S[p+"type"];return[X.hzN(X.hz(+S[p+"f"]))*w,hasGain(t)?hh/2-X.g(+S[p+"g"])/18*(hh/2):hh/2]}
function drawEq(cv,s){
  const r=fitCanvas(cv);if(!r)return;const[ctx,w,hh]=r,on=+S[s.base+"/eq/on"];
  ctx.clearRect(0,0,w,hh);ctx.lineWidth=1;ctx.font="11px "+getComputedStyle(document.body).fontFamily;
  for(const f of[20,50,100,200,500,1000,2000,5000,10000,20000]){const x=X.hzN(f)*w;ctx.strokeStyle="#1d1d21";ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,hh);ctx.stroke();
    ctx.fillStyle="#55555c";ctx.fillText(f>=1000?f/1000+"k":f,x+3,hh-5)}
  for(const d of[-15,-10,-5,0,5,10,15]){const y=hh/2-d/18*(hh/2);ctx.strokeStyle=d?"#1d1d21":"#2e2e34";ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();
    if(d){ctx.fillStyle="#55555c";ctx.fillText((d>0?"+":"")+d,4,y-3)}}
  const Y=d=>hh/2-clamp(d,-20,20)/18*(hh/2);
  for(let i=1;i<=s.eq;i++){const pts=eqCurve(s,160,i);ctx.beginPath();pts.forEach(([x,d],k)=>k?ctx.lineTo(x*w,Y(d)):ctx.moveTo(x*w,Y(d)));
    ctx.strokeStyle=EQ_COL[i-1]+(i===eqBand?"aa":"44");ctx.lineWidth=i===eqBand?1.6:1;ctx.stroke()}
  const pts=eqCurve(s,240);
  ctx.beginPath();ctx.moveTo(0,hh/2);pts.forEach(([x,d])=>ctx.lineTo(x*w,Y(d)));ctx.lineTo(w,hh/2);ctx.closePath();
  const gr=ctx.createLinearGradient(0,0,0,hh);gr.addColorStop(0,on?"rgba(227,16,28,.35)":"rgba(120,120,130,.2)");gr.addColorStop(.5,"rgba(227,16,28,.04)");gr.addColorStop(1,on?"rgba(227,16,28,.35)":"rgba(120,120,130,.2)");
  ctx.fillStyle=gr;ctx.fill();
  ctx.beginPath();pts.forEach(([x,d],k)=>k?ctx.lineTo(x*w,Y(d)):ctx.moveTo(x*w,Y(d)));
  ctx.strokeStyle=on?"#ff2a36":"#6a6a72";ctx.lineWidth=3;ctx.shadowColor="#e3101c";ctx.shadowBlur=on?12:0;ctx.stroke();ctx.shadowBlur=0;
  for(let i=1;i<=s.eq;i++){const[x,y]=eqXY(s,i,w,hh),sel=i===eqBand;
    ctx.beginPath();ctx.arc(x,y,sel?15:12,0,7);ctx.fillStyle=sel?EQ_COL[i-1]:"#111";ctx.fill();ctx.lineWidth=2.5;ctx.strokeStyle=EQ_COL[i-1];ctx.stroke();
    ctx.fillStyle=sel?"#000":"#fff";ctx.font="bold 13px "+getComputedStyle(document.body).fontFamily;ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(i,x,y+1);
    ctx.textAlign="left";ctx.textBaseline="alphabetic";ctx.font="11px "+getComputedStyle(document.body).fontFamily}
  if(s.kind==="ch"&&+S[s.base+"/preamp/hpon"]){const x=X.hzN(X.hpf(+S[s.base+"/preamp/hpf"]))*w;ctx.fillStyle="#8b8b93";ctx.fillText("Corte "+X.fmtHz(X.hpf(+S[s.base+"/preamp/hpf"])),x+4,14)}
}
function eqTouch(g,s){
  const pts=new Map();let band=null,start=null,pinch=null;
  g.addEventListener("pointerdown",e=>{
    try{g.setPointerCapture(e.pointerId)}catch(_){}
    pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    const r=g.getBoundingClientRect();
    if(pts.size===1){
      let best=1,bd=1e9;for(let i=1;i<=s.eq;i++){const[x,y]=eqXY(s,i,r.width,r.height);const d=Math.hypot(x-(e.clientX-r.left),(y-(e.clientY-r.top))*.6);if(d<bd){bd=d;best=i}}
      if(best!==eqBand){eqBand=best;renderPane(s);return}
      band=best;const p=`${s.base}/eq/${band}/`;start={x:e.clientX,y:e.clientY,f:+S[p+"f"],g:+S[p+"g"]};hold(p+"f");hold(p+"g");
    }else if(pts.size===2&&band){const a=[...pts.values()];pinch={d:Math.abs(a[0].x-a[1].x)+1,q:+S[`${s.base}/eq/${band}/q`]};start=null}
    e.preventDefault();
  });
  g.addEventListener("pointermove",e=>{if(!pts.has(e.pointerId)||!band)return;pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    const r=g.getBoundingClientRect(),p=`${s.base}/eq/${band}/`;
    if(pinch&&pts.size>=2){const a=[...pts.values()],d=Math.abs(a[0].x-a[1].x)+1;setP(p+"q",clamp(pinch.q+Math.log(d/pinch.d)*.35));return}
    if(!start)return;
    setP(p+"f",clamp(start.f+(e.clientX-start.x)/r.width));
    if(hasGain(+S[p+"type"]))setP(p+"g",clamp(start.g-(e.clientY-start.y)/(r.height/2)*18/30));
  });
  const up=e=>{pts.delete(e.pointerId);if(!pts.size&&band){const p=`${s.base}/eq/${band}/`;release(p+"f");release(p+"g");band=null;start=null;pinch=null}};
  g.addEventListener("pointerup",up);g.addEventListener("pointercancel",up);
  g.addEventListener("wheel",e=>{const p=`${s.base}/eq/${eqBand}/q`;setP(p,clamp(+S[p]+(e.deltaY>0?.02:-.02)));e.preventDefault()},{passive:false});
}

/* ---------- Envíos ---------- */
function paneSends(s,pane){
  head(pane,"Envíos a buses");
  const grid=h("div","sends");
  for(let n=1;n<=16;n++){
    const bs=busStrip(n),lp=`${s.base}/mix/${pad2(n)}/level`,op=`${s.base}/mix/${pad2(n)}/on`;
    const row=h("div","send",`<div class="who"><small>Bus ${n}</small><span></span></div><div class="hslider"><b></b></div><div class="val"></div><button class="on">ON</button>`);
    watch("pane",[lp,op,bs.base+"/config/name",bs.base+"/config/color"],()=>{
      row.querySelector(".who").style.setProperty("--c",colorOf(bs).c);row.querySelector(".who span").textContent=S[bs.base+"/config/name"]||"Bus "+n;
      row.querySelector(".hslider b").style.width=(+S[lp]*100)+"%";row.querySelector(".val").textContent=X.fmtDb(+S[lp]);
      row.querySelector(".on").classList.toggle("on",!!+S[op]);row.classList.toggle("off",!+S[op])});
    const sl=row.querySelector(".hslider");
    dragH(sl,()=>+S[lp],v=>setP(lp,v),{start:()=>hold(lp),end:()=>release(lp),dbl:()=>setP(lp,.75),travel:()=>sl.clientWidth});
    row.querySelector(".on").onclick=()=>setP(op,+S[op]?0:1);
    grid.appendChild(row);
  }
  pane.appendChild(grid);
}

/* ---------- Nombre y color ---------- */
function paneCfg(s,pane){
  head(pane,"Nombre y color");
  const np=s.base+"/config/name",cp=s.base+"/config/color";
  const inp=h("input","field");inp.maxLength=12;inp.placeholder=s.label;inp.style.maxWidth="420px";inp.value=S[np]||"";
  inp.oninput=()=>setP(np,inp.value);pane.appendChild(inp);
  pane.appendChild(h("p","hint","Máximo 12 caracteres (límite de la mesa)."));
  const cols=h("div","colors");
  for(let i=0;i<16;i++){const c=COLORS[i%8],inv=i>=8;const b=h("button","",COLOR_NAMES[i%8].split(" ")[0]);
    b.style.cssText=inv?`background:${c};color:#000`:`background:#0b0b0d;color:${i%8?c:"#8b8b93"};box-shadow:inset 0 5px 0 ${c}`;
    b.onclick=()=>setP(cp,i);cols.appendChild(b)}
  watch("pane",[cp],()=>[...cols.children].forEach((b,i)=>b.classList.toggle("sel",i===+S[cp])));
  pane.appendChild(h("h3","",'<span style="color:var(--muted);font-size:13px;font-weight:600">COLOR (fila de abajo: invertido)</span>'));pane.appendChild(cols);
}

/* ================================================================ hojas */
function openSheet(id){$(id).classList.add("show")}
function closeSheets(){document.querySelectorAll(".sheet.show").forEach(s=>s.classList.remove("show"))}
document.querySelectorAll(".sheet").forEach(sh=>sh.addEventListener("pointerdown",e=>{if(e.target===sh||e.target.dataset.close!=null)closeSheets()}));

let connMode="demo";
function openConn(){connMode=status.mode&&status.mode!=="offline"?status.mode:"x32";$("#ip").value=status.ip||status.lastIp||"";paintConn();openSheet("#connSheet")}
function paintConn(){document.querySelectorAll(".model").forEach(b=>b.classList.toggle("sel",b.dataset.mode===connMode));$("#ipBox").style.display=connMode==="x32"?"":"none"}
document.querySelectorAll(".model").forEach(b=>b.onclick=()=>{connMode=b.dataset.mode;paintConn()});
$("#connBtn").onclick=openConn;
$("#connectBtn").onclick=()=>{$("#connectBtn").textContent="Conectando…";send({t:"connect",mode:connMode,ip:$("#ip").value})};
$("#findBtn").onclick=()=>{$("#found").innerHTML='<div class="empty">Buscando mesas en la red…</div>';send({t:"discover"})};

function openMix(){
  const list=$("#mixList");list.innerHTML="";
  const mk=(n,label,sub,c)=>{const b=h("button",n?"":"lr",`${esc(label)}<small>${esc(sub)}</small>`);b.style.setProperty("--c",c);b.classList.toggle("sel",n===sendBus);
    b.onclick=()=>{sendBus=n;store("sendBus",n);closeSheets();renderDesk()};list.appendChild(b)};
  mk(0,"Main LR","Mezcla principal","var(--red)");
  for(let n=1;n<=16;n++){const s=busStrip(n);mk(n,"Bus "+n,S[s.base+"/config/name"]||"—",colorOf(s).c)}
  openSheet("#mixSheet");
}
$("#mixSel").onclick=openMix;

function renderScenes(){
  const l=$("#sceneList");l.innerHTML="";
  if(!scenes.length){l.innerHTML='<div class="empty">Aún no hay escenas guardadas.</div>';return}
  scenes.forEach((sc,i)=>{const it=h("div","item",`<span>${esc(sc.name)}<small>${esc(sc.time||"")}</small></span>`);
    const ld=h("button","btn small red","Cargar"),del=h("button","btn small","✕");
    ld.onclick=()=>{if(ld.dataset.c){send({t:"sceneLoad",i});closeSheets();toast(`Escena «${sc.name}» cargada`)}else{ld.dataset.c=1;ld.textContent="¿Seguro?";setTimeout(()=>{delete ld.dataset.c;ld.textContent="Cargar"},2500)}};
    del.onclick=()=>{if(del.dataset.c)send({t:"sceneDelete",i});else{del.dataset.c=1;del.textContent="Borrar";setTimeout(()=>{delete del.dataset.c;del.textContent="✕"},2500)}};
    it.appendChild(ld);it.appendChild(del);l.appendChild(it)});
}
$("#scenesBtn").onclick=()=>{renderScenes();openSheet("#sceneSheet")};
$("#sceneSave").onclick=()=>{send({t:"sceneSave",name:$("#sceneName").value});$("#sceneName").value="";toast("Escena guardada")};

function openLayerEditor(){
  const box=$("#layerPick");box.innerHTML="";
  const groups=[["Canales",STRIPS.filter(s=>s.kind==="ch")],["Aux · FX",STRIPS.filter(s=>s.kind==="auxin"||s.kind==="fxrtn")],
    ["Buses · Matrices · Main",STRIPS.filter(s=>["bus","mtx","main"].includes(s.kind))],["DCA",STRIPS.filter(s=>s.kind==="dca")]];
  for(const[t,list]of groups){box.appendChild(h("h3","",t));const g=h("div","pick");
    for(const s of list){const b=h("button","",esc(S[s.base+"/config/name"]||s.label));b.style.setProperty("--c",colorOf(s).c);
      const paint=()=>{const i=layout.custom.indexOf(s.id);b.classList.toggle("sel",i>=0);b.title=s.label};paint();
      b.onclick=()=>{const i=layout.custom.indexOf(s.id);i>=0?layout.custom.splice(i,1):layout.custom.push(s.id);paint()};g.appendChild(b)}
    box.appendChild(g)}
  openSheet("#layerSheet");
}
$("#layerClear").onclick=()=>{layout.custom=[];openLayerEditor()};
$("#layerDone").onclick=()=>{send({t:"layout",v:layout});closeSheets();layer="custom";store("layer",layer);renderLayers();renderDesk()};

$("#dClose").onclick=closeDetail;$("#dPrev").onclick=()=>stepDetail(-1);$("#dNext").onclick=()=>stepDetail(1);
document.addEventListener("keydown",e=>{if(e.target.tagName==="INPUT")return;
  if(e.key==="Escape"){closeSheets();closeDetail()}
  if(detailId&&(e.key==="ArrowDown"||e.key==="ArrowUp")){stepDetail(e.key==="ArrowDown"?1:-1);e.preventDefault()}});

function toast(msg){const t=$("#toast");t.textContent=msg;t.classList.add("show");clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove("show"),4000)}

/* ================================================================ conexión con el servidor MBMix */
function send(o){if(ws&&ws.readyState===1)ws.send(JSON.stringify(o))}
function connectWs(){
  ws=new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host+"/ws");
  ws.onopen=()=>{wsTries=0};
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    switch(m.t){
      case"m":M=m.v;break;
      case"upd":{const ch=[];for(const p in m.v)if(!active.has(p)){S[p]=m.v[p];ch.push(p)}notify(ch);break}
      case"state":S=m.v;notifyAll();break;
      case"model":STRIPS=m.strips;TYPES=m.types;DEF=m.defaults;BY={};STRIPS.forEach(s=>BY[s.id]=s);break;
      case"status":{const first=!status.t;status=m;const d=$("#connDot");d.className="conn-dot"+(m.mode==="demo"?" demo":m.connected?" on":"");
        $("#lanUrl").textContent=m.url;$("#connInfo").textContent=m.mode==="offline"?"Elige tu mesa. Con «Demo» puedes probarlo todo sin mesa.":
          m.connected?`Conectado: ${m.info}`:`Sin respuesta de la mesa${m.ip?" ("+m.ip+")":""}. Reintentando…`;
        if(first){renderLayers();renderDesk();if(m.mode==="offline")openConn()}
        else if(m.mode==="x32"&&!m.connected)toast("Se ha perdido la conexión con la mesa");break}
      case"connectResult":$("#connectBtn").textContent="Conectar";if(m.ok){closeSheets();toast("Conectado")}else toast(m.msg);break;
      case"found":{const f=$("#found");f.innerHTML="";if(!m.v.length)f.innerHTML='<div class="empty">No se ha encontrado ninguna mesa. Escribe su IP (en la mesa: Setup → Network).</div>';
        m.v.forEach(x=>{const b=h("button","",`${esc(x.name)} <small>${esc(x.model)} · ${esc(x.ip)} · v${esc(x.version)}</small>`);b.onclick=()=>{$("#ip").value=x.ip;connMode="x32";paintConn()};f.appendChild(b)});break}
      case"scenes":scenes=m.v;renderScenes();break;
      case"layout":layout=Object.assign({custom:[]},m.v||{});if(!Array.isArray(layout.custom))layout.custom=[];if(layer==="custom"&&status.t)renderDesk();break;
    }};
  ws.onclose=()=>{ws=null;$("#connDot").className="conn-dot";if(wsTries++>1)toast("Sin conexión con el ordenador de MBMix. Reintentando…");setTimeout(connectWs,Math.min(5000,500*wsTries))};
}
window.addEventListener("resize",()=>notifyAll());
requestAnimationFrame(meterLoop);
connectWs();
