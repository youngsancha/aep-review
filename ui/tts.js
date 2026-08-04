// English TTS — 미리 생성해 Supabase Storage 에 올린 mp3 재생. 파일이 없으면 브라우저 폴백.
//
// 보이스는 2단 체인이다: Kokoro → Edge Neural → 브라우저 speechSynthesis.
// Kokoro(mlx-audio, af_heart)는 Mac mini 의 speakloop 게이트웨이에서만 합성할 수 있어
// scripts/pregen_kokoro_tts.py 로 로컬에서 일괄 생성한다. 반면 야간 CI 인제스트는 GitHub
// 러너에서 edge-tts 로 새 회차의 음성을 만든다 — 즉 갓 들어온 회차는 Edge 파일만 있고
// Kokoro 파일은 로컬 배치가 돌기 전까지 없다. 체인의 2단(Edge)이 없으면 그 창 동안 새
// 표현이 곧바로 로봇 목소리로 떨어진다. 2단을 두는 비용은 Kokoro 가 없을 때의 재시도 1회뿐.
import { STORAGE_URL } from '/supabase.js';

const VOICE_KEY = 'aep-tts-voice-v1';
const RATE_KEY  = 'aep-tts-rate-v1';

// 사전생성 보이스 — id/rate 는 파일명 sha1 의 일부다. 바꾸면 기존 파일이 전부 미스가 된다.
// (Kokoro: scripts/pregen_kokoro_tts.py · Edge: ingest/store.py TTS_VOICE/TTS_RATE)
export const KOKORO = { voice: 'kokoro-af_heart', rate: '+0%' };
export const EDGE   = { voice: 'en-US-JennyNeural', rate: '-5%' };

export const VOICES = [
  { id: KOKORO.voice,          label: 'Kokoro',  sub: 'F · natural (af_heart)' },
  { id: 'en-US-JennyNeural',   label: 'Jenny',   sub: 'F · warm (Shana-like)' },
  { id: 'en-US-AriaNeural',    label: 'Aria',    sub: 'F · standard news' },
  { id: 'en-US-EmmaNeural',    label: 'Emma',    sub: 'F · casual' },
  { id: 'en-US-GuyNeural',     label: 'Guy',     sub: 'M · standard' },
  { id: 'en-US-DavisNeural',   label: 'Davis',   sub: 'M · casual' },
  { id: 'en-US-AndrewNeural',  label: 'Andrew',  sub: 'M · calm' },
];
const DEFAULT_VOICE = KOKORO.voice;
const DEFAULT_RATE  = KOKORO.rate;

export function getVoice() { return localStorage.getItem(VOICE_KEY) || DEFAULT_VOICE; }
export function setVoice(v) { if (VOICES.some((x) => x.id === v)) localStorage.setItem(VOICE_KEY, v); }
export function getRate()  { return localStorage.getItem(RATE_KEY)  || DEFAULT_RATE; }
export function setRate(r) { if (/^[+-]\d{1,3}%$/.test(r)) localStorage.setItem(RATE_KEY, r); }

// 시도 순서. opts.voice 를 명시하면 그것만(호출자가 특정 보이스를 원한 것이므로).
function voiceChain(opts) {
  if (opts.voice) return [{ voice: opts.voice, rate: opts.rate || getRate() }];
  const stored = localStorage.getItem(VOICE_KEY);
  if (stored && stored !== KOKORO.voice) return [{ voice: stored, rate: getRate() }];
  return [KOKORO, EDGE];
}

let _audio = null;
function getAudio() {
  if (!_audio) { _audio = new Audio(); _audio.preload = 'auto'; }
  return _audio;
}

let _gen = 0;

function hardStop(audio) {
  try { audio.pause(); } catch (e) {}
  try { audio.removeAttribute('src'); audio.load(); } catch (e) {}
}

function killBrowserTTS() {
  if (!('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    speechSynthesis.pause();
    speechSynthesis.resume();
    speechSynthesis.cancel();
  } catch (e) {}
}

function browserFallback(text, playbackRate) {
  if (!('speechSynthesis' in window) || !text) return;
  killBrowserTTS();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US'; u.rate = 0.9 * (playbackRate || 1);
  speechSynthesis.speak(u);
}

// ingest/store.py::tts_key 와 동일한 sha1 키.
async function sha1Hex(s) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Storage 의 미리 생성된 mp3 public URL.
export async function ttsUrl(text, voice = getVoice(), rate = getRate()) {
  const clean = String(text).trim();
  const key = await sha1Hex(`${voice}|${rate}|${clean}`);
  return `${STORAGE_URL}/tts/${key}.mp3`;
}

export async function speak(text, opts = {}) {
  if (!text) return;
  const myGen = ++_gen;

  killBrowserTTS();
  const audio = getAudio();
  hardStop(audio);

  for (const cand of voiceChain(opts)) {
    let url;
    try {
      url = await ttsUrl(text, cand.voice, cand.rate);
    } catch (e) {
      // crypto.subtle 부재(비보안 컨텍스트: http LAN 직접접속 등) → 키 계산 불가.
      // 던지지 말고(이전엔 여기서 throw 돼 폴백 자체가 안 됨) 브라우저 TTS 로 강등.
      break;
    }
    if (myGen !== _gen) return;
    audio.src = url;
    audio.playbackRate = opts.playbackRate || 1;  // 받아쓰기 "천천히" 등 슬로우 재생

    try {
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.then === 'function') {
        await playPromise;
      }
      if (myGen !== _gen) hardStop(audio);
      return;                                     // 재생 시작 — 체인 종료
    } catch (e) {
      if (myGen !== _gen) return;
      // Storage 에 없거나(404) 재생 실패 → 체인의 다음 보이스로, 없으면 브라우저 TTS
      hardStop(audio);
    }
  }
  if (myGen !== _gen) return;
  console.warn('tts: no pre-generated file for this text, falling back to browser TTS');
  browserFallback(text, opts.playbackRate);
}

export function prefetch(texts, voice = getVoice(), rate = getRate()) {
  if (!Array.isArray(texts)) return;
  texts.slice(0, 30).forEach(async (t) => {
    if (!t) return;
    try {
      const url = await ttsUrl(t, voice, rate);
      fetch(url, { method: 'GET', cache: 'force-cache' }).catch(() => {});
    } catch (e) { /* ignore */ }
  });
}
