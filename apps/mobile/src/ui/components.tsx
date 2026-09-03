import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import type { CardStatus, DeckProgress } from '@fluentflow/core';
import { useTheme, type Theme } from './theme';
import type { TextStyleProp, ViewStyleProp } from './styles';

/**
 * Shared primitives.
 *
 * These exist so no screen reaches for a raw colour: every one of them takes
 * its palette from the theme, which is what makes dark mode a single switch
 * rather than an audit.
 */

// --- text -------------------------------------------------------------------

type TextVariant = keyof Theme['typography'];

interface LabelProps {
  children: ReactNode;
  variant?: TextVariant;
  tone?: 'default' | 'muted' | 'faint' | 'accent' | 'danger';
  align?: 'left' | 'center' | 'right';
  style?: TextStyleProp;
  numberOfLines?: number;
  selectable?: boolean;
}

export function Label({
  children,
  variant = 'body',
  tone = 'default',
  align = 'left',
  style,
  numberOfLines,
  selectable,
}: LabelProps) {
  const theme = useTheme();
  const colors = {
    default: theme.colors.text,
    muted: theme.colors.textMuted,
    faint: theme.colors.textFaint,
    accent: theme.colors.accent,
    danger: theme.colors.danger,
  };

  return (
    <Text
      numberOfLines={numberOfLines}
      selectable={selectable}
      style={[
        theme.typography[variant],
        { color: colors[tone], textAlign: align },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

// --- buttons ----------------------------------------------------------------

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  /** Overrides the variant's background, used by the rating buttons. */
  color?: string;
  style?: ViewStyleProp;
  accessibilityHint?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  color,
  style,
  accessibilityHint,
}: ButtonProps) {
  const theme = useTheme();
  const inactive = disabled || loading;

  const background =
    color ??
    {
      primary: theme.colors.accent,
      secondary: theme.colors.surfaceRaised,
      ghost: 'transparent',
      danger: theme.colors.danger,
    }[variant];

  const textColor =
    variant === 'secondary'
      ? theme.colors.text
      : variant === 'ghost'
        ? theme.colors.accent
        : theme.colors.accentText;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: Boolean(inactive) }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: background,
          borderColor: variant === 'secondary' ? theme.colors.border : 'transparent',
          borderWidth: variant === 'secondary' ? StyleSheet.hairlineWidth : 0,
          // Opacity rather than a second palette entry: it reads correctly in
          // both themes and against the overridden rating colours.
          opacity: inactive ? 0.45 : pressed ? 0.82 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <Text style={[theme.typography.label, { color: textColor }]}>{label}</Text>
      )}
    </Pressable>
  );
}

// --- layout -----------------------------------------------------------------

export function Screen({
  children,
  style,
}: {
  children: ReactNode;
  style?: ViewStyleProp;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.screen, { backgroundColor: theme.colors.background }, style]}>
      {children}
    </View>
  );
}

export function Surface({
  children,
  style,
  raised,
}: {
  children: ReactNode;
  style?: ViewStyleProp;
  raised?: boolean;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.surface,
        {
          backgroundColor: raised ? theme.colors.surfaceRaised : theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radius.md,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Row({
  children,
  gap = 8,
  style,
}: {
  children: ReactNode;
  gap?: number;
  style?: ViewStyleProp;
}) {
  return <View style={[styles.row, { gap }, style]}>{children}</View>;
}

export function Spacer({ size = 16 }: { size?: number }) {
  return <View style={{ height: size }} />;
}

// --- inputs -----------------------------------------------------------------

interface FieldProps extends TextInputProps {
  label?: string;
  hint?: string;
  error?: string | null;
}

export const Field = forwardRef<TextInput, FieldProps>(function Field(
  { label, hint, error, style, ...props },
  ref,
) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      {label ? (
        <Label variant="caption" tone="muted" style={styles.fieldLabel}>
          {label}
        </Label>
      ) : null}
      <TextInput
        ref={ref}
        // The visible label is a sibling `Text`, which a screen reader has no
        // way to associate with this input — without this the field is
        // announced as an unnamed text box.
        accessibilityLabel={props.accessibilityLabel ?? label}
        placeholderTextColor={theme.colors.textFaint}
        style={[
          theme.typography.body,
          styles.input,
          {
            backgroundColor: theme.colors.surface,
            borderColor: error ? theme.colors.danger : theme.colors.border,
            borderRadius: theme.radius.sm,
            color: theme.colors.text,
          },
          style,
        ]}
        {...props}
      />
      {error ? (
        <Label variant="caption" tone="danger" style={styles.fieldHint}>
          {error}
        </Label>
      ) : hint ? (
        <Label variant="caption" tone="faint" style={styles.fieldHint}>
          {hint}
        </Label>
      ) : null}
    </View>
  );
});

// --- status -----------------------------------------------------------------

export function StatusDot({ status, size = 8 }: { status: CardStatus; size?: number }) {
  const theme = useTheme();
  const color = {
    new: theme.colors.statusNew,
    learning: theme.colors.statusLearning,
    mastered: theme.colors.statusMastered,
  }[status];

  return (
    <View
      accessibilityLabel={status}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }}
    />
  );
}

/**
 * Deck progress as a single stacked bar.
 *
 * A bar rather than three numbers because the useful question is "how much of
 * this deck is mastered", which is a proportion. The numbers are still there
 * underneath for anyone who wants them.
 */
export function ProgressBar({ progress }: { progress: DeckProgress }) {
  const theme = useTheme();
  const total = Math.max(progress.total, 1);

  const segments: { key: CardStatus; count: number; color: string }[] = [
    { key: 'mastered', count: progress.mastered, color: theme.colors.statusMastered },
    { key: 'learning', count: progress.learning, color: theme.colors.statusLearning },
    { key: 'new', count: progress.new, color: theme.colors.statusNew },
  ];

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: progress.total, now: progress.mastered }}
      style={[styles.progressTrack, { backgroundColor: theme.colors.border }]}
    >
      {segments.map((segment) =>
        segment.count > 0 ? (
          <View
            key={segment.key}
            style={{ flex: segment.count / total, backgroundColor: segment.color }}
          />
        ) : null,
      )}
    </View>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.empty}>
      <Label variant="heading" align="center">
        {title}
      </Label>
      {hint ? (
        <Label variant="body" tone="muted" align="center" style={styles.emptyHint}>
          {hint}
        </Label>
      ) : null}
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={theme.colors.accent} />
      {label ? (
        <Label variant="caption" tone="muted" style={styles.loadingLabel}>
          {label}
        </Label>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  surface: { borderWidth: StyleSheet.hairlineWidth, padding: 16 },
  row: { flexDirection: 'row', alignItems: 'center' },
  button: {
    minHeight: 48,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  field: { gap: 6 },
  fieldLabel: { textTransform: 'uppercase', letterSpacing: 0.6 },
  fieldHint: {},
  input: {
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  empty: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  emptyHint: { maxWidth: 320 },
  emptyAction: { marginTop: 8 },
  loading: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  loadingLabel: {},
});
