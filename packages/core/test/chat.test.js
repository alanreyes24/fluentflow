import test from 'node:test';
import assert from 'node:assert/strict';
import { chatWithGemini } from '../dist/index.js';

test('chat forwards the conversation without added prompts or generation settings', async () => {
  const messages = [
    { role: 'user', text: 'What does casa mean?' },
    { role: 'model', text: 'House.' },
    { role: 'user', text: 'And the plural?' },
  ];
  const text = await chatWithGemini({
    apiKey: 'test-key',
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers['x-goog-api-key'], 'test-key');
      assert.deepEqual(JSON.parse(init.body), {
        contents: messages.map(({ role, text }) => ({ role, parts: [{ text }] })),
      });
      return Response.json({ candidates: [{ content: { parts: [{ text: 'Casas.' }] } }] });
    },
  }, messages);
  assert.equal(text, 'Casas.');
});

test('chat rejects malformed history before calling Gemini', async () => {
  await assert.rejects(chatWithGemini({ apiKey: 'test-key', fetchImpl: () => {
    assert.fail('Must not fetch');
  } }, [{ role: 'model', text: 'hello' }]), /conversation/);
});

test('chat reports provider failures and empty answers', async () => {
  const messages = [{ role: 'user', text: 'Hello' }];
  await assert.rejects(chatWithGemini({ apiKey: 'test-key', fetchImpl: async () =>
    Response.json({ error: { message: 'Quota exceeded' } }, { status: 429 }),
  }, messages), /Quota exceeded/);
  await assert.rejects(chatWithGemini({ apiKey: 'test-key', fetchImpl: async () =>
    Response.json({ candidates: [] }),
  }, messages), /no text/);
});
