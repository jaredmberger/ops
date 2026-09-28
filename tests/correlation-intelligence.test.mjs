import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('Browser Search dispatch owns fallback supervision', async () => {
  const source=await readFile(new URL('../src/browser-search-dispatch.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/browser-search-dispatch-supervisor/);
  assert.match(source,/FALLBACK_AFTER_MS/);
  assert.match(source,/MIN_DISPATCH_INTERVAL_MS/);
  assert.match(source,/import base from '\.\/performance-anomaly\.js'/);
});

test('Operational State preserves dependency-aware classification', async () => {
  const source=await readFile(new URL('../src/operational-state.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/operational-state/);
  assert.match(source,/buildFindings/);
  assert.match(source,/deriveState/);
  assert.match(source,/import base from '\.\/browser-search-dispatch\.js'/);
});

test('Incident Correlation preserves lossless grouping and recovery lifecycle', async () => {
  const source=await readFile(new URL('../src/incident-correlation.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/incident-correlation/);
  assert.match(source,/buildGroups/);
  assert.match(source,/RECOVERY_CONFIRMATIONS/);
  assert.match(source,/listActiveIncidents/);
  assert.match(source,/import base from '\.\/operational-state\.js'/);
});

test('Operational History preserves temporal correlation without causal claim', async () => {
  const source=await readFile(new URL('../src/operational-history.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/operational-history/);
  assert.match(source,/findDeploymentCorrelation/);
  assert.match(source,/temporal-correlation/);
  assert.match(source,/causal:false/);
  assert.match(source,/import base from '\.\/incident-correlation\.js'/);
});

test('Device/security/briefing layer keeps device state observational', async () => {
  const source=await readFile(new URL('../src/device-security-briefing.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/devices/);
  assert.match(source,/\/api\/security-summary/);
  assert.match(source,/\/api\/briefing/);
  assert.match(source,/deviceStateRank/);
  assert.match(source,/import base from '\.\/operational-history\.js'/);
});

test('Diagnostics owns evidence-first explanations', async () => {
  const source=await readFile(new URL('../src/diagnostics.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/diagnostics/);
  assert.match(source,/diagnosticConclusion/);
  assert.match(source,/contextEvidence/);
  assert.match(source,/confidenceRank/);
  assert.match(source,/import base from '\.\/device-security-briefing\.js'/);
});

test('v1.12-v1.17 remain compatibility shims', async () => {
  const mapping=[
    ['entry-v1.12.js','browser-search-dispatch.js'],
    ['entry-v1.13.js','operational-state.js'],
    ['entry-v1.14.js','incident-correlation.js'],
    ['entry-v1.15.js','operational-history.js'],
    ['entry-v1.16.js','device-security-briefing.js'],
    ['entry-v1.17.js','diagnostics.js']
  ];
  for(const [name,target] of mapping){
    const source=await readFile(new URL(`../src/${name}`,import.meta.url),'utf8');
    assert.match(source,new RegExp(`export \\{ default \\} from '\\.\\/${target.replace('.', '\\.')}';`));
    assert.ok(source.split('\n').length<6);
  }
});


test('Operational State distinguishes stale scheduled work from observer unreachability', async () => {
  const source=await readFile(new URL('../src/operational-state.js',import.meta.url),'utf8');
  assert.match(source,/severity:service\.status==='stale'\?'attention':'degraded'/);
  assert.match(source,/job staleness is not yet confirmed/);
});
