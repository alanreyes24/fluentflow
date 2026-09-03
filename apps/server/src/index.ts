import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createStore } from './store/index.ts';

const config = loadConfig();
const store = createStore(config);
const app = createApp({ config, store });

const server = app.listen(config.port, config.host, () => {
  console.log(`[fluentflow] listening on http://${config.host}:${config.port} (${config.mode} mode)`);
  if (config.mode === 'local') {
    console.log(
      '[fluentflow] local mode: data is in memory and any "Bearer local:<name>" token is accepted.',
    );
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[fluentflow] ${signal} received, shutting down`);
    server.close(() => {
      void store.close().then(() => process.exit(0));
    });
  });
}
