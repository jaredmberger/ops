import base from './entry-v1.18.js';

const KV='CURATOR_OPS_RECORDS';
const DIAGNOSTICS_KEY='diagnostics:latest';

const SERVICE_IDS_BY_NAME=new Map([
  ['Ocean Liner Curator','public-site'],
  ['CuratorOS','curatoros'],
  ['Curator Intelligence','curator-intelligence'],
  ['Error Bus','error-bus'],
  ['Curator Verify','verify'],
  ['Site Health','site-health'],
  ['Curator Integrity','integrity'],
  ['Curator Speed','speed'],
  ['Curator Indexer','indexer'],
  ['Search Intelligence','search-intelligence'],
  ['Link Map','link-map'],
  ['Page Studio','page-studio'],
  ['CuratorOS Launcher','launcher'],
  ['Curator Analytics','analytics'],
  ['Content Opportunity','content-opportunity']
]);

export default{
  async fetch(request,env,ctx){
    const response=await base.fetch(request,env,ctx);
    const url=new URL(request.url);

    if(request.method!=='GET'||url.pathname!=='/')return response;
    if(!(response.headers.get('content-type')||'').includes('text/html'))return response;

    const body=await response.text();
    const diagnostics=await readLatestDiagnostics(env);
    const headers=new Headers(response.headers);
    headers.delete('content-length');

    return new Response(enhanceFleetTable(body,diagnostics),{
      status:response.status,
      statusText:response.statusText,
      headers
    });
  },

  async scheduled(controller,env,ctx){
    return base.scheduled(controller,env,ctx);
  }
};

async function readLatestDiagnostics(env){
  try{
    if(!env?.[KV])return null;
    return await env[KV].get(DIAGNOSTICS_KEY,'json');
  }catch{
    return null;
  }
}

function enhanceFleetTable(body,snapshot){
  let out=body;
  if(!out.includes('<th>Error</th>'))return out;

  out=out.replace('<th>Error</th>','<th>Error</th><th>Diagnosis</th>');

  out=out.replace(/<tr><td><span class="dot ([^"]+)"><\/span>([^<]+)<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><td>([\s\S]*?)<\/td><\/tr>/g,
    (row,dotClass,serviceName,state,http,streak,latency,error)=>{
      const serviceId=SERVICE_IDS_BY_NAME.get(serviceName);
      const diagnosis=serviceId?findServiceDiagnostic(snapshot,serviceId):null;
      const diagnosisCell=diagnosticCell({serviceId,state,diagnosis,snapshot});

      return `<tr><td><span class="dot ${dotClass}"></span>${serviceName}</td><td>${state}</td><td>${http}</td><td>${streak}</td><td>${latency}</td><td>${error}</td><td>${diagnosisCell}</td></tr>`;
    }
  );

  if(out.includes('</style>')){
    out=out.replace('</style>',`
      .ops-diagnosis{min-width:280px;max-width:460px;font:12px/1.45 system-ui;color:#cfd5d0}
      .ops-diagnosis__label{display:inline-block;margin:0 7px 5px 0;padding:2px 7px;border-radius:999px;border:1px solid var(--line);color:var(--brass);font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
      .ops-diagnosis__text{color:#cfd5d0}
      .ops-diagnosis__link{display:inline-block;margin-top:5px;font-weight:700}
      .ops-diagnosis--quiet{color:var(--muted)}
      .ops-diagnosis--missing{color:#d6ad58}
    </style>`);
  }

  return out;
}

function findServiceDiagnostic(snapshot,serviceId){
  const diagnostics=Array.isArray(snapshot?.diagnostics)?snapshot.diagnostics:[];
  const id=`service:${serviceId}`;

  return diagnostics.find(d=>d?.id===id)
    ||diagnostics.find(d=>d?.rootCause?.id===id)
    ||diagnostics.find(d=>d?.causedBy===id)
    ||null;
}

function diagnosticCell({serviceId,state,diagnosis,snapshot}){
  const normalized=String(state||'').toLowerCase();

  if(normalized==='healthy'){
    return '<div class="ops-diagnosis ops-diagnosis--quiet">—</div>';
  }

  if(!serviceId){
    return '<div class="ops-diagnosis ops-diagnosis--missing">No service diagnostic mapping.</div>';
  }

  if(!diagnosis){
    const freshness=snapshot?.generatedAt?formatAge(snapshot.generatedAt):null;
    const suffix=freshness?` Latest diagnostic pass: ${escapeHtml(freshness)}.`:'';
    return `<div class="ops-diagnosis ops-diagnosis--missing">No structured diagnosis yet.${suffix}<br><a class="ops-diagnosis__link" href="/diagnose">Open diagnostics →</a></div>`;
  }

  const label=diagnosis.rootCause?.classification
    ||diagnosis.state
    ||diagnosis.confidence
    ||'active';
  const conclusion=shorten(diagnosis.conclusion||'An active operational finding is present.',220);
  const target=encodeURIComponent(diagnosis.id||`service:${serviceId}`);

  return `<div class="ops-diagnosis"><span class="ops-diagnosis__label">${escapeHtml(label)}</span><span class="ops-diagnosis__text">${escapeHtml(conclusion)}</span><br><a class="ops-diagnosis__link" href="/diagnose?target=${target}">Details →</a></div>`;
}

function shorten(value,max){
  const text=String(value??'').replace(/\s+/g,' ').trim();
  if(text.length<=max)return text;
  return text.slice(0,Math.max(0,max-1)).trimEnd()+'…';
}

function formatAge(value){
  const ms=Date.now()-Date.parse(value);
  if(!Number.isFinite(ms))return null;
  const minutes=Math.max(0,Math.round(ms/60000));
  if(minutes<1)return 'just now';
  if(minutes===1)return '1 minute ago';
  return `${minutes} minutes ago`;
}

function escapeHtml(value){
  return String(value??'').replace(/[&<>'"]/g,c=>({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    "'":'&#39;',
    '"':'&quot;'
  }[c]));
}
