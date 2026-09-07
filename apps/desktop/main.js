'use strict';

/**
 * Desktop shell for Windows and macOS.
 *
 * Expo targets iOS, Android and the web. It does not target Windows or macOS —
 * those need the out-of-tree `react-native-windows` / `react-native-macos`
 * forks, which are not Expo-managed and would mean maintaining a second native
 * project. Wrapping the web export in Electron gets a real desktop app from the
 * same codebase, at the cost of the on-device ONNX model: `onnxruntime-react-
 * native` is a native mobile module, so the desktop build falls back to written
 * example sentences.
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

const { importApkg, EXTENSIONS } = require('./src/apkg');
const windowState = require('./src/window-state');

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
    // Matches the background the app itself last rendered, so a cold start does
    // not flash a light page on a dark desktop or the reverse.
    backgroundColor: restored.backgroundColor,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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

// --- theme ------------------------------------------------------------------

function registerThemeHandler() {
  // The app reports what it is actually rendering. That drives the window
  // background, the Windows title bar, and the background the *next* cold start
  // opens with.
  ipcMain.on('fluentflow:theme', (event, report) => {
    if (mainWindow && event.sender !== mainWindow.webContents) return;

    const name = report?.name === 'dark' ? 'dark' : 'light';
    const preference = ['light', 'dark', 'system'].includes(report?.preference)
      ? report.preference
      : 'system';

    nativeTheme.themeSource = preference;
    windowState.rememberTheme(name, preference);
    mainWindow?.setBackgroundColor(windowState.BACKGROUNDS[name]);
  });

  // Following the system means following it while the app is open, too.
  nativeTheme.on('updated', () => {
    if (nativeTheme.themeSource !== 'system' || !mainWindow) return;
    const name = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    windowState.rememberTheme(name, 'system');
    mainWindow.setBackgroundColor(windowState.BACKGROUNDS[name]);
  });
}

// --- menu -------------------------------------------------------------------

function buildMenu() {
  const isMac = process.platform === 'darwin';

  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
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
  body { font: 15px/1.6 system-ui, sans-serif; background: #f7f5f1; color: #1c1a17;
         display: grid; place-items: center; height: 100vh; margin: 0; }
  main { max-width: 34rem; padding: 2rem; }
  code { background: #edeae3; padding: .15em .4em; border-radius: 4px; }
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
    registerImportHandlers();
    registerThemeHandler();
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
