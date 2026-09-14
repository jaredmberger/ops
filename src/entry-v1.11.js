import base from './entry-v1.10.js';

const OPS_KV='CURATOR_OPS_RECORDS';
const ERROR_KV='CURATOR_ERROR_RECORDS';
const SNAPSHOT_KEY='performance-anomaly:latest';
const STATE_KEY='performance-anomaly:state';
const INCIDENT_KEY='incident:ops-performance-anomaly';
const EVENT_PREFIX='event:';
const DISPLAY_TIME_ZONE='America/Chicago';
const STATE_TTL=60*60*24*30;
const RECOVERED_TTL=60*60*24*180;
const BASE='https://oceanliners.net';
const MAX_SAMPLES=72;
const MIN_SAMPLES=12;
const RATIO_THRESHOLD=5;
const ABSOLUTE_THRESHOLD_MS=1500;

const CHECKS=[
  {id:'homepage',name:'Homepage',path:'/'},
  {id:'nav',name:'Shared navigation script',path:'/assets/nav.js'},
  {id:'home-search',name:'Homepage search component',path:'/assets/home-search.js'},
  {id:'titanic',name:'Titanic destination',path:'/titanic'}
];

export default{
  async fetch(request,env,ctx){
    const u=new URL(request.url);
    if(request.method==='GET'&&u.pathname==='/api/performance-anomaly')return json({ok:true,snapshot:await readSnapshot(env)});
    if(request.method==='POST'&&u.pathname==='/api/performance-anomaly-check-now')return json({ok:true,snapshot:await collect(env,'manual')});
    if(request.method==='GET'&&u.pathname==='/performance-anomaly')return html(render(await readSnapshot(env)));
    if(request.method==='GET'&&u.pathname==='/'){
      const response=await base.fetch(request,env,ctx);
      const type=response.headers.get('content-type')||'';
      if(!type.includes('text/html'))return response;
      const snapshot=await readSnapshot(env);
      const body=await response.text();
      const headers=new Headers(response.headers);
      headers.delete('content-length');
      return new Response(inject(body,snapshot),{status:response.status,statusText:response.statusText,headers});
    }
    return base.fetch(request,env,ctx);
  },
  async scheduled(controller,env,ctx){
    const result=base.scheduled(controller,env,ctx);
    ctx.waitUntil(collect(env,`cron:${controller?.cron||'unknown'}`).catch(error=>console.error('Ops performance anomaly collection failed',error)));
    return result;
  }
};

async function collect(env,source){
  requireBindings(env);
  const checkedAt=new Date().toISOString();
  const prior=await env[OPS_KV].get(STATE_KEY,'json')||{};
  const samples=prior.samples&&typeof prior.samples==='object'?prior.samples:{};
  const results=[];

  for(const check of CHECKS){
    const history=Array.isArray(samples[check.id])?samples[check.id].filter(Number.isFinite):[];
    const baseline=history.length>=MIN_SAMPLES?median(history):null;
    const probeResult=await probe(check);
    let ratio=null;
    let anomalous=false;
    let message='';

    if(!probeResult.ok){
      message=`No performance sample: HTTP ${probeResult.status??'fetch failure'}.`;
    }else if(baseline===null){
      message=`Building baseline (${history.length+1}/${MIN_SAMPLES} samples).`;
    }else{
      ratio=baseline>0?probeResult.durationMs/baseline:null;
      anomalous=Number.isFinite(ratio)&&ratio>=RATIO_THRESHOLD&&probeResult.durationMs>=ABSOLUTE_THRESHOLD_MS;
      message=anomalous
        ?`${ratio.toFixed(1)}× slower than baseline (${probeResult.durationMs} ms vs ${Math.round(baseline)} ms).`
        :`Within baseline (${probeResult.durationMs} ms vs ${Math.round(baseline)} ms median).`;
    }

    if(probeResult.ok&&(!anomalous||baseline===null)){
      const next=[...history,probeResult.durationMs].slice(-MAX_SAMPLES);
      samples[check.id]=next;
    }else{
      samples[check.id]=history.slice(-MAX_SAMPLES);
    }

    results.push({...probeResult,baselineMs:baseline===null?null:Math.round(baseline),sampleCount:samples[check.id].length,ratio:ratio===null?null:Number(ratio.toFixed(2)),anomalous,message});
  }

  const judged=results.filter(r=>r.baselineMs!==null&&r.ok);
  const anomalies=judged.filter(r=>r.anomalous);
  const warming=results.some(r=>r.sampleCount<MIN_SAMPLES);
  const rawState=anomalies.length?'anomalous':warming?'warming':'healthy';
  let anomalyStreak=Number(prior.anomalyStreak||0);
  let firstAnomalyAt=prior.firstAnomalyAt||null;
  let lastAnomalyAt=prior.lastAnomalyAt||null;
  let lastHealthyAt=prior.lastHealthyAt||null;

  if(rawState==='anomalous'){
    anomalyStreak+=1;
    firstAnomalyAt=firstAnomalyAt||checkedAt;
    lastAnomalyAt=checkedAt;
  }else if(rawState==='healthy'){
    anomalyStreak=0;
    firstAnomalyAt=null;
    lastAnomalyAt=null;
    lastHealthyAt=checkedAt;
  }else{
    anomalyStreak=0;
  }

  const effectiveState=rawState==='warming'?'warming':rawState==='healthy'?'healthy':anomalyStreak>=3?'persistent':anomalyStreak===2?'degraded':'observing';
  const message=rawState==='warming'
    ?`Building a stable performance baseline; at least ${MIN_SAMPLES} successful samples are required per check.`
    :rawState==='healthy'
      ?`No meaningful performance regression detected across ${judged.length} monitored paths.`
      :`${anomalies.length} path${anomalies.length===1?' is':'s are'} at least ${RATIO_THRESHOLD}× slower than baseline and above ${ABSOLUTE_THRESHOLD_MS} ms.`;

  const snapshot={
    generatedAt:checkedAt,source,displayTimeZone:DISPLAY_TIME_ZONE,name:'Performance Anomaly',
    ok:effectiveState==='healthy',effectiveState,rawState,anomalyStreak,firstAnomalyAt,lastAnomalyAt,lastHealthyAt,
    thresholds:{minimumSamples:MIN_SAMPLES,ratio:RATIO_THRESHOLD,absoluteMs:ABSOLUTE_THRESHOLD_MS,maxSamples:MAX_SAMPLES},
    message,checks:results,
    summary:{status:effectiveState,rawState,anomalousChecks:anomalies.length,totalChecks:results.length,anomalyStreak}
  };

  const state={samples,anomalyStreak,firstAnomalyAt,lastAnomalyAt,lastHealthyAt,effectiveState,updatedAt:checkedAt};
  await env[OPS_KV].put(STATE_KEY,JSON.stringify(state),{expirationTtl:STATE_TTL});
  await env[OPS_KV].put(SNAPSHOT_KEY,JSON.stringify(snapshot));
  await reconcileIncident(env,snapshot);
  return snapshot;
}

async function probe(check){
  const started=Date.now();
  try{
    const response=await fetch(BASE+check.path,{
      redirect:'follow',
      cf:{cacheTtl:0,cacheEverything:false},
      headers:{'user-agent':'Mozilla/5.0 (compatible; CuratorOS-Performance/1.11; +https://ops.oceanlinercurator.com)','cache-control':'no-cache','pragma':'no-cache'}
    });
    const durationMs=Date.now()-started;
    return{id:check.id,name:check.name,path:check.path,ok:response.ok,status:response.status,durationMs};
  }catch(error){
    return{id:check.id,name:check.name,path:check.path,ok:false,status:null,durationMs:Date.now()-started,error:String(error?.message||error||'Fetch failed')};
  }
}

function median(values){
  const sorted=[...values].sort((a,b)=>a-b);
  const mid=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
}

async function reconcileIncident(env,snapshot){
  const previous=await env[ERROR_KV].get(INCIDENT_KEY,'json');
  const active=previous&&['active','degraded'].includes(previous.status);
  const now=new Date().toISOString();
  if(snapshot.effectiveState==='persistent'){
    const anomalous=snapshot.checks.filter(c=>c.anomalous).map(c=>({id:c.id,path:c.path,durationMs:c.durationMs,baselineMs:c.baselineMs,ratio:c.ratio}));
    const incident={
      id:previous?.id||'incident_ops-performance-anomaly',fingerprint:'ops-performance-anomaly',source:'Curator Ops',component:'public-site:performance',severity:'p2',type:'ops-performance-persistent-regression',
      message:`Meaningful performance regression persisted for ${snapshot.anomalyStreak} consecutive checks.`,
      context:{anomalyStreak:snapshot.anomalyStreak,thresholds:snapshot.thresholds,anomalousChecks:anomalous},
      firstSeenAt:active?(previous.firstSeenAt||now):now,lastSeenAt:now,occurrences:active?Math.max(1,Number(previous.occurrences||0)+1):1,status:'active',recoveredAt:null,recoveryMessage:null,lastSuccessfulAt:previous?.lastSuccessfulAt||null
    };
    await env[ERROR_KV].put(INCIDENT_KEY,JSON.stringify(incident));
    if(!active)await writeEvent(env,'ops-incident',incident);
    return;
  }
  if(active&&snapshot.effectiveState==='healthy'){
    const recovered={...previous,status:'recovered',recoveredAt:now,lastSuccessfulAt:now,recoveryMessage:'Performance returned to the established baseline.'};
    await env[ERROR_KV].put(INCIDENT_KEY,JSON.stringify(recovered),{expirationTtl:RECOVERED_TTL});
    await writeEvent(env,'ops-recovery',recovered);
  }
}

async function writeEvent(env,kind,incident){
  const at=new Date().toISOString();
  const key=`${EVENT_PREFIX}${at}:${Math.random().toString(36).slice(2,8)}`;
  await env[ERROR_KV].put(key,JSON.stringify({kind,at,incidentId:incident.id,fingerprint:incident.fingerprint,source:incident.source,component:incident.component,severity:incident.severity,status:incident.status,message:incident.message}),{expirationTtl:RECOVERED_TTL});
}

async function readSnapshot(env){
  requireBindings(env);
  return await env[OPS_KV].get(SNAPSHOT_KEY,'json')||{generatedAt:null,source:null,displayTimeZone:DISPLAY_TIME_ZONE,name:'Performance Anomaly',ok:null,effectiveState:'warming',rawState:'warming',anomalyStreak:0,firstAnomalyAt:null,lastAnomalyAt:null,lastHealthyAt:null,thresholds:{minimumSamples:MIN_SAMPLES,ratio:RATIO_THRESHOLD,absoluteMs:ABSOLUTE_THRESHOLD_MS,maxSamples:MAX_SAMPLES},message:'Waiting for performance baseline samples.',checks:[],summary:{status:'warming',rawState:'warming',anomalousChecks:0,totalChecks:CHECKS.length,anomalyStreak:0}};
}

function inject(body,snapshot){
  const state=String(snapshot?.effectiveState||'warming');
  const checked=snapshot?.generatedAt?formatCentral(snapshot.generatedAt):'waiting';
  const detail=`${snapshot?.message||'Waiting for performance samples.'} · Ops checked ${checked}`;
  const card=`<section class="ops-performance-monitor" aria-label="Performance anomaly monitoring"><a class="ops-monitoring__card" href="/performance-anomaly"><div class="label">Performance Anomaly</div><div class="ops-monitoring__status"><span class="ops-monitoring__dot ${escClass(state)}"></span>${esc(state)}</div><div class="ops-monitoring__detail">${esc(detail)}</div></a></section>`;
  let out=body;
  if(out.includes('</style>'))out=out.replace('</style>','.ops-performance-monitor{margin:-8px 0 22px}.ops-performance-monitor .ops-monitoring__card{width:100%}</style>');
  out=out.replace('<a href="/history">Operational History →</a>','<a href="/performance-anomaly">Performance Anomaly →</a><a href="/history">Operational History →</a>');
  if(out.includes('<section class="table">'))out=out.replace('<section class="table">',card+'<section class="table">');
  return out;
}

function render(snapshot){
  const rows=(snapshot.checks||[]).map(c=>`<tr><td>${esc(c.name)}</td><td><code>${esc(c.path)}</code></td><td>${c.durationMs??'—'} ms</td><td>${c.baselineMs??'building'}</td><td>${c.ratio===null?'—':`${c.ratio}×`}</td><td>${c.sampleCount??0}</td><td>${c.anomalous?'anomaly':c.ok?'normal':'no sample'}</td><td>${esc(c.message||c.error||'')}</td></tr>`).join('');
  return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Performance Anomaly · Curator Ops</title><style>:root{color-scheme:dark;--bg:#0a1110;--panel:#101918;--brass:#bfa46a;--text:#f3eee3;--muted:#9aa6a0;--line:#263330}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Georgia,serif}.wrap{max-width:1180px;margin:auto;padding:58px 20px}.eyebrow{font:600 12px system-ui;letter-spacing:.18em;text-transform:uppercase;color:var(--brass)}h1{font-size:clamp(38px,7vw,62px);font-weight:400}.lede{max-width:880px;color:#d3d6d1;line-height:1.6}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:28px 0}.card,.table{border:1px solid var(--line);background:var(--panel);border-radius:16px}.card{padding:18px}.label{font:600 11px system-ui;color:var(--muted);text-transform:uppercase}.value{font-size:25px;margin-top:8px}.table{overflow:auto}table{width:100%;border-collapse:collapse;font:13px/1.45 system-ui}th,td{text-align:left;padding:12px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase}code,a{color:#e9d49e}@media(max-width:800px){.cards{grid-template-columns:1fr 1fr}}</style></head><body><main class="wrap"><div class="eyebrow">CuratorOS · Performance Assurance</div><h1>Performance Anomaly</h1><p class="lede">Watches successful requests for unmistakable slowdowns relative to their own recent median. It intentionally ignores small timing changes and leaves availability failures to the existing site and integrity monitors.</p><section class="cards"><div class="card"><div class="label">State</div><div class="value">${esc(snapshot.effectiveState||'warming')}</div></div><div class="card"><div class="label">Anomalies</div><div class="value">${snapshot.summary?.anomalousChecks??0}</div></div><div class="card"><div class="label">Anomaly streak</div><div class="value">${snapshot.anomalyStreak||0}</div></div><div class="card"><div class="label">Last check</div><div class="value" style="font-size:16px">${snapshot.generatedAt?formatCentral(snapshot.generatedAt):'Waiting'}</div></div></section><p class="lede">${esc(snapshot.message||'Waiting for baseline samples.')}</p><p class="lede">Threshold: at least ${RATIO_THRESHOLD}× baseline and at least ${ABSOLUTE_THRESHOLD_MS} ms, sustained for three checks before Error Bus escalation.</p><section class="table"><table><thead><tr><th>Check</th><th>Path</th><th>Current</th><th>Baseline</th><th>Ratio</th><th>Samples</th><th>State</th><th>Detail</th></tr></thead><tbody>${rows||'<tr><td colspan="8">Waiting for first samples.</td></tr>'}</tbody></table></section><p><a href="/">← Curator Ops</a> · <a href="/deployment-integrity">Deployment Integrity</a> · <a href="/browser-search-journey">Browser Search</a></p></main></body></html>`;
}

function formatCentral(value){if(!value)return'—';const d=new Date(value);if(Number.isNaN(d.getTime()))return'—';return new Intl.DateTimeFormat('en-US',{timeZone:DISPLAY_TIME_ZONE,month:'numeric',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(d)}
function escClass(v){return ['healthy','warming','observing','degraded','persistent','attention','unknown'].includes(v)?v:'unknown'}
function esc(v){return String(v??'').replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]))}
function requireBindings(env){if(!env[OPS_KV])throw new Error(`${OPS_KV} KV binding is not configured.`);if(!env[ERROR_KV])throw new Error(`${ERROR_KV} KV binding is not configured.`)}
function json(v,s=200){return new Response(JSON.stringify(v,null,2),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}})}
function html(v){return new Response(v,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})}
