// Settings ↔ Study 세션 크기 동기화 회귀 테스트 (node --test, 빌드툴 없음).
//   Settings 시트에 추가된 "오늘 세션 크기"(S/M/L) 세그먼트가 Study 탭이 이미 쓰는
//   'aep-session-size' 키와 정확히 같은 값 인코딩을 읽고/쓰는지 확인한다 — 한쪽이 값을 바꾸면
//   다른 쪽이 조용히 못 읽는 "second encoding" 드리프트가 회귀 대상.
// 복사 드리프트 방지: 실제 소스(ui/settings.js·ui/views/study.js)에서 함수를 추출해 실행
// (srs_streak.test.mjs 와 동일 기법 — grabFn/grabConst).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function grabConst(src, name) {
  const m = new RegExp(`^const ${name} = .*;`, 'm').exec(src);
  if (!m) throw new Error('const not found: ' + name);
  return m[0];
}
// study.js::SESS_CAPS 처럼 여러 줄에 걸친 객체 리터럴 const 용 (grabConst 는 한 줄짜리 전용).
function grabBlock(src, name) {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`const ${name} = `));
  if (start < 0) throw new Error('const not found: ' + name);
  if (/;\s*$/.test(lines[start])) return lines[start];
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\};?\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end < 0) throw new Error('const end not found: ' + name);
  return lines.slice(start, end + 1).join('\n');
}
function grabFn(src, name) {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error('fn not found: ' + name);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].replace(/\s+$/, '') === '}') { end = i; break; }
  }
  if (end < 0) throw new Error('fn end not found: ' + name);
  return lines.slice(start, end + 1).join('\n');
}
function fakeLS(obj = {}) {
  const store = { ...obj };
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _store: store,
  };
}

const settingsSrc = readFileSync(join(ROOT, 'ui/settings.js'), 'utf8');
const SETTINGS_BODY = grabConst(settingsSrc, 'SESS_SIZE_KEY') + '\n'
  + grabFn(settingsSrc, 'getSessionSize') + '\n'
  + grabFn(settingsSrc, 'setSessionSize') + '\n'
  + 'return { getSessionSize, setSessionSize, SESS_SIZE_KEY };';
function makeSettings(ls) { return new Function('localStorage', SETTINGS_BODY)(ls); }

const studySrc = readFileSync(join(ROOT, 'ui/views/study.js'), 'utf8');
const STUDY_BODY = grabConst(studySrc, 'SESS_SIZE_KEY') + '\n'
  + grabBlock(studySrc, 'SESS_CAPS') + '\n'   // sessSize() 가 SESS_CAPS[v] 로 유효성 검사함
  + grabFn(studySrc, 'sessSize') + '\n'
  + 'return { sessSize, SESS_SIZE_KEY };';
function makeStudy(ls) { return new Function('localStorage', STUDY_BODY)(ls); }

test('settings.js와 study.js가 같은 localStorage 키를 쓴다', () => {
  const s = makeSettings(fakeLS());
  const st = makeStudy(fakeLS());
  assert.equal(s.SESS_SIZE_KEY, 'aep-session-size');
  assert.equal(s.SESS_SIZE_KEY, st.SESS_SIZE_KEY);
});

test('둘 다 기본값(빈/무효 값)에서 M을 반환한다', () => {
  assert.equal(makeSettings(fakeLS()).getSessionSize(), 'M');
  assert.equal(makeStudy(fakeLS()).sessSize(), 'M');
  const bogus = fakeLS({ 'aep-session-size': 'XL' });
  assert.equal(makeSettings(bogus).getSessionSize(), 'M');
  assert.equal(makeStudy(bogus).sessSize(), 'M');
});

test('Settings에서 쓴 값을 Study가 다음 렌더에서 그대로 읽는다(같은 인코딩)', () => {
  for (const v of ['S', 'M', 'L']) {
    const ls = fakeLS();
    const settings = makeSettings(ls);
    settings.setSessionSize(v);
    assert.equal(ls.getItem('aep-session-size'), v);   // 값 자체가 S/M/L 그대로 저장됨
    const study = makeStudy(ls);                        // Study가 "다음 렌더"에서 같은 localStorage를 읽는 상황 재현
    assert.equal(study.sessSize(), v);
  }
});
