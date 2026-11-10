import { Platform } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import type { ViewStyleProp } from './styles';

/**
 * The app's icons: one stroke family, drawn as SVG.
 *
 * These replace the text glyphs (★ ⚙ ✎ ✕ ✓ ⏱) and the streak emoji, which drew
 * in whatever font and colour the platform felt like — an emoji ignores the
 * text colour entirely, so the flame could not follow the theme. Paths are from
 * Lucide (ISC licence, https://lucide.dev), on its 24-unit grid with a 2-unit
 * round stroke, so every icon shares a weight and a corner.
 *
 * Only the shapes the app uses are here. Adding one is copying its path data
 * from Lucide into `SHAPES`.
 *
 * Icons are decorative by default: every place one appears is either beside
 * text or inside a control that carries its own accessibility label, and a
 * screen reader announcing "image" next to it is noise.
 */

type Shape = { paths: string[]; circles?: { cx: number; cy: number; r: number }[] };

const SHAPES = {
  flame: {
    paths: [
      'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z',
    ],
  },
  sprout: {
    paths: [
      'M7 20h10',
      'M10 20c5.5-2.5.8-6.4 3-10',
      'M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z',
      'M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z',
    ],
  },
  star: {
    paths: ['M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z'],
  },
  settings: {
    paths: [
      'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
    ],
    circles: [{ cx: 12, cy: 12, r: 3 }],
  },
  pencil: {
    paths: ['M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z', 'm15 5 4 4'],
  },
  x: { paths: ['M18 6 6 18', 'm6 6 12 12'] },
  check: { paths: ['M20 6 9 17l-5-5'] },
  timer: {
    paths: ['M10 2h4', 'M12 14l3-3'],
    circles: [{ cx: 12, cy: 14, r: 8 }],
  },
  chevronDown: { paths: ['m6 9 6 6 6-6'] },
  chevronUp: { paths: ['m18 15-6-6-6 6'] },
  chevronLeft: { paths: ['m15 18-6-6 6-6'] },
  chevronRight: { paths: ['m9 18 6-6-6-6'] },
  home: {
    paths: [
      'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8',
      'M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    ],
  },
  library: { paths: ['m16 6 4 14', 'M12 6v14', 'M8 8v12', 'M4 4v16'] },
  layers: {
    paths: [
      'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z',
      'm22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65',
      'm22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65',
    ],
  },
  plus: { paths: ['M5 12h14', 'M12 5v14'] },
  clipboard: {
    paths: [
      'M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z',
      'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2',
      'M9 12h6',
      'M9 16h4',
    ],
  },
  sparkles: {
    paths: [
      'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z',
      'M20 3v4',
      'M22 5h-4',
    ],
  },
  play: { paths: ['M6 3l14 9-14 9V3z'] },
  barChart: { paths: ['M3 3v16a2 2 0 0 0 2 2h16', 'M18 17V9', 'M13 17V5', 'M8 17v-3'] },
  bookOpen: {
    paths: [
      'M12 7v14',
      'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
    ],
  },
  calendar: {
    paths: ['M8 2v4', 'M16 2v4', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M3 10h18'],
  },
  moreHorizontal: {
    paths: [],
    circles: [{ cx: 12, cy: 12, r: 1 }, { cx: 19, cy: 12, r: 1 }, { cx: 5, cy: 12, r: 1 }],
  },
} satisfies Record<string, Shape>;

export type IconName = keyof typeof SHAPES;

/**
 * Hide the icon from assistive technology. On the web `react-native-svg`
 * hands its props straight to the DOM `<svg>`, where the native-only props are
 * unknown attributes React warns about, so each platform gets its own.
 */
const HIDDEN =
  Platform.OS === 'web'
    ? { 'aria-hidden': true }
    : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };

export function Icon({
  name,
  size = 20,
  color,
  filled = false,
  strokeWidth = 2,
  style,
}: {
  name: IconName;
  size?: number;
  color: string;
  /** Fill the outline as well as stroking it — a starred star, a lit flame. */
  filled?: boolean;
  strokeWidth?: number;
  style?: ViewStyleProp;
}) {
  const shape: Shape = SHAPES[name];
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? color : 'none'}
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      {...HIDDEN}
    >
      {shape.paths.map((d) => (
        <Path key={d} d={d} />
      ))}
      {shape.circles?.map((circle) => (
        <Circle key={`${circle.cx}-${circle.cy}-${circle.r}`} {...circle} />
      ))}
    </Svg>
  );
}
