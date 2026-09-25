import base from './entry-v1.15.js';

const OPS_KV='CURATOR_OPS_RECORDS';
const ERROR_KV='CURATOR_ERROR_RECORDS';
const HEARTBEAT_PREFIX='heartbeat:';
const SECURITY_PREFIX='security-event:';
const SECURITY_SUMMARY_KEY='security-summary:latest';
const DEVICE_SNAPSHOT_KEY='device-observability:latest';
const BRIEFING_KEY='current-briefing:latest';
const INCIDENT_CORRELATION_KEY='incident-correlation:latest';
const OPERATIONAL_STATE_KEY='operational-state:latest';
const OPERATIONAL_HISTORY_KEY='operational-history:latest';
const REACHABILITY_KEY='snapshot:latest';
const DEPLOYMENT_DRIFT_KEY='deployment-drift:latest';
const SCHEDULED_FRESHNESS_KEY='scheduled-freshness:latest';
const DEFAULT_DEVICE_MAX_AGE_MINUTES=30;
const DEVICE_QUIET_MULTIPLIER=3;
const SECURITY_TTL=60*60*24*30;
const SNAPSHOT_TTL=60*60*24*30;
const DISPLAY_TIME_ZONE='America/Chicago';

export default{
  async fetch(request,env,ctx){
    const u=new URL(request.url);

    if(request.method==='POST'&&u.pathname==='/api/heartbeat'){
      const auth=authorizeWrite(request,env);
      if(!auth.ok)return json({ok:false,error:auth.error},auth.status);
      try{
        const heartbeat=await recordHeartbeat(env,await readJson(request));
        return json({ok:true,heartbeat},201);
      }catch(error){
        return json({ok:false,error:String(error?.message||error)},400);
      }
    }

    if(request.method==='GET'&&u.pathname==='/api/devices'){
      const snapshot=await collectDevices(env,'request');
      return json({ok:true,snapshot});
    }

    if(request.method==='GET'&&u.pathname==='/devices'){
      return html(renderDevices(await collectDevices(env,'request')));
    }

    if(request.method==='POST'&&u.pathname==='/api/security-event'){
      const auth=authorizeWrite(request,env);
      if(!auth.ok)return json({ok:false,error:auth.error},auth.status);
      try{
        const event=await recordSecurityEvent(env,await readJson(request),request);
        return json({ok:true,event},201);
      }catch(error){
        return json({ok:false,error:String(error?.message||error)},400);
      }
    }

    if(request.method==='GET'&&u.pathname==='/api/security-summary'){
      return json({ok:true,snapshot:await collectSecurity(env,'request')});
    }

    if(request.method==='GET'&&u.pathname==='/security'){
      return html(renderSecurity(await collectSecurity(env,'request')));
    }

    if(request.method==='GET'&&u.pathname==='/api/briefing'){
      return json({ok:true,briefing:await buildBriefing(env,'request')});
    }

    if(request.method==='GET'&&u.pathname==='/briefing'){
      return html(renderBriefing(await buildBriefing(env,'request')));
    }

    if(request.method==='GET'&&u.pathname==='/'){
      const response=await base.fetch(request,env,ctx);
      const type=response.headers.get('content-type')||'';
      if(!type.includes('text/html'))return response;
      const [devices,security,briefing]=await Promise.all([
        readDeviceSnapshot(env),
        readSecuritySnapshot(env),
        readBriefing(env)
      ]);
      const body=await response.text();
      const headers=new Headers(response.headers);
      headers.delete('content-length');
      return new Response(
        inject(body,devices,security,briefing),
        {status:response.status,statusText:response.statusText,headers}
      );
    }

    return base.fetch(request,env,ctx);
  },

  async scheduled(controller,env,ctx){
    const result=base.scheduled(controller,env,ctx);
    ctx.waitUntil(
      Promise.all([
        collectDevices(env,`cron:${controller?.cron||'unknown'}`),
        collectSecurity(env,`cron:${controller?.cron||'unknown'}`)
      ]).then(()=>buildBriefing(env,`cron:${controller?.cron||'unknown'}`))
        .catch(error=>console.error('Devices/security/briefing collection failed',error))
    );
    return result;
  }
};

async function recordHeartbeat(env,body){
  requireOpsKv(env);
  const service=clean(body?.service,100);
  if(!service)throw new Error('service is required');

  const now=new Date().toISOString();
  const deviceId=clean(body?.deviceId||body?.device_id||service,120);
  const expectedMinutes=finitePositive(
    body?.maxAgeMinutes??body?.max_age_minutes??body?.heartbeatMaxAgeMinutes
  );

  const record={
    service,
    deviceId:deviceId||service,
    status:clean(body?.status||'online',40),
    version:clean(body?.version,120)||null,
    firmware:clean(body?.firmware||body?.firmwareVersion,120)||null,
    commit:clean(body?.commit,120)||null,
    runtime:clean(body?.runtime,120)||null,
    deviceClass:clean(body?.deviceClass||body?.device_class,80)||null,
    board:clean(body?.board,120)||null,
    display:clean(body?.display,120)||null,
    wifiRssi:finite(body?.wifiRssi??body?.rssi),
    batteryPercent:clampNumber(body?.batteryPercent??body?.battery,0,100),
    powerSource:clean(body?.powerSource||body?.power,80)||null,
    charging:typeof body?.charging==='boolean'?body.charging:null,
    maxAgeMinutes:expectedMinutes||DEFAULT_DEVICE_MAX_AGE_MINUTES,
    note:clean(body?.note,500)||null,
    observedAt:now
  };

  await env[OPS_KV].put(
    `${HEARTBEAT_PREFIX}${slug(record.deviceId)}`,
    JSON.stringify(record),
    {expirationTtl:60*60*24*30}
  );
  return record;
}

async function collectDevices(env,source){
  requireOpsKv(env);
  const now=Date.now();
  const listed=await env[OPS_KV].list({prefix:HEARTBEAT_PREFIX,limit:1000});
  const devices=[];

  for(const item of listed.keys){
    const value=await env[OPS_KV].get(item.name,'json');
    if(!value)continue;

    const observedMs=Date.parse(value.observedAt||'');
    const ageMinutes=Number.isFinite(observedMs)?Math.max(0,Math.round((now-observedMs)/60000)):null;
    const maxAgeMinutes=finitePositive(value.maxAgeMinutes)||DEFAULT_DEVICE_MAX_AGE_MINUTES;
    const state=
      ageMinutes===null?'unknown':
      ageMinutes<=maxAgeMinutes?'online':
      ageMinutes<=maxAgeMinutes*DEVICE_QUIET_MULTIPLIER?'quiet':'stale';

    devices.push({
      ...value,
      maxAgeMinutes,
      ageMinutes,
      state,
      key:item.name
    });
  }

  devices.sort((a,b)=>
    deviceStateRank(a.state)-deviceStateRank(b.state)||
    String(a.service||a.deviceId).localeCompare(String(b.service||b.deviceId))
  );

  const summary={
    total:devices.length,
    online:devices.filter(x=>x.state==='online').length,
    quiet:devices.filter(x=>x.state==='quiet').length,
    stale:devices.filter(x=>x.state==='stale').length,
    unknown:devices.filter(x=>x.state==='unknown').length,
    batteryPowered:devices.filter(x=>Number.isFinite(x.batteryPercent)).length,
    weakWifi:devices.filter(x=>Number.isFinite(x.wifiRssi)&&x.wifiRssi<-75).length
  };

  const snapshot={
    generatedAt:new Date().toISOString(),
    source,
    displayTimeZone:DISPLAY_TIME_ZONE,
    summary,
    devices
  };

  await env[OPS_KV].put(DEVICE_SNAPSHOT_KEY,JSON.stringify(snapshot),{expirationTtl:SNAPSHOT_TTL});
  return snapshot;
}

async function recordSecurityEvent(env,body,request){
  requireOpsKv(env);
  const now=new Date().toISOString();
  const source=clean(body?.source||body?.sensor||'security-sensor',100);
  const type=clean(body?.type||body?.eventType||body?.logtype||'probe',120);
  const srcHost=clean(body?.srcHost||body?.src_host||body?.sourceIp||body?.source_ip,120)||null;
  const dstHost=clean(body?.dstHost||body?.dst_host||body?.destinationIp||body?.destination_ip,120)||null;
  const dstPort=finite(body?.dstPort??body?.dst_port);
  const srcPort=finite(body?.srcPort??body?.src_port);
  const protocol=clean(body?.protocol||inferProtocol(type,dstPort),40)||null;
  const username=clean(body?.username||body?.user,120)||null;
  const category=classifySecurityEvent(type,dstPort,body);
  const observedAt=normalizeDate(body?.observedAt||body?.timestamp)||now;

  const event={
    id:crypto.randomUUID(),
    source,
    category,
    type,
    srcHost,
    srcPort,
    dstHost,
    dstPort,
    protocol,
    username,
    message:clean(body?.message||body?.msg||describeSecurityEvent(category,type,dstPort),500)||null,
    observedAt,
    receivedAt:now,
    userAgent:clean(request.headers.get('user-agent'),240)||null
  };

  const ts=Date.parse(observedAt)||Date.now();
  const reverse=String(9999999999999-ts).padStart(13,'0');
  await env[OPS_KV].put(
    `${SECURITY_PREFIX}${reverse}:${event.id}`,
    JSON.stringify(event),
    {expirationTtl:SECURITY_TTL}
  );
  return event;
}

async function collectSecurity(env,source){
  requireOpsKv(env);
  const listed=await env[OPS_KV].list({prefix:SECURITY_PREFIX,limit:1000});
  const events=[];
  for(const item of listed.keys){
    const value=await env[OPS_KV].get(item.name,'json');
    if(value)events.push(value);
  }
  events.sort((a,b)=>String(b.observedAt||'').localeCompare(String(a.observedAt||'')));

  const now=Date.now();
  const within=(minutes)=>events.filter(x=>{
    const ts=Date.parse(x.observedAt||'');
    return Number.isFinite(ts)&&now-ts<=minutes*60000;
  });

  const hour=within(60);
  const day=within(24*60);
  const week=within(7*24*60);
  const previousHour=events.filter(x=>{
    const ts=Date.parse(x.observedAt||'');
    return Number.isFinite(ts)&&now-ts>60*60000&&now-ts<=120*60000;
  });

  const burst=hour.length>=Math.max(10,previousHour.length*3);
  const summary={
    lastHour:hour.length,
    last24Hours:day.length,
    last7Days:week.length,
    uniqueSources24Hours:new Set(day.map(x=>x.srcHost).filter(Boolean)).size,
    burst,
    previousHour:previousHour.length,
    lastEventAt:events[0]?.observedAt||null
  };

  const snapshot={
    generatedAt:new Date().toISOString(),
    source,
    displayTimeZone:DISPLAY_TIME_ZONE,
    status:burst?'elevated':events.length?'observing':'quiet',
    summary,
    topPorts24Hours:topValues(day.map(x=>x.dstPort).filter(Number.isFinite),8),
    topCategories24Hours:topValues(day.map(x=>x.category).filter(Boolean),8),
    topSources24Hours:topValues(day.map(x=>x.srcHost).filter(Boolean),8),
    recentEvents:events.slice(0,50)
  };

  await env[OPS_KV].put(SECURITY_SUMMARY_KEY,JSON.stringify(snapshot),{expirationTtl:SNAPSHOT_TTL});
  return snapshot;
}

async function buildBriefing(env,source){
  requireOpsKv(env);
  const [reachability,drift,scheduled,operational,incidents,history,devices,security]=await Promise.all([
    env[OPS_KV].get(REACHABILITY_KEY,'json'),
    env[OPS_KV].get(DEPLOYMENT_DRIFT_KEY,'json'),
    env[OPS_KV].get(SCHEDULED_FRESHNESS_KEY,'json'),
    env[OPS_KV].get(OPERATIONAL_STATE_KEY,'json'),
    env[OPS_KV].get(INCIDENT_CORRELATION_KEY,'json'),
    env[OPS_KV].get(OPERATIONAL_HISTORY_KEY,'json'),
    readDeviceSnapshot(env),
    readSecuritySnapshot(env)
  ]);

  const rs=reachability?.summary||{};
  const ds=drift?.summary||{};
  const ss=scheduled?.summary||{};
  const os=operational?.summary||{};
  const is=incidents?.summary||{};
  const hs=history?.windows?.hours24||{};
  const dev=devices?.summary||{};
  const sec=security?.summary||{};

  const status=
    incidents?.status==='attention'||operational?.status==='attention'?'attention':
    incidents?.status==='observing'||operational?.status==='degraded'?'observing':'healthy';

  const highlights=[];
  if(Number(is.activeGroups||0)>0){
    highlights.push(`${is.activeGroups} active operational incident group${Number(is.activeGroups)===1?'':'s'} across ${is.underlyingActiveIncidents||0} underlying Error Bus record${Number(is.underlyingActiveIncidents)===1?'':'s'}.`);
  }else{
    highlights.push('No active correlated operational incidents.');
  }
  highlights.push(`Reachability: ${rs.healthy??0}/${rs.total??0} services healthy.`);
  highlights.push(`Deployment truth: ${ds.inSync??0}/${ds.total??0} in sync; ${ds.drift??0} drift.`);
  highlights.push(`Scheduled work: ${ss.healthy??0}/${ss.total??0} healthy; ${ss.stale??0} stale.`);
  if(hs.healthyPercent!=null)highlights.push(`24-hour observed health: ${hs.healthyPercent}% across ${hs.coverageSamples||0} samples.`);
  if(dev.total!=null)highlights.push(`Devices: ${dev.online??0}/${dev.total??0} online; ${dev.quiet??0} quiet; ${dev.stale??0} stale.`);
  if(sec.last24Hours!=null)highlights.push(`Security: ${sec.last24Hours} retained probe event${sec.last24Hours===1?'':'s'} in 24 hours${sec.burst?' with an active burst pattern':''}.`);

  const priorities=[];
  for(const group of incidents?.activeGroups||[]){
    priorities.push({
      type:'incident',
      severity:group.severity||'p2',
      title:group.title,
      detail:group.message,
      signals:group.incidents?.length||0
    });
  }
  for(const device of devices?.devices||[]){
    if(device.state==='stale'){
      priorities.push({
        type:'device',
        severity:'notice',
        title:`${device.service||device.deviceId} heartbeat stale`,
        detail:`Last heartbeat ${device.ageMinutes??'unknown'} minutes ago; expected within ${device.maxAgeMinutes} minutes.`
      });
    }
  }
  if(sec.burst){
    priorities.push({
      type:'security',
      severity:'notice',
      title:'Honeypot/security probe burst',
      detail:`${sec.lastHour} retained events in the last hour versus ${sec.previousHour} in the previous hour.`
    });
  }

  const briefing={
    generatedAt:new Date().toISOString(),
    source,
    displayTimeZone:DISPLAY_TIME_ZONE,
    status,
    headline:status==='healthy'?'CuratorOS is operationally quiet.':status==='attention'?'CuratorOS has active operational attention items.':'CuratorOS is observing conditions that have not reached incident severity.',
    highlights,
    priorities:priorities.slice(0,12),
    counts:{
      servicesHealthy:Number(rs.healthy||0),
      servicesTotal:Number(rs.total||0),
      rootProblems:Number(os.rootProblems||0),
      independentProblems:Number(os.independentProblems||0),
      downstreamSymptoms:Number(os.downstreamSymptoms||0),
      activeIncidentGroups:Number(is.activeGroups||0),
      underlyingIncidents:Number(is.underlyingActiveIncidents||0),
      devicesOnline:Number(dev.online||0),
      devicesTotal:Number(dev.total||0),
      securityEvents24Hours:Number(sec.last24Hours||0)
    }
  };

  await env[OPS_KV].put(BRIEFING_KEY,JSON.stringify(briefing),{expirationTtl:SNAPSHOT_TTL});
  return briefing;
}

async function readDeviceSnapshot(env){
  requireOpsKv(env);
  return await env[OPS_KV].get(DEVICE_SNAPSHOT_KEY,'json')||{
    generatedAt:null,source:null,displayTimeZone:DISPLAY_TIME_ZONE,
    summary:{total:0,online:0,quiet:0,stale:0,unknown:0,batteryPowered:0,weakWifi:0},
    devices:[]
  };
}

async function readSecuritySnapshot(env){
  requireOpsKv(env);
  return await env[OPS_KV].get(SECURITY_SUMMARY_KEY,'json')||{
    generatedAt:null,source:null,displayTimeZone:DISPLAY_TIME_ZONE,status:'quiet',
    summary:{lastHour:0,last24Hours:0,last7Days:0,uniqueSources24Hours:0,burst:false,previousHour:0,lastEventAt:null},
    topPorts24Hours:[],topCategories24Hours:[],topSources24Hours:[],recentEvents:[]
  };
}

async function readBriefing(env){
  requireOpsKv(env);
  return await env[OPS_KV].get(BRIEFING_KEY,'json')||{
    generatedAt:null,source:null,displayTimeZone:DISPLAY_TIME_ZONE,status:'warming',
    headline:'Waiting for the first CuratorOS briefing.',
    highlights:[],priorities:[],counts:{}
  };
}

function inject(body,devices,security,briefing){
  const detail=`${devices.summary?.online??0}/${devices.summary?.total??0} devices online · ${security.summary?.last24Hours??0} security events/24h · ${briefing.priorities?.length??0} briefing priorities`;
  const section=`<section class="ops-device-security" aria-label="Device and security observability"><div class="ops-monitoring__grid"><a class="ops-monitoring__card" href="/devices"><div class="label">Device Observability</div><div class="ops-monitoring__status"><span class="ops-monitoring__dot ${devices.summary?.stale?'observing':'healthy'}"></span>${devices.summary?.online??0}/${devices.summary?.total??0} online</div><div class="ops-monitoring__detail">${esc(detail)}</div></a><a class="ops-monitoring__card" href="/briefing"><div class="label">Current Briefing</div><div class="ops-monitoring__status"><span class="ops-monitoring__dot ${escClass(briefing.status||'warming')}"></span>${esc(briefing.status||'warming')}</div><div class="ops-monitoring__detail">${esc(briefing.headline||'Waiting for briefing.')}</div></a></div></section>`;
  let out=body;
  if(out.includes('</style>'))out=out.replace('</style>','.ops-device-security{margin:-8px 0 22px}</style>');
  out=out.replace('<a href="/history">Operational History →</a>','<a href="/devices">Devices →</a><a href="/security">Security →</a><a href="/briefing">Briefing →</a><a href="/history">Operational History →</a>');
  if(out.includes('<section class="table">'))out=out.replace('<section class="table">',section+'<section class="table">');
  return out;
}

function renderDevices(snapshot){
  const s=snapshot.summary||{};
  const rows=(snapshot.devices||[]).map(d=>`<tr><td>${esc(d.service||d.deviceId)}</td><td>${esc(d.state)}</td><td>${d.observedAt?formatCentral(d.observedAt):'—'}</td><td>${d.ageMinutes??'—'} min</td><td>${esc(d.deviceClass||d.board||'—')}</td><td>${esc(d.firmware||d.version||'—')}</td><td>${d.wifiRssi??'—'} dBm</td><td>${d.batteryPercent==null?'—':d.batteryPercent+'%'}</td><td>${esc(d.powerSource||'—')}</td><td>${esc(d.note||'—')}</td></tr>`).join('');
  return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Devices · Curator Ops</title>${style()}</head><body><main class="wrap"><div class="eyebrow">CuratorOS · Physical Clients</div><h1>Device Observability</h1><p class="lede">Heartbeat visibility for CuratorOS hardware clients. Older devices continue to work with the minimal heartbeat contract; richer firmware can additionally report RSSI, battery, power source, board, display, and expected heartbeat age.</p><section class="cards"><div class="card"><div class="label">Online</div><div class="value">${s.online??0}/${s.total??0}</div></div><div class="card"><div class="label">Quiet</div><div class="value">${s.quiet??0}</div></div><div class="card"><div class="label">Stale</div><div class="value">${s.stale??0}</div></div><div class="card"><div class="label">Weak Wi-Fi</div><div class="value">${s.weakWifi??0}</div></div></section><section class="table"><table><thead><tr><th>Device</th><th>State</th><th>Last heartbeat</th><th>Age</th><th>Hardware</th><th>Firmware</th><th>RSSI</th><th>Battery</th><th>Power</th><th>Note</th></tr></thead><tbody>${rows||'<tr><td colspan="10">No hardware heartbeats retained yet.</td></tr>'}</tbody></table></section><p><a href="/">← Curator Ops</a> · <a href="/briefing">Current Briefing</a></p></main></body></html>`;
}

function renderSecurity(snapshot){
  const s=snapshot.summary||{};
  const rows=(snapshot.recentEvents||[]).map(e=>`<tr><td>${formatCentral(e.observedAt)}</td><td>${esc(e.category)}</td><td>${esc(e.srcHost||'—')}</td><td>${esc(e.protocol||'—')}</td><td>${e.dstPort??'—'}</td><td>${esc(e.type||'—')}</td><td>${esc(e.message||'—')}</td></tr>`).join('');
  return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Security Telemetry · Curator Ops</title>${style()}</head><body><main class="wrap"><div class="eyebrow">CuratorOS · Security Telemetry</div><h1>Security Telemetry</h1><p class="lede">A bounded operational view of honeypot and security-sensor observations. Raw probes remain telemetry rather than Error Bus incidents; the dashboard highlights volume, sources, ports, and burst behavior.</p><section class="cards"><div class="card"><div class="label">Last hour</div><div class="value">${s.lastHour??0}</div></div><div class="card"><div class="label">24 hours</div><div class="value">${s.last24Hours??0}</div></div><div class="card"><div class="label">Unique sources</div><div class="value">${s.uniqueSources24Hours??0}</div></div><div class="card"><div class="label">Burst</div><div class="value">${s.burst?'yes':'no'}</div></div></section><section class="table"><table><thead><tr><th>Observed</th><th>Category</th><th>Source</th><th>Protocol</th><th>Port</th><th>Type</th><th>Detail</th></tr></thead><tbody>${rows||'<tr><td colspan="7">No retained security events yet.</td></tr>'}</tbody></table></section><p><a href="/">← Curator Ops</a> · <a href="/briefing">Current Briefing</a></p></main></body></html>`;
}

function renderBriefing(briefing){
  const highlights=(briefing.highlights||[]).map(x=>`<li>${esc(x)}</li>`).join('');
  const priorities=(briefing.priorities||[]).map(p=>`<article class="priority"><div class="label">${esc(p.type||'item')} · ${esc(p.severity||'notice')}</div><h2>${esc(p.title)}</h2><p>${esc(p.detail||'')}</p></article>`).join('');
  return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Current Briefing · Curator Ops</title>${style()}</head><body><main class="wrap"><div class="eyebrow">CuratorOS · Current State</div><h1>Current Briefing</h1><p class="lede">${esc(briefing.headline||'Waiting for current-state data.')}</p><div class="note">Generated ${briefing.generatedAt?formatCentral(briefing.generatedAt):'—'} · This briefing summarizes evidence already collected by CuratorOS; it does not create new incident severity.</div><h2>At a glance</h2><ul class="brief-list">${highlights||'<li>Waiting for the first briefing collection.</li>'}</ul><h2>Priorities</h2>${priorities||'<p class="lede">No active priorities.</p>'}<p><a href="/">← Curator Ops</a> · <a href="/incidents">Correlated Incidents</a> · <a href="/devices">Devices</a> · <a href="/security">Security</a></p></main></body></html>`;
}

function style(){
  return`<style>:root{color-scheme:dark;--bg:#0a1110;--panel:#101918;--brass:#bfa46a;--text:#f3eee3;--muted:#9aa6a0;--line:#263330}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Georgia,serif}.wrap{max-width:1240px;margin:auto;padding:58px 20px}.eyebrow{font:600 12px system-ui;letter-spacing:.18em;text-transform:uppercase;color:var(--brass)}h1{font-size:clamp(38px,7vw,62px);font-weight:400}.lede{max-width:900px;color:#d3d6d1;line-height:1.6}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:28px 0}.card,.table,.note,.priority{border:1px solid var(--line);background:var(--panel);border-radius:16px}.card,.note,.priority{padding:18px}.label{font:600 11px system-ui;color:var(--muted);text-transform:uppercase}.value{font-size:27px;margin-top:8px}.table{overflow:auto;margin:18px 0}table{width:100%;border-collapse:collapse;min-width:980px;font:13px/1.45 system-ui}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase}a,code{color:#e9d49e}.note,.brief-list,.priority p{font:13px/1.6 system-ui;color:#d3d6d1}.priority{margin:12px 0}.priority h2{font-weight:400;margin:6px 0}.brief-list{padding-left:22px}@media(max-width:800px){.cards{grid-template-columns:1fr 1fr}}@media(max-width:520px){.cards{grid-template-columns:1fr}}</style>`;
}

function topValues(values,limit){
  const counts=new Map();
  for(const value of values)counts.set(String(value),Number(counts.get(String(value))||0)+1);
  return [...counts.entries()].map(([value,count])=>({value,count})).sort((a,b)=>b.count-a.count||a.value.localeCompare(b.value)).slice(0,limit);
}

function classifySecurityEvent(type,port,body){
  const t=String(type||'').toLowerCase();
  if(/ssh/.test(t)||port===22||port===2222)return'ssh';
  if(/telnet/.test(t)||port===23)return'telnet';
  if(/mysql/.test(t)||port===3306)return'database';
  if(/redis/.test(t)||port===6379)return'database';
  if(/rdp/.test(t)||port===3389)return'remote-desktop';
  if(/http/.test(t)||port===80||port===443)return'web';
  if(body?.username||body?.password)return'authentication';
  return'probe';
}

function inferProtocol(type,port){
  const t=String(type||'').toLowerCase();
  if(/ssh/.test(t)||port===22||port===2222)return'ssh';
  if(/telnet/.test(t)||port===23)return'telnet';
  if(/rdp/.test(t)||port===3389)return'rdp';
  if(/http/.test(t)||port===80||port===443)return'http';
  return'';
}

function describeSecurityEvent(category,type,port){
  return `${category||'security'} observation${type?` (${type})`:''}${Number.isFinite(port)?` on port ${port}`:''}`;
}

function normalizeDate(value){
  if(value==null)return null;
  if(typeof value==='number'){
    const ms=value>1e12?value:value*1000;
    const d=new Date(ms);
    return Number.isNaN(d.getTime())?null:d.toISOString();
  }
  const d=new Date(String(value));
  return Number.isNaN(d.getTime())?null:d.toISOString();
}

function deviceStateRank(v){return v==='stale'?0:v==='quiet'?1:v==='unknown'?2:3}
function finite(v){const n=Number(v);return Number.isFinite(n)?n:null}
function finitePositive(v){const n=Number(v);return Number.isFinite(n)&&n>0?n:null}
function clampNumber(v,min,max){const n=Number(v);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):null}
function authorizeWrite(request,env){if(!env.OPS_WRITE_KEY)return{ok:false,status:503,error:'OPS_WRITE_KEY is not configured.'};const supplied=request.headers.get('x-curator-ops-key')||'';if(!supplied||supplied!==env.OPS_WRITE_KEY)return{ok:false,status:401,error:'Unauthorized.'};return{ok:true}}
async function readJson(request){try{return await request.json()}catch{throw new Error('Expected a JSON request body.')}}
function clean(value,max=500){return String(value??'').trim().slice(0,max)}
function slug(value){return clean(value,120).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'unknown'}
function escClass(v){return ['healthy','warming','observing','degraded','persistent','attention','unknown'].includes(String(v))?String(v):'unknown'}
function formatCentral(value){if(!value)return'—';const d=new Date(value);if(Number.isNaN(d.getTime()))return'—';return new Intl.DateTimeFormat('en-US',{timeZone:DISPLAY_TIME_ZONE,month:'numeric',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(d)}
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function requireOpsKv(env){if(!env?.[OPS_KV])throw new Error(`${OPS_KV} binding is required`)}
function requireBindings(env){requireOpsKv(env);if(!env?.[ERROR_KV])throw new Error(`${ERROR_KV} binding is required`)}
function json(value,status=200){return new Response(JSON.stringify(value,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}})}
function html(value){return new Response(value,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})}
