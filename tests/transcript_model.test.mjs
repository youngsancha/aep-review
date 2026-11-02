// ui/transcript-model.js directly. resegment itself is pinned against real transcripts and the Python port
// by tests/test_resegment_parity.py; these cover the rest of the module and the invariants named in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trKey, resegment, groupIntoParagraphs, detectContentStart, detectAdRanges, easyByWords }
  from '../ui/transcript-model.js';

const sent = (text, start, end) => ({ text, start, end });

test('trKey ignores case, spacing and closing punctuation, so a backfilled period keeps its translation', () => {
  assert.equal(trKey('  Hello,   World '), 'hello, world');
  assert.equal(trKey('Hello, world.'), trKey('hello, world'));
  assert.equal(trKey('Really?!'), 'really');
  assert.equal(trKey('wait…'), 'wait');
});

test('trKey keeps inner punctuation and caps its length', () => {
  assert.equal(trKey('U.S. policy'), 'u.s. policy');
  assert.equal(trKey('x'.repeat(500)).length, 180);
});

test('trKey survives missing text', () => {
  assert.equal(trKey(null), '');
  assert.equal(trKey(undefined), '');
});

test('resegment splits on sentence ends and keeps word timings', () => {
  const words = [['Hello', 0, 0.4], [' there.', 0.4, 0.9], [' How', 1.2, 1.5], [' are', 1.5, 1.7], [' you?', 1.7, 2]]
    .map(([word, start, end]) => ({ word, start, end }));
  const out = resegment([{ start: 0, end: 2, text: 'Hello there. How are you?', words }]);
  assert.deepEqual(out.map((s) => s.text), ['Hello there.', 'How are you?']);
  assert.equal(out[1].start, 1.2);
  assert.equal(out[1].end, 2);
});

test('paragraphs: a real silence always breaks', () => {
  const p = groupIntoParagraphs([sent('One two', 0, 1), sent('three four', 3, 4)]);
  assert.equal(p.length, 2);
});

test('paragraphs: two quick acknowledgements do not make a one-second paragraph', () => {
  const p = groupIntoParagraphs([sent('Yeah.', 0, 0.4), sent('So good.', 0.5, 1), sent('I agree with that.', 1.1, 3)]);
  assert.equal(p.length, 1);
});

test('paragraphs: a long run is capped even with no sentence end', () => {
  const run = Array.from({ length: 10 }, (_, i) => sent('and then', i * 2, i * 2 + 2));
  assert.ok(groupIntoParagraphs(run).length >= 2);
});

test('the content start is the host intro, including a greeting right before it', () => {
  const s = ['Buy this mattress.', 'Save 20 percent.', 'Hi everybody.', 'My name is Shana.', 'Today we talk.']
    .map((text, i) => sent(text, i, i + 1));
  assert.equal(detectContentStart(s), 2);
});

test('no intro anchor means nothing is hidden as an ad', () => {
  const s = ['Plain sentence one.', 'Plain sentence two.'].map((text, i) => sent(text, i, i + 1));
  assert.equal(detectContentStart(s) <= 0, true);
  assert.deepEqual(detectAdRanges(s), []);
});

test('easy sentences are short and common; anything else earns a translation', () => {
  assert.equal(easyByWords('Yes, I know that.'), true);
  assert.equal(easyByWords('Serendipity struck.'), false);
  assert.equal(easyByWords('one two three four five six seven eight nine ten'), false);
  assert.equal(easyByWords(''), true);
});
