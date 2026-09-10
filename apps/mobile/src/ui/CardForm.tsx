import { useState } from 'react';
import { StyleSheet } from 'react-native';
import { useI18n } from '../i18n';
import { Button, Field, Label, Row, Surface } from './components';
import { useTheme } from './theme';

/**
 * Add or edit a card's content: front, back, and the optional context lists.
 *
 * Shared by the deck screen's card list and the study session, so the same
 * fields, validation, and "stay open after adding" behaviour apply wherever a
 * card is written. Passing `initialFront`/`initialBack` switches it from an
 * add form (clears and stays open on save) to an edit form (closes on save).
 */
export function CardForm({
  onCreate,
  onCancel,
  initialFront = '',
  initialBack = '',
  initialGrammarNotes = [],
  initialRelatedWords = [],
  initialTags = [],
  error,
}: {
  onCreate: (
    front: string,
    back: string,
    grammarNotes: string[],
    relatedWords: string[],
    tags: string[],
  ) => Promise<boolean>;
  onCancel: () => void;
  initialFront?: string;
  initialBack?: string;
  initialGrammarNotes?: string[];
  initialRelatedWords?: string[];
  initialTags?: string[];
  error?: string;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const [front, setFront] = useState(initialFront);
  const [back, setBack] = useState(initialBack);
  const [grammarNotes, setGrammarNotes] = useState(initialGrammarNotes.join(', '));
  const [relatedWords, setRelatedWords] = useState(initialRelatedWords.join(', '));
  const [tags, setTags] = useState(initialTags.join(', '));
  const [busy, setBusy] = useState(false);

  const editing = Boolean(initialFront || initialBack);

  const submit = async () => {
    if (!front.trim() || !back.trim() || busy) return;
    setBusy(true);
    try {
      const saved = await onCreate(
        front.trim(),
        back.trim(),
        splitList(grammarNotes),
        splitList(relatedWords),
        normalizeTags(splitList(tags)),
      );
      if (saved && !editing) {
        // Stay open and clear: adding ten cards in a row is the common case.
        setFront('');
        setBack('');
        setGrammarNotes('');
        setRelatedWords('');
        setTags('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Surface style={styles.form}>
      {error ? <Label variant="caption" tone="danger">{error}</Label> : null}
      <Field label={t('front')} value={front} onChangeText={setFront} autoFocus />
      <Field
        label={t('back')}
        value={back}
        onChangeText={setBack}
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
      />
      <Field
        label={t('grammarNotes')}
        hint={t('grammarNotesHint')}
        value={grammarNotes}
        onChangeText={setGrammarNotes}
        multiline
      />
      <Field
        label={t('relatedWords')}
        hint={t('relatedWordsHint')}
        value={relatedWords}
        onChangeText={setRelatedWords}
      />
      <Field
        label={t('tags')}
        hint={t('tagsHint')}
        value={tags}
        onChangeText={setTags}
      />
      <Row gap={theme.spacing.sm}>
        <Button label={t('cancel')} variant="ghost" onPress={onCancel} style={styles.grow} />
        <Button
          label={t('save')}
          onPress={() => void submit()}
          disabled={!front.trim() || !back.trim()}
          loading={busy}
          style={styles.grow}
        />
      </Row>
    </Surface>
  );
}

/** Split a comma- or newline-separated field into a trimmed, non-empty list. */
export function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Tags are case-insensitive labels; store a stable, duplicate-free spelling. */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  return tags.filter((tag) => {
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const styles = StyleSheet.create({
  form: { gap: 16 },
  grow: { flex: 1 },
});
