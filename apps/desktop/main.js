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
 * content.
 */

const { app, BrowserWindow, Menu, net, protocol, shell, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { existsSync } = require('node:fs');

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
    backgroundColor: '#f6f5f2',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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

app.whenReady().then(() => {
  registerProtocolHandler();
  applyContentSecurityPolicy();
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
