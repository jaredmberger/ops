import base from './entry-v1.14.js';

const OPS_KV='CURATOR_OPS_RECORDS';
const ERROR_KV='CURATOR_ERROR_RECORDS';
const CORRELATION_KEY='incident-correlation:latest';
const OPERATIONAL_KEY='operational-state:latest';
const DRIFT_KEY='deployment-drift:latest';
const SNAPSHOT_KEY='operational-history:latest';
const DAILY_PREFIX='operational-daily:';
const DEPLOYMENT_LATEST_PREFIX='deployment:latest:';
const EVENT_PREFIX='event:';
const DISPLAY_TIME_ZONE='America/Chicago';
const HISTORY_TTL=60*60*24*400;
const DEPLOYMENT_WINDOW_MS=60*60*1000;

export default{
  async fetch(request,env,ctx){
    const u=new URL(request.url);
    if(request.method==='GET'&&u.pathname==='/api/operational-history'){
      return json({ok:true,snapshot:await readSnapshot(env)});
    }
    if(request.method==='POST'&&u.pathname==='/api/operational-history-check-now'){
      return json({ok:true,snapshot:await collect(env,'manual')});
    }
    if(request.method==='GET'&&u.pathname==='/timeline'){
      return html(render(await readSnapshot(env)));
    }
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
    ctx.waitUntil(
      collect(env,`cron:${controller?.cron||'unknown'}`)
        .catch(error=>console.error('Operational history collection failed',error))
    );
    return result;
  }
};

async function collect(env,source){
  requireBindings(env);
  const now=new Date();
  const [correlation,operational,drift,deployments,events]=await Promise.all([
    env[OPS_KV].get(CORRELATION_KEY,'json'),
    env[OPS_KV].get(OPERATIONAL_KEY,'json'),
    env[OPS_KV].get(DRIFT_KEY,'json'),
    readLatestDeployments(env),
    readOpsEvents(env)
  ]);

  await updateDailyBucket(env,now,correlation,operational);
  const days=await readDailyBuckets(env,31,now);
  const deploymentCandidates=buildDeploymentCandidates(deployments,drift);
  const activeGroups=(correlation?.activeGroups||[]).map(group=>({
    ...group,
    deploymentCorrelation:findDeploymentCorrelation(group,deploymentCandidates)
  }));

  const windows={
    hours24:summarizeWindow(days,events,1,now),
    days7:summarizeWindow(days,events,7,now),
    days30:summarizeWindow(days,events,30,now)
  };

  const temporalMatches=activeGroups.filter(g=>g.deploymentCorrelation?.match).length;
  const snapshot={
    generatedAt:now.toISOString(),
    source,
    displayTimeZone:DISPLAY_TIME_ZONE,
    historyCoverage:{
      firstDailyBucket:days.length?days[days.length-1].date:null,
      latestDailyBucket:days.length?days[0].date:null,
      daysAvailable:days.length,
      note:'Daily operational rollups begin when this history layer is deployed; older Error Bus event history is retained separately where available.'
    },
    summary:{
      currentState:correlation?.status||operational?.status||'unknown',
      activeIncidentGroups:activeGroups.length,
      groupsWithRecentDeployment:temporalMatches,
      recentDeployments:deploymentCandidates.length
    },
    windows,
    activeGroups,
    recentDeployments:deploymentCandidates.slice(0,30),
    daily:days
  };

  await env[OPS_KV].put(SNAPSHOT_KEY,JSON.stringify(snapshot));
  return snapshot;
}

async function updateDailyBucket(env,now,correlation,operational){
  const date=now.toISOString().slice(0,10);
  const key=DAILY_PREFIX+date;
  const prior=await env[OPS_KV].get(key,'json')||{
    date,samples:0,healthySamples:0,observingSamples:0,degradedSamples:0,attentionSamples:0,
    maxActiveGroups:0,maxUnderlyingIncidents:0,maxCorrelatedDuplicates:0,
    rootProblemSampleTotal:0,independentProblemSampleTotal:0,symptomSampleTotal:0,
    firstObservedAt:null,lastObservedAt:null
  };

  const state=correlation?.status||operational?.status||'unknown';
  const summary=correlation?.summary||{};
  const op=operational?.summary||{};
  const bucket={
    ...prior,
    samples:Number(prior.samples||0)+1,
    healthySamples:Number(prior.healthySamples||0)+(state==='healthy'?1:0),
    observingSamples:Number(prior.observingSamples||0)+(state==='observing'||state==='warming'?1:0),
    degradedSamples:Number(prior.degradedSamples||0)+(state==='degraded'?1:0),
    attentionSamples:Number(prior.attentionSamples||0)+(state==='attention'?1:0),
    maxActiveGroups:Math.max(Number(prior.maxActiveGroups||0),Number(summary.activeGroups||0)),
    maxUnderlyingIncidents:Math.max(Number(prior.maxUnderlyingIncidents||0),Number(summary.underlyingActiveIncidents||0)),
    maxCorrelatedDuplicates:Math.max(Number(prior.maxCorrelatedDuplicates||0),Number(summary.correlatedDuplicates||0)),
    rootProblemSampleTotal:Number(prior.rootProblemSampleTotal||0)+Number(op.rootProblems||0),
    independentProblemSampleTotal:Number(prior.independentProblemSampleTotal||0)+Number(op.independentProblems||0),
    symptomSampleTotal:Number(prior.symptomSampleTotal||0)+Number(op.downstreamSymptoms||0),
    firstObservedAt:prior.firstObservedAt||now.toISOString(),
    lastObservedAt:now.toISOString()
  };
  await env[OPS_KV].put(key,JSON.stringify(bucket),{expirationTtl:HISTORY_TTL});
}

async function readDailyBuckets(env,count,now){
  const out=[];
  for(let i=0;i<count;i++){
    const d=new Date(now.getTime()-i*24*60*60*1000);
    const date=d.toISOString().slice(0,10);
    const value=await env[OPS_KV].get(DAILY_PREFIX+date,'json');
    if(value)out.push(value);
  }
  return out;
}

async function readLatestDeployments(env){
  const listed=await env[OPS_KV].list({prefix:DEPLOYMENT_LATEST_PREFIX,limit:1000});
  const out=[];
  for(const item of listed.keys){
    const value=await env[OPS_KV].get(item.name,'json');
    if(value)out.push(value);
  }
  return out;
}

function buildDeploymentCandidates(reported,drift){
  const seen=new Map();

  for(const record of reported||[]){
    const at=record.deployedAt||record.recordedAt||null;
    if(!at)continue;
    const serviceId=slug(record.service);
    const candidate={
      source:'reported-deployment',
      serviceId,
      service:record.service||serviceId,
      commit:record.commit||null,
      version:record.version||null,
      deployedAt:at,
      environment:record.environment||null,
      provider:record.provider||null
    };
    seen.set(`${serviceId}|${candidate.commit||''}|${at}`,candidate);
  }

  for(const service of drift?.services||[]){
    const at=service.running?.cloudflareVersionTimestamp||service.github?.committedAt||null;
    if(!at)continue;
    const candidate={
      source:service.running?.cloudflareVersionTimestamp?'runtime-version':'github-head',
      serviceId:service.id,
      service:service.name,
      commit:service.running?.commit||service.github?.commit||null,
      version:service.running?.version||null,
      deployedAt:at,
      environment:'production',
      provider:service.running?.cloudflareVersionTimestamp?'cloudflare':'github'
    };
    const key=`${candidate.serviceId}|${candidate.commit||''}|${at}`;
    if(!seen.has(key))seen.set(key,candidate);
  }

  return [...seen.values()].sort((a,b)=>String(b.deployedAt||'').localeCompare(String(a.deployedAt||'')));
}

function findDeploymentCorrelation(group,candidates){
  const incidentAt=Date.parse(group.firstSeenAt||'');
  if(!Number.isFinite(incidentAt))return{match:false,reason:'Incident group has no usable first-seen timestamp.'};

  const serviceIds=groupServiceIds(group);
  const eligible=candidates
    .map(candidate=>({...candidate,deltaMs:incidentAt-Date.parse(candidate.deployedAt||'')}))
    .filter(candidate=>
      Number.isFinite(candidate.deltaMs)&&
      candidate.deltaMs>=0&&candidate.deltaMs<=DEPLOYMENT_WINDOW_MS&&
      (serviceIds.size===0||serviceIds.has(candidate.serviceId))
    )
    .sort((a,b)=>a.deltaMs-b.deltaMs);

  const best=eligible[0];
  if(!best)return{match:false,reason:'No matching deployment was observed in the 60 minutes before this incident began.'};

  return{
    match:true,
    classification:'temporal-correlation',
    causal:false,
    serviceId:best.serviceId,
    service:best.service,
    commit:best.commit,
    version:best.version,
    deployedAt:best.deployedAt,
    minutesBeforeIncident:Math.round(best.deltaMs/60000),
    source:best.source,
    note:'Temporal proximity is evidence for investigation, not proof that the deployment caused the incident.'
  };
}

function groupServiceIds(group){
  const ids=new Set();
  const anchor=String(group.anchorFindingId||'');
  for(const prefix of ['service:','deployment:','scheduled:']){
    if(anchor.startsWith(prefix))ids.add(anchor.slice(prefix.length));
  }
  for(const incident of group.incidents||[]){
    const component=String(incident.component||'');
    if(component.startsWith('reachability:'))ids.add(component.slice('reachability:'.length));
    if(component.startsWith('deployment:'))ids.add(component.slice('deployment:'.length));
    if(component.startsWith('scheduled:'))ids.add(component.slice('scheduled:'.length));
  }
  if(anchor.startsWith('monitor:'))ids.add('ops');
  return ids;
}

async function readOpsEvents(env){
  const listed=await env[ERROR_KV].list({prefix:EVENT_PREFIX,limit:1000});
  const out=[];
  for(const item of listed.keys){
    const value=await env[ERROR_KV].get(item.name,'json');
    if(!value||value.source!=='Curator Ops')continue;
    if(!['ops-incident','ops-recovery'].includes(value.kind))continue;
    out.push(value);
  }
  return out.sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')));
}

function summarizeWindow(days,events,dayCount,now){
  const cutoff=now.getTime()-dayCount*24*60*60*1000;
  const selectedDays=days.filter(d=>Date.parse(`${d.date}T23:59:59Z`)>=cutoff);
  const selectedEvents=events.filter(e=>Date.parse(e.at||'')>=cutoff);
  const samples=selectedDays.reduce((n,d)=>n+Number(d.samples||0),0);
  const healthy=selectedDays.reduce((n,d)=>n+Number(d.healthySamples||0),0);
  const observing=selectedDays.reduce((n,d)=>n+Number(d.observingSamples||0),0);
  const degraded=selectedDays.reduce((n,d)=>n+Number(d.degradedSamples||0),0);
  const attention=selectedDays.reduce((n,d)=>n+Number(d.attentionSamples||0),0);

  return{
    label:dayCount===1?'24 hours':`${dayCount} days`,
    coverageSamples:samples,
    healthyPercent:samples?Number((healthy*100/samples).toFixed(1)):null,
    observingPercent:samples?Number((observing*100/samples).toFixed(1)):null,
    degradedPercent:samples?Number((degraded*100/samples).toFixed(1)):null,
    attentionPercent:samples?Number((attention*100/samples).toFixed(1)):null,
    maxActiveGroups:selectedDays.reduce((n,d)=>Math.max(n,Number(d.maxActiveGroups||0)),0),
    maxUnderlyingIncidents:selectedDays.reduce((n,d)=>Math.max(n,Number(d.maxUnderlyingIncidents||0)),0),
    incidentEvents:selectedEvents.filter(e=>e.kind==='ops-incident').length,
    recoveryEvents:selectedEvents.filter(e=>e.kind==='ops-recovery').length
  };
}

async function readSnapshot(env){
  requireBindings(env);
  return await env[OPS_KV].get(SNAPSHOT_KEY,'json')||{
    generatedAt:null,source:null,displayTimeZone:DISPLAY_TIME_ZONE,
    historyCoverage:{firstDailyBucket:null,latestDailyBucket:null,daysAvailable:0,note:'Waiting for the first operational-history collection.'},
    summary:{currentState:'warming',activeIncidentGroups:0,groupsWithRecentDeployment:0,recentDeployments:0},
    windows:{
      hours24:{label:'24 hours',coverageSamples:0,healthyPercent:null,observingPercent:null,degradedPercent:null,attentionPercent:null,maxActiveGroups:0,maxUnderlyingIncidents:0,incidentEvents:0,recoveryEvents:0},
      days7:{label:'7 days',coverageSamples:0,healthyPercent:null,observingPercent:null,degradedPercent:null,attentionPercent:null,maxActiveGroups:0,maxUnderlyingIncidents:0,incidentEvents:0,recoveryEvents:0},
      days30:{label:'30 days',coverageSamples:0,healthyPercent:null,observingPercent:null,degradedPercent:null,attentionPercent:null,maxActiveGroups:0,maxUnderlyingIncidents:0,incidentEvents:0,recoveryEvents:0}
    },
    activeGroups:[],recentDeployments:[],daily:[]
  };
}

function inject(body,snapshot){
  const s=snapshot?.summary||{};
  const w=snapshot?.windows?.hours24||{};
  const detail=snapshot?.generatedAt
    ?`24h healthy ${w.healthyPercent??'—'}% · ${s.groupsWithRecentDeployment??0} active groups near a recent deployment · checked ${formatCentral(snapshot.generatedAt)}`
    :'Waiting for the first historical rollup.';
  const card=`<section class="ops-history-intelligence" aria-label="Operational history intelligence"><a class="ops-monitoring__card" href="/timeline"><div class="label">History Intelligence</div><div class="ops-monitoring__status"><span class="ops-monitoring__dot ${escClass(s.currentState||'warming')}"></span>${esc(s.currentState||'warming')}</div><div class="ops-monitoring__detail">${esc(detail)}</div></a></section>`;
  let out=body;
  if(out.includes('</style>'))out=out.replace('</style>','.ops-history-intelligence{margin:-8px 0 22px}.ops-history-intelligence .ops-monitoring__card{width:100%}</style>');
  out=out.replace('<a href="/history">Operational History →</a>','<a href="/timeline">History Intelligence →</a><a href="/history">Operational History →</a>');
  if(out.includes('<section class="table">'))out=out.replace('<section class="table">',card+'<section class="table">');
  return out;
}

function render(snapshot){
  const w=[snapshot.windows?.hours24,snapshot.windows?.days7,snapshot.windows?.days30].filter(Boolean);
  const cards=w.map(x=>`<div class="window"><div class="label">${esc(x.label)}</div><div class="big">${x.healthyPercent==null?'—':x.healthyPercent+'%'} healthy</div><div class="meta">${x.coverageSamples} samples · ${x.incidentEvents} incidents · ${x.recoveryEvents} recoveries · max ${x.maxActiveGroups} groups</div></div>`).join('');
  const groups=(snapshot.activeGroups||[]).map(g=>{
    const d=g.deploymentCorrelation||{};
    return`<tr><td>${esc(g.title)}</td><td>${esc(g.severity||'—')}</td><td>${d.match?esc(d.service||d.serviceId):'—'}</td><td>${d.match?esc(shortSha(d.commit)):'—'}</td><td>${d.match?`${d.minutesBeforeIncident} min`:'—'}</td><td>${esc(d.match?d.note:d.reason||'No recent deployment match.')}</td></tr>`;
  }).join('');
  const daily=(snapshot.daily||[]).map(d=>{
    const healthy=d.samples?Number((Number(d.healthySamples||0)*100/d.samples).toFixed(1)):null;
    return`<tr><td>${esc(d.date)}</td><td>${d.samples}</td><td>${healthy==null?'—':healthy+'%'}</td><td>${d.maxActiveGroups||0}</td><td>${d.maxUnderlyingIncidents||0}</td><td>${d.maxCorrelatedDuplicates||0}</td></tr>`;
  }).join('');

  return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>History Intelligence · Curator Ops</title><style>:root{color-scheme:dark;--bg:#0a1110;--panel:#101918;--brass:#bfa46a;--text:#f3eee3;--muted:#9aa6a0;--line:#263330}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Georgia,serif}.wrap{max-width:1220px;margin:auto;padding:58px 20px}.eyebrow{font:600 12px system-ui;letter-spacing:.18em;text-transform:uppercase;color:var(--brass)}h1{font-size:clamp(38px,7vw,62px);font-weight:400}.lede{max-width:920px;color:#d3d6d1;line-height:1.6}.windows{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:28px 0}.window,.table,.note{border:1px solid var(--line);background:var(--panel);border-radius:16px}.window,.note{padding:18px}.label{font:600 11px system-ui;color:var(--muted);text-transform:uppercase}.big{font-size:25px;margin:8px 0}.meta{font:12px/1.55 system-ui;color:var(--muted)}.table{overflow:auto;margin:16px 0 30px}table{width:100%;border-collapse:collapse;min-width:900px;font:13px/1.45 system-ui}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase}a,code{color:#e9d49e}h2{font-weight:400;margin-top:36px}.note{font:13px/1.55 system-ui;color:#d3d6d1}@media(max-width:800px){.windows{grid-template-columns:1fr}}</style></head><body><main class="wrap"><div class="eyebrow">CuratorOS · Historical Operations</div><h1>History Intelligence</h1><p class="lede">Tracks whether CuratorOS is actually becoming more or less stable over time and places recent deployments beside incident onset for investigation. Deployment proximity is reported as temporal evidence only; CuratorOS does not infer causation from timing alone.</p><section class="windows">${cards}</section><div class="note">${esc(snapshot.historyCoverage?.note||'')} Current daily-rollup coverage begins ${esc(snapshot.historyCoverage?.firstDailyBucket||'after first collection')}.</div><h2>Deployment correlation</h2><section class="table"><table><thead><tr><th>Incident group</th><th>Severity</th><th>Recent deployment</th><th>Commit</th><th>Before onset</th><th>Assessment</th></tr></thead><tbody>${groups||'<tr><td colspan="6">No active incident groups.</td></tr>'}</tbody></table></section><h2>Daily operational rollups</h2><section class="table"><table><thead><tr><th>Date</th><th>Samples</th><th>Healthy</th><th>Max groups</th><th>Max incidents</th><th>Max grouped duplicates</th></tr></thead><tbody>${daily||'<tr><td colspan="6">Daily history begins with the first scheduled collection.</td></tr>'}</tbody></table></section><p><a href="/">← Curator Ops</a> · <a href="/incidents">Correlated Incidents</a> · <a href="/operational-state">Operational State</a></p></main></body></html>`;
}

function shortSha(v){return v?String(v).slice(0,8):'—'}
function slug(v){return String(v??'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'unknown'}
function escClass(v){return ['healthy','warming','observing','degraded','persistent','attention','unknown'].includes(String(v))?String(v):'unknown'}
function formatCentral(value){if(!value)return'—';const d=new Date(value);if(Number.isNaN(d.getTime()))return'—';return new Intl.DateTimeFormat('en-US',{timeZone:DISPLAY_TIME_ZONE,month:'numeric',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(d)}
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function requireBindings(env){if(!env?.[OPS_KV])throw new Error(`${OPS_KV} binding is required`);if(!env?.[ERROR_KV])throw new Error(`${ERROR_KV} binding is required`)}
function json(value,status=200){return new Response(JSON.stringify(value,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}})}
function html(value){return new Response(value,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})}
