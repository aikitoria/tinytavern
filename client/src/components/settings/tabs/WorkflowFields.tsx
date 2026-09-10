import { entityOptions, editReferencedEntity } from '../../../state/entityReferences.ts';
import SettingsSection from '../SettingsSection.tsx';
import { For, Show, createMemo } from 'solid-js';
import {
  compileMediaWorkflow,
  mediaPromptSettingsKey,
  type MediaWorkflow,
  type MediaInputContext,
  type MediaInputSource,
} from '@tinytavern/shared';
import { state } from '../../../state/store.ts';
import FormField from '../../forms/FormFields.tsx';
import { RevertButton } from '../../forms/SettingField.tsx';
import Select from '../../ui/Select.tsx';

export default function WorkflowFields(props: {
  workflow: MediaWorkflow;
  onChange: (value: Partial<MediaWorkflow>) => void;
}) {
  const current = () => props.workflow;
  const patch = props.onChange;
  const compiled = createMemo(() => {
    try {
      const json = current()?.json;
      return { workflow: json?.trim() ? compileMediaWorkflow(json) : null, error: '' };
    } catch (err) {
      return { workflow: null, error: err instanceof Error ? err.message : String(err) };
    }
  });
  const bind = (context: MediaInputContext, slot: string, source: string) => {
    const inputBindings = structuredClone(current()!.inputBindings);
    const values = inputBindings[context] ?? {};
    if (source) values[slot] = source as MediaInputSource;
    else delete values[slot];
    if (Object.keys(values).length) inputBindings[context] = values;
    else delete inputBindings[context];
    patch({ inputBindings });
  };
  return (
    <>
      <FormField
        label="Workflow JSON"
        kind="macro"
        value={current()?.json ?? ''}
        defaultValue=""
        onChange={(json) => {
          if (current()?.json !== json) patch({ json });
        }}
        rows={12}
        mono
        keys={[
          'prompt',
          'seed',
          'job_id',
          ...(compiled().workflow?.imageInputs.map((input) => input.name) ?? []),
        ]}
        placeholder="Paste a Comfy API-format workflow"
      />
      <Show when={compiled().error}>
        <p class="notice notice-error" role="alert">
          {compiled().error}
        </p>
      </Show>
      <For each={['standalone', 'chat'] as const}>
        {(mode) => {
          const field = mode === 'chat' ? 'chatPromptPresetId' : 'standalonePromptPresetId';
          return (
            <FormField
              label={mode === 'chat' ? 'Chat prompt preset' : 'Standalone prompt preset'}
              value={current()?.[field] ?? ''}
              defaultValue=""
              options={[
                {
                  value: '',
                  label: 'Use context default',
                  edit: () =>
                    editReferencedEntity(
                      mediaPromptSettingsKey(mode === 'chat'),
                      state.settings[mediaPromptSettingsKey(mode === 'chat')].defaultPresetId ??
                        'default',
                    ),
                },
                ...entityOptions(
                  mediaPromptSettingsKey(mode === 'chat'),
                  state.settings[mediaPromptSettingsKey(mode === 'chat')].presets,
                ),
              ]}
              onChange={(value) => patch({ [field]: value || null })}
            />
          );
        }}
      </For>
      <FormField
        label="Text output node"
        value={current()?.textOutputNodeId ?? ''}
        defaultValue=""
        options={[
          { value: '', label: 'Return media assets' },
          ...Object.entries(compiled().workflow?.graph ?? {}).map(([id, raw]) => {
            const node = raw as { class_type?: string; _meta?: { title?: string } };
            return {
              value: id,
              label: `${id}: ${node?._meta?.title ?? node?.class_type ?? 'Node'}`,
            };
          }),
        ]}
        onChange={(value) => patch({ textOutputNodeId: value || null })}
        hint="For description workflows, choose the node whose history output contains the text. Images and videos are detected from returned assets."
      />
      <Show when={compiled().workflow?.imageInputs.length}>
        <h4 class="m-0 text-sm">Automatic inputs</h4>
        <p class="hint">Fill empty image inputs from these sources.</p>
        <div class="overflow-x-auto">
          <table class="settings-table w-full">
            <thead>
              <tr>
                <th scope="col">Input</th>
                <th scope="col">Standalone</th>
                <th scope="col">Chat</th>
                <th scope="col">Avatar</th>
              </tr>
            </thead>
            <tbody>
              <For each={compiled().workflow?.imageInputs ?? []}>
                {(input) => (
                  <tr>
                    <th scope="row">{input.label}</th>
                    <For each={['standalone', 'chat', 'avatar'] as const}>
                      {(context) => (
                        <td>
                          <div class="flex items-center gap-1 min-w-36 [&_.select-control]:flex-1 [&_.select-control]:min-w-0">
                            <Select
                              ariaLabel={`${input.label}: ${context}`}
                              value={current()?.inputBindings[context]?.[input.name] ?? ''}
                              options={[
                                { value: '', label: 'Fill manually' },
                                ...(compiled().workflow?.imageInputs ?? []).map((_, index) => ({
                                  value: `selected:${index + 1}`,
                                  label: `Selected image ${index + 1}`,
                                })),
                                { value: 'character-avatar', label: 'Character avatar' },
                                { value: 'persona-avatar', label: 'Persona avatar' },
                              ]}
                              onChange={(source) => bind(context, input.name, source)}
                            />
                            <RevertButton
                              changed={Boolean(current()?.inputBindings[context]?.[input.name])}
                              onRevert={() => bind(context, input.name, '')}
                            />
                          </div>
                        </td>
                      )}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </>
  );
}

export function WorkflowSetupHelp() {
  return (
    <SettingsSection title="Workflow setup help" id="workflow-help" fields={[]}>
      <p>
        Export an API-format workflow with node titles included. TinyTavern preserves the graph and
        binds only the inputs you expose.
      </p>
      <ul>
        <li>
          Prompt: use a primitive Text node containing <code>{'{{prompt}}'}</code>, or title a text
          constant <code>Prompt [prompt]</code>.
        </li>
        <li>
          Images: title a Load Image node <code>Subject [image:subject]</code>. Names use lowercase
          letters, digits and underscores. Reuse a name to feed the same image to multiple loaders.
        </li>
        <li>
          Custom nodes: specify the literal filename/text field, for example{' '}
          <code>Subject [image:subject, field=filename]</code> or{' '}
          <code>Prompt [prompt, field=text]</code>. Connected fields cannot be overwritten.
        </li>
        <li>
          Media prompt presets use <code>{'{{input1_prompt}}'}</code>,{' '}
          <code>{'{{input2_prompt}}'}</code>, and so on for the saved prompts of input images, in
          editor order. Input names and labels do not change these macros.
        </li>
        <li>
          Controls: use constant-node titles such as{' '}
          <code>Steps [input: min=1, max=100, step=1]</code>, <code>Style [input]</code>,{' '}
          <code>Negative prompt [input]</code>, or <code>Resolution [input]</code>. Add{' '}
          <code>order=0</code> to control ordering. Existing limits and defaults are retained.
        </li>
        <li>
          Seeds: keep seed inputs numeric. Seeds are randomized per render; exposed seed controls
          retain their chosen values.
        </li>
        <li>
          Outputs: use one final media output node, including batches. Images and AV1 WebM videos
          share the same execution path. For text, select the output node above.
        </li>
      </ul>
    </SettingsSection>
  );
}
