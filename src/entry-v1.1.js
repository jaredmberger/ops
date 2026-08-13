import base from './index.js';

const KV = 'CURATOR_OPS_RECORDS';
const RUNTIME_SNAPSHOT_KEY = 'runtime-snapshot:latest';
const RUNTIME_HISTORY_PREFIX = 'runtime-snapshot:';
const REQUEST_TIMEOUT_MS = 10000;

const RUNTIMES = [
  { id:'error-bus', name:'Error Bus', url:'https://errors.oceanliners.net/api/runtime', repository:'jaredmberger/errors' },
  { id:'verify', name:'Curator Verify', url:'https://verify.oceanlinercurator.com/api/runtime', repository:'jaredmberger/verify' },
  { id:'site-health', name:'Site Health', url:'https://site-health.oceanliners.net/api/runtime', repository:'jaredmberger/site-health' },
  { id:'integrity', name:'Curator Integrity', url:'https://integrity.oceanliners.net/api/runtime', repository:'jaredmberger/curator-integrity' },
  { id:'speed', name:'Curator Speed', url:'https://speed.oceanliners.net/api/runtime', repository:'jaredmberger/speed' },
  { id:'indexer', name:'Curator Indexer', url:'https://curator-indexer.oceanliners.net/api/runtime', repository:'jaredmberger/curator-indexer' },
  { id:'search-intelligence', name:'Search Intelligence', url:'https://search-intelligence.oceanliners.net/api/runtime', repository:'jaredmberger/search-intelligence' },
  { id:'analytics', name:'Curator Analytics', url:'https://analytics.oceanliners.net/api/runtime', repository:'jaredmberger/analytics' },
  { id:'content-opportunity', name:'Content Opportunity', url:'https://content.oceanliners.net/api/runtime', repository:'jaredmberger/content-opportunity' }
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/runtime') {
      const meta = env.CF_VERSION_METADATA || {};
      return json({ok:true,service:'Curator Ops',version:'1.1.4',repository:'jaredmberger/ops',runtime:'cloudflare-workers',cloudflareVersion:{id:meta.id||null,tag:meta.tag||null,timestamp:meta.timestamp||null},accessServiceAuthConfigured:Boolean(env.CF_ACCESS_CLIENT_ID&&env.CF_ACCESS_CLIENT_SECRET),observedAt:new Date().toISOString()});
    }
    if (request.method === 'GET' && url.pathname === '/api/runtime-status') return json({ ok:true, snapshot:await readRuntimeSnapshot(env) });
    if (request.method === 'POST' && url.pathname === '/api/runtime-check-now') return json({ ok:true, snapshot:await collectRuntimeIdentities(env, 'manual') });
    return base.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    const result = base.scheduled(controller, env, ctx);
    ctx.waitUntil(collectRuntimeIdentities(env, `cron:${controller?.cron || 'unknown'}`).catch(error => console.error('Ops runtime identity collection failed', error)));
    return result;
  }
};

async function collectRuntimeIdentities(env, source) {
  requireKv(env); const services=[]; for(const runtime of RUNTIMES) services.push(await probeRuntime(runtime,env));
  const identified=services.filter(x=>x.ok&&x.cloudflareVersion?.id).length;
  const snapshot={generatedAt:new Date().toISOString(),source,accessServiceAuthConfigured:Boolean(env.CF_ACCESS_CLIENT_ID&&env.CF_ACCESS_CLIENT_SECRET),summary:{total:services.length,identified,missing:services.length-identified,status:identified===services.length?'healthy':'attention'},services};
  await env[KV].put(RUNTIME_SNAPSHOT_KEY,JSON.stringify(snapshot)); const ts=Date.parse(snapshot.generatedAt)||Date.now(); await env[KV].put(`${RUNTIME_HISTORY_PREFIX}${String(9999999999999-ts).padStart(13,'0')}:${crypto.randomUUID()}`,JSON.stringify(snapshot),{expirationTtl:60*60*24*90}); return snapshot;
}
async function probeRuntime(service,env){const started=Date.now(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);try{const target=new URL(service.url);target.searchParams.set('opsRuntime',Date.now().toString());const response=await fetch(target.href,{method:'GET',redirect:'follow',cache:'no-store',headers:{accept:'application/json','user-agent':'CuratorOps-Runtime/1.4 (+https://ops.oceanlinercurator.com)',...accessHeaders(env,target)},signal:controller.signal});if(!response.ok)throw new Error(`HTTP ${response.status}`);const p=await response.json();return{id:service.id,name:service.name,repository:p.repository||service.repository,ok:Boolean(p.ok),reportedService:p.service||null,version:p.version||null,runtime:p.runtime||null,cloudflareVersion:p.cloudflareVersion||null,build:p.build||null,observedAt:p.observedAt||null,checkedAt:new Date().toISOString(),durationMs:Date.now()-started}}catch(error){return{id:service.id,name:service.name,repository:service.repository,ok:false,error:error?.name==='AbortError'?'timeout':(error?.message||String(error)),checkedAt:new Date().toISOString(),durationMs:Date.now()-started}}finally{clearTimeout(timer)}}
function accessHeaders(env,target){if(!env.CF_ACCESS_CLIENT_ID||!env.CF_ACCESS_CLIENT_SECRET)return{};const host=target.hostname.toLowerCase();const owned=host==='oceanliners.net'||host.endsWith('.oceanliners.net')||host==='oceanlinercurator.com'||host.endsWith('.oceanlinercurator.com');return owned?{'CF-Access-Client-Id':env.CF_ACCESS_CLIENT_ID,'CF-Access-Client-Secret':env.CF_ACCESS_CLIENT_SECRET}:{}}
async function readRuntimeSnapshot(env){requireKv(env);return await env[KV].get(RUNTIME_SNAPSHOT_KEY,'json')||{generatedAt:null,source:null,summary:{total:RUNTIMES.length,identified:0,missing:RUNTIMES.length,status:'unknown'},services:RUNTIMES.map(x=>({id:x.id,name:x.name,repository:x.repository,ok:null}))}}
function requireKv(env){if(!env[KV])throw new Error(`${KV} KV binding is not configured.`)}function json(v,s=200){return new Response(JSON.stringify(v,null,2),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}})}
