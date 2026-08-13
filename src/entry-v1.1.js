import base from './index.js';

const KV = 'CURATOR_OPS_RECORDS';
const RUNTIME_SNAPSHOT_KEY = 'runtime-snapshot:latest';
const RUNTIME_HISTORY_PREFIX = 'runtime-snapshot:';
const REQUEST_TIMEOUT_MS = 10000;

const RUNTIMES = [
  { id:'error-bus', name:'Error Bus', url:'https://errors.oceanliners.net/api/runtime', repository:'jaredmberger/errors' },
  { id:'verify', name:'Curator Verify', url:'https://verify.oceanlinercurator.com/api/runtime', repository:'jaredmberger/verify' }
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/runtime') {
      const meta = env.CF_VERSION_METADATA || {};
      return json({
        ok:true,
        service:'Curator Ops',
        version:'1.1.0',
        repository:'jaredmberger/ops',
        runtime:'cloudflare-workers',
        cloudflareVersion:{
          id:meta.id || null,
          tag:meta.tag || null,
          timestamp:meta.timestamp || null
        },
        observedAt:new Date().toISOString()
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/runtime-status') {
      return json({ ok:true, snapshot:await readRuntimeSnapshot(env) });
    }

    if (request.method === 'POST' && url.pathname === '/api/runtime-check-now') {
      const snapshot = await collectRuntimeIdentities(env, 'manual');
      return json({ ok:true, snapshot });
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const result = base.scheduled(controller, env, ctx);
    ctx.waitUntil(collectRuntimeIdentities(env, `cron:${controller?.cron || 'unknown'}`).catch(error => console.error('Ops runtime identity collection failed', error)));
    return result;
  }
};

async function collectRuntimeIdentities(env, source) {
  requireKv(env);
  const services = [];
  for (const runtime of RUNTIMES) services.push(await probeRuntime(runtime));

  const identified = services.filter(x => x.ok && x.cloudflareVersion?.id).length;
  const snapshot = {
    generatedAt:new Date().toISOString(),
    source,
    summary:{ total:services.length, identified, missing:services.length-identified, status:identified===services.length?'healthy':'attention' },
    services
  };

  await env[KV].put(RUNTIME_SNAPSHOT_KEY, JSON.stringify(snapshot));
  const ts = Date.parse(snapshot.generatedAt) || Date.now();
  await env[KV].put(`${RUNTIME_HISTORY_PREFIX}${String(9999999999999-ts).padStart(13,'0')}:${crypto.randomUUID()}`, JSON.stringify(snapshot), { expirationTtl:60*60*24*90 });
  return snapshot;
}

async function probeRuntime(service) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${service.url}?opsRuntime=${Date.now()}`, {
      method:'GET',
      redirect:'follow',
      cache:'no-store',
      headers:{ accept:'application/json', 'user-agent':'CuratorOps-Runtime/1.1 (+https://ops.oceanlinercurator.com)' },
      signal:controller.signal,
      cf:{ cacheTtl:0, cacheEverything:false }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return {
      id:service.id,
      name:service.name,
      repository:payload.repository || service.repository,
      ok:Boolean(payload.ok),
      reportedService:payload.service || null,
      version:payload.version || null,
      runtime:payload.runtime || null,
      cloudflareVersion:payload.cloudflareVersion || null,
      observedAt:payload.observedAt || null,
      checkedAt:new Date().toISOString(),
      durationMs:Date.now()-started
    };
  } catch (error) {
    return {
      id:service.id,
      name:service.name,
      repository:service.repository,
      ok:false,
      error:error?.name==='AbortError'?'timeout':(error?.message || String(error)),
      checkedAt:new Date().toISOString(),
      durationMs:Date.now()-started
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readRuntimeSnapshot(env) {
  requireKv(env);
  return await env[KV].get(RUNTIME_SNAPSHOT_KEY, 'json') || {
    generatedAt:null,
    source:null,
    summary:{ total:RUNTIMES.length, identified:0, missing:RUNTIMES.length, status:'unknown' },
    services:RUNTIMES.map(x=>({ id:x.id, name:x.name, repository:x.repository, ok:null }))
  };
}

function requireKv(env){ if(!env[KV]) throw new Error(`${KV} KV binding is not configured.`); }
function json(value,status=200){ return new Response(JSON.stringify(value,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}}); }
