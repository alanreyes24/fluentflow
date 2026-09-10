import { Platform } from 'react-native';
import type { TargetLanguage } from '@fluentflow/core';

/** Speak through the host's system voice, with no network request or audio asset. */
export function pronunciationAvailable(): boolean {
  return Platform.OS === 'web' && typeof globalThis.speechSynthesis !== 'undefined';
}

export function pronounce(word: string, language: TargetLanguage): boolean {
  if (!pronunciationAvailable() || typeof globalThis.SpeechSynthesisUtterance === 'undefined') return false;
  const text = word.trim();
  if (!text) return false;

  globalThis.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = language === 'es' ? 'es-ES' : 'bs-BA';
  utterance.rate = 0.86;
  globalThis.speechSynthesis.speak(utterance);
  return true;
}

export function stopPronunciation(): void {
  if (pronunciationAvailable()) globalThis.speechSynthesis.cancel();
}
