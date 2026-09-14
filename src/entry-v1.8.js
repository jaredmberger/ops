import base from './entry-v1.7.js';

const OPS_KV='CURATOR_OPS_RECORDS';
const JOURNEY_KEY='public-site-journey:latest';
const SELFTEST_KEY='self-test:latest';

export default{
  async fetch(request,env,ctx){
    const u=new URL(request.url);
    if(request.method==='GET'&&u.pathname==='/'){
      const [response,journey,selfTest]=await Promise.all([
        base.fetch(request,env,ctx),
        readSnapshot(env,JOURNEY_KEY,'Public Site Journey'),
        readSnapshot(env,SELFTEST_KEY,'CuratorOS Self-Test')
      ]);
      const contentType=response.headers.get('content-type')||'';
      if(!contentType.includes('text/html'))return response;
      const body=await response.text();
      const html=injectMonitoring(body,journey,selfTest);
      const headers=new Headers(response.headers);
      headers.set('content-length',String(new TextEncoder().encode(html).length));
      return new Response(html,{status:response.status,statusText:response.statusText,headers});
    }
    return base.fetch(request,env,ctx);
  },
  async scheduled(controller,env,ctx){return base.scheduled(controller,env,ctx)}
};

async function readSnapshot(env,key,name){
  if(!env[OPS_KV])return{name,effectiveState:'unknown',generatedAt:null,summary:{}};
  return await env[OPS_KV].get(key,'json')||{name,effectiveState:'warming',generatedAt:null,summary:{}};
}

function injectMonitoring(body,journey,selfTest){
  const styles=`
.ops-monitoring{margin:26px 0 8px}.ops-monitoring__head{display:flex;align-items:end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:12px}.ops-monitoring__title{margin:0;font-size:20px;font-weight:400}.ops-monitoring__hint{color:var(--muted);font:12px system-ui}.ops-monitoring__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.ops-monitoring__card{display:block;padding:18px 20px;border:1px solid var(--line);border-radius:16px;background:rgba(16,25,24,.84);text-decoration:none;color:inherit}.ops-monitoring__card:hover{border-color:rgba(191,164,106,.45)}.ops-monitoring__status{display:flex;align-items:center;gap:8px;margin-top:8px;font:600 13px system-ui;text-transform:capitalize}.ops-monitoring__detail{margin-top:7px;color:var(--muted);font:12px/1.45 system-ui}.ops-monitoring__dot{width:9px;height:9px;border-radius:50%;display:inline-block}.ops-monitoring__dot.healthy{background:#58c77a}.ops-monitoring__dot.warming,.ops-monitoring__dot.observing{background:#d6ad58}.ops-monitoring__dot.degraded{background:#d98d58}.ops-monitoring__dot.persistent,.ops-monitoring__dot.attention{background:#d86666}.ops-monitoring__dot.unknown{background:#8b9490}@media(max-width:700px){.ops-monitoring__grid{grid-template-columns:1fr}}
`;
  const section=`<section class="ops-monitoring" aria-label="Synthetic monitoring"><div class="ops-monitoring__head"><h2 class="ops-monitoring__title">Synthetic Monitoring</h2><div class="ops-monitoring__hint">Feature-path and monitoring-integrity checks</div></div><div class="ops-monitoring__grid">${card('/journey','Public Site Journey',journey,'Visitor-facing feature chain')}${card('/self-test','CuratorOS Self-Test',selfTest,'Monitoring storage integrity')}</div></section>`;
  let out=body;
  if(out.includes('</style>'))out=out.replace('</style>',styles+'</style>');
  if(out.includes('</main>'))out=out.replace('</main>',section+'</main>');
  return out;
}

function card(href,title,snapshot,subtitle){
  const state=String(snapshot?.effectiveState||snapshot?.summary?.status||'unknown');
  const checked=snapshot?.generatedAt?new Date(snapshot.generatedAt).toLocaleString('en-US',{timeZone:'America/Chicago',month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit'}):'waiting for first check';
  const summary=snapshot?.summary||{};
  let detail=subtitle+` · ${checked}`;
  if(typeof summary.passed==='number'&&typeof summary.total==='number')detail=`${summary.passed}/${summary.total} checks passed · ${checked}`;
  return `<a class="ops-monitoring__card" href="${href}"><div class="label">${title}</div><div class="ops-monitoring__status"><span class="ops-monitoring__dot ${escClass(state)}"></span>${esc(state)}</div><div class="ops-monitoring__detail">${esc(detail)}</div></a>`;
}

function escClass(v){return ['healthy','warming','observing','degraded','persistent','attention','unknown'].includes(v)?v:'unknown'}
function esc(v){return String(v??'').replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]))}
