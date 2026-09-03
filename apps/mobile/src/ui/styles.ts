import type { ComponentProps } from 'react';
import type { Image, Text, View } from 'react-native';

/**
 * Style prop types for components that accept a `style`.
 *
 * React Native is midway through replacing its hand-written types with
 * Flow-derived generated ones. On 0.86 the hand-written set is still the
 * default and the generated set is opt-in via the `react-native-strict-api`
 * export condition; the two are not interchangeable, and mixing them fails to
 * compile (`View` wants `____ViewStyleProp_Internal` where `Pressable` wants
 * `StyleProp<ViewStyle>`, and they disagree about properties such as
 * `backgroundImage`).
 *
 * Reading the aliases off the components' own props sidesteps the question
 * entirely: whichever set is active, these follow it.
 */

export type ViewStyleProp = ComponentProps<typeof View>['style'];
export type TextStyleProp = ComponentProps<typeof Text>['style'];
export type ImageStyleProp = ComponentProps<typeof Image>['style'];
