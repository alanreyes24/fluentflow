import type {
  GenerateExamplesResult,
  ResolvedMeaning,
  TargetLanguage,
} from '@fluentflow/core';
import { webAiAvailable, lookupSourcesOnWeb, resolveMeaningsOnWeb } from './web';

/**
 * The desktop shell's lookup bridge, as the app sees it.
 *
 * Two things cross it: meanings for a pasted word list, and example sentences
 * for a card reveal. On the web it is simply absent, and every caller has to
 * handle that — the same bundle runs in a browser tab, in Electron, and
 * (through react-native-web) in the render tests. The `*Available` functions
 * are the only way to ask.
 *
 * Nothing here looks anything up or generates anything. The dictionary is a
 * SQLite file in the Electron main process and the hosted model is called from
 * there with a key this bundle never sees — see apps/desktop/ai.js. This is the
 * typed edge of the `contextBridge` surface declared in apps/desktop/preload.js.
 */

export interface DictionaryStatus {
  available: boolean;
  reason?: string;
  dir?: string;
  /** Which of the target languages have a dictionary installed. */
  languages?: Partial<Record<TargetLanguage, boolean>>;
  /** The Wiktionary language each file was built from, for attribution. */
  source?: Partial<Record<TargetLanguage, string>>;
}

/**
 * The hosted model, as the settings screen sees it.
 *
 * Note what is missing: the key. It is stored in the OS keychain by the main
 * process and used there, and the bridge has no getter for it — this bundle
 * renders user-supplied deck content and holding a credential would be a
 * liability with no upside. `configured` is all the UI needs to know.
 */
export interface CloudModelStatus {
  available: boolean;
  /** Whether an API key is stored. */
  configured: boolean;
  /** Why it is unavailable, written for a person. */
  reason?: string;
  /** The model id being called, e.g. `gemini-2.5-flash-lite`. */
  model?: string;
  provider?: string;
  /** False when the OS offered no keychain and the key is stored as text. */
  encrypted?: boolean;
  /** Where to get a key, so the settings screen can say. */
  keyUrl?: string;
}

/** Both sources, separately: either can be present without the other. */
export interface LookupSources {
  dictionary: DictionaryStatus;
  /** Absent on a shell built before the hosted path existed. */
  cloud?: CloudModelStatus;
}

/** What the settings screen sends when the user saves a key or a model name. */
export interface CloudSettingsInput {
  /** The API key. An empty string removes it. */
  apiKey?: string;
  /** The model id. An empty string restores the default. */
  model?: string;
}

/** How much of a lookup to run. */
export interface LookupOptions {
  /**
   * Send the words the dictionary misses to the hosted model. Defaults to true.
   *
   * The import screen passes false for its first pass, so that the dictionary —
   * which is free, offline and covers most word lists outright — answers before
   * anything can be billed, and reaching the model is always a second, named
   * press rather than a side effect of asking for meanings at all.
   */
  useModel?: boolean;
}

export interface TranslationProgress {
  done: number;
  total: number;
}

/** What a card reveal asks the shell for. */
export interface ExampleRequest {
  word: string;
  /** The card back, used to disambiguate a word with several senses. */
  meaning?: string;
  language: TargetLanguage;
  count?: number;
}

interface DesktopBridge {
  platform: string;
  ai?: {
    status(): Promise<LookupSources>;
    resolve(
      words: string[],
      language: TargetLanguage,
      /** Optional: a shell built before the free pass existed ignores it. */
      options?: LookupOptions,
    ): Promise<{ ok: true; meanings: ResolvedMeaning[] } | { ok: false; error: string }>;
    /** Optional: a shell built before example generation existed has no such key. */
    examples?(
      request: ExampleRequest,
      requestId?: string,
    ): Promise<{ ok: true; result: GenerateExamplesResult } | { ok: false; error: string }>;
    /** Optional: older still than `examples`, and only an optimisation. */
    cancelExamples?(requestId: string): void;
    /** Optional: absent on a shell built before the hosted path existed. */
    setCloud?(
      settings: CloudSettingsInput,
    ): Promise<{ ok: true; status: CloudModelStatus } | { ok: false; error: string }>;
    clearCloud?(): Promise<{ ok: true; status: CloudModelStatus } | { ok: false; error: string }>;
    onProgress(listener: (progress: TranslationProgress) => void): () => void;
  };
}

function bridge(): DesktopBridge['ai'] | null {
  if (typeof globalThis === 'undefined') return null;
  const desktop = (globalThis as { fluentflowDesktop?: DesktopBridge }).fluentflowDesktop;
  return desktop?.ai ?? null;
}

/** Is there a desktop shell here at all? Says nothing about what it has installed. */
export function lookupBridgeAvailable(): boolean {
  return bridge() !== null;
}

/**
 * Can this shell write example sentences?
 *
 * Separate from {@link lookupBridgeAvailable} because it is a separate question
 * in time, not just in kind: an older shell exposes `resolve` but not
 * `examples`, and a renderer served by one must not call a function that is not
 * there. It says nothing about whether a model is installed — that is
 * {@link lookupSources}, and a shell with no model still answers, with carrier
 * sentences the UI labels as offline.
 */
export function exampleBridgeAvailable(): boolean {
  return typeof bridge()?.examples === 'function';
}

const NO_SHELL = 'Looking words up needs the desktop app.';

export async function lookupSources(): Promise<LookupSources> {
  const ai = bridge();
  if (!ai) return webAiAvailable()
    ? lookupSourcesOnWeb()
    : { dictionary: { available: false, reason: NO_SHELL } };

  try {
    return await ai.status();
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    return { dictionary: { available: false, reason } };
  }
}

/** Can this shell be pointed at a hosted model? Says nothing about whether it is. */
export function cloudBridgeAvailable(): boolean {
  return typeof bridge()?.setCloud === 'function';
}

/**
 * Store the user's API key, or change which model is called.
 *
 * The key travels one way: into the main process, which puts it in the OS
 * keychain. Nothing reads it back out to this side, so a settings screen that
 * has just saved a key shows "configured", not the key.
 *
 * @throws with a message worth showing when the shell could not save it
 */
export async function saveCloudSettings(
  settings: CloudSettingsInput,
): Promise<CloudModelStatus> {
  const ai = bridge();
  if (!ai?.setCloud) throw new Error(NO_SHELL);
  const result = await ai.setCloud(settings);
  if (!result.ok) throw new Error(result.error);
  return result.status;
}

/** Forget the key and the model choice. */
export async function clearCloudSettings(): Promise<CloudModelStatus> {
  const ai = bridge();
  if (!ai?.clearCloud) throw new Error(NO_SHELL);
  const result = await ai.clearCloud();
  if (!result.ok) throw new Error(result.error);
  return result.status;
}

/**
 * Find meanings for a list of words: dictionary first, model for the rest.
 *
 * Pass `{ useModel: false }` to stop at the dictionary. See {@link LookupOptions}.
 *
 * @throws with a message worth showing when the shell reports a failure
 */
export async function lookUpMeanings(
  words: string[],
  language: TargetLanguage,
  onProgress?: (progress: TranslationProgress) => void,
  options?: LookupOptions,
): Promise<ResolvedMeaning[]> {
  const ai = bridge();
  if (!ai) {
    if (webAiAvailable()) return resolveMeaningsOnWeb(words, language, options);
    throw new Error(NO_SHELL);
  }

  const unsubscribe = onProgress ? ai.onProgress(onProgress) : null;
  try {
    const result = await ai.resolve(words, language, options);
    if (!result.ok) throw new Error(result.error);
    return result.meanings;
  } finally {
    unsubscribe?.();
  }
}

let requestCounter = 0;

/**
 * Write example sentences for one card, in the desktop shell's main process.
 *
 * The whole pipeline runs on the other side of the bridge — prompt, decode,
 * parse, validate — and one result comes back. That is the point: decoding is a
 * loop of tens of forward passes, and running it here would mean one IPC round
 * trip per token through a `contextBridge` that copies every message.
 *
 * `signal` cancels a generation the caller has stopped wanting — a speculative
 * run for a card the user has moved past. An AbortSignal is not
 * structured-cloneable and cannot cross `contextBridge`, so the request carries
 * an id and cancelling is a second, one-way message quoting it. The call still
 * settles afterwards; the caller checks its own signal and throws the answer
 * away. A shell too old to have `cancelExamples` simply finishes the work.
 *
 * @throws if the shell has no example bridge, or reported a failure
 */
export async function generateExamplesOnDesktop(
  request: ExampleRequest,
  signal?: AbortSignal,
): Promise<GenerateExamplesResult> {
  const ai = bridge();
  if (!ai?.examples) throw new Error(NO_SHELL);

  const requestId = `${Date.now()}-${(requestCounter += 1)}`;
  const cancel = () => ai.cancelExamples?.(requestId);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });

  try {
    const response = await ai.examples(request, requestId);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
