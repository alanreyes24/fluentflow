'use strict';

/**
 * Desktop shell for Windows and macOS.
 *
 * The app is a React web build (Expo's web export). Electron wraps it in a real
 * desktop window on Windows and macOS. The on-device model does not run in the
 * renderer — the web export has no Node runtime and cannot load an inference
 * backend — so inference runs in this process behind the IPC handlers at the
 * bottom of the file. See ai.js for what runs there and why.
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

const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  shell,
  session,
} = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { existsSync } = require('node:fs');
const ai = require('./ai');
const cloud = require('./cloud');
const windowState = require('./window-state');
const updater = require('./updater');

// The name Electron derives every per-user path from. Without this it takes the
// package name, `@fluentflow/desktop`, and the scope's slash turns into a
// directory: dictionaries and the model would be looked for under
// `Application Support/@fluentflow/desktop/`, while the fetch scripts write to
// `Application Support/FluentFlow/`. The app then reports nothing installed
// however many times you run the fetch. Must run before anything resolves
// `userData`, which is why it sits with the requires.
app.setName('FluentFlow');

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

const isMac = process.platform === 'darwin';

function createWindow() {
  const { bounds, maximized } = windowState.initialState();

  const window = new BrowserWindow({
    ...bounds,
    minWidth: 480,
    minHeight: 520,
    // On macOS the window is a vibrancy pane, so its background is transparent
    // and the material shows through where the page does not paint — the title
    // strip and the bottom bar. Elsewhere it matches the app's own light
    // background so a cold start does not flash white on a dark desktop.
    backgroundColor: isMac ? '#00000000' : '#fbfaf8',
    // `sidebar` is the standard material for app chrome; `followWindow` dims it
    // when the window is not focused, the way native chrome does.
    ...(isMac ? { vibrancy: 'sidebar', visualEffectState: 'followWindow' } : {}),
    show: false,
    // `hidden` rather than `hiddenInset` so the page knows where the window
    // buttons are. `hiddenInset` shifts them by an amount Electron documents
    // only as "a fixed amount", which is not something a layout can be built
    // against — and the layout has to be built against it, because macOS draws
    // those three buttons over the top-left of the page whatever is there.
    // `TITLE_BAR_HEIGHT` and `WINDOW_BUTTONS_WIDTH` in the app's ui/shell.ts
    // are the other half of this pair.
    titleBarStyle: isMac ? 'hidden' : 'default',
    trafficLightPosition: { x: 18, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  windowState.track(window);

  window.once('ready-to-show', () => {
    if (maximized) window.maximize();
    window.show();
  });

  // The renderer keeps a strip clear for the traffic lights and uses it as the
  // drag handle. macOS hides the lights in full-screen, so the strip has to go
  // too — the page cannot see the window's state on its own.
  const sendFullscreen = () =>
    window.webContents.send('window:fullscreen', window.isFullScreen());
  window.on('enter-full-screen', sendFullscreen);
  window.on('leave-full-screen', sendFullscreen);
  window.webContents.on('did-finish-load', sendFullscreen);

  updater.start(window);

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
  return Menu.buildFromTemplate([
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              {
                label: 'Check for Updates…',
                click: () => updater.checkNow(),
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
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
  <p><code>npm run web</code> in the repository root, then <code>npm run dev</code> here.</p>
</main></body></html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * Generations in flight, by the id the renderer gave them.
 *
 * Cancellation is here because of the prefetch. The study screen generates
 * examples for the cards *behind* the one on screen, so when the user reveals a
 * card the model is usually several tokens into a different one — and there is
 * one session and one set of threads. Starting the card the user is looking at
 * means stopping the one they are not; without this the reveal waits out a
 * generation nobody wants any more, which measured 3.5–6.2 s on an M-series Mac.
 *
 * The renderer supplies the id because an AbortSignal cannot cross
 * `contextBridge` — only structured-cloneable data does.
 */
const runningExamples = new Map();

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
    const { words, language, useModel } = request ?? {};
    if (!Array.isArray(words) || words.length === 0) {
      return { ok: false, error: 'No words to look up.' };
    }

    try {
      // Opt out, not opt in: a renderer too old to send the flag gets the
      // behaviour it was written against.
      const askModel = useModel !== false;
      const meanings = await ai.resolve(words, language, (done, total) => {
        // The window can go away mid-run; a long list outlives a closed window.
        if (!event.sender.isDestroyed()) {
          event.sender.send('ai:progress', { done, total });
        }
      }, askModel);
      return { ok: true, meanings };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });

  ipcMain.handle('ai:examples', async (_event, request) => {
    const { word, meaning, language, count, requestId } = request ?? {};
    if (typeof word !== 'string' || !word.trim()) {
      return { ok: false, error: 'No word to write examples for.' };
    }

    const controller = new AbortController();
    if (requestId != null) runningExamples.set(requestId, controller);

    try {
      const result = await ai.examples({ word, meaning, language, count }, controller.signal);
      return { ok: true, result, cancelled: controller.signal.aborted };
    } catch (error) {
      // A reveal must not break because the model did. The renderer turns this
      // into the same carrier sentences it would show with no model installed.
      return { ok: false, error: String(error?.message ?? error) };
    } finally {
      if (requestId != null) runningExamples.delete(requestId);
    }
  });

  ipcMain.on('ai:examples:cancel', (_event, requestId) => {
    runningExamples.get(requestId)?.abort();
  });

  /**
   * Configure the hosted model.
   *
   * Deliberately write-only. The renderer can set a key, change the model and
   * clear both, and it gets back the same status `ai:status` reports — which
   * says whether a key is present, never what it is. Reading the key is a main
   * process job because using it is a main process job; a getter would put a
   * credential into a page that renders user-supplied deck content for no
   * benefit at all.
   */
  ipcMain.handle('ai:cloud:set', (_event, request) => {
    const { apiKey, model } = request ?? {};
    try {
      if (typeof model === 'string') cloud.setModel(model);
      if (typeof apiKey === 'string') return { ok: true, status: cloud.setApiKey(apiKey) };
      return { ok: true, status: cloud.status() };
    } catch (error) {
      // Writing to userData can fail — a full disk, a keychain the user denied
      // — and the settings screen needs to say so rather than silently
      // appearing to have saved.
      return { ok: false, error: String(error?.message ?? error) };
    }
  });

  ipcMain.handle('ai:cloud:clear', () => {
    try {
      return { ok: true, status: cloud.clear() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });
}

/**
 * Keep the window chrome — the traffic lights and the window vibrancy — in
 * step with the theme the user picked inside the app.
 *
 * The renderer decides light/dark for its own palette from
 * `prefers-color-scheme`, which Electron drives from `nativeTheme`. So the
 * whole job here is to relay the app's Light/Dark/System preference to
 * `themeSource`; the renderer then follows the media query as it already does.
 */
function registerThemeSync() {
  ipcMain.on('theme:set', (_event, preference) => {
    nativeTheme.themeSource =
      preference === 'light' || preference === 'dark' ? preference : 'system';
  });

  nativeTheme.on('updated', () => {
    const name = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('theme:native-changed', name);
    }
  });
}

if (isMac) {
  app.setAboutPanelOptions({
    applicationName: 'FluentFlow',
    applicationVersion: app.getVersion(),
    version: '',
    copyright: '© 2026 FluentFlow',
    credits:
      'On-device model: Qwen2.5-1.5B-Instruct.\n' +
      'Dictionary data from Wiktionary (CC BY-SA).',
  });
}

app.whenReady().then(() => {
  registerProtocolHandler();
  applyContentSecurityPolicy();
  registerAiHandlers();
  registerThemeSync();
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
