import base from './entry-v1.3.js';

const OPS_KV='CURATOR_OPS_RECORDS';
const ERROR_KV='CURATOR_ERROR_RECORDS';
const REACHABILITY_KEY='snapshot:latest';
const DRIFT_KEY='deployment-drift:latest';
const FRESHNESS_KEY='scheduled-freshness:latest';
const BRIDGE_KEY='error-bus-bridge:latest';
const INCIDENT_PREFIX='incident:';
const EVENT_PREFIX='event:';
const RECOVERED_TTL=60*60*24*180;

export default{
  async fetch(request,env,ctx){
    const u=new URL(request.url);
    if(request.method==='GET'&&u.pathname==='/api/error-bus-bridge')return json({ok:true,snapshot:await readBridge(env)});
    if(request.method==='POST'&&u.pathname==='/api/error-bus-bridge-check-now')return json({ok:true,snapshot:await reconcile(env,'manual')});
    return base.fetch(request,env,ctx);
  },
  async scheduled(controller,env,ctx){
    const result=base.scheduled(controller,env,ctx);
    ctx.waitUntil(reconcile(env,`cron:${controller?.cron||'unknown'}`).catch(e=>console.error('Ops Error Bus bridge failed',e)));
    return result;
  }
};

async function reconcile(env,source){
  requireBindings(env);
  const [reachability,drift,freshness]=await Promise.all([
    env[OPS_KV].get(REACHABILITY_KEY,'json'),
    env[OPS_KV].get(DRIFT_KEY,'json'),
    env[OPS_KV].get(FRESHNESS_KEY,'json')
  ]);

  const desired=[];
  for(const s of reachability?.services||[]){
    if(s.effectiveState==='persistent')desired.push({
      fingerprint:`ops-reachability-${slug(s.id)}`,
      component:`reachability:${s.id}`,
      type:'ops-persistent-unreachable',
      severity:'p1',
      message:`${s.name} has failed ${Number(s.failureStreak||3)} consecutive Curator Ops reachability checks.`,
      context:{serviceId:s.id,url:s.url,httpStatus:s.status??null,failureStreak:s.failureStreak??null,firstFailureAt:s.firstFailureAt??null,lastFailureAt:s.lastFailureAt??null,error:s.error??null}
    });
  }
  for(const s of drift?.services||[]){
    if(s.state==='drift')desired.push({
      fingerprint:`ops-deployment-drift-${slug(s.id)}`,
      component:`deployment:${s.id}`,
      type:'ops-deployment-drift',
      severity:'p1',
      message:`${s.name} is running a different commit than GitHub main beyond the deployment grace period.`,
      context:{serviceId:s.id,runningCommit:s.running?.commit??null,githubCommit:s.github?.commit??null,version:s.running?.version??null,assessment:s.message??null}
    });
  }
  for(const s of freshness?.services||[]){
    if(s.status==='stale')desired.push({
      fingerprint:`ops-scheduled-stale-${slug(s.id)}`,
      component:`scheduled:${s.id}`,
      type:'ops-scheduled-stale',
      severity:'p1',
      message:`${s.name} scheduled work is stale in Curator Ops.`,
      context:{serviceId:s.id,lastSuccessAt:s.lastSuccessAt??null,ageMinutes:s.ageMinutes??null,maxAgeMinutes:s.maxAgeMinutes??null,schedule:compactSchedule(s.schedule)}
    });
  }

  const desiredMap=new Map(desired.map(x=>[x.fingerprint,x]));
  const managed=await listManagedIncidents(env);
  const opened=[],updated=[],recovered=[];

  for(const spec of desired){
    const result=await upsertManagedIncident(env,spec);
    (result.opened?opened:updated).push(result.incident);
  }
  for(const incident of managed){
    if(desiredMap.has(incident.fingerprint))continue;
    if(['active','degraded'].includes(incident.status)){
      const r=await recoverManagedIncident(env,incident,'Curator Ops verified that the operational condition cleared.');
      if(r)recovered.push(r);
    }
  }

  const snapshot={generatedAt:new Date().toISOString(),source,activeManaged:desired.length,opened:opened.length,updated:updated.length,recovered:recovered.length,status:desired.length?'attention':'healthy',managedFingerprints:desired.map(x=>x.fingerprint)};
  await env[OPS_KV].put(BRIDGE_KEY,JSON.stringify(snapshot),{expirationTtl:60*60*24*30});
  return snapshot;
}

async function upsertManagedIncident(env,spec){
  const key=INCIDENT_PREFIX+spec.fingerprint;
  const previous=await env[ERROR_KV].get(key,'json');
  const now=new Date().toISOString();
  const opened=!previous||!['active','degraded'].includes(previous.status);
  const incident={
    id:previous?.id||`incident_${spec.fingerprint.slice(0,20)}`,
    fingerprint:spec.fingerprint,
    source:'Curator Ops',
    component:spec.component,
    severity:spec.severity,
    type:spec.type,
    message:spec.message,
    context:sanitize(spec.context),
    firstSeenAt:opened?now:(previous?.firstSeenAt||now),
    lastSeenAt:now,
    occurrences:opened?1:Math.max(1,Number(previous?.occurrences||0)+1),
    status:'active',
    recoveredAt:null,
    recoveryMessage:null,
    lastSuccessfulAt:previous?.lastSuccessfulAt||null
  };
  await env[ERROR_KV].put(key,JSON.stringify(incident));
  if(opened)await writeEvent(env,'ops-incident',incident);
  return{opened,incident};
}

async function recoverManagedIncident(env,incident,message){
  const key=INCIDENT_PREFIX+incident.fingerprint;
  const now=new Date().toISOString();
  const recovered={...incident,status:'recovered',recoveredAt:now,lastSuccessfulAt:now,recoveryMessage:message};
  await env[ERROR_KV].put(key,JSON.stringify(recovered),{expirationTtl:RECOVERED_TTL});
  await writeEvent(env,'ops-recovery',recovered);
  return recovered;
}

async function listManagedIncidents(env){
  const listed=await env[ERROR_KV].list({prefix:INCIDENT_PREFIX+'ops-',limit:1000});
  const out=[];
  for(const k of listed.keys){const v=await env[ERROR_KV].get(k.name,'json');if(v?.source==='Curator Ops')out.push(v)}
  return out;
}

async function writeEvent(env,kind,incident){
  const at=new Date().toISOString();
  const key=`${EVENT_PREFIX}${at}:${Math.random().toString(36).slice(2,8)}`;
  await env[ERROR_KV].put(key,JSON.stringify({kind,at,incidentId:incident.id,fingerprint:incident.fingerprint,source:incident.source,component:incident.component,severity:incident.severity,status:incident.status,message:incident.message}),{expirationTtl:RECOVERED_TTL});
}

async function readBridge(env){
  requireBindings(env);
  return await env[OPS_KV].get(BRIDGE_KEY,'json')||{generatedAt:null,source:null,activeManaged:0,opened:0,updated:0,recovered:0,status:'warming',managedFingerprints:[]};
}
function compactSchedule(v){if(!v||typeof v!=='object')return null;const out={};for(const [k,x] of Object.entries(v).slice(0,8)){if(x==null||['string','number','boolean'].includes(typeof x))out[k]=x}return out}
function sanitize(v){if(!v||typeof v!=='object'||Array.isArray(v))return{};const out={};for(const [k,x] of Object.entries(v).slice(0,30)){if(/token|secret|password|authorization|cookie/i.test(k))continue;if(x==null||['string','number','boolean'].includes(typeof x))out[String(k).slice(0,80)]=typeof x==='string'?x.slice(0,4000):x}return out}
function slug(v){return String(v??'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'unknown'}
function requireBindings(env){if(!env[OPS_KV])throw new Error(`${OPS_KV} KV binding is not configured.`);if(!env[ERROR_KV])throw new Error(`${ERROR_KV} KV binding is not configured.`)}
function json(v,s=200){return new Response(JSON.stringify(v,null,2),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}})}
