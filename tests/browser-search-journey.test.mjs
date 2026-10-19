import assert from 'node:assert/strict';
import test from 'node:test';
import { selectLatestRun, assessRun } from '../src/browser-search-journey.js';

test('selectLatestRun chooses the newest run by updated_at, not response order',()=>{
  const runs=[
    {
      id:1,
      created_at:'2026-10-01T13:04:00Z',
      updated_at:'2026-10-01T13:05:00Z',
      status:'completed',
      conclusion:'success'
    },
    {
      id:2,
      created_at:'2026-10-06T17:04:00Z',
      updated_at:'2026-10-06T17:05:00Z',
      status:'completed',
      conclusion:'success'
    },
    {
      id:3,
      created_at:'2026-10-06T16:39:00Z',
      updated_at:'2026-10-06T16:40:00Z',
      status:'completed',
      conclusion:'success'
    }
  ];

  assert.equal(selectLatestRun(runs)?.id,2);
});

test('selectLatestRun falls back to created_at and ignores invalid entries',()=>{
  const runs=[
    null,
    {created_at:'2026-10-06T17:10:00Z'},
    {id:10,created_at:'2026-10-06T17:00:00Z'},
    {id:11,created_at:'2026-10-06T17:09:00Z'}
  ];

  assert.equal(selectLatestRun(runs)?.id,11);
});

test('selectLatestRun returns null for an empty run list',()=>{
  assert.equal(selectLatestRun([]),null);
});

test('HTTP 401 identifies credential failure without claiming a failed browser run',()=>{
  const result=assessRun(null,'GitHub Actions API HTTP 401','2026-10-19T04:50:00Z');
  assert.equal(result.rawState,'unreachable');
  assert.equal(result.reason,'github-authentication-failure');
  assert.match(result.message,/GITHUB_OPS_TOKEN/);
});

test('HTTP 500 remains a general GitHub API failure',()=>{
  const result=assessRun(null,'GitHub Actions API HTTP 500','2026-10-19T04:50:00Z');
  assert.equal(result.reason,'github-api-unreachable');
});
