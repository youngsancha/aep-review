// 빌드리스 JS 게이트 (C3 / AUDIT I6) — 의존성 0. ui/ 와 tests/ 의 모든 .js/.mjs 를
// `node --check` 로 파싱해 구문오류를 잡는다. PWA 가 무번들/무빌드라 자동가드가 node --test
// 뿐이던 공백을 메운다(전 파일 구문 보장). 더 강한 규칙(미사용 변수 등)은 eslint.config.js 가
// 준비돼 있고, ESLint 설치(npm) 후 `npx eslint ui tests` 로 켜면 된다(설치=사람/네트워크 단계).
//
//   node scripts/jscheck.mjs     # exit 0=PASS, 1=구문오류 발견
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['ui', 'tests'];
const EXT = new Set(['.js', '.mjs']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.has(extname(name))) out.push(p);
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(join(ROOT, d)));
const failures = [];
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failures.push(`${f}\n${(e.stderr || e.message || '').toString().trim()}`);
  }
}

console.log(`jscheck: ${files.length} files, ${failures.length} failed`);
if (failures.length) {
  console.error('\nSYNTAX ERRORS:\n' + failures.join('\n\n'));
  process.exit(1);
}
console.log('PASS');
