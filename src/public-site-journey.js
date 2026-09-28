import base from './entry-v1.5.js';

const OPS_KV='CURATOR_OPS_RECORDS';
const JOURNEY_KEY='public-site-journey:latest';
const JOURNEY_STATE_KEY='public-site-journey:state';
const JOURNEY_HISTORY_PREFIX='public-site-journey:';
const REQUEST_TIMEOUT_MS=10000;
const DISPLAY_TIME_ZONE='America/Chicago';

const STEPS=[
  {id:'homepage',name:'Homepage HTML',url:'https://oceanliners.net/',markers:['Ocean Liner Curator','/assets/nav.js'],minBytes:1500},
  {id:'nav-loader',name:'Shared navigation loader',url:'https://oceanliners.net/assets/nav.js',markers:['home-search.js','sitemap-search.js'],minBytes:1000},
  {id:'home-search',name:'Homepage search component',url:'https://oceanliners.net/assets/home-search.js',markers:['/tools/search/pagefind/pagefind.js','/tools/search/search-engine.js','Search the archive'],minBytes:1500},
  {id:'pagefind-runtime',name:'Pagefind runtime',url:'https://oceanliners.net/tools/search/pagefind/pagefind.js',markers:[],minBytes:500},
  {id:'search-page',name:'Standalone search page',url:'https://oceanliners.net/tools/search/',markers:['Search','search.js'],minBytes:800},
  {id:'titanic-destination',name:'Titanic destination',url:'https://oceanliners.net/titanic',markers:['RMS Titanic'],minBytes:1500}
];

export default{
  async fetch(request,env,ctx){
    const u=new URL(request.url);
    if(request.method==='GET'&&u.pathname==='/api/public-site-journey')return json({ok:true,snapshot:await readJourney(env)});
    if(request.method==='POST'&&u.pathname==='/api/public-site-journey-check-now')return json({ok:true,snapshot:await runJourney(env,'manual')});
    if(request.method==='GET'&&u.pathname==='/journey')return html(renderJourney(await readJourney(env)));
    return base.fetch(request,env,ctx);
  },
  async scheduled(controller,env,ctx){
    const result=base.scheduled(controller,env,ctx);
    ctx.waitUntil(runJourney(env,`cron:${controller?.cron||'unknown'}`).catch(e=>console.error('Ops public-site journey failed',e)));
    return result;
  }
};

async function runJourney(env,source){
  requireKv(env);
  const steps=[];
  for(const step of STEPS)steps.push(await probeStep(step));
  const rawOk=steps.every(s=>s.ok);
  const now=new Date().toISOString();
  const prior=await env[OPS_KV].get(JOURNEY_STATE_KEY,'json');
  const failureStreak=rawOk?0:Number(prior?.failureStreak||0)+1;
  const firstFailureAt=rawOk?null:(prior?.firstFailureAt||now);
  const lastFailureAt=rawOk?null:now;
  const effectiveState=rawOk?'healthy':failureStreak===1?'observing':failureStreak===2?'degraded':'persistent';
  const failedSteps=steps.filter(s=>!s.ok).map(s=>s.id);
  const state={failureStreak,firstFailureAt,lastFailureAt,lastHealthyAt:rawOk?now:(prior?.lastHealthyAt||null),effectiveState,updatedAt:now};
  const snapshot={
    generatedAt:now,
    source,
    displayTimeZone:DISPLAY_TIME_ZONE,
    name:'Public Site Journey',
    ok:rawOk,
    effectiveState,
    failureStreak,
    firstFailureAt,
    lastFailureAt,
    lastHealthyAt:state.lastHealthyAt,
    summary:{total:steps.length,passed:steps.filter(s=>s.ok).length,failed:failedSteps.length,failedSteps,status:effectiveState},
    steps
  };
  await env[OPS_KV].put(JOURNEY_STATE_KEY,JSON.stringify(state),{expirationTtl:60*60*24*30});
  await env[OPS_KV].put(JOURNEY_KEY,JSON.stringify(snapshot));
  const ts=Date.parse(now)||Date.now();
  await env[OPS_KV].put(`${JOURNEY_HISTORY_PREFIX}${String(9999999999999-ts).padStart(13,'0')}:${crypto.randomUUID()}`,JSON.stringify(snapshot),{expirationTtl:60*60*24*30});
  return snapshot;
}

async function probeStep(step){
  const started=Date.now();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
  let status=null,finalUrl=null,contentType=null,bytes=0;
  try{
    const target=new URL(step.url);
    target.searchParams.set('opsJourney',Date.now().toString());
    const response=await fetch(target.href,{method:'GET',redirect:'follow',cache:'no-store',headers:{'user-agent':'CuratorOps-Journey/1.6 (+https://ops.oceanlinercurator.com)',accept:'text/html,application/javascript,text/javascript,*/*;q=0.8'},signal:controller.signal});
    status=response.status;
    finalUrl=response.url;
    contentType=response.headers.get('content-type');
    const body=await response.text();
    bytes=new TextEncoder().encode(body).length;
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    if(step.minBytes&&bytes<step.minBytes)throw new Error(`response too small: ${bytes} bytes`);
    for(const marker of step.markers||[]){if(!body.includes(marker))throw new Error(`expected marker missing: ${marker}`)}
    return{id:step.id,name:step.name,url:step.url,ok:true,status,finalUrl,contentType,bytes,error:null,durationMs:Date.now()-started,checkedAt:new Date().toISOString()};
  }catch(error){
    return{id:step.id,name:step.name,url:step.url,ok:false,status,finalUrl,contentType,bytes,error:error?.name==='AbortError'?'timeout':String(error?.message||error||'journey step failed'),durationMs:Date.now()-started,checkedAt:new Date().toISOString()};
  }finally{clearTimeout(timer)}
}

async function readJourney(env){
  requireKv(env);
  return await env[OPS_KV].get(JOURNEY_KEY,'json')||{
    generatedAt:null,source:null,displayTimeZone:DISPLAY_TIME_ZONE,name:'Public Site Journey',ok:null,effectiveState:'warming',failureStreak:0,firstFailureAt:null,lastFailureAt:null,lastHealthyAt:null,
    summary:{total:STEPS.length,passed:0,failed:0,failedSteps:[],status:'warming'},
    steps:STEPS.map(s=>({id:s.id,name:s.name,url:s.url,ok:null,status:null,error:null}))
  };
}

function renderJourney(snapshot){
  const rows=(snapshot.steps||[]).map(s=>`<tr><td><span class="dot ${s.ok===true?'healthy':s.ok===false?'attention':'unknown'}"></span>${esc(s.name)}</td><td>${s.ok===true?'pass':s.ok===false?'fail':'waiting'}</td><td>${s.status??'—'}</td><td>${s.bytes??'—'}</td><td>${s.durationMs!=null?`${s.durationMs} ms`:'—'}</td><td>${esc(s.error||'—')}</td></tr>`).join('');
  const x=snapshot.summary||{};
  return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Public Site Journey · Curator Ops</title><style>:root{color-scheme:dark;--bg:#0a1110;--panel:#101918;--brass:#bfa46a;--text:#f3eee3;--muted:#9aa6a0;--line:#263330}*{box-sizing:border-box}body{margin:0;background:#0a1110;color:var(--text);font-family:Georgia,serif}.wrap{max-width:1220px;margin:auto;padding:58px 20px}.eyebrow{font:600 12px system-ui;letter-spacing:.18em;text-transform:uppercase;color:var(--brass)}h1{font-size:clamp(38px,7vw,62px);font-weight:400}.lede{max-width:820px;color:#d3d6d1;line-height:1.6}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:28px 0}.card,.table{border:1px solid var(--line);background:var(--panel);border-radius:16px}.card{padding:18px}.label{font:600 11px system-ui;color:var(--muted);text-transform:uppercase}.value{font-size:28px;margin-top:8px}.table{overflow:auto}table{width:100%;border-collapse:collapse;min-width:980px;font:14px system-ui}th,td{text-align:left;padding:14px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:9px}.healthy{background:#58c77a}.attention{background:#d86666}.unknown{background:#8b9490}a{color:#e9d49e}.tz{color:var(--muted);font:12px system-ui}@media(max-width:800px){.cards{grid-template-columns:1fr 1fr}}</style></head><body><main class="wrap"><div class="eyebrow">CuratorOS · Synthetic Monitoring</div><h1>Public Site Journey</h1><p class="lede">Checks the served feature chain a visitor depends on: homepage, shared navigation loader, homepage search component, Pagefind runtime, standalone search page, and the Titanic destination.</p><p class="tz">One failed run is observed quietly; two becomes degraded; three consecutive failures become persistent and eligible for Error Bus escalation.</p><section class="cards"><div class="card"><div class="label">State</div><div class="value">${esc(snapshot.effectiveState||'warming')}</div></div><div class="card"><div class="label">Passed</div><div class="value">${x.passed||0}/${x.total||STEPS.length}</div></div><div class="card"><div class="label">Failure streak</div><div class="value">${snapshot.failureStreak||0}</div></div><div class="card"><div class="label">Last check</div><div class="value" style="font-size:17px">${snapshot.generatedAt?formatCentral(snapshot.generatedAt):'Waiting'}</div></div></section><section class="table"><table><thead><tr><th>Step</th><th>Result</th><th>HTTP</th><th>Bytes</th><th>Duration</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table></section><p><a href="/">← Curator Ops</a> · <a href="/history">Operational History</a></p></main></body></html>`;
}

function formatCentral(value){if(!value)return'—';const d=new Date(value);if(Number.isNaN(d.getTime()))return'—';return new Intl.DateTimeFormat('en-US',{timeZone:DISPLAY_TIME_ZONE,month:'numeric',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(d)}
function esc(v){return String(v??'').replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]))}
function requireKv(env){if(!env[OPS_KV])throw new Error(`${OPS_KV} KV binding is not configured.`)}
function json(v,s=200){return new Response(JSON.stringify(v,null,2),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}})}
function html(v){return new Response(v,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})}
