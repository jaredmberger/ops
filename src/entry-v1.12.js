import base from './entry-v1.11.js';

const OPS_KV='CURATOR_OPS_RECORDS';
const BROWSER_KEY='browser-search-journey:latest';
const DISPATCH_STATE_KEY='browser-search-dispatch-supervisor:state';
const DISPATCH_SNAPSHOT_KEY='browser-search-dispatch-supervisor:latest';
const DISPATCH_URL='https://api.github.com/repos/jaredmberger/ops/actions/workflows/browser-search-journey.yml/dispatches';
const FALLBACK_AFTER_MS=20*60*1000;
const MIN_DISPATCH_INTERVAL_MS=15*60*1000;
const STATE_TTL=60*60*24*30;

export default {
  async fetch(request,env,ctx){
    const u=new URL(request.url);
    if(request.method==='GET'&&u.pathname==='/api/browser-search-dispatch-supervisor'){
      return json({ok:true,snapshot:await readSupervisorSnapshot(env)});
    }
    if(request.method==='POST'&&u.pathname==='/api/browser-search-dispatch-supervisor-check-now'){
      return json({ok:true,snapshot:await supervise(env,'manual')});
    }
    return base.fetch(request,env,ctx);
  },

  async scheduled(controller,env,ctx){
    const result=base.scheduled(controller,env,ctx);
    ctx.waitUntil(
      supervise(env,`cron:${controller?.cron||'unknown'}`)
        .catch(error=>console.error('Browser search dispatch supervisor failed',error))
    );
    return result;
  }
};

async function supervise(env,source){
  requireBindings(env);
  const nowMs=Date.now();
  const checkedAt=new Date(nowMs).toISOString();
  const browser=await env[OPS_KV].get(BROWSER_KEY,'json');
  const prior=await env[OPS_KV].get(DISPATCH_STATE_KEY,'json')||{};

  const runUpdatedAt=browser?.run?.updatedAt||browser?.run?.createdAt||null;
  const runUpdatedMs=runUpdatedAt?Date.parse(runUpdatedAt):NaN;
  const ageMs=Number.isFinite(runUpdatedMs)?Math.max(0,nowMs-runUpdatedMs):null;
  const ageMinutes=ageMs===null?null:Math.round(ageMs/60000);
  const lastDispatchMs=prior?.lastDispatchAt?Date.parse(prior.lastDispatchAt):NaN;
  const sinceLastDispatchMs=Number.isFinite(lastDispatchMs)?nowMs-lastDispatchMs:null;

  let action='none';
  let message='Browser journey is fresh; no fallback dispatch needed.';
  let dispatchStatus=null;
  let lastDispatchAt=prior.lastDispatchAt||null;
  let lastDispatchResult=prior.lastDispatchResult||null;

  const needsFallback=ageMs===null||ageMs>FALLBACK_AFTER_MS;
  const rateLimited=sinceLastDispatchMs!==null&&sinceLastDispatchMs<MIN_DISPATCH_INTERVAL_MS;

  if(needsFallback){
    if(rateLimited){
      action='suppressed';
      message=`Browser journey is stale, but a fallback dispatch was already requested ${Math.max(0,Math.round(sinceLastDispatchMs/60000))} minutes ago.`;
    }else if(!env.GITHUB_OPS_TOKEN){
      action='blocked';
      message='Browser journey is stale, but GITHUB_OPS_TOKEN is not configured for workflow dispatch.';
      lastDispatchResult='missing-token';
    }else{
      const response=await fetch(DISPATCH_URL,{
        method:'POST',
        headers:{
          accept:'application/vnd.github+json',
          authorization:`Bearer ${env.GITHUB_OPS_TOKEN}`,
          'content-type':'application/json',
          'user-agent':'CuratorOps-BrowserDispatch/1.12 (+https://ops.oceanlinercurator.com)',
          'x-github-api-version':'2022-11-28'
        },
        body:JSON.stringify({ref:'main'})
      });
      dispatchStatus=response.status;
      lastDispatchAt=checkedAt;

      if(response.status===204){
        action='dispatched';
        lastDispatchResult='accepted';
        message=`Browser journey was stale${ageMinutes===null?'':` (${ageMinutes} minutes old)`}; fallback workflow dispatch accepted by GitHub.`;
      }else{
        let detail='';
        try{detail=(await response.text()).slice(0,240)}catch{}
        action='dispatch-failed';
        lastDispatchResult=`http-${response.status}`;
        message=`Fallback workflow dispatch failed with GitHub HTTP ${response.status}${detail?`: ${detail}`:''}.`;
      }
    }
  }

  const state={
    lastDispatchAt,
    lastDispatchResult,
    updatedAt:checkedAt
  };
  const snapshot={
    generatedAt:checkedAt,
    source,
    action,
    message,
    browserRunUpdatedAt:runUpdatedAt,
    browserRunAgeMinutes:ageMinutes,
    fallbackAfterMinutes:Math.round(FALLBACK_AFTER_MS/60000),
    minimumDispatchIntervalMinutes:Math.round(MIN_DISPATCH_INTERVAL_MS/60000),
    lastDispatchAt,
    lastDispatchResult,
    dispatchStatus
  };

  await env[OPS_KV].put(DISPATCH_STATE_KEY,JSON.stringify(state),{expirationTtl:STATE_TTL});
  await env[OPS_KV].put(DISPATCH_SNAPSHOT_KEY,JSON.stringify(snapshot));
  return snapshot;
}

async function readSupervisorSnapshot(env){
  requireBindings(env);
  return await env[OPS_KV].get(DISPATCH_SNAPSHOT_KEY,'json')||{
    generatedAt:null,
    source:null,
    action:'warming',
    message:'Waiting for the first dispatch-supervisor check.',
    browserRunUpdatedAt:null,
    browserRunAgeMinutes:null,
    fallbackAfterMinutes:20,
    minimumDispatchIntervalMinutes:15,
    lastDispatchAt:null,
    lastDispatchResult:null,
    dispatchStatus:null
  };
}

function requireBindings(env){
  if(!env?.[OPS_KV])throw new Error(`${OPS_KV} binding is required`);
}

function json(value,status=200){
  return new Response(JSON.stringify(value,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
}
