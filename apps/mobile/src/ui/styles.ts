import type { ComponentProps } from 'react';
import type { Image, Text, View } from 'react-native';

/**
 * Style prop types for components that accept a `style`.
 *
 * React Native 0.87 ships two parallel type definitions — the hand-written ones
 * under `types/` and Flow-derived generated ones under `types_generated/` — and
 * mixing them does not type-check: `View` picks up the generated
 * `____ViewStyleProp_Internal` while `Pressable` and `Text` still resolve to the
 * hand-written `StyleProp<ViewStyle>`, and the two disagree on properties such
 * as `backgroundImage`. `tsconfig.json` therefore pins the hand-written set via
 * the `react-native-legacy-deep-imports` export condition, which is the
 * consistent one across every component in this release.
 *
 * These aliases are read off the components' own props rather than written out,
 * so the app keeps compiling when that pin is eventually removed and the
 * generated types become the only ones.
 */

export type ViewStyleProp = ComponentProps<typeof View>['style'];
export type TextStyleProp = ComponentProps<typeof Text>['style'];
export type ImageStyleProp = ComponentProps<typeof Image>['style'];
