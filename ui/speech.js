// Episode word pronunciation uses the device voice; no generated files or network.
export function speak(text) {
  if (!text || !('speechSynthesis' in window)) return;
  const speech = window.speechSynthesis;
  speech.cancel();
  speech.resume();
  const utterance = new SpeechSynthesisUtterance(String(text));
  utterance.lang = 'en-US';
  utterance.rate = 0.9;
  speech.speak(utterance);
}
