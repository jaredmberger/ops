import base from './entry-v1.9.js';

const OPS_KV='CURATOR_OPS_RECORDS';
const ERROR_KV='CURATOR_ERROR_RECORDS';
const SNAPSHOT_KEY='deployment-integrity:latest';
const STATE_KEY='deployment-integrity:state';
const INCIDENT_KEY='incident:ops-deployment-integrity';
const EVENT_PREFIX='event:';
const DISPLAY_TIME_ZONE='America/Chicago';
const RECOVERED_TTL=60*60*24*180;
const STATE_TTL=60*60*24*30;
const BASE='https://oceanliners.net';

const CHECKS=[
  {id:'homepage',name:'Homepage document',path:'/',kind:'text',contentType:'text/html',minBytes:8000,markers:['Ocean Liner Curator','/assets/nav.js','flags-logo-hero.webp'],noRedirect:true},
  {id:'nav',name:'Shared navigation script',path:'/assets/nav.js',kind:'text',contentType:'javascript',minBytes:3000,markers:['olc:header-ready','home-search.js','sitemap-search.js'],noRedirect:true},
  {id:'home-search',name:'Homepage search component',path:'/assets/home-search.js',kind:'text',contentType:'javascript',minBytes:1500,markers:['Search the archive','/tools/search/pagefind/pagefind.js','/tools/search/search-engine.js'],noRedirect:true},
  {id:'search-engine',name:'Search engine module',path:'/tools/search/search-engine.js',kind:'text',contentType:'javascript',minBytes:400,markers:['normalizeShipName','searchArchive'],noRedirect:true},
  {id:'pagefind-entry',name:'Pagefind metadata',path:'/tools/search/pagefind/pagefind-entry.json',kind:'json',contentType:'json',minBytes:40,noRedirect:true},
  {id:'hero-logo',name:'Primary hero image',path:'/flags-logo-hero.webp',kind:'binary',contentType:'image/webp',minBytes:1000,noRedirect:true},
  {id:'titanic',name:'Titanic destination',path:'/titanic',kind:'text',contentType:'text/html',minBytes:1500,markers:['Titanic'],noRedirect:true},
  {id:'ship-archive',name:'Ship Archive destination',path:'/ships/ships',kind:'text',contentType:'text/html',minBytes:1500,markers:['Ship Archive'],noRedirect:true}
];

export default{
  async fetch(request,env,ctx){
    const u=new URL(request.url);
    if(request.method==='GET'&&u.pathname==='/api/deployment-integrity')return json({ok:true,snapshot:await readSnapshot(env)});
    if(request.method==='POST'&&u.pathname==='/api/deployment-integrity-check-now')return json({ok:true,snapshot:await collect(env,'manual')});
    if(request.method==='GET'&&u.pathname==='/deployment-integrity')return html(render(await readSnapshot(env)));
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
    ctx.waitUntil(collect(env,`cron:${controller?.cron||'unknown'}`).catch(error=>console.error('Ops deployment integrity collection failed',error)));
    return result;
  }
};

async function collect(env,source){
  requireBindings(env);
  const checkedAt=new Date().toISOString();
  const prior=await env[OPS_KV].get(STATE_KEY,'json');
  const results=[];
  for(const check of CHECKS)results.push(await probe(check));

  const failures=results.filter(r=>!r.ok);
  const rawState=failures.length?'failed':'healthy';
  let failureStreak=Number(prior?.failureStreak||0);
  let firstFailureAt=prior?.firstFailureAt||null;
  let lastFailureAt=prior?.lastFailureAt||null;
  let lastHealthyAt=prior?.lastHealthyAt||null;

  if(rawState==='healthy'){
    failureStreak=0;
    firstFailureAt=null;
    lastFailureAt=null;
    lastHealthyAt=checkedAt;
  }else{
    failureStreak+=1;
    firstFailureAt=firstFailureAt||checkedAt;
    lastFailureAt=checkedAt;
  }

  const effectiveState=rawState==='healthy'?'healthy':failureStreak>=3?'persistent':failureStreak===2?'degraded':'observing';
  const message=rawState==='healthy'
    ?`All ${results.length} deployment integrity checks passed.`
    :`${failures.length} of ${results.length} integrity checks failed: ${failures.map(f=>f.name).join(', ')}.`;

  const snapshot={
    generatedAt:checkedAt,source,displayTimeZone:DISPLAY_TIME_ZONE,name:'Deployment Integrity',
    ok:effectiveState==='healthy',effectiveState,rawState,failureStreak,firstFailureAt,lastFailureAt,lastHealthyAt,
    message,checks:results,
    summary:{status:effectiveState,rawState,failedChecks:failures.length,totalChecks:results.length,failureStreak}
  };
  const state={failureStreak,firstFailureAt,lastFailureAt,lastHealthyAt,effectiveState,updatedAt:checkedAt};
  await env[OPS_KV].put(STATE_KEY,JSON.stringify(state),{expirationTtl:STATE_TTL});
  await env[OPS_KV].put(SNAPSHOT_KEY,JSON.stringify(snapshot));
  await reconcileIncident(env,snapshot);
  return snapshot;
}

async function probe(check){
  const started=Date.now();
  const url=BASE+check.path;
  try{
    const response=await fetch(url,{
      redirect:check.noRedirect?'manual':'follow',
      cf:{cacheTtl:0,cacheEverything:false},
      headers:{'user-agent':'Mozilla/5.0 (compatible; CuratorOS-Integrity/1.10; +https://ops.oceanlinercurator.com)','cache-control':'no-cache','pragma':'no-cache'}
    });
    const status=response.status;
    const type=(response.headers.get('content-type')||'').toLowerCase();
    const location=response.headers.get('location');
    if(status>=300&&status<400)return fail(check,started,status,type,`Unexpected redirect${location?` to ${location}`:''}.`);
    if(!response.ok)return fail(check,started,status,type,`HTTP ${status}.`);
    if(check.contentType&&!type.includes(check.contentType))return fail(check,started,status,type,`Expected ${check.contentType}, received ${type||'no content type'}.`);

    let bytes=0;
    if(check.kind==='binary'){
      const body=await response.arrayBuffer();
      bytes=body.byteLength;
    }else{
      const body=await response.text();
      bytes=new TextEncoder().encode(body).byteLength;
      if(/<title>\s*(?:attention required|just a moment|error)|cloudflare ray id|cf-error-details/i.test(body))return fail(check,started,status,type,'Received Cloudflare/error HTML instead of the expected asset.',bytes);
      if(check.kind==='json'){
        try{JSON.parse(body)}catch{return fail(check,started,status,type,'Response was not valid JSON.',bytes)}
      }
      for(const marker of check.markers||[]){
        if(!body.includes(marker))return fail(check,started,status,type,`Missing expected marker: ${marker}`,bytes);
      }
    }
    if(bytes<check.minBytes)return fail(check,started,status,type,`Response unexpectedly small (${bytes} bytes; minimum ${check.minBytes}).`,bytes);
    return{...identity(check),ok:true,status,contentType:type,bytes,durationMs:Date.now()-started,message:'Passed'};
  }catch(error){
    return{...identity(check),ok:false,status:null,contentType:null,bytes:null,durationMs:Date.now()-started,message:String(error?.message||error||'Fetch failed')};
  }
}

function identity(check){return{id:check.id,name:check.name,path:check.path}}
function fail(check,started,status,contentType,message,bytes=null){return{...identity(check),ok:false,status,contentType,bytes,durationMs:Date.now()-started,message}}

async function reconcileIncident(env,snapshot){
  const previous=await env[ERROR_KV].get(INCIDENT_KEY,'json');
  const active=previous&&['active','degraded'].includes(previous.status);
  const now=new Date().toISOString();
  if(snapshot.effectiveState==='persistent'){
    const failed=snapshot.checks.filter(c=>!c.ok).map(c=>({id:c.id,path:c.path,status:c.status,message:c.message}));
    const incident={
      id:previous?.id||'incident_ops-deployment-integrity',fingerprint:'ops-deployment-integrity',source:'Curator Ops',component:'public-site:deployment-integrity',severity:'p2',type:'ops-deployment-integrity-persistent-failure',
      message:`Deployment integrity has failed ${snapshot.failureStreak} consecutive checks.`,
      context:{failureStreak:snapshot.failureStreak,failedChecks:failed},
      firstSeenAt:active?(previous.firstSeenAt||now):now,lastSeenAt:now,occurrences:active?Math.max(1,Number(previous.occurrences||0)+1):1,status:'active',recoveredAt:null,recoveryMessage:null,lastSuccessfulAt:previous?.lastSuccessfulAt||null
    };
    await env[ERROR_KV].put(INCIDENT_KEY,JSON.stringify(incident));
    if(!active)await writeEvent(env,'ops-incident',incident);
    return;
  }
  if(active&&snapshot.effectiveState==='healthy'){
    const recovered={...previous,status:'recovered',recoveredAt:now,lastSuccessfulAt:now,recoveryMessage:'All deployment integrity checks are passing again.'};
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
  return await env[OPS_KV].get(SNAPSHOT_KEY,'json')||{generatedAt:null,source:null,displayTimeZone:DISPLAY_TIME_ZONE,name:'Deployment Integrity',ok:null,effectiveState:'warming',rawState:'warming',failureStreak:0,firstFailureAt:null,lastFailureAt:null,lastHealthyAt:null,message:'Waiting for first integrity check.',checks:[],summary:{status:'warming',rawState:'warming',failedChecks:0,totalChecks:CHECKS.length,failureStreak:0}};
}

function inject(body,snapshot){
  const state=String(snapshot?.effectiveState||'warming');
  const checked=snapshot?.generatedAt?formatCentral(snapshot.generatedAt):'waiting';
  const detail=`${snapshot?.message||'Waiting for integrity check.'} · Ops checked ${checked}`;
  const card=`<section class="ops-integrity-monitor" aria-label="Deployment integrity monitoring"><a class="ops-monitoring__card" href="/deployment-integrity"><div class="label">Deployment Integrity</div><div class="ops-monitoring__status"><span class="ops-monitoring__dot ${escClass(state)}"></span>${esc(state)}</div><div class="ops-monitoring__detail">${esc(detail)}</div></a></section>`;
  let out=body;
  if(out.includes('</style>'))out=out.replace('</style>','.ops-integrity-monitor{margin:-8px 0 22px}.ops-integrity-monitor .ops-monitoring__card{width:100%}</style>');
  out=out.replace('<a href="/history">Operational History →</a>','<a href="/deployment-integrity">Deployment Integrity →</a><a href="/history">Operational History →</a>');
  if(out.includes('<section class="table">'))out=out.replace('<section class="table">',card+'<section class="table">');
  return out;
}

function render(snapshot){
  const rows=(snapshot.checks||[]).map(c=>`<tr><td>${esc(c.name)}</td><td><code>${esc(c.path)}</code></td><td>${c.ok?'pass':'fail'}</td><td>${c.status??'—'}</td><td>${c.bytes??'—'}</td><td>${c.durationMs??'—'} ms</td><td>${esc(c.message||'')}</td></tr>`).join('');
  return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deployment Integrity · Curator Ops</title><style>:root{color-scheme:dark;--bg:#0a1110;--panel:#101918;--brass:#bfa46a;--text:#f3eee3;--muted:#9aa6a0;--line:#263330}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Georgia,serif}.wrap{max-width:1180px;margin:auto;padding:58px 20px}.eyebrow{font:600 12px system-ui;letter-spacing:.18em;text-transform:uppercase;color:var(--brass)}h1{font-size:clamp(38px,7vw,62px);font-weight:400}.lede{max-width:850px;color:#d3d6d1;line-height:1.6}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:28px 0}.card,.table{border:1px solid var(--line);background:var(--panel);border-radius:16px}.card{padding:18px}.label{font:600 11px system-ui;color:var(--muted);text-transform:uppercase}.value{font-size:25px;margin-top:8px}.table{overflow:auto}table{width:100%;border-collapse:collapse;font:13px/1.45 system-ui}th,td{text-align:left;padding:12px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase}code{color:#e9d49e}a{color:#e9d49e}@media(max-width:800px){.cards{grid-template-columns:1fr 1fr}}</style></head><body><main class="wrap"><div class="eyebrow">CuratorOS · Deployment Assurance</div><h1>Deployment Integrity</h1><p class="lede">Checks critical public-site documents and assets for correct status, type, size, expected markers, accidental redirects, malformed JSON, and Cloudflare/error pages masquerading as successful responses.</p><section class="cards"><div class="card"><div class="label">State</div><div class="value">${esc(snapshot.effectiveState||'warming')}</div></div><div class="card"><div class="label">Failed checks</div><div class="value">${snapshot.summary?.failedChecks??0}</div></div><div class="card"><div class="label">Failure streak</div><div class="value">${snapshot.failureStreak||0}</div></div><div class="card"><div class="label">Last check</div><div class="value" style="font-size:16px">${snapshot.generatedAt?formatCentral(snapshot.generatedAt):'Waiting'}</div></div></section><p class="lede">${esc(snapshot.message||'Waiting for first integrity check.')}</p><section class="table"><table><thead><tr><th>Check</th><th>Path</th><th>Result</th><th>HTTP</th><th>Bytes</th><th>Time</th><th>Detail</th></tr></thead><tbody>${rows||'<tr><td colspan="7">Waiting for first check.</td></tr>'}</tbody></table></section><p><a href="/">← Curator Ops</a> · <a href="/journey">Visitor Journey</a> · <a href="/browser-search-journey">Browser Search</a> · <a href="/self-test">Self-Test</a></p></main></body></html>`;
}

function formatCentral(value){if(!value)return'—';const d=new Date(value);if(Number.isNaN(d.getTime()))return'—';return new Intl.DateTimeFormat('en-US',{timeZone:DISPLAY_TIME_ZONE,month:'numeric',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(d)}
function escClass(v){return ['healthy','warming','observing','degraded','persistent','attention','unknown'].includes(v)?v:'unknown'}
function esc(v){return String(v??'').replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]))}
function requireBindings(env){if(!env[OPS_KV])throw new Error(`${OPS_KV} KV binding is not configured.`);if(!env[ERROR_KV])throw new Error(`${ERROR_KV} KV binding is not configured.`)}
function json(v,s=200){return new Response(JSON.stringify(v,null,2),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}})}
function html(v){return new Response(v,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})}
