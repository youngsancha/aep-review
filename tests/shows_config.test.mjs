// 멀티-쇼 config 계약 검증 (node --test) — config.js 는 top-level 에서 localStorage 를
// try/catch 로만 만져 node 직접 import 가능. flag-off 시 기존 단일쇼(aep) 동작 보존을 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHOWS, SHOW_BY_SLUG, DEFAULT_SHOW, MULTISHOW,
  currentShow, setCurrentShow, showMeta, showCover, SHOW_COVER, SHOW_COVER_SM,
} from '../ui/config.js';

const REQUIRED = ['slug', 'name', 'host', 'level', 'rss', 'cover'];

test('SHOWS: aep + allears 두 쇼, 필수 필드 완비', () => {
  assert.equal(SHOWS.length, 2);
  const slugs = SHOWS.map((s) => s.slug);
  assert.deepEqual(slugs, ['aep', 'allears']);
  for (const s of SHOWS) {
    for (const f of REQUIRED) assert.ok(s[f] && String(s[f]).trim(), `${s.slug}.${f} 비어있음`);
    assert.ok(/^https?:\/\//.test(s.rss), `${s.slug}.rss URL 아님`);
    assert.ok(/^https?:\/\//.test(s.cover), `${s.slug}.cover URL 아님`);
  }
});

test('RSS: 두 쇼 모두 megaphone 피드(공통 clean-URL/R2 싱크 적용)', () => {
  assert.equal(SHOW_BY_SLUG.aep.rss, 'https://feeds.megaphone.fm/americanenglishpodcast');
  assert.equal(SHOW_BY_SLUG.allears.rss, 'https://feeds.megaphone.fm/allearsenglish');
});

test('SHOW_BY_SLUG / DEFAULT_SHOW', () => {
  assert.equal(SHOW_BY_SLUG.aep.name, 'American English Podcast');
  assert.equal(SHOW_BY_SLUG.allears.name, 'All Ears English');
  assert.equal(DEFAULT_SHOW, 'aep');
});

test('flag-off 안전: MULTISHOW=false 면 currentShow()=기본쇼(aep) — localStorage 무관', () => {
  assert.equal(MULTISHOW, false);            // 활성화는 [사람]: 마이그레이션+인제스트 후 true
  assert.equal(currentShow(), 'aep');
  setCurrentShow('allears');                  // flag off 면 무시(여전히 aep)
  assert.equal(currentShow(), 'aep');
});

test('showMeta/showCover: 기본=aep, 미지 slug 는 첫 쇼로 폴백', () => {
  assert.equal(showMeta().slug, 'aep');
  assert.equal(showMeta('allears').slug, 'allears');
  assert.equal(showMeta('nope').slug, 'aep');   // 폴백
  assert.ok(showCover('allears').includes('All_Ears_English'));
});

test('하위호환: SHOW_COVER/SM 은 aep 커버 사이즈 변형(기존 픽셀 보존)', () => {
  assert.ok(SHOW_COVER.includes('15526600'));      // aep 커버 자산 id
  assert.ok(SHOW_COVER.endsWith('&w=720&h=720'));
  assert.ok(SHOW_COVER_SM.endsWith('&w=160&h=160'));
});
