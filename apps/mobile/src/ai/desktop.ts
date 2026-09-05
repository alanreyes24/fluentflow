import type { ResolvedMeaning, TargetLanguage } from '@fluentflow/core';

/**
 * The desktop shell's translation bridge, as the app sees it.
 *
 * On the web this is simply absent, and every caller has to handle that: the
 * same bundle runs in a browser tab, in Electron, and (through
 * react-native-web) in the render tests. `available()` is the only way to ask.
 *
 * Nothing here looks anything up. The dictionary and the model both live in
 * the Electron main process — see apps/desktop/ai.js for why — and this is the
 * typed edge of the `contextBridge` surface declared in
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

interface DesktopBridge {
  platform: string;
  ai?: {
    status(): Promise<LookupSources>;
    resolve(
      words: string[],
      language: TargetLanguage,
    ): Promise<{ ok: true; meanings: ResolvedMeaning[] } | { ok: false; error: string }>;
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
