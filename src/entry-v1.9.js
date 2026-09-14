import base from './entry-v1.8.js';

const OPS_KV='CURATOR_OPS_RECORDS';
const ERROR_KV='CURATOR_ERROR_RECORDS';
const BROWSER_KEY='browser-search-journey:latest';
const BROWSER_STATE_KEY='browser-search-journey:state';
const INCIDENT_KEY='incident:ops-browser-search-journey';
const EVENT_PREFIX='event:';
const WORKFLOW_RUNS_URL='https://api.github.com/repos/jaredmberger/ops/actions/workflows/browser-search-journey.yml/runs?branch=main&per_page=1';
const STALE_AFTER_MS=45*60*1000;
const RECOVERED_TTL=60*60*24*180;
const DISPLAY_TIME_ZONE='America/Chicago';

export default{
  async fetch(request,env,ctx){
    const u=new URL(request.url);
    if(request.method==='GET'&&u.pathname==='/api/browser-search-journey')return json({ok:true,snapshot:await readSnapshot(env)});
    if(request.method==='POST'&&u.pathname==='/api/browser-search-journey-check-now')return json({ok:true,snapshot:await collect(env,'manual')});
    if(request.method==='GET'&&u.pathname==='/browser-search-journey')return html(render(await readSnapshot(env)));
    if(request.method==='GET'&&u.pathname==='/'){
      const response=await base.fetch(request,env,ctx);
      const contentType=response.headers.get('content-type')||'';
      if(!contentType.includes('text/html'))return response;
      const snapshot=await readSnapshot(env);
      const body=await response.text();
      const output=injectBrowserStatus(body,snapshot);
      const headers=new Headers(response.headers);
      headers.delete('content-length');
      return new Response(output,{status:response.status,statusText:response.statusText,headers});
    }
    return base.fetch(request,env,ctx);
  },
  async scheduled(controller,env,ctx){
    const result=base.scheduled(controller,env,ctx);
    ctx.waitUntil(collect(env,`cron:${controller?.cron||'unknown'}`).catch(error=>console.error('Ops browser search journey collection failed',error)));
    return result;
  }
};

async function collect(env,source){
  requireBindings(env);
  const checkedAt=new Date().toISOString();
  const prior=await env[OPS_KV].get(BROWSER_STATE_KEY,'json');
  let run=null;
  let fetchError=null;
  try{
    const headers={
      accept:'application/vnd.github+json',
      'user-agent':'CuratorOps-BrowserJourney/1.9 (+https://ops.oceanlinercurator.com)',
      'x-github-api-version':'2022-11-28'
    };
    if(env.GITHUB_OPS_TOKEN)headers.authorization=`Bearer ${env.GITHUB_OPS_TOKEN}`;
    const response=await fetch(WORKFLOW_RUNS_URL,{headers});
    if(!response.ok){
      const remaining=response.headers.get('x-ratelimit-remaining');
      const reset=response.headers.get('x-ratelimit-reset');
      const rateDetail=remaining!==null?` · rate remaining ${remaining}${reset?` · reset ${new Date(Number(reset)*1000).toISOString()}`:''}`:'';
      throw new Error(`GitHub Actions API HTTP ${response.status}${rateDetail}`);
    }
    const payload=await response.json();
    run=payload?.workflow_runs?.[0]||null;
  }catch(error){
    fetchError=String(error?.message||error||'GitHub Actions API fetch failed');
  }

  const assessed=assessRun(run,fetchError,checkedAt);
  const runId=run?.id?String(run.id):null;
  let failureStreak=Number(prior?.failureStreak||0);
  let firstFailureAt=prior?.firstFailureAt||null;
  let lastFailureAt=prior?.lastFailureAt||null;
  let lastHealthyAt=prior?.lastHealthyAt||null;
  let lastProcessedRunId=prior?.lastProcessedRunId||null;
  let stalePollStreak=Number(prior?.stalePollStreak||0);

  if(assessed.rawState==='healthy'){
    failureStreak=0;
    firstFailureAt=null;
    lastFailureAt=null;
    lastHealthyAt=checkedAt;
    stalePollStreak=0;
    if(runId)lastProcessedRunId=runId;
  }else if(assessed.rawState==='failed'){
    stalePollStreak=0;
    if(runId&&runId!==lastProcessedRunId){
      failureStreak+=1;
      firstFailureAt=firstFailureAt||checkedAt;
      lastFailureAt=checkedAt;
      lastProcessedRunId=runId;
    }
  }else if(assessed.rawState==='stale'||assessed.rawState==='unreachable'){
    stalePollStreak+=1;
    if(stalePollStreak===1){
      firstFailureAt=firstFailureAt||checkedAt;
      lastFailureAt=checkedAt;
    }
  }else{
    stalePollStreak=0;
  }

  let effectiveState='warming';
  if(assessed.rawState==='healthy')effectiveState='healthy';
  else if(assessed.rawState==='pending')effectiveState='observing';
  else if(assessed.rawState==='failed')effectiveState=failureStreak>=3?'persistent':failureStreak===2?'degraded':'observing';
  else if(assessed.rawState==='stale'||assessed.rawState==='unreachable')effectiveState=stalePollStreak>=3?'persistent':stalePollStreak===2?'degraded':'observing';

  const snapshot={
    generatedAt:checkedAt,
    source,
    displayTimeZone:DISPLAY_TIME_ZONE,
    name:'Browser Search Journey',
    ok:effectiveState==='healthy',
    effectiveState,
    failureStreak,
    stalePollStreak,
    firstFailureAt,
    lastFailureAt,
    lastHealthyAt,
    assessment:assessed,
    run:run?{
      id:run.id,
      status:run.status,
      conclusion:run.conclusion,
      event:run.event,
      htmlUrl:run.html_url,
      createdAt:run.created_at,
      startedAt:run.run_started_at,
      updatedAt:run.updated_at,
      headSha:run.head_sha
    }:null,
    summary:{status:effectiveState,rawState:assessed.rawState,consecutiveFailedRuns:failureStreak,stalePollStreak}
  };

  const state={failureStreak,stalePollStreak,firstFailureAt,lastFailureAt,lastHealthyAt,lastProcessedRunId,effectiveState,updatedAt:checkedAt};
  await env[OPS_KV].put(BROWSER_STATE_KEY,JSON.stringify(state),{expirationTtl:60*60*24*30});
  await env[OPS_KV].put(BROWSER_KEY,JSON.stringify(snapshot));
  await reconcileIncident(env,snapshot);
  return snapshot;
}

function assessRun(run,fetchError,now){
  if(fetchError)return{rawState:'unreachable',message:fetchError,ageMinutes:null};
  if(!run)return{rawState:'warming',message:'No browser journey run has been recorded yet.',ageMinutes:null};
  const anchor=Date.parse(run.updated_at||run.created_at||'');
  const ageMs=Number.isFinite(anchor)?Date.parse(now)-anchor:NaN;
  const ageMinutes=Number.isFinite(ageMs)?Math.max(0,Math.round(ageMs/60000)):null;
  if(Number.isFinite(ageMs)&&ageMs>STALE_AFTER_MS)return{rawState:'stale',message:`Latest browser journey is stale (${ageMinutes} minutes old).`,ageMinutes};
  if(run.status!=='completed')return{rawState:'pending',message:`Browser journey is ${run.status||'in progress'}.`,ageMinutes};
  if(run.conclusion==='success')return{rawState:'healthy',message:'Latest real-browser homepage search journey passed.',ageMinutes};
  return{rawState:'failed',message:`Latest browser journey concluded ${run.conclusion||'without success'}.`,ageMinutes};
}

async function reconcileIncident(env,snapshot){
  const previous=await env[ERROR_KV].get(INCIDENT_KEY,'json');
  const active=previous&&['active','degraded'].includes(previous.status);
  const now=new Date().toISOString();
  if(snapshot.effectiveState==='persistent'){
    const incident={
      id:previous?.id||'incident_ops-browser-search-journey',
      fingerprint:'ops-browser-search-journey',
      source:'Curator Ops',
      component:'synthetic:browser-search',
      severity:'p1',
      type:'ops-browser-search-persistent-failure',
      message:snapshot.assessment?.rawState==='failed'?`Browser Search Journey has failed ${snapshot.failureStreak} separate runs.`:'Browser Search Journey is no longer reporting fresh results.',
      context:{rawState:snapshot.assessment?.rawState||null,failureStreak:snapshot.failureStreak,stalePollStreak:snapshot.stalePollStreak,runId:snapshot.run?.id||null,conclusion:snapshot.run?.conclusion||null,runUrl:snapshot.run?.htmlUrl||null,assessment:snapshot.assessment?.message||null},
      firstSeenAt:active?(previous.firstSeenAt||now):now,
      lastSeenAt:now,
      occurrences:active?Math.max(1,Number(previous.occurrences||0)+1):1,
      status:'active',recoveredAt:null,recoveryMessage:null,lastSuccessfulAt:previous?.lastSuccessfulAt||null
    };
    await env[ERROR_KV].put(INCIDENT_KEY,JSON.stringify(incident));
    if(!active)await writeEvent(env,'ops-incident',incident);
    return;
  }
  if(active&&snapshot.effectiveState==='healthy'){
    const recovered={...previous,status:'recovered',recoveredAt:now,lastSuccessfulAt:now,recoveryMessage:'A fresh real-browser search journey completed successfully.'};
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
  return await env[OPS_KV].get(BROWSER_KEY,'json')||{generatedAt:null,source:null,displayTimeZone:DISPLAY_TIME_ZONE,name:'Browser Search Journey',ok:null,effectiveState:'warming',failureStreak:0,stalePollStreak:0,firstFailureAt:null,lastFailureAt:null,lastHealthyAt:null,assessment:{rawState:'warming',message:'Waiting for first browser journey run.',ageMinutes:null},run:null,summary:{status:'warming',rawState:'warming',consecutiveFailedRuns:0,stalePollStreak:0}};
}

function injectBrowserStatus(body,snapshot){
  const state=String(snapshot?.effectiveState||'warming');
  const checked=snapshot?.generatedAt?formatCentral(snapshot.generatedAt):'waiting';
  const detail=`${snapshot?.assessment?.message||'Waiting for browser check.'} · Ops checked ${checked}`;
  const card=`<section class="ops-browser-monitor" aria-label="Real browser monitoring"><a class="ops-monitoring__card" href="/browser-search-journey"><div class="label">Browser Search Journey</div><div class="ops-monitoring__status"><span class="ops-monitoring__dot ${escClass(state)}"></span>${esc(state)}</div><div class="ops-monitoring__detail">${esc(detail)}</div></a></section>`;
  let out=body;
  if(out.includes('</style>'))out=out.replace('</style>','.ops-browser-monitor{margin:-8px 0 22px}.ops-browser-monitor .ops-monitoring__card{width:100%}</style>');
  out=out.replace('<a href="/history">Operational History →</a>','<a href="/browser-search-journey">Browser Search Journey →</a><a href="/history">Operational History →</a>');
  if(out.includes('<section class="table">'))out=out.replace('<section class="table">',card+'<section class="table">');
  return out;
}

function render(snapshot){
  const run=snapshot.run||{};
  const a=snapshot.assessment||{};
  return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser Search Journey · Curator Ops</title><style>:root{color-scheme:dark;--bg:#0a1110;--panel:#101918;--brass:#bfa46a;--text:#f3eee3;--muted:#9aa6a0;--line:#263330}*{box-sizing:border-box}body{margin:0;background:#0a1110;color:var(--text);font-family:Georgia,serif}.wrap{max-width:1100px;margin:auto;padding:58px 20px}.eyebrow{font:600 12px system-ui;letter-spacing:.18em;text-transform:uppercase;color:var(--brass)}h1{font-size:clamp(38px,7vw,62px);font-weight:400}.lede{max-width:820px;color:#d3d6d1;line-height:1.6}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:28px 0}.card,.detail{border:1px solid var(--line);background:var(--panel);border-radius:16px}.card{padding:18px}.label{font:600 11px system-ui;color:var(--muted);text-transform:uppercase}.value{font-size:26px;margin-top:8px}.detail{padding:20px;font:14px/1.65 system-ui}.detail dl{display:grid;grid-template-columns:180px 1fr;gap:10px 18px;margin:0}.detail dt{color:var(--muted)}.detail dd{margin:0;overflow-wrap:anywhere}a{color:#e9d49e}@media(max-width:800px){.cards{grid-template-columns:1fr 1fr}.detail dl{grid-template-columns:1fr}}</style></head><body><main class="wrap"><div class="eyebrow">CuratorOS · Real Browser Synthetic</div><h1>Browser Search Journey</h1><p class="lede">A scheduled Chromium browser opens OceanLiners.net, finds the homepage archive search, searches for “Titanic,” confirms a Titanic result renders, and verifies that result points to a valid OceanLiners.net Titanic destination.</p><section class="cards"><div class="card"><div class="label">State</div><div class="value">${esc(snapshot.effectiveState||'warming')}</div></div><div class="card"><div class="label">Raw result</div><div class="value">${esc(a.rawState||'warming')}</div></div><div class="card"><div class="label">Failed runs</div><div class="value">${snapshot.failureStreak||0}</div></div><div class="card"><div class="label">Last Ops poll</div><div class="value" style="font-size:17px">${snapshot.generatedAt?formatCentral(snapshot.generatedAt):'Waiting'}</div></div></section><section class="detail"><dl><dt>Assessment</dt><dd>${esc(a.message||'Waiting for first run.')}</dd><dt>Workflow status</dt><dd>${esc(run.status||'—')}</dd><dt>Conclusion</dt><dd>${esc(run.conclusion||'—')}</dd><dt>Workflow run</dt><dd>${run.htmlUrl?`<a href="${esc(run.htmlUrl)}">Open GitHub Actions run →</a>`:'—'}</dd><dt>Run updated</dt><dd>${run.updatedAt?formatCentral(run.updatedAt):'—'}</dd><dt>Commit</dt><dd>${esc(run.headSha||'—')}</dd></dl></section><p><a href="/">← Curator Ops</a> · <a href="/journey">Worker-level Public Site Journey</a> · <a href="/self-test">Self-Test</a></p></main></body></html>`;
}

function formatCentral(value){if(!value)return'—';const d=new Date(value);if(Number.isNaN(d.getTime()))return'—';return new Intl.DateTimeFormat('en-US',{timeZone:DISPLAY_TIME_ZONE,month:'numeric',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(d)}
function escClass(v){return ['healthy','warming','observing','degraded','persistent','attention','unknown'].includes(v)?v:'unknown'}
function esc(v){return String(v??'').replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]))}
function requireBindings(env){if(!env[OPS_KV])throw new Error(`${OPS_KV} KV binding is not configured.`);if(!env[ERROR_KV])throw new Error(`${ERROR_KV} KV binding is not configured.`)}
function json(v,s=200){return new Response(JSON.stringify(v,null,2),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}})}
function html(v){return new Response(v,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})}