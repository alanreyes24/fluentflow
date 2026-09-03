import type { LanguageCode } from '@fluentflow/core';

/**
 * UI strings.
 *
 * English is the source of truth: {@link Strings} is derived from it, so adding
 * a key without translating it is a type error in every other language pack
 * rather than a blank label at runtime.
 */

export const en = {
  appName: 'FluentFlow',

  // Auth
  signIn: 'Sign in',
  signUp: 'Create account',
  signOut: 'Sign out',
  email: 'Email',
  password: 'Password',
  continueWithGoogle: 'Continue with Google',
  noAccountYet: 'No account yet? Create one',
  haveAccount: 'Already have an account? Sign in',
  authFailed: 'Could not sign you in',
  workOffline: 'Continue without an account',
  offlineAccountNote: 'Your cards stay on this device until you sign in.',

  // Decks
  decks: 'Decks',
  newDeck: 'New deck',
  deckName: 'Deck name',
  deckLanguage: 'Language',
  createDeck: 'Create deck',
  deleteDeck: 'Delete deck',
  noDecksYet: 'No decks yet',
  noDecksHint: 'Create a deck or import one from Anki to get started.',
  cardCount: '{count} cards',
  dueCount: '{count} due',

  // Cards
  cards: 'Cards',
  addCard: 'Add card',
  front: 'Word or phrase',
  back: 'Meaning or translation',
  save: 'Save',
  cancel: 'Cancel',
  delete: 'Delete',
  edit: 'Edit',
  noCardsYet: 'This deck has no cards yet.',

  // Study
  study: 'Study',
  showAnswer: 'Show answer',
  againLabel: 'Again',
  hardLabel: 'Hard',
  goodLabel: 'Good',
  easyLabel: 'Easy',
  sessionComplete: 'Nothing left to review',
  sessionCompleteHint: 'Come back later, or study ahead.',
  studyAhead: 'Study ahead',
  reviewedToday: '{count} reviewed',
  examples: 'Examples',
  generatingExamples: 'Writing examples…',
  examplesOffline: 'Offline examples',
  examplesOfflineHint: 'The on-device model was unavailable, so these are generic.',
  regenerate: 'Regenerate',
  nextReviewIn: 'Next review in {interval}',

  // Progress
  statusNew: 'New',
  statusLearning: 'Learning',
  statusMastered: 'Mastered',
  progress: 'Progress',

  // Import
  importDeck: 'Import from Anki',
  chooseFile: 'Choose .apkg file',
  importing: 'Importing…',
  importSummary: '{cards} cards in {decks} deck(s)',
  importDetected: 'Detected language: {language}',
  importFailed: 'Import failed',
  importDone: 'Import complete',
  importHint: 'Export a deck from Anki Desktop with File › Export › Anki Deck Package.',
  importOverride: 'Import as',

  // Sync
  synced: 'Synced',
  syncing: 'Syncing…',
  offline: 'Offline',
  pendingChanges: '{count} pending',
  syncNow: 'Sync now',
  syncFailed: 'Sync failed',
  lastSynced: 'Last synced {time}',

  // Settings
  settings: 'Settings',
  interfaceLanguage: 'Interface language',
  appearance: 'Appearance',
  themeSystem: 'System',
  themeLight: 'Light',
  themeDark: 'Dark',
  aiSection: 'On-device examples',
  aiModelReady: 'Model ready',
  aiModelMissing: 'Model not installed',
  aiModelMissingHint: 'Examples fall back to generic sentences. Run npm run prepare-model.',
  account: 'Account',

  // Generic
  retry: 'Retry',
  loading: 'Loading…',
  errorTitle: 'Something went wrong',
  keyboardHint: 'Press 1–4 to rate',
} as const;

/**
 * English is the source of truth for *which* keys exist, but the values are
 * plain strings: `as const` above gives every English value a literal type, and
 * a translation is by definition a different string.
 */
export type Strings = { readonly [K in keyof typeof en]: string };
export type StringKey = keyof Strings;

const es: Strings = {
  appName: 'FluentFlow',

  signIn: 'Iniciar sesión',
  signUp: 'Crear cuenta',
  signOut: 'Cerrar sesión',
  email: 'Correo electrónico',
  password: 'Contraseña',
  continueWithGoogle: 'Continuar con Google',
  noAccountYet: '¿No tienes cuenta? Crea una',
  haveAccount: '¿Ya tienes cuenta? Inicia sesión',
  authFailed: 'No se pudo iniciar sesión',
  workOffline: 'Continuar sin cuenta',
  offlineAccountNote: 'Tus tarjetas se quedan en este dispositivo hasta que inicies sesión.',

  decks: 'Mazos',
  newDeck: 'Nuevo mazo',
  deckName: 'Nombre del mazo',
  deckLanguage: 'Idioma',
  createDeck: 'Crear mazo',
  deleteDeck: 'Eliminar mazo',
  noDecksYet: 'Todavía no hay mazos',
  noDecksHint: 'Crea un mazo o importa uno de Anki para empezar.',
  cardCount: '{count} tarjetas',
  dueCount: '{count} pendientes',

  cards: 'Tarjetas',
  addCard: 'Añadir tarjeta',
  front: 'Palabra o frase',
  back: 'Significado o traducción',
  save: 'Guardar',
  cancel: 'Cancelar',
  delete: 'Eliminar',
  edit: 'Editar',
  noCardsYet: 'Este mazo aún no tiene tarjetas.',

  study: 'Estudiar',
  showAnswer: 'Ver respuesta',
  againLabel: 'Otra vez',
  hardLabel: 'Difícil',
  goodLabel: 'Bien',
  easyLabel: 'Fácil',
  sessionComplete: 'No queda nada por repasar',
  sessionCompleteHint: 'Vuelve más tarde o adelanta trabajo.',
  studyAhead: 'Adelantar repaso',
  reviewedToday: '{count} repasadas',
  examples: 'Ejemplos',
  generatingExamples: 'Escribiendo ejemplos…',
  examplesOffline: 'Ejemplos sin conexión',
  examplesOfflineHint: 'El modelo del dispositivo no estaba disponible, así que estos son genéricos.',
  regenerate: 'Regenerar',
  nextReviewIn: 'Próximo repaso en {interval}',

  statusNew: 'Nuevas',
  statusLearning: 'Aprendiendo',
  statusMastered: 'Dominadas',
  progress: 'Progreso',

  importDeck: 'Importar de Anki',
  chooseFile: 'Elegir archivo .apkg',
  importing: 'Importando…',
  importSummary: '{cards} tarjetas en {decks} mazo(s)',
  importDetected: 'Idioma detectado: {language}',
  importFailed: 'Error al importar',
  importDone: 'Importación completa',
  importHint: 'Exporta un mazo desde Anki Desktop con Archivo › Exportar › Paquete de mazo de Anki.',
  importOverride: 'Importar como',

  synced: 'Sincronizado',
  syncing: 'Sincronizando…',
  offline: 'Sin conexión',
  pendingChanges: '{count} pendientes',
  syncNow: 'Sincronizar ahora',
  syncFailed: 'Error de sincronización',
  lastSynced: 'Última sincronización: {time}',

  settings: 'Ajustes',
  interfaceLanguage: 'Idioma de la interfaz',
  appearance: 'Apariencia',
  themeSystem: 'Sistema',
  themeLight: 'Claro',
  themeDark: 'Oscuro',
  aiSection: 'Ejemplos en el dispositivo',
  aiModelReady: 'Modelo listo',
  aiModelMissing: 'Modelo no instalado',
  aiModelMissingHint: 'Los ejemplos usan frases genéricas. Ejecuta npm run prepare-model.',
  account: 'Cuenta',

  retry: 'Reintentar',
  loading: 'Cargando…',
  errorTitle: 'Algo salió mal',
  keyboardHint: 'Pulsa 1–4 para calificar',
};

const bs: Strings = {
  appName: 'FluentFlow',

  signIn: 'Prijava',
  signUp: 'Napravi račun',
  signOut: 'Odjava',
  email: 'Email',
  password: 'Lozinka',
  continueWithGoogle: 'Nastavi sa Google',
  noAccountYet: 'Nemate račun? Napravite ga',
  haveAccount: 'Već imate račun? Prijavite se',
  authFailed: 'Prijava nije uspjela',
  workOffline: 'Nastavi bez računa',
  offlineAccountNote: 'Kartice ostaju na ovom uređaju dok se ne prijavite.',

  decks: 'Špilovi',
  newDeck: 'Novi špil',
  deckName: 'Naziv špila',
  deckLanguage: 'Jezik',
  createDeck: 'Napravi špil',
  deleteDeck: 'Obriši špil',
  noDecksYet: 'Još nema špilova',
  noDecksHint: 'Napravite špil ili uvezite jedan iz Ankija.',
  cardCount: '{count} kartica',
  dueCount: '{count} na redu',

  cards: 'Kartice',
  addCard: 'Dodaj karticu',
  front: 'Riječ ili fraza',
  back: 'Značenje ili prijevod',
  save: 'Sačuvaj',
  cancel: 'Otkaži',
  delete: 'Obriši',
  edit: 'Uredi',
  noCardsYet: 'Ovaj špil još nema kartica.',

  study: 'Uči',
  showAnswer: 'Prikaži odgovor',
  againLabel: 'Ponovo',
  hardLabel: 'Teško',
  goodLabel: 'Dobro',
  easyLabel: 'Lako',
  sessionComplete: 'Nema više ponavljanja',
  sessionCompleteHint: 'Vratite se kasnije ili učite unaprijed.',
  studyAhead: 'Uči unaprijed',
  reviewedToday: '{count} ponovljeno',
  examples: 'Primjeri',
  generatingExamples: 'Pišem primjere…',
  examplesOffline: 'Primjeri bez interneta',
  examplesOfflineHint: 'Model na uređaju nije bio dostupan, pa su ovi primjeri opšti.',
  regenerate: 'Generiši ponovo',
  nextReviewIn: 'Sljedeće ponavljanje za {interval}',

  statusNew: 'Nove',
  statusLearning: 'Učenje',
  statusMastered: 'Savladane',
  progress: 'Napredak',

  importDeck: 'Uvezi iz Ankija',
  chooseFile: 'Odaberi .apkg datoteku',
  importing: 'Uvozim…',
  importSummary: '{cards} kartica u {decks} špil(ova)',
  importDetected: 'Otkriveni jezik: {language}',
  importFailed: 'Uvoz nije uspio',
  importDone: 'Uvoz završen',
  importHint: 'Izvezite špil iz Anki Desktopa: Datoteka › Izvoz › Anki Deck Package.',
  importOverride: 'Uvezi kao',

  synced: 'Sinhronizovano',
  syncing: 'Sinhronizujem…',
  offline: 'Bez interneta',
  pendingChanges: '{count} na čekanju',
  syncNow: 'Sinhronizuj sada',
  syncFailed: 'Sinhronizacija nije uspjela',
  lastSynced: 'Zadnja sinhronizacija: {time}',

  settings: 'Postavke',
  interfaceLanguage: 'Jezik sučelja',
  appearance: 'Izgled',
  themeSystem: 'Sistemski',
  themeLight: 'Svijetlo',
  themeDark: 'Tamno',
  aiSection: 'Primjeri na uređaju',
  aiModelReady: 'Model spreman',
  aiModelMissing: 'Model nije instaliran',
  aiModelMissingHint: 'Primjeri koriste opšte rečenice. Pokrenite npm run prepare-model.',
  account: 'Račun',

  retry: 'Pokušaj ponovo',
  loading: 'Učitavanje…',
  errorTitle: 'Nešto je pošlo po zlu',
  keyboardHint: 'Pritisnite 1–4 za ocjenu',
};

export const LANGUAGE_PACKS: Record<LanguageCode, Strings> = { en, es, bs };
