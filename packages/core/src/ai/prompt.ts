import { LANGUAGE_NAMES_EN, type TargetLanguage } from '../types.js';

/**
 * What the model is asked for, when a card needs example sentences.
 *
 * This used to carry a chat template per model family, because a local base
 * model fed the wrong control tokens continues the instruction instead of
 * answering it — feed TinyLlama a Phi-2 prompt and it happily writes the next
 * question. With generation now going to a hosted chat endpoint there is one
 * prompt and no wrappers: the service applies its own template, and sending it
 * `<|im_start|>` would just be text it has to read past.
 */

export interface ExamplePromptInput {
  word: string;
  /** The translation, included as a disambiguation hint when available. */
  meaning?: string;
  language: TargetLanguage;
  count?: number;
}

/** Concrete instructions in the target language keep the answer on task. */
const LANGUAGE_INSTRUCTIONS: Record<TargetLanguage, (word: string, count: number) => string> = {
  es: (word, count) =>
    `Escribe ${count} frases naturales en español que usen la palabra "${word}". ` +
    'La primera frase debe ser sencilla, con vocabulario cotidiano y una estructura clara. La segunda debe ser más compleja, con vocabulario avanzado y una oración subordinada u otra estructura elaborada. Usa la colocación y la preposición más naturales para un hablante nativo; no traduzcas literalmente del inglés. ' +
    'Si es una expresión fija, conserva su forma idiomática y añade los artículos que correspondan. ' +
    'Por ejemplo, para "entrar a la fuerza en" es preferible "entrar por la fuerza en la casa/una casa"; "en casa" normalmente significa "at home".',
  bs: (word, count) =>
    `Napiši ${count} prirodne rečenice na bosanskom jeziku koje koriste riječ "${word}". ` +
    'Prva rečenica treba biti jednostavna, sa svakodnevnim riječima i jasnom strukturom. Druga treba biti složenija, s naprednim vokabularom i zavisnom rečenicom ili drugom složenom strukturom. Koristi prirodne kolokacije i padeže; ne prevodi doslovno s engleskog. ' +
    'Ako je riječ o ustaljenom izrazu, koristi njegov najprirodniji oblik.',
};

export function buildInstruction(input: ExamplePromptInput): string {
  const count = input.count ?? 2;
  const languageName = LANGUAGE_NAMES_EN[input.language];
  const localized = LANGUAGE_INSTRUCTIONS[input.language](input.word, count);
  const meaning = input.meaning ? ` The word means "${input.meaning}" in English.` : '';

  return (
    `Generate ${count} example sentences using the word "${input.word}" in ${languageName}.` +
    meaning +
    ` ${localized}` +
    ' The sentences must sound like natural, contemporary usage to a native speaker, not merely be grammatically possible.' +
    ' Keep the sentences in order of difficulty: the first sentence must be simple, using everyday vocabulary and one clear main clause, ideally 5-10 words (longer if needed for the target phrase).' +
    ' The second sentence must be more complex: use 12-20 words, with a subordinate clause, contrast, cause-and-effect relationship, or hypothetical situation, and one or two useful C1-C2 words or collocations that fit naturally.' +
    ' If more than two sentences are requested, keep the additional sentences at the more complex level. If only one is requested, use the simple level.' +
    ' Make each sentence specific and useful for learning, with a clear difference in difficulty between the first and second.' +
    ' Do not make the sentence obscure, artificial, or difficult to understand from context.' +
    ' Prefer a different sentence or construction if the requested phrase would sound unnatural in context.' +
    outputFormat(input.language)
  );
}

/**
 * How the sentences come back.
 *
 * Bosnian carries an English translation of each sentence, shown beneath it in
 * study so a learner who cannot yet parse the sentence still gets the context
 * it is there to provide. Spanish stays a bare string array.
 */
function outputFormat(language: TargetLanguage): string {
  if (language === 'bs') {
    return (
      ' Format the answer as a JSON array of objects, each with a "sentence" field' +
      ' holding the Bosnian sentence and a "translation" field holding a natural,' +
      ' faithful English translation of that exact sentence.' +
      ' Example: [{"sentence": "...", "translation": "..."}, {"sentence": "...", "translation": "..."}]'
    );
  }
  return (
    ' Format the answer as a JSON array of strings.' +
    ' Example: ["sentence 1", "sentence 2"]'
  );
}

/**
 * The prompt for a card reveal.
 *
 * Kept as its own function rather than folded into {@link buildInstruction}
 * because the two names mean different things to a reader — one is "the words
 * we say to the model", the other is "the request we send" — and the
 * distinction is where a template would go back if a second provider ever needs
 * one.
 */
export function buildPrompt(input: ExamplePromptInput): string {
  return buildInstruction(input);
}

/**
 * Sequences that end generation, for a backend that needs telling.
 *
 * The hosted path with a response schema ignores these: the answer is complete
 * when the JSON array closes, and a stop sequence layered on top of a schema
 * can only truncate valid JSON into invalid JSON. They are still sent for
 * unstructured answers, where a chatty model otherwise runs on past the point
 * it has answered.
 */
export const STOP_SEQUENCES: string[] = ['\n\n'];
