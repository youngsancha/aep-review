// Essentials 데이터 품질 가드 (node --test) — ui/data/essentials.json.
// 대량 표현 확장(B1) 시 스키마/중복/카테고리 정합을 자동 검증해 소비 코드(essentials.js)와의
// 계약을 깨지 않게 한다. 유료 API·외부호출 없음(정적 팩 검사만).
//
// 검사 계약(essentials.js 가 읽는 형태와 일치):
//   카드 = { id, cat, term, ko, example, example_ko, register } 7필드 전부 비어있지 않은 문자열.
//   id 전역 유일 · cat 은 categories[].id 중 하나 · term 은 대소문자 무시 유일.
//   category = { id, emoji, label } 비어있지 않음.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pack = JSON.parse(readFileSync(join(ROOT, 'ui/data/essentials.json'), 'utf8'));

const CARD_FIELDS = ['id', 'cat', 'term', 'ko', 'example', 'example_ko', 'register'];
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

test('top-level: version / categories[] / cards[] 존재', () => {
  assert.ok(pack && typeof pack === 'object');
  assert.ok(Array.isArray(pack.categories) && pack.categories.length > 0);
  assert.ok(Array.isArray(pack.cards) && pack.cards.length > 0);
});

test('categories: id/emoji/label 비어있지 않고 id 유일', () => {
  const ids = new Set();
  for (const k of pack.categories) {
    assert.ok(nonEmpty(k.id), `cat id empty: ${JSON.stringify(k)}`);
    assert.ok(nonEmpty(k.emoji), `cat emoji empty: ${k.id}`);
    assert.ok(nonEmpty(k.label), `cat label empty: ${k.id}`);
    assert.ok(!ids.has(k.id), `dup category id: ${k.id}`);
    ids.add(k.id);
  }
});

test('cards: 7필드 전부 비어있지 않은 문자열', () => {
  for (const c of pack.cards) {
    for (const f of CARD_FIELDS) {
      assert.ok(nonEmpty(c[f]), `card ${c.id || '?'} field "${f}" empty/missing`);
    }
  }
});

test('cards: id 전역 유일', () => {
  const seen = new Set();
  for (const c of pack.cards) {
    assert.ok(!seen.has(c.id), `dup card id: ${c.id}`);
    seen.add(c.id);
  }
});

test('cards: cat 은 정의된 카테고리를 참조', () => {
  const catIds = new Set(pack.categories.map((k) => k.id));
  for (const c of pack.cards) {
    assert.ok(catIds.has(c.cat), `card ${c.id} references unknown cat "${c.cat}"`);
  }
});

test('cards: term 대소문자 무시 중복 없음', () => {
  const seen = new Map();
  for (const c of pack.cards) {
    const key = c.term.trim().toLowerCase();
    assert.ok(!seen.has(key), `dup term "${c.term}" (ids ${seen.get(key)} & ${c.id})`);
    seen.set(key, c.id);
  }
});

test('cards: 알 수 없는 필드 없음(스키마 드리프트 방지)', () => {
  const allowed = new Set(CARD_FIELDS);
  for (const c of pack.cards) {
    for (const k of Object.keys(c)) {
      assert.ok(allowed.has(k), `card ${c.id} has unexpected field "${k}"`);
    }
  }
});

test('모든 카테고리가 최소 1장의 카드를 보유(빈 탭 방지)', () => {
  const used = new Set(pack.cards.map((c) => c.cat));
  for (const k of pack.categories) {
    assert.ok(used.has(k.id), `category "${k.id}" has no cards`);
  }
});
