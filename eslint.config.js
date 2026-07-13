// ESLint flat config (C3 / AUDIT I6) — 강(强)게이트. 무번들 PWA 라 평소엔
// `node scripts/jscheck.mjs`(의존성 0, 구문 게이트)로 충분하지만, 미사용 변수·미정의 참조 등
// 더 엄격한 규칙은 여기서. 설치·실행:  npm i -D eslint  →  npx eslint ui scripts tests
const browser = {
  // 코어
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly',
  history: 'readonly', console: 'readonly', self: 'readonly', performance: 'readonly',
  // 타이머/스케줄
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  requestIdleCallback: 'readonly', cancelIdleCallback: 'readonly', queueMicrotask: 'readonly',
  // 저장/캐시/네트워크
  localStorage: 'readonly', sessionStorage: 'readonly', caches: 'readonly', indexedDB: 'readonly',
  fetch: 'readonly', Request: 'readonly', Response: 'readonly', Headers: 'readonly',
  AbortController: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  // 미디어/파일
  Audio: 'readonly', Image: 'readonly', Blob: 'readonly', File: 'readonly', FileReader: 'readonly',
  MediaRecorder: 'readonly', MediaMetadata: 'readonly', MediaSource: 'readonly',
  // 음성
  SpeechSynthesisUtterance: 'readonly', speechSynthesis: 'readonly',
  SpeechRecognition: 'readonly', webkitSpeechRecognition: 'readonly',
  // DOM/이벤트/관찰자
  Event: 'readonly', CustomEvent: 'readonly', PointerEvent: 'readonly', KeyboardEvent: 'readonly',
  getComputedStyle: 'readonly', matchMedia: 'readonly', DOMParser: 'readonly',
  IntersectionObserver: 'readonly', ResizeObserver: 'readonly', MutationObserver: 'readonly',
  Notification: 'readonly',
  // 대화상자/인코딩/기타
  alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
  crypto: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
  btoa: 'readonly', atob: 'readonly', structuredClone: 'readonly', RegExp: 'readonly',
  // Service Worker 전용(service-worker.js) — 선언만 해도 no-undef 오탐 제거
  clients: 'readonly', registration: 'readonly', skipWaiting: 'readonly',
  ServiceWorkerGlobalScope: 'readonly',
};
const node = {
  process: 'readonly', console: 'readonly', URL: 'readonly', setTimeout: 'readonly',
  Buffer: 'readonly', __dirname: 'readonly',
};

// no-unused-vars: 관용적으로 무시하는 것들은 오탐에서 제외 —
//   · catch (e) {} 스왈로우 패턴(caughtErrors:'none')
//   · _ 접두 = '의도적으로 안 씀' 표시(varsIgnorePattern/argsIgnorePattern)
//   · 뒤따르는 인자만 안 쓰는 콜백(args:'after-used')
const unusedVars = ['warn', {
  args: 'after-used', caughtErrors: 'none',
  varsIgnorePattern: '^_', argsIgnorePattern: '^_',
}];

export default [
  {
    files: ['ui/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: browser },
    rules: { 'no-undef': 'error', 'no-unused-vars': unusedVars, 'no-const-assign': 'error', 'no-dupe-keys': 'error' },
  },
  {
    files: ['tests/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: node },
    rules: { 'no-unused-vars': unusedVars, 'no-dupe-keys': 'error' },
  },
];
