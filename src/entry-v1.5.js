import base from './entry-v1.4.js';

const OPS_KV='CURATOR_OPS_RECORDS';
const ERROR_KV='CURATOR_ERROR_RECORDS';
const REACHABILITY_KEY='snapshot:latest';
const DRIFT_KEY='deployment-drift:latest';
const FRESHNESS_KEY='scheduled-freshness:latest';
const BRIDGE_KEY='error-bus-bridge:latest';
const EVENT_PREFIX='event:';
const DISPLAY_TIME_ZONE='America/Chicago';

export default{
  async fetch(request,env,ctx){
    const u=new URL(request.url);
    if(request.method==='GET'&&u.pathname==='/api/history'){
      const limit=clampInt(u.searchParams.get('limit'),1,200,60);
      return json({ok:true,generatedAt:new Date().toISOString(),events:await readHistory(env,limit)});
    }
    if(request.method==='GET'&&u.pathname==='/history'){
      return html(renderHistory(await readHistory(env,120)));
    }
    if(request.method==='GET'&&u.pathname==='/api/curator-intelligence'){
      const payload=await buildIntelligence(env);
      const callback=safeCallback(u.searchParams.get('callback'));
      return callback?javascript(payload,callback):json(payload);
    }
    return base.fetch(request,env,ctx);
  },
  async scheduled(controller,env,ctx){return base.scheduled(controller,env,ctx)}
};

async function buildIntelligence(env){
  requireBindings(env);
  const [reachability,drift,freshness,bridge]=await Promise.all([
    env[OPS_KV].get(REACHABILITY_KEY,'json'),
    env[OPS_KV].get(DRIFT_KEY,'json'),
    env[OPS_KV].get(FRESHNESS_KEY,'json'),
    env[OPS_KV].get(BRIDGE_KEY,'json')
  ]);
  const rs=reachability?.summary||{},ds=drift?.summary||{},fs=freshness?.summary||{},bs=bridge||{};
  const persistent=Number(rs.persistent||0);
  const driftCount=Number(ds.drift||0);
  const stale=Number(fs.stale||0)+Number(fs.unreachable||0);
  const activeManaged=Number(bs.activeManaged||0);
  const status=activeManaged||persistent||driftCount||stale?'warning':(Number(rs.degraded||0)||Number(rs.observing||0)||Number(ds.pending||0)||Number(ds.unknown||0)||Number(fs.unknown||0))?'attention':'good';
  const statusLabel=status==='good'?'Operationally healthy':status==='warning'?'Operational attention':'Observing';
  const total=Number(ds.total||drift?.services?.length||0);
  const inSync=Number(ds.inSync||0);
  const healthyJobs=Number(fs.healthy||0);
  const totalJobs=Number(fs.total||freshness?.services?.length||0);
  const latest=[reachability?.generatedAt,drift?.generatedAt,freshness?.generatedAt,bridge?.generatedAt].filter(Boolean).sort().at(-1)||null;
  return{
    ok:true,
    schemaVersion:1,
    generatedAt:new Date().toISOString(),
    system:{
      id:'curator-ops',
      name:'Curator Ops',
      status,
      statusLabel,
      value:status==='good'?'Fleet healthy':`${activeManaged||persistent+driftCount+stale} operational condition${(activeManaged||persistent+driftCount+stale)===1?'':'s'}`,
      summary:status==='good'?'Deployment truth, scheduled freshness, and persistence-aware reachability are all healthy.':'Curator Ops has detected an operational condition that warrants attention.',
      detail:`Deployments ${inSync}/${total||'—'} in sync · Scheduled ${healthyJobs}/${totalJobs||'—'} healthy · Persistent reachability ${persistent}`,
      url:'https://ops.oceanlinercurator.com/'
    },
    metrics:{
      deploymentsInSync:inSync,
      deploymentTotal:total,
      deploymentDrift:driftCount,
      scheduledHealthy:healthyJobs,
      scheduledTotal:totalJobs,
      scheduledStale:stale,
      persistentReachability:persistent,
      activeManagedIncidents:activeManaged,
      lastOpsCheck:latest
    },
    priorities:[],opportunities:[],
    activity:[{title:'Curator Ops reporting live',summary:`${inSync}/${total||'—'} deployments in sync; ${healthyJobs}/${totalJobs||'—'} scheduled jobs healthy; ${persistent} persistent reachability failures.`,meta:`Operational control plane · ${latest||'snapshot pending'}`}],
    capabilities:{deploymentTruth:true,scheduledFreshness:true,persistenceAwareReachability:true,errorBusEscalation:true,operationalHistory:true}
  };
}

async function readHistory(env,limit){
  requireBindings(env);
  const listed=await env[ERROR_KV].list({prefix:EVENT_PREFIX,limit:1000});
  const rows=[];
  for(const k of listed.keys){
    const v=await env[ERROR_KV].get(k.name,'json');
    if(!v||v.source!=='Curator Ops')continue;
    if(!['ops-incident','ops-recovery'].includes(v.kind))continue;
    rows.push(v);
  }
  rows.sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')));
  return rows.slice(0,limit);
}

function renderHistory(events){
  const rows=events.map(e=>`<tr><td>${formatCentral(e.at)}</td><td><span class="dot ${e.kind==='ops-recovery'?'healthy':'attention'}"></span>${esc(e.kind==='ops-recovery'?'Recovered':'Incident')}</td><td>${esc(e.component||'—')}</td><td>${esc(e.message||'—')}</td></tr>`).join('')||'<tr><td colspan="4">No Curator Ops incidents or recoveries have been recorded yet.</td></tr>';
  return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Operational History · Curator Ops</title><style>:root{color-scheme:dark;--bg:#0a1110;--panel:#101918;--brass:#bfa46a;--text:#f3eee3;--muted:#9aa6a0;--line:#263330}*{box-sizing:border-box}body{margin:0;background:#0a1110;color:var(--text);font-family:Georgia,serif}.wrap{max-width:1220px;margin:auto;padding:58px 20px}.eyebrow{font:600 12px system-ui;letter-spacing:.18em;text-transform:uppercase;color:var(--brass)}h1{font-size:clamp(38px,7vw,62px);font-weight:400}.lede{color:#d3d6d1;max-width:820px;line-height:1.6}.table{overflow:auto;border:1px solid var(--line);background:var(--panel);border-radius:16px;margin-top:26px}table{width:100%;border-collapse:collapse;min-width:900px;font:14px system-ui}th,td{text-align:left;padding:14px 16px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:8px}.healthy{background:#58c77a}.attention{background:#d86666}a{color:#e9d49e}</style></head><body><main class="wrap"><div class="eyebrow">CuratorOS · Operational Control Plane</div><h1>Operational History</h1><p class="lede">A concise audit trail of persistent operational incidents promoted by Curator Ops and the recoveries that cleared them. Quiet observations that never became persistent are intentionally omitted.</p><div class="table"><table><thead><tr><th>Time · Central</th><th>Event</th><th>Component</th><th>Message</th></tr></thead><tbody>${rows}</tbody></table></div><p><a href="/">← Curator Ops</a> · <a href="/deployments">Deployment Drift</a> · <a href="/scheduled">Scheduled Work</a></p></main></body></html>`;
}

function safeCallback(v){return /^[A-Za-z_$][0-9A-Za-z_$\.]{0,100}$/.test(String(v||''))?String(v):null}
function javascript(payload,callback){return new Response(`${callback}(${JSON.stringify(payload)});`,{headers:{'content-type':'application/javascript; charset=utf-8','cache-control':'no-store'}})}
function clampInt(v,min,max,fallback){const n=Number.parseInt(v,10);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback}
function formatCentral(value){if(!value)return'—';const d=new Date(value);if(Number.isNaN(d.getTime()))return'—';return new Intl.DateTimeFormat('en-US',{timeZone:DISPLAY_TIME_ZONE,month:'numeric',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(d)}
function esc(v){return String(v??'').replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]))}
function requireBindings(env){if(!env[OPS_KV])throw new Error(`${OPS_KV} KV binding is not configured.`);if(!env[ERROR_KV])throw new Error(`${ERROR_KV} KV binding is not configured.`)}
function json(v,s=200){return new Response(JSON.stringify(v,null,2),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}})}
function html(v){return new Response(v,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})}
