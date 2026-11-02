// resegment 파리티 하니스 — 앱이 실제로 쓰는 ui/transcript-model.js 의 resegment / trKey 를 그대로 실행한다.
//   tests/test_resegment_parity.py 가 이 출력을 Python 포팅(scripts/translate_transcripts.py)과 대조.
//
//   사용: node scripts/resegment_parity.mjs [--ids 1,2,3] [--dir <path>]
//   --dir defaults to data/transcripts (gitignored pipeline output). The parity test also points
//   it at tests/fixtures/transcripts, which IS committed, so the comparison runs on a fresh
//   checkout instead of skipping itself into a false green.
//   출력(stdout, JSON): { "<id>": { "sents": [...문장...], "keys": [...trKey...] } }
import { readFileSync, readdirSync } from 'node:fs';
import { resegment, trKey } from '../ui/transcript-model.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --ids / --dir 파싱
let ids = null;
const ai = process.argv.indexOf('--ids');
if (ai >= 0 && process.argv[ai + 1]) ids = process.argv[ai + 1].split(',').map((s) => s.trim()).filter(Boolean);

const di = process.argv.indexOf('--dir');
const txDir = di >= 0 && process.argv[di + 1] ? process.argv[di + 1] : join(ROOT, 'data/transcripts');
if (!ids) {
  ids = readdirSync(txDir)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => f.replace('.json', ''));
}

const out = {};
for (const id of ids) {
  let tr;
  try {
    tr = JSON.parse(readFileSync(join(txDir, `${id}.json`), 'utf8'));
  } catch {
    continue;  // 없는 id 는 건너뜀(테스트가 교집합만 비교)
  }
  const segs = tr.segments || [];
  const reseg = resegment(segs);
  // resegment 는 {text,start,end,words} 객체 배열(단어 없으면 raw segment 폴백).
  // 문장 텍스트만 뽑는다: 객체면 .text, 혹시 문자열이면 그대로.
  const sents = reseg.map((s) => (s && typeof s === 'object' ? (s.text || '') : String(s || '')));
  out[id] = { sents, keys: sents.map(trKey) };
}
process.stdout.write(JSON.stringify(out));
