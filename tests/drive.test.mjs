// Car Mode 대상 선택 로직 단위검증 (node --test) — A3.
// drive.js 는 브라우저 모듈(/player.js 등)을 import 해 node 직접 import 불가 → 순수함수
// driveTarget 만 소스에서 추출해 검증(다른 테스트와 동일한 복사-드리프트 방지 기법).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'ui/views/drive.js'), 'utf8');

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
const driveTarget = new Function(grabFn('driveTarget') + '\nreturn driveTarget;')();

test('현재 로드된 트랙이 있으면 그걸 사용(mode=current, resume 0)', () => {
  const r = driveTarget({ id: 7, title: 'Ep 7' }, { id: 3, title: 'Ep 3', t: 120 });
  assert.deepEqual(r, { mode: 'current', id: 7, title: 'Ep 7', resume: 0 });
});

test('현재 트랙 없으면 마지막 이어듣기로(mode=resume, 저장 위치)', () => {
  const r = driveTarget(null, { id: 3, title: 'Ep 3', t: 120 });
  assert.deepEqual(r, { mode: 'resume', id: 3, title: 'Ep 3', resume: 120 });
});

test('둘 다 없으면 none', () => {
  assert.equal(driveTarget(null, null).mode, 'none');
  assert.equal(driveTarget(undefined, undefined).mode, 'none');
  assert.equal(driveTarget({}, {}).mode, 'none');  // id 없는 빈 객체도 none
});

test('이어듣기 t 없으면 resume 0 으로 안전', () => {
  const r = driveTarget(null, { id: 5, title: 'Ep 5' });
  assert.deepEqual(r, { mode: 'resume', id: 5, title: 'Ep 5', resume: 0 });
});
