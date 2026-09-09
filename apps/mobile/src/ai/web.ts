import { Platform } from 'react-native';
import type {
  GenerateExamplesResult,
  TargetLanguage,
} from '@fluentflow/core';
import type { LookupOptions, LookupSources, MeaningLookupResult } from './desktop';
import { appConfig } from '../firebase/config';
import { authApi } from '../firebase/client';

/** Browser client for the localhost AI proxy. The Gemini key never enters this bundle. */

export function webAiAvailable(): boolean {
  return Platform.OS === 'web' && appConfig.apiBaseUrl !== null;
}

export async function lookupSourcesOnWeb(): Promise<LookupSources> {
  const body = await request('/api/ai/status', { method: 'GET' });
  return {
    dictionary: body.dictionary ?? {
      available: false,
      reason: 'The localhost dictionary is not available.',
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
      modelOnly: options?.modelOnly === true,
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
  if (!webAiAvailable() || !base) throw new Error('The localhost AI server is not configured.');

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
    throw new Error(body?.message ?? `The localhost AI server failed (HTTP ${response.status}).`);
  }
  return body;
}

export async function chatOnWeb(messages: import('@fluentflow/core').ChatMessage[]): Promise<string> {
  const result = await request('/api/ai/chat', {
    method: 'POST', body: JSON.stringify({ messages }),
  });
  return result.text;
}
