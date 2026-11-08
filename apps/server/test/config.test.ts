import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

test('a fresh checkout keeps the permissive local API on loopback', () => {
  const config = loadConfig({});
  assert.equal(config.mode, 'local');
  assert.equal(config.host, '127.0.0.1');
  assert.ok(!config.corsOrigins.includes('*'));
});

test('production refuses permissive local authentication', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /Refusing to start/);
  assert.throws(() => loadConfig({
    NODE_ENV: 'production', FLUENTFLOW_MODE: 'local',
  }), /Refusing to start/);
});

test('a Firebase deployment can explicitly configure its bind address and origins', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    FLUENTFLOW_MODE: 'firebase',
    FIREBASE_PROJECT_ID: 'test-project',
    HOST: '0.0.0.0',
    CORS_ORIGINS: 'https://study.example, https://preview.example',
  });
  assert.equal(config.mode, 'firebase');
  assert.equal(config.host, '0.0.0.0');
  assert.deepEqual(config.corsOrigins, ['https://study.example', 'https://preview.example']);
});

test('a hosted build needs only the web client project id to select firebase mode', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    EXPO_PUBLIC_FLUENTFLOW_FIREBASE_PROJECT_ID: 'web-project',
    FLUENTFLOW_ALLOWED_EMAILS: ' Me@Example.com , other@example.com ',
  });
  assert.equal(config.mode, 'firebase');
  assert.equal(config.projectId, 'web-project');
  assert.equal(config.host, '0.0.0.0');
  assert.ok(config.webDir?.endsWith(`mobile/dist`));
  assert.deepEqual(config.allowedEmails, ['me@example.com', 'other@example.com']);
});

test('development does not serve a stale web export', () => {
  assert.equal(loadConfig({}).webDir, undefined);
  assert.equal(loadConfig({}).allowedEmails, undefined);
});
