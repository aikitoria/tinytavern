import { nextCollectionId } from '@tinytavern/shared';
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
import FormField from '../FormFields.tsx';
import { createNamedCollection } from '../NamedCollectionEditor.tsx';
import MacroHelp from '../MacroHelp.tsx';
import { mediaSettingsDraft } from './mediaSettingsDraft.tsx';

export default function MediaRenderingTab() {
  const form = mediaSettingsDraft('mediaRendering');
  const Group = (props: {
    operation: MediaOperation;
    label: string;
    referenceCount: MediaWorkflow['referenceCount'];
  }) => {
    const key = () => mediaWorkflowKey(props.operation, props.referenceCount);
    const collection = createNamedCollection<MediaWorkflow>({
      items: () => form.draft().workflows,
      filter: (item) =>
        item.operation === props.operation && item.referenceCount === props.referenceCount,
      selected: () => form.draft().defaults[key()] ?? '',
      identify: (item) => item.id,
      newName: 'New workflow',
      adjacentOnDelete: true,
      create: (source, name) => ({
        id: nextCollectionId(form.draft().workflows),
        name,
        operation: props.operation,
        referenceCount: props.referenceCount,
        json: source?.json ?? '',
        galleryPromptPresetId: source?.galleryPromptPresetId ?? null,
        chatPromptPresetId: source?.chatPromptPresetId ?? null,
      }),
      commit: (workflows, id, removed) =>
        form.setDraft((value) => {
          const defaults = { ...value.defaults };
          if (id || !removed) defaults[key()] = id;
          else delete defaults[key()];
          return {
            ...value,
            workflows,
            defaults,
            avatarWorkflowId:
              removed && value.avatarWorkflowId === removed.id ? null : value.avatarWorkflowId,
          };
        }),
    });
    const { current, patch } = collection;
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
        <collection.Toolbar
          ariaLabel={`${props.label} saved workflows`}
          nameLabel="Workflow name"
          emptyLabel="No saved workflows"
          unselectedLabel="Select a workflow"
          transfer={{
            type: `workflow:${key()}`,
            onError: form.setError,
            exportData: (workflow) => exportWorkflow(workflow!, state.settings),
            importData: (data, previous) => {
              const source = transferObject(data);
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
              return workflow;
            },
          }}
        />
        <Show when={current()}>
          <FormField
            label={
              <>
                Workflow JSON
                <Show when={props.operation !== 'image-describe'}>
                  <MacroHelp rows={[['{{prompt}}', 'Final prompt text']]} />
                </Show>
              </>
            }
            kind="macro"
            value={current()?.json ?? ''}
            defaultValue=""
            onChange={(value) => {
              if (current()?.json !== value) patch({ json: value });
            }}
            rows={12}
            mono
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
              const presets = () =>
                state.settings[
                  mediaPromptSettingsKey(props.operation, mode === 'chat')
                ].presets.filter((item) => item.operation === props.operation);
              return (
                <Show when={presets().length > 0}>
                  <FormField
                    label={mode === 'chat' ? 'Chat prompt preset' : 'Gallery prompt preset'}
                    defaultValue=""
                    ariaLabel={`${props.label} ${mode} prompt preset`}
                    value={current()?.[field] ?? ''}
                    options={[
                      { value: '', label: `Use ${mode} default` },
                      ...presets().map((item) => ({ value: item.id, label: item.name })),
                    ]}
                    onChange={(value) => patch({ [field]: value || null })}
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
    <div class="form [&_label]:text-label [&_label]:text-foreground [&_label]:mt-2">
      <section class="settings-section">
        <h3>Connection</h3>
        <FormField
          label="ComfyUI URL"
          value={form.draft().comfyUrl}
          defaultValue={DEFAULT_MEDIA_RENDERING.comfyUrl}
          onChange={(comfyUrl) => form.setDraft((value) => ({ ...value, comfyUrl }))}
        />
        <FormField
          label="Maximum job time (seconds)"
          kind="number"
          min="0"
          max="86400"
          value={form.draft().jobTimeoutSeconds}
          defaultValue={DEFAULT_MEDIA_RENDERING.jobTimeoutSeconds}
          onChange={(jobTimeoutSeconds) =>
            form.setDraft((value) => ({ ...value, jobTimeoutSeconds: jobTimeoutSeconds || 0 }))
          }
          hint="0 means no time limit. A limit of 60–86400 seconds applies from submission to completion, including queue time. Prompt preparation has a separate inactivity timeout."
        />
      </section>
      <section class="settings-section">
        <h3>Avatars</h3>
        <FormField
          label="Avatar workflow"
          ariaLabel="Avatar image workflow"
          value={form.draft().avatarWorkflowId ?? ''}
          defaultValue=""
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
        <ol class="pl-4 hint [&>li+li]:mt-3 [&_strong]:text-foreground [&_strong]:font-semibold [&_p]:m-0 [&_p]:mt-2">
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
            <div class="overflow-x-auto mt-2">
              <table class="border-collapse w-full text-left text-size-inherit [&_th]:text-foreground [&_th]:font-semibold [&_:is(th,_td)]:py-1 [&_:is(th,_td)]:px-2 [&_:is(th,_td)]:align-top [&_:is(th,_td):first-child]:pl-0">
                <thead>
                  <tr>
                    <th scope="col">Node</th>
                    <th scope="col">Example title</th>
                  </tr>
                </thead>
                <tbody>
                  <For
                    each={[
                      ['Int', 'Steps [input: min=1, max=100, step=1]'],
                      ['Float', 'Guidance [input: min=0, max=20, step=0.1]'],
                      ['Text', 'Style [input]'],
                      ['Text (Multiline)', 'Negative prompt [input]'],
                      ['Boolean', 'Enable upscale [input]'],
                      ['Resolution Selector', 'Resolution [input]'],
                    ]}
                  >
                    {([node, title]) => (
                      <tr>
                        <td>{node}</td>
                        <td>
                          <code>{title}</code>
                        </td>
                      </tr>
                    )}
                  </For>
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
