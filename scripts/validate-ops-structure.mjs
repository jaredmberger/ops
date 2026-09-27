import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const wranglerPath=path.join(root,'wrangler.toml');
const readmePath=path.join(root,'README.md');

const wrangler=fs.readFileSync(wranglerPath,'utf8');
const readme=fs.readFileSync(readmePath,'utf8');

const mainMatch=wrangler.match(/^main\s*=\s*"([^"]+)"/m);
if(!mainMatch)throw new Error('wrangler.toml does not declare a main entrypoint.');

const mainPath=mainMatch[1];
const absoluteMain=path.join(root,mainPath);
if(!fs.existsSync(absoluteMain))throw new Error(`wrangler.toml main does not exist: ${mainPath}`);

if(!readme.includes(`Current entrypoint: \`${mainPath}\``)){
  throw new Error(`README production entrypoint does not match wrangler.toml: ${mainPath}`);
}

const visited=new Set();
function verifyImports(filePath){
  const absolute=path.resolve(filePath);
  if(visited.has(absolute))return;
  visited.add(absolute);

  const source=fs.readFileSync(absolute,'utf8');
  const importRe=/from\s+['"]([^'"]+)['"]/g;
  for(const match of source.matchAll(importRe)){
    const spec=match[1];
    if(!spec.startsWith('.'))continue;
    const target=path.resolve(path.dirname(absolute),spec);
    if(!fs.existsSync(target)){
      throw new Error(`Missing relative import from ${path.relative(root,absolute)}: ${spec}`);
    }
    verifyImports(target);
  }
}

verifyImports(absoluteMain);

const chain=[...visited].map(file=>path.relative(root,file)).sort();
console.log(`Validated production entrypoint: ${mainPath}`);
console.log(`Validated ${chain.length} files in the active import chain.`);
for(const file of chain)console.log(` - ${file}`);


const driftSource=fs.readFileSync(path.join(root,'src/deployment-drift.js'),'utf8');
if(!driftSource.includes('/compare/')){
  throw new Error('Deployment drift must verify GitHub commit ancestry before declaring drift.');
}
if(!driftSource.includes("state='unknown';relation='unverified'")){
  throw new Error('Unverified commit mismatches must remain unknown rather than escalate as drift.');
}

const bridgeSource=fs.readFileSync(path.join(root,'src/error-bus-bridge.js'),'utf8');
if(!bridgeSource.includes("if(s.state==='drift')")){
  throw new Error('Error Bus bridge must only escalate confirmed deployment drift.');
}
if(!bridgeSource.includes('comparisonStatus')){
  throw new Error('Deployment drift incidents must carry comparison evidence.');
}

if(!driftSource.includes("relation='content-equivalent'")){
  throw new Error('Deployment drift must recognize zero-file-diff commit equivalence.');
}
if(!driftSource.includes('filesChanged===0')){
  throw new Error('Deployment drift must test GitHub file-diff equivalence before escalation.');
}


const runtimeSource=fs.readFileSync(path.join(root,'src/runtime-identity.js'),'utf8');
if(!runtimeSource.includes("import { BUILD_META } from './build-meta.generated.js'")){
  throw new Error('Ops runtime must expose build metadata.');
}
if(!runtimeSource.includes("id:'ops'")||!runtimeSource.includes('localRuntimeIdentity')){
  throw new Error('Ops runtime inventory must include Curator Ops itself without recursive HTTP fetch.');
}
if(!driftSource.includes("id:'ops'")||!driftSource.includes('localRuntimeResult')){
  throw new Error('Deployment drift must include Curator Ops itself using local runtime metadata.');
}
if(!wrangler.includes('command = "node scripts/write-build-meta.mjs"')){
  throw new Error('wrangler.toml must stamp Ops build metadata before deployment.');
}


if(mainPath!=='src/ops.js'){
  throw new Error(`Curator Ops production entrypoint must remain src/ops.js, found: ${mainPath}`);
}

const stableOpsSource=fs.readFileSync(path.join(root,'src/ops.js'),'utf8');
if(!stableOpsSource.includes("entry-v1.19.js")){
  throw new Error('Stable Ops entrypoint must currently delegate to the verified v1.19 compatibility implementation.');
}

const srcFiles=fs.readdirSync(path.join(root,'src'));
for(const name of srcFiles){
  const match=name.match(/^entry-v1\.(\d+)\.js$/);
  if(match&&Number(match[1])>19){
    throw new Error(`Version-wrapper pattern is frozen; unexpected wrapper found: ${name}`);
  }
}


const freshnessSource=fs.readFileSync(path.join(root,'src/scheduled-freshness.js'),'utf8');
if(!freshnessSource.includes('/api/scheduled-freshness')||!freshnessSource.includes("scheduled-freshness:latest")){
  throw new Error('Named scheduled-freshness module must own freshness routes and snapshot key.');
}

const foundationalShims=[
  ['entry-v1.1.js','runtime-identity.js'],
  ['entry-v1.2.js','deployment-drift.js'],
  ['entry-v1.3.js','scheduled-freshness.js'],
  ['entry-v1.4.js','error-bus-bridge.js']
];
for(const [name,target] of foundationalShims){
  const source=fs.readFileSync(path.join(root,'src',name),'utf8');
  if(!source.includes(`export { default } from './${target}';`)||source.split('\n').length>=6){
    throw new Error(`${name} must remain a tiny compatibility shim to ${target}.`);
  }
}

const historySource=fs.readFileSync(path.join(root,'src/entry-v1.5.js'),'utf8');
if(!historySource.includes("import base from './error-bus-bridge.js'")){
  throw new Error('v1.5 must import the named Error Bus bridge directly.');
}
