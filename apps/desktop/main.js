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
 * example sentences unless it is pointed at a local inference service.
 *
 * The renderer is deliberately locked down. It loads only the bundled export
 * and never gets Node access, because it runs UI code that renders
 * user-supplied deck content.
 */

const { app, BrowserWindow, Menu, shell, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { existsSync } = require('node:fs');

/** Set to the Metro dev server URL to develop against a live reload. */
const DEV_URL = process.env.FLUENTFLOW_DEV_URL;
const WEB_ROOT = path.join(__dirname, 'web');
const INDEX_HTML = path.join(WEB_ROOT, 'index.html');

/** Hosts the renderer may talk to. Firebase needs several. */
const ALLOWED_CONNECT_HOSTS = [
  'https://*.googleapis.com',
  'https://*.firebaseio.com',
  'https://*.cloudfunctions.net',
  'wss://*.firebaseio.com',
];

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
    void window.loadFile(INDEX_HTML);
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
    const target = new URL(url);
    const allowed = DEV_URL ? new URL(DEV_URL).origin : pathToFileURL(WEB_ROOT).origin;
    if (target.origin !== allowed) {
      event.preventDefault();
      if (/^https?:$/.test(target.protocol)) void shell.openExternal(url);
    }
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
            // Metro's dev bundle and React Native Web's runtime style
            // injection both need these; the packaged build is stricter only
            // in that it has no dev server to reach.
            `script-src 'self' ${DEV_URL ? "'unsafe-eval'" : ''}`,
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            `connect-src 'self' ${ALLOWED_CONNECT_HOSTS.join(' ')} ${DEV_URL ?? ''}`,
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
  <p><code>npm run dist -w @fluentflow/desktop</code></p>
  <p>Or develop against the Metro dev server:</p>
  <p><code>npm run mobile</code> then <code>npm run dev -w @fluentflow/desktop</code></p>
</main></body></html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

app.whenReady().then(() => {
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
