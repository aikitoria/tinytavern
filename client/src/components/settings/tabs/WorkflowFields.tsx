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
        mono
        keys={['prompt', 'seed', 'job_id', ...(compiled().workflow?.mediaInputs.map((input) => input.name) ?? [])]}
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
                      state.settings[mediaPromptSettingsKey(mode === 'chat')].defaultPresetId ?? 'default',
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
      <Show when={compiled().workflow?.mediaInputs.length}>
        <h4 class="m-0 text-sm">Automatic inputs</h4>
        <p class="hint">Fill empty media inputs from these sources.</p>
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
              <For each={compiled().workflow?.mediaInputs ?? []}>
                {(input) => (
                  <tr>
                    <th scope="row">
                      {input.name} · {input.label} ({input.kind})
                    </th>
                    <For each={['standalone', 'chat', 'avatar'] as const}>
                      {(context) => (
                        <td>
                          <div class="flex items-center gap-1 min-w-36 [&_.select-control]:flex-1 [&_.select-control]:min-w-0">
                            <Select
                              ariaLabel={`${input.label}: ${context}`}
                              value={current()?.inputBindings[context]?.[input.name] ?? ''}
                              options={[
                                { value: '', label: 'Fill manually' },
                                ...(compiled().workflow?.mediaInputs ?? []).map((_, index) => ({
                                  value: `selected:${index + 1}`,
                                  label: `Selected media ${index + 1}`,
                                })),
                                ...(input.kind === 'image'
                                  ? [
                                      { value: 'character-avatar', label: 'Character avatar' },
                                      { value: 'persona-avatar', label: 'Persona avatar' },
                                    ]
                                  : []),
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
    <SettingsSection title="Workflow setup" id="workflow-help" class="workflow-setup-help" fields={[]}>
      <p class="m-0 text-sm text-dim">Export your ComfyUI workflow in API format, including node titles.</p>
      <dl>
        <div>
          <dt>Prompt</dt>
          <dd>
            Put <code>{'{{prompt}}'}</code> in a primitive Text node, or name a text node <code>Prompt [prompt]</code>.
          </dd>
        </div>
        <div>
          <dt>Images</dt>
          <dd>
            Name a Load Image node <code>Subject [image:input1]</code>. Use <code>input1</code> through{' '}
            <code>input64</code>; “Subject” is just a label. Reuse a number to share an image between loaders.
          </dd>
        </div>
        <div>
          <dt>Videos</dt>
          <dd>
            Name a native Load Video node <code>Clip [video:input1]</code>. Its file input receives the original video.
            Images and videos share the <code>input1</code> through <code>input64</code> numbering; use a different
            number for each required source. Connect Load Video to Get Video Components when downstream nodes need
            frames.
          </dd>
        </div>
        <div>
          <dt>Controls</dt>
          <dd>
            Name a constant node <code>Style [input]</code> to make it editable. For numeric limits, use{' '}
            <code>Steps [input: min=1, max=100, step=1]</code>. Add <code>order=0</code> inside the brackets to set
            display order. Add a numeric display unit, such as <code>Duration (seconds) [input: unit=s]</code>, to show{' '}
            <code>10 s</code> in the collapsed render summary. The control label and submitted number stay the same.
          </dd>
        </div>
        <div>
          <dt>Seeds</dt>
          <dd>Keep seeds numeric. They are randomized for each render unless exposed as a control.</dd>
        </div>
        <div>
          <dt>Outputs</dt>
          <dd>
            Use one media output node. It can return multiple files from a single run. For descriptions, choose the{' '}
            <strong>Text output node</strong> below.
          </dd>
        </div>
        <div>
          <dt>Custom nodes</dt>
          <dd>
            Specify other filename or text fields in the title: <code>Subject [image:input1, field=filename]</code> or{' '}
            <code>Prompt [prompt, field=text]</code>. Only unconnected text fields can be bound.
          </dd>
        </div>
      </dl>
    </SettingsSection>
  );
}
