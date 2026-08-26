// resegment 파리티 하니스 — ui/views/episode.js 의 '실제' resegment / trKey 소스를 그대로 실행한다.
//   복사본을 두지 않는다(드리프트 방지): episode.js 를 텍스트로 읽어 두 최상위 함수만 잘라
//   new Function 으로 평가 → DOM/네트워크 의존 없이 진짜 앱 코드를 돌린다.
//   tests/test_resegment_parity.py 가 이 출력을 Python 포팅(scripts/translate_transcripts.py)과 대조.
//
//   사용: node scripts/resegment_parity.mjs [--ids 1,2,3] [--dir <path>]
//   --dir defaults to data/transcripts (gitignored pipeline output). The parity test also points
//   it at tests/fixtures/transcripts, which IS committed, so the comparison runs on a fresh
//   checkout instead of skipping itself into a false green.
//   출력(stdout, JSON): { "<id>": { "sents": [...문장...], "keys": [...trKey...] } }
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// episode.js 의 '최상위 function NAME(...) { ... }' 블록을 통째로 추출.
// 최상위 함수는 닫는 '}' 가 컬럼0 단독 줄이라 그 줄까지 잘라낸다(파서 없이 안전).
function extractTopLevelFn(src, name) {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`function ${name} (`));
  if (start < 0) throw new Error(`function ${name} 를 episode.js 에서 못 찾음`);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].replace(/\s+$/, '') === '}') { end = i; break; }
  }
  if (end < 0) throw new Error(`function ${name} 의 닫는 } 를 못 찾음`);
  return lines.slice(start, end + 1).join('\n');
}

const epSrc = readFileSync(join(ROOT, 'ui/views/episode.js'), 'utf8');
const body =
  extractTopLevelFn(epSrc, 'resegment') + '\n' +
  extractTopLevelFn(epSrc, 'trKey') + '\n' +
  'return { resegment, trKey };';
const { resegment, trKey } = new Function(body)();

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
