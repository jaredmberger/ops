import base from './entry-v1.1.js';

const KV = 'CURATOR_OPS_RECORDS';
const DRIFT_SNAPSHOT_KEY = 'deployment-drift:latest';
const DRIFT_HISTORY_PREFIX = 'deployment-drift:';
const REQUEST_TIMEOUT_MS = 10000;
const DEPLOY_GRACE_MS = 15 * 60 * 1000;

const RUNTIMES = [
  { id:'error-bus', name:'Error Bus', runtimeUrl:'https://errors.oceanliners.net/api/runtime', repository:'jaredmberger/errors' },
  { id:'verify', name:'Curator Verify', runtimeUrl:'https://verify.oceanlinercurator.com/api/runtime', repository:'jaredmberger/verify' }
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/deployment-drift') {
      return json({ ok:true, snapshot:await readDriftSnapshot(env) });
    }

    if (request.method === 'POST' && url.pathname === '/api/deployment-drift-check-now') {
      const snapshot = await collectDeploymentDrift(env, 'manual');
      return json({ ok:true, snapshot });
    }

    if (request.method === 'GET' && url.pathname === '/deployments') {
      return html(renderDeployments(await readDriftSnapshot(env)));
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const result = base.scheduled(controller, env, ctx);
    ctx.waitUntil(collectDeploymentDrift(env, `cron:${controller?.cron || 'unknown'}`).catch(error => console.error('Ops deployment drift collection failed', error)));
    return result;
  }
};

async function collectDeploymentDrift(env, source) {
  requireKv(env);
  const services = [];

  for (const service of RUNTIMES) {
    const runtime = await fetchJson(service.runtimeUrl, 'CuratorOps-Drift/1.2');
    const github = await fetchGitHubHead(service.repository);
    services.push(classify(service, runtime, github));
  }

  const counts = {
    inSync: services.filter(x=>x.state==='in-sync').length,
    pending: services.filter(x=>x.state==='pending').length,
    drift: services.filter(x=>x.state==='drift').length,
    unknown: services.filter(x=>x.state==='unknown').length
  };

  const snapshot = {
    generatedAt:new Date().toISOString(),
    source,
    graceMinutes:Math.round(DEPLOY_GRACE_MS/60000),
    summary:{
      total:services.length,
      ...counts,
      status:counts.drift || counts.unknown ? 'attention' : (counts.pending ? 'deploying' : 'healthy')
    },
    services
  };

  await env[KV].put(DRIFT_SNAPSHOT_KEY, JSON.stringify(snapshot));
  const ts=Date.parse(snapshot.generatedAt)||Date.now();
  await env[KV].put(`${DRIFT_HISTORY_PREFIX}${String(9999999999999-ts).padStart(13,'0')}:${crypto.randomUUID()}`, JSON.stringify(snapshot), { expirationTtl:60*60*24*180 });
  return snapshot;
}

function classify(service, runtimeResult, githubResult) {
  const runtime = runtimeResult.ok ? runtimeResult.data : null;
  const github = githubResult.ok ? githubResult.data : null;
  const runningCommit = runtime?.build?.commit || null;
  const githubCommit = github?.sha || null;
  const githubCommittedAt = github?.committedAt || null;
  const headAgeMs = githubCommittedAt ? Date.now()-Date.parse(githubCommittedAt) : null;

  let state='unknown';
  let message='Deployment state could not be determined.';
  if (runningCommit && githubCommit && runningCommit === githubCommit) {
    state='in-sync';
    message='Running Worker matches GitHub main.';
  } else if (runningCommit && githubCommit && Number.isFinite(headAgeMs) && headAgeMs < DEPLOY_GRACE_MS) {
    state='pending';
    message='GitHub is newer; deployment is within the normal grace window.';
  } else if (runningCommit && githubCommit) {
    state='drift';
    message='Running Worker does not match GitHub main beyond the deployment grace window.';
  }

  return {
    id:service.id,
    name:service.name,
    repository:service.repository,
    state,
    message,
    running:{
      commit:runningCommit,
      version:runtime?.version || null,
      cloudflareVersionId:runtime?.cloudflareVersion?.id || null,
      cloudflareVersionTimestamp:runtime?.cloudflareVersion?.timestamp || null,
      buildSource:runtime?.build?.source || null,
      buildBranch:runtime?.build?.branch || null,
      buildUuid:runtime?.build?.buildUuid || null
    },
    github:{
      commit:githubCommit,
      committedAt:githubCommittedAt,
      message:github?.message || null
    },
    errors:{
      runtime:runtimeResult.ok ? null : runtimeResult.error,
      github:githubResult.ok ? null : githubResult.error
    },
    checkedAt:new Date().toISOString()
  };
}

async function fetchGitHubHead(repository) {
  const result = await fetchJson(`https://api.github.com/repos/${repository}/commits/main`, 'CuratorOps/1.2');
  if (!result.ok) return result;
  const payload=result.data;
  return {
    ok:true,
    data:{
      sha:payload?.sha || null,
      committedAt:payload?.commit?.committer?.date || payload?.commit?.author?.date || null,
      message:String(payload?.commit?.message || '').split('\n')[0].slice(0,300)
    }
  };
}

async function fetchJson(url, userAgent) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
  try {
    const response=await fetch(`${url}${url.includes('?')?'&':'?'}ops=${Date.now()}`,{
      method:'GET',redirect:'follow',cache:'no-store',
      headers:{accept:'application/vnd.github+json, application/json','user-agent':userAgent},
      signal:controller.signal,
      cf:{cacheTtl:0,cacheEverything:false}
    });
    if(!response.ok) return {ok:false,error:`HTTP ${response.status}`};
    return {ok:true,data:await response.json()};
  } catch(error) {
    return {ok:false,error:error?.name==='AbortError'?'timeout':(error?.message||String(error))};
  } finally { clearTimeout(timer); }
}

async function readDriftSnapshot(env) {
  requireKv(env);
  return await env[KV].get(DRIFT_SNAPSHOT_KEY,'json') || {
    generatedAt:null,
    source:null,
    graceMinutes:15,
    summary:{total:RUNTIMES.length,inSync:0,pending:0,drift:0,unknown:RUNTIMES.length,status:'unknown'},
    services:RUNTIMES.map(x=>({id:x.id,name:x.name,repository:x.repository,state:'unknown'}))
  };
}

function renderDeployments(snapshot) {
  const rows=(snapshot.services||[]).map(s=>`<tr><td><span class="dot ${escapeHtml(s.state)}"></span>${escapeHtml(s.name)}</td><td>${escapeHtml(s.state)}</td><td><code>${shortSha(s.running?.commit)}</code></td><td><code>${shortSha(s.github?.commit)}</code></td><td>${escapeHtml(s.running?.version||'—')}</td><td>${escapeHtml(s.message||'')}</td></tr>`).join('');
  const x=snapshot.summary||{};
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deployments · Curator Ops</title><style>:root{color-scheme:dark;--bg:#0a1110;--panel:#101918;--brass:#bfa46a;--text:#f3eee3;--muted:#9aa6a0;--line:#263330}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 50% -20%,#17221f 0,#0a1110 52%);color:var(--text);font-family:Georgia,'Times New Roman',serif;min-height:100vh}.wrap{max-width:1150px;margin:auto;padding:58px 20px}.eyebrow{font:600 12px system-ui,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:var(--brass)}h1{font-size:clamp(38px,7vw,62px);font-weight:400;margin:.2em 0}.lede{color:#d3d6d1;font-size:18px;line-height:1.6;max-width:800px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:28px 0}.card,.table{border:1px solid var(--line);background:rgba(16,25,24,.84);border-radius:16px}.card{padding:18px}.label{font:600 11px system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}.value{font-size:28px;margin-top:8px}.table{overflow:auto}table{width:100%;border-collapse:collapse;min-width:900px;font:14px system-ui,sans-serif}th,td{text-align:left;padding:14px 15px;border-bottom:1px solid var(--line)}th{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:9px}.in-sync{background:#58c77a}.pending{background:#d6ad58}.drift{background:#d86666}.unknown{background:#8b9490}code{color:#e9d49e}a{color:#e9d49e}footer{margin-top:28px;color:#6f7974;font:12px system-ui,sans-serif}@media(max-width:700px){.cards{grid-template-columns:1fr 1fr}}</style></head><body><main class="wrap"><div class="eyebrow">CuratorOS · Deployment Truth</div><h1>Deployment Drift</h1><p class="lede">Compares the GitHub main branch with the commit stamped into the Worker actually serving traffic. A ${snapshot.graceMinutes||15}-minute grace period prevents normal deployment propagation from becoming an alert.</p><section class="cards"><div class="card"><div class="label">State</div><div class="value">${escapeHtml(x.status||'unknown')}</div></div><div class="card"><div class="label">In sync</div><div class="value">${x.inSync||0}</div></div><div class="card"><div class="label">Deploying</div><div class="value">${x.pending||0}</div></div><div class="card"><div class="label">Drift</div><div class="value">${x.drift||0}</div></div></section><section class="table"><table><thead><tr><th>Worker</th><th>State</th><th>Running commit</th><th>GitHub main</th><th>Version</th><th>Assessment</th></tr></thead><tbody>${rows}</tbody></table></section><footer><a href="/">← Curator Ops</a> · Ocean Liner Curator</footer></main></body></html>`;
}

function shortSha(value){return value?String(value).slice(0,8):'—';}
function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function requireKv(env){if(!env[KV])throw new Error(`${KV} KV binding is not configured.`);}
function json(value,status=200){return new Response(JSON.stringify(value,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}});}
function html(value){return new Response(value,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});}
