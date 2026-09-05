import { LANGUAGE_NAMES_EN, type TargetLanguage } from '../types.js';

/**
 * Prompt construction for the bundled on-device model.
 *
 * Small instruct models (TinyLlama 1.1B, Phi-2 2.7B) are sensitive to their
 * chat template: feed TinyLlama a Phi-2 prompt and it will happily continue the
 * instruction instead of answering it. Each supported family therefore gets its
 * own wrapper around one shared instruction.
 */

export type ModelFamily = 'tinyllama' | 'phi2' | 'qwen' | 'raw';

export interface ExamplePromptInput {
  word: string;
  /** The translation, included as a disambiguation hint when available. */
  meaning?: string;
  language: TargetLanguage;
  count?: number;
}

/** Short, concrete instructions in the target language keep small models on task. */
const LANGUAGE_INSTRUCTIONS: Record<TargetLanguage, (word: string, count: number) => string> = {
  es: (word, count) =>
    `Escribe ${count} frases sencillas en español que usen la palabra "${word}". ` +
    'Cada frase debe tener entre 4 y 12 palabras.',
  bs: (word, count) =>
    `Napiši ${count} jednostavne rečenice na bosanskom jeziku koje koriste riječ "${word}". ` +
    'Svaka rečenica treba imati između 4 i 12 riječi.',
};

const SYSTEM_PROMPT =
  'You are a language-learning assistant. You reply with a JSON array of strings and nothing else.';

export function buildInstruction(input: ExamplePromptInput): string {
  const count = input.count ?? 2;
  const languageName = LANGUAGE_NAMES_EN[input.language];
  const localized = LANGUAGE_INSTRUCTIONS[input.language](input.word, count);
  const meaning = input.meaning ? ` The word means "${input.meaning}" in English.` : '';

  return (
    `Generate ${count} simple example sentences using the word "${input.word}" in ${languageName}.` +
    meaning +
    ` ${localized}` +
    ' Format the answer as a JSON array of strings.' +
    ' Example: ["sentence 1", "sentence 2"]'
  );
}

/** Wrap the instruction in the chat template the given model family expects. */
export function buildPrompt(input: ExamplePromptInput, family: ModelFamily = 'tinyllama'): string {
  const instruction = buildInstruction(input);

  switch (family) {
    case 'tinyllama':
      return (
        `<|system|>\n${SYSTEM_PROMPT}</s>\n` +
        `<|user|>\n${instruction}</s>\n` +
        '<|assistant|>\n'
      );
    case 'qwen':
      return (
        `<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>\n` +
        `<|im_start|>user\n${instruction}<|im_end|>\n` +
        '<|im_start|>assistant\n'
      );
    case 'phi2':
      return `Instruct: ${instruction}\nOutput:`;
    case 'raw':
      return instruction;
  }
}

/**
 * Sequences that end generation. TinyLlama emits `</s>`; Phi-2 tends to start a
 * new `Instruct:` turn instead of stopping, so both are treated as terminators.
 */
export const STOP_SEQUENCES: Record<ModelFamily, string[]> = {
  tinyllama: ['</s>', '<|user|>', '<|system|>'],
  qwen: ['<|im_end|>', '<|im_start|>', '<|endoftext|>'],
  phi2: ['Instruct:', '\nOutput:', '<|endoftext|>'],
  raw: ['\n\n'],
};
