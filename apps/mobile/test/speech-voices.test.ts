import { voiceFor, voiceScore } from '../src/speech';

/**
 * Which system voice reads a card when Gemini cannot.
 *
 * macOS lists its robotic novelty voices ("Eddy", "Flo", ...) first, so a
 * plain first match read Spanish cards in a far worse voice than the
 * "Mónica" installed beside them. The list below is a real Mac's.
 */

const MAC_VOICES = [
  ['Eddy (Spanish (Spain))', 'es-ES'],
  ['Eddy (Spanish (Mexico))', 'es-MX'],
  ['Flo (Spanish (Spain))', 'es-ES'],
  ['Grandma (Spanish (Mexico))', 'es-MX'],
  ['Lana', 'hr-HR'],
  ['Mónica', 'es-ES'],
  ['Paulina', 'es-MX'],
  ['Reed (Spanish (Spain))', 'es-ES'],
  ['Shelley (Spanish (Mexico))', 'es-MX'],
].map(([name, lang]) => ({ name, lang, localService: true, default: false, voiceURI: name }) as SpeechSynthesisVoice);

function installVoices(voices: SpeechSynthesisVoice[]) {
  (globalThis as { speechSynthesis?: unknown }).speechSynthesis = {
    getVoices: () => voices,
    speak: () => undefined,
    cancel: () => undefined,
  };
}

afterEach(() => {
  delete (globalThis as { speechSynthesis?: unknown }).speechSynthesis;
});

describe('system voice choice', () => {
  it('reads Spanish with a real voice, not a novelty one, preferring Spain', () => {
    installVoices(MAC_VOICES);
    expect(voiceFor('es')?.name).toBe('Mónica');
  });

  it('falls back to Mexico, then to a novelty voice only when nothing else is installed', () => {
    installVoices(MAC_VOICES.filter((voice) => voice.name !== 'Mónica'));
    expect(voiceFor('es')?.name).toBe('Paulina');
    installVoices(MAC_VOICES.filter((voice) => voice.name.startsWith('Eddy')));
    expect(voiceFor('es')?.name).toBe('Eddy (Spanish (Spain))');
  });

  it('reads Bosnian with the Croatian voice', () => {
    installVoices(MAC_VOICES);
    expect(voiceFor('bs')?.name).toBe('Lana');
  });

  it('prefers a downloaded Premium or Enhanced voice over a standard one', () => {
    const voice = (name: string) => ({ name, lang: 'es-ES', localService: true });
    expect(voiceScore(voice('Mónica (Premium)'), 'es')).toBeGreaterThan(voiceScore(voice('Mónica (Enhanced)'), 'es'));
    expect(voiceScore(voice('Mónica (Enhanced)'), 'es')).toBeGreaterThan(voiceScore(voice('Mónica'), 'es'));
    expect(voiceScore(voice('Mónica'), 'es')).toBeGreaterThan(voiceScore(voice('Eddy (Spanish (Spain))'), 'es'));
  });
});
