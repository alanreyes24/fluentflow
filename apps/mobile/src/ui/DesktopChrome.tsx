import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { onDesktopFullscreenChange } from './shell';

/**
 * Bits of the desktop window state the page cannot observe for itself.
 *
 * Right now that is just full-screen: macOS hides the traffic lights in
 * full-screen, so {@link TitleBar} drops the strip it reserves for buttons
 * that are no longer there. The value is always `false` in a browser tab.
 */

interface DesktopChrome {
  fullscreen: boolean;
}

const DesktopChromeContext = createContext<DesktopChrome>({ fullscreen: false });

export function DesktopChromeProvider({ children }: { children: ReactNode }) {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => onDesktopFullscreenChange(setFullscreen), []);

  const value = useMemo(() => ({ fullscreen }), [fullscreen]);
  return <DesktopChromeContext.Provider value={value}>{children}</DesktopChromeContext.Provider>;
}

export function useDesktopChrome(): DesktopChrome {
  return useContext(DesktopChromeContext);
}
