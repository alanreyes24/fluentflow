import test from 'node:test';
import assert from 'node:assert/strict';
import { isSettingValue, mergeSettings, sameSettings } from '../dist/index.js';

const T1 = '2026-11-18T10:00:00.000Z';
const T2 = '2026-11-18T11:00:00.000Z';

test('merges setting by setting, newest wins', () => {
  const laptop = { theme: { value: 'dark', updatedAt: T2 }, dailyGoal: { value: 20, updatedAt: T1 } };
  const phone = { theme: { value: 'light', updatedAt: T1 }, dailyGoal: { value: 40, updatedAt: T2 } };
  const merged = mergeSettings(laptop, phone);
  assert.deepEqual(merged, { dailyGoal: { value: 40, updatedAt: T2 }, theme: { value: 'dark', updatedAt: T2 } });
  // Order does not matter.
  assert.deepEqual(mergeSettings(phone, laptop), merged);
});

test('keeps a setting only one side has chosen', () => {
  const merged = mergeSettings({ uiLanguage: { value: 'bs', updatedAt: T1 } }, {});
  assert.deepEqual(merged, { uiLanguage: { value: 'bs', updatedAt: T1 } });
});

test('settles a tie the same way on every device', () => {
  const a = { dailyGoal: { value: 10, updatedAt: T1 } };
  const b = { dailyGoal: { value: 80, updatedAt: T1 } };
  assert.deepEqual(mergeSettings(a, b), mergeSettings(b, a));
});

test('compares copies by value and time', () => {
  const a = { theme: { value: 'dark', updatedAt: T1 } };
  assert.equal(sameSettings(a, { theme: { value: 'dark', updatedAt: T1 } }), true);
  assert.equal(sameSettings(a, { theme: { value: 'dark', updatedAt: T2 } }), false);
  assert.equal(sameSettings(a, {}), false);
});

test('validates values per setting', () => {
  assert.equal(isSettingValue('dailyGoal', 20), true);
  assert.equal(isSettingValue('dailyGoal', 0), false);
  assert.equal(isSettingValue('dailyGoal', 2.5), false);
  assert.equal(isSettingValue('theme', 'dark'), true);
  assert.equal(isSettingValue('theme', 'blue'), false);
  assert.equal(isSettingValue('uiLanguage', 'bs'), true);
  assert.equal(isSettingValue('uiLanguage', 'fr'), false);
});
