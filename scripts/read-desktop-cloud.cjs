'use strict';

/**
 * Read FluentFlow's desktop-only Gemini settings for the local web API.
 *
 * This script must run under Electron: `safeStorage` needs Electron's main
 * process and the OS keychain. The credential is returned only over the
 * private child-process IPC channel; it is never printed or exposed to Expo.
 */

const path = require('node:path');
const { app } = require('electron');

app.setName('FluentFlow');
app.setPath('userData', path.join(app.getPath('appData'), 'FluentFlow'));
app.dock?.hide();

void app.whenReady().then(() => {
  const cloud = require('../apps/desktop/cloud.js');
  const apiKey = cloud.apiKey();

  process.send?.({
    type: 'fluentflow-cloud-settings',
    apiKey,
    model: cloud.model(),
  });
  app.quit();
}).catch((error) => {
  process.send?.({
    type: 'fluentflow-cloud-settings-error',
    message: error instanceof Error ? error.message : String(error),
  });
  app.exit(1);
});
