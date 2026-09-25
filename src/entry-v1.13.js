import base from './entry-v1.12.js';

const OPS_KV='CURATOR_OPS_RECORDS';
const SNAPSHOT_KEY='operational-state:latest';
const HISTORY_PREFIX='operational-state:';
const DISPLAY_TIME_ZONE='America/Chicago';
const REQUEST_TIMEOUT_MS=10000;
const HISTORY_TTL=60*60*24*180;

const SOURCES=[
  {id:'reachability',name:'Fleet Reachability',key:'snapshot:latest',maxAgeMinutes:15},
  {id:'deployment-drift',name:'Deployment Drift',key:'deployment-drift:latest',maxAgeMinutes:20},
  {id:'scheduled-freshness',name:'Scheduled Work',key:'scheduled-freshness:latest',maxAgeMinutes:20},
  {id:'public-site-journey',name:'Public Site Journey',key:'public-site-journey:latest',maxAgeMinutes:20},
  {id:'self-test',name:'CuratorOS Self-Test',key:'self-test:latest',maxAgeMinutes:20},
  {id:'browser-search-journey',name:'Browser Search Journey',key:'browser-search-journey:latest',maxAgeMinutes:20},
  {id:'deployment-integrity',name:'Deployment Integrity',key:'deployment-integrity:latest',maxAgeMinutes:20},
  {id:'performance-anomaly',name:'Performance Anomaly',key:'performance-anomaly:latest',maxAgeMinutes:20},
  {id:'browser-dispatch-supervisor',name:'Browser Dispatch Supervisor',key:'browser-search-dispatch-supervisor:latest',maxAgeMinutes:20}
];

const REPOSITORY_INTEGRITY_URL='https://oceanliners.net/api/device/curatoros-integrity.json';

export default{
  async fetch(request,env,ctx){
    const u=new URL(request.url);
    if(request.method==='GET'&&u.pathname==='/api/operational-state'){
      return json({ok:true,snapshot:await readSnapshot(env)});
    }
    if(request.method==='POST'&&u.pathname==='/api/operational-state-check-now'){
      return json({ok:true,snapshot:await collect(env,'manual')});
    }
    if(request.method==='GET'&&u.pathname==='/operational-state'){
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
        .catch(error=>console.error('Operational-state collection failed',error))
    );
    return result;
  }
};

async function collect(env,source){
  requireKv(env);
  const now=new Date();
  const entries=await Promise.all(SOURCES.map(async config=>{
    const value=await env[OPS_KV].get(config.key,'json');
    return assessSource(config,value,now);
  }));

  const byId=Object.fromEntries(entries.map(entry=>[entry.id,entry]));
  const repositoryIntegrity=await fetchRepositoryIntegrity();
  const findings=buildFindings(byId,repositoryIntegrity);

  const roots=findings.filter(x=>x.role==='root');
  const independent=findings.filter(x=>x.role==='independent');
  const symptoms=findings.filter(x=>x.role==='symptom');
  const staleSources=entries.filter(x=>x.freshnessState!=='fresh');

  const status=
    roots.some(x=>x.severity==='attention')||independent.some(x=>x.severity==='attention')?'attention':
    roots.length||independent.length||symptoms.length||staleSources.length?'degraded':'healthy';

  const snapshot={
    generatedAt:now.toISOString(),
    source,
    displayTimeZone:DISPLAY_TIME_ZONE,
    status,
    summary:{
      sources:SOURCES.length+1,
      freshSources:entries.filter(x=>x.freshnessState==='fresh').length+(repositoryIntegrity.state==='healthy'?1:0),
      staleSources:staleSources.length+(repositoryIntegrity.state==='unreachable'?1:0),
      rootProblems:roots.length,
      independentProblems:independent.length,
      downstreamSymptoms:symptoms.length,
      activeFindings:findings.length
    },
    sources:entries,
    repositoryIntegrity,
    findings
  };

  await env[OPS_KV].put(SNAPSHOT_KEY,JSON.stringify(snapshot));
  const ts=Date.parse(snapshot.generatedAt)||Date.now();
  await env[OPS_KV].put(
    `${HISTORY_PREFIX}${String(9999999999999-ts).padStart(13,'0')}:${crypto.randomUUID()}`,
    JSON.stringify(snapshot),
    {expirationTtl:HISTORY_TTL}
  );
  return snapshot;
}

function assessSource(config,value,now){
  const generatedAt=value?.generatedAt||null;
  const generatedMs=generatedAt?Date.parse(generatedAt):NaN;
  const ageMinutes=Number.isFinite(generatedMs)?Math.max(0,Math.round((now.getTime()-generatedMs)/60000)):null;
  const freshnessState=
    !value||!generatedAt?'missing':
    ageMinutes>config.maxAgeMinutes?'stale':'fresh';

  return{
    id:config.id,
    name:config.name,
    key:config.key,
    generatedAt,
    ageMinutes,
    maxAgeMinutes:config.maxAgeMinutes,
    freshnessState,
    state:deriveState(config.id,value),
    detail:deriveDetail(config.id,value),
    data:value||null
  };
}

function deriveState(id,value){
  if(!value)return'unknown';
  if(id==='reachability')return value.summary?.status||'unknown';
  if(id==='deployment-drift')return value.summary?.status||'unknown';
  if(id==='scheduled-freshness')return value.summary?.status||'unknown';
  if(id==='browser-dispatch-supervisor'){
    const action=value.action||'unknown';
    if(action==='blocked'||action==='dispatch-failed')return'attention';
    if(action==='suppressed'||action==='warming')return'observing';
    return'healthy';
  }
  return value.effectiveState||value.summary?.status||value.status||'unknown';
}

function deriveDetail(id,value){
  if(!value)return'No snapshot has been recorded.';
  if(id==='reachability'){
    const s=value.summary||{};
    return`${s.healthy??0}/${s.total??0} healthy; ${s.observing??0} observing; ${s.degraded??0} degraded; ${s.persistent??0} persistent.`;
  }
  if(id==='deployment-drift'){
    const s=value.summary||{};
    return`${s.inSync??0}/${s.total??0} in sync; ${s.pending??0} pending; ${s.drift??0} drift; ${s.unknown??0} unknown.`;
  }
  if(id==='scheduled-freshness'){
    const s=value.summary||{};
    return`${s.healthy??0}/${s.total??0} healthy; ${s.stale??0} stale; ${s.unreachable??0} unreachable; ${s.unknown??0} unknown.`;
  }
  if(id==='browser-dispatch-supervisor')return value.message||'Dispatch supervisor snapshot available.';
  return value.message||value.assessment?.message||`State: ${deriveState(id,value)}.`;
}

async function fetchRepositoryIntegrity(){
  const started=Date.now();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
  try{
    const target=new URL(REPOSITORY_INTEGRITY_URL);
    target.searchParams.set('ops',Date.now().toString());
    const response=await fetch(target.href,{
      method:'GET',
      redirect:'follow',
      cache:'no-store',
      headers:{
        accept:'application/json',
        'cache-control':'no-cache',
        'user-agent':'CuratorOps-OperationalState/1.13 (+https://ops.oceanlinercurator.com)'
      },
      signal:controller.signal
    });
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const payload=await response.json();
    const state=payload?.status==='healthy'?'healthy':'attention';
    return{
      id:'repository-integrity',
      name:'Repository Integrity',
      url:REPOSITORY_INTEGRITY_URL,
      state,
      status:payload?.status||'unknown',
      archiveGenerated:payload?.generatedFrom?.archiveGenerated||null,
      counts:payload?.counts||null,
      checks:Array.isArray(payload?.checks)?payload.checks:[],
      durationMs:Date.now()-started,
      error:null
    };
  }catch(error){
    return{
      id:'repository-integrity',
      name:'Repository Integrity',
      url:REPOSITORY_INTEGRITY_URL,
      state:'unreachable',
      status:'unknown',
      archiveGenerated:null,
      counts:null,
      checks:[],
      durationMs:Date.now()-started,
      error:error?.name==='AbortError'?'timeout':String(error?.message||error||'fetch failed')
    };
  }finally{
    clearTimeout(timer);
  }
}

function buildFindings(byId,repositoryIntegrity){
  const findings=[];
  const add=(finding)=>findings.push({
    id:finding.id,
    name:finding.name,
    severity:finding.severity||'degraded',
    role:finding.role||'independent',
    causedBy:finding.causedBy||null,
    evidence:finding.evidence||null,
    message:finding.message
  });

  for(const source of Object.values(byId)){
    if(source.freshnessState==='fresh')continue;
    add({
      id:`snapshot-freshness:${source.id}`,
      name:`${source.name} snapshot freshness`,
      severity:source.freshnessState==='missing'?'attention':'degraded',
      role:'independent',
      message:source.freshnessState==='missing'
        ?`${source.name} has not produced an operational snapshot.`
        :`${source.name} snapshot is ${source.ageMinutes} minutes old; expected within ${source.maxAgeMinutes} minutes.`,
      evidence:{generatedAt:source.generatedAt,ageMinutes:source.ageMinutes,maxAgeMinutes:source.maxAgeMinutes}
    });
  }

  const reach=byId.reachability?.data;
  for(const service of reach?.services||[]){
    if(!['degraded','persistent'].includes(service.effectiveState))continue;
    add({
      id:`service:${service.id}`,
      name:service.name,
      severity:service.effectiveState==='persistent'?'attention':'degraded',
      role:'root',
      message:`${service.name} reachability is ${service.effectiveState} after ${service.failureStreak??0} consecutive failed checks.`,
      evidence:{serviceId:service.id,httpStatus:service.status??null,error:service.error??null,failureStreak:service.failureStreak??0}
    });
  }

  const publicSiteBad=findings.some(x=>x.id==='service:public-site'&&x.role==='root');
  const selfTestState=byId['self-test']?.state;
  const selfTestBad=['degraded','persistent','attention'].includes(selfTestState);

  const monitorSpecs=[
    ['public-site-journey','Public Site Journey'],
    ['deployment-integrity','Deployment Integrity'],
    ['performance-anomaly','Performance Anomaly'],
    ['browser-search-journey','Browser Search Journey']
  ];

  for(const [id,name] of monitorSpecs){
    const source=byId[id];
    if(!source||isHealthyish(source.state))continue;
    const isBrowserStale=id==='browser-search-journey'&&source.data?.assessment?.rawState==='stale';
    const supervisor=byId['browser-dispatch-supervisor'];
    const supervisorCausal=isBrowserStale&&['blocked','dispatch-failed'].includes(supervisor?.data?.action);

    if(supervisorCausal){
      add({
        id:`monitor:${id}`,name,severity:severityFor(source.state),role:'symptom',
        causedBy:'monitor:browser-dispatch-supervisor',
        message:`${name} is stale while the fallback dispatch supervisor is ${supervisor.data.action}.`,
        evidence:{state:source.state,rawState:source.data?.assessment?.rawState||null,supervisorAction:supervisor.data.action}
      });
      continue;
    }

    if(publicSiteBad){
      add({
        id:`monitor:${id}`,name,severity:severityFor(source.state),role:'symptom',
        causedBy:'service:public-site',
        message:`${name} is unhealthy while the public site itself has a persistent/degraded reachability failure.`,
        evidence:{state:source.state}
      });
    }else{
      add({
        id:`monitor:${id}`,name,severity:severityFor(source.state),role:'independent',
        message:`${name} reports ${source.state} without a confirmed upstream public-site reachability failure.`,
        evidence:{state:source.state}
      });
    }
  }

  const supervisor=byId['browser-dispatch-supervisor'];
  if(supervisor&&!isHealthyish(supervisor.state)){
    const action=supervisor.data?.action||'unknown';
    add({
      id:'monitor:browser-dispatch-supervisor',
      name:'Browser Dispatch Supervisor',
      severity:['blocked','dispatch-failed'].includes(action)?'attention':'degraded',
      role:['blocked','dispatch-failed'].includes(action)?'root':'independent',
      message:supervisor.data?.message||`Browser dispatch supervisor reports ${action}.`,
      evidence:{action,lastDispatchAt:supervisor.data?.lastDispatchAt||null,lastDispatchResult:supervisor.data?.lastDispatchResult||null}
    });
  }

  const scheduled=byId['scheduled-freshness']?.data;
  for(const service of scheduled?.services||[]){
    if(!['stale','unreachable'].includes(service.status))continue;
    add({
      id:`scheduled:${service.id}`,
      name:`${service.name} scheduled work`,
      severity:'attention',
      role:'independent',
      message:service.status==='stale'
        ?`${service.name} scheduled work is stale (${service.ageMinutes??'unknown'} minutes old; limit ${service.maxAgeMinutes??'unknown'}).`
        :`${service.name} scheduled freshness endpoint is unreachable.`,
      evidence:{serviceId:service.id,status:service.status,lastSuccessAt:service.lastSuccessAt??null,ageMinutes:service.ageMinutes??null,error:service.error??null}
    });
  }

  const drift=byId['deployment-drift']?.data;
  for(const service of drift?.services||[]){
    if(service.state!=='drift')continue;
    add({
      id:`deployment:${service.id}`,
      name:`${service.name} deployment`,
      severity:'attention',
      role:'independent',
      message:`${service.name} is running a different commit from GitHub main beyond the deployment grace period.`,
      evidence:{serviceId:service.id,runningCommit:service.running?.commit||null,githubCommit:service.github?.commit||null}
    });
  }

  if(repositoryIntegrity.state!=='healthy'){
    add({
      id:'repository-integrity',
      name:'Repository Integrity',
      severity:'attention',
      role:'independent',
      message:repositoryIntegrity.state==='unreachable'
        ?`Repository integrity manifest is unreachable: ${repositoryIntegrity.error||'unknown error'}.`
        :'Repository integrity manifest reports one or more failed invariants.',
      evidence:{status:repositoryIntegrity.status,counts:repositoryIntegrity.counts,error:repositoryIntegrity.error}
    });
  }

  if(selfTestBad){
    for(const finding of findings){
      if(!finding.id.startsWith('snapshot-freshness:')||finding.id==='snapshot-freshness:self-test')continue;
      finding.role='symptom';
      finding.causedBy='monitor:self-test';
      finding.message+= ' Ops storage self-test is also unhealthy, so stale monitoring state may be a downstream symptom.';
    }
    add({
      id:'monitor:self-test',
      name:'CuratorOS Self-Test',
      severity:severityFor(selfTestState),
      role:'root',
      message:`CuratorOS monitoring-storage self-test reports ${selfTestState}; confidence in persisted Ops state is reduced.`,
      evidence:{state:selfTestState}
    });
  }

  return dedupeFindings(findings);
}

function dedupeFindings(findings){
  const seen=new Map();
  for(const item of findings){
    const prior=seen.get(item.id);
    if(!prior||rank(item.role)>rank(prior.role)||severityRank(item.severity)>severityRank(prior.severity))seen.set(item.id,item);
  }
  return [...seen.values()].sort((a,b)=>
    severityRank(b.severity)-severityRank(a.severity)||
    rank(b.role)-rank(a.role)||
    a.name.localeCompare(b.name)
  );
}

function rank(role){return role==='root'?3:role==='independent'?2:role==='symptom'?1:0}
function severityRank(v){return v==='attention'?3:v==='degraded'?2:v==='observing'?1:0}
function severityFor(state){return ['persistent','attention','stale','unreachable'].includes(state)?'attention':['degraded'].includes(state)?'degraded':'observing'}
function isHealthyish(state){return ['healthy','warming','in-sync','deploying','pending','none','dispatched'].includes(String(state||'unknown'))}

async function readSnapshot(env){
  requireKv(env);
  return await env[OPS_KV].get(SNAPSHOT_KEY,'json')||{
    generatedAt:null,
    source:null,
    displayTimeZone:DISPLAY_TIME_ZONE,
    status:'warming',
    summary:{sources:SOURCES.length+1,freshSources:0,staleSources:SOURCES.length+1,rootProblems:0,independentProblems:0,downstreamSymptoms:0,activeFindings:0},
    sources:SOURCES.map(x=>({id:x.id,name:x.name,key:x.key,generatedAt:null,ageMinutes:null,maxAgeMinutes:x.maxAgeMinutes,freshnessState:'missing',state:'unknown',detail:'Waiting for first operational-state collection.',data:null})),
    repositoryIntegrity:{id:'repository-integrity',name:'Repository Integrity',state:'unknown',status:'unknown',archiveGenerated:null,counts:null,checks:[],durationMs:null,error:null},
    findings:[]
  };
}

function inject(body,snapshot){
  const state=snapshot?.status||'warming';
  const summary=snapshot?.summary||{};
  const detail=snapshot?.generatedAt
    ?`${summary.rootProblems??0} root · ${summary.independentProblems??0} independent · ${summary.downstreamSymptoms??0} downstream · checked ${formatCentral(snapshot.generatedAt)}`
    :'Waiting for first dependency-aware snapshot.';
  const card=`<section class="ops-operational-state" aria-label="Dependency-aware operational state"><a class="ops-monitoring__card" href="/operational-state"><div class="label">Operational State</div><div class="ops-monitoring__status"><span class="ops-monitoring__dot ${escClass(state)}"></span>${esc(state)}</div><div class="ops-monitoring__detail">${esc(detail)}</div></a></section>`;
  let out=body;
  if(out.includes('</style>'))out=out.replace('</style>','.ops-operational-state{margin:-8px 0 22px}.ops-operational-state .ops-monitoring__card{width:100%}</style>');
  out=out.replace('<a href="/history">Operational History →</a>','<a href="/operational-state">Operational State →</a><a href="/history">Operational History →</a>');
  if(out.includes('<section class="table">'))out=out.replace('<section class="table">',card+'<section class="table">');
  return out;
}

function render(snapshot){
  const s=snapshot.summary||{};
  const sourceRows=(snapshot.sources||[]).map(x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.state)}</td><td>${esc(x.freshnessState)}</td><td>${x.generatedAt?formatCentral(x.generatedAt):'—'}</td><td>${x.ageMinutes??'—'} min</td><td>${x.maxAgeMinutes} min</td><td>${esc(x.detail||'')}</td></tr>`).join('');
  const repo=snapshot.repositoryIntegrity||{};
  const findingRows=(snapshot.findings||[]).map(x=>`<tr><td><span class="dot ${escClass(x.severity)}"></span>${esc(x.name)}</td><td>${esc(x.role)}</td><td>${esc(x.severity)}</td><td>${esc(x.causedBy||'—')}</td><td>${esc(x.message)}</td></tr>`).join('');

  return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Operational State · Curator Ops</title><style>:root{color-scheme:dark;--bg:#0a1110;--panel:#101918;--brass:#bfa46a;--text:#f3eee3;--muted:#9aa6a0;--line:#263330}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Georgia,serif}.wrap{max-width:1280px;margin:auto;padding:58px 20px}.eyebrow{font:600 12px system-ui;letter-spacing:.18em;text-transform:uppercase;color:var(--brass)}h1{font-size:clamp(38px,7vw,62px);font-weight:400}.lede{max-width:900px;color:#d3d6d1;line-height:1.6}.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:28px 0}.card,.table,.repo{border:1px solid var(--line);background:var(--panel);border-radius:16px}.card,.repo{padding:18px}.label{font:600 11px system-ui;color:var(--muted);text-transform:uppercase}.value{font-size:27px;margin-top:8px}.table{overflow:auto;margin:18px 0}table{width:100%;border-collapse:collapse;min-width:980px;font:13px/1.45 system-ui}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:9px}.healthy{background:#58c77a}.warming,.observing{background:#d6ad58}.degraded{background:#d98d58}.attention,.persistent,.stale,.unreachable{background:#d86666}.unknown{background:#8b9490}a,code{color:#e9d49e}.section-title{font:400 24px Georgia,serif;margin:34px 0 10px}.meta{color:var(--muted);font:12px/1.55 system-ui}@media(max-width:900px){.cards{grid-template-columns:1fr 1fr}}@media(max-width:560px){.cards{grid-template-columns:1fr}}</style></head><body><main class="wrap"><div class="eyebrow">CuratorOS · Dependency-Aware Operations</div><h1>Operational State</h1><p class="lede">Combines reachability, freshness, deployment truth, synthetic monitoring, repository integrity, and known dependency relationships. Problems are classified as root causes, independent failures, or downstream symptoms; correlation does not yet suppress existing Error Bus incidents.</p><section class="cards"><div class="card"><div class="label">State</div><div class="value">${esc(snapshot.status||'warming')}</div></div><div class="card"><div class="label">Root causes</div><div class="value">${s.rootProblems??0}</div></div><div class="card"><div class="label">Independent</div><div class="value">${s.independentProblems??0}</div></div><div class="card"><div class="label">Symptoms</div><div class="value">${s.downstreamSymptoms??0}</div></div><div class="card"><div class="label">Fresh sources</div><div class="value">${s.freshSources??0}/${s.sources??SOURCES.length+1}</div></div></section><div class="repo"><div class="label">Repository integrity</div><div class="value" style="font-size:20px">${esc(repo.state||'unknown')}</div><div class="meta">Archive generated: ${esc(repo.archiveGenerated||'—')} · Archive count: ${repo.counts?.archive??'—'} · Errors: ${repo.counts?.errors??'—'} · Warnings: ${repo.counts?.warnings??'—'} · Fetch: ${repo.durationMs??'—'} ms</div></div><h2 class="section-title">Active findings</h2><section class="table"><table><thead><tr><th>Finding</th><th>Role</th><th>Severity</th><th>Caused by</th><th>Assessment</th></tr></thead><tbody>${findingRows||'<tr><td colspan="5">No active operational findings.</td></tr>'}</tbody></table></section><h2 class="section-title">Source freshness</h2><section class="table"><table><thead><tr><th>Source</th><th>State</th><th>Freshness</th><th>Generated</th><th>Age</th><th>Expected</th><th>Detail</th></tr></thead><tbody>${sourceRows}</tbody></table></section><p><a href="/">← Curator Ops</a> · <a href="/scheduled">Scheduled Work</a> · <a href="/deployments">Deployment Drift</a> · <a href="/history">Operational History</a></p></main></body></html>`;
}

function formatCentral(value){if(!value)return'—';const d=new Date(value);if(Number.isNaN(d.getTime()))return'—';return new Intl.DateTimeFormat('en-US',{timeZone:DISPLAY_TIME_ZONE,month:'numeric',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(d)}
function escClass(v){return ['healthy','warming','observing','degraded','persistent','attention','stale','unreachable','unknown'].includes(String(v))?String(v):'unknown'}
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function requireKv(env){if(!env?.[OPS_KV])throw new Error(`${OPS_KV} binding is required`)}
function json(value,status=200){return new Response(JSON.stringify(value,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}})}
function html(value){return new Response(value,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})}
