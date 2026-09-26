import base from './entry-v1.17.js';

const NAV_START='<!-- CURATOR_OPS_NAV -->';
const CARDS_START='<!-- CURATOR_OPS_CARDS -->';

export default{
  async fetch(request,env,ctx){
    const url=new URL(request.url);

    if(request.method==='GET'&&url.pathname==='/api/recovery-export'){
      const authError=requireRecoveryExportToken(request,env);
      if(authError)return authError;
      return recoveryExport(env);
    }

    const response=await base.fetch(request,env,ctx);
    if(request.method!=='GET'||url.pathname!=='/')return response;

    const type=response.headers.get('content-type')||'';
    if(!type.includes('text/html'))return response;

    const body=await response.text();
    const headers=new Headers(response.headers);
    headers.delete('content-length');

    return new Response(polishHome(body),{
      status:response.status,
      statusText:response.statusText,
      headers
    });
  },

  async scheduled(controller,env,ctx){
    return base.scheduled(controller,env,ctx);
  }
};

function polishHome(body){
  const nav=NAV_START+`<div class="links ops-unified-nav">
    <a href="/deployments">Deployments →</a>
    <a href="/scheduled">Scheduled Work →</a>
    <a href="/operational-state">Operational State →</a>
    <a href="/incidents">Correlated Incidents →</a>
    <a href="/timeline">History Intelligence →</a>
    <a href="/devices">Devices →</a>
    <a href="/security">Security →</a>
    <a href="/briefing">Briefing →</a>
    <a href="/diagnose">Why is this red? →</a>
    <a href="/history">Incident History →</a>
    <a href="/api/status">Status JSON →</a>
  </div>`+CARDS_START;

  let out=body;
  const anchored=new RegExp(
    escapeRegExp(NAV_START)+'[\\s\\S]*?'+escapeRegExp(CARDS_START)
  );

  if(anchored.test(out)){
    out=out.replace(anchored,nav);
  }else{
    const legacy='<div class="links"><a href="/deployments">Deployment Drift →</a><a href="/scheduled">Scheduled Work →</a><a href="/api/status">Status JSON →</a></div>';
    if(out.includes(legacy))out=out.replace(legacy,nav);
  }

  if(out.includes('</style>')){
    out=out.replace(
      '</style>',
      '.ops-unified-nav{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center}.ops-unified-nav a{white-space:nowrap}</style>'
    );
  }

  return out;
}

function escapeRegExp(value){
  return String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}


function requireRecoveryExportToken(request,env){
  if(!env.RECOVERY_EXPORT_TOKEN){
    return recoveryJson({
      ok:false,
      error:'Recovery export is disabled because RECOVERY_EXPORT_TOKEN is not configured.'
    },503);
  }

  const supplied=request.headers.get('x-curator-recovery-key');
  if(supplied===env.RECOVERY_EXPORT_TOKEN)return null;

  return recoveryJson({
    ok:false,
    error:'Unauthorized recovery export request.'
  },401);
}

async function recoveryExport(env){
  if(!env.CURATOR_OPS_RECORDS){
    return recoveryJson({
      ok:false,
      error:'CURATOR_OPS_RECORDS is not configured.'
    },500);
  }

  try{
    const entries=await listAllOpsState(env.CURATOR_OPS_RECORDS);
    const data={entries};
    const exportedAt=new Date().toISOString();
    const dataSha256=await sha256(JSON.stringify(data));

    const payload={
      format:'curator-ops-kv-recovery',
      schemaVersion:1,
      exportedAt,
      source:{
        service:'Curator Ops',
        binding:'CURATOR_OPS_RECORDS',
        namespaceId:'747c318b62fa479aa486130011d5670d'
      },
      integrity:{algorithm:'SHA-256',dataSha256},
      summary:{
        keyCount:entries.length,
        categories:summarizeOpsState(entries)
      },
      data
    };

    const stamp=exportedAt.replace(/[:.]/g,'-');
    return new Response(JSON.stringify(payload,null,2),{
      status:200,
      headers:{
        'content-type':'application/json; charset=utf-8',
        'content-disposition':`attachment; filename="curator-ops-recovery-${stamp}.json"`,
        'cache-control':'no-store',
        'x-content-type-options':'nosniff',
        'x-robots-tag':'noindex, nofollow, noarchive'
      }
    });
  }catch(error){
    return recoveryJson({
      ok:false,
      error:'Recovery export failed.',
      detail:error?.message||String(error)
    },500);
  }
}

async function listAllOpsState(store){
  const entries=[];
  let cursor;

  do{
    const page=await store.list({
      limit:1000,
      ...(cursor?{cursor}:{})
    });

    for(const item of page.keys){
      const raw=await store.get(item.name,'text');
      if(raw===null)throw new Error(`Listed KV key disappeared during export: ${item.name}`);
      entries.push({key:item.name,value:raw});
    }

    cursor=page.list_complete?undefined:page.cursor;
  }while(cursor);

  entries.sort((a,b)=>a.key.localeCompare(b.key));
  return entries;
}

function summarizeOpsState(entries){
  const counts={
    deployments:0,
    scheduled:0,
    reachability:0,
    journeys:0,
    integrity:0,
    performance:0,
    selfTest:0,
    operationalState:0,
    incidents:0,
    history:0,
    devices:0,
    security:0,
    diagnostics:0,
    other:0
  };

  for(const {key} of entries){
    if(key.includes('deployment'))counts.deployments++;
    else if(key.includes('scheduled'))counts.scheduled++;
    else if(key.includes('reachability')||key.includes('service-status'))counts.reachability++;
    else if(key.includes('journey'))counts.journeys++;
    else if(key.includes('integrity'))counts.integrity++;
    else if(key.includes('performance'))counts.performance++;
    else if(key.includes('self-test'))counts.selfTest++;
    else if(key.includes('operational-state'))counts.operationalState++;
    else if(key.includes('incident')||key.includes('correlation'))counts.incidents++;
    else if(key.includes('history')||key.includes('timeline')||key.includes('rollup'))counts.history++;
    else if(key.includes('device')||key.includes('heartbeat'))counts.devices++;
    else if(key.includes('security'))counts.security++;
    else if(key.includes('diagnostic'))counts.diagnostics++;
    else counts.other++;
  }

  return counts;
}

async function sha256(value){
  const bytes=new TextEncoder().encode(value);
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)]
    .map(byte=>byte.toString(16).padStart(2,'0'))
    .join('');
}

function recoveryJson(value,status=200){
  return new Response(JSON.stringify(value,null,2),{
    status,
    headers:{
      'content-type':'application/json; charset=utf-8',
      'cache-control':'no-store',
      'x-content-type-options':'nosniff',
      'x-robots-tag':'noindex, nofollow, noarchive'
    }
  });
}
