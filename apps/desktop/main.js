'use strict';

/**
 * Desktop shell for Windows and macOS.
 *
 * Expo targets iOS, Android and the web. It does not target Windows or macOS —
 * those need the out-of-tree `react-native-windows` / `react-native-macos`
 * forks, which are not Expo-managed and would mean maintaining a second native
 * project. Wrapping the web export in Electron gets a real desktop app from the
 * same codebase. The on-device model survives that move, but not in the
 * renderer: `onnxruntime-react-native` is a native mobile module and cannot
 * load in the web export, so inference runs in this process behind the IPC
 * handlers at the bottom of the file. See ai.js for what runs there and why.
 *
 * The export is served over a custom `app://` scheme rather than loaded from
 * `file://`. That is not cosmetic:
 *
 *  - The build is a single-page app, and expo-router drives it with the History
 *    API. Under `file://` those routes do not resolve, so a reload or a deep
 *    link lands on a blank page.
 *  - `file://` URLs have a null origin, which makes both CSP and any
 *    same-origin navigation check meaningless.
 *
 * The renderer never gets Node access, because it renders user-supplied deck
 * content.
 */

const { app, BrowserWindow, Menu, ipcMain, net, protocol, shell, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { existsSync } = require('node:fs');
const ai = require('./ai');

/** Set to the Metro dev server URL to develop against live reload. */
const DEV_URL = process.env.FLUENTFLOW_DEV_URL;
const WEB_ROOT = path.join(__dirname, 'web');
const INDEX_HTML = path.join(WEB_ROOT, 'index.html');

const SCHEME = 'app';
const APP_ORIGIN = `${SCHEME}://fluentflow`;

/** Hosts the renderer may talk to. Firebase needs several. */
const ALLOWED_CONNECT_HOSTS = [
  'https://*.googleapis.com',
  'https://*.firebaseio.com',
  'https://*.cloudfunctions.net',
  'wss://*.firebaseio.com',
];

// Must be called before `app.whenReady`. Registering the scheme as standard is
// what gives it a real origin; without `secure`, the renderer is treated as an
// insecure context and IndexedDB — which expo-sqlite's web backend needs — is
// unavailable.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/**
 * Serve the export, falling back to `index.html` for unknown paths.
 *
 * The fallback is what makes client-side routing work: a request for
 * `app://fluentflow/decks` has no matching file, and the SPA is expected to
 * resolve that route itself once it boots.
 */
function registerProtocolHandler() {
  protocol.handle(SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
    const candidate = path.join(WEB_ROOT, relative);

    // Refuse anything that escapes the export directory.
    const withinRoot =
      candidate === WEB_ROOT || candidate.startsWith(WEB_ROOT + path.sep);

    const target = withinRoot && relative && existsSync(candidate) ? candidate : INDEX_HTML;
    return net.fetch(pathToFileURL(target).toString());
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 480,
    minHeight: 520,
    // Matches the app's own light background so a cold start does not flash
    // white on a dark desktop.
    backgroundColor: '#fbfaf8',
    show: false,
    // `hidden` rather than `hiddenInset` so the page knows where the window
    // buttons are. `hiddenInset` shifts them by an amount Electron documents
    // only as "a fixed amount", which is not something a layout can be built
    // against — and the layout has to be built against it, because macOS draws
    // those three buttons over the top-left of the page whatever is there.
    // `TITLE_BAR_HEIGHT` and `WINDOW_BUTTONS_WIDTH` in the app's ui/shell.ts
    // are the other half of this pair.
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: { x: 18, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => window.show());

  if (DEV_URL) {
    void window.loadURL(DEV_URL);
    window.webContents.openDevTools({ mode: 'detach' });
  } else if (existsSync(INDEX_HTML)) {
    void window.loadURL(`${APP_ORIGIN}/`);
  } else {
    void window.loadURL(missingBuildPage());
  }

  // External links open in the user's browser rather than replacing the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Block in-app navigation away from the bundle. Without this, a link in a
  // card's text could replace the whole app with an arbitrary page.
  window.webContents.on('will-navigate', (event, url) => {
    const allowedOrigin = DEV_URL ? new URL(DEV_URL).origin : APP_ORIGIN;
    if (new URL(url).origin === allowedOrigin) return;

    event.preventDefault();
    if (/^https?:/.test(new URL(url).protocol)) void shell.openExternal(url);
  });

  return window;
}

function applyContentSecurityPolicy() {
  // Applied as a header rather than a meta tag so it also covers the dev server.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            // Metro's dev bundle needs eval; the packaged build does not, and
            // does not get it.
            `script-src 'self'${DEV_URL ? " 'unsafe-eval'" : ''}`,
            // react-native-web injects styles at runtime.
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            // wa-sqlite runs in a worker instantiated from a blob URL.
            "worker-src 'self' blob:",
            `connect-src 'self' ${ALLOWED_CONNECT_HOSTS.join(' ')} ${DEV_URL ?? ''}`.trim(),
            "frame-ancestors 'none'",
          ].join('; '),
        ],
      },
    });
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';

  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]);
}

function missingBuildPage() {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>FluentFlow</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; background: #f6f5f2; color: #1c1a17;
         display: grid; place-items: center; height: 100vh; margin: 0; }
  main { max-width: 34rem; padding: 2rem; }
  code { background: #e8e5df; padding: .15em .4em; border-radius: 4px; }
</style></head>
<body><main>
  <h1>The web build is missing</h1>
  <p>This shell renders the Expo web export. Build it first:</p>
  <p><code>npm run dist</code></p>
  <p>Or develop against the Metro dev server:</p>
  <p><code>npm run mobile</code> in the repository root, then <code>npm run dev</code> here.</p>
</main></body></html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * Looking words up runs here, not in the renderer.
 *
 * The renderer is the web export: no Node, and a content security policy that
 * exists because it renders user-supplied deck content. The dictionary is a
 * 40 MB SQLite file and the model is a gigabyte of weights behind a native
 * module, so both stay on this side of the bridge and the renderer asks for
 * results.
 *
 * Every handler answers with a plain object rather than throwing across the
 * bridge, because an IPC rejection reaches the renderer as a string with the
 * main-process stack glued to the front of it.
 */
function registerAiHandlers() {
  ipcMain.handle('ai:status', () => ai.sources());

  ipcMain.handle('ai:resolve', async (event, request) => {
    const { words, language } = request ?? {};
    if (!Array.isArray(words) || words.length === 0) {
      return { ok: false, error: 'No words to look up.' };
    }

    try {
      const meanings = await ai.resolve(words, language, (done, total) => {
        // The window can go away mid-run; a long list outlives a closed window.
        if (!event.sender.isDestroyed()) {
          event.sender.send('ai:progress', { done, total });
        }
      });
      return { ok: true, meanings };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });

  ipcMain.handle('ai:examples', async (_event, request) => {
    const { word, meaning, language, count } = request ?? {};
    if (typeof word !== 'string' || !word.trim()) {
      return { ok: false, error: 'No word to write examples for.' };
    }

    try {
      return { ok: true, result: await ai.examples({ word, meaning, language, count }) };
    } catch (error) {
      // A reveal must not break because the model did. The renderer turns this
      // into the same carrier sentences it would show with no model installed.
      return { ok: false, error: String(error?.message ?? error) };
    }
  });
}

app.whenReady().then(() => {
  registerProtocolHandler();
  applyContentSecurityPolicy();
  registerAiHandlers();
  Menu.setApplicationMenu(buildMenu());
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS keeps the app running with no windows; every other platform quits.
  if (process.platform !== 'darwin') app.quit();
});

// Refuse to create a renderer with Node access, whatever a future edit asks for.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});
