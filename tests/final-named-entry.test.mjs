import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('incident history owns legacy history and intelligence routes',async()=>{
  const source=await readFile(new URL('../src/incident-history.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/history/);
  assert.match(source,/\/api\/curator-intelligence/);
  assert.match(source,/import base from '\.\/error-bus-bridge\.js'/);
});

test('recovery/home owns authenticated recovery export and homepage normalization',async()=>{
  const source=await readFile(new URL('../src/recovery-home.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/recovery-export/);
  assert.match(source,/RECOVERY_EXPORT_TOKEN/);
  assert.match(source,/CURATOR_OPS_NAV/);
  assert.match(source,/import base from '\.\/diagnostics\.js'/);
});

test('fleet diagnostics owns homepage diagnosis presentation',async()=>{
  const source=await readFile(new URL('../src/fleet-diagnostics.js',import.meta.url),'utf8');
  assert.match(source,/DIAGNOSTICS_KEY/);
  assert.match(source,/enhanceFleetTable/);
  assert.match(source,/import base from '\.\/recovery-home\.js'/);
});

test('stable Ops entrypoint uses only named production modules',async()=>{
  const source=await readFile(new URL('../src/ops.js',import.meta.url),'utf8');
  assert.match(source,/fleet-diagnostics\.js/);
  assert.doesNotMatch(source,/from '\.\/entry-v1\./);
});

test('final historical files are compatibility shims',async()=>{
  const mapping=[
    ['entry-v1.5.js','incident-history.js'],
    ['entry-v1.18.js','recovery-home.js'],
    ['entry-v1.19.js','fleet-diagnostics.js']
  ];
  for(const [name,target] of mapping){
    const source=await readFile(new URL(`../src/${name}`,import.meta.url),'utf8');
    assert.match(source,new RegExp(`export \\{ default \\} from '\\.\\/${target.replace('.', '\\.')}';`));
    assert.ok(source.split('\n').length<6);
  }
});


test('runtime identity accepts Pages while preserving Worker deployment identity requirements',async()=>{
  const source=await readFile(new URL('../src/runtime-identity.js',import.meta.url),'utf8');
  assert.match(source,/id:'curator-os'/);
  assert.match(source,/https:\/\/curator\.oceanliners\.net\/api\/runtime/);
  assert.match(source,/id:'link-map'/);
  assert.match(source,/https:\/\/link-map\.oceanliners\.net\/api\/runtime/);
  assert.match(source,/\['cloudflare-workers','cloudflare-pages'\]/);
  assert.match(source,/cloudflareDeploymentId is required for cloudflare-workers/);
  assert.match(source,/cloudflareDeploymentId must be null for cloudflare-pages/);
  assert.match(source,/services\.filter\(x=>x\.ok\)\.length/);
});
