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
 * content. What it does get is a narrow bridge (see `preload.js`) for the three
 * things a wrapped web page cannot do for itself: import an Anki package from
 * disk, tell the shell which theme it is rendering, and name the build.
 */

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  shell,
  session,
} = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { existsSync, statSync } = require('node:fs');
const ai = require('./ai');
const cloud = require('./cloud');
const windowState = require('./src/window-state');
const updater = require('./updater');
const { importApkg, EXTENSIONS } = require('./src/apkg');

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
const REPOSITORY_URL = 'https://github.com/alanreyes24/fluentflow';

/** Hosts the renderer may talk to. Firebase needs several. */
const ALLOWED_CONNECT_HOSTS = [
  'https://*.googleapis.com',
  'https://*.firebaseio.com',
  'https://*.cloudfunctions.net',
  'wss://*.firebaseio.com',
  // The sync server. `app.json` ships pointing at `http://localhost:8787`, and
  // without this the packaged app cannot reach a server the user is running on
  // their own machine: every request fails as a policy violation, which reads
  // as the server being down. Loopback only; nothing else plaintext is allowed.
  'http://localhost:*',
  'http://127.0.0.1:*',
];

/** The one window. Kept so the menu and second-instance handler can find it. */
let mainWindow = null;

/**
 * Files the *user* chose, by path.
 *
 * The renderer names a path when it asks for an import, and the renderer draws
 * deck content it did not write. So a path is only importable if it arrived
 * from a file dialog, a drop on the window, or the command line — the renderer
 * cannot invent one and have the main process read it.
 */
const permittedFiles = new Set();

/** An import asked for before the app finished booting, held until it can land. */
let pendingImport = null;
let rendererReady = false;

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
  const restored = windowState.restore();

  // The app's own setting wins over the system's. `nativeTheme` knows what
  // Windows prefers; it does not know that this user forced light inside the
  // app. On Windows this is also what colours the title bar.
  nativeTheme.themeSource = restored.themeSource;

  const window = new BrowserWindow({
    ...restored.bounds,
    minWidth: windowState.MIN_WIDTH,
    minHeight: windowState.MIN_HEIGHT,
    // On macOS the window is a vibrancy pane, so its background is transparent
    // and the material shows through where the page does not paint — the title
    // strip and the bottom bar. Everywhere else it matches the background the
    // app itself last rendered, so a cold start does not flash a light page on
    // a dark desktop or the reverse.
    backgroundColor: isMac ? '#00000000' : restored.backgroundColor,
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
      // Applied before the first paint rather than after load, so the app does
      // not visibly re-lay-out into someone's chosen zoom on every launch.
      zoomFactor: restored.zoomFactor,
      // Read back in the preload. The version is in `app`, which a preload
      // cannot reach, and an extra IPC round trip for a constant is silly.
      additionalArguments: [`--fluentflow-app-version=${app.getVersion()}`],
    },
  });

  // Maximise before showing: Electron has no constructor option for it, and
  // doing it after `show` is a visible resize.
  if (restored.maximized) window.maximize();
  if (restored.fullScreen) window.setFullScreen(true);

  window.once('ready-to-show', () => window.show());
  windowState.track(window);

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

  // A reload drops the renderer's subscription, so anything queued for it has
  // to wait for the new page to say it is listening again.
  window.webContents.on('did-start-navigation', (details) => {
    if (!details.isSameDocument) rendererReady = false;
  });

  window.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });

  mainWindow = window;
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

// --- Anki import ------------------------------------------------------------

/**
 * Ask the app to import a file, or — with no file — to open its own picker.
 *
 * Held rather than dropped if the renderer is not listening yet: on Windows,
 * opening a `.apkg` with the app *starts* the app, so the request always
 * arrives before there is anything to receive it.
 */
function requestImport(file) {
  if (file) permittedFiles.add(file.path);

  if (!mainWindow || !rendererReady) {
    pendingImport = file ?? { path: null };
    return;
  }
  mainWindow.webContents.send('fluentflow:import-request', file);
}

function describeFile(filePath) {
  try {
    return { path: filePath, name: path.basename(filePath), size: statSync(filePath).size };
  } catch {
    return null;
  }
}


/** The first Anki package named on a command line, if any. */
function apkgFromArgv(argv) {
  const candidate = argv
    .slice(1)
    .filter((argument) => !argument.startsWith('-'))
    .find((argument) => EXTENSIONS.test(argument) && existsSync(argument));
  return candidate ? describeFile(path.resolve(candidate)) : null;
}

function registerImportHandlers() {
  // The picker lives here rather than in the page because a sandboxed renderer
  // gets a browser file input, which hands back a `File` with no usable path —
  // and the parse happens in this process, from a path.
  ipcMain.handle('fluentflow:pick-apkg', async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const { canceled, filePaths } = await dialog.showOpenDialog(owner, {
      title: 'Import an Anki deck',
      buttonLabel: 'Import',
      properties: ['openFile'],
      filters: [
        { name: 'Anki package', extensions: ['apkg', 'colpkg'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });

    if (canceled || filePaths.length === 0) return { canceled: true };

    const file = describeFile(filePaths[0]);
    if (!file) return { canceled: true };

    permittedFiles.add(file.path);
    return { canceled: false, file };
  });

  ipcMain.handle('fluentflow:import-apkg', async (_event, request) => {
    const filePath = typeof request?.path === 'string' ? request.path : '';
    if (!permittedFiles.has(filePath)) {
      return {
        ok: false,
        code: 'NOT_A_ZIP',
        message: 'Choose the file again — the app can only import a file you picked.',
      };
    }

    return importApkg(filePath, {
      userId: String(request?.userId ?? ''),
      language: request?.language || undefined,
      flatten: request?.flatten === true,
    });
  });

  // Sent by the preload once the app has somewhere to put an import request.
  ipcMain.on('fluentflow:import-ready', (event) => {
    if (mainWindow && event.sender !== mainWindow.webContents) return;
    rendererReady = true;
    if (!pendingImport || !mainWindow) return;

    const queued = pendingImport;
    pendingImport = null;
    mainWindow.webContents.send('fluentflow:import-request', queued.path ? queued : null);
  });

  // A file dropped on the window. The preload resolves the path; this decides
  // whether it is worth handing to the importer.
  ipcMain.on('fluentflow:dropped-file', (event, filePath) => {
    if (mainWindow && event.sender !== mainWindow.webContents) return;
    if (typeof filePath !== 'string' || !EXTENSIONS.test(filePath)) return;

    const file = describeFile(filePath);
    if (file) requestImport(file);
  });
}

// --- menu -------------------------------------------------------------------

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
    {
      label: '&File',
      submenu: [
        {
          label: 'Import Anki deck…',
          accelerator: 'CmdOrCtrl+O',
          click: () => requestImport(null),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: '&View',
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
    {
      role: 'help',
      submenu: [
        { label: 'Source and releases', click: () => void shell.openExternal(REPOSITORY_URL) },
        { type: 'separator' },
        { label: `About ${app.getName()}`, click: showAbout },
      ],
    },
  ]);
}

function showAbout() {
  void dialog.showMessageBox(mainWindow ?? undefined, {
    type: 'info',
    title: `About ${app.getName()}`,
    message: `${app.getName()} ${app.getVersion()}`,
    detail: [
      'Spaced-repetition flashcards for language learning.',
      '',
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
      '',
      // Said plainly, because "why are my examples generic?" is the question
      // this build will be asked most, and on desktop the answer never changes.
      'Example sentences here are written, not generated: the on-device model',
      'is a native mobile module and is not part of the desktop build.',
    ].join('\n'),
    buttons: ['Close'],
    noLink: true,
  });
}

function missingBuildPage() {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>FluentFlow</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; background: #f4f7f5; color: #0f1c17;
         display: grid; place-items: center; height: 100vh; margin: 0; }
  main { max-width: 34rem; padding: 2rem; }
  code { background: #eef2f0; padding: .15em .4em; border-radius: 4px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0b1512; color: #e8f0ec; }
    code { background: #16271f; }
  }
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
      const result = await ai.resolve(words, language, (done, total) => {
        // The window can go away mid-run; a long list outlives a closed window.
        if (!event.sender.isDestroyed()) {
          event.sender.send('ai:progress', { done, total });
        }
      }, askModel);
      return { ok: true, ...result };
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
    rememberRenderedTheme();
  });

  nativeTheme.on('updated', () => {
    const name = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('theme:native-changed', name);
    }
    // Following the system means following it while the app is open, too.
    rememberRenderedTheme();
  });
}

/**
 * Persist what the window is actually showing.
 *
 * `themeSource` is the preference; `shouldUseDarkColors` is what it resolves to
 * once "system" has been asked. The resolved name is what the *next* cold start
 * paints before any bundle has loaded, and on Windows it is what colours the
 * title bar — so it has to be stored, not just applied.
 */
function rememberRenderedTheme() {
  const name = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  windowState.rememberTheme(name, nativeTheme.themeSource);
  // On macOS the window is a vibrancy pane; painting it would cover the
  // material the title strip and bottom bar show through.
  if (!isMac) mainWindow?.setBackgroundColor(windowState.BACKGROUNDS[name]);
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

// --- lifecycle --------------------------------------------------------------

/**
 * One copy at a time.
 *
 * Two windows over one SQLite database in one profile is a corruption risk, and
 * on Windows a second copy is easy to start by accident — a second click on the
 * Start menu tile, or opening a `.apkg` while the app is already running. The
 * second process hands its command line to the first and exits.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const file = apkgFromArgv(argv);
    if (file) requestImport(file);
  });

  // macOS delivers "open with" through an event rather than the command line,
  // and can fire it before the app is ready.
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    const file = describeFile(filePath);
    if (file) requestImport(file);
  });

  app.whenReady().then(() => {
    registerProtocolHandler();
    applyContentSecurityPolicy();
    registerAiHandlers();
    registerImportHandlers();
    registerThemeSync();
    Menu.setApplicationMenu(buildMenu());
    createWindow();

    // Launched by double-clicking a deck, or from the command line.
    const opened = apkgFromArgv(process.argv);
    if (opened) requestImport(opened);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  // macOS keeps the app running with no windows; every other platform quits.
  if (process.platform !== 'darwin') app.quit();
});

// The window state writer debounces, so a quit between the last resize and the
// next tick would otherwise lose it.
app.on('before-quit', () => windowState.flush());

// Refuse to create a renderer with Node access, whatever a future edit asks for.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});
