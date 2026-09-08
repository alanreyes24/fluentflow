import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { LANGUAGE_NAMES, TARGET_LANGUAGES, type TargetLanguage } from '@fluentflow/core';
import { useI18n } from '../i18n';
import { Button, Field, Label, Row, SegmentedControl } from './components';
import { useTheme } from './theme';

export function NewDeckForm({
  onCreate,
  onCancel,
}: {
  onCreate: (name: string, language: TargetLanguage) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<TargetLanguage>('es');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onCreate(name.trim(), language);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.form}>
      <Field
        label={t('deckName')}
        value={name}
        onChangeText={setName}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
        placeholder="Spanish Verbs"
      />

      <View style={styles.field}>
        <Label variant="caption" tone="muted" style={styles.fieldLabel}>
          {t('deckLanguage')}
        </Label>
        <SegmentedControl
          options={TARGET_LANGUAGES.map((code) => ({ value: code, label: LANGUAGE_NAMES[code] }))}
          value={language}
          onChange={setLanguage}
        />
      </View>

      <Row gap={theme.spacing.sm}>
        <Button label={t('cancel')} variant="ghost" onPress={onCancel} style={styles.grow} />
        <Button
          label={t('createDeck')}
          onPress={() => void submit()}
          disabled={!name.trim()}
          loading={busy}
          style={styles.grow}
        />
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 16 },
  field: { gap: 6 },
  fieldLabel: { textTransform: 'uppercase', letterSpacing: 0.6 },
  grow: { flex: 1 },
});
