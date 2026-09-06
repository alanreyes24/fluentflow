import { View } from 'react-native';
import { useDesktopChrome } from './DesktopChrome';
import { dragRegionProps, onMacDesktop, TITLE_BAR_HEIGHT } from './shell';

/**
 * The strip the window buttons live in.
 *
 * The desktop shell hides the native title bar, so close/minimise/zoom are
 * painted over the top-left of the page at a position the page cannot query.
 * This reserves that space and doubles as the window's drag handle — with the
 * title bar hidden there is otherwise nothing to grab.
 *
 * It renders nothing anywhere else: in a browser tab and in the render tests
 * there is no shell, so there is no strip. In native full-screen macOS hides
 * the window buttons, so the strip goes too.
 *
 * The strip itself paints no background — on macOS the window is a vibrancy
 * pane and this sits over it.
 */
export function TitleBar() {
  const { fullscreen } = useDesktopChrome();
  if (!onMacDesktop() || fullscreen) return null;

  return <View {...dragRegionProps} style={{ height: TITLE_BAR_HEIGHT }} />;
}
