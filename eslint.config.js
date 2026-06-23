// ESLint flat config (C3 / AUDIT I6) — 선택적 강(强)게이트.
// 무번들 PWA 라 평소엔 `node scripts/jscheck.mjs`(의존성 0, 구문 게이트)로 충분하다.
// 더 엄격한 규칙(미사용 변수·미정의 참조 등)을 원하면 ESLint 를 1회 설치(사람/네트워크 단계):
//     npm i -D eslint   →   npx eslint ui tests scripts
// 이 파일은 설치 전엔 비활성(그냥 존재만). 설치하면 즉시 동작한다.
const browser = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly',
  history: 'readonly', fetch: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
  console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', requestAnimationFrame: 'readonly', crypto: 'readonly', caches: 'readonly',
  self: 'readonly', Audio: 'readonly', Image: 'readonly', URL: 'readonly', TextEncoder: 'readonly',
  matchMedia: 'readonly', MediaMetadata: 'readonly', SpeechSynthesisUtterance: 'readonly',
  speechSynthesis: 'readonly', Event: 'readonly', CustomEvent: 'readonly', RegExp: 'readonly',
};
const node = {
  process: 'readonly', console: 'readonly', URL: 'readonly', setTimeout: 'readonly',
  Buffer: 'readonly', __dirname: 'readonly',
};

export default [
  {
    files: ['ui/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: browser },
    rules: { 'no-undef': 'error', 'no-unused-vars': 'warn', 'no-const-assign': 'error', 'no-dupe-keys': 'error' },
  },
  {
    files: ['tests/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: node },
    rules: { 'no-unused-vars': 'warn', 'no-dupe-keys': 'error' },
  },
];
