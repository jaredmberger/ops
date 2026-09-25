import base from './entry-v1.16.js';

const OPS_KV='CURATOR_OPS_RECORDS';
const ERROR_KV='CURATOR_ERROR_RECORDS';
const OPERATIONAL_STATE_KEY='operational-state:latest';
const INCIDENT_CORRELATION_KEY='incident-correlation:latest';
const HISTORY_KEY='operational-history:latest';
const REACHABILITY_KEY='snapshot:latest';
const DRIFT_KEY='deployment-drift:latest';
const FRESHNESS_KEY='scheduled-freshness:latest';
const DEVICE_KEY='device-observability:latest';
const SECURITY_KEY='security-summary:latest';
const BRIEFING_KEY='current-briefing:latest';
const SNAPSHOT_KEY='diagnostics:latest';
const DISPLAY_TIME_ZONE='America/Chicago';
const MAX_DIAGNOSTICS=100;

export default{
  async fetch(request,env,ctx){
    const u=new URL(request.url);

    if(request.method==='GET'&&u.pathname==='/api/diagnostics'){
      const snapshot=await collectDiagnostics(env,'request');
      const target=clean(u.searchParams.get('target'),160);
      return json({ok:true,snapshot:target?selectTarget(snapshot,target):snapshot});
    }

    if(request.method==='POST'&&u.pathname==='/api/diagnostics-check-now'){
      return json({ok:true,snapshot:await collectDiagnostics(env,'manual')});
    }

    if(request.method==='GET'&&u.pathname==='/diagnose'){
      const snapshot=await collectDiagnostics(env,'request');
      const target=clean(u.searchParams.get('target'),160);
      return html(renderDiagnostics(snapshot,target));
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
      collectDiagnostics(env,`cron:${controller?.cron||'unknown'}`)
        .catch(error=>console.error('Diagnostic collection failed',error))
    );
    return result;
  }
};

async function collectDiagnostics(env,source){
  requireBindings(env);

  const [operational,correlation,history,reachability,drift,freshness,devices,security,briefing,activeIncidents]=await Promise.all([
    env[OPS_KV].get(OPERATIONAL_STATE_KEY,'json'),
    env[OPS_KV].get(INCIDENT_CORRELATION_KEY,'json'),
    env[OPS_KV].get(HISTORY_KEY,'json'),
    env[OPS_KV].get(REACHABILITY_KEY,'json'),
    env[OPS_KV].get(DRIFT_KEY,'json'),
    env[OPS_KV].get(FRESHNESS_KEY,'json'),
    env[OPS_KV].get(DEVICE_KEY,'json'),
    env[OPS_KV].get(SECURITY_KEY,'json'),
    env[OPS_KV].get(BRIEFING_KEY,'json'),
    listActiveIncidents(env)
  ]);

  const findings=Array.isArray(operational?.findings)?operational.findings:[];
  const activeGroups=Array.isArray(correlation?.activeGroups)?correlation.activeGroups:[];
  const diagnostics=[];

  for(const finding of findings){
    diagnostics.push(buildFindingDiagnostic({
      finding,findings,activeGroups,history,reachability,drift,freshness,devices,security,activeIncidents
    }));
  }

  for(const group of activeGroups){
    if(diagnostics.some(d=>d.groupId===group.id))continue;
    diagnostics.push(buildGroupDiagnostic({
      group,findings,history,reachability,drift,freshness,devices,security,activeIncidents
    }));
  }

  for(const device of devices?.devices||[]){
    if(!['quiet','stale','unknown'].includes(device.state))continue;
    const id=`device:${slug(device.deviceId||device.service)}`;
    diagnostics.push({
      id,
      targetType:'device',
      title:device.service||device.deviceId||'Device',
      state:device.state,
      severity:device.state==='stale'?'attention':'observing',
      confidence:'high',
      conclusion:device.state==='stale'
        ?`The device heartbeat is stale: last seen ${device.ageMinutes??'unknown'} minutes ago, with an expected interval of ${device.maxAgeMinutes} minutes.`
        :`The device heartbeat is ${device.state}; there is not yet enough evidence to call it offline.`,
      rootCause:null,
      causedBy:null,
      deploymentCorrelation:null,
      evidence:[
        evidence('heartbeat','confirmed',`Last heartbeat ${device.ageMinutes??'unknown'} minutes ago.`,{observedAt:device.observedAt||null,maxAgeMinutes:device.maxAgeMinutes}),
        ...(Number.isFinite(device.wifiRssi)?[evidence('wifi-rssi',device.wifiRssi<-75?'supporting':'context',`Wi-Fi RSSI is ${device.wifiRssi} dBm.`,{wifiRssi:device.wifiRssi})]:[]),
        ...(Number.isFinite(device.batteryPercent)?[evidence('battery','context',`Battery is ${device.batteryPercent}%.`,{batteryPercent:device.batteryPercent,charging:device.charging??null,powerSource:device.powerSource||null})]:[])
      ],
      nextChecks:[
        'Confirm whether the device is intentionally powered off or sleeping.',
        Number.isFinite(device.wifiRssi)&&device.wifiRssi<-75?'Check local Wi-Fi quality before treating the stale heartbeat as a device fault.':'If the device should be online, inspect its local power/network state.'
      ],
      incidentFingerprints:[]
    });
  }

  if(security?.summary?.burst){
    diagnostics.push({
      id:'security:probe-burst',
      targetType:'security',
      title:'Security probe burst',
      state:'elevated',
      severity:'observing',
      confidence:'high',
      conclusion:`Security telemetry shows ${security.summary.lastHour} events in the last hour versus ${security.summary.previousHour} in the previous hour. This is a traffic-pattern observation, not an infrastructure incident by itself.`,
      rootCause:null,
      causedBy:null,
      deploymentCorrelation:null,
      evidence:[
        evidence('security-volume','confirmed','A security-probe burst threshold is currently met.',{
          lastHour:security.summary.lastHour,
          previousHour:security.summary.previousHour,
          uniqueSources24Hours:security.summary.uniqueSources24Hours,
          topPorts24Hours:security.topPorts24Hours||[]
        })
      ],
      nextChecks:[
        'Review top source addresses and destination ports for concentration or novelty.',
        'Escalate only if probe activity coincides with an independently observed service impact.'
      ],
      incidentFingerprints:[]
    });
  }

  diagnostics.sort((a,b)=>
    severityRank(b.severity)-severityRank(a.severity)||
    confidenceRank(b.confidence)-confidenceRank(a.confidence)||
    a.title.localeCompare(b.title)
  );

  const snapshot={
    generatedAt:new Date().toISOString(),
    source,
    displayTimeZone:DISPLAY_TIME_ZONE,
    status:diagnostics.some(x=>x.severity==='attention')?'attention':diagnostics.length?'observing':'healthy',
    summary:{
      diagnostics:diagnostics.length,
      attention:diagnostics.filter(x=>x.severity==='attention').length,
      observing:diagnostics.filter(x=>x.severity==='observing').length,
      confirmedRoots:diagnostics.filter(x=>x.rootCause?.classification==='confirmed').length,
      suspectedDeploymentLinks:diagnostics.filter(x=>x.deploymentCorrelation?.match).length
    },
    briefing:briefing||null,
    diagnostics:diagnostics.slice(0,MAX_DIAGNOSTICS)
  };

  await env[OPS_KV].put(SNAPSHOT_KEY,JSON.stringify(snapshot));
  return snapshot;
}

function buildFindingDiagnostic(ctx){
  const {finding,findings,activeGroups,history,reachability,drift,freshness,devices,security,activeIncidents}=ctx;
  const group=findGroupForFinding(activeGroups,finding.id);
  const causedBy=finding.causedBy?findings.find(x=>x.id===finding.causedBy):null;
  const deploymentCorrelation=group?.deploymentCorrelation||findDeploymentForFinding(history,finding.id);
  const relatedIncidents=incidentMatches(activeIncidents,finding.id);

  const rootCause=finding.role==='root'
    ?{classification:'confirmed',id:finding.id,name:finding.name,message:finding.message}
    :finding.role==='symptom'&&causedBy
      ?{classification:'confirmed-upstream',id:causedBy.id,name:causedBy.name,message:causedBy.message}
      :null;

  const evidenceItems=[
    evidence('operational-finding',finding.role==='root'?'confirmed':finding.role==='symptom'?'supporting':'confirmed',finding.message,{id:finding.id,role:finding.role,severity:finding.severity,causedBy:finding.causedBy||null}),
    ...relatedIncidents.map(i=>evidence('error-bus','confirmed',i.message||i.fingerprint,{fingerprint:i.fingerprint,severity:i.severity,status:i.status,firstSeenAt:i.firstSeenAt,lastSeenAt:i.lastSeenAt,occurrences:i.occurrences})),
    ...contextEvidence(finding,reachability,drift,freshness,devices,security)
  ];

  if(deploymentCorrelation?.match){
    evidenceItems.push(evidence(
      'recent-deployment',
      'temporal',
      `${deploymentCorrelation.service||deploymentCorrelation.serviceId} deployed ${deploymentCorrelation.minutesBeforeIncident} minutes before incident onset.`,
      deploymentCorrelation
    ));
  }

  const conclusion=diagnosticConclusion(finding,causedBy,deploymentCorrelation);
  return{
    id:finding.id,
    groupId:group?.id||null,
    targetType:'operational-finding',
    title:finding.name,
    state:finding.role,
    severity:finding.severity,
    confidence:rootCause?'high':finding.role==='independent'?'medium':'medium',
    conclusion,
    rootCause,
    causedBy:finding.causedBy||null,
    deploymentCorrelation:deploymentCorrelation||null,
    evidence:evidenceItems,
    nextChecks:nextChecksFor(finding,causedBy,deploymentCorrelation),
    incidentFingerprints:relatedIncidents.map(x=>x.fingerprint).filter(Boolean)
  };
}

function buildGroupDiagnostic(ctx){
  const {group,findings,history,activeIncidents}=ctx;
  const anchor=group.anchorFindingId?findings.find(x=>x.id===group.anchorFindingId):null;
  const deploymentCorrelation=group.deploymentCorrelation||findDeploymentForFinding(history,group.anchorFindingId);
  const incidents=(group.incidents||[]).length?group.incidents:incidentMatches(activeIncidents,group.anchorFindingId);
  const rootCause=anchor?.role==='root'
    ?{classification:'confirmed',id:anchor.id,name:anchor.name,message:anchor.message}
    :null;

  return{
    id:group.id,
    groupId:group.id,
    targetType:'incident-group',
    title:group.title,
    state:group.lifecycleState||'active',
    severity:severityFromIncident(group.severity),
    confidence:rootCause?'high':'medium',
    conclusion:rootCause
      ?`CuratorOS has an evidenced root cause for this incident group: ${rootCause.name}.`
      :`CuratorOS has grouped related signals, but no single upstream cause has been confirmed.`,
    rootCause,
    causedBy:group.causedBy||null,
    deploymentCorrelation:deploymentCorrelation||null,
    evidence:incidents.map(i=>evidence('error-bus','confirmed',i.message||i.fingerprint,{fingerprint:i.fingerprint,severity:i.severity,status:i.status,firstSeenAt:i.firstSeenAt,lastSeenAt:i.lastSeenAt,occurrences:i.occurrences})),
    nextChecks:deploymentCorrelation?.match
      ?['Inspect the temporally related deployment and compare changed files with the failing component.','Do not attribute causation unless the changed surface overlaps the failing path or a rollback/redeploy changes the outcome.']
      :['Inspect the root/independent finding evidence and collect a more specific failing path before attributing a cause.'],
    incidentFingerprints:incidents.map(x=>x.fingerprint).filter(Boolean)
  };
}

function diagnosticConclusion(finding,causedBy,deploymentCorrelation){
  if(finding.role==='root'){
    const suffix=deploymentCorrelation?.match
      ?` A matching deployment occurred ${deploymentCorrelation.minutesBeforeIncident} minutes earlier, but timing alone does not prove it caused the failure.`
      :'';
    return `CuratorOS identifies this as an evidenced root operational problem. ${finding.message}${suffix}`;
  }
  if(finding.role==='symptom'&&causedBy){
    return `This appears to be a downstream symptom of ${causedBy.name}. ${finding.message}`;
  }
  if(deploymentCorrelation?.match){
    return `This is currently an independent operational finding. A matching deployment occurred ${deploymentCorrelation.minutesBeforeIncident} minutes before onset, which is useful investigative context but not proof of cause.`;
  }
  return `This is an active independent finding with no evidenced upstream cause yet. ${finding.message}`;
}

function nextChecksFor(finding,causedBy,deploymentCorrelation){
  const out=[];
  if(finding.role==='symptom'&&causedBy){
    out.push(`Investigate the upstream finding first: ${causedBy.name}.`);
    out.push('Recheck this downstream component after the upstream condition clears.');
  }else if(finding.id.startsWith('service:')){
    out.push('Check the service-specific runtime/status endpoint and the most recent deployment state.');
    out.push('Compare whether other dependent monitors are failing at the same time.');
  }else if(finding.id.startsWith('deployment:')){
    out.push('Inspect the running commit versus GitHub main and confirm whether deployment propagation is still in progress.');
  }else if(finding.id.startsWith('scheduled:')){
    out.push('Inspect the scheduled worker heartbeat and the last successful job execution.');
  }else if(finding.id.startsWith('monitor:')){
    out.push('Inspect the monitor-specific failed steps before treating the monitor itself as the root cause.');
  }else if(finding.id.startsWith('snapshot-freshness:')){
    out.push('Determine whether the producing monitor stopped running or whether Ops storage stopped receiving updates.');
  }else if(finding.id==='repository-integrity'){
    out.push('Open the repository-integrity manifest and inspect the failed invariant before changing production state.');
  }

  if(deploymentCorrelation?.match){
    out.push('Compare the deployment commit with the affected component; temporal proximity alone is not sufficient for causation.');
  }

  if(!out.length)out.push('Collect one more independent signal before escalating the diagnosis beyond the current evidence.');
  return [...new Set(out)].slice(0,5);
}

function contextEvidence(finding,reachability,drift,freshness,devices,security){
  const out=[];
  const serviceId=serviceIdFromFinding(finding.id);

  if(serviceId){
    const reach=(reachability?.services||[]).find(x=>x.id===serviceId);
    if(reach)out.push(evidence('reachability',reach.ok?'context':'confirmed',`${reach.name} reachability state is ${reach.effectiveState||'unknown'}.`,{status:reach.status??null,error:reach.error??null,failureStreak:reach.failureStreak??0,lastHealthyAt:reach.lastHealthyAt||null}));

    const deploy=(drift?.services||[]).find(x=>x.id===serviceId);
    if(deploy)out.push(evidence('deployment-state',deploy.state==='drift'?'confirmed':'context',deploy.message||`Deployment state: ${deploy.state}.`,{state:deploy.state,runningCommit:deploy.running?.commit||null,githubCommit:deploy.github?.commit||null}));

    const scheduled=(freshness?.services||[]).find(x=>x.id===serviceId);
    if(scheduled)out.push(evidence('scheduled-freshness',['stale','unreachable'].includes(scheduled.status)?'confirmed':'context',`Scheduled-work state is ${scheduled.status}.`,{lastSuccessAt:scheduled.lastSuccessAt||null,ageMinutes:scheduled.ageMinutes??null,maxAgeMinutes:scheduled.maxAgeMinutes??null,error:scheduled.error||null}));
  }

  if(finding.id==='monitor:self-test'){
    out.push(evidence('storage-integrity','confirmed','The monitoring storage path itself is under test; stale Ops snapshots may therefore be secondary evidence.',{}));
  }

  if(security?.summary?.burst&&finding.id==='service:public-site'){
    out.push(evidence('security-telemetry','context','A security probe burst is occurring at the same time, but no causal relationship is assumed.',{lastHour:security.summary.lastHour,previousHour:security.summary.previousHour}));
  }

  return out;
}

function findGroupForFinding(groups,findingId){
  return groups.find(g=>
    g.anchorFindingId===findingId||
    (g.incidents||[]).some(i=>i.findingId===findingId)
  )||null;
}

function findDeploymentForFinding(history,findingId){
  if(!history||!findingId)return null;
  const group=(history.activeGroups||[]).find(g=>
    g.anchorFindingId===findingId||
    (g.incidents||[]).some(i=>i.findingId===findingId)
  );
  return group?.deploymentCorrelation||null;
}

function incidentMatches(incidents,findingId){
  return incidents.filter(incident=>incidentFindingId(incident)===findingId);
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

function serviceIdFromFinding(id){
  const value=String(id||'');
  for(const prefix of ['service:','deployment:','scheduled:']){
    if(value.startsWith(prefix))return value.slice(prefix.length);
  }
  return null;
}

async function listActiveIncidents(env){
  const listed=await env[ERROR_KV].list({prefix:'incident:',limit:1000});
  const out=[];
  for(const item of listed.keys){
    const incident=await env[ERROR_KV].get(item.name,'json');
    if(incident&&['active','degraded'].includes(incident.status))out.push(incident);
  }
  return out;
}

function selectTarget(snapshot,target){
  const needle=String(target||'').toLowerCase();
  const diagnostic=(snapshot.diagnostics||[]).find(d=>
    String(d.id||'').toLowerCase()===needle||
    String(d.title||'').toLowerCase()===needle||
    String(d.id||'').toLowerCase().includes(needle)||
    String(d.title||'').toLowerCase().includes(needle)
  );
  return {
    generatedAt:snapshot.generatedAt,
    status:diagnostic?diagnostic.severity:'not-found',
    requestedTarget:target,
    diagnostic:diagnostic||null
  };
}

async function readSnapshot(env){
  requireBindings(env);
  return await env[OPS_KV].get(SNAPSHOT_KEY,'json')||{
    generatedAt:null,
    source:null,
    displayTimeZone:DISPLAY_TIME_ZONE,
    status:'warming',
    summary:{diagnostics:0,attention:0,observing:0,confirmedRoots:0,suspectedDeploymentLinks:0},
    briefing:null,
    diagnostics:[]
  };
}

function inject(body,snapshot){
  const s=snapshot?.summary||{};
  const detail=snapshot?.generatedAt
    ?`${s.diagnostics??0} diagnostics · ${s.confirmedRoots??0} confirmed roots · ${s.suspectedDeploymentLinks??0} recent deployment links`
    :'Waiting for first diagnostic pass.';
  const card=`<section class="ops-diagnostic-engine" aria-label="Diagnostic engine"><a class="ops-monitoring__card" href="/diagnose"><div class="label">Why is this red?</div><div class="ops-monitoring__status"><span class="ops-monitoring__dot ${escClass(snapshot?.status||'warming')}"></span>${esc(snapshot?.status||'warming')}</div><div class="ops-monitoring__detail">${esc(detail)}</div></a></section>`;
  let out=body;
  if(out.includes('</style>'))out=out.replace('</style>','.ops-diagnostic-engine{margin:-8px 0 22px}.ops-diagnostic-engine .ops-monitoring__card{width:100%}</style>');
  out=out.replace('<a href="/history">Operational History →</a>','<a href="/diagnose">Why is this red? →</a><a href="/history">Operational History →</a>');
  if(out.includes('<section class="table">'))out=out.replace('<section class="table">',card+'<section class="table">');
  return out;
}

function renderDiagnostics(snapshot,target){
  const selected=target?selectTarget(snapshot,target).diagnostic:null;
  if(selected)return renderDiagnosticDetail(snapshot,selected);

  const rows=(snapshot.diagnostics||[]).map(d=>`<tr><td><a href="/diagnose?target=${encodeURIComponent(d.id)}">${esc(d.title)}</a></td><td>${esc(d.severity)}</td><td>${esc(d.confidence)}</td><td>${esc(d.rootCause?.name||d.causedBy||'—')}</td><td>${d.deploymentCorrelation?.match?`${esc(d.deploymentCorrelation.service||d.deploymentCorrelation.serviceId)} · ${d.deploymentCorrelation.minutesBeforeIncident} min`:'—'}</td><td>${esc(d.conclusion)}</td></tr>`).join('');
  const s=snapshot.summary||{};

  return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Why is this red? · Curator Ops</title>${style()}</head><body><main class="wrap"><div class="eyebrow">CuratorOS · Diagnostic Engine</div><h1>Why is this red?</h1><p class="lede">An evidence-first diagnostic path for unhealthy or suspicious CuratorOS conditions. It separates confirmed upstream causes, downstream symptoms, independent findings, and recent-but-unproven deployment correlations.</p><section class="cards"><div class="card"><div class="label">Diagnostics</div><div class="value">${s.diagnostics??0}</div></div><div class="card"><div class="label">Attention</div><div class="value">${s.attention??0}</div></div><div class="card"><div class="label">Confirmed roots</div><div class="value">${s.confirmedRoots??0}</div></div><div class="card"><div class="label">Deployment links</div><div class="value">${s.suspectedDeploymentLinks??0}</div></div></section><section class="table"><table><thead><tr><th>Target</th><th>Severity</th><th>Confidence</th><th>Root / upstream</th><th>Recent deployment</th><th>Assessment</th></tr></thead><tbody>${rows||'<tr><td colspan="6">There are no active diagnostic targets.</td></tr>'}</tbody></table></section><p><a href="/">← Curator Ops</a> · <a href="/incidents">Correlated Incidents</a> · <a href="/timeline">History Intelligence</a> · <a href="/briefing">Current Briefing</a></p></main></body></html>`;
}

function renderDiagnosticDetail(snapshot,d){
  const evidenceRows=(d.evidence||[]).map(e=>`<tr><td>${esc(e.kind)}</td><td>${esc(e.strength)}</td><td>${esc(e.message)}</td></tr>`).join('');
  const checks=(d.nextChecks||[]).map(x=>`<li>${esc(x)}</li>`).join('');
  const deploy=d.deploymentCorrelation?.match
    ?`<div class="note"><strong>Recent deployment:</strong> ${esc(d.deploymentCorrelation.service||d.deploymentCorrelation.serviceId)} · <code>${esc(shortSha(d.deploymentCorrelation.commit))}</code> · ${d.deploymentCorrelation.minutesBeforeIncident} minutes before onset.<br><span class="muted">Temporal correlation only; causal: false.</span></div>`
    :'';

  return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(d.title)} · Diagnostic · Curator Ops</title>${style()}</head><body><main class="wrap"><div class="eyebrow">CuratorOS · Why is this red?</div><h1>${esc(d.title)}</h1><p class="lede">${esc(d.conclusion)}</p><section class="cards"><div class="card"><div class="label">Severity</div><div class="value">${esc(d.severity)}</div></div><div class="card"><div class="label">Confidence</div><div class="value">${esc(d.confidence)}</div></div><div class="card"><div class="label">Classification</div><div class="value" style="font-size:18px">${esc(d.rootCause?.classification||d.state||'independent')}</div></div><div class="card"><div class="label">Signals</div><div class="value">${d.evidence?.length??0}</div></div></section>${d.rootCause?`<div class="note"><strong>Root / upstream cause:</strong> ${esc(d.rootCause.name)} — ${esc(d.rootCause.message)}</div>`:''}${deploy}<h2>Evidence chain</h2><section class="table"><table><thead><tr><th>Evidence</th><th>Strength</th><th>What it says</th></tr></thead><tbody>${evidenceRows||'<tr><td colspan="3">No structured evidence was retained.</td></tr>'}</tbody></table></section><h2>What to check next</h2><ol class="checks">${checks||'<li>Collect another independent signal before escalating the diagnosis.</li>'}</ol><p><a href="/diagnose">← All diagnostics</a> · <a href="/incidents">Correlated Incidents</a> · <a href="/timeline">History Intelligence</a></p></main></body></html>`;
}

function evidence(kind,strength,message,data){return{kind,strength,message,data:data||{}}}
function shortSha(v){return v?String(v).slice(0,8):'—'}
function severityFromIncident(v){return v==='p0'||v==='p1'?'attention':'observing'}
function severityRank(v){return v==='attention'?3:v==='degraded'?2:v==='observing'?1:0}
function confidenceRank(v){return v==='high'?3:v==='medium'?2:v==='low'?1:0}
function clean(v,max=500){return String(v??'').trim().slice(0,max)}
function slug(v){return clean(v,120).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'unknown'}
function escClass(v){return ['healthy','warming','observing','degraded','persistent','attention','unknown'].includes(String(v))?String(v):'unknown'}
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function requireBindings(env){if(!env?.[OPS_KV])throw new Error(`${OPS_KV} binding is required`);if(!env?.[ERROR_KV])throw new Error(`${ERROR_KV} binding is required`)}
function json(value,status=200){return new Response(JSON.stringify(value,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}})}
function html(value){return new Response(value,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})}
function style(){return`<style>:root{color-scheme:dark;--bg:#0a1110;--panel:#101918;--brass:#bfa46a;--text:#f3eee3;--muted:#9aa6a0;--line:#263330}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Georgia,serif}.wrap{max-width:1240px;margin:auto;padding:58px 20px}.eyebrow{font:600 12px system-ui;letter-spacing:.18em;text-transform:uppercase;color:var(--brass)}h1{font-size:clamp(38px,7vw,62px);font-weight:400}.lede{max-width:930px;color:#d3d6d1;line-height:1.6}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:28px 0}.card,.table,.note{border:1px solid var(--line);background:var(--panel);border-radius:16px}.card,.note{padding:18px}.label{font:600 11px system-ui;color:var(--muted);text-transform:uppercase}.value{font-size:27px;margin-top:8px}.table{overflow:auto;margin:18px 0}table{width:100%;border-collapse:collapse;min-width:920px;font:13px/1.5 system-ui}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase}a,code{color:#e9d49e}.note,.checks{font:13px/1.65 system-ui;color:#d3d6d1}.muted{color:var(--muted)}h2{font-weight:400;margin-top:34px}@media(max-width:800px){.cards{grid-template-columns:1fr 1fr}}@media(max-width:520px){.cards{grid-template-columns:1fr}}</style>`}
