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
    'Cada frase debe tener entre 12 y 20 palabras y presentar una idea compleja, no una oración básica de sujeto-verbo-objeto. Usa la colocación y la preposición más naturales para un hablante nativo; no traduzcas literalmente del inglés. ' +
    'Si es una expresión fija, conserva su forma idiomática y añade los artículos que correspondan. ' +
    'Por ejemplo, para "entrar a la fuerza en" es preferible "entrar por la fuerza en la casa/una casa"; "en casa" normalmente significa "at home".',
  bs: (word, count) =>
    `Napiši ${count} prirodne rečenice na bosanskom jeziku koje koriste riječ "${word}". ` +
    'Svaka rečenica treba imati između 12 i 20 riječi i izražavati složenu ideju, a ne osnovni obrazac subjekt-glagol-objekat. Koristi prirodne kolokacije i padeže; ne prevodi doslovno s engleskog. ' +
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
    ' Make the surrounding language genuinely C1-C2 level so the learner encounters sophisticated vocabulary, idiomatic expressions, and nuanced contexts even when the target word itself is common.' +
    ' Every sentence must be 12-20 words and include a subordinate clause, contrast, cause-and-effect relationship, hypothetical situation, or another non-trivial structure.' +
    ' Include one or two useful C1-C2 words or collocations that fit naturally.' +
    ' Do not use generic beginner patterns such as "The thief decided..." or "They tried..."; make each sentence specific, vivid, and useful for learning.' +
    ' Do not make the sentence obscure, artificial, or difficult to understand from context.' +
    ' Prefer a different sentence or construction if the requested phrase would sound unnatural in context.' +
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
