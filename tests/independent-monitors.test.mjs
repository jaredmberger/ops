import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('Public Site Journey preserves three-stage persistence',async()=>{
  const source=await readFile(new URL('../src/public-site-journey.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/public-site-journey/);
  assert.match(source,/failureStreak===1\?'observing':failureStreak===2\?'degraded':'persistent'/);
  assert.match(source,/public-site-journey:latest/);
  assert.match(source,/import base from '\.\/incident-history\.js'/);
});

test('self-test owns persistence verification and storage incident',async()=>{
  const source=await readFile(new URL('../src/self-test.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/self-test/);
  assert.match(source,/incident:ops-self-test-storage/);
  assert.match(source,/OPS_SENTINEL_KEY/);
  assert.match(source,/ERROR_SENTINEL_KEY/);
  assert.match(source,/import base from '\.\/public-site-journey\.js'/);
});

test('monitoring summary composes journey and self-test state',async()=>{
  const source=await readFile(new URL('../src/monitoring-summary.js',import.meta.url),'utf8');
  assert.match(source,/Public Site Journey/);
  assert.match(source,/CuratorOS Self-Test/);
  assert.match(source,/import base from '\.\/self-test\.js'/);
});

test('Browser Search Journey retains specialist incident ownership',async()=>{
  const source=await readFile(new URL('../src/browser-search-journey.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/browser-search-journey/);
  assert.match(source,/browser-search-journey:latest/);
  assert.match(source,/incident:/);
  assert.match(source,/import base from '\.\/monitoring-summary\.js'/);
});

test('Deployment Integrity retains persistent-only escalation',async()=>{
  const source=await readFile(new URL('../src/deployment-integrity.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/deployment-integrity/);
  assert.match(source,/deployment-integrity/);
  assert.match(source,/persistent/);
  assert.match(source,/import base from '\.\/browser-search-journey\.js'/);
});

test('Performance Anomaly retains conservative thresholds',async()=>{
  const source=await readFile(new URL('../src/performance-anomaly.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/performance-anomaly/);
  assert.match(source,/RATIO_THRESHOLD/);
  assert.match(source,/ABSOLUTE_THRESHOLD_MS/);
  assert.match(source,/MIN_SAMPLES/);
  assert.match(source,/import base from '\.\/deployment-integrity\.js'/);
});

test('v1.6-v1.11 are compatibility shims and dispatch supervision follows the named monitor chain',async()=>{
  const mapping=[
    ['entry-v1.6.js','public-site-journey.js'],
    ['entry-v1.7.js','self-test.js'],
    ['entry-v1.8.js','monitoring-summary.js'],
    ['entry-v1.9.js','browser-search-journey.js'],
    ['entry-v1.10.js','deployment-integrity.js'],
    ['entry-v1.11.js','performance-anomaly.js']
  ];
  for(const [name,target] of mapping){
    const source=await readFile(new URL(`../src/${name}`,import.meta.url),'utf8');
    assert.match(source,new RegExp(`export \\{ default \\} from '\\.\\/${target.replace('.', '\\.')}';`));
    assert.ok(source.split('\n').length<6);
  }
  const dispatch=await readFile(new URL('../src/browser-search-dispatch.js',import.meta.url),'utf8');
  assert.match(dispatch,/import base from '\.\/performance-anomaly\.js'/);
  assert.doesNotMatch(dispatch,/entry-v1\.11\.js/);
});
