// 홈 화면 아이콘 회귀 테스트 — "설치 며칠 뒤 흰 테두리 + 작아진 아이콘" 버그(v1.53~v1.78)를 막는다.
//
// 원인: Chrome 은 설치된 WebAPK 의 manifest 를 하루 한 번쯤 다시 보고, maskable 아이콘을 못 받으면
// "any" 아이콘으로 떨어져 WebAPK 를 다시 만든다. 안드로이드는 maskable 이 아닌 아이콘을 흰 판 위에
// 작게 그린다. 그래서 여기서 지키는 것:
//   ① 런처 아이콘 파일마다 any 와 maskable 이 둘 다 선언됨 → 어느 쪽으로 떨어져도 같은 바이트
//   ② 그 파일들이 SW 필수 precache 에 있음 → 오프라인 점검에서도 실패하지 않음
//   ③ 경로가 /icons/vN/ 로 버전됨 → 옛 SW·HTTP 캐시가 옛 그림을 내줄 수 없음
//   ④ PNG 가 선언한 크기 그대로이고 불투명(RGB) — 투명 픽셀도 런처 판을 부른다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const UI = new URL('../ui/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', UI), 'utf8'));
const html = readFileSync(new URL('index.html', UI), 'utf8');
const swSrc = readFileSync(new URL('service-worker.js', UI), 'utf8');

/** PNG IHDR → {w, h, colorType}. colorType 2 = RGB, 6 = RGBA. */
function pngInfo(path) {
  const b = readFileSync(new URL('.' + path, UI));
  assert.equal(b.toString('latin1', 1, 4), 'PNG', `${path} is not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] };
}

/** SW 를 샌드박스에서 돌려 install 이 실제로 받는 URL 목록을 얻는다(정규식보다 정직하다). */
async function swInstallUrls() {
  const fetched = [];
  let installer;
  const self = {
    location: { origin: 'https://app.test' },
    addEventListener(type, fn) { if (type === 'install') installer = fn; },
    skipWaiting() {},
  };
  const caches = { async open() { return { async put() {} }; } };
  const fetch = async (url) => { fetched.push(url); return { ok: true, clone() { return this; } }; };
  vm.runInNewContext(swSrc, { self, caches, fetch, URL, console, setTimeout, Response: class {} });
  let done;
  installer({ waitUntil(p) { done = p; } });
  await done;
  return fetched;
}

const launcher = manifest.icons;

test('manifest has an explicit id and only versioned icon paths', () => {
  assert.equal(manifest.id, '/');
  for (const i of launcher) assert.match(i.src, /^\/icons\/v\d+\//, i.src);
});

test('every launcher icon file is declared as BOTH any and maskable (no fallback to downgrade to)', () => {
  const bySrc = new Map();
  for (const i of launcher) {
    const set = bySrc.get(i.src) || new Set();
    for (const p of (i.purpose || 'any').split(/\s+/)) set.add(p);
    bySrc.set(i.src, set);
  }
  for (const [src, purposes] of bySrc) {
    assert.ok(purposes.has('any') && purposes.has('maskable'), `${src}: ${[...purposes]}`);
  }
  const sizes = new Set(launcher.map((i) => i.sizes));
  assert.ok(sizes.has('192x192') && sizes.has('512x512'), 'Chrome installability needs 192 and 512');
});

test('icon files exist, match their declared size, and are opaque', () => {
  for (const i of launcher) {
    const { w, h, colorType } = pngInfo(i.src);
    assert.equal(`${w}x${h}`, i.sizes, i.src);
    assert.equal(colorType, 2, `${i.src} must be opaque RGB`);
  }
});

test('the service worker precaches every manifest icon as CRITICAL', async () => {
  const urls = await swInstallUrls();
  for (const i of launcher) assert.ok(urls.includes(i.src), `SW does not precache ${i.src}`);
  const m = /const ICONS = \[([\s\S]*?)\];/.exec(swSrc);
  assert.ok(m && /\.\.\.ICONS/.test(/const SHELL_CRITICAL = \[([\s\S]*?)\];/.exec(swSrc)[1]),
    'ICONS must be spread into SHELL_CRITICAL');
});

test('index.html and views reference only files that exist under the current icon set', () => {
  const refs = new Set();
  const views = readdirSync(new URL('views/', UI)).map((f) => readFileSync(new URL('views/' + f, UI), 'utf8'));
  for (const src of [html, swSrc, ...views, JSON.stringify(manifest)]) {
    for (const m of src.matchAll(/\/icons\/[\w./-]+\.png/g)) refs.add(m[0]);
  }
  for (const r of refs) {
    assert.ok(existsSync(new URL('.' + r, UI)), `missing ${r}`);
    if (r !== '/icons/wh-cover.png') assert.match(r, /^\/icons\/v\d+\//, `unversioned icon path ${r}`);
  }
});
