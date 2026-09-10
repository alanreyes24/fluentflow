import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-native-markdown-display';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Card, ChatMessage } from '@fluentflow/core';
import { sendChat } from '../ai/desktop';
import { useI18n } from '../i18n';
import { Button, Label, Row } from './components';
import { useTheme } from './theme';

type StudyContext = Pick<Card, 'front' | 'back' | 'language' | 'examples' | 'grammarNotes' | 'relatedWords'>;
type StudyMessage = ChatMessage & { context?: StudyContext };

export function useEscapeToClose(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);
}

/** Capture the card with each question so follow-ups retain the right context. */
function requestMessages(messages: StudyMessage[]): ChatMessage[] {
  return messages.map(({ role, text, context }) => ({
    role,
    text: context ? `Current study card (context for this question):\n${JSON.stringify({
      word: context.front,
      meaning: context.back,
      language: context.language === 'es' ? 'Spanish (es)' : 'Bosnian (bs)',
      examples: context.examples,
      grammarNotes: context.grammarNotes,
      relatedWords: context.relatedWords,
    })}\n\nQuestion: ${text}` : text,
  }));
}

export function StudyChat({ card, open, onClose }: {
  card: StudyContext;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const [messages, setMessages] = useState<StudyMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const scroll = useRef<ScrollView>(null);

  useEscapeToClose(open, onClose);

  async function send() {
    const text = draft.trim();
    if (!text || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    const next: StudyMessage[] = [...messages, { role: 'user', text, context: { ...card } }];
    setMessages(next);
    setDraft('');
    try {
      const answer = await sendChat(requestMessages(next));
      setMessages([...next, { role: 'model', text: answer }]);
    } catch (cause) {
      setMessages(messages);
      setDraft(text);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <View style={[styles.container, !open && styles.hidden]}>
      {open ? (
        <View style={[styles.panel, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          <Row>
            <Label variant="caption" style={styles.flex}>Gemini</Label>
            <Button label={t('chatClear')} variant="ghost" disabled={busy || messages.length === 0}
              onPress={() => { setMessages([]); setError(null); }} />
          </Row>
          <Label variant="caption" tone="muted" numberOfLines={2}>
            {card.front} · {card.language === 'es' ? 'Español' : 'Bosanski'}
          </Label>
          <ScrollView ref={scroll} style={styles.history} keyboardShouldPersistTaps="handled"
            onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
            {messages.length === 0 ? <Label tone="muted" variant="caption">{t('chatHint')}</Label> : null}
            {messages.map((message, index) => (
              <View key={index} style={styles.message}>
                <Label variant="caption" tone="muted">{message.role === 'user' ? t('chatYou') : 'Gemini'}</Label>
                {message.role === 'model' ? (
                  <Markdown rules={{
                    textgroup: (node, children, _parents, markdownStyles) => (
                      <Text key={node.key} selectable style={markdownStyles.textgroup}>{children}</Text>
                    ),
                  }} style={{
                    body: { color: theme.colors.text, fontSize: 15, lineHeight: 23 },
                    paragraph: { marginTop: 0, marginBottom: 12 },
                    heading1: { fontSize: 22, lineHeight: 28, marginTop: 16, marginBottom: 8, fontWeight: '700' },
                    heading2: { fontSize: 20, lineHeight: 26, marginTop: 16, marginBottom: 8, fontWeight: '700' },
                    heading3: { fontSize: 17, lineHeight: 24, marginTop: 12, marginBottom: 8, fontWeight: '700' },
                    bullet_list: { marginBottom: 12 },
                    ordered_list: { marginBottom: 12 },
                    table: { borderColor: theme.colors.border, marginBottom: 12 },
                    tr: { borderColor: theme.colors.border },
                    th: { padding: 8 },
                    td: { padding: 8 },
                    code_inline: { backgroundColor: theme.colors.surface, color: theme.colors.text },
                    code_block: { backgroundColor: theme.colors.surface, color: theme.colors.text, borderColor: theme.colors.border },
                    fence: { backgroundColor: theme.colors.surface, color: theme.colors.text, borderColor: theme.colors.border },
                    blockquote: { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
                    link: { color: theme.colors.accent },
                  }}>{message.text}</Markdown>
                ) : <Label selectable>{message.text}</Label>}
              </View>
            ))}
            {busy ? <Label tone="muted" variant="caption">{t('chatThinking')}</Label> : null}
          </ScrollView>
          {error ? <Label tone="danger" variant="caption">{error}</Label> : null}
          <Row>
            <TextInput accessibilityLabel={t('chatQuestion')} placeholder={t('chatQuestion')}
              placeholderTextColor={theme.colors.textMuted} value={draft} onChangeText={setDraft}
              onKeyPress={(event) => {
                const key = event.nativeEvent as typeof event.nativeEvent & {
                  shiftKey?: boolean; isComposing?: boolean; keyCode?: number; repeat?: boolean;
                };
                if (key.key !== 'Enter' || key.shiftKey || key.isComposing || key.keyCode === 229) return;
                event.preventDefault();
                if (!key.repeat) void send();
              }}
              editable={!busy} multiline style={[styles.input, { color: theme.colors.text, borderColor: theme.colors.border }]}
            />
            <Button label={t('chatSend')} onPress={() => void send()} disabled={!draft.trim()} loading={busy} />
          </Row>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minWidth: 0, minHeight: 0, padding: 24 },
  hidden: { display: 'none' },
  flex: { flex: 1 },
  panel: { flex: 1, minHeight: 0, borderWidth: 1, borderRadius: 12, padding: 20, gap: 12 },
  history: { flex: 1, minHeight: 0 },
  message: { gap: 3, marginBottom: 12 },
  input: { flex: 1, borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 42, maxHeight: 80 },
});
