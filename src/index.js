const KV = 'CURATOR_OPS_RECORDS';
const SNAPSHOT_KEY = 'snapshot:latest';
const HISTORY_PREFIX = 'snapshot:';
const HEARTBEAT_PREFIX = 'heartbeat:';
const DEPLOYMENT_PREFIX = 'deployment:';
const REQUEST_TIMEOUT_MS = 10000;
const DISPLAY_TIME_ZONE = 'America/Chicago';

const SERVICES = [
  { id:'public-site', name:'Ocean Liner Curator', url:'https://oceanliners.net/', kind:'public-site' },
  { id:'curatoros', name:'CuratorOS', url:'https://curator.oceanliners.net/', kind:'tool' },
  { id:'curator-intelligence', name:'Curator Intelligence', url:'https://tools.oceanliners.net/', kind:'tool' },
  { id:'error-bus', name:'Error Bus', url:'https://errors.oceanliners.net/api/status', kind:'api' },
  { id:'verify', name:'Curator Verify', url:'https://verify.oceanlinercurator.com/api/status', kind:'api' },
  { id:'site-health', name:'Site Health', url:'https://site-health.oceanliners.net/', kind:'tool' },
  { id:'integrity', name:'Curator Integrity', url:'https://integrity.oceanliners.net/', kind:'tool' },
  { id:'speed', name:'Curator Speed', url:'https://speed.oceanliners.net/', kind:'tool' },
  { id:'indexer', name:'Curator Indexer', url:'https://curator-indexer.oceanliners.net/', kind:'tool' },
  { id:'search-intelligence', name:'Search Intelligence', url:'https://search-intelligence.oceanliners.net/', kind:'tool' },
  { id:'link-map', name:'Link Map', url:'https://link-map.oceanliners.net/', kind:'tool' },
  { id:'page-studio', name:'Page Studio', url:'https://page-studio.oceanliners.net/', kind:'tool' },
  { id:'launcher', name:'CuratorOS Launcher', url:'https://launch.oceanliners.net/', kind:'tool' },
  { id:'analytics', name:'Curator Analytics', url:'https://analytics.oceanliners.net/', kind:'tool' },
  { id:'content-opportunity', name:'Content Opportunity', url:'https://content.oceanliners.net/', kind:'tool' }
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return html(renderHome(await readSnapshot(env)));
    if (request.method === 'GET' && url.pathname === '/api/status') {
      const snapshot = await readSnapshot(env);
      return json({ ok:true, service:'Curator Ops', version:'1.0.3', generatedAt:new Date().toISOString(), displayTimeZone:DISPLAY_TIME_ZONE, accessServiceAuthConfigured:Boolean(env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET), snapshot });
    }
    if (request.method === 'POST' && url.pathname === '/api/check-now') return json({ ok:true, snapshot:await runChecks(env, 'manual') });
    if (request.method === 'POST' && url.pathname === '/api/heartbeat') {
      const auth = authorizeWrite(request, env); if (!auth.ok) return json({ ok:false, error:auth.error }, auth.status);
      return json({ ok:true, heartbeat:await recordHeartbeat(env, await readJson(request)) }, 201);
    }
    if (request.method === 'POST' && url.pathname === '/api/deployment') {
      const auth = authorizeWrite(request, env); if (!auth.ok) return json({ ok:false, error:auth.error }, auth.status);
      return json({ ok:true, deployment:await recordDeployment(env, await readJson(request)) }, 201);
    }
    return json({ ok:false, error:'Not found.' }, 404);
  },
  async scheduled(controller, env, ctx) { ctx.waitUntil(runChecks(env, `cron:${controller?.cron || 'unknown'}`).catch(error => console.error('Ops scheduled check failed', error))); }
};

async function runChecks(env, source) {
  requireKv(env); const results=[]; for(const service of SERVICES) results.push(await probe(service, env));
  const healthy=results.filter(x=>x.ok).length, degraded=results.length-healthy;
  const snapshot={ generatedAt:new Date().toISOString(), source, displayTimeZone:DISPLAY_TIME_ZONE, accessServiceAuthConfigured:Boolean(env.CF_ACCESS_CLIENT_ID&&env.CF_ACCESS_CLIENT_SECRET), summary:{total:results.length,healthy,degraded,status:degraded?'attention':'healthy'}, services:results };
  await env[KV].put(SNAPSHOT_KEY,JSON.stringify(snapshot)); const ts=Date.parse(snapshot.generatedAt)||Date.now();
  await env[KV].put(`${HISTORY_PREFIX}${String(9999999999999-ts).padStart(13,'0')}:${crypto.randomUUID()}`,JSON.stringify(snapshot),{expirationTtl:60*60*24*30}); return snapshot;
}

async function probe(service, env) {
  const started=Date.now(), controller=new AbortController(), timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS); let status=null,finalUrl=null,contentType=null;
  try {
    const target=new URL(service.url); target.searchParams.set('opsProbe',Date.now().toString());
    const outbound=new Request(target.href,{
      method:'GET',
      redirect:'follow',
      cache:'no-store',
      headers:{
        'user-agent':'CuratorOps/1.0 (+https://ops.oceanlinercurator.com)',
        accept:'text/html,application/json,*/*;q=0.8'
      },
      signal:controller.signal
    });
    applyAccessHeaders(outbound,env,target);
    const response=await fetch(outbound);
    status=response.status; finalUrl=response.url; contentType=response.headers.get('content-type');
    return {id:service.id,name:service.name,kind:service.kind,url:service.url,ok:response.ok,status,finalUrl,contentType,error:null,durationMs:Date.now()-started,checkedAt:new Date().toISOString()};
  } catch(err) {
    const error=err?.name==='AbortError'?'timeout':String(err?.message||err||'fetch failed');
    return {id:service.id,name:service.name,kind:service.kind,url:service.url,ok:false,status,finalUrl,contentType,error,durationMs:Date.now()-started,checkedAt:new Date().toISOString()};
  } finally { clearTimeout(timer); }
}

function applyAccessHeaders(request,env,target){
  if(!env.CF_ACCESS_CLIENT_ID||!env.CF_ACCESS_CLIENT_SECRET)return;
  let host='';
  try{host=(target instanceof URL?target:new URL(target)).hostname.toLowerCase()}catch{return}
  const owned=host==='oceanliners.net'||host.endsWith('.oceanliners.net')||host==='oceanlinercurator.com'||host.endsWith('.oceanlinercurator.com');
  if(!owned)return;
  request.headers.set('cf-access-client-id',env.CF_ACCESS_CLIENT_ID);
  request.headers.set('cf-access-client-secret',env.CF_ACCESS_CLIENT_SECRET);
}

async function readSnapshot(env){requireKv(env);return await env[KV].get(SNAPSHOT_KEY,'json')||{generatedAt:null,source:null,displayTimeZone:DISPLAY_TIME_ZONE,summary:{total:SERVICES.length,healthy:0,degraded:0,status:'unknown'},services:SERVICES.map(s=>({id:s.id,name:s.name,kind:s.kind,url:s.url,ok:null,status:null,error:null}))}}
async function recordHeartbeat(env,body){requireKv(env);const service=clean(body?.service,100);if(!service)throw new Error('service is required');const now=new Date().toISOString(),record={service,status:clean(body?.status||'online',40),version:clean(body?.version,120)||null,commit:clean(body?.commit,120)||null,runtime:clean(body?.runtime,120)||null,note:clean(body?.note,500)||null,observedAt:now};await env[KV].put(`${HEARTBEAT_PREFIX}${slug(service)}`,JSON.stringify(record),{expirationTtl:60*60*24*30});return record}
async function recordDeployment(env,body){requireKv(env);const service=clean(body?.service,100);if(!service)throw new Error('service is required');const now=new Date().toISOString(),record={id:crypto.randomUUID(),service,commit:clean(body?.commit,120)||null,version:clean(body?.version,120)||null,environment:clean(body?.environment||'production',80),provider:clean(body?.provider||'cloudflare',80),source:clean(body?.source||'reported',80),deployedAt:clean(body?.deployedAt,80)||now,recordedAt:now};const ts=Date.parse(record.deployedAt)||Date.now(),key=`${DEPLOYMENT_PREFIX}${slug(service)}:${String(9999999999999-ts).padStart(13,'0')}:${record.id}`;await env[KV].put(key,JSON.stringify(record),{expirationTtl:60*60*24*365});await env[KV].put(`${DEPLOYMENT_PREFIX}latest:${slug(service)}`,JSON.stringify(record),{expirationTtl:60*60*24*365});return record}
function authorizeWrite(request,env){if(!env.OPS_WRITE_KEY)return{ok:false,status:503,error:'OPS_WRITE_KEY is not configured.'};const supplied=request.headers.get('x-curator-ops-key')||'';if(!supplied||supplied!==env.OPS_WRITE_KEY)return{ok:false,status:401,error:'Unauthorized.'};return{ok:true}}
async function readJson(request){try{return await request.json()}catch{throw new Error('Expected a JSON request body.')}}
function formatCentral(value){if(!value)return'—';const date=new Date(value);if(Number.isNaN(date.getTime()))return'—';return new Intl.DateTimeFormat('en-US',{timeZone:DISPLAY_TIME_ZONE,month:'numeric',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(date)}
function requireKv(env){if(!env[KV])throw new Error(`${KV} KV binding is not configured.`)}function clean(value,max=500){return String(value??'').trim().slice(0,max)}function slug(value){return clean(value,120).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'unknown'}function json(value,status=200){return new Response(JSON.stringify(value,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}})}function html(value){return new Response(value,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})}
function renderHome(snapshot){
  const rows=(snapshot.services||[]).map(s=>`<tr><td><span class="dot ${s.ok===true?'ok':s.ok===false?'bad':'unknown'}"></span>${escapeHtml(s.name)}</td><td>${s.status??'—'}</td><td>${s.durationMs!=null?`${s.durationMs} ms`:'—'}</td><td>${escapeHtml(s.error||'—')}</td><td>${s.checkedAt?formatCentral(s.checkedAt):'Not checked yet'}</td></tr>`).join(''),summary=snapshot.summary||{};
  return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Curator Ops</title><style>:root{color-scheme:dark;--bg:#0a1110;--panel:#101918;--brass:#bfa46a;--text:#f3eee3;--muted:#9aa6a0;--line:#263330}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 50% -20%,#17221f 0,#0a1110 52%);color:var(--text);font-family:Georgia,'Times New Roman',serif;min-height:100vh}.wrap{max-width:1220px;margin:0 auto;padding:58px 20px}.eyebrow{font:600 12px system-ui,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:var(--brass)}h1{font-size:clamp(38px,7vw,64px);font-weight:400;margin:.18em 0}.lede{max-width:760px;color:#d3d6d1;font-size:18px;line-height:1.6}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:30px 0}.card,.table{border:1px solid var(--line);background:rgba(16,25,24,.84);border-radius:16px}.card{padding:20px}.label{font:600 11px system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}.value{font-size:30px;margin-top:8px}.table{overflow-x:auto}table{width:100%;border-collapse:collapse;font:14px system-ui,sans-serif;min-width:1000px}th,td{text-align:left;padding:14px 16px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.1em}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:9px}.ok{background:#58c77a}.bad{background:#d86666}.unknown{background:#8b9490}.tz{color:var(--muted);font:12px system-ui,sans-serif;margin-top:8px}footer{margin-top:28px;color:#6f7974;font:12px system-ui,sans-serif}@media(max-width:700px){.cards{grid-template-columns:1fr}}</style></head><body><main class="wrap"><div class="eyebrow">CuratorOS · Operational Control Plane</div><h1>Curator Ops</h1><p class="lede">Tracks the machinery behind CuratorOS: service reachability, runtime freshness, deployment reports, and operational drift. It does not judge site content.</p><section class="cards"><div class="card"><div class="label">Overall</div><div class="value">${escapeHtml(summary.status||'unknown')}</div></div><div class="card"><div class="label">Healthy</div><div class="value">${summary.healthy??0}/${summary.total??SERVICES.length}</div></div><div class="card"><div class="label">Last snapshot</div><div class="value" style="font-size:18px">${snapshot.generatedAt?formatCentral(snapshot.generatedAt):'Waiting for first check'}</div><div class="tz">US Central time</div></div></section><section class="table"><table><thead><tr><th>Service</th><th>HTTP</th><th>Latency</th><th>Error</th><th>Checked · Central</th></tr></thead><tbody>${rows}</tbody></table></section><footer>Ocean Liner Curator · CuratorOS Operations Layer</footer></main></body></html>`}
function escapeHtml(value){return String(value??'').replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]))}
