import SettingsTransferButtons from '../SettingsTransferButtons.tsx';
import { exportWorkflow, importWorkflow, transferObject } from '@tinytavern/shared';
import { For, Show } from 'solid-js';
import {
  MEDIA_OPERATIONS,
  DEFAULT_MEDIA_RENDERING,
  mediaWorkflowKey,
  mediaPromptSettingsKey,
  mediaInputSlots,
  operationHasReferences,
  type MediaOperation,
  type MediaWorkflow,
} from '@tinytavern/shared';
import { state } from '../../state/store.ts';
import SettingLabel, { createDefaultField } from '../SettingField.tsx';
import Select from '../Select.tsx';
import NamedCollectionToolbar, {
  type NamedCollectionToolbarHandle,
} from '../NamedCollectionToolbar.tsx';
import { uniqueCollectionName } from '../../state/collectionNames.ts';
import MacroTextarea from '../MacroTextarea.tsx';
import MacroHelp from '../MacroHelp.tsx';
import { mediaSettingsDraft } from './mediaSettingsDraft.tsx';

export default function MediaRenderingTab() {
  const form = mediaSettingsDraft('mediaRendering');
  const url = createDefaultField(() => DEFAULT_MEDIA_RENDERING.comfyUrl);
  const timeout = createDefaultField(() => String(DEFAULT_MEDIA_RENDERING.jobTimeoutSeconds));
  const avatar = createDefaultField(() => '');
  const updateWorkflow = (id: string, patch: Partial<MediaWorkflow>) =>
    form.setDraft((current) => ({
      ...current,
      workflows: current.workflows.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  const Group = (props: {
    operation: MediaOperation;
    label: string;
    referenceCount: MediaWorkflow['referenceCount'];
  }) => {
    let toolbar!: NamedCollectionToolbarHandle;
    const key = () => mediaWorkflowKey(props.operation, props.referenceCount);
    const workflows = () =>
      form
        .draft()
        .workflows.filter(
          (item) =>
            item.operation === props.operation && item.referenceCount === props.referenceCount,
        );
    const selected = () => form.draft().defaults[key()] ?? '';
    const current = () => workflows().find((item) => item.id === selected());
    const json = createDefaultField(() => '');
    const select = (id: string) => {
      form.setDraft((value) => ({ ...value, defaults: { ...value.defaults, [key()]: id } }));
    };
    const add = (duplicate = false) => {
      const source = current();
      const id = crypto.randomUUID();
      const baseName = duplicate && source ? `${source.name} (copy)` : 'New workflow';
      const name = uniqueCollectionName(baseName, workflows());
      form.setDraft((value) => ({
        ...value,
        defaults: { ...value.defaults, [key()]: id },
        workflows: [
          ...value.workflows,
          {
            id,
            name,
            operation: props.operation,
            referenceCount: props.referenceCount,
            json: source?.json ?? '',
            galleryPromptPresetId: source?.galleryPromptPresetId ?? null,
            chatPromptPresetId: source?.chatPromptPresetId ?? null,
          },
        ],
      }));
    };
    const remove = () => {
      const id = selected();
      const choices = workflows();
      const index = choices.findIndex((item) => item.id === id);
      const next = choices[index + 1] ?? choices[index - 1];
      form.setDraft((value) => {
        const defaults = { ...value.defaults };
        if (next) defaults[key()] = next.id;
        else delete defaults[key()];
        return {
          ...value,
          workflows: value.workflows.filter((item) => item.id !== id),
          defaults,
          avatarWorkflowId: value.avatarWorkflowId === id ? null : value.avatarWorkflowId,
        };
      });
    };
    return (
      <div
        class="form-stack field-group"
        role="group"
        aria-label={`${props.label} workflow editor`}
      >
        <label>
          Saved workflows
          {props.referenceCount > 0
            ? ` · ${props.referenceCount} reference${props.referenceCount === 1 ? '' : 's'}`
            : ''}
        </label>
        <NamedCollectionToolbar
          ref={toolbar}
          ariaLabel={`${props.label} saved workflows`}
          selected={selected()}
          options={workflows().map((item) => ({ value: item.id, label: item.name }))}
          buttonLabel={
            current()?.name ?? (workflows().length ? 'Select a workflow' : 'No saved workflows')
          }
          hasSelection={!!current()}
          name={current()?.name ?? ''}
          nameLabel="Workflow name"
          onRename={(name) => updateWorkflow(selected(), { name })}
          onSelect={select}
          onNew={() => add()}
          onDuplicate={() => add(true)}
          onDelete={remove}
        >
          <SettingsTransferButtons
            type={`workflow:${key()}`}
            onError={form.setError}
            disabledExport={!current()}
            exportData={() => exportWorkflow(current()!, state.settings)}
            importData={(data) => {
              const source = transferObject(data);
              const previous = current();
              const workflow = importWorkflow(
                source,
                previous ? [{ ...previous, name: String(source.name) }] : [],
                state.settings,
              );
              if (
                workflow.operation !== props.operation ||
                workflow.referenceCount !== props.referenceCount
              )
                throw new Error('This workflow belongs to another operation');
              form.setDraft((value) => ({
                ...value,
                workflows: previous
                  ? value.workflows.map((item) => (item.id === previous.id ? workflow : item))
                  : [...value.workflows, workflow],
                defaults: { ...value.defaults, [key()]: workflow.id },
              }));
              toolbar.closeRename();
            }}
          />
        </NamedCollectionToolbar>
        <Show when={current()}>
          <SettingLabel field={json}>
            Workflow JSON
            <Show when={props.operation !== 'image-describe'}>
              <MacroHelp rows={[['{{prompt}}', 'Final prompt text']]} />
            </Show>
          </SettingLabel>
          <MacroTextarea
            ref={json.ref}
            value={current()?.json ?? ''}
            onText={(value) => {
              if (current()?.json !== value) updateWorkflow(selected(), { json: value });
            }}
            rows={12}
            class="mono"
            keys={[
              'prompt',
              'seed',
              'job_id',
              ...mediaInputSlots(props.operation, props.referenceCount),
            ]}
            placeholder="Paste a Comfy API-format workflow"
          />
          <For
            each={
              props.operation === 'image-describe'
                ? []
                : props.operation.startsWith('video')
                  ? (['gallery', 'chat'] as const)
                  : (['gallery'] as const)
            }
          >
            {(mode) => {
              const field = mode === 'chat' ? 'chatPromptPresetId' : 'galleryPromptPresetId';
              const reset = createDefaultField(() => '');
              const presets = () =>
                state.settings[
                  mediaPromptSettingsKey(props.operation, mode === 'chat')
                ].presets.filter((item) => item.operation === props.operation);
              return (
                <Show when={presets().length > 0}>
                  <SettingLabel field={reset}>
                    {mode === 'chat' ? 'Chat prompt preset' : 'Gallery prompt preset'}
                  </SettingLabel>
                  <Select
                    ref={reset.ref}
                    ariaLabel={`${props.label} ${mode} prompt preset`}
                    value={current()?.[field] ?? ''}
                    options={[
                      { value: '', label: `Use ${mode} default` },
                      ...presets().map((item) => ({ value: item.id, label: item.name })),
                    ]}
                    onChange={(value) => updateWorkflow(selected(), { [field]: value || null })}
                  />
                </Show>
              );
            }}
          </For>
        </Show>
      </div>
    );
  };
  return (
    <div class="form">
      <section class="settings-section">
        <h3>Connection</h3>
        <SettingLabel field={url}>ComfyUI URL</SettingLabel>
        <input
          ref={url.ref}
          value={form.draft().comfyUrl}
          onInput={(event) =>
            form.setDraft((value) => ({ ...value, comfyUrl: event.currentTarget.value }))
          }
        />
        <SettingLabel field={timeout}>Maximum job time (seconds)</SettingLabel>
        <input
          ref={timeout.ref}
          type="number"
          min="0"
          max="86400"
          value={form.draft().jobTimeoutSeconds}
          onInput={(event) =>
            form.setDraft((value) => ({
              ...value,
              jobTimeoutSeconds: Number(event.currentTarget.value),
            }))
          }
        />
        <p class="hint">
          0 means no time limit. A limit of 60–86400 seconds applies from submission to completion,
          including queue time. Prompt preparation has a separate inactivity timeout.
        </p>
      </section>
      <section class="settings-section">
        <h3>Avatars</h3>
        <SettingLabel field={avatar}>Avatar workflow</SettingLabel>
        <Select
          ref={avatar.ref}
          ariaLabel="Avatar image workflow"
          value={form.draft().avatarWorkflowId ?? ''}
          options={[
            { value: '', label: 'Same as Create image' },
            ...form
              .draft()
              .workflows.filter((item) => item.operation === 'image')
              .map((item) => ({ value: item.id, label: item.name })),
          ]}
          onChange={(value) =>
            form.setDraft((current) => ({ ...current, avatarWorkflowId: value || null }))
          }
        />
      </section>
      <details class="settings-section">
        <summary>Workflow setup help</summary>
        <ol class="workflow-setup-steps hint">
          <li>
            <strong>Connect the prompt.</strong> Add a Text node from utilities → primitive, enter{' '}
            <code>{'{{prompt}}'}</code>, and connect it to the prompt input. TinyTavern replaces
            this text with your generation prompt. Describe image workflows keep their description
            instruction inside the workflow instead. Using a separate Text node stops Comfy from
            removing the braces during export.
          </li>
          <li>
            <strong>Choose placeholder images, if needed.</strong> In Load Image nodes, select{' '}
            <code>source.png</code> for the image being described, <code>first_frame.png</code> for
            a video's first frame, or <code>reference1.png</code> through{' '}
            <code>reference3.png</code> for reference images. TinyTavern uploads the images you
            select in the tool and replaces these filenames for each render. The placeholder files
            can be in subfolders.
          </li>
          <li>
            <strong>Choose which settings appear in the tool.</strong> Connect a constant node to
            the setting you want to control, then rename it using one of these examples. Its current
            value becomes the default.
            <div class="workflow-setup-table-scroll">
              <table class="workflow-setup-table">
                <thead>
                  <tr>
                    <th scope="col">Node</th>
                    <th scope="col">Example title</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Int</td>
                    <td>
                      <code>Steps [input: min=1, max=100, step=1]</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Float</td>
                    <td>
                      <code>Guidance [input: min=0, max=20, step=0.1]</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Text</td>
                    <td>
                      <code>Style [input]</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Text (Multiline)</td>
                    <td>
                      <code>Negative prompt [input]</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Boolean</td>
                    <td>
                      <code>Enable upscale [input]</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Resolution Selector</td>
                    <td>
                      <code>Resolution [input]</code>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              The text before <code>[input]</code> becomes the field label. Parameters are optional.
              Numbers accept <code>min</code>, <code>max</code>, and <code>step</code>. Text and
              Boolean nodes need only <code>[input]</code>. Text uses a single-line field; Text
              (Multiline) uses a textarea. Boolean nodes become checkboxes.
            </p>
            <p>
              Add <code>order</code> to set a field’s position, for example{' '}
              <code>Duration (seconds) [input: min=1, max=15, order=0]</code>. Use whole numbers:
              lower values appear first. Fields without an order follow afterward. Ties keep their
              node ID order.
            </p>
            <p>
              Resolution Selector adds an aspect-ratio dropdown and a megapixels field (0.1–16, step
              0.1). Its limits and step apply to megapixels; <code>order</code> moves both fields
              together. Leave <code>multiple</code> set in Comfy.
            </p>
          </li>
          <li>
            <strong>Keep the seed inputs as numbers.</strong> TinyTavern randomizes{' '}
            <code>seed</code> and <code>noise_seed</code> for each render, including directly
            connected Int constants. A seed exposed with <code>[input]</code> uses your chosen value
            instead.
          </li>
          <li>
            <strong>Save one output and export.</strong> Use one media output node, such as Save
            Image or VHS Video Combine. You can keep its filename prefix. Export in API format with
            node titles included, then paste the JSON into the matching workflow editor below.
          </li>
        </ol>
      </details>
      <For each={MEDIA_OPERATIONS}>
        {(operation) => (
          <section class="settings-section">
            <h3>{operation.label}</h3>
            <Show when={operation.id === 'image-describe'}>
              <p class="hint">
                Generates text for the Saved prompt field in gallery details. Use source.png in Load
                Image and connect the generated string to one Preview as Text node.
              </p>
            </Show>
            <For
              each={operationHasReferences(operation.id) ? ([1, 2, 3] as const) : ([0] as const)}
            >
              {(count) => (
                <Group
                  operation={operation.id}
                  referenceCount={count}
                  label={`${operation.label}${count ? ` · ${count} reference${count === 1 ? '' : 's'}` : ''}`}
                />
              )}
            </For>
          </section>
        )}
      </For>
      <form.Actions />
    </div>
  );
}
