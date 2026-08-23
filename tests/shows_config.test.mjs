// 멀티-쇼 config 계약 검증 (node --test) — config.js 는 top-level 에서 localStorage 를
// try/catch 로만 만져 node 직접 import 가능. flag-off 시 기존 단일쇼(aep) 동작 보존을 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHOWS, SHOW_BY_SLUG, DEFAULT_SHOW, MULTISHOW,
  currentShow, setCurrentShow, showMeta, showCover, showOptions, SHOW_COVER, SHOW_COVER_SM,
} from '../ui/config.js';

// rss 는 source==='rss' 쇼만 필수(wh 는 whitehouse.gov 스크레이프라 rss 없음).
const REQUIRED = ['slug', 'name', 'host', 'level', 'cover'];

test('SHOWS: aep + allears + wh + cnn10 네 쇼, 필수 필드 완비', () => {
  assert.equal(SHOWS.length, 4);
  const slugs = SHOWS.map((s) => s.slug);
  assert.deepEqual(slugs, ['aep', 'allears', 'wh', 'cnn10']);
  for (const s of SHOWS) {
    for (const f of REQUIRED) assert.ok(s[f] && String(s[f]).trim(), `${s.slug}.${f} 비어있음`);
    assert.ok(s.cover && String(s.cover).trim(), `${s.slug}.cover 없음`);
    if ((s.source || 'rss') === 'rss') {
      assert.ok(/^https?:\/\//.test(s.rss), `${s.slug}.rss URL 아님`);
    } else {
      assert.equal(s.rss, null, `${s.slug} 는 비-RSS 소스라 rss=null 이어야`);
    }
  }
});

test('RSS: rss 소스 쇼는 megaphone 피드; wh 는 whitehouse 소스(rss 없음)', () => {
  assert.equal(SHOW_BY_SLUG.aep.rss, 'https://feeds.megaphone.fm/americanenglishpodcast');
  assert.equal(SHOW_BY_SLUG.allears.rss, 'https://feeds.megaphone.fm/allearsenglish');
  assert.equal(SHOW_BY_SLUG.wh.source, 'whitehouse');
  assert.equal(SHOW_BY_SLUG.wh.rss, null);
});

test('SHOW_BY_SLUG / DEFAULT_SHOW', () => {
  assert.equal(SHOW_BY_SLUG.aep.name, 'American English Podcast');
  assert.equal(SHOW_BY_SLUG.allears.name, 'All Ears English');
  assert.equal(DEFAULT_SHOW, 'aep');
});

test('MULTISHOW 활성(v137): 선택기 노출 + currentShow 는 저장값 없으면 기본쇼(aep)', () => {
  assert.equal(MULTISHOW, true);             // v137 활성화: AEP+AEE 선택기 노출(롤백 시 false)
  assert.equal(currentShow(), 'aep');        // node 엔 localStorage 없음 → 항상 기본쇼
  setCurrentShow('allears');                  // localStorage 미지원(node) → no-op, 여전히 aep
  assert.equal(currentShow(), 'aep');
});

test('showMeta/showCover: 기본=aep, 미지 slug 는 첫 쇼로 폴백', () => {
  assert.equal(showMeta().slug, 'aep');
  assert.equal(showMeta('allears').slug, 'allears');
  assert.equal(showMeta('nope').slug, 'aep');   // 폴백
  assert.ok(showCover('allears').includes('All_Ears_English'));
});

test('showOptions: 선택기 렌더 데이터 — 기본 쇼(aep)만 active', () => {
  const opts = showOptions();
  assert.equal(opts.length, 4);
  const aep = opts.find((o) => o.slug === 'aep');
  const aee = opts.find((o) => o.slug === 'allears');
  assert.equal(aep.active, true);          // node: localStorage 없음 → currentShow=aep 가 active
  assert.equal(aee.active, false);
  for (const o of opts) {
    for (const f of ['slug', 'name', 'level', 'cover']) assert.ok(o[f], `${o.slug}.${f} 없음`);
  }
});

test('하위호환: SHOW_COVER/SM 은 aep 커버 사이즈 변형(기존 픽셀 보존)', () => {
  assert.ok(SHOW_COVER.includes('15526600'));      // aep 커버 자산 id
  assert.ok(SHOW_COVER.endsWith('&w=720&h=720'));
  assert.ok(SHOW_COVER_SM.endsWith('&w=160&h=160'));
});
