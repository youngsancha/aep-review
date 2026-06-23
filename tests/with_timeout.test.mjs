// boot() getSession 타임아웃 가드 단위검증 (node --test) — C2/AUDIT P5.
// app.js 는 브라우저 모듈을 import 해 node 직접 import 불가 → 순수 withTimeout 만 소스 추출.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'ui/app.js'), 'utf8');

function grabFn(name) {
  const lines = SRC.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes(`function ${name}(`));
  if (start < 0) throw new Error('fn not found: ' + name);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].replace(/\s+$/, '') === '}') { end = i; break; }
  }
  return lines.slice(start, end + 1).join('\n').replace(/^export\s+/, '');
}
const withTimeout = new Function(grabFn('withTimeout') + '\nreturn withTimeout;')();

test('promise 가 제때 resolve 되면 그 값 반환', async () => {
  const r = await withTimeout(Promise.resolve({ ok: 1 }), 1000, { fallback: true });
  assert.deepEqual(r, { ok: 1 });
});

test('promise 가 ms 안에 안 오면 fallback 반환', async () => {
  const hang = new Promise(() => {});  // 영원히 pending
  const r = await withTimeout(hang, 20, { data: { session: null } });
  assert.deepEqual(r, { data: { session: null } });
});

test('promise 가 reject 돼도 throw 없이 fallback 반환', async () => {
  const r = await withTimeout(Promise.reject(new Error('net down')), 1000, { fallback: true });
  assert.deepEqual(r, { fallback: true });
});

test('일반 값(thenable 아님)도 안전하게 감싼다', async () => {
  const r = await withTimeout(42, 1000, { fallback: true });
  assert.equal(r, 42);
});
