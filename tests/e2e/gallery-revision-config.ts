import type { Endpoint, GalleryItem, Settings, StandalonePromptTemplate } from '@tinytavern/shared';
import { BASE, MOCK_CONTROL, assert, expectStatus, putSettings, req } from './helpers.ts';

export async function testGalleryRevisionConfig(item: GalleryItem): Promise<void> {
  const settings = await req<Settings>('GET', '/api/settings');
  const endpoints = await req<Endpoint[]>('GET', '/api/endpoints');
  const endpoint = endpoints.find((entry) => entry.id === settings.activeEndpointId)!;
  const template: StandalonePromptTemplate = {
    systemPrompt: 'SYSTEM: edit {{prompt}}',
    userMessage: 'Apply {{instruction}}. Original: {{prompt}}.',
    reasoningPrefill: 'Plan {{instruction}}',
    messagePrefill: 'Seed: ',
  };
  const instruction = 'Keep {{prompt}} literal and preserve $&';
  await putSettings({ gallery: { promptRevision: template } });
  const saved = await req<Settings>('GET', '/api/settings');
  assert(
    JSON.stringify(saved.gallery.promptRevision) === JSON.stringify(template),
    'gallery saves all four standalone template fields',
  );
  await expectStatus(
    'PUT',
    '/api/settings',
    {
      expectedRevision: saved.revision,
      gallery: { promptRevision: { ...template, userMessage: 'Missing instruction' } },
    },
    400,
  );

  try {
    for (const mode of ['vllm', 'deepseek', 'none', 'disabled'] as const) {
      await req('PATCH', `/api/endpoints/${endpoint.id}`, {
        prefillMode: mode,
        genParams: { ...endpoint.genParams, maxTokens: 777, reasoningEffort: 'high' },
      });
      const response = await fetch(`${BASE}/api/gallery/${item.id}/revise-prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: item.prompt, instruction }),
      });
      assert(response.ok, `gallery revision accepts ${mode} endpoint configuration`);
      let output = '';
      let done = false;
      let error = '';
      for (const line of (await response.text()).split('\n')) {
        if (!line.startsWith('data:')) continue;
        const event = JSON.parse(line.slice(5)) as { d?: string; error?: string; done?: boolean };
        output += event.d ?? '';
        error ||= event.error ?? '';
        done ||= event.done === true;
      }
      assert(done && !error, `gallery revision finishes with ${mode} prefills`);
      const { completion } = (await (
        await fetch(`${MOCK_CONTROL}/control/last-completion`)
      ).json()) as {
        completion: {
          messages: {
            role: string;
            content: string;
            reasoning_content?: string;
            prefix?: boolean;
          }[];
          maxTokens: number;
          reasoningEffort: string;
          continueFinalMessage: boolean;
        };
      };
      const expectedMessages = [
        { role: 'system', content: `SYSTEM: edit ${item.prompt}` },
        { role: 'user', content: `Apply ${instruction}. Original: ${item.prompt}.` },
        ...(mode === 'disabled'
          ? []
          : [
              {
                role: 'assistant',
                content: 'Seed: ',
                reasoning_content: `Plan ${instruction}`,
                ...(mode === 'deepseek' ? { prefix: true } : {}),
              },
            ]),
      ];
      assert(
        JSON.stringify(completion.messages) === JSON.stringify(expectedMessages),
        `${mode} gallery request expands all template fields once without extra messages`,
      );
      assert(
        completion.maxTokens === 777 &&
          completion.reasoningEffort === 'high' &&
          completion.continueFinalMessage === (mode === 'vllm'),
        `${mode} gallery request uses endpoint parameters and continuation flags`,
      );
      assert(
        output.startsWith('Seed: ') === (mode !== 'disabled') &&
          !output.includes(`Plan ${instruction}`),
        `${mode} gallery output includes enabled visible prefill and excludes reasoning`,
      );
    }
  } finally {
    await req('PATCH', `/api/endpoints/${endpoint.id}`, {
      prefillMode: endpoint.prefillMode,
      genParams: endpoint.genParams,
    });
    await putSettings({ gallery: settings.gallery });
  }
}
