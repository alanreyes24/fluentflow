import type {
  GenerateExamplesResult,
  ResolvedMeaning,
  TargetLanguage,
} from '@fluentflow/core';

/**
 * The desktop shell's model bridge, as the app sees it.
 *
 * Two things cross it: meanings for a pasted word list, and example sentences
 * for a card reveal. On the web it is simply absent, and every caller has to
 * handle that — the same bundle runs in a browser tab, in Electron, and
 * (through react-native-web) in the render tests. The `*Available` functions
 * are the only way to ask.
 *
 * Nothing here looks anything up or generates anything. The dictionary and the
 * model both live in the Electron main process — see apps/desktop/ai.js for
 * why — and this is the typed edge of the `contextBridge` surface declared in
 * apps/desktop/preload.js.
 */

export interface LocalModelStatus {
  available: boolean;
  /** Why it is unavailable, written for a person. */
  reason?: string;
  /** The model's own name, e.g. `Qwen/Qwen2.5-1.5B-Instruct`. */
  name?: string;
  dir?: string;
}

export interface DictionaryStatus {
  available: boolean;
  reason?: string;
  dir?: string;
  /** Which of the target languages have a dictionary installed. */
  languages?: Partial<Record<TargetLanguage, boolean>>;
  /** The Wiktionary language each file was built from, for attribution. */
  source?: Partial<Record<TargetLanguage, string>>;
}

/** Both sources, separately: either can be installed without the other. */
export interface LookupSources {
  dictionary: DictionaryStatus;
  model: LocalModelStatus;
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
    ): Promise<{ ok: true; meanings: ResolvedMeaning[] } | { ok: false; error: string }>;
    /** Optional: a shell built before example generation existed has no such key. */
    examples?(
      request: ExampleRequest,
    ): Promise<{ ok: true; result: GenerateExamplesResult } | { ok: false; error: string }>;
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
  if (!ai) {
    return {
      dictionary: { available: false, reason: NO_SHELL },
      model: { available: false, reason: NO_SHELL },
    };
  }

  try {
    return await ai.status();
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    return { dictionary: { available: false, reason }, model: { available: false, reason } };
  }
}

/**
 * Find meanings for a list of words: dictionary first, model for the rest.
 *
 * @throws with a message worth showing when the shell reports a failure
 */
export async function lookUpMeanings(
  words: string[],
  language: TargetLanguage,
  onProgress?: (progress: TranslationProgress) => void,
): Promise<ResolvedMeaning[]> {
  const ai = bridge();
  if (!ai) throw new Error(NO_SHELL);

  const unsubscribe = onProgress ? ai.onProgress(onProgress) : null;
  try {
    const result = await ai.resolve(words, language);
    if (!result.ok) throw new Error(result.error);
    return result.meanings;
  } finally {
    unsubscribe?.();
  }
}

/**
 * Write example sentences for one card, in the desktop shell's main process.
 *
 * The whole pipeline runs on the other side of the bridge — prompt, decode,
 * parse, validate — and one result comes back. That is the point: decoding is a
 * loop of tens of forward passes, and running it here would mean one IPC round
 * trip per token through a `contextBridge` that copies every message.
 *
 * @throws if the shell has no example bridge, or reported a failure
 */
export async function generateExamplesOnDesktop(
  request: ExampleRequest,
): Promise<GenerateExamplesResult> {
  const ai = bridge();
  if (!ai?.examples) throw new Error(NO_SHELL);

  const response = await ai.examples(request);
  if (!response.ok) throw new Error(response.error);
  return response.result;
}
