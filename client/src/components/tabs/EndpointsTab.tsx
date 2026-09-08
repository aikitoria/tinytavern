import SettingLabel, { createDefaultField } from '../SettingField.tsx';
import { Show, createSignal } from 'solid-js';
import type { Endpoint, GenParams } from '@tinytavern/shared';
import { api } from '../../state/api.ts';
import { selectSettingsEntity } from '../../state/settingsSelection.ts';
import { state } from '../../state/store.ts';
import { createEntityEditor, errorMessage } from '../../util.ts';
import EntityEditorPane from '../EntityEditorPane.tsx';
import Select from '../Select.tsx';

export default function EndpointsTab() {
  const [model, setModel] = createSignal('');
  const [keyCleared, setKeyCleared] = createSignal(false);
  const [editingExisting, setEditingExisting] = createSignal(false);
  const nameEl = createDefaultField(() => '');
  const urlEl = createDefaultField(() => '');
  const keyEl = createDefaultField(() => '');
  const tempEl = createDefaultField(() => '');
  const topPEl = createDefaultField(() => '');
  const minPEl = createDefaultField(() => '');
  const maxTokEl = createDefaultField(() => '');
  const freqEl = createDefaultField(() => '');
  const presEl = createDefaultField(() => '');
  const effortEl = createDefaultField(() => '');
  const prefillEl = createDefaultField(() => 'none');

  const editor = createEntityEditor({
    items: () => state.endpoints,
    load: (endpoint) => {
      setEditingExisting(endpoint != null);
      nameEl.value = endpoint?.name ?? '';
      urlEl.value = endpoint?.baseUrl ?? '';
      keyEl.value = '';
      setKeyCleared(false);
      setModel(endpoint?.model ?? '');
      tempEl.value = String(endpoint?.genParams.temperature ?? '');
      topPEl.value = String(endpoint?.genParams.topP ?? '');
      minPEl.value = String(endpoint?.genParams.minP ?? '');
      maxTokEl.value = String(endpoint?.genParams.maxTokens ?? '');
      freqEl.value = String(endpoint?.genParams.frequencyPenalty ?? '');
      presEl.value = String(endpoint?.genParams.presencePenalty ?? '');
      effortEl.value = endpoint?.genParams.reasoningEffort ?? '';
      prefillEl.value = endpoint?.prefillMode ?? 'none';
    },
    data: () => {
      const genParams: GenParams = {};
      if (tempEl.value !== '') genParams.temperature = Number(tempEl.value);
      if (topPEl.value !== '') genParams.topP = Number(topPEl.value);
      if (minPEl.value !== '') genParams.minP = Number(minPEl.value);
      if (maxTokEl.value !== '') genParams.maxTokens = Number(maxTokEl.value);
      if (freqEl.value !== '') genParams.frequencyPenalty = Number(freqEl.value);
      if (presEl.value !== '') genParams.presencePenalty = Number(presEl.value);
      if (effortEl.value !== '') {
        genParams.reasoningEffort = effortEl.value as GenParams['reasoningEffort'];
      }
      return {
        name: nameEl.value,
        baseUrl: urlEl.value,
        // An empty field preserves the stored key unless explicitly cleared.
        ...(!editingExisting() || keyEl.value !== '' || keyCleared()
          ? { apiKey: keyEl.value }
          : {}),
        model: model() || null,
        genParams,
        prefillMode: prefillEl.value as Endpoint['prefillMode'],
      };
    },
    create: async (data) => {
      const endpoint = await api.createEndpoint(data);
      setEditingExisting(true);
      setKeyCleared(false);
      return endpoint;
    },
    patch: async (id, data) => {
      const endpoint = await api.patchEndpoint(id, data);
      setKeyCleared(false);
      return endpoint;
    },
    remove: api.deleteEndpoint,
    duplicate: api.duplicateEndpoint,
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
      const models = await api.fetchModels(id);
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
        <SettingLabel field={nameEl}>Name</SettingLabel>
        <input ref={nameEl.ref} placeholder="Local llama.cpp" />
        <SettingLabel field={urlEl}>Base URL</SettingLabel>
        <p class="hint">OpenAI-compatible URL through the `/v1` segment.</p>
        <input ref={urlEl.ref} placeholder="http://192.168.1.10:8080/v1" />
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
        <div class="key-row">
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
        <div class="key-row">
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
        <h3>Advanced generation</h3>
        <p class="hint">Empty sampling fields are omitted so backend defaults still apply.</p>
        <div class="param-grid field-group" role="group" aria-label="Sampling parameters">
          <div>
            <SettingLabel field={tempEl}>Temperature</SettingLabel>
            <input ref={tempEl.ref} type="number" step="0.05" min="0" max="2" />
          </div>
          <div>
            <SettingLabel field={topPEl}>Top P</SettingLabel>
            <input ref={topPEl.ref} type="number" step="0.05" min="0" max="1" />
          </div>
          <div>
            <SettingLabel field={minPEl}>Min P</SettingLabel>
            <input ref={minPEl.ref} type="number" step="0.01" min="0" max="1" />
          </div>
          <div>
            <SettingLabel field={maxTokEl}>Max tokens</SettingLabel>
            <input ref={maxTokEl.ref} type="number" step="1" min="1" />
          </div>
          <div>
            <SettingLabel field={freqEl}>Freq. penalty</SettingLabel>
            <input ref={freqEl.ref} type="number" step="0.05" min="-2" max="2" />
          </div>
          <div>
            <SettingLabel field={presEl}>Pres. penalty</SettingLabel>
            <input ref={presEl.ref} type="number" step="0.05" min="-2" max="2" />
          </div>
          <div>
            <SettingLabel field={effortEl}>Reasoning effort</SettingLabel>
            <Select
              ref={effortEl.ref}
              ariaLabel="Reasoning effort"
              options={[
                { value: '', label: '— omit —' },
                { value: 'none', label: 'none' },
                { value: 'minimal', label: 'minimal' },
                { value: 'low', label: 'low' },
                { value: 'medium', label: 'medium' },
                { value: 'high', label: 'high' },
                { value: 'max', label: 'max' },
              ]}
            />
          </div>
        </div>

        <SettingLabel field={prefillEl}>Prefill support</SettingLabel>
        <p class="hint">Used by resume, speaker-name, and template prefills.</p>
        <Select
          ref={prefillEl.ref}
          ariaLabel="Prefill support"
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
