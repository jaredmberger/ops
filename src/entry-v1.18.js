import base from './entry-v1.17.js';

const NAV_START='<!-- CURATOR_OPS_NAV -->';
const CARDS_START='<!-- CURATOR_OPS_CARDS -->';

export default{
  async fetch(request,env,ctx){
    const response=await base.fetch(request,env,ctx);
    const url=new URL(request.url);
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
