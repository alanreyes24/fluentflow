import { cloudBridgeAvailable, exampleBridgeAvailable, lookupSources } from './desktop';

/**
 * Whether the app can write real example sentences right now, and if not, why.
 *
 * The settings screen shows this because "why are my examples generic?" is the
 * question this app will be asked most, and the answer is nearly always one
 * specific, fixable thing — no desktop shell, or no API key.
 *
 * Generation happens in the Electron main process (see apps/desktop/ai.js),
 * because that is where the API key lives and this bundle must never hold it.
 * The renderer — the same bundle a browser tab runs — reaches it through the
 * desktop bridge. In a plain browser tab there is no bridge, and every reveal
 * falls back to written carrier sentences.
 */

export interface ModelStatus {
  available: boolean;
  /** Why generation is unavailable, for the settings screen. */
  reason?: string;
  /** The model being called, e.g. `gemini-3.1-flash-lite`. */
  name?: string;
  /** Whether an API key is stored. */
  configured?: boolean;
  /** Where to get a key, when there is none. */
  keyUrl?: string;
}

const NO_SHELL = 'Example generation runs in the FluentFlow desktop app.';
const NO_BRIDGE = 'This version of the desktop app cannot reach a model.';

export async function modelStatus(): Promise<ModelStatus> {
  if (!exampleBridgeAvailable()) return { available: false, reason: NO_SHELL };
  if (!cloudBridgeAvailable()) return { available: false, reason: NO_BRIDGE };

  const { cloud } = await lookupSources();
  return {
    available: cloud?.available === true,
    configured: cloud?.configured === true,
    reason: cloud?.reason,
    name: cloud?.model,
    keyUrl: cloud?.keyUrl,
  };
}
