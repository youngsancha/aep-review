// English TTS — 인제스트 때 미리 생성해 Supabase Storage 에 올린 Edge Neural mp3 재생.
// 파일이 없으면(기본 보이스 외/임의 텍스트) 브라우저 speechSynthesis 로 폴백.
import { STORAGE_URL } from '/supabase.js';

const VOICE_KEY = 'aep-tts-voice-v1';
const RATE_KEY  = 'aep-tts-rate-v1';

export const VOICES = [
  { id: 'en-US-JennyNeural',   label: 'Jenny',   sub: 'F · warm (Shana-like)' },
  { id: 'en-US-AriaNeural',    label: 'Aria',    sub: 'F · standard news' },
  { id: 'en-US-EmmaNeural',    label: 'Emma',    sub: 'F · casual' },
  { id: 'en-US-GuyNeural',     label: 'Guy',     sub: 'M · standard' },
  { id: 'en-US-DavisNeural',   label: 'Davis',   sub: 'M · casual' },
  { id: 'en-US-AndrewNeural',  label: 'Andrew',  sub: 'M · calm' },
];
// 인제스트가 미리 생성하는 기본 보이스/속도 (ingest/store.py 와 일치해야 함)
const DEFAULT_VOICE = VOICES[0].id;
const DEFAULT_RATE  = '-5%';

export function getVoice() { return localStorage.getItem(VOICE_KEY) || DEFAULT_VOICE; }
export function setVoice(v) { if (VOICES.some((x) => x.id === v)) localStorage.setItem(VOICE_KEY, v); }
export function getRate()  { return localStorage.getItem(RATE_KEY)  || DEFAULT_RATE; }
export function setRate(r) { if (/^[+-]\d{1,3}%$/.test(r)) localStorage.setItem(RATE_KEY, r); }

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

  const voice = opts.voice || getVoice();
  const rate  = opts.rate  || getRate();
  const url = await ttsUrl(text, voice, rate);
  if (myGen !== _gen) return;
  audio.src = url;
  audio.playbackRate = opts.playbackRate || 1;  // 받아쓰기 "천천히" 등 슬로우 재생

  try {
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.then === 'function') {
      await playPromise;
    }
    if (myGen !== _gen) hardStop(audio);
  } catch (e) {
    if (myGen !== _gen) return;
    // Storage 에 없거나(404) 재생 실패 → 브라우저 TTS 폴백
    console.warn('tts play failed, fallback to browser TTS', e);
    browserFallback(text, opts.playbackRate);
  }
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
