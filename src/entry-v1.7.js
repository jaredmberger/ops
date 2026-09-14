import base from './entry-v1.6.js';

const OPS_KV='CURATOR_OPS_RECORDS';
const ERROR_KV='CURATOR_ERROR_RECORDS';
const SELFTEST_KEY='self-test:latest';
const SELFTEST_STATE_KEY='self-test:state';
const OPS_SENTINEL_KEY='self-test:sentinel:ops';
const ERROR_SENTINEL_KEY='ops-self-test:sentinel:error-bus';
const INCIDENT_KEY='incident:ops-self-test-storage';
const EVENT_PREFIX='event:';
const SENTINEL_TTL=60*60;
const MAX_SENTINEL_AGE_MS=15*60*1000;
const RECOVERED_TTL=60*60*24*180;
const DISPLAY_TIME_ZONE='America/Chicago';

export default{
  async fetch(request,env,ctx){
    const u=new URL(request.url);
    if(request.method==='GET'&&u.pathname==='/api/self-test')return json({ok:true,snapshot:await readSelfTest(env)});
    if(request.method==='POST'&&u.pathname==='/api/self-test-check-now')return json({ok:true,snapshot:await runSelfTest(env,'manual')});
    if(request.method==='GET'&&u.pathname==='/self-test')return html(renderSelfTest(await readSelfTest(env)));
    return base.fetch(request,env,ctx);
  },
  async scheduled(controller,env,ctx){
    const result=base.scheduled(controller,env,ctx);
    ctx.waitUntil(runSelfTest(env,`cron:${controller?.cron||'unknown'}`).catch(e=>console.error('Ops self-test failed',e)));
    return result;
  }
};

async function runSelfTest(env,source){
  requireBindings(env);
  const now=new Date().toISOString();
  const token=crypto.randomUUID();
  const steps=[];

  steps.push(await verifyPriorSentinel(env[OPS_KV],OPS_SENTINEL_KEY,'ops-kv-read','Ops KV prior sentinel'));
  steps.push(await verifyPriorSentinel(env[ERROR_KV],ERROR_SENTINEL_KEY,'error-kv-read','Error Bus KV prior sentinel'));
  steps.push(await writeSentinel(env[OPS_KV],OPS_SENTINEL_KEY,'ops-kv-write','Ops KV write',token,now));
  steps.push(await writeSentinel(env[ERROR_KV],ERROR_SENTINEL_KEY,'error-kv-write','Error Bus KV write',token,now));

  const failures=steps.filter(s=>s.status==='fail');
  const warming=steps.filter(s=>s.status==='warming');
  const prior=await env[OPS_KV].get(SELFTEST_STATE_KEY,'json');
  const failureStreak=failures.length?Number(prior?.failureStreak||0)+1:0;
  const firstFailureAt=failures.length?(prior?.firstFailureAt||now):null;
  const lastFailureAt=failures.length?now:null;
  const effectiveState=failures.length?(failureStreak===1?'observing':failureStreak===2?'degraded':'persistent'):(warming.length?'warming':'healthy');
  const state={failureStreak,firstFailureAt,lastFailureAt,lastHealthyAt:failures.length?(prior?.lastHealthyAt||null):now,effectiveState,updatedAt:now};
  const snapshot={generatedAt:now,source,displayTimeZone:DISPLAY_TIME_ZONE,name:'CuratorOS Self-Test',ok:failures.length===0,effectiveState,failureStreak,firstFailureAt,lastFailureAt,lastHealthyAt:state.lastHealthyAt,summary:{total:steps.length,passed:steps.filter(s=>s.status==='pass').length,warming:warming.length,failed:failures.length,status:effectiveState},steps};

  await env[OPS_KV].put(SELFTEST_STATE_KEY,JSON.stringify(state),{expirationTtl:60*60*24*30});
  await env[OPS_KV].put(SELFTEST_KEY,JSON.stringify(snapshot));
  await reconcileIncident(env,snapshot);
  return snapshot;
}

async function verifyPriorSentinel(kv,key,id,name){
  const started=Date.now();
  try{
    const value=await kv.get(key,'json');
    if(!value)return{id,name,status:'warming',ok:true,error:null,note:'No prior sentinel yet; next scheduled run can verify persistence.',durationMs:Date.now()-started};
    const writtenAt=Date.parse(value.writtenAt||'');
    if(!value.token||!Number.isFinite(writtenAt))throw new Error('prior sentinel is malformed');
    const ageMs=Date.now()-writtenAt;
    if(ageMs>MAX_SENTINEL_AGE_MS)throw new Error(`prior sentinel is stale (${Math.round(ageMs/60000)} min old)`);
    return{id,name,status:'pass',ok:true,error:null,note:`Previous run persisted ${Math.max(0,Math.round(ageMs/1000))}s ago.`,durationMs:Date.now()-started};
  }catch(error){
    return{id,name,status:'fail',ok:false,error:String(error?.message||error||'sentinel read failed'),note:null,durationMs:Date.now()-started};
  }
}

async function writeSentinel(kv,key,id,name,token,writtenAt){
  const started=Date.now();
  try{
    await kv.put(key,JSON.stringify({token,writtenAt}),{expirationTtl:SENTINEL_TTL});
    return{id,name,status:'pass',ok:true,error:null,note:'Sentinel write accepted.',durationMs:Date.now()-started};
  }catch(error){
    return{id,name,status:'fail',ok:false,error:String(error?.message||error||'sentinel write failed'),note:null,durationMs:Date.now()-started};
  }
}

async function reconcileIncident(env,snapshot){
  const previous=await env[ERROR_KV].get(INCIDENT_KEY,'json');
  const active=previous&&['active','degraded'].includes(previous.status);
  const now=new Date().toISOString();
  if(snapshot.effectiveState==='persistent'){
    const failed=snapshot.steps.filter(s=>s.status==='fail').map(s=>s.name);
    const incident={
      id:previous?.id||'incident_ops-self-test-storage',
      fingerprint:'ops-self-test-storage',
      source:'Curator Ops',
      component:'self-test:storage',
      severity:'p1',
      type:'ops-self-test-persistent-failure',
      message:`CuratorOS self-test has failed ${snapshot.failureStreak} consecutive checks.`,
      context:{failedSteps:failed.join(', '),failureStreak:snapshot.failureStreak,firstFailureAt:snapshot.firstFailureAt,lastFailureAt:snapshot.lastFailureAt},
      firstSeenAt:active?(previous.firstSeenAt||now):now,
      lastSeenAt:now,
      occurrences:active?Math.max(1,Number(previous.occurrences||0)+1):1,
      status:'active',recoveredAt:null,recoveryMessage:null,lastSuccessfulAt:previous?.lastSuccessfulAt||null
    };
    await env[ERROR_KV].put(INCIDENT_KEY,JSON.stringify(incident));
    if(!active)await writeEvent(env,'ops-incident',incident);
    return;
  }
  if(active){
    const recovered={...previous,status:'recovered',recoveredAt:now,lastSuccessfulAt:now,recoveryMessage:'Curator Ops verified that both monitoring KV paths are healthy again.'};
    await env[ERROR_KV].put(INCIDENT_KEY,JSON.stringify(recovered),{expirationTtl:RECOVERED_TTL});
    await writeEvent(env,'ops-recovery',recovered);
  }
}

async function writeEvent(env,kind,incident){
  const at=new Date().toISOString();
  const key=`${EVENT_PREFIX}${at}:${Math.random().toString(36).slice(2,8)}`;
  await env[ERROR_KV].put(key,JSON.stringify({kind,at,incidentId:incident.id,fingerprint:incident.fingerprint,source:incident.source,component:incident.component,severity:incident.severity,status:incident.status,message:incident.message}),{expirationTtl:RECOVERED_TTL});
}

async function readSelfTest(env){
  requireBindings(env);
  return await env[OPS_KV].get(SELFTEST_KEY,'json')||{generatedAt:null,source:null,displayTimeZone:DISPLAY_TIME_ZONE,name:'CuratorOS Self-Test',ok:null,effectiveState:'warming',failureStreak:0,firstFailureAt:null,lastFailureAt:null,lastHealthyAt:null,summary:{total:4,passed:0,warming:4,failed:0,status:'warming'},steps:[]};
}

function renderSelfTest(snapshot){
  const rows=(snapshot.steps||[]).map(s=>`<tr><td><span class="dot ${s.status==='pass'?'healthy':s.status==='fail'?'attention':'unknown'}"></span>${esc(s.name)}</td><td>${esc(s.status||'waiting')}</td><td>${s.durationMs!=null?`${s.durationMs} ms`:'—'}</td><td>${esc(s.error||s.note||'—')}</td></tr>`).join('')||'<tr><td colspan="4">Waiting for the first scheduled self-test.</td></tr>';
  const x=snapshot.summary||{};
  return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CuratorOS Self-Test · Curator Ops</title><style>:root{color-scheme:dark;--bg:#0a1110;--panel:#101918;--brass:#bfa46a;--text:#f3eee3;--muted:#9aa6a0;--line:#263330}*{box-sizing:border-box}body{margin:0;background:#0a1110;color:var(--text);font-family:Georgia,serif}.wrap{max-width:1100px;margin:auto;padding:58px 20px}.eyebrow{font:600 12px system-ui;letter-spacing:.18em;text-transform:uppercase;color:var(--brass)}h1{font-size:clamp(38px,7vw,62px);font-weight:400}.lede{max-width:820px;color:#d3d6d1;line-height:1.6}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:28px 0}.card,.table{border:1px solid var(--line);background:var(--panel);border-radius:16px}.card{padding:18px}.label{font:600 11px system-ui;color:var(--muted);text-transform:uppercase}.value{font-size:28px;margin-top:8px}.table{overflow:auto}table{width:100%;border-collapse:collapse;min-width:800px;font:14px system-ui}th,td{text-align:left;padding:14px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:9px}.healthy{background:#58c77a}.attention{background:#d86666}.unknown{background:#8b9490}a{color:#e9d49e}.tz{color:var(--muted);font:12px system-ui}@media(max-width:800px){.cards{grid-template-columns:1fr 1fr}}</style></head><body><main class="wrap"><div class="eyebrow">CuratorOS · Monitoring the Monitor</div><h1>CuratorOS Self-Test</h1><p class="lede">Confirms that Curator Ops can persist state in its own KV and that the Error Bus storage path can also accept and retain monitoring data. Each run verifies the previous run's sentinel before writing the next one.</p><p class="tz">The first run is expected to show warming for prior-sentinel reads. Persistent failures alone are escalated.</p><section class="cards"><div class="card"><div class="label">State</div><div class="value">${esc(snapshot.effectiveState||'warming')}</div></div><div class="card"><div class="label">Passed</div><div class="value">${x.passed||0}/${x.total||4}</div></div><div class="card"><div class="label">Failure streak</div><div class="value">${snapshot.failureStreak||0}</div></div><div class="card"><div class="label">Last check</div><div class="value" style="font-size:17px">${snapshot.generatedAt?formatCentral(snapshot.generatedAt):'Waiting'}</div></div></section><section class="table"><table><thead><tr><th>Check</th><th>Result</th><th>Duration</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></section><p><a href="/">← Curator Ops</a> · <a href="/journey">Public Site Journey</a> · <a href="/history">Operational History</a></p></main></body></html>`;
}

function formatCentral(value){if(!value)return'—';const d=new Date(value);if(Number.isNaN(d.getTime()))return'—';return new Intl.DateTimeFormat('en-US',{timeZone:DISPLAY_TIME_ZONE,month:'numeric',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(d)}
function esc(v){return String(v??'').replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]))}
function requireBindings(env){if(!env[OPS_KV])throw new Error(`${OPS_KV} KV binding is not configured.`);if(!env[ERROR_KV])throw new Error(`${ERROR_KV} KV binding is not configured.`)}
function json(v,s=200){return new Response(JSON.stringify(v,null,2),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}})}
function html(v){return new Response(v,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})}
