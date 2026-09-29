import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('runtime identity owns runtime inventory and self identity', async () => {
  const source=await readFile(new URL('../src/runtime-identity.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/runtime/);
  assert.match(source,/\/api\/runtime-status/);
  assert.match(source,/localRuntimeIdentity/);
  assert.match(source,/BUILD_META/);
  assert.match(source,/contractVersion:1/);
  assert.match(source,/productionBranch:'main'/);
  assert.match(source,/cloudflareDeploymentId/);
  assert.match(source,/validateRuntimeContract/);
  assert.match(source,/contractVersion must be 1/);
  assert.match(source,/productionBranch must be main/);
  assert.match(source,/commit is required/);
  assert.match(source,/cloudflareDeploymentId is required/);
});

test('deployment drift owns evidence-based deployment comparison', async () => {
  const source=await readFile(new URL('../src/deployment-drift.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/deployment-drift/);
  assert.match(source,/filesChanged===0/);
  assert.match(source,/relation='content-equivalent'/);
  assert.match(source,/\/compare\//);
  assert.match(source,/runtime\.data\?\.commit\|\|runtime\.data\?\.build\?\.commit/);
  assert.match(source,/runtime\?\.cloudflareDeploymentId\|\|runtime\?\.cloudflareVersion\?\.id/);
  assert.match(source,/import base from '\.\/runtime-identity\.js'/);
});

test('scheduled freshness owns freshness collection', async () => {
  const source=await readFile(new URL('../src/scheduled-freshness.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/scheduled-freshness/);
  assert.match(source,/scheduled-freshness:latest/);
  assert.match(source,/import base from '\.\/deployment-drift\.js'/);
});

test('Error Bus bridge owns reconciliation and recovery confirmation', async () => {
  const source=await readFile(new URL('../src/error-bus-bridge.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/error-bus-bridge/);
  assert.match(source,/RECOVERY_CONFIRMATIONS/);
  assert.match(source,/bridgeOwnsIncident/);
  assert.match(source,/import base from '\.\/scheduled-freshness\.js'/);
});

test('v1.1-v1.4 are compatibility shims', async () => {
  const pairs=[
    ['entry-v1.1.js','runtime-identity.js'],
    ['entry-v1.2.js','deployment-drift.js'],
    ['entry-v1.3.js','scheduled-freshness.js'],
    ['entry-v1.4.js','error-bus-bridge.js']
  ];
  for(const [name,target] of pairs){
    const source=await readFile(new URL(`../src/${name}`,import.meta.url),'utf8');
    assert.match(source,new RegExp(`export \\{ default \\} from '\\.\\/${target.replace('.', '\\.')}';`));
    assert.ok(source.split('\n').length<6);
  }
});

test('incident history imports Error Bus bridge directly and v1.5 remains a shim', async () => {
  const source=await readFile(new URL('../src/incident-history.js',import.meta.url),'utf8');
  assert.match(source,/import base from '\.\/error-bus-bridge\.js'/);
  assert.doesNotMatch(source,/entry-v1\.4\.js/);

  const shim=await readFile(new URL('../src/entry-v1.5.js',import.meta.url),'utf8');
  assert.match(shim,/export \{ default \} from '\.\/incident-history\.js'/);
  assert.ok(shim.split('\n').length<6);
});
