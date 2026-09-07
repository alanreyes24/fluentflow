import { forwardRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type TextStyle,
} from 'react-native';
import type { CardStatus, DeckProgress } from '@fluentflow/core';
import { layout, useLayout, useTheme, type ElevationLevel, type Theme } from './theme';
import type { TextStyleProp, ViewStyleProp } from './styles';

/**
 * Shared primitives.
 *
 * These exist so no screen reaches for a raw colour: every one of them takes
 * its palette from the theme, which is what makes dark mode a single switch
 * rather than an audit.
 *
 * The look is a quiet emerald system — one accent, a neutral surface ramp, and
 * soft shadows that lift a card off the page without a hard edge. Motion and
 * focus rings are web-only style props, guarded so the native test preset never
 * sees a style key it does not know.
 */

const WEB = Platform.OS === 'web';

/** Append an alpha byte to a `#rrggbb`, leave anything else alone. */
function withAlpha(color: string, alpha: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}${alpha}` : color;
}

/**
 * Web-only style props (CSS transitions, `backdrop-filter`). A no-op on native,
 * where these keys are not in `ViewStyle` — the cast is the price of using them
 * without pulling in the react-native-web types across the whole app. `webText`
 * is the same escape hatch for a `TextInput`'s style, whose element type is
 * `TextStyle` rather than `ViewStyle` in this React Native version.
 */
function web(style: Record<string, string | number>): ViewStyleProp {
  return WEB ? (style as unknown as ViewStyleProp) : undefined;
}

function webText(style: Record<string, string | number>): TextStyle | undefined {
  return WEB ? (style as unknown as TextStyle) : undefined;
}

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
  variant?: 'primary' | 'secondary' | 'ghost' | 'ghostDanger' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  /** Solid background override — the answer buttons on the flashcard use it. */
  color?: string;
  /** Tonal override: a soft wash of this colour with the colour as the label. */
  tone?: string;
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
  tone,
  style,
  accessibilityHint,
}: ButtonProps) {
  const theme = useTheme();
  const { wide } = useLayout();
  const [hovered, setHovered] = useState(false);
  const inactive = disabled || loading;

  // Resolve the resting and hover backgrounds. `tone`/`color` overrides win,
  // then the variant. `primary` moves through real accent steps rather than the
  // old flat opacity dip, which reads muddy against a coloured override.
  let background: string;
  let hoverBackground: string;
  let textColor: string;
  let shadow: string = theme.elevation.none;

  if (color) {
    background = color;
    hoverBackground = color;
    textColor = theme.colors.accentText;
    shadow = theme.elevation.sm;
  } else if (tone) {
    background = withAlpha(tone, '26');
    hoverBackground = withAlpha(tone, '3d');
    textColor = tone;
  } else {
    switch (variant) {
      case 'primary':
        background = theme.colors.accent;
        hoverBackground = theme.colors.accentHover;
        textColor = theme.colors.accentText;
        shadow = theme.elevation.sm;
        break;
      case 'secondary':
        background = theme.colors.accentSoft;
        hoverBackground = withAlpha(theme.colors.accent, '2e');
        textColor = theme.colors.accent;
        break;
      case 'danger':
        background = theme.colors.danger;
        hoverBackground = theme.colors.danger;
        textColor = theme.colors.accentText;
        shadow = theme.elevation.sm;
        break;
      case 'ghostDanger':
        background = 'transparent';
        hoverBackground = withAlpha(theme.colors.danger, '1f');
        textColor = theme.colors.danger;
        break;
      default:
        background = 'transparent';
        hoverBackground = theme.colors.hover;
        textColor = theme.colors.accent;
    }
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: Boolean(inactive) }}
      disabled={inactive}
      onPress={onPress}
      // Pointer events rather than Pressable's `hovered` state: that one is a
      // react-native-web extension the shared types do not carry, and these
      // are in React Native proper and simply never fire on a touch screen.
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={({ pressed }) => [
        styles.button,
        { borderRadius: theme.radius.md },
        // A 48pt target is sized for a thumb. With a mouse it reads as
        // oversized, and macOS controls are nowhere near it.
        { minHeight: wide ? 38 : 48, paddingHorizontal: wide ? 18 : 22 },
        {
          backgroundColor: (pressed || hovered) && !inactive ? hoverBackground : background,
          opacity: inactive ? 0.4 : pressed ? 0.9 : 1,
          boxShadow: inactive ? theme.elevation.none : shadow,
          transform: pressed && !inactive ? [{ translateY: 1 }] : [{ translateY: 0 }],
        },
        web({ transitionProperty: 'background-color, box-shadow, transform, opacity', transitionDuration: '120ms' }),
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

/**
 * The width text is actually set at, and the padding around it.
 *
 * Returned as a style object rather than a component because most screens are
 * a `FlatList` or a `ScrollView`, and the thing that needs constraining is
 * `contentContainerStyle` — wrapping the list in a narrow `View` instead would
 * stop the scrollbar reaching the window edge.
 *
 * Passing `full` opts out of the measure for content that genuinely wants the
 * pane: the flashcard, which is a stage rather than a paragraph.
 */
export function useContentStyle(options?: { full?: boolean; maxWidth?: number }): ViewStyleProp {
  const theme = useTheme();
  const { wide } = useLayout();

  return {
    padding: wide ? theme.spacing.lg : theme.spacing.md,
    // Room to scroll the last row clear of the window edge.
    paddingBottom: theme.spacing.xxl,
    width: '100%',
    maxWidth: options?.full ? undefined : (options?.maxWidth ?? layout.measure),
    // Centred in the window, with the header title centred over it (see the
    // stack's `headerTitleAlign` in app/(app)/_layout.tsx). The column used to
    // hug the leading edge because a sidebar sat beside it and the navigator
    // drew the title there; with the navigation moved to the bottom bar there
    // is nothing on the left for it to line up with, and a 680pt column pinned
    // to the left of an 1100pt window reads as content that fell over.
    alignSelf: 'center',
  };
}

/** The same column, for a screen that does not scroll. */
export function Page({
  children,
  style,
  full,
  maxWidth,
}: {
  children: ReactNode;
  style?: ViewStyleProp;
  full?: boolean;
  maxWidth?: number;
}) {
  const content = useContentStyle({ full, maxWidth });
  return <View style={[styles.page, content, style]}>{children}</View>;
}

/**
 * A heading over a group of rows.
 *
 * Small, uppercase and faint on purpose: it labels the group without competing
 * with the content of it, which is the one job a section heading has.
 */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <Label variant="caption" tone="faint" style={styles.sectionLabel}>
      {children}
    </Label>
  );
}

export function Surface({
  children,
  style,
  raised,
  elevation,
}: {
  children: ReactNode;
  style?: ViewStyleProp;
  raised?: boolean;
  elevation?: ElevationLevel;
}) {
  const theme = useTheme();
  const level: ElevationLevel = elevation ?? (raised ? 'sm' : 'none');
  return (
    <View
      style={[
        styles.surface,
        {
          backgroundColor: raised ? theme.colors.surfaceRaised : theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radius.md,
          boxShadow: theme.elevation[level],
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** A hairline rule inside a surface. */
export function Divider({ style }: { style?: ViewStyleProp }) {
  const theme = useTheme();
  return (
    <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.divider }, style]} />
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

/**
 * A small count or status pill.
 *
 * `accent` is the due-count on a deck; `plain` is a neutral tag. Text stays at
 * caption size so a two-digit number does not stretch the pill out of round.
 */
export function Badge({
  children,
  tone = 'accent',
}: {
  children: ReactNode;
  tone?: 'accent' | 'plain';
}) {
  const theme = useTheme();
  const accent = tone === 'accent';
  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: accent ? theme.colors.accent : theme.colors.surfaceSunken,
          borderRadius: theme.radius.pill,
        },
      ]}
    >
      <Text
        style={[
          theme.typography.caption,
          { color: accent ? theme.colors.accentText : theme.colors.textMuted, fontWeight: '700' },
        ]}
      >
        {children}
      </Text>
    </View>
  );
}

// --- segmented control -----------------------------------------------------

/**
 * One-of-N choice as a single grooved control.
 *
 * Replaces the rows of primary/secondary buttons the pickers used to be: the
 * selected segment lifts on its own surface, the rest recede into the groove.
 * Equal-width segments — every option here is one or two words.
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
        { backgroundColor: theme.colors.surfaceSunken, borderRadius: theme.radius.md },
        style,
      ]}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Segment
            key={option.value}
            label={option.label}
            selected={selected}
            onPress={() => onChange(option.value)}
          />
        );
      })}
    </View>
  );
}

function Segment({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);

  const background = selected
    ? theme.colors.surfaceRaised
    : hovered
      ? theme.colors.hover
      : 'transparent';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={[
        styles.segment,
        {
          backgroundColor: background,
          borderRadius: theme.radius.md - 3,
          borderWidth: selected ? StyleSheet.hairlineWidth : 0,
          borderColor: theme.colors.border,
          boxShadow: selected ? theme.elevation.sm : theme.elevation.none,
        },
        web({ transitionProperty: 'background-color, box-shadow', transitionDuration: '120ms' }),
      ]}
    >
      <Label
        variant="label"
        tone={selected ? 'accent' : 'muted'}
        align="center"
        numberOfLines={1}
      >
        {label}
      </Label>
    </Pressable>
  );
}

// --- inputs -----------------------------------------------------------------

interface FieldProps extends TextInputProps {
  label?: string;
  hint?: string;
  error?: string | null;
}

export const Field = forwardRef<TextInput, FieldProps>(function Field(
  { label, hint, error, style, onFocus, onBlur, ...props },
  ref,
) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);

  const borderColor = error
    ? theme.colors.danger
    : focused
      ? theme.colors.accent
      : theme.colors.border;

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
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        style={[
          theme.typography.body,
          styles.input,
          {
            backgroundColor: theme.colors.surfaceSunken,
            borderColor,
            borderRadius: theme.radius.sm,
            color: theme.colors.text,
            boxShadow: focused && !error
              ? `0 0 0 3px ${theme.colors.accentSoft}`
              : theme.elevation.none,
          },
          { outlineWidth: 0 },
          webText({ transitionProperty: 'border-color, box-shadow', transitionDuration: '120ms' }),
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
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        boxShadow: `0 0 0 3px ${withAlpha(color, '29')}`,
      }}
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
      style={[
        styles.progressTrack,
        { backgroundColor: theme.colors.surfaceSunken, borderRadius: theme.radius.pill },
      ]}
    >
      {segments.map((segment) =>
        segment.count > 0 ? (
          <View
            key={segment.key}
            style={{
              flex: segment.count / total,
              backgroundColor: segment.color,
              borderRadius: theme.radius.pill,
            }}
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
  page: { flex: 1 },
  sectionLabel: { textTransform: 'uppercase', letterSpacing: 0.8 },
  surface: { borderWidth: StyleSheet.hairlineWidth, padding: 16 },
  row: { flexDirection: 'row', alignItems: 'center' },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  badge: {
    minWidth: 24,
    paddingHorizontal: 9,
    paddingVertical: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmented: {
    flexDirection: 'row',
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  field: { gap: 6 },
  fieldLabel: { textTransform: 'uppercase', letterSpacing: 0.8 },
  fieldHint: {},
  input: {
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  progressTrack: {
    height: 8,
    overflow: 'hidden',
    flexDirection: 'row',
    gap: 2,
  },
  empty: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  emptyHint: { maxWidth: 320 },
  emptyAction: { marginTop: 8 },
  loading: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  loadingLabel: {},
});
