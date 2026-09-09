import SettingLabel from '../../forms/SettingField.tsx';
import { For, Show, createSignal } from 'solid-js';
import type { Endpoint, GenParams } from '@tinytavern/shared';
import { api } from '../../../state/api.ts';
import { selectSettingsEntity } from '../../../state/settingsSelection.ts';
import { state } from '../../../state/store.ts';
import { createEntityEditor, errorMessage } from '../../../util.ts';
import EntityEditorPane from '../EntityEditorPane.tsx';
import FormField, { createFormFields } from '../../forms/FormFields.tsx';
import Select from '../../ui/Select.tsx';

export default function EndpointsTab() {
  const [model, setModel] = createSignal('');
  const [keyCleared, setKeyCleared] = createSignal(false);
  const [editingExisting, setEditingExisting] = createSignal(false);
  const form = createFormFields({
    name: '',
    baseUrl: '',
    apiKey: '',
    temperature: '',
    topP: '',
    minP: '',
    maxTokens: '',
    frequencyPenalty: '',
    presencePenalty: '',
    reasoningEffort: '',
    prefillMode: 'none',
    systemPromptPrefix: '',
    systemPromptSuffix: '',
    reasoningPrefillPrefix: '',
  });
  const keyEl = form.fields.apiKey;
  const sampling = [
    ['temperature', 'Temperature', '0.05', 0, 2],
    ['topP', 'Top P', '0.05', 0, 1],
    ['minP', 'Min P', '0.01', 0, 1],
    ['maxTokens', 'Max tokens', '1', 1, undefined],
    ['frequencyPenalty', 'Freq. penalty', '0.05', -2, 2],
    ['presencePenalty', 'Pres. penalty', '0.05', -2, 2],
  ] as const;

  const editor = createEntityEditor({
    ...api.endpoints,
    items: () => state.endpoints,
    load: (endpoint) => {
      setEditingExisting(endpoint != null);
      setKeyCleared(false);
      setModel(endpoint?.model ?? '');
      form.load({
        name: endpoint?.name ?? '',
        baseUrl: endpoint?.baseUrl ?? '',
        apiKey: '',
        prefillMode: endpoint?.prefillMode ?? 'none',
        systemPromptPrefix: endpoint?.systemPromptPrefix ?? '',
        systemPromptSuffix: endpoint?.systemPromptSuffix ?? '',
        reasoningPrefillPrefix: endpoint?.reasoningPrefillPrefix ?? '',
        reasoningEffort: endpoint?.genParams.reasoningEffort ?? '',
        ...Object.fromEntries(
          sampling.map(([key]) => [key, String(endpoint?.genParams[key] ?? '')]),
        ),
      });
    },
    data: () => {
      const {
        name,
        baseUrl,
        apiKey,
        prefillMode,
        reasoningEffort,
        systemPromptPrefix,
        systemPromptSuffix,
        reasoningPrefillPrefix,
        ...numeric
      } = form.value();
      const genParams: GenParams = Object.fromEntries(
        Object.entries(numeric)
          .filter(([, value]) => value !== '')
          .map(([key, value]) => [key, Number(value)]),
      );
      if (reasoningEffort)
        genParams.reasoningEffort = reasoningEffort as GenParams['reasoningEffort'];
      return {
        name,
        baseUrl,
        model: model() || null,
        genParams,
        prefillMode: prefillMode as Endpoint['prefillMode'],
        systemPromptPrefix,
        systemPromptSuffix,
        reasoningPrefillPrefix,
        // An empty field preserves the stored key unless explicitly cleared.
        ...(!editingExisting() || apiKey !== '' || keyCleared() ? { apiKey } : {}),
      };
    },
    create: async (data) => {
      const endpoint = await api.endpoints.create(data);
      setEditingExisting(true);
      setKeyCleared(false);
      return endpoint;
    },
    patch: async (id, data) => {
      const endpoint = await api.endpoints.patch(id, data);
      setKeyCleared(false);
      return endpoint;
    },
    deletePrompt: 'Delete this endpoint?',
    initialId: () => state.settings.activeEndpointId,
    emptySelection: 'new',
    activate: (id) => selectSettingsEntity('activeEndpointId', id),
  });

  const fetchModels = async () => {
    const id = editor.selectedId();
    if (typeof id !== 'number') return;
    editor.setStatus('Fetching models…', 'info');
    try {
      const models = await api.endpoints.models(id);
      editor.setStatus(`${models.length} models available.`, 'success');
      if (!model() && models.length > 0) setModel(models[0]!);
    } catch (err) {
      editor.setStatus(errorMessage(err));
    }
  };

  const models = () => editor.selected()?.models ?? [];

  return (
    <EntityEditorPane
      editor={editor}
      transferType="endpoints"
      items={state.endpoints}
      itemLabel={(ep) => ep.name}
      newLabel="New endpoint"
      activeId={state.settings.activeEndpointId}
    >
      <section class="settings-section">
        <h3>Connection</h3>
        <FormField field={form.fields.name} label="Name" placeholder="Local llama.cpp" />
        <FormField
          field={form.fields.baseUrl}
          label="Base URL"
          placeholder="http://192.168.1.10:8080/v1"
          hint="OpenAI-compatible URL through the `/v1` segment."
        />
        <SettingLabel
          field={keyEl}
          changed={keyEl.changed() || (Boolean(editor.selected()?.hasApiKey) && !keyCleared())}
          onRevert={() => {
            keyEl.reset();
            setKeyCleared(true);
          }}
        >
          API key
        </SettingLabel>
        <p class="hint">Optional. Stored server-side and never returned to the browser.</p>
        <div class="key-row flex items-center gap-2 [&_input]:flex-1 [&_input]:min-w-0 [&_.select-btn]:flex-1 [&_.select-btn]:min-w-0 [&>button:not(.select-btn)]:whitespace-nowrap [&>button:not(.select-btn)]:shrink-0">
          <input
            ref={keyEl.ref}
            placeholder={
              keyCleared()
                ? 'Will be removed on save'
                : editor.selected()?.hasApiKey
                  ? 'Configured — enter to replace'
                  : 'sk-…'
            }
          />
        </div>

        <SettingLabel changed={model() !== ''} onRevert={() => setModel('')}>
          Model
        </SettingLabel>
        <p class="hint">Optional; leave blank to use the endpoint default.</p>
        <div class="key-row flex items-center gap-2 [&_input]:flex-1 [&_input]:min-w-0 [&_.select-btn]:flex-1 [&_.select-btn]:min-w-0 [&>button:not(.select-btn)]:whitespace-nowrap [&>button:not(.select-btn)]:shrink-0">
          <Show
            when={models().length > 0}
            fallback={
              <input
                value={model()}
                onInput={(e) => setModel(e.currentTarget.value)}
                placeholder="model id (blank uses endpoint default)"
              />
            }
          >
            <Select
              value={model()}
              ariaLabel="Endpoint model"
              onChange={setModel}
              options={[
                { value: '', label: '— endpoint default —' },
                ...(model() && !models().includes(model())
                  ? [{ value: model(), label: `${model()} (custom)` }]
                  : []),
                ...models().map((m) => ({ value: m, label: m })),
              ]}
            />
          </Show>
          <Show when={typeof editor.selectedId() === 'number'}>
            <button onClick={() => void fetchModels()}>Fetch models</button>
          </Show>
        </div>
      </section>

      <section class="settings-section">
        <h3>Global prompt additions</h3>
        <p class="hint">
          Apply to every request using this endpoint, including chats, media prompts, and background
          tasks. Text is joined exactly as entered; include any spaces or line breaks you need.
        </p>
        <FormField
          field={form.fields.systemPromptPrefix}
          label="System prompt prefix"
          kind="textarea"
          rows={4}
          hint="Added before the assembled system prompt."
        />
        <FormField
          field={form.fields.systemPromptSuffix}
          label="System prompt suffix"
          kind="textarea"
          rows={4}
          hint="Added after the assembled system prompt. If there is no system prompt, the prefix and suffix form one."
        />
        <FormField
          field={form.fields.reasoningPrefillPrefix}
          label="Reasoning prefill prefix"
          kind="textarea"
          rows={4}
          hint="Added before the prompt template's reasoning prefill, or used on its own when that is empty. Requires prefill support to be enabled."
        />
      </section>

      <section class="settings-section">
        <h3>Advanced generation</h3>
        <p class="hint">Empty sampling fields are omitted so backend defaults still apply.</p>
        <div
          class="grid gap-3 mt-2 field-group grid-cols-[repeat(auto-fit,_minmax(140px,_1fr))]"
          role="group"
          aria-label="Sampling parameters"
        >
          <For each={sampling}>
            {([key, label, step, min, max]) => (
              <div>
                <FormField
                  field={form.fields[key]}
                  label={label}
                  kind="number"
                  step={step}
                  min={min}
                  max={max}
                />
              </div>
            )}
          </For>
          <div>
            <FormField
              field={form.fields.reasoningEffort}
              label="Reasoning effort"
              options={[
                { value: '', label: '— omit —' },
                ...['none', 'minimal', 'low', 'medium', 'high', 'max'].map((value) => ({
                  value,
                  label: value,
                })),
              ]}
            />
          </div>
        </div>

        <FormField
          field={form.fields.prefillMode}
          label="Prefill support"
          hint="Used by resume, speaker-name, and template prefills."
          options={[
            { value: 'disabled', label: 'Disabled (do not send prefills)' },
            { value: 'none', label: 'Generic (trailing assistant message)' },
            { value: 'vllm', label: 'vLLM (continue_final_message)' },
            { value: 'deepseek', label: 'DeepSeek beta (prefix flag, needs /beta base URL)' },
          ]}
        />
      </section>
    </EntityEditorPane>
  );
}
