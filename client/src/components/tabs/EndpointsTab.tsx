import { Show, createSignal } from 'solid-js';
import type { Endpoint, GenParams } from '@tinytavern/shared';
import { api } from '../../state/api.ts';
import { selectSettingsEntity } from '../../state/settingsSelection.ts';
import { state } from '../../state/store.ts';
import { createEntityEditor, errorMessage } from '../../util.ts';
import EntityEditorPane from '../EntityEditorPane.tsx';
import Select from '../Select.tsx';
import type { SelectHandle } from '../Select.tsx';

export default function EndpointsTab() {
  const [model, setModel] = createSignal('');
  const [keyCleared, setKeyCleared] = createSignal(false);
  const [editingExisting, setEditingExisting] = createSignal(false);
  let nameEl!: HTMLInputElement;
  let urlEl!: HTMLInputElement;
  let keyEl!: HTMLInputElement;
  let tempEl!: HTMLInputElement;
  let topPEl!: HTMLInputElement;
  let minPEl!: HTMLInputElement;
  let maxTokEl!: HTMLInputElement;
  let freqEl!: HTMLInputElement;
  let presEl!: HTMLInputElement;
  let effortEl!: SelectHandle;
  let prefillEl!: SelectHandle;

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
      items={state.endpoints}
      itemLabel={(ep) => ep.name}
      newLabel="New endpoint"
      activeId={state.settings.activeEndpointId}
      defaultOption={{
        label: 'No active endpoint',
        description: 'Select or create an endpoint before starting a generation.',
      }}
      extraActions={<button onClick={() => void fetchModels()}>Fetch models</button>}
    >
      <section class="settings-section">
        <h3>Connection</h3>
        <label>Name</label>
        <input ref={nameEl} placeholder="Local llama.cpp" />
        <label>Base URL</label>
        <p class="hint">OpenAI-compatible URL through the `/v1` segment.</p>
        <input ref={urlEl} placeholder="http://192.168.1.10:8080/v1" />
        <label>API key</label>
        <p class="hint">Optional. Stored server-side and never returned to the browser.</p>
        <div class="key-row">
          <input
            ref={keyEl}
            placeholder={
              keyCleared()
                ? 'Will be removed on save'
                : editor.selected()?.hasApiKey
                  ? 'Configured — enter to replace'
                  : 'sk-…'
            }
          />
          <Show when={editor.selected()?.hasApiKey && !keyCleared()}>
            <button
              onClick={() => {
                keyEl.value = '';
                setKeyCleared(true);
              }}
            >
              Clear key
            </button>
          </Show>
        </div>

        <label>Model</label>
        <p class="hint">Optional; leave blank to use the endpoint default.</p>
        <Show
          when={models().length > 0}
          fallback={
            <input
              value={model()}
              onChange={(e) => setModel(e.currentTarget.value)}
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
      </section>

      <details class="settings-section settings-disclosure">
        <summary>Advanced generation</summary>
        <div class="settings-section-body">
          <p class="hint">Empty sampling fields are omitted so backend defaults still apply.</p>
          <div class="param-grid">
            <div>
              <label>Temperature</label>
              <input ref={tempEl} type="number" step="0.05" min="0" max="2" />
            </div>
            <div>
              <label>Top P</label>
              <input ref={topPEl} type="number" step="0.05" min="0" max="1" />
            </div>
            <div>
              <label>Min P</label>
              <input ref={minPEl} type="number" step="0.01" min="0" max="1" />
            </div>
            <div>
              <label>Max tokens</label>
              <input ref={maxTokEl} type="number" step="1" min="1" />
            </div>
            <div>
              <label>Freq. penalty</label>
              <input ref={freqEl} type="number" step="0.05" min="-2" max="2" />
            </div>
            <div>
              <label>Pres. penalty</label>
              <input ref={presEl} type="number" step="0.05" min="-2" max="2" />
            </div>
            <div>
              <label>Reasoning effort</label>
              <Select
                ref={effortEl}
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

          <label>Prefill support</label>
          <p class="hint">Used by resume, speaker-name, and template prefills.</p>
          <Select
            ref={prefillEl}
            ariaLabel="Prefill support"
            options={[
              { value: 'disabled', label: 'Disabled (do not send prefills)' },
              { value: 'none', label: 'Generic (trailing assistant message)' },
              { value: 'vllm', label: 'vLLM (continue_final_message)' },
              { value: 'deepseek', label: 'DeepSeek beta (prefix flag, needs /beta base URL)' },
            ]}
          />
        </div>
      </details>
    </EntityEditorPane>
  );
}
