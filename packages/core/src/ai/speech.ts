import type { TargetLanguage } from '../types.js';
import { GEMINI_ENDPOINT, RemoteInferenceError } from './remote.js';

/**
 * Read-aloud audio from Gemini's text-to-speech models.
 *
 * Shared sentence decks ship without audio, and the voices built into macOS
 * cover Bosnian only through a compact Croatian voice. Gemini's speech models
 * read Bosnian, Croatian and Serbian text with natural prosody, so a card can
 * be heard the way a person would say it.
 *
 * Older speech models return raw 16-bit mono PCM, which is wrapped in a WAV
 * header here. Gemini 3 models return a finished WAV instead, with a C2PA
 * provenance chunk after the audio; that file is passed through untouched,
 * because wrapping it again makes players read its header as a click and its
 * provenance chunk as a burst of static. Either way every caller (browser
 * `Audio`, Electron, a file on disk) gets a WAV it can play as is. Callers
 * cache the bytes: the same sentence never needs generating twice.
 */

/** Gemini's text-to-speech model. Override with GEMINI_SPEECH_MODEL. */
export const DEFAULT_SPEECH_MODEL = 'gemini-3.8-flash-tts';

/**
 * A few of Gemini's prebuilt voices, chosen for clear, even delivery. The
 * first is the default.
 */
export const SPEECH_VOICES = ['Aoede', 'Leda', 'Kore', 'Puck', 'Charon'] as const;
export type SpeechVoice = (typeof SPEECH_VOICES)[number];
/** Picked by ear against the other prebuilt voices on Bosnian sentences. */
export const DEFAULT_SPEECH_VOICE: SpeechVoice = 'Aoede';

/** Sentences longer than this are not cards; refuse rather than bill for them. */
export const MAX_SPEECH_CHARACTERS = 600;

/**
 * The language each card is read in, as `speechConfig.languageCode`.
 *
 * The language goes here rather than into the text: Gemini speech models have
 * no system instruction, and direction written into the text ("read this
 * slowly: ...", or a director's-notes header) is sometimes spoken aloud with
 * the card, most often when the card is a single word.
 */
const SPEECH_LANGUAGE_CODES: Record<TargetLanguage, string> = {
  bs: 'bs-BA',
  es: 'es-ES',
};

export interface SpeechOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface SpeechClip {
  /** A complete WAV file. */
  audio: Uint8Array;
  mimeType: 'audio/wav';
  model: string;
  voice: string;
}

export function isSpeechVoice(value: unknown): value is SpeechVoice {
  return typeof value === 'string' && (SPEECH_VOICES as readonly string[]).includes(value);
}

/** Only text-to-speech model names may be asked for. */
export function isSpeechModel(value: unknown): value is string {
  return typeof value === 'string' && /^gemini-[\w.-]+-tts$/.test(value);
}

/**
 * The longest a clip of `text` can plausibly be. Anything longer is the model
 * saying more than the card (reading direction aloud, or adding words of its
 * own), and is refused rather than cached and replayed forever.
 */
export function maxSpeechSeconds(text: string): number {
  return 2.5 + 0.18 * text.trim().length;
}

/** How long a WAV file plays, from its `data` chunk. */
export function wavSeconds(wav: Uint8Array): number {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let offset = 12;
  let byteRate = 48_000;
  while (offset + 8 <= wav.byteLength) {
    const id = String.fromCharCode(...wav.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && offset + 20 <= wav.byteLength) byteRate = view.getUint32(offset + 16, true) || byteRate;
    if (id === 'data') return size / byteRate;
    offset += 8 + size + (size & 1);
  }
  return 0;
}

/**
 * Gemini refused for quota. `daily` is the per-day request cap (100 a day on
 * the first paid tier), which no amount of slowing down gets past; the caller
 * should wait `retryAfterMs`.
 */
export class SpeechQuotaError extends RemoteInferenceError {
  constructor(
    message: string,
    readonly daily: boolean,
    readonly retryAfterMs: number,
  ) {
    super(message, 429, true);
    this.name = 'SpeechQuotaError';
  }
}

/**
 * A stable cache key for one clip. The version is bumped whenever clips made
 * before a fix would still be wrong, so caches on disk never replay them.
 */
const SPEECH_CACHE_VERSION = 'v2';
export function speechCacheKey(text: string, language: TargetLanguage, voice: string, model: string): string {
  return [SPEECH_CACHE_VERSION, model, voice, language, text.trim()].join('\u001f');
}

/**
 * The cache key of a recording that came with a deck. It names no voice or
 * model, so it outlives a change of either, and it is looked up before the
 * generated clip: a person reading the sentence beats any synthetic voice.
 */
export function recordedSpeechKey(text: string, language: TargetLanguage): string {
  return speechCacheKey(text, language, 'recorded', 'deck');
}

/** The media type of a clip, from its first bytes: WAV, MP3 or Ogg. */
export function audioMimeType(bytes: Uint8Array): string {
  if (isWav(bytes)) return 'audio/wav';
  const head = String.fromCharCode(...bytes.subarray(0, 4));
  if (head.startsWith('ID3') || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (head === 'OggS') return 'audio/ogg';
  if (head === 'fLaC') return 'audio/flac';
  if (String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') return 'audio/mp4';
  return 'application/octet-stream';
}

export async function synthesizeSpeech(
  options: SpeechOptions,
  text: string,
  language: TargetLanguage,
): Promise<SpeechClip> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) throw new RemoteInferenceError('Add a Gemini API key in Settings to hear cards read aloud.', 401);
  const trimmed = text.trim();
  if (!trimmed) throw new RemoteInferenceError('There is nothing to read aloud.', 400);
  if (trimmed.length > MAX_SPEECH_CHARACTERS) {
    throw new RemoteInferenceError('That text is too long to read aloud.', 400);
  }

  const model = isSpeechModel(options.model) ? options.model : DEFAULT_SPEECH_MODEL;
  const voice = isSpeechVoice(options.voice) ? options.voice : DEFAULT_SPEECH_VOICE;

  const response = await (options.fetchImpl ?? globalThis.fetch)(
    `${options.endpoint ?? GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: trimmed }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            languageCode: SPEECH_LANGUAGE_CODES[language],
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
          },
        },
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    },
  );

  if (!response.ok) {
    let detail = '';
    let retryDelay: string | undefined;
    try {
      const failure = (await response.json()) as {
        error?: { message?: string; details?: { retryDelay?: string }[] };
      };
      detail = failure.error?.message ?? '';
      retryDelay = failure.error?.details?.find((entry) => entry.retryDelay)?.retryDelay;
    } catch {
      // Status alone will have to do.
    }
    if (response.status === 429) {
      const daily = /per_?day|PerDay|requests per day/i.test(detail);
      const retryAfterMs = parseRetryDelay(retryDelay, detail) ?? (daily ? 60 * 60_000 : 15_000);
      throw new SpeechQuotaError(
        daily
          ? 'Gemini\'s daily read-aloud limit for this API key is used up.'
          : 'Gemini is rate-limiting read-aloud right now. Try again in a moment.',
        daily,
        retryAfterMs,
      );
    }
    const message = response.status === 404
      ? `No speech model called "${model}".`
      : response.status === 401 || response.status === 403
        ? 'That API key was refused. Check it in Settings.'
        : response.status === 429
          ? 'Gemini is rate-limiting read-aloud right now. Try again in a moment.'
          : 'Gemini could not read that aloud.';
    throw new RemoteInferenceError(detail ? `${message} ${detail}` : message, response.status);
  }

  const body = (await response.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
  };
  const inline = body.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;
  if (!inline?.data) throw new RemoteInferenceError('Gemini returned no audio.', 502);

  const bytes = base64ToBytes(inline.data);
  const sampleRate = Number(/rate=(\d+)/.exec(inline.mimeType ?? '')?.[1] ?? 24_000);
  const audio = isWav(bytes) ? bytes : pcmToWav(bytes, sampleRate);
  if (wavSeconds(audio) > maxSpeechSeconds(trimmed)) {
    throw new RemoteInferenceError('Gemini said more than the card, so the clip was not kept.', 422);
  }
  return { audio, mimeType: 'audio/wav', model, voice };
}

/** True for a RIFF/WAVE file, as opposed to bare PCM samples. */
export function isWav(bytes: Uint8Array): boolean {
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  return bytes.byteLength >= 12 && tag(0) === 'RIFF' && tag(8) === 'WAVE';
}

/** Wrap 16-bit little-endian mono PCM in a WAV header. */
export function pcmToWav(pcm: Uint8Array, sampleRate = 24_000): Uint8Array {
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}

/** "47589s" from RetryInfo, or "13h14m9.38s" from the message text, in ms. */
function parseRetryDelay(retryDelay: string | undefined, message: string): number | undefined {
  const seconds = retryDelay ? Number.parseFloat(retryDelay) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  const match = /retry in\s+(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(message);
  if (!match || !(match[1] || match[2] || match[3])) return undefined;
  const total = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return total > 0 ? Math.ceil(total * 1000) : undefined;
}

/** `atob` exists in every runtime this runs in: Node 16+, Electron, browsers. */
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
