import { useMemo, useSyncExternalStore } from 'react';
import { DEFAULT_SPEECH_VOICE, isSpeechVoice, type SpeechVoice, type TargetLanguage } from '@fluentflow/core';
import { fetchSpeech, naturalSpeechReachable } from './ai/desktop';

/**
 * Read-aloud for study cards.
 *
 * Shared Anki sentence decks usually carry no audio, so cards are spoken one
 * of two ways:
 *
 *  - **natural**: Gemini's speech model, through the desktop shell (which
 *    caches every clip on disk) or the AI server. It sounds like a person.
 *  - **system**: the device's own speech synthesiser (the browser's
 *    `speechSynthesis`, which Electron backs with the macOS and Windows
 *    voices). Offline and free, and the fallback whenever a natural clip
 *    cannot be had.
 *
 * Bosnian system voices are rare: macOS and Windows ship Croatian ones (macOS's
 * "Lana"), and Bosnian, Croatian and Serbian are pronounced almost alike, so
 * the fallback reads Bosnian text with Bosnian sounds. Serbian comes last
 * because some of its voices expect Cyrillic.
 *
 * The native build has neither `Audio` nor `speechSynthesis`; there every call
 * here is a no-op and the speaker button is not drawn.
 */

export type SpeechEngine = 'natural' | 'system';

const VOICE_LANGUAGES: Record<TargetLanguage, string[]> = {
  bs: ['bs', 'hr', 'sr', 'sh'],
  es: ['es'],
};

/** Slightly under normal speed: these are learners listening for each word. */
const SPEAKING_RATE = 0.9;

const AUTO_READ_KEY = 'fluentflow.autoRead';
const ENGINE_KEY = 'fluentflow.speechEngine';
const NATURAL_VOICE_KEY = 'fluentflow.speechVoice';
const AUDIO_OFF_DECKS_KEY = 'fluentflow.audioOffDecks';
/** Object URLs kept for replay and prefetch; older ones are released. */
const CLIP_LIMIT = 200;

function synth(): SpeechSynthesis | null {
  const value = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  return value && typeof value.speak === 'function' ? value : null;
}

function systemSpeechSupported(): boolean {
  return synth() !== null && typeof globalThis.SpeechSynthesisUtterance === 'function';
}

function audioSupported(): boolean {
  return typeof globalThis.Audio === 'function' && typeof URL.createObjectURL === 'function';
}

export function speechSupported(): boolean {
  return systemSpeechSupported() || naturalSpeechAvailable();
}

/** Whether natural (Gemini) read-aloud is chosen and reachable from here. */
export function naturalSpeechAvailable(): boolean {
  return audioSupported() && naturalSpeechReachable() && speechEngine() === 'natural';
}

/** The best installed voice for a deck language, or null when there is none. */
export function voiceFor(language: TargetLanguage): SpeechSynthesisVoice | null {
  const voices = synth()?.getVoices() ?? [];
  for (const code of VOICE_LANGUAGES[language]) {
    const matching = voices.filter((voice) => languageOf(voice) === code);
    // A voice installed on the device works offline; a network voice may not.
    const local = matching.find((voice) => voice.localService);
    const chosen = local ?? matching[0];
    if (chosen) return chosen;
  }
  return null;
}

const clips = new Map<string, Promise<string>>();
let playing: HTMLAudioElement | null = null;
/** Bumped by every new request, so a slow clip never talks over a newer one. */
let generation = 0;

function clipUrl(text: string, language: TargetLanguage): Promise<string> {
  const voice = naturalVoice();
  const key = `${voice}\u001f${language}\u001f${text}`;
  let clip = clips.get(key);
  if (!clip) {
    clip = fetchSpeech(text, language, voice).then((audio) =>
      URL.createObjectURL(new Blob([audio as BlobPart], { type: 'audio/wav' })),
    );
    // A failed clip is forgotten so the next attempt asks again.
    clip.catch(() => clips.delete(key));
    clips.set(key, clip);
    if (clips.size > CLIP_LIMIT) {
      const [oldestKey, oldest] = clips.entries().next().value!;
      clips.delete(oldestKey);
      void oldest.then((url) => URL.revokeObjectURL(url), () => undefined);
    }
  }
  return clip;
}

/** Start fetching a card's clip ahead of time, so it plays the moment it is asked for. */
export function prefetchSpeech(text: string, language: TargetLanguage): void {
  const trimmed = text.trim();
  if (!trimmed || !naturalSpeechAvailable()) return;
  void clipUrl(trimmed, language).catch(() => undefined);
}

/**
 * Speak `text`, interrupting anything still being read. A natural clip that
 * cannot be had falls back to the system voice.
 *
 * @returns false when nothing could be spoken.
 */
export function speak(text: string, language: TargetLanguage): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  stopSpeaking();

  if (naturalSpeechAvailable()) {
    const mine = generation;
    clipUrl(trimmed, language)
      .then((url) => {
        if (mine !== generation) return;
        const audio = new Audio(url);
        playing = audio;
        return audio.play();
      })
      .catch((error: unknown) => {
        if (mine !== generation) return;
        console.warn('[fluentflow] natural read-aloud failed, using the system voice:', error);
        speakWithSystemVoice(trimmed, language);
      });
    return true;
  }
  return speakWithSystemVoice(trimmed, language);
}

function speakWithSystemVoice(text: string, language: TargetLanguage): boolean {
  const engine = synth();
  const voice = voiceFor(language);
  if (!engine || !voice) return false;

  engine.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.rate = SPEAKING_RATE;
  engine.speak(utterance);
  return true;
}

export function stopSpeaking(): void {
  generation++;
  playing?.pause();
  playing = null;
  synth()?.cancel();
}

/** Whether a card in this language can be read aloud at all. */
export function useCanSpeak(language: TargetLanguage | undefined): boolean {
  const voice = useSpeechVoice(language);
  return Boolean(language) && (naturalSpeechAvailable() || voice !== null);
}

/**
 * The voice for a language, updated when the browser finishes loading its
 * voice list (Chromium loads it asynchronously, so the first read is often
 * empty).
 */
export function useSpeechVoice(language: TargetLanguage | undefined): SpeechSynthesisVoice | null {
  // Chromium can hand back fresh voice objects on every `getVoices()`, so the
  // store's snapshot is the voice's identity, not the object.
  const key = useSyncExternalStore(
    subscribeToVoices,
    () => (language ? voiceKey(voiceFor(language)) : ''),
    () => '',
  );
  return useMemo(() => (key && language ? voiceFor(language) : null), [key, language]);
}

function subscribeToVoices(onChange: () => void): () => void {
  const engine = synth();
  engine?.addEventListener?.('voiceschanged', onChange);
  return () => engine?.removeEventListener?.('voiceschanged', onChange);
}

function voiceKey(voice: SpeechSynthesisVoice | null): string {
  return voice ? `${voice.voiceURI}\u001f${voice.lang}` : '';
}

/**
 * Whether cards are read aloud as they appear. Kept on this device rather than
 * with the account: which voices exist is a property of the device too.
 */
export function autoReadEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(AUTO_READ_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setAutoReadEnabled(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(AUTO_READ_KEY, enabled ? 'true' : 'false');
  } catch {
    // Storage can be unavailable (private windows); the choice then lasts
    // only as long as the screen holding it.
  }
}

/** Natural voices are the default wherever they can be reached. */
export function speechEngine(): SpeechEngine {
  const stored = readSetting(ENGINE_KEY);
  return stored === 'system' ? 'system' : 'natural';
}

export function setSpeechEngine(engine: SpeechEngine): void {
  writeSetting(ENGINE_KEY, engine);
}

export function naturalVoice(): SpeechVoice {
  const stored = readSetting(NATURAL_VOICE_KEY);
  return isSpeechVoice(stored) ? stored : DEFAULT_SPEECH_VOICE;
}

export function setNaturalVoice(voice: SpeechVoice): void {
  writeSetting(NATURAL_VOICE_KEY, voice);
}

/**
 * Whether Gemini clips are made ahead of time for a deck: by the background
 * run and by the study screen's look-ahead. With it off, the speaker button
 * still works for that deck, one card at a time. Kept on this device, like
 * the other read-aloud choices, because the clips themselves live here.
 */
export function deckAudioEnabled(deckId: string): boolean {
  return !audioOffDecks().has(deckId);
}

export function setDeckAudioEnabled(deckId: string, enabled: boolean): void {
  const off = audioOffDecks();
  if (enabled) off.delete(deckId);
  else off.add(deckId);
  writeSetting(AUDIO_OFF_DECKS_KEY, JSON.stringify([...off]));
}

function audioOffDecks(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readSetting(AUDIO_OFF_DECKS_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function readSetting(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeSetting(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage can be unavailable (private windows); the choice then lasts
    // only as long as the screen holding it.
  }
}

function languageOf(voice: SpeechSynthesisVoice): string {
  return voice.lang.toLowerCase().split(/[-_]/)[0] ?? '';
}

/** A readable name for a voice, e.g. "Lana (hr-HR)". */
export function describeVoice(voice: SpeechSynthesisVoice): string {
  return `${voice.name} (${voice.lang.replace('_', '-')})`;
}
