import { View } from 'react-native';
import { dragRegionProps, onMacDesktop, TITLE_BAR_HEIGHT } from './shell';
import { useTheme } from './theme';

/**
 * The strip the window buttons live in.
 *
 * The desktop shell hides the native title bar, so close/minimise/zoom are
 * painted over the top-left of the page at a position the page cannot query.
 * This reserves that space and doubles as the window's drag handle — with the
 * title bar hidden there is otherwise nothing to grab.
 *
 * It renders nothing anywhere else: on a phone, in a browser tab and in the
 * render tests there is no shell, so there is no strip.
 */
export function TitleBar() {
  const theme = useTheme();
  if (!onMacDesktop()) return null;

  return (
    <View
      {...dragRegionProps}
      style={{ height: TITLE_BAR_HEIGHT, backgroundColor: theme.colors.background }}
    />
  );
}
