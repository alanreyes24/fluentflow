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
import { useTheme, type Elevation, type Theme } from './theme';
import type { TextStyleProp, ViewStyleProp } from './styles';

/**
 * Shared primitives.
 *
 * These exist so no screen reaches for a raw colour: every one of them takes
 * its palette from the theme, which is what makes dark mode a single switch
 * rather than an audit. The same argument applies to shape — corner radii,
 * control heights and the uppercase treatment on section headings live here,
 * so "make it look better" is one file rather than seven.
 */

// --- text -------------------------------------------------------------------

type TextVariant = keyof Theme['typography'];
type Tone = 'default' | 'muted' | 'faint' | 'accent' | 'danger' | 'streak' | 'inverse';

interface LabelProps {
  children: ReactNode;
  variant?: TextVariant;
  tone?: Tone;
  align?: 'left' | 'center' | 'right';
  style?: TextStyleProp;
  numberOfLines?: number;
  selectable?: boolean;
  accessibilityLabel?: string;
}

export function Label({
  children,
  variant = 'body',
  tone = 'default',
  align = 'left',
  style,
  numberOfLines,
  selectable,
  accessibilityLabel,
}: LabelProps) {
  const theme = useTheme();
  const colors: Record<Tone, string> = {
    default: theme.colors.text,
    muted: theme.colors.textMuted,
    faint: theme.colors.textFaint,
    accent: theme.colors.accent,
    danger: theme.colors.danger,
    streak: theme.colors.streak,
    inverse: theme.colors.accentText,
  };

  return (
    <Text
      numberOfLines={numberOfLines}
      selectable={selectable}
      accessibilityLabel={accessibilityLabel}
      style={[
        theme.typography[variant],
        // Uppercasing in the component rather than at every call site: five
        // screens were repeating the same three style properties.
        variant === 'overline' && styles.overline,
        { color: colors[tone], textAlign: align },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/** A section heading, optionally with a control on the right. */
export function SectionHeader({
  title,
  action,
  style,
}: {
  title: string;
  action?: ReactNode;
  style?: ViewStyleProp;
}) {
  return (
    <View style={[styles.sectionHeader, style]}>
      <Label variant="overline" tone="faint" style={styles.grow}>
        {title}
      </Label>
      {action}
    </View>
  );
}

// --- buttons ----------------------------------------------------------------

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  disabled?: boolean;
  loading?: boolean;
  /** Overrides the variant's background, used by the rating buttons. */
  color?: string;
  /** A leading glyph. Decorative, so it stays out of the accessible name. */
  icon?: string;
  style?: ViewStyleProp;
  accessibilityHint?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled,
  loading,
  color,
  icon,
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
        size === 'sm' ? styles.buttonSmall : styles.buttonMedium,
        {
          backgroundColor: background,
          borderColor: variant === 'secondary' ? theme.colors.border : 'transparent',
          borderWidth: variant === 'secondary' ? StyleSheet.hairlineWidth : 0,
          borderRadius: theme.radius.md,
          // Opacity rather than a second palette entry: it reads correctly in
          // both themes and against the overridden rating colours.
          opacity: inactive ? 0.45 : pressed ? 0.82 : 1,
          transform: [{ scale: pressed && !inactive ? 0.985 : 1 }],
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <View style={styles.buttonInner}>
          {icon ? (
            <Text style={[theme.typography.label, { color: textColor }]}>{icon}</Text>
          ) : null}
          <Text
            numberOfLines={1}
            style={[size === 'sm' ? theme.typography.caption : theme.typography.label, { color: textColor }]}
          >
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/**
 * A row of mutually exclusive options.
 *
 * Replaces the three-buttons-in-a-row pattern the settings screen used: it
 * says "pick one of these" in its shape, which a row of equal buttons does
 * not, and it keeps each option addressable by its own label.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  style,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  style?: ViewStyleProp;
}) {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.segmented,
        {
          backgroundColor: theme.colors.surfaceSunken,
          borderRadius: theme.radius.md,
          borderColor: theme.colors.border,
        },
        style,
      ]}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.segment,
              {
                backgroundColor: selected ? theme.colors.surface : 'transparent',
                borderRadius: theme.radius.sm,
                opacity: pressed && !selected ? 0.7 : 1,
                boxShadow: selected ? theme.elevation.low : undefined,
              },
            ]}
          >
            <Text
              numberOfLines={1}
              style={[
                theme.typography.caption,
                { color: selected ? theme.colors.text : theme.colors.textMuted },
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
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
  tone = 'default',
  elevation = 'none',
  padding,
}: {
  children: ReactNode;
  style?: ViewStyleProp;
  raised?: boolean;
  tone?: 'default' | 'sunken' | 'accent';
  elevation?: Elevation;
  /** Overrides the default 16pt inset — 0 for a surface that hosts a list. */
  padding?: number;
}) {
  const theme = useTheme();

  const background = {
    default: raised ? theme.colors.surfaceRaised : theme.colors.surface,
    sunken: theme.colors.surfaceSunken,
    accent: theme.colors.accentSoft,
  }[tone];

  return (
    <View
      style={[
        styles.surface,
        {
          backgroundColor: background,
          borderColor: tone === 'accent' ? 'transparent' : theme.colors.border,
          borderRadius: theme.radius.lg,
          boxShadow: theme.elevation[elevation],
        },
        padding === undefined ? null : { padding },
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
  align = 'center',
  justify,
  wrap,
  style,
}: {
  children: ReactNode;
  gap?: number;
  align?: 'center' | 'flex-start' | 'flex-end' | 'baseline' | 'stretch';
  justify?: 'flex-start' | 'center' | 'space-between' | 'flex-end';
  wrap?: boolean;
  style?: ViewStyleProp;
}) {
  return (
    <View
      style={[
        styles.row,
        { gap, alignItems: align },
        justify ? { justifyContent: justify } : null,
        wrap ? styles.wrap : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Spacer({ size = 16 }: { size?: number }) {
  return <View style={{ height: size }} />;
}

/**
 * A centred content column.
 *
 * The same components render into a phone and into a maximised Electron
 * window, and without a ceiling on width the desktop build lays a study card
 * out as one 1400px line of text. `wide` is the reading measure for lists and
 * cards; `narrow` is for forms, which look abandoned at any more than that.
 *
 * Applied to a scroll view's `contentContainerStyle` rather than to the screen,
 * so the scrollbar stays at the window edge where it belongs.
 */
export const column = StyleSheet.create({
  wide: { width: '100%', maxWidth: 760, alignSelf: 'center' },
  narrow: { width: '100%', maxWidth: 460, alignSelf: 'center' },
});

export function Divider({ style }: { style?: ViewStyleProp }) {
  const theme = useTheme();
  return <View style={[styles.divider, { backgroundColor: theme.colors.border }, style]} />;
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
        <Label variant="overline" tone="muted">
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
            backgroundColor: theme.colors.surfaceSunken,
            borderColor: error ? theme.colors.danger : theme.colors.border,
            borderRadius: theme.radius.md,
            color: theme.colors.text,
          },
          style,
        ]}
        {...props}
      />
      {error ? (
        <Label variant="caption" tone="danger">
          {error}
        </Label>
      ) : hint ? (
        <Label variant="caption" tone="faint">
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

/** A small rounded tag. Used for due counts, languages and the sync state. */
export function Chip({
  label,
  color,
  background,
  icon,
  style,
  accessibilityLabel,
}: {
  label: string;
  color?: string;
  background?: string;
  icon?: string;
  style?: ViewStyleProp;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.chip,
        {
          backgroundColor: background ?? theme.colors.surfaceSunken,
          borderRadius: theme.radius.pill,
        },
        style,
      ]}
    >
      {icon ? (
        <Text style={[theme.typography.caption, { color: color ?? theme.colors.textMuted }]}>
          {icon}
        </Text>
      ) : null}
      <Text
        numberOfLines={1}
        style={[theme.typography.caption, { color: color ?? theme.colors.textMuted }]}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * Deck progress as a single stacked bar.
 *
 * A bar rather than three numbers because the useful question is "how much of
 * this deck is mastered", which is a proportion. The numbers are still there
 * underneath for anyone who wants them.
 */
export function ProgressBar({
  progress,
  height = 8,
}: {
  progress: DeckProgress;
  height?: number;
}) {
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
      style={[
        styles.progressTrack,
        { backgroundColor: theme.colors.surfaceSunken, height, borderRadius: height / 2 },
      ]}
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

/** A single bar, 0..1, for goals and mastery. */
export function Meter({
  value,
  color,
  height = 8,
  accessibilityLabel,
}: {
  value: number;
  color?: string;
  height?: number;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={[
        styles.progressTrack,
        { backgroundColor: theme.colors.surfaceSunken, height, borderRadius: height / 2 },
      ]}
    >
      <View
        style={{
          width: `${clamped * 100}%`,
          backgroundColor: color ?? theme.colors.accent,
          borderRadius: height / 2,
        }}
      />
    </View>
  );
}

/** One headline number with its caption. The unit of the statistics screen. */
export function StatTile({
  value,
  label,
  hint,
  tone = 'default',
  style,
}: {
  value: string;
  label: string;
  hint?: string;
  tone?: Tone;
  style?: ViewStyleProp;
}) {
  return (
    // One accessibility node, not three: "75" and "Retention" are separate
    // text nodes on screen and a screen reader has no way to pair them.
    <View accessible accessibilityLabel={`${label}: ${value}`} style={[styles.statTile, style]}>
      <Label variant="metric" tone={tone}>
        {value}
      </Label>
      <Label variant="overline" tone="faint">
        {label}
      </Label>
      {hint ? (
        <Label variant="caption" tone="muted">
          {hint}
        </Label>
      ) : null}
    </View>
  );
}

export function EmptyState({
  title,
  hint,
  action,
  icon,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  icon?: string;
}) {
  const theme = useTheme();
  return (
    <View style={styles.empty}>
      {icon ? (
        <View
          style={[
            styles.emptyIcon,
            { backgroundColor: theme.colors.surfaceSunken, borderRadius: theme.radius.pill },
          ]}
        >
          <Text style={styles.emptyGlyph}>{icon}</Text>
        </View>
      ) : null}
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
        <Label variant="caption" tone="muted">
          {label}
        </Label>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  surface: { borderWidth: StyleSheet.hairlineWidth, padding: 16 },
  row: { flexDirection: 'row' },
  wrap: { flexWrap: 'wrap' },
  grow: { flex: 1 },
  overline: { textTransform: 'uppercase', letterSpacing: 0.8 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  button: { alignItems: 'center', justifyContent: 'center' },
  buttonMedium: { minHeight: 50, paddingHorizontal: 20 },
  buttonSmall: { minHeight: 34, paddingHorizontal: 12 },
  buttonInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  segmented: {
    flexDirection: 'row',
    padding: 3,
    gap: 3,
    borderWidth: StyleSheet.hairlineWidth,
  },
  segment: { flex: 1, minHeight: 34, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  field: { gap: 6 },
  input: {
    minHeight: 50,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  divider: { height: StyleSheet.hairlineWidth, width: '100%' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  progressTrack: { overflow: 'hidden', flexDirection: 'row' },
  statTile: { gap: 2, minWidth: 72 },
  empty: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  emptyIcon: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  emptyGlyph: { fontSize: 24 },
  emptyHint: { maxWidth: 320 },
  emptyAction: { marginTop: 8 },
  loading: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
});
