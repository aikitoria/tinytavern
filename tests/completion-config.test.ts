import assert from 'node:assert/strict';
import type { Endpoint } from '@tinytavern/shared';
import { prepareStandaloneCompletion } from '../server/src/completionConfig.ts';
import type { ChatMessage } from '../server/src/prompt.ts';

const endpoint: Endpoint = {
  id: 1,
  name: 'Test',
  baseUrl: '',
  apiKey: '',
  hasApiKey: false,
  models: [],
  model: null,
  createdAt: 0,
  prefillMode: 'vllm',
  genParams: {
    temperature: 0,
    topP: 0.8,
    minP: 0.05,
    maxTokens: 700,
    frequencyPenalty: 0,
    presencePenalty: 0.2,
    reasoningEffort: 'high',
  },
};
const source: ChatMessage[] = [{ role: 'user', content: 'Revise this prompt' }];
const original = structuredClone(source);
for (const mode of ['vllm', 'deepseek', 'none', 'disabled'] as const) {
  const prepared = prepareStandaloneCompletion({ ...endpoint, prefillMode: mode }, source, 1024, {
    useEndpointParameters: true,
    reasoningPrefill: 'Consider the light',
    messagePrefill: 'A scene ',
  });
  assert.deepEqual(prepared, {
    messages: [
      ...source,
      ...(mode === 'disabled'
        ? []
        : [
            {
              role: 'assistant',
              content: 'A scene ',
              reasoning_content: 'Consider the light',
              ...(mode === 'deepseek' ? { prefix: true } : {}),
            },
          ]),
    ],
    parameters: {
      temperature: 0,
      top_p: 0.8,
      min_p: 0.05,
      max_tokens: 700,
      frequency_penalty: 0,
      presence_penalty: 0.2,
      reasoning_effort: 'high',
      ...(mode === 'vllm' ? { continue_final_message: true, add_generation_prompt: false } : {}),
    },
    messagePrefill: mode === 'disabled' ? '' : 'A scene ',
    reasoningPrefill: mode === 'disabled' ? '' : 'Consider the light',
  });
}
assert.deepEqual(source, original, 'Preparing continuation must not mutate snapshotted messages');
assert.deepEqual(prepareStandaloneCompletion(endpoint, source, 1024), {
  messages: source,
  parameters: { max_tokens: 1024 },
  messagePrefill: '',
  reasoningPrefill: '',
});
assert.deepEqual(
  prepareStandaloneCompletion({ ...endpoint, genParams: {} }, source, 1024, {
    useEndpointParameters: true,
    reasoningPrefill: 'Think',
  }),
  {
    messages: [...source, { role: 'assistant', content: '', reasoning_content: 'Think' }],
    parameters: { max_tokens: 1024, continue_final_message: true, add_generation_prompt: false },
    messagePrefill: '',
    reasoningPrefill: 'Think',
  },
);
console.log('Standalone completion configuration regressions passed');
