import test from 'node:test';
import assert from 'node:assert/strict';
import {
  combineModelUsage,
  createRemoteInference,
} from '../dist/index.js';

test('remote inference reports measured tokens and list-price cost', async () => {
  const usages = [];
  const infer = createRemoteInference({
    apiKey: 'test-key',
    model: 'gemini-3.1-flash-lite',
    onUsage: (usage) => usages.push(usage),
    fetchImpl: async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'armor' }] } }],
      usageMetadata: {
        promptTokenCount: 120,
        candidatesTokenCount: 30,
        thoughtsTokenCount: 5,
        totalTokenCount: 155,
      },
    })),
  });

  assert.equal(await infer({ prompt: 'translate', stop: [], maxTokens: 32 }), 'armor');
  assert.deepEqual(usages, [{
    model: 'gemini-3.1-flash-lite',
    requests: 1,
    inputTokens: 120,
    outputTokens: 35,
    totalTokens: 155,
    listPriceUsd: 0.0000825,
  }]);
});

test('measured usage combines every successful request in an import', () => {
  const combined = combineModelUsage([
    {
      model: 'gemini-3.1-flash-lite',
      requests: 1,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      listPriceUsd: 0.000055,
    },
    {
      model: 'gemini-3.1-flash-lite',
      requests: 1,
      inputTokens: 80,
      outputTokens: 10,
      totalTokens: 90,
      listPriceUsd: 0.000035,
    },
  ]);

  assert.deepEqual(combined, {
    model: 'gemini-3.1-flash-lite',
    requests: 2,
    inputTokens: 180,
    outputTokens: 30,
    totalTokens: 210,
    listPriceUsd: 0.00009,
  });
});
