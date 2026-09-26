import base from './entry-v1.1.js';

const KV = 'CURATOR_OPS_RECORDS';
const DRIFT_SNAPSHOT_KEY = 'deployment-drift:latest';
const DRIFT_HISTORY_PREFIX = 'deployment-drift:';
const REQUEST_TIMEOUT_MS = 10000;
const DEPLOY_GRACE_MS = 15 * 60 * 1000;
const DISPLAY_TIME_ZONE = 'America/Chicago';

const RUNTIMES = [
  { id:'error-bus', name:'Error Bus', runtimeUrl:'https://errors.oceanliners.net/api/runtime', repository:'jaredmberger/errors' },
  { id:'verify', name:'Curator Verify', runtimeUrl:'https://verify.oceanlinercurator.com/api/runtime', repository:'jaredmberger/verify' },
  { id:'site-health', name:'Site Health', runtimeUrl:'https://site-health.oceanliners.net/api/runtime', repository:'jaredmberger/site-health' },
  { id:'integrity', name:'Curator Integrity', runtimeUrl:'https://integrity.oceanliners.net/api/runtime', repository:'jaredmberger/curator-integrity' },
  { id:'speed', name:'Curator Speed', runtimeUrl:'https://speed.oceanliners.net/api/runtime', repository:'jaredmberger/speed' },
  { id:'indexer', name:'Curator Indexer', runtimeUrl:'https://curator-indexer.oceanliners.net/api/runtime', repository:'jaredmberger/curator-indexer' },
  { id:'search-intelligence', name:'Search Intelligence', runtimeUrl:'https://search-intelligence.oceanliners.net/api/runtime', repository:'jaredmberger/search-intelligence' },
  { id:'analytics', name:'Curator Analytics', runtimeUrl:'https://analytics.oceanliners.net/api/runtime', repository:'jaredmberger/analytics' },
  { id:'content-opportunity', name:'Content Opportunity', runtimeUrl:'https://content.oceanliners.net/api/runtime', repository:'jaredmberger/content-opportunity' }
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/deployment-drift') return json({ ok:true, snapshot:await readDriftSnapshot(env) });
    if (request.method === 'POST' && url.pathname === '/api/deployment-drift-check-now') return json({ ok:true, snapshot:await collectDeploymentDrift(env, 'manual') });
    if (request.method === 'GET' && url.pathname === '/deployments') return html(renderDeployments(await readDriftSnapshot(env)));
    return base.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    const result = base.scheduled(controller, env, ctx);
    ctx.waitUntil(collectDeploymentDrift(env, `cron:${controller?.cron || 'unknown'}`).catch(error => console.error('Ops deployment drift collection failed', error)));
    return result;
  }
};

async function collectDeploymentDrift(env, source) {
  requireKv(env); const services=[];
  for(const service of RUNTIMES){
    const runtime=await fetchJson(service.runtimeUrl,'CuratorOps-Drift/1.9',env,{useAccess:true});
    const github=await fetchGitHubHead(service.repository,env);
    let comparison=null;
    const runningCommit=runtime.ok?runtime.data?.build?.commit:null;
    const githubCommit=github.ok?github.data?.sha:null;
    const githubCommittedAt=github.ok?github.data?.committedAt:null;
    const headAgeMs=githubCommittedAt?Date.now()-Date.parse(githubCommittedAt):null;
    if(runningCommit&&githubCommit&&runningCommit!==githubCommit&&!(Number.isFinite(headAgeMs)&&headAgeMs<DEPLOY_GRACE_MS)){
      comparison=await fetchGitHubComparison(service.repository,runningCommit,githubCommit,env);
    }
    services.push(classify(service,runtime,github,comparison));
  }
  const counts={inSync:services.filter(x=>x.state==='in-sync').length,pending:services.filter(x=>x.state==='pending').length,drift:services.filter(x=>x.state==='drift').length,unknown:services.filter(x=>x.state==='unknown').length};
  const snapshot={generatedAt:new Date().toISOString(),source,displayTimeZone:DISPLAY_TIME_ZONE,graceMinutes:Math.round(DEPLOY_GRACE_MS/60000),accessServiceAuthConfigured:Boolean(env.CF_ACCESS_CLIENT_ID&&env.CF_ACCESS_CLIENT_SECRET),githubAuthConfigured:Boolean(env.GITHUB_TOKEN),summary:{total:services.length,...counts,status:counts.drift||counts.unknown?'attention':counts.pending?'deploying':'healthy'},services};
  await env[KV].put(DRIFT_SNAPSHOT_KEY,JSON.stringify(snapshot)); const ts=Date.parse(snapshot.generatedAt)||Date.now(); await env[KV].put(`${DRIFT_HISTORY_PREFIX}${String(9999999999999-ts).padStart(13,'0')}:${crypto.randomUUID()}`,JSON.stringify(snapshot),{expirationTtl:60*60*24*180}); return snapshot;
}
function classify(service,runtimeResult,githubResult,comparisonResult=null){
  const runtime=runtimeResult.ok?runtimeResult.data:null;
  const github=githubResult.ok?githubResult.data:null;
  const runningCommit=runtime?.build?.commit||null;
  const githubCommit=github?.sha||null;
  const githubCommittedAt=github?.committedAt||null;
  const headAgeMs=githubCommittedAt?Date.now()-Date.parse(githubCommittedAt):null;
  const comparison=comparisonResult?.ok?comparisonResult.data:null;
  let state='unknown',message='Deployment state could not be determined.',relation='unverified';

  if(runningCommit&&githubCommit&&runningCommit===githubCommit){
    state='in-sync';relation='identical';message='Running Worker matches GitHub main.';
  }else if(runningCommit&&githubCommit&&Number.isFinite(headAgeMs)&&headAgeMs<DEPLOY_GRACE_MS){
    state='pending';relation='grace-window';message='GitHub is newer; deployment is within the normal grace window.';
  }else if(runningCommit&&githubCommit&&comparison){
    if(comparison.filesChanged===0){
      state='in-sync';relation='content-equivalent';
      message='Running commit differs from GitHub main, but GitHub confirms there are zero file changes between them; deployed content is equivalent.';
    }else if(comparison.status==='ahead'){
      state='drift';relation='running-behind-main';
      message=`Cloudflare is confirmed behind GitHub main by ${Number(comparison.aheadBy||0)} commit${Number(comparison.aheadBy||0)===1?'':'s'} with ${Number(comparison.filesChanged||0)} changed file${Number(comparison.filesChanged||0)===1?'':'s'}.`;
    }else if(comparison.status==='behind'){
      state='drift';relation='running-ahead-of-main';
      message=`Cloudflare is running a commit ahead of GitHub main by ${Number(comparison.behindBy||0)} commit${Number(comparison.behindBy||0)===1?'':'s'}; verify the production deployment source.`;
    }else if(comparison.status==='diverged'){
      state='drift';relation='diverged';
      message='Cloudflare and GitHub main are on divergent commit histories; verify the production deployment source.';
    }else if(comparison.status==='identical'){
      state='in-sync';relation='identical';message='GitHub confirms the running commit and main are identical.';
    }else{
      state='unknown';relation='unverified';message='Commit mismatch observed, but GitHub did not return a recognized ancestry relationship.';
    }
  }else if(runningCommit&&githubCommit){
    state='unknown';relation='unverified';
    message='Commit mismatch observed, but GitHub could not verify the relationship; not escalating as confirmed drift.';
  }

  return{
    id:service.id,name:service.name,repository:service.repository,state,message,relation,
    running:{commit:runningCommit,version:runtime?.version||null,cloudflareVersionId:runtime?.cloudflareVersion?.id||null,cloudflareVersionTimestamp:runtime?.cloudflareVersion?.timestamp||null,buildSource:runtime?.build?.source||null,buildBranch:runtime?.build?.branch||null,buildUuid:runtime?.build?.buildUuid||null},
    github:{commit:githubCommit,committedAt:githubCommittedAt,message:github?.message||null,authFallback:githubResult.authFallback||false,comparisonStatus:comparison?.status||null,aheadBy:comparison?.aheadBy??null,behindBy:comparison?.behindBy??null,totalCommits:comparison?.totalCommits??null,filesChanged:comparison?.filesChanged??null},
    errors:{runtime:runtimeResult.ok?null:runtimeResult.error,github:githubResult.ok?(githubResult.authFallback?'Configured GitHub token was rejected; using unauthenticated fallback.':null):githubResult.error,comparison:comparisonResult&&!comparisonResult.ok?comparisonResult.error:null},
    checkedAt:new Date().toISOString()
  };
}
async function fetchGitHubHead(repository,env){const url=`https://api.github.com/repos/${repository}/commits/main`;let result=await fetchJson(url,'CuratorOps/1.8',env,{useGitHubAuth:true});if(!result.ok&&result.status===401&&env.GITHUB_TOKEN){const fallback=await fetchJson(url,'CuratorOps/1.8',env,{useGitHubAuth:false});if(fallback.ok)result={...fallback,authFallback:true};}if(!result.ok)return result;const p=result.data;return{ok:true,authFallback:Boolean(result.authFallback),data:{sha:p?.sha||null,committedAt:p?.commit?.committer?.date||p?.commit?.author?.date||null,message:String(p?.commit?.message||'').split('\n')[0].slice(0,300)}}}
async function fetchGitHubComparison(repository,runningCommit,githubCommit,env){
  const url=`https://api.github.com/repos/${repository}/compare/${encodeURIComponent(runningCommit)}...${encodeURIComponent(githubCommit)}`;
  let result=await fetchJson(url,'CuratorOps-Drift/1.9',env,{useGitHubAuth:true});
  if(!result.ok&&result.status===401&&env.GITHUB_TOKEN){
    const fallback=await fetchJson(url,'CuratorOps-Drift/1.9',env,{useGitHubAuth:false});
    if(fallback.ok)result={...fallback,authFallback:true};
  }
  if(!result.ok)return result;
  const p=result.data||{};
  return{ok:true,authFallback:Boolean(result.authFallback),data:{
    status:p.status||null,
    aheadBy:Number.isFinite(Number(p.ahead_by))?Number(p.ahead_by):null,
    behindBy:Number.isFinite(Number(p.behind_by))?Number(p.behind_by):null,
    totalCommits:Number.isFinite(Number(p.total_commits))?Number(p.total_commits):null,
    filesChanged:Array.isArray(p.files)?p.files.length:null
  }};
}
async function fetchJson(url,userAgent,env,{useAccess=false,useGitHubAuth=false}={}){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);try{const target=new URL(url);target.searchParams.set('ops',Date.now().toString());const headers={accept:'application/vnd.github+json, application/json','user-agent':userAgent};if(useAccess)Object.assign(headers,accessHeaders(env,target));if(useGitHubAuth&&target.hostname.toLowerCase()==='api.github.com'&&env.GITHUB_TOKEN){headers.authorization=`Bearer ${env.GITHUB_TOKEN}`;headers['x-github-api-version']='2022-11-28'}const response=await fetch(target.href,{method:'GET',redirect:'manual',cache:'no-store',headers,signal:controller.signal});const location=response.headers.get('location');const contentType=(response.headers.get('content-type')||'').toLowerCase();if(response.status>=300&&response.status<400){return{ok:false,status:response.status,error:`HTTP ${response.status} redirect${location?` → ${location.slice(0,220)}`:''}`}}if(!response.ok){const remaining=response.headers.get('x-ratelimit-remaining');const reset=response.headers.get('x-ratelimit-reset');return{ok:false,status:response.status,error:`HTTP ${response.status}${remaining!==null?` · rate remaining ${remaining}`:''}${reset?` · reset ${reset}`:''}`}}if(!contentType.includes('json')){const body=(await response.text()).replace(/\s+/g,' ').trim().slice(0,180);return{ok:false,status:response.status,error:`HTTP ${response.status} · ${contentType||'unknown content-type'}${body?` · body: ${body}`:''}`}}return{ok:true,status:response.status,data:await response.json()}}catch(error){return{ok:false,status:null,error:error?.name==='AbortError'?'timeout':(error?.message||String(error))}}finally{clearTimeout(timer)}}
function accessHeaders(env,target){if(!env.CF_ACCESS_CLIENT_ID||!env.CF_ACCESS_CLIENT_SECRET)return{};const host=target.hostname.toLowerCase();const owned=host==='oceanliners.net'||host.endsWith('.oceanliners.net')||host==='oceanlinercurator.com'||host.endsWith('.oceanlinercurator.com');return owned?{'CF-Access-Client-Id':env.CF_ACCESS_CLIENT_ID,'CF-Access-Client-Secret':env.CF_ACCESS_CLIENT_SECRET}:{}}
async function readDriftSnapshot(env){requireKv(env);return await env[KV].get(DRIFT_SNAPSHOT_KEY,'json')||{generatedAt:null,source:null,displayTimeZone:DISPLAY_TIME_ZONE,graceMinutes:15,githubAuthConfigured:Boolean(env.GITHUB_TOKEN),summary:{total:RUNTIMES.length,inSync:0,pending:0,drift:0,unknown:RUNTIMES.length,status:'unknown'},services:RUNTIMES.map(x=>({id:x.id,name:x.name,repository:x.repository,state:'unknown'}))}}
function formatCentral(value){if(!value)return'—';const date=new Date(value);if(Number.isNaN(date.getTime()))return'—';return new Intl.DateTimeFormat('en-US',{timeZone:DISPLAY_TIME_ZONE,month:'numeric',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(date)}
function renderDeployments(snapshot){const rows=(snapshot.services||[]).map(s=>`<tr><td><span class="dot ${escapeHtml(s.state)}"></span>${escapeHtml(s.name)}</td><td>${escapeHtml(s.state)}</td><td><code>${shortSha(s.running?.commit)}</code></td><td><code>${shortSha(s.github?.commit)}</code></td><td>${escapeHtml(s.running?.version||'—')}</td><td>${escapeHtml(s.errors?.runtime||'—')}</td><td>${escapeHtml(s.errors?.github||'—')}</td><td>${escapeHtml(s.message||'')}</td></tr>`).join(''),x=snapshot.summary||{};return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deployments · Curator Ops</title><style>:root{color-scheme:dark;--panel:#101918;--brass:#bfa46a;--text:#f3eee3;--muted:#9aa6a0;--line:#263330}*{box-sizing:border-box}body{margin:0;background:#0a1110;color:var(--text);font-family:Georgia,serif}.wrap{max-width:1380px;margin:auto;padding:58px 20px}.eyebrow{font:600 12px system-ui;letter-spacing:.18em;text-transform:uppercase;color:var(--brass)}h1{font-size:clamp(38px,7vw,62px);font-weight:400}.meta{color:var(--muted);font:13px system-ui;line-height:1.7}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:28px 0}.card,.table{border:1px solid var(--line);background:var(--panel);border-radius:16px}.card{padding:18px}.label{font:600 11px system-ui;color:var(--muted);text-transform:uppercase}.value{font-size:28px;margin-top:8px}.table{overflow:auto}table{width:100%;border-collapse:collapse;min-width:1250px;font:14px system-ui}th,td{text-align:left;padding:14px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:11px;color:var(--muted);text-transform:uppercase}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:9px}.in-sync{background:#58c77a}.pending{background:#d6ad58}.drift{background:#d86666}.unknown{background:#8b9490}code,a{color:#e9d49e}</style></head><body><main class="wrap"><div class="eyebrow">CuratorOS · Deployment Truth</div><h1>Deployment Drift</h1><p>Compares GitHub main with the commit stamped into each Worker actually serving traffic. A ${snapshot.graceMinutes||15}-minute grace period suppresses normal deployment propagation.</p><p class="meta">Last check: ${formatCentral(snapshot.generatedAt)} · GitHub auth: ${snapshot.githubAuthConfigured?'configured':'NOT configured'} · Access auth: ${snapshot.accessServiceAuthConfigured?'configured':'NOT configured'}</p><section class="cards"><div class="card"><div class="label">State</div><div class="value">${escapeHtml(x.status||'unknown')}</div></div><div class="card"><div class="label">In sync</div><div class="value">${x.inSync||0}</div></div><div class="card"><div class="label">Deploying</div><div class="value">${x.pending||0}</div></div><div class="card"><div class="label">Drift</div><div class="value">${x.drift||0}</div></div></section><section class="table"><table><thead><tr><th>Worker</th><th>State</th><th>Running commit</th><th>GitHub main</th><th>Version</th><th>Runtime error</th><th>GitHub error</th><th>Assessment</th></tr></thead><tbody>${rows}</tbody></table></section><p><a href="/">← Curator Ops</a> · <a href="/scheduled">Scheduled Work</a></p></main></body></html>`}
function shortSha(v){return v?String(v).slice(0,8):'—'}function escapeHtml(v){return String(v??'').replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]))}function requireKv(env){if(!env[KV])throw new Error(`${KV} KV binding is not configured.`)}function json(v,s=200){return new Response(JSON.stringify(v,null,2),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}})}function html(v){return new Response(v,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})}
