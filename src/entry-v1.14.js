import base from './entry-v1.13.js';

const OPS_KV='CURATOR_OPS_RECORDS';
const ERROR_KV='CURATOR_ERROR_RECORDS';
const OPERATIONAL_STATE_KEY='operational-state:latest';
const SNAPSHOT_KEY='incident-correlation:latest';
const STATE_KEY='incident-correlation:state';
const HISTORY_PREFIX='incident-correlation:';
const INCIDENT_PREFIX='incident:';
const DISPLAY_TIME_ZONE='America/Chicago';
const ACTIVE_STATUSES=new Set(['active','degraded']);
const RECOVERY_CONFIRMATIONS=3;
const STATE_TTL=60*60*24*180;
const HISTORY_TTL=60*60*24*180;

export default{
  async fetch(request,env,ctx){
    const u=new URL(request.url);
    if(request.method==='GET'&&u.pathname==='/api/incident-correlation'){
      return json({ok:true,snapshot:await readSnapshot(env)});
    }
    if(request.method==='POST'&&u.pathname==='/api/incident-correlation-check-now'){
      return json({ok:true,snapshot:await collect(env,'manual')});
    }
    if(request.method==='GET'&&u.pathname==='/incidents'){
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
        .catch(error=>console.error('Incident correlation collection failed',error))
    );
    return result;
  }
};

async function collect(env,source){
  requireBindings(env);
  const now=new Date().toISOString();
  const [operationalState,activeIncidents,prior]=await Promise.all([
    env[OPS_KV].get(OPERATIONAL_STATE_KEY,'json'),
    listActiveIncidents(env),
    env[OPS_KV].get(STATE_KEY,'json')
  ]);

  const findings=Array.isArray(operationalState?.findings)?operationalState.findings:[];
  const findingsById=new Map(findings.map(x=>[x.id,x]));
  const groups=buildGroups(activeIncidents,findingsById);
  const lifecycle=advanceLifecycle(groups,prior?.groups||{},now);

  const activeGroups=lifecycle.filter(x=>x.lifecycleState==='active');
  const recoveringGroups=lifecycle.filter(x=>x.lifecycleState==='recovering');
  const verifiedRecoveries=lifecycle.filter(x=>x.lifecycleState==='verified-recovered');
  const underlyingCount=activeGroups.reduce((n,g)=>n+g.incidents.length,0);
  const deduplicatedCount=Math.max(0,underlyingCount-activeGroups.length);

  const snapshot={
    generatedAt:now,
    source,
    displayTimeZone:DISPLAY_TIME_ZONE,
    status:activeGroups.length?'attention':recoveringGroups.length?'observing':'healthy',
    recoveryConfirmationsRequired:RECOVERY_CONFIRMATIONS,
    summary:{
      activeGroups:activeGroups.length,
      underlyingActiveIncidents:underlyingCount,
      correlatedDuplicates:deduplicatedCount,
      recoveringGroups:recoveringGroups.length,
      verifiedRecoveries:verifiedRecoveries.length
    },
    activeGroups,
    recoveringGroups,
    verifiedRecoveries:verifiedRecoveries.slice(0,20)
  };

  const stateGroups={};
  for(const group of lifecycle){
    stateGroups[group.id]={
      id:group.id,
      title:group.title,
      anchorFindingId:group.anchorFindingId,
      firstSeenAt:group.firstSeenAt,
      lastSeenAt:group.lastSeenAt,
      lifecycleState:group.lifecycleState,
      cleanStreak:group.cleanStreak,
      firstCleanAt:group.firstCleanAt||null,
      recoveredAt:group.recoveredAt||null,
      lastSeverity:group.severity,
      lastIncidentFingerprints:group.incidents.map(x=>x.fingerprint).slice(0,50)
    };
  }

  await env[OPS_KV].put(STATE_KEY,JSON.stringify({updatedAt:now,groups:stateGroups}),{expirationTtl:STATE_TTL});
  await env[OPS_KV].put(SNAPSHOT_KEY,JSON.stringify(snapshot));

  const ts=Date.parse(now)||Date.now();
  await env[OPS_KV].put(
    `${HISTORY_PREFIX}${String(9999999999999-ts).padStart(13,'0')}:${crypto.randomUUID()}`,
    JSON.stringify(snapshot),
    {expirationTtl:HISTORY_TTL}
  );

  return snapshot;
}

function buildGroups(incidents,findingsById){
  const grouped=new Map();

  for(const incident of incidents){
    const findingId=incidentFindingId(incident);
    const finding=findingId?findingsById.get(findingId):null;
    const anchorFindingId=finding?.role==='symptom'&&finding.causedBy
      ?finding.causedBy
      :(finding?.id||null);
    const anchorFinding=anchorFindingId?findingsById.get(anchorFindingId):null;
    const id=anchorFindingId
      ?`correlation:${anchorFindingId}`
      :`incident:${incident.fingerprint||incident.id||'unknown'}`;

    if(!grouped.has(id)){
      grouped.set(id,{
        id,
        anchorFindingId,
        title:anchorFinding?.name||finding?.name||incident.component||incident.fingerprint||'Operational incident',
        role:anchorFinding?.role||finding?.role||'independent',
        severity:'p2',
        message:anchorFinding?.message||finding?.message||incident.message||'Active operational incident.',
        causedBy:anchorFinding?.causedBy||finding?.causedBy||null,
        incidents:[]
      });
    }

    const group=grouped.get(id);
    group.incidents.push(compactIncident(incident,findingId,finding));
    if(severityRank(incident.severity)>severityRank(group.severity))group.severity=incident.severity;
  }

  return [...grouped.values()]
    .map(group=>({
      ...group,
      incidents:group.incidents.sort((a,b)=>
        severityRank(b.severity)-severityRank(a.severity)||
        String(a.fingerprint).localeCompare(String(b.fingerprint))
      )
    }))
    .sort((a,b)=>
      severityRank(b.severity)-severityRank(a.severity)||
      b.incidents.length-a.incidents.length||
      a.title.localeCompare(b.title)
    );
}

function incidentFindingId(incident){
  const fingerprint=String(incident?.fingerprint||'');
  const component=String(incident?.component||'');

  if(fingerprint.startsWith('ops-reachability-'))return `service:${fingerprint.slice('ops-reachability-'.length)}`;
  if(fingerprint.startsWith('ops-deployment-drift-'))return `deployment:${fingerprint.slice('ops-deployment-drift-'.length)}`;
  if(fingerprint.startsWith('ops-scheduled-stale-'))return `scheduled:${fingerprint.slice('ops-scheduled-stale-'.length)}`;
  if(fingerprint==='ops-public-site-journey')return'monitor:public-site-journey';
  if(fingerprint==='ops-browser-search-journey')return'monitor:browser-search-journey';
  if(fingerprint==='ops-deployment-integrity')return'monitor:deployment-integrity';
  if(fingerprint==='ops-performance-anomaly')return'monitor:performance-anomaly';
  if(fingerprint==='ops-self-test-storage')return'monitor:self-test';

  if(component.startsWith('reachability:'))return`service:${component.slice('reachability:'.length)}`;
  if(component.startsWith('deployment:'))return`deployment:${component.slice('deployment:'.length)}`;
  if(component.startsWith('scheduled:'))return`scheduled:${component.slice('scheduled:'.length)}`;
  if(component==='synthetic:public-site-journey')return'monitor:public-site-journey';
  if(component==='synthetic:browser-search')return'monitor:browser-search-journey';
  if(component==='public-site:deployment-integrity')return'monitor:deployment-integrity';
  if(component==='public-site:performance')return'monitor:performance-anomaly';
  if(component==='self-test:storage')return'monitor:self-test';
  return null;
}

function compactIncident(incident,findingId,finding){
  return{
    id:incident.id||null,
    fingerprint:incident.fingerprint||null,
    source:incident.source||null,
    component:incident.component||null,
    severity:incident.severity||null,
    type:incident.type||null,
    status:incident.status||null,
    message:incident.message||null,
    firstSeenAt:incident.firstSeenAt||null,
    lastSeenAt:incident.lastSeenAt||null,
    occurrences:Number(incident.occurrences||0),
    findingId,
    correlationRole:finding?.role||'independent',
    causedBy:finding?.causedBy||null
  };
}

function advanceLifecycle(activeGroups,priorGroups,now){
  const out=[];
  const activeIds=new Set(activeGroups.map(x=>x.id));

  for(const group of activeGroups){
    const prior=priorGroups[group.id];
    out.push({
      ...group,
      lifecycleState:'active',
      firstSeenAt:prior?.firstSeenAt||earliest(group.incidents.map(x=>x.firstSeenAt))||now,
      lastSeenAt:latest(group.incidents.map(x=>x.lastSeenAt))||now,
      cleanStreak:0,
      firstCleanAt:null,
      recoveredAt:null
    });
  }

  for(const [id,prior] of Object.entries(priorGroups)){
    if(activeIds.has(id))continue;
    if(!['active','recovering'].includes(prior?.lifecycleState))continue;

    const cleanStreak=Number(prior.cleanStreak||0)+1;
    const verified=cleanStreak>=RECOVERY_CONFIRMATIONS;
    out.push({
      id,
      anchorFindingId:prior.anchorFindingId||null,
      title:prior.title||id,
      role:'recovery',
      severity:prior.lastSeverity||'p2',
      message:verified
        ?`Recovery verified across ${RECOVERY_CONFIRMATIONS} consecutive correlation passes.`
        :`Condition absent for ${cleanStreak}/${RECOVERY_CONFIRMATIONS} required clean correlation passes.`,
      causedBy:null,
      incidents:(prior.lastIncidentFingerprints||[]).map(fingerprint=>({fingerprint,severity:prior.lastSeverity||null,status:'recovered'})),
      lifecycleState:verified?'verified-recovered':'recovering',
      firstSeenAt:prior.firstSeenAt||null,
      lastSeenAt:prior.lastSeenAt||null,
      cleanStreak,
      firstCleanAt:prior.firstCleanAt||now,
      recoveredAt:verified?now:null
    });
  }

  for(const [id,prior] of Object.entries(priorGroups)){
    if(activeIds.has(id))continue;
    if(prior?.lifecycleState!=='verified-recovered')continue;
    out.push({
      id,
      anchorFindingId:prior.anchorFindingId||null,
      title:prior.title||id,
      role:'recovery',
      severity:prior.lastSeverity||'p2',
      message:`Recovery verified across ${RECOVERY_CONFIRMATIONS} consecutive correlation passes.`,
      causedBy:null,
      incidents:(prior.lastIncidentFingerprints||[]).map(fingerprint=>({fingerprint,severity:prior.lastSeverity||null,status:'recovered'})),
      lifecycleState:'verified-recovered',
      firstSeenAt:prior.firstSeenAt||null,
      lastSeenAt:prior.lastSeenAt||null,
      cleanStreak:Number(prior.cleanStreak||RECOVERY_CONFIRMATIONS),
      firstCleanAt:prior.firstCleanAt||null,
      recoveredAt:prior.recoveredAt||now
    });
  }

  return out.sort((a,b)=>
    lifecycleRank(b.lifecycleState)-lifecycleRank(a.lifecycleState)||
    severityRank(b.severity)-severityRank(a.severity)||
    String(a.title).localeCompare(String(b.title))
  );
}

async function listActiveIncidents(env){
  const listed=await env[ERROR_KV].list({prefix:INCIDENT_PREFIX,limit:1000});
  const out=[];
  for(const item of listed.keys){
    const incident=await env[ERROR_KV].get(item.name,'json');
    if(incident&&ACTIVE_STATUSES.has(incident.status))out.push(incident);
  }
  return out;
}

async function readSnapshot(env){
  requireBindings(env);
  return await env[OPS_KV].get(SNAPSHOT_KEY,'json')||{
    generatedAt:null,
    source:null,
    displayTimeZone:DISPLAY_TIME_ZONE,
    status:'warming',
    recoveryConfirmationsRequired:RECOVERY_CONFIRMATIONS,
    summary:{activeGroups:0,underlyingActiveIncidents:0,correlatedDuplicates:0,recoveringGroups:0,verifiedRecoveries:0},
    activeGroups:[],
    recoveringGroups:[],
    verifiedRecoveries:[]
  };
}

function inject(body,snapshot){
  const s=snapshot?.summary||{};
  const detail=snapshot?.generatedAt
    ?`${s.activeGroups??0} grouped incidents · ${s.underlyingActiveIncidents??0} underlying records · ${s.correlatedDuplicates??0} correlated duplicates · checked ${formatCentral(snapshot.generatedAt)}`
    :'Waiting for first incident-correlation pass.';
  const card=`<section class="ops-incident-correlation" aria-label="Correlated incidents"><a class="ops-monitoring__card" href="/incidents"><div class="label">Incident Correlation</div><div class="ops-monitoring__status"><span class="ops-monitoring__dot ${escClass(snapshot?.status||'warming')}"></span>${esc(snapshot?.status||'warming')}</div><div class="ops-monitoring__detail">${esc(detail)}</div></a></section>`;
  let out=body;
  if(out.includes('</style>'))out=out.replace('</style>','.ops-incident-correlation{margin:-8px 0 22px}.ops-incident-correlation .ops-monitoring__card{width:100%}</style>');
  out=out.replace('<a href="/history">Operational History →</a>','<a href="/incidents">Correlated Incidents →</a><a href="/history">Operational History →</a>');
  if(out.includes('<section class="table">'))out=out.replace('<section class="table">',card+'<section class="table">');
  return out;
}

function render(snapshot){
  const s=snapshot.summary||{};
  const groups=(snapshot.activeGroups||[]).map(group=>{
    const evidence=group.incidents.map(i=>`<li><code>${esc(i.fingerprint||i.id||'unknown')}</code> · ${esc(i.severity||'—')} · ${esc(i.message||'')}</li>`).join('');
    return`<article class="group"><div class="group-head"><div><div class="label">${esc(group.role||'independent')} · ${esc(group.severity||'—')}</div><h2>${esc(group.title)}</h2></div><div class="count">${group.incidents.length} signal${group.incidents.length===1?'':'s'}</div></div><p>${esc(group.message||'')}</p>${group.causedBy?`<p class="meta">Caused by: <code>${esc(group.causedBy)}</code></p>`:''}<ul>${evidence}</ul></article>`;
  }).join('');

  const recovering=(snapshot.recoveringGroups||[]).map(g=>`<tr><td>${esc(g.title)}</td><td>${g.cleanStreak}/${snapshot.recoveryConfirmationsRequired}</td><td>${g.firstCleanAt?formatCentral(g.firstCleanAt):'—'}</td><td>${esc(g.message)}</td></tr>`).join('');

  return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Correlated Incidents · Curator Ops</title><style>:root{color-scheme:dark;--bg:#0a1110;--panel:#101918;--brass:#bfa46a;--text:#f3eee3;--muted:#9aa6a0;--line:#263330}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Georgia,serif}.wrap{max-width:1180px;margin:auto;padding:58px 20px}.eyebrow{font:600 12px system-ui;letter-spacing:.18em;text-transform:uppercase;color:var(--brass)}h1{font-size:clamp(38px,7vw,62px);font-weight:400}.lede{max-width:900px;color:#d3d6d1;line-height:1.6}.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:28px 0}.card,.group,.table{border:1px solid var(--line);background:var(--panel);border-radius:16px}.card{padding:18px}.label{font:600 11px system-ui;color:var(--muted);text-transform:uppercase}.value{font-size:27px;margin-top:8px}.group{padding:20px;margin:14px 0}.group-head{display:flex;justify-content:space-between;gap:18px;align-items:start}.group h2{font-size:23px;font-weight:400;margin:5px 0 0}.group p,.group li{font:13px/1.55 system-ui}.group ul{margin:14px 0 0;padding-left:20px}.count{font:600 12px system-ui;color:var(--brass);white-space:nowrap}.meta{color:var(--muted)}.table{overflow:auto;margin-top:16px}table{width:100%;border-collapse:collapse;min-width:800px;font:13px system-ui}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase}a,code{color:#e9d49e}@media(max-width:900px){.cards{grid-template-columns:1fr 1fr}.group-head{display:block}.count{margin-top:8px}}@media(max-width:560px){.cards{grid-template-columns:1fr}}</style></head><body><main class="wrap"><div class="eyebrow">CuratorOS · Incident Correlation</div><h1>Correlated Incidents</h1><p class="lede">Related operational evidence is grouped beneath the best evidenced root cause without deleting or rewriting any underlying Error Bus record. Recovery is not considered verified until the entire group remains absent for ${snapshot.recoveryConfirmationsRequired||RECOVERY_CONFIRMATIONS} consecutive correlation passes.</p><section class="cards"><div class="card"><div class="label">State</div><div class="value">${esc(snapshot.status||'warming')}</div></div><div class="card"><div class="label">Incident groups</div><div class="value">${s.activeGroups??0}</div></div><div class="card"><div class="label">Underlying records</div><div class="value">${s.underlyingActiveIncidents??0}</div></div><div class="card"><div class="label">Grouped duplicates</div><div class="value">${s.correlatedDuplicates??0}</div></div><div class="card"><div class="label">Confirming recovery</div><div class="value">${s.recoveringGroups??0}</div></div></section>${groups||'<p class="lede">No active incident groups.</p>'}<h2>Recovery verification</h2><section class="table"><table><thead><tr><th>Group</th><th>Clean passes</th><th>First clean</th><th>Assessment</th></tr></thead><tbody>${recovering||'<tr><td colspan="4">No groups are currently awaiting recovery verification.</td></tr>'}</tbody></table></section><p><a href="/">← Curator Ops</a> · <a href="/operational-state">Operational State</a> · <a href="/history">Operational History</a></p></main></body></html>`;
}

function earliest(values){return values.filter(Boolean).sort()[0]||null}
function latest(values){return values.filter(Boolean).sort().at(-1)||null}
function lifecycleRank(v){return v==='active'?3:v==='recovering'?2:v==='verified-recovered'?1:0}
function severityRank(v){return v==='p0'?4:v==='p1'?3:v==='p2'?2:v==='observation'?1:0}
function formatCentral(value){if(!value)return'—';const d=new Date(value);if(Number.isNaN(d.getTime()))return'—';return new Intl.DateTimeFormat('en-US',{timeZone:DISPLAY_TIME_ZONE,month:'numeric',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(d)}
function escClass(v){return ['healthy','warming','observing','degraded','persistent','attention','unknown'].includes(String(v))?String(v):'unknown'}
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function requireBindings(env){if(!env?.[OPS_KV])throw new Error(`${OPS_KV} binding is required`);if(!env?.[ERROR_KV])throw new Error(`${ERROR_KV} binding is required`)}
function json(value,status=200){return new Response(JSON.stringify(value,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}})}
function html(value){return new Response(value,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})}
