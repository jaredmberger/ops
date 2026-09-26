import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('Ops recovery endpoint is protected and scoped to CURATOR_OPS_RECORDS',async()=>{
  const source=await readFile(new URL('../src/entry-v1.18.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/recovery-export/);
  assert.match(source,/RECOVERY_EXPORT_TOKEN/);
  assert.match(source,/x-curator-recovery-key/);
  assert.match(source,/CURATOR_OPS_RECORDS/);
  assert.match(source,/747c318b62fa479aa486130011d5670d/);
  assert.doesNotMatch(source,/source:\{[\s\S]*binding:'CURATOR_ERROR_RECORDS'/);
  assert.match(source,/list_complete/);
  assert.match(source,/dataSha256/);
});
