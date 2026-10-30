"use strict";
/* MB Soundtools · MBMix — motor en el propio iPad (sin ordenador).
   Es la traducción a JavaScript del servidor mbmix.py: modelos de mesa, conversión de valores,
   protocolo OSC, modo demo, escenas, grupos y enlaces. La app nativa solo aporta la red (UDP)
   y el almacenamiento; la interfaz (app.js) le habla igual que al servidor. */
(function(){
const WING_OSC_PORT=2223,WING_INFO_PORT=2222,XAIR_PORT=10024;

/* ---------------------------------------------------------------- OSC */
const te=new TextEncoder(),td=new TextDecoder();
const pad4=n=>(n+3)&~3;
function oscEncode(addr,...args){
  const parts=[],str=s=>{const b=te.encode(s),o=new Uint8Array(pad4(b.length+1));o.set(b);return o};
  let tags=",";
  for(const a of args){
    if(typeof a==="number"&&a.isInt){tags+="i";const d=new DataView(new ArrayBuffer(4));d.setInt32(0,a.v);parts.push(new Uint8Array(d.buffer))}
    else if(typeof a==="object"&&a&&a.isInt){tags+="i";const d=new DataView(new ArrayBuffer(4));d.setInt32(0,a.v);parts.push(new Uint8Array(d.buffer))}
    else if(typeof a==="object"&&a&&a.isFloat){tags+="f";const d=new DataView(new ArrayBuffer(4));d.setFloat32(0,a.v);parts.push(new Uint8Array(d.buffer))}
    else{tags+="s";parts.push(str(String(a)))}
  }
  const all=[str(addr),str(tags),...parts],len=all.reduce((n,p)=>n+p.length,0),out=new Uint8Array(len);
  let o=0;for(const p of all){out.set(p,o);o+=p.length}return out;
}
const I=v=>({isInt:true,v:Math.round(v)}),Fl=v=>({isFloat:true,v});
function oscDecode(buf){
  try{
    const u=buf,dv=new DataView(u.buffer,u.byteOffset,u.byteLength);
    const rs=i=>{let e=i;while(e<u.length&&u[e])e++;return[td.decode(u.subarray(i,e)),pad4(e+1)]};
    let[addr,i]=rs(0);if(i>=u.length||u[i]!==44)return[addr,[]];
    let tags;[tags,i]=rs(i);const args=[];
    for(const t of tags.slice(1)){
      if(t==="i"){args.push(dv.getInt32(i));i+=4}
      else if(t==="f"){args.push(dv.getFloat32(i));i+=4}
      else if(t==="s"){let s;[s,i]=rs(i);args.push(s)}
      else if(t==="b"){const n=dv.getInt32(i);args.push(u.subarray(i+4,i+4+n));i+=4+pad4(n)}
    }
    return[addr,args];
  }catch(e){return null}
}
const b64e=u=>{let s="";for(let i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s)};
const b64d=s=>{const b=atob(s),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u};

/* ---------------------------------------------------------------- conversiones */
const x32pos=db=>db>=-10?(db+30)/40:db>=-30?(db+50)/80:db>=-60?(db+70)/160:db>-90?(db+90)/480:0;
const x32db=f=>f>=.5?f*40-30:f>=.25?f*80-50:f>=.0625?f*160-70:f>0?f*480-90:-144;
const convLin=(lo,hi)=>[v=>(v-lo)/(hi-lo),x=>lo+x*(hi-lo)];
const convLog=(lo,hi)=>{const r=Math.log(hi/lo);return[v=>Math.log(Math.max(1e-9,v)/lo)/r,x=>lo*Math.exp(x*r)]};
const convEnum=vals=>[v=>{let b=0;vals.forEach((x,i)=>{if(Math.abs(x-v)<Math.abs(vals[b]-v))b=i});return b},x=>vals[x|0]];
const CONV_FADER=[x32pos,x32db],CONV_INV=[v=>v?0:1,x=>x?0:1],CONV_PAN=convLin(-100,100);

/* ---------------------------------------------------------------- modelos */
class Model{
  constructor(kind,name){Object.assign(this,{kind,name,strips:[],spec:{},path:{},conv:{},otype:{},layers:[],targets:[],colors:[],master:"",mgroups:0,mains:[],mtxTargets:[]})}
  p(key,path,typ,lo=0,hi=1,curve="lin",def=0,o={}){
    this.spec[key]=[typ,lo,hi,curve,def].concat(o.values?[o.values]:[]);
    if(path)this.path[key]=path;if(o.conv)this.conv[key]=o.conv;
    this.otype[key]=o.otype||({s:"s",b:"i",i:"i"}[typ]||"f");
  }
  addStrip(id,kind,label,f){const st=Object.assign({id,kind,label,eq:[],eqTypes:false,gate:false,dyn:false,sends:false,pan:true,inp:false,trim:false,solo:true},f);this.strips.push(st);return st}
  describe(){return{t:"model",kind:this.kind,name:this.name,strips:this.strips,spec:this.spec,layers:this.layers,targets:this.targets,colors:this.colors,master:this.master,mgroups:this.mgroups,mains:this.mains,mtxTargets:this.mtxTargets}}
}
const rng=(a,b)=>Array.from({length:b-a+1},(_,i)=>a+i);
const ids=(pre,a,b)=>rng(a,b).map(n=>pre+n);
const pad2=n=>String(n).padStart(2,"0");

const WING_COLORS=[["#4a4a52","Ninguno"],["#7b8fb0","Gris azul"],["#2f7bf2","Azul"],["#3346c8","Azul oscuro"],["#1fc2d4","Turquesa"],["#2fbf5b","Verde"],
  ["#8fae2a","Oliva"],["#f2c230","Amarillo"],["#ff8a1f","Naranja"],["#e3101c","Rojo"],["#ff6b5a","Coral"],["#ff5fb0","Rosa"],["#b06ad8","Malva"]];
const EQ_WS=["l","1","2","3","4","h"],EQ_WB=["l","1","2","3","4","5","6","h"];
function buildWing(){
  const m=new Model("wing","Behringer WING");m.colors=WING_COLORS;m.master="main1";m.mgroups=8;
  const p=(...a)=>m.p(...a);
  const strip=(sid,kind,label,base,{eq=null,gate=false,dyn=false,sends=false,pan=true,inp=false,mtx=false}={})=>{
    m.addStrip(sid,kind,label,{eq:eq||[],gate,dyn,sends,pan,inp,trim:inp,mtxSends:mtx});const k=sid+".";
    p(k+"name",base+"/name","s",0,1,"lin","");p(k+"color",base+"/col","i",0,12,"lin",0);
    p(k+"fader",base+"/fdr","n",-144,10,"fdr",["ch","aux","mtx"].includes(kind)?-144:0);
    p(k+"mute",base+"/mute","b");p(k+"solo",base+"/$solo","b");
    if(pan)p(k+"pan",base+"/pan","n",-100,100,"lin",0);
    if(inp){p(k+"gain",null,"n",-3,60,"lin",0);p(k+"p48",null,"b");p(k+"trim",base+"/in/set/trim","n",-18,18,"lin",0);
      p(k+"invert",base+"/in/set/inv","b");p(k+"lc",base+"/flt/lc","b");p(k+"lcf",base+"/flt/lcf","n",20,2000,"log",100);
      p(k+"src.grp",base+"/in/conn/grp","s",0,1,"lin","");p(k+"src.in",base+"/in/conn/in","i",0,64,"lin",0)}
    if(gate){const g=k+"gate.";p(g+"on",base+"/gate/on","b");p(g+"thr",base+"/gate/thr","n",-80,0,"lin",-40);p(g+"range",base+"/gate/range","n",3,60,"lin",30);
      p(g+"att",base+"/gate/att","n",0,120,"lin",0);p(g+"hld",base+"/gate/hld","n",0,2000,"log1",50);p(g+"rel",base+"/gate/rel","n",4,4000,"log",200)}
    if(dyn){const d=k+"dyn.";p(d+"on",base+"/dyn/on","b");p(d+"thr",base+"/dyn/thr","n",-60,0,"lin",-15);p(d+"ratio",base+"/dyn/ratio","n",1.1,100,"log",3);
      p(d+"knee",base+"/dyn/knee","n",0,5,"lin",1);p(d+"att",base+"/dyn/att","n",0,120,"lin",10);p(d+"rel",base+"/dyn/rel","n",4,4000,"log",150);
      p(d+"gain",base+"/dyn/gain","n",-6,12,"lin",0);p(d+"mix",base+"/dyn/mix","n",0,100,"lin",100)}
    if(eq){p(k+"eq.on",base+"/eq/on","b");const fr=eq.length===6?[80,250,800,2500,6000,10000]:[80,150,300,700,1500,3500,7000,10000];
      eq.forEach((b,i)=>{p(`${k}eq.${b}.g`,`${base}/eq/${b}g`,"n",-15,15,"lin",0);p(`${k}eq.${b}.f`,`${base}/eq/${b}f`,"n",20,20000,"log",fr[i]);
        p(`${k}eq.${b}.q`,`${base}/eq/${b}q`,"n",.44,10,"log","lh".includes(b)?.7:2)})}
    if(sends){for(let b=1;b<=16;b++){p(`${k}send.${b}.lvl`,`${base}/send/${b}/lvl`,"n",-144,10,"fdr",-144);p(`${k}send.${b}.on`,`${base}/send/${b}/on`,"b",0,1,"lin",1)}
      for(let mn=1;mn<=4;mn++)p(`${k}main.${mn}.on`,`${base}/main/${mn}/on`,"b",0,1,"lin",mn===1?1:0)}
    if(mtx)for(let x=1;x<=8;x++){p(`${k}send.${100+x}.lvl`,`${base}/send/${x}/lvl`,"n",-144,10,"fdr",-144);p(`${k}send.${100+x}.on`,`${base}/send/${x}/on`,"b",0,1,"lin",1)}
  };
  for(const n of rng(1,40))strip("ch"+n,"ch","Canal "+n,"/ch/"+n,{eq:EQ_WS,gate:true,dyn:true,sends:true,inp:true});
  for(const n of rng(1,8))strip("aux"+n,"aux","Aux "+n,"/aux/"+n,{eq:EQ_WS,dyn:true,sends:true,inp:true});
  for(const n of rng(1,16))strip("bus"+n,"bus","Bus "+n,"/bus/"+n,{eq:EQ_WB,dyn:true,mtx:true});
  for(const n of rng(1,4))strip("main"+n,"main","Main "+n,"/main/"+n,{eq:EQ_WB,dyn:true,mtx:true});
  for(const n of rng(1,8))strip("mtx"+n,"mtx","Matriz "+n,"/mtx/"+n,{eq:EQ_WB,dyn:true});
  for(const n of rng(1,16))strip("dca"+n,"dca","DCA "+n,"/dca/"+n,{pan:false});
  for(const g of rng(1,8)){p(`mg${g}.mute`,`/mgrp/${g}/mute`,"b");p(`mg${g}.name`,`/mgrp/${g}/name`,"s",0,1,"lin","")}
  m.targets=rng(1,16).map(b=>({n:b,id:"bus"+b}));m.mains=rng(1,4).map(n=>({n,id:"main"+n}));m.mtxTargets=rng(1,8).map(x=>({n:100+x,id:"mtx"+x}));
  m.layers=[{id:"in1",name:"1–16",ids:ids("ch",1,16)},{id:"in2",name:"17–32",ids:ids("ch",17,32)},{id:"in3",name:"33–40",ids:ids("ch",33,40)},
    {id:"aux",name:"Aux",ids:ids("aux",1,8)},{id:"bus",name:"Buses",ids:ids("bus",1,16)},{id:"out",name:"Salidas",ids:[...ids("main",1,4),...ids("mtx",1,8)]},
    {id:"dca",name:"DCA",ids:ids("dca",1,16)}];
  return m;
}
const XAIR_COLORS=[["#4a4a52","Ninguno"],["#e3101c","Rojo"],["#2fbf5b","Verde"],["#f2c230","Amarillo"],["#2f7bf2","Azul"],["#c23be0","Magenta"],["#1fc2d4","Cian"],["#e8e8ec","Blanco"]];
const XAIR_RATIOS=[1.1,1.3,1.5,2,2.5,3,4,5,7,10,20,100];
function buildXair(){
  const m=new Model("xair","Behringer XR18");m.colors=XAIR_COLORS;m.master="lr";m.mgroups=4;
  const p=(...a)=>m.p(...a);
  const strip=(sid,kind,label,base,solo,{eq=0,gate=false,dyn=false,sends=false,pan=true,inp=null}={})=>{
    m.addStrip(sid,kind,label,{eq:rng(1,eq).map(String),eqTypes:!!eq,gate,dyn,sends,pan,inp:inp!==null,solo:solo!==null});
    const k=sid+".",dca=kind==="dca",mix=dca?base:base+"/mix";
    p(k+"name",base+"/config/name","s",0,1,"lin","");p(k+"color",base+"/config/color","i",0,7,"lin",0);
    p(k+"fader",mix+"/fader","n",-144,10,"fdr",["ch","aux","fxrtn"].includes(kind)?-144:0,{conv:CONV_FADER});
    p(k+"mute",mix+"/on","b",0,1,"lin",0,{conv:CONV_INV});
    if(solo!==null)p(k+"solo","/-stat/solosw/"+pad2(solo),"b");
    if(pan)p(k+"pan",mix+"/pan","n",-100,100,"lin",0,{conv:CONV_PAN});
    if(inp!==null){const h="/headamp/"+pad2(inp);p(k+"gain",h+"/gain","n",-12,60,"lin",0,{conv:convLin(-12,60)});p(k+"p48",h+"/phantom","b");
      p(k+"invert",base+"/preamp/invert","b");p(k+"lc",base+"/preamp/hpon","b");p(k+"lcf",base+"/preamp/hpf","n",20,400,"log",100,{conv:convLog(20,400)})}
    if(gate){const g=k+"gate.",gp=base+"/gate/";p(g+"on",gp+"on","b");p(g+"thr",gp+"thr","n",-80,0,"lin",-40,{conv:convLin(-80,0)});
      p(g+"range",gp+"range","n",3,60,"lin",30,{conv:convLin(3,60)});p(g+"att",gp+"attack","n",0,120,"lin",0,{conv:convLin(0,120)});
      p(g+"hld",gp+"hold","n",.02,2000,"log",50,{conv:convLog(.02,2000)});p(g+"rel",gp+"release","n",5,4000,"log",200,{conv:convLog(5,4000)})}
    if(dyn){const d=k+"dyn.",dp=base+"/dyn/";p(d+"on",dp+"on","b");p(d+"thr",dp+"thr","n",-60,0,"lin",-15,{conv:convLin(-60,0)});
      p(d+"ratio",dp+"ratio","n",1.1,100,"enum",3,{conv:convEnum(XAIR_RATIOS),otype:"i",values:XAIR_RATIOS});
      p(d+"knee",dp+"knee","n",0,5,"lin",1,{conv:convLin(0,5)});p(d+"att",dp+"attack","n",0,120,"lin",10,{conv:convLin(0,120)});
      p(d+"rel",dp+"release","n",5,4000,"log",150,{conv:convLog(5,4000)});p(d+"gain",dp+"mgain","n",0,24,"lin",0,{conv:convLin(0,24)});
      p(d+"mix",dp+"mix","n",0,100,"lin",100,{conv:convLin(0,100)})}
    if(eq){p(k+"eq.on",base+"/eq/on","b");const fr=eq===4?[100,500,2000,8000]:[80,200,500,1500,4000,10000];
      fr.forEach((f,j)=>{const i=j+1,e=`${base}/eq/${i}/`;p(`${k}eq.${i}.type`,e+"type","i",0,5,"lin",i===1?1:i===eq?4:2);
        p(`${k}eq.${i}.f`,e+"f","n",20,20000,"log",f,{conv:convLog(20,20000)});p(`${k}eq.${i}.g`,e+"g","n",-15,15,"lin",0,{conv:convLin(-15,15)});
        p(`${k}eq.${i}.q`,e+"q","n",.3,10,"log",2,{conv:convLog(10,.3)})})}
    if(sends){for(let b=1;b<=10;b++)p(`${k}send.${b}.lvl`,`${mix}/${pad2(b)}/level`,"n",-144,10,"fdr",-144,{conv:CONV_FADER});
      p(`${k}main.1.on`,mix+"/lr","b",0,1,"lin",1)}
  };
  for(const n of rng(1,16))strip("ch"+n,"ch","Canal "+n,"/ch/"+pad2(n),n,{eq:4,gate:true,dyn:true,sends:true,inp:n});
  strip("aux1","aux","Aux 17-18","/rtn/aux",17,{sends:true});
  for(const n of rng(1,4))strip("fx"+n,"fxrtn","Retorno FX "+n,"/rtn/"+n,17+n,{sends:true});
  for(const n of rng(1,6))strip("bus"+n,"bus","Bus "+n,"/bus/"+n,21+n,{eq:6,dyn:true});
  for(const n of rng(1,4))strip("fxs"+n,"fxsend","Envío FX "+n,"/fxsend/"+n,27+n,{pan:false});
  strip("lr","main","Principal L/R","/lr",32,{eq:6,dyn:true});
  for(const n of rng(1,4))strip("dca"+n,"dca","DCA "+n,"/dca/"+n,null,{pan:false});
  for(const g of rng(1,4))p(`mg${g}.mute`,`/config/mute/${g}`,"b");
  m.targets=[...rng(1,6).map(b=>({n:b,id:"bus"+b})),...rng(1,4).map(f=>({n:6+f,id:"fxs"+f}))];m.mains=[{n:1,id:"lr"}];
  m.layers=[{id:"in1",name:"1–16",ids:ids("ch",1,16)},{id:"rtn",name:"Aux · FX",ids:["aux1",...ids("fx",1,4)]},
    {id:"bus",name:"Buses",ids:[...ids("bus",1,6),...ids("fxs",1,4)]},{id:"dca",name:"DCA",ids:ids("dca",1,4)}];
  return m;
}
const MODELS={wing:buildWing,xair:buildXair},MODEL_NAMES={wing:"Behringer WING",xair:"Behringer XR18"};
const DEMO_NAMES={ch1:["Bombo",9,1],ch2:["Caja",9,1],ch3:["Charles",9,1],ch4:["Tom 1",9,1],ch5:["Tom 2",9,1],ch6:["Base",9,1],ch7:["Aéreo I",9,1],
  ch8:["Aéreo D",9,1],ch9:["Bajo",2,4],ch10:["Guitarra 1",7,3],ch11:["Guitarra 2",7,3],ch12:["Teclado I",12,5],ch13:["Teclado D",12,5],ch14:["Acústica",8,3],
  ch15:["Voz MB",4,6],ch16:["Coro 1",5,2],ch17:["Coro 2",5,2],ch18:["Coro 3",5,2],aux1:["Ordenador",1,7],aux2:["Reverb",11,5],fx1:["Reverb",11,5],
  fx2:["Delay",11,5],bus1:["Mon Batería",9,1],bus2:["Mon Bajo",2,4],bus3:["Mon Guitarra",7,3],bus4:["Mon Voz",4,6],bus5:["Cascos MB I",5,2],
  bus6:["Cascos MB D",5,2],fxs1:["Reverb",11,5],fxs2:["Delay",11,5],main1:["Principal",1,7],lr:["Principal",1,7],dca1:["Batería",9,1],
  dca2:["Voces",4,6],dca3:["Banda",7,3],dca4:["Efectos",11,5],mg1:["Banda"],mg2:["Efectos"]};
const faderGain=db=>db<=-140?0:Math.pow(10,db/20);

/* ---------------------------------------------------------------- red (la pone la app nativa) */
const Net={
  native:!!(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.mbmix),
  post(o){if(this.native)window.webkit.messageHandlers.mbmix.postMessage(o)},
  send(ip,port,bytes){this.post({op:"send",ip,port,data:b64e(bytes)})},
  onRecv:null,
};
window.MBNative=window.MBNative||{};
window.MBNative.recv=(ip,port,b64)=>{try{Net.onRecv&&Net.onRecv(ip,port,b64d(b64))}catch(e){}};
window.MBNative.info=info=>{Net.info=info};

/* almacenamiento: en la app nativa se guarda en el iPad (UserDefaults); en el navegador, localStorage */
const Store={
  get(k,d){try{const s=window.MBNativeStore;if(s&&k in s)return JSON.parse(s[k]);const v=localStorage.getItem("mbmix.engine."+k);return v==null?d:JSON.parse(v)}catch(e){return d}},
  set(k,v){const j=JSON.stringify(v);if(Net.native){Net.post({op:"save",key:k,value:j});if(window.MBNativeStore)window.MBNativeStore[k]=j}
    else try{localStorage.setItem("mbmix.engine."+k,j)}catch(e){}},
};

/* ---------------------------------------------------------------- mesa */
const now=()=>performance.now()/1000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class Mixer{
  constructor(hub){this.hub=hub;Object.assign(this,{mode:"offline",ip:"",info:"",connected:false,lastRx:0,hasMeters:false,live:false});this.useModel("wing")}
  useModel(kind){this.model=(MODELS[kind]||buildWing)();this.kind=this.model.kind;this.strips=this.model.strips;this.spec=this.model.spec;
    this.path=Object.assign({},this.model.path);this.byPath={};for(const k in this.path)this.byPath[this.path[k]]=k;
    this.values={};for(const k in this.spec)this.values[k]=this.spec[k][4];this.meters={};for(const s of this.strips)this.meters[s.id]=[0,1,1]}
  async connect(kind,demo,ip=""){
    this.disconnect();this.useModel(kind);this.ip=(ip||"").trim();
    if(demo){this.mode="demo";this.demoSetup();this.connected=true;this.hasMeters=true;this.info="Demo · "+MODEL_NAMES[this.kind];return{ok:true}}
    if(!Net.native){this.mode="offline";return{ok:false,msg:"Para conectar con la mesa usa la app MBMix del iPad (o el programa del ordenador)."}}
    if(!this.ip){this.mode="offline";return{ok:false,msg:"Escribe la dirección IP de la mesa."}}
    this.mode="live";this.live=true;this.port=this.kind==="wing"?WING_OSC_PORT:XAIR_PORT;
    if(this.kind==="wing"){this.send("/?");this.send("/ch/1/name")}else this.send("/xinfo");
    for(let i=0;i<30&&!this.connected;i++)await sleep(100);
    if(!this.connected){this.live=false;this.mode="offline";
      return{ok:false,msg:`La mesa no responde en ${this.ip}. Revisa la IP, que hayas elegido el modelo correcto y que el iPad esté en la misma red que la mesa.`}}
    if(!this.info)this.info=`${MODEL_NAMES[this.kind]} · ${this.ip}`;
    this.hasMeters=this.kind==="xair";this.subscribe();this.queryAll();return{ok:true};
  }
  disconnect(){this.live=false;this.connected=false;this.info=""}
  send(addr,...args){if(this.live)Net.send(this.ip,this.port,oscEncode(addr,...args))}
  subscribe(){if(this.kind==="wing")this.send("/*S");else{this.send("/xremote");this.send("/meters","/meters/1")}}
  async queryAll(){
    const paths=Object.values(this.path);
    for(let i=0;i<paths.length;i++){if(!this.live)return;this.send(paths[i]);if(i%20===19)await sleep(20)}
    await sleep(600);
    if(this.kind==="wing"){for(const s of this.strips)if(s.inp)this.mapSource(s.id);await sleep(400)}
    this.hub.broadcast({t:"state",v:this.values});
  }
  mapSource(sid){
    const grp=this.values[sid+".src.grp"],n=this.values[sid+".src.in"];
    for(const k of["gain","p48"]){const old=this.path[`${sid}.${k}`];if(old){delete this.path[`${sid}.${k}`];delete this.byPath[old]}}
    if(grp&&grp!=="OFF"&&n){for(const[k,suf]of[["gain","g"],["p48","vph"]]){const wp=`/io/in/${grp}/${n|0}/${suf}`;this.path[`${sid}.${k}`]=wp;this.byPath[wp]=`${sid}.${k}`;this.send(wp)}}
  }
  onOsc(addr,args){
    this.lastRx=now();if(!this.connected)this.connected=true;
    if(addr==="/?"&&typeof args[0]==="string"&&args[0].startsWith("WING")){const p=args[0].split(",");if(p.length>=4)this.info=`WING (${p[3]}) · ${p[2]} · ${p[1]}`;return}
    if(addr==="/xinfo"&&args.length>=4){this.info=`${args[2]} · ${args[1]} · ${args[0]}`;return}
    if(addr==="/meters/1"&&args[0]instanceof Uint8Array){this.xairMeters(args[0]);return}
    const key=this.byPath[addr];if(!key||!args.length)return;
    const typ=this.spec[key][0];let raw;
    if(this.kind==="wing"){const nums=args.filter(a=>typeof a==="number");raw=typ==="s"?String(args[0]):nums.length?nums[nums.length-1]:args[0]}
    else raw=args[0];
    if(raw instanceof Uint8Array)return;
    let v;
    if(this.model.conv[key]&&typ!=="s")raw=this.model.conv[key][1](+raw);
    if(typ==="s")v=String(raw);else if(typ==="n"){v=Math.round(+raw*1000)/1000;if(isNaN(v))return}else{v=Math.round(+raw);if(isNaN(v))return}
    this.values[key]=v;this.hub.queueUpdate(key,v);
    if(key.endsWith(".src.grp")||key.endsWith(".src.in"))this.mapSource(key.split(".")[0]);
  }
  xairMeters(blob){
    const dv=new DataView(blob.buffer,blob.byteOffset,blob.byteLength);if(blob.length<4)return;
    const n=dv.getInt32(0,true);if(n<38||blob.length<4+2*n)return;
    const lin=i=>Math.pow(10,dv.getInt16(4+2*i,true)/256/20),m=this.meters;
    for(let i=0;i<16;i++)m["ch"+(i+1)]=[lin(i),1,1];m.aux1=[Math.max(lin(16),lin(17)),1,1];
    for(let i=0;i<4;i++)m["fx"+(i+1)]=[Math.max(lin(18+2*i),lin(19+2*i)),1,1];
    for(let i=0;i<6;i++)m["bus"+(i+1)]=[lin(26+i),1,1];for(let i=0;i<4;i++)m["fxs"+(i+1)]=[lin(32+i),1,1];
    m.lr=[Math.max(lin(36),lin(37)),1,1];
  }
  set(key,value){
    const sp=this.spec[key];if(!sp)return false;const[typ,lo,hi]=sp;let v;
    if(typ==="s")v=String(value).slice(0,this.kind==="wing"?16:12);
    else if(typ==="n"){v=Math.min(hi,Math.max(lo,+value));if(isNaN(v))return false;if(sp[3]==="enum")v=sp[5].reduce((b,x)=>Math.abs(x-v)<Math.abs(b-v)?x:b,sp[5][0])}
    else{v=typ==="i"?Math.min(hi,Math.max(lo,Math.round(+value))):(value?1:0);if(isNaN(v))return false}
    this.values[key]=v;
    if(this.mode==="live"&&this.path[key]){let out=v;const ot=this.model.otype[key];
      if(this.model.conv[key]){out=this.model.conv[key][0](v);if(ot==="f")out=Math.min(1,Math.max(0,out))}
      this.send(this.path[key],ot==="i"?I(out):ot==="f"?Fl(+out):String(out))}
    return true;
  }
  tick(){
    const t=now();
    if(this.mode==="live"&&this.live){
      if(!this.lastSub||t-this.lastSub>7){this.subscribe();this.send(this.kind==="wing"?"/?":"/xinfo");this.lastSub=t}
      if(this.connected&&t-this.lastRx>20){this.connected=false;this.hub.broadcast(this.hub.status())}
      else if(!this.connected&&t-this.lastRx<2){this.connected=true;this.hub.broadcast(this.hub.status())}
    }else if(this.mode==="demo")this.demoMeters(t);
    this.hub.sendMeters();
  }
  demoSetup(){
    const v=this.values,wing=this.kind==="wing";
    for(const[sid,d]of Object.entries(DEMO_NAMES)){if(!(sid+".name"in v))continue;v[sid+".name"]=d[0];if(d.length>1)v[sid+".color"]=wing?d[1]:d[2]}
    for(const s of this.strips){const id=s.id;
      if(["ch","aux","fxrtn"].includes(s.kind)&&v[id+".name"]){v[id+".fader"]=s.kind==="ch"?0:-6;if(s.eq.length)v[id+".eq.on"]=1;
        if(s.kind==="ch"){v[id+".dyn.on"]=1;v[id+".gain"]=30;v[id+".lc"]=1}}
      if(["bus","fxsend"].includes(s.kind)&&v[id+".name"])v[id+".fader"]=0}
    for(let n=1;n<16;n++)if(`ch${n}.send.4.lvl`in v)v[`ch${n}.send.4.lvl`]=n!==15?-10:0;
  }
  demoMeters(t){
    const v=this.values,m=this.meters;this.phase=this.phase||{};let mix=0;
    for(const s of this.strips){const id=s.id;if(!["ch","aux","fxrtn"].includes(s.kind))continue;
      if(!v[id+".name"]){m[id]=[0,1,1];continue}
      const ph=this.phase[id]??(this.phase[id]=Math.random()*10);
      const env=.5+.5*Math.sin(t*(1.3+ph%1.7)+ph),hit=Math.pow(Math.abs(Math.sin(t*(2+ph%3)+ph)),6);
      const lvl=Math.min(1,(.08+.35*env+.4*hit)*(.6+.4*Math.random()));let gr=1;
      if(s.dyn&&v[id+".dyn.on"]){const thr=Math.pow(10,v[id+".dyn.thr"]/20);if(lvl>thr)gr=Math.max(.1,Math.pow(thr/lvl,1-1/Math.max(1.1,v[id+".dyn.ratio"])))}
      m[id]=[lvl,1,gr];if(!v[id+".mute"])mix=Math.max(mix,lvl*faderGain(v[id+".fader"]))}
    for(const s of this.strips)if(["bus","fxsend"].includes(s.kind)){const l=v[s.id+".name"]?mix*.7*(.85+.15*Math.random()):0;m[s.id]=[Math.min(1,l*faderGain(v[s.id+".fader"])*1.5),1,1]}
    const mm=this.model.master;m[mm]=[v[mm+".mute"]?0:Math.min(1,mix*faderGain(v[mm+".fader"])),1,1];
  }
  snapshot(){const o={};for(const k in this.values)if(!k.endsWith(".solo")&&!k.includes(".src."))o[k]=this.values[k];return o}
  recall(vals){for(const k in vals)if(k in this.spec)this.set(k,vals[k])}
}

/* ---------------------------------------------------------------- búsqueda de mesas */
function discover(){
  return new Promise(res=>{
    if(!Net.native){res([]);return}
    const found={},prev=Net.scan;
    Net.scan=(ip,port,u)=>{
      const txt=td.decode(u);
      if(txt.startsWith("WING,")){const p=txt.replace(/\0+$/,"").split(",");if(p.length>=4)found[ip]={ip,kind:"wing",name:p[2],model:"WING "+p[3]}}
      else{const m=oscDecode(u);if(m&&m[0]==="/xinfo"&&m[1].length>=3)found[ip]={ip,kind:"xair",name:m[1][1],model:m[1][2]}}
    };
    Net.post({op:"scan",wing:b64e(te.encode("WING?")),xair:b64e(oscEncode("/xinfo"))});
    setTimeout(()=>{Net.scan=prev||null;res(Object.values(found))},2500);
  });
}

/* ---------------------------------------------------------------- hub (lo que antes hacía el servidor) */
const NO_LINK=["name","color","gain","p48","trim","invert","pan","solo"];
class Hub{
  constructor(emit){
    this.emit=emit;this.mixer=new Mixer(this);this.updates={};
    this.cfg=Object.assign({kind:"wing",demo:true,ip:"",ips:{},scenes:[],layouts:{}},Store.get("cfg",{}));
    if(!MODELS[this.cfg.kind])this.cfg.kind="wing";
    Net.onRecv=(ip,port,u)=>{
      if(Net.scan&&(port===WING_INFO_PORT||port===XAIR_PORT))Net.scan(ip,port,u);
      if(this.mixer.live&&ip===this.mixer.ip){const m=oscDecode(u);if(m)this.mixer.onOsc(m[0],m[1])}
    };
  }
  save(){Store.set("cfg",this.cfg)}
  status(){const m=this.mixer;return{t:"status",mode:m.mode,kind:m.kind,ip:m.ip,connected:m.connected,info:m.info,meters:m.hasMeters,
    url:Net.native?"":location.href,ips:this.cfg.ips||{},native:Net.native,standalone:true}}
  broadcast(o){this.emit(o)}
  queueUpdate(k,v){this.updates[k]=v}
  sendMeters(){
    if(Object.keys(this.updates).length){this.emit({t:"upd",v:this.updates});this.updates={}}
    if(this.mixer.hasMeters){const o={};for(const k in this.mixer.meters){const v=this.mixer.meters[k];o[k]=[+v[0].toFixed(4),+v[1].toFixed(3),+v[2].toFixed(3)]}this.emit({t:"m",v:o})}
  }
  scenes(){const kind=this.mixer.kind;return{t:"scenes",v:this.cfg.scenes.map((s,i)=>({i,name:s.name,time:s.time||"",model:s.model})).filter(s=>s.model===kind)}}
  layoutObj(){return this.cfg.layouts[this.mixer.kind]||(this.cfg.layouts[this.mixer.kind]={})}
  layout(){return{t:"layout",v:this.cfg.layouts[this.mixer.kind]||{}}}
  full(){const m=this.mixer;for(const o of[m.model.describe(),this.status(),{t:"state",v:m.values},this.scenes(),this.layout()])this.emit(o)}
  links(){const l=this.layoutObj();return l.links||(l.links=[])}
  partner(key){
    const dot=key.indexOf(".");if(dot<0)return null;const sid=key.slice(0,dot),rest=key.slice(dot+1);
    if(!sid.startsWith("ch")||NO_LINK.includes(rest.split(".")[0])||rest.startsWith("src."))return null;
    const n=+sid.slice(2),odd=n%2?n:n-1;if(!this.links().includes(odd))return null;
    const other=`ch${n===odd?odd+1:odd}.${rest}`;return other in this.mixer.spec?other:null;
  }
  link(odd,on){
    const m=this.mixer,links=this.links(),a="ch"+odd,b="ch"+(odd+1);if(!(a+".fader"in m.spec)||!(b+".fader"in m.spec))return;
    if(on&&!links.includes(odd)){links.push(odd);for(const k in m.spec)if(k.startsWith(a+".")){const o=this.partner(k);if(o)m.set(o,m.values[k])}
      if(a+".pan"in m.spec){m.set(a+".pan",-100);m.set(b+".pan",100)}}
    else if(!on&&links.includes(odd))links.splice(links.indexOf(odd),1);
    this.save();this.emit(this.layout());this.emit({t:"state",v:m.values});
  }
  async handle(msg){
    const m=this.mixer,t=msg.t;
    if(t==="set"){const k=msg.p;if(m.set(k,msg.v)){const o=this.partner(k);if(o&&m.set(o,m.values[k]))this.emit({t:"upd",v:{[o]:m.values[o]}})}}
    else if(t==="link")this.link(+msg.ch||0,!!msg.on);
    else if(t==="connect"){
      const kind=MODELS[msg.kind]?msg.kind:"wing",demo=!!msg.demo,ip=String(msg.ip||"");
      const res=await m.connect(kind,demo,ip);this.cfg.kind=kind;this.cfg.demo=demo;
      if(res.ok&&!demo){this.cfg.ip=ip;this.cfg.ips[kind]=ip}
      this.save();this.emit(Object.assign({t:"connectResult"},res));this.full();
    }else if(t==="discover")this.emit({t:"found",v:await discover()});
    else if(t==="sceneSave"){
      const kind=m.kind;let name=String(msg.name||"").split(/\s+/).join(" ").trim().slice(0,40);
      if(!name)name="Mezcla "+(this.cfg.scenes.filter(s=>s.model===kind).length+1);
      const d=new Date(),sc={name,time:`${pad2(d.getDate())}/${pad2(d.getMonth()+1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`,model:kind,values:m.snapshot()};
      const i=this.cfg.scenes.findIndex(s=>s.model===kind&&s.name.toLowerCase()===name.toLowerCase());
      i>=0?this.cfg.scenes[i]=sc:this.cfg.scenes.push(sc);this.save();this.emit(this.scenes());
    }else if(t==="sceneLoad"){const sc=this.cfg.scenes[+msg.i];if(sc&&sc.model===m.kind){m.recall(sc.values);this.emit({t:"state",v:m.values})}}
    else if(t==="sceneDelete"){const i=+msg.i;if(i>=0&&i<this.cfg.scenes.length){this.cfg.scenes.splice(i,1);this.save();this.emit(this.scenes())}}
    else if(t==="layout"){const v=msg.v||{},cur=this.layoutObj();for(const k of["custom","groups","views"])if(Array.isArray(v[k]))cur[k]=v[k];this.save()}
    else if(t==="reset"){this.cfg.layouts[m.kind]={};this.save();this.emit(this.layout())}
    else if(t==="awake")Net.post({op:"awake",on:!!msg.on});
  }
}

/* arranque: la interfaz llama a MBEngine.start(onMessage) y le envía órdenes con MBEngine.handle(msg) */
window.MBEngine={
  native:Net.native,
  async start(emit){
    const hub=new Hub(m=>setTimeout(()=>emit(m),0));this.hub=hub;
    const c=hub.cfg;let res=await hub.mixer.connect(c.kind,c.demo!==false,(c.ips||{})[c.kind]||c.ip||"");
    if(!res.ok)await hub.mixer.connect(c.kind,true);
    hub.full();setInterval(()=>hub.mixer.tick(),50);
  },
  handle(msg){this.hub&&this.hub.handle(msg)},
};
})();
