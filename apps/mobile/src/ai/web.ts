import { Platform } from 'react-native';
import type {
  GenerateExamplesResult,
  TargetLanguage,
} from '@fluentflow/core';
import type { LookupOptions, LookupSources, MeaningLookupResult } from './desktop';
import { appConfig } from '../firebase/config';
import { authApi } from '../firebase/client';

/** Browser client for the server AI proxy (localhost in development, the hosting server in production). The Gemini key never enters this bundle. */

export function webAiAvailable(): boolean {
  return Platform.OS === 'web' && appConfig.apiBaseUrl !== null;
}

export async function lookupSourcesOnWeb(): Promise<LookupSources> {
  const body = await request('/api/ai/status', { method: 'GET' });
  return {
    dictionary: body.dictionary ?? {
      available: false,
      reason: 'The server dictionary is not available.',
    },
    cloud: body.cloud,
  };
}

export async function resolveMeaningsOnWeb(
  words: string[],
  language: TargetLanguage,
  options?: LookupOptions,
): Promise<MeaningLookupResult> {
  const body = await request('/api/ai/resolve', {
    method: 'POST',
    body: JSON.stringify({
      words,
      language,
      useModel: options?.useModel !== false,
    }),
  });
  return { meanings: body.meanings, usage: body.usage };
}

export async function generateExamplesOnWeb(input: {
  word: string;
  meaning?: string;
  language: TargetLanguage;
  count?: number;
}): Promise<GenerateExamplesResult> {
  return request('/api/ai/examples', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

async function request(path: string, init: RequestInit): Promise<any> {
  const base = appConfig.apiBaseUrl;
  if (!webAiAvailable() || !base) throw new Error('The AI server is not configured.');

  const token = (await authApi()?.idToken()) ?? 'local:local-user';
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    throw new Error(body?.message ?? `The AI server failed (HTTP ${response.status}).`);
  }
  return body;
}

/** Read-aloud audio from the server's Gemini proxy, as audio bytes (WAV, or a deck recording). */
export async function speechOnWeb(text: string, language: TargetLanguage, voice?: string): Promise<Uint8Array> {
  const base = appConfig.apiBaseUrl;
  if (!webAiAvailable() || !base) throw new Error('The AI server is not configured.');
  const token = (await authApi()?.idToken()) ?? 'local:local-user';
  const response = await fetch(`${base}/api/ai/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ text, language, voice }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.message ?? `Read-aloud failed (HTTP ${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** A deck recording, named by the hash the desktop shell files it under. */
export interface DeckRecordingUpload {
  id: string;
  /** Base64 audio. */
  audio: string;
}

export async function uploadRecordingsOnWeb(recordings: DeckRecordingUpload[]): Promise<number> {
  const body = await request('/api/speech/recordings', {
    method: 'POST',
    body: JSON.stringify({ recordings }),
  });
  return body.stored;
}

export async function chatOnWeb(messages: import('@fluentflow/core').ChatMessage[]): Promise<string> {
  const result = await request('/api/ai/chat', {
    method: 'POST', body: JSON.stringify({ messages }),
  });
  return result.text;
}
