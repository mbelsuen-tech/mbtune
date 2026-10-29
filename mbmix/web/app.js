"use strict";
/* MB Soundtools · MBMix — interfaz táctil (estilo Mixing Station) para Behringer WING */

const $=s=>document.querySelector(s);
const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
const range=(a,b)=>Array.from({length:b-a+1},(_,i)=>a+i);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

/* ================================================================ estado */
let STRIPS=[],BY={},SPEC={},S={},M={},status={},scenes=[],layout={custom:[]};
let ws=null,wsTries=0;
let layer=load("layer","in1"),sendBus=+load("sendBus",0),detailId=null,detailTab=null,eqBand=null;
const active=new Set();          // parámetros que se están moviendo con el dedo (no se pisan con lo que llega)

function load(k,d){try{const v=localStorage.getItem("mbmix."+k);return v==null?d:v}catch(e){return d}}
function store(k,v){try{localStorage.setItem("mbmix."+k,v)}catch(e){}}

/* ---- observadores: cada control se redibuja cuando cambia su parámetro ---- */
const W=new Map(),SCOPES=new Map();let METERS=[];
function watch(scope,keys,fn){const e={fn,keys};for(const p of keys){if(!W.has(p))W.set(p,new Set());W.get(p).add(e)}
  if(!SCOPES.has(scope))SCOPES.set(scope,[]);SCOPES.get(scope).push(e);fn();return e}
function unwatch(scope){for(const e of SCOPES.get(scope)||[])for(const p of e.keys)W.get(p)?.delete(e);SCOPES.delete(scope);METERS=METERS.filter(m=>m.scope!==scope)}
function notify(keys){const run=new Set();for(const p of keys)W.get(p)?.forEach(e=>run.add(e));run.forEach(e=>e.fn())}
function notifyAll(){SCOPES.forEach(l=>l.forEach(e=>e.fn()))}

function setP(k,v){const s=SPEC[k];if(!s)return;if(s[0]==="n")v=Math.round(clamp(+v,s[1],s[2])*100)/100;S[k]=v;send({t:"set",p:k,v});notify([k])}
const tog=k=>setP(k,+S[k]?0:1);
function hold(k){active.add(k)} function release(k){setTimeout(()=>active.delete(k),350)}

/* ================================================================ valores: posición 0..1 <-> unidades reales */
const FD={
  pos(d){return d>=-10?(d+30)/40:d>=-30?(d+50)/80:d>=-60?(d+70)/160:d>-90?(d+90)/480:0},
  db(p){return p>=.5?p*40-30:p>=.25?p*80-50:p>=.0625?p*160-70:p>0?p*480-90:-144},
};
function norm(k){const s=SPEC[k],v=+S[k];if(!s)return 0;
  switch(s[3]){case"fdr":return FD.pos(v);case"log":return clamp(Math.log(v/s[1])/Math.log(s[2]/s[1]));
    case"log1":return clamp(Math.log1p(v)/Math.log1p(s[2]));default:return clamp((v-s[1])/(s[2]-s[1]))}}
function denorm(k,n){const s=SPEC[k];n=clamp(n);
  switch(s[3]){case"fdr":return FD.db(n);case"log":return s[1]*Math.pow(s[2]/s[1],n);case"log1":return Math.expm1(n*Math.log1p(s[2]));
    default:return s[1]+n*(s[2]-s[1])}}
const setN=(k,n)=>setP(k,denorm(k,n));

const F={
  db(d){d=+d;return d<=-89.5?"-∞":(d>0?"+":"")+d.toFixed(Math.abs(d)>=10?0:1)},
  dbu(d){return F.db(d)+(d<=-89.5?"":" dB")},
  hz(h){h=+h;return h<1000?Math.round(h)+" Hz":(h/1000).toFixed(h<10000?2:1)+" kHz"},
  ms(m){m=+m;return m<10?m.toFixed(1)+" ms":m<1000?Math.round(m)+" ms":(m/1000).toFixed(2)+" s"},
  pan(p){p=Math.round(+p);return p===0?"Centro":p<0?"Izq "+(-p):"Der "+p},
};

/* colores de la WING (0 = sin color) */
const COLORS=["#4a4a52","#7b8fb0","#2f7bf2","#3346c8","#1fc2d4","#2fbf5b","#8fae2a","#f2c230","#ff8a1f","#e3101c","#ff6b5a","#ff5fb0","#b06ad8"];
const COLOR_NAMES=["Ninguno","Gris azul","Azul","Azul oscuro","Turquesa","Verde","Oliva","Amarillo","Naranja","Rojo","Coral","Rosa","Malva"];

/* ================================================================ tiras */
const nameOf=s=>S[s.id+".name"]||s.label;
const colorOf=s=>COLORS[+S[s.id+".color"]||0]||COLORS[0];
const faderKey=(s,bus)=>bus&&s.sends?`${s.id}.send.${bus}.lvl`:s.id+".fader";
const busStrip=n=>BY["bus"+n];
const bandName=b=>b==="l"?"Graves":b==="h"?"Agudos":"Medios "+b;

const LAYERS=[
  {id:"in1",name:"1–16",ids:()=>range(1,16).map(n=>"ch"+n)},
  {id:"in2",name:"17–32",ids:()=>range(17,32).map(n=>"ch"+n)},
  {id:"in3",name:"33–40",ids:()=>range(33,40).map(n=>"ch"+n)},
  {id:"aux",name:"Aux",ids:()=>range(1,8).map(n=>"aux"+n)},
  {id:"bus",name:"Buses",ids:()=>range(1,16).map(n=>"bus"+n)},
  {id:"out",name:"Salidas",ids:()=>[...range(1,4).map(n=>"main"+n),...range(1,8).map(n=>"mtx"+n)]},
  {id:"dca",name:"DCA",ids:()=>range(1,16).map(n=>"dca"+n)},
  {id:"custom",name:"Mi vista",ids:()=>(layout.custom||[]).filter(id=>BY[id])},
];

function stripKeys(s,bus){
  const k=s.id+".",p=[k+"name",k+"color",faderKey(s,bus),k+"mute"];
  if(s.solo)p.push(k+"solo");if(s.pan)p.push(k+"pan");
  if(bus&&s.sends)p.push(`${k}send.${bus}.on`,`bus${bus}.color`);
  if(s.eq.length){p.push(k+"eq.on");for(const b of s.eq)for(const x of["g","f","q"])p.push(`${k}eq.${b}.${x}`)}
  if(s.inp)p.push(k+"lc",k+"lcf");
  if(s.gate)p.push(k+"gate.on");if(s.dyn)p.push(k+"dyn.on");
  return p;
}

const SCALE=[10,5,0,-5,-10,-20,-30,-40,-50,-60,-90];
const capPos=v=>`calc(22px + (100% - 44px) * ${(1-v).toFixed(4)})`;
const MUTE_ICON=`<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>`;

function makeStrip(scope,s,{bus=0,detail=false}={}){
  const el=document.createElement("div");
  const sendMode=!!(bus&&s.sends);
  el.className="strip"+(sendMode?" sendmode":"");el.dataset.id=s.id;
  const num=s.kind==="ch"?String(+s.id.slice(2)):s.label;
  el.innerHTML=`<button class="scribble" title="Abrir el canal"><span class="num">${esc(num)}</span><span class="nm"></span></button>
    <div class="proc${s.eq.length||s.dyn||s.gate?"":" none"}"><canvas></canvas><div class="tags"></div></div>
    <div class="pan${s.pan?"":" none"}" title="Panorama (doble toque: centro)"><b></b><span></span></div>
    <button class="sendon">ENVÍO</button>
    <div class="ms"><button class="mute" title="Silenciar">${MUTE_ICON}<small>MUTE</small></button><button class="solo" title="Escuchar solo este canal">SOLO</button></div>
    <div class="fader"><div class="scale">${SCALE.map(d=>`<span class="${d===0?"zero":""}" style="top:${capPos(FD.pos(d))}">${d===-90?"-∞":d>0?"+"+d:d}</span>`).join("")}</div>
      <div class="track"><div class="fill"></div></div><div class="meter"><b></b><i></i></div><div class="fader-cap"></div></div>
    <div class="db"></div>`;
  const q=c=>el.querySelector(c),k=s.id+".";
  const fk=faderKey(s,bus),sendOn=sendMode?`${k}send.${bus}.on`:null;
  const cv=q(".proc canvas");

  watch(scope,stripKeys(s,bus),()=>{
    el.style.setProperty("--c",colorOf(s));q(".nm").textContent=nameOf(s);
    const v=norm(fk);q(".fader-cap").style.top=capPos(v);q(".fill").style.height=`calc((100% - 44px) * ${v.toFixed(4)})`;
    q(".db").textContent=F.db(S[fk]);
    const muted=!!+S[k+"mute"];el.classList.toggle("muted",muted);q(".mute").classList.toggle("on",muted);
    if(s.solo)q(".solo").classList.toggle("on",!!+S[k+"solo"]);
    if(s.pan){const p=+S[k+"pan"]/200+.5,b=q(".pan b");b.style.left=Math.min(50,p*100)+"%";b.style.width=Math.max(1.5,Math.abs(p-.5)*100)+"%";
      const r=Math.round(+S[k+"pan"]);q(".pan span").textContent=r===0?"C":r<0?"I"+(-r):"D"+r}
    if(sendMode){const so=+S[sendOn];q(".sendon").classList.toggle("on",!!so);el.classList.toggle("sendoff",!so);
      el.style.setProperty("--bus",colorOf(busStrip(bus)))}
    drawProc(s,cv,q(".tags"));
  });
  if(s.id===detailId&&!detail)el.classList.add("selected");

  const fader=q(".fader");
  dragV(fader,()=>norm(fk),v=>setN(fk,v),{start:()=>hold(fk),end:()=>release(fk),dbl:()=>setP(fk,0),travel:()=>fader.clientHeight-44});
  q(".mute").onclick=()=>tog(k+"mute");
  q(".solo").onclick=()=>s.solo&&tog(k+"solo");
  q(".sendon").onclick=()=>sendOn&&tog(sendOn);
  if(s.pan){const pan=q(".pan");dragH(pan,()=>norm(k+"pan"),v=>setN(k+"pan",v),{start:()=>hold(k+"pan"),end:()=>release(k+"pan"),dbl:()=>setP(k+"pan",0),travel:()=>pan.clientWidth*1.5})}
  if(!detail){q(".scribble").onclick=()=>openDetail(s.id);q(".proc").onclick=e=>openDetail(s.id,e.target.dataset?.tab||(s.eq.length?"eq":"dyn"))}
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
    ctx.strokeStyle="#222";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();
    ctx.beginPath();pts.forEach(([x,d],i)=>{const X_=x*w,Y=h/2-clamp(d,-18,18)/18*(h/2-3);i?ctx.lineTo(X_,Y):ctx.moveTo(X_,Y)});
    const c=colorOf(s);ctx.strokeStyle=on?(c===COLORS[0]?"#e3101c":c):"#3a3a40";ctx.lineWidth=1.6;ctx.stroke()});
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
    const fine=e.shiftKey||e.altKey?.15:1;set(clamp(v0+(axis(e)-p0)/Math.max(40,travel())*fine))});
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
  requestAnimationFrame(meterLoop);
}

/* ================================================================ mesa */
function renderLayers(){
  const nav=$("#layers");nav.innerHTML="";
  for(const L of LAYERS){const b=document.createElement("button");b.textContent=L.name;b.classList.toggle("sel",L.id===layer);
    b.onclick=()=>{if(L.id==="custom"&&(layer==="custom"||!(layout.custom||[]).length)){openLayerEditor();return}layer=L.id;store("layer",layer);renderLayers();renderDesk()};
    nav.appendChild(b)}
}
function renderDesk(){
  unwatch("desk");unwatch("master");
  const box=$("#strips");box.innerHTML="";
  const L=LAYERS.find(l=>l.id===layer)||LAYERS[0];
  for(const id of L.ids())box.appendChild(makeStrip("desk",BY[id],{bus:sendBus}));
  if(layer==="dca")box.appendChild(muteGroups());
  if(layer==="custom"){const t=document.createElement("button");t.className="strip";
    t.innerHTML=`<div style="margin:auto;text-align:center;color:var(--muted);font-size:13px;line-height:1.5"><b style="font-size:30px;color:var(--text)">＋</b><br>Elegir<br>canales</div>`;
    t.onclick=openLayerEditor;box.appendChild(t)}
  box.scrollLeft=0;
  const ms=sendBus?busStrip(sendBus):BY.main1;
  const mbox=$("#master");mbox.innerHTML="";mbox.appendChild(makeStrip("master",ms));
  const sel=$("#mixSel");sel.classList.toggle("busmode",!!sendBus);
  watch("desk",[ms.id+".name",ms.id+".color"],()=>{
    $("#mixName").textContent=sendBus?`Bus ${sendBus} · ${nameOf(ms)}`:"Principal";
    sel.style.setProperty("--bus",sendBus?colorOf(ms):"var(--red)");
    sel.querySelector("small").textContent=sendBus?"Mezcla de monitor":"Estás mezclando";
  });
}
function muteGroups(){
  const d=document.createElement("div");d.className="mgroups";d.innerHTML="<h4>Grupos de mute</h4>";
  for(let g=1;g<=8;g++){const b=document.createElement("button"),k=`mg${g}.mute`,nk=`mg${g}.name`;
    b.onclick=()=>tog(k);watch("desk",[k,nk],()=>{b.textContent=S[nk]||"Grupo "+g;b.classList.toggle("on",!!+S[k])});d.appendChild(b)}
  return d;
}

/* ================================================================ vista de canal */
function tabsFor(s){
  const t=[],k=s.id+".";
  if(s.inp)t.push(["in","Entrada",k+"lc"]);
  if(s.gate)t.push(["gate","Puerta",k+"gate.on"]);
  if(s.dyn)t.push(["dyn","Compresor",k+"dyn.on"]);
  if(s.eq.length)t.push(["eq","Ecualizador",k+"eq.on"]);
  if(s.sends)t.push(["sends","Envíos",null]);
  t.push(["cfg","Nombre y color",null]);
  return t;
}
function openDetail(id,tab){
  const s=BY[id];if(!s)return;
  const tabs=tabsFor(s);
  if(id!==detailId)eqBand=null;
  detailId=id;detailTab=tab&&tabs.some(t=>t[0]===tab)?tab:(tabs.some(t=>t[0]===detailTab)?detailTab:tabs[0][0]);
  unwatch("dhead");unwatch("dstrip");
  $("#detail").classList.add("show");
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
    svg.innerHTML=`<defs><radialGradient id="${id}" cx="40%" cy="30%" r="75%"><stop offset="0" stop-color="#3a3a40"/><stop offset=".55" stop-color="#18181b"/><stop offset="1" stop-color="#0b0b0c"/></radialGradient></defs>
      <path d="${arc(40,40,35,-135,135)}" stroke="#0b0b0d" stroke-width="7" fill="none" stroke-linecap="round"/>
      ${t>.003?`<path d="${arc(40,40,35,-135,a)}" stroke="var(--red)" stroke-width="5" fill="none" stroke-linecap="round" style="filter:drop-shadow(0 0 3px var(--red))"/>`:""}
      <circle cx="40" cy="41" r="27" fill="#000" opacity=".5"/><circle cx="40" cy="40" r="27" fill="url(#${id})" stroke="#2e2e34"/>
      <line x1="${qx.toFixed(1)}" y1="${qy.toFixed(1)}" x2="${px.toFixed(1)}" y2="${py.toFixed(1)}" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`;
    el.querySelector("b").textContent=fmt(S[key])});
  const d=def!=null?def:SPEC[key][4];
  dragV(el,()=>norm(key),n=>setN(key,n),{start:()=>hold(key),end:()=>release(key),dbl:()=>setP(key,d),travel:()=>220});
  return el;
}
function polar(cx,cy,r,deg){const a=(deg-90)*Math.PI/180;return[cx+r*Math.cos(a),cy+r*Math.sin(a)]}
function arc(cx,cy,r,a0,a1){const[x0,y0]=polar(cx,cy,r,a0),[x1,y1]=polar(cx,cy,r,a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1-a0>180?1:0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`}
function fitCanvas(cv){const r=cv.getBoundingClientRect();if(!r.width||!r.height)return null;const d=devicePixelRatio||1;
  const w=Math.round(r.width*d),hh=Math.round(r.height*d);if(cv.width!==w||cv.height!==hh){cv.width=w;cv.height=hh}
  const ctx=cv.getContext("2d");ctx.setTransform(d,0,0,d,0,0);return[ctx,r.width,r.height]}
const meterEl=(cls="")=>h("div","meter "+cls,"<b></b><i></i>");
const font=()=>getComputedStyle(document.body).fontFamily;

/* ---------- Entrada ---------- */
function paneInput(s,pane){
  const k=s.id+".";
  head(pane,"Entrada","Cuánta señal entra en el canal. Sube la ganancia hasta que el vúmetro se mueva bien sin llegar al rojo.");
  const wrap=h("div","inbig");const big=h("div","bigmeter");const m=meterEl();big.appendChild(m);addMeter("pane",s.id,0,m);wrap.appendChild(big);
  const col=h("div","incol");
  const ks=h("div","knobs left");
  ks.appendChild(knob("pane",{label:"Ganancia",key:k+"gain",fmt:F.dbu}));
  ks.appendChild(knob("pane",{label:"Ajuste fino",key:k+"trim",fmt:F.dbu}));
  ks.appendChild(knob("pane",{label:"Quitar graves por debajo de",key:k+"lcf",fmt:F.hz}));
  const row=h("div","btnrow");
  row.appendChild(bigToggle("pane","Phantom 48V",k+"p48","p48"));
  row.appendChild(bigToggle("pane","Quitar graves",k+"lc"));
  row.appendChild(bigToggle("pane","Invertir fase",k+"invert"));
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
  ctx.clearRect(0,0,w,hh);ctx.strokeStyle="#1d1d21";ctx.lineWidth=1;ctx.font="11px "+font();ctx.fillStyle="#55555c";
  for(let d=lo;d<=0;d+=10){ctx.beginPath();ctx.moveTo(px(d),0);ctx.lineTo(px(d),hh);ctx.moveTo(0,py(d));ctx.lineTo(w,py(d));ctx.stroke();if(d>lo)ctx.fillText(d,px(d)+3,hh-4)}
  ctx.strokeStyle="#2e2e34";ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(px(lo),py(lo));ctx.lineTo(px(0),py(0));ctx.stroke();ctx.setLineDash([]);
  ctx.strokeStyle="rgba(227,16,28,.5)";ctx.beginPath();ctx.moveTo(px(thr),0);ctx.lineTo(px(thr),hh);ctx.stroke();
  ctx.beginPath();for(let x=lo;x<=0;x+=.5){const y=fn(x);x===lo?ctx.moveTo(px(x),py(y)):ctx.lineTo(px(x),py(y))}
  ctx.strokeStyle=on?"#e3101c":"#55555c";ctx.lineWidth=3;ctx.shadowColor="#e3101c";ctx.shadowBlur=on?10:0;ctx.stroke();ctx.shadowBlur=0;
  const lv=M[id]?.[0]||0,ldb=lv>0?20*Math.log10(lv):-100;
  if(status.meters&&ldb>lo){ctx.fillStyle="#fff";ctx.beginPath();ctx.arc(px(ldb),py(fn(ldb)),6,0,7);ctx.fill()}
  ctx.fillStyle="#8b8b93";ctx.fillText("Umbral "+(+thr).toFixed(1)+" dB  ·  desliza el dedo sobre el gráfico para moverlo",10,16);
}

/* ---------- Ecualizador ---------- */
function biquad(type,f0,g,q,fs=48000){   // type: hp, ls, hs, pk
  const A=Math.pow(10,g/40),w=2*Math.PI*Math.min(f0,fs*.45)/fs,cs=Math.cos(w),sn=Math.sin(w);
  let al=sn/(2*q),b0,b1,b2,a0,a1,a2;
  if(type==="hp"){al=sn/(2*.707);b0=(1+cs)/2;b1=-(1+cs);b2=b0;a0=1+al;a1=-2*cs;a2=1-al}
  else if(type==="ls"||type==="hs"){al=sn/(2*Math.min(q,1.2));const sq=2*Math.sqrt(A)*al;
    if(type==="ls"){b0=A*((A+1)-(A-1)*cs+sq);b1=2*A*((A-1)-(A+1)*cs);b2=A*((A+1)-(A-1)*cs-sq);a0=(A+1)+(A-1)*cs+sq;a1=-2*((A-1)+(A+1)*cs);a2=(A+1)+(A-1)*cs-sq}
    else{b0=A*((A+1)+(A-1)*cs+sq);b1=-2*A*((A-1)+(A+1)*cs);b2=A*((A+1)+(A-1)*cs-sq);a0=(A+1)-(A-1)*cs+sq;a1=2*((A-1)-(A+1)*cs);a2=(A+1)-(A-1)*cs-sq}}
  else{b0=1+al*A;b1=-2*cs;b2=1-al*A;a0=1+al/A;a1=-2*cs;a2=1-al/A}
  return[b0/a0,b1/a0,b2/a0,a1/a0,a2/a0];
}
function magDb(c,f,fs=48000){const w=2*Math.PI*f/fs,c1=Math.cos(w),c2=Math.cos(2*w),s1=Math.sin(w),s2=Math.sin(2*w);
  const nr=c[0]+c[1]*c1+c[2]*c2,ni=c[1]*s1+c[2]*s2,dr=1+c[3]*c1+c[4]*c2,di=c[3]*s1+c[4]*s2;
  return 10*Math.log10((nr*nr+ni*ni)/(dr*dr+di*di)+1e-20)}
const bandType=b=>b==="l"?"ls":b==="h"?"hs":"pk";
function bandCoef(s,b){const p=`${s.id}.eq.${b}.`;return biquad(bandType(b),+S[p+"f"],+S[p+"g"],+S[p+"q"])}
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
  s.eq.forEach((b,i)=>{const c=h("button","",bandName(b));c.style.setProperty("--bc",EQ_COL[i%EQ_COL.length]);c.classList.toggle("sel",b===eqBand);
    c.onclick=()=>{eqBand=b;renderPane(s)};bands.appendChild(c)});
  pane.appendChild(bands);
  const ks=h("div","knobs");const bp=`${k}${eqBand}.`;
  ks.appendChild(knob("pane",{label:"Frecuencia",key:bp+"f",fmt:F.hz}));
  ks.appendChild(knob("pane",{label:"Subir / bajar",key:bp+"g",fmt:F.dbu,def:0}));
  ks.appendChild(knob("pane",{label:"Anchura",key:bp+"q",fmt:v=>(+v<1.5?"Ancha ":+v>4?"Estrecha ":"Media ")+(+v).toFixed(1)}));
  pane.appendChild(ks);
  const cv=g.querySelector("canvas");
  const keys=[k+"on",s.id+".lc",s.id+".lcf"];for(const b of s.eq)for(const x of["g","f","q"])keys.push(`${k}${b}.${x}`);
  watch("pane",keys,()=>requestAnimationFrame(()=>drawEq(cv,s)));
  eqTouch(g,s);
}
const EQ_COL=["#ff3b45","#ffb020","#34d27b","#1fc2d4","#2f7bf2","#c23be0","#ff5fb0","#e8e8ec"];
function eqXY(s,b,w,hh){const p=`${s.id}.eq.${b}.`;return[hzX(+S[p+"f"])*w,hh/2-(+S[p+"g"])/18*(hh/2)]}
function drawEq(cv,s){
  const r=fitCanvas(cv);if(!r)return;const[ctx,w,hh]=r,on=+S[s.id+".eq.on"];
  ctx.clearRect(0,0,w,hh);ctx.lineWidth=1;ctx.font="11px "+font();
  for(const[f,l]of[[20,"20"],[50,"50"],[100,"100"],[200,"200"],[500,"500"],[1000,"1k"],[2000,"2k"],[5000,"5k"],[10000,"10k"]]){const x=hzX(f)*w;ctx.strokeStyle="#1d1d21";ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,hh);ctx.stroke();
    ctx.fillStyle="#55555c";ctx.fillText(l,x+3,hh-5)}
  ctx.fillStyle="#3a3a40";ctx.font="12px "+font();ctx.fillText("GRAVES",hzX(60)*w,18);ctx.fillText("MEDIOS",hzX(900)*w,18);ctx.fillText("AGUDOS",hzX(9000)*w,18);ctx.font="11px "+font();
  for(const d of[-15,-10,-5,0,5,10,15]){const y=hh/2-d/18*(hh/2);ctx.strokeStyle=d?"#1d1d21":"#2e2e34";ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();
    if(d){ctx.fillStyle="#55555c";ctx.fillText((d>0?"+":"")+d,4,y-3)}}
  const Y=d=>hh/2-clamp(d,-20,20)/18*(hh/2);
  s.eq.forEach((b,i)=>{const pts=eqCurve(s,160,b);ctx.beginPath();pts.forEach(([x,d],k)=>k?ctx.lineTo(x*w,Y(d)):ctx.moveTo(x*w,Y(d)));
    ctx.strokeStyle=EQ_COL[i%EQ_COL.length]+(b===eqBand?"aa":"44");ctx.lineWidth=b===eqBand?1.6:1;ctx.stroke()});
  const pts=eqCurve(s,240);
  ctx.beginPath();ctx.moveTo(0,hh/2);pts.forEach(([x,d])=>ctx.lineTo(x*w,Y(d)));ctx.lineTo(w,hh/2);ctx.closePath();
  const gr=ctx.createLinearGradient(0,0,0,hh);gr.addColorStop(0,on?"rgba(227,16,28,.35)":"rgba(120,120,130,.2)");gr.addColorStop(.5,"rgba(227,16,28,.04)");gr.addColorStop(1,on?"rgba(227,16,28,.35)":"rgba(120,120,130,.2)");
  ctx.fillStyle=gr;ctx.fill();
  ctx.beginPath();pts.forEach(([x,d],k)=>k?ctx.lineTo(x*w,Y(d)):ctx.moveTo(x*w,Y(d)));
  ctx.strokeStyle=on?"#ff2a36":"#6a6a72";ctx.lineWidth=3;ctx.shadowColor="#e3101c";ctx.shadowBlur=on?12:0;ctx.stroke();ctx.shadowBlur=0;
  s.eq.forEach((b,i)=>{const[x,y]=eqXY(s,b,w,hh),sel=b===eqBand,c=EQ_COL[i%EQ_COL.length];
    ctx.beginPath();ctx.arc(x,y,sel?16:13,0,7);ctx.fillStyle=sel?c:"#111";ctx.fill();ctx.lineWidth=2.5;ctx.strokeStyle=c;ctx.stroke();
    ctx.fillStyle=sel?"#000":"#fff";ctx.font="bold 12px "+font();ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(b==="l"?"G":b==="h"?"A":b,x,y+1);
    ctx.textAlign="left";ctx.textBaseline="alphabetic";ctx.font="11px "+font()});
  if(s.inp&&+S[s.id+".lc"]){const x=hzX(+S[s.id+".lcf"])*w;ctx.fillStyle="#8b8b93";ctx.fillText("Graves quitados hasta "+F.hz(S[s.id+".lcf"]),x+4,34)}
}
function eqTouch(g,s){
  const pts=new Map();let band=null,start=null,pinch=null;
  g.addEventListener("pointerdown",e=>{
    try{g.setPointerCapture(e.pointerId)}catch(_){}
    pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    const r=g.getBoundingClientRect();
    if(pts.size===1){
      let best=s.eq[0],bd=1e9;for(const b of s.eq){const[x,y]=eqXY(s,b,r.width,r.height);const d=Math.hypot(x-(e.clientX-r.left),(y-(e.clientY-r.top))*.6);if(d<bd){bd=d;best=b}}
      if(best!==eqBand){eqBand=best;renderPane(s);return}
      band=best;const p=`${s.id}.eq.${band}.`;start={x:e.clientX,y:e.clientY,f:norm(p+"f"),g:+S[p+"g"]};hold(p+"f");hold(p+"g");
    }else if(pts.size===2&&band){const a=[...pts.values()];pinch={d:Math.abs(a[0].x-a[1].x)+1,q:norm(`${s.id}.eq.${band}.q`)};start=null}
    e.preventDefault();
  });
  g.addEventListener("pointermove",e=>{if(!pts.has(e.pointerId)||!band)return;pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    const r=g.getBoundingClientRect(),p=`${s.id}.eq.${band}.`;
    if(pinch&&pts.size>=2){const a=[...pts.values()],d=Math.abs(a[0].x-a[1].x)+1;setN(p+"q",pinch.q-Math.log(d/pinch.d)*.35);return}
    if(!start)return;
    setN(p+"f",start.f+(e.clientX-start.x)/r.width);
    setP(p+"g",start.g-(e.clientY-start.y)/(r.height/2)*18);
  });
  const up=e=>{pts.delete(e.pointerId);if(!pts.size&&band){const p=`${s.id}.eq.${band}.`;release(p+"f");release(p+"g");band=null;start=null;pinch=null}};
  g.addEventListener("pointerup",up);g.addEventListener("pointercancel",up);
  g.addEventListener("wheel",e=>{const p=`${s.id}.eq.${eqBand}.q`;setN(p,norm(p)+(e.deltaY>0?-.02:.02));e.preventDefault()},{passive:false});
}

/* ---------- Envíos ---------- */
function paneSends(s,pane){
  head(pane,"Envíos a monitores","Cuánto de este canal va a cada bus (monitores, cascos, efectos).");
  const grid=h("div","sends");
  for(let n=1;n<=16;n++){
    const bs=busStrip(n),lk=`${s.id}.send.${n}.lvl`,ok=`${s.id}.send.${n}.on`;
    const row=h("div","send",`<div class="who"><small>Bus ${n}</small><span></span></div><div class="hslider"><b></b></div><div class="val"></div><button class="on">ON</button>`);
    watch("pane",[lk,ok,bs.id+".name",bs.id+".color"],()=>{
      row.querySelector(".who").style.setProperty("--c",colorOf(bs));row.querySelector(".who span").textContent=S[bs.id+".name"]||"Bus "+n;
      row.querySelector(".hslider b").style.width=(norm(lk)*100)+"%";row.querySelector(".val").textContent=F.db(S[lk]);
      row.querySelector(".on").classList.toggle("on",!!+S[ok]);row.classList.toggle("off",!+S[ok])});
    const sl=row.querySelector(".hslider");
    dragH(sl,()=>norm(lk),v=>setN(lk,v),{start:()=>hold(lk),end:()=>release(lk),dbl:()=>setP(lk,0),travel:()=>sl.clientWidth});
    row.querySelector(".on").onclick=()=>tog(ok);
    grid.appendChild(row);
  }
  pane.appendChild(grid);
}

/* ---------- Nombre y color ---------- */
function paneCfg(s,pane){
  head(pane,"Nombre y color","Así aparece el canal en la mesa y en todos los iPads.");
  const nk=s.id+".name",ck=s.id+".color";
  const inp=h("input","field");inp.maxLength=16;inp.placeholder=s.label;inp.style.maxWidth="420px";inp.value=S[nk]||"";
  inp.oninput=()=>setP(nk,inp.value);pane.appendChild(inp);
  const cols=h("div","colors");
  COLORS.forEach((c,i)=>{const b=h("button","",COLOR_NAMES[i]);b.style.cssText=`background:#0b0b0d;color:${i?c:"#8b8b93"};box-shadow:inset 0 6px 0 ${c}`;
    b.onclick=()=>setP(ck,i);cols.appendChild(b)});
  watch("pane",[ck],()=>[...cols.children].forEach((b,i)=>b.classList.toggle("sel",i===+S[ck])));
  pane.appendChild(h("h3","sec","Color"));pane.appendChild(cols);
}

/* ================================================================ hojas */
function openSheet(id){$(id).classList.add("show")}
function closeSheets(){document.querySelectorAll(".sheet.show").forEach(s=>s.classList.remove("show"))}
document.querySelectorAll(".sheet").forEach(sh=>sh.addEventListener("pointerdown",e=>{if(e.target===sh||e.target.dataset.close!=null)closeSheets()}));

let connMode="wing";
function openConn(){connMode=status.mode&&status.mode!=="offline"?status.mode:"wing";$("#ip").value=status.ip||status.lastIp||"";paintConn();openSheet("#connSheet")}
function paintConn(){document.querySelectorAll(".model").forEach(b=>b.classList.toggle("sel",b.dataset.mode===connMode));$("#ipBox").style.display=connMode==="wing"?"":"none"}
document.querySelectorAll(".model").forEach(b=>b.onclick=()=>{connMode=b.dataset.mode;paintConn()});
$("#connBtn").onclick=openConn;
$("#connectBtn").onclick=()=>{$("#connectBtn").textContent="Conectando…";send({t:"connect",mode:connMode,ip:$("#ip").value})};
$("#findBtn").onclick=()=>{$("#found").innerHTML='<div class="empty">Buscando la mesa en la red…</div>';send({t:"discover"})};

function openMix(){
  const list=$("#mixList");list.innerHTML="";
  const mk=(n,label,sub,c)=>{const b=h("button",n?"":"lr",`${esc(label)}<small>${esc(sub)}</small>`);b.style.setProperty("--c",c);b.classList.toggle("sel",n===sendBus);
    b.onclick=()=>{sendBus=n;store("sendBus",n);closeSheets();renderDesk()};list.appendChild(b)};
  mk(0,"Principal","La mezcla que oye el público","var(--red)");
  for(let n=1;n<=16;n++){const s=busStrip(n);mk(n,"Bus "+n,S[s.id+".name"]||"—",colorOf(s))}
  openSheet("#mixSheet");
}
$("#mixSel").onclick=openMix;

function renderScenes(){
  const l=$("#sceneList");l.innerHTML="";
  if(!scenes.length){l.innerHTML='<div class="empty">Todavía no has guardado ninguna mezcla.</div>';return}
  scenes.forEach((sc,i)=>{const it=h("div","item",`<span>${esc(sc.name)}<small>${esc(sc.time||"")}</small></span>`);
    const ld=h("button","btn small red","Cargar"),del=h("button","btn small","Borrar");
    ld.onclick=()=>{if(ld.dataset.c){send({t:"sceneLoad",i});closeSheets();toast(`Mezcla «${sc.name}» cargada`)}else{ld.dataset.c=1;ld.textContent="¿Seguro?";setTimeout(()=>{delete ld.dataset.c;ld.textContent="Cargar"},2500)}};
    del.onclick=()=>{if(del.dataset.c)send({t:"sceneDelete",i});else{del.dataset.c=1;del.textContent="¿Seguro?";setTimeout(()=>{delete del.dataset.c;del.textContent="Borrar"},2500)}};
    it.appendChild(ld);it.appendChild(del);l.appendChild(it)});
}
$("#scenesBtn").onclick=()=>{renderScenes();openSheet("#sceneSheet")};
$("#sceneSave").onclick=()=>{send({t:"sceneSave",name:$("#sceneName").value});$("#sceneName").value="";toast("Mezcla guardada")};
$("#helpBtn").onclick=()=>openSheet("#helpSheet");

function openLayerEditor(){
  const box=$("#layerPick");box.innerHTML="";
  const groups=[["Canales",STRIPS.filter(s=>s.kind==="ch")],["Aux",STRIPS.filter(s=>s.kind==="aux")],
    ["Buses",STRIPS.filter(s=>s.kind==="bus")],["Salidas",STRIPS.filter(s=>s.kind==="main"||s.kind==="mtx")],["DCA",STRIPS.filter(s=>s.kind==="dca")]];
  for(const[t,list]of groups){box.appendChild(h("h3","sec",t));const g=h("div","pick");
    for(const s of list){const b=h("button","",esc(S[s.id+".name"]||s.label));b.style.setProperty("--c",colorOf(s));
      const paint=()=>{const i=layout.custom.indexOf(s.id);b.classList.toggle("sel",i>=0);b.dataset.n=i>=0?i+1:""};paint();
      b.onclick=()=>{const i=layout.custom.indexOf(s.id);i>=0?layout.custom.splice(i,1):layout.custom.push(s.id);box.querySelectorAll(".pick button").forEach(x=>x._paint());};b._paint=paint;g.appendChild(b)}
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
      case"model":STRIPS=m.strips;SPEC=m.spec;BY={};STRIPS.forEach(s=>BY[s.id]=s);break;
      case"status":{const first=!status.t;status=m;const d=$("#connDot");d.className="conn-dot"+(m.mode==="demo"?" demo":m.connected?" on":"");
        document.body.classList.toggle("nometers",!m.meters);if(!m.meters)M={};
        $("#lanUrl").textContent=m.url;$("#connInfo").textContent=m.mode==="offline"?"Elige tu mesa. Con «Demo» puedes probarlo todo sin mesa.":
          m.connected?`Conectado a: ${m.info}`:`La mesa no responde${m.ip?" ("+m.ip+")":""}. Reintentando…`;
        $("#connState").textContent=m.mode==="demo"?"Demo":m.connected?"Conectado":"Sin mesa";
        if(first){renderLayers();renderDesk();if(m.mode==="offline")openConn()}
        else if(m.mode==="wing"&&!m.connected)toast("Se ha perdido la conexión con la mesa");break}
      case"connectResult":$("#connectBtn").textContent="Conectar";if(m.ok){closeSheets();toast("Conectado")}else toast(m.msg);break;
      case"found":{const f=$("#found");f.innerHTML="";if(!m.v.length)f.innerHTML='<div class="empty">No he encontrado ninguna WING. Escribe su IP (en la mesa: Setup → Network).</div>';
        m.v.forEach(x=>{const b=h("button","",`${esc(x.name)} <small>${esc(x.model)} · ${esc(x.ip)}</small>`);b.onclick=()=>{$("#ip").value=x.ip;connMode="wing";paintConn()};f.appendChild(b)});break}
      case"scenes":scenes=m.v;renderScenes();break;
      case"layout":layout=Object.assign({custom:[]},m.v||{});if(!Array.isArray(layout.custom))layout.custom=[];layout.custom=layout.custom.filter(id=>BY[id]);if(layer==="custom"&&status.t)renderDesk();break;
    }};
  ws.onclose=()=>{ws=null;$("#connDot").className="conn-dot";if(wsTries++>1)toast("Sin conexión con el ordenador de MBMix. Reintentando…");setTimeout(connectWs,Math.min(5000,500*wsTries))};
}
window.addEventListener("resize",()=>notifyAll());
requestAnimationFrame(meterLoop);
connectWs();
