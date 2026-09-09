import { nextCollectionId } from '@tinytavern/shared';
import SettingsTransferButtons from '../SettingsTransferButtons.tsx';
import { importPromptCollection, transferObject } from '@tinytavern/shared';
import { For, Show } from 'solid-js';
import {
  MEDIA_OPERATIONS,
  mediaInputSlots,
  operationHasReferences,
  defaultMediaPrompt,
  defaultChatMediaPrompt,
  mediaPromptSettingsKey,
  type MediaOperation,
  type MediaPromptPreset,
  type MediaPromptSettings,
  type StandalonePromptTemplate,
} from '@tinytavern/shared';
import SettingLabel, { createDefaultField, type DefaultField } from '../SettingField.tsx';
import MacroHelp from '../MacroHelp.tsx';
import MacroTextarea from '../MacroTextarea.tsx';
import NamedCollectionToolbar, {
  type NamedCollectionToolbarHandle,
} from '../NamedCollectionToolbar.tsx';
import { uniqueCollectionName } from '../../state/collectionNames.ts';
import { mediaSettingsDraft } from './mediaSettingsDraft.tsx';

const FIELDS: [keyof StandalonePromptTemplate, string][] = [
  ['systemPrompt', 'System instructions'],
  ['userMessage', 'User message template'],
  ['reasoningPrefill', 'Reasoning prefill'],
  ['messagePrefill', 'Assistant prefill'],
];

function MediaPromptFields(props: {
  mode: 'chat' | 'gallery';
  kind: 'image' | 'video';
  value: MediaPromptSettings;
  onError: (error: string) => void;
  onChange: (update: (value: MediaPromptSettings) => MediaPromptSettings) => void;
}) {
  const form = { draft: () => props.value, setDraft: props.onChange };
  const Group = (group: { operation: MediaOperation; label: string }) => {
    let toolbar!: NamedCollectionToolbarHandle;
    const selected = () => form.draft().defaults[group.operation] ?? '';
    const defaults = defaultMediaPrompt(group.operation);
    const inputSlots = mediaInputSlots(
      group.operation,
      operationHasReferences(group.operation) ? 3 : 0,
    );
    const inputLabels = {
      source: 'source image',
      first_frame: 'first-frame image',
      reference1: 'reference image 1',
      reference2: 'reference image 2',
      reference3: 'reference image 3',
    };
    const macroKeys = [
      'instruction',
      'prompt',
      'char',
      'user',
      ...inputSlots.map((slot) => `${slot}_prompt`),
    ];
    const conditionalKey = inputSlots.length ? `${inputSlots[0]}_prompt` : 'instruction';
    const inputMacroHelp: [string, string][] = [
      ...inputSlots.map((slot): [string, string] => [
        `{{${slot}_prompt}}`,
        `Saved prompt for the ${inputLabels[slot]}; editable in gallery details, empty if none.`,
      ]),
      [
        `{{#if ${conditionalKey}}}…{{/if}}`,
        'Include this block only when the macro has a nonempty value. Works with any available macro.',
      ],
    ];
    const fields = Object.fromEntries(
      FIELDS.map(([key]) => [key, createDefaultField(() => defaults[key])]),
    ) as Record<keyof StandalonePromptTemplate, DefaultField<string>>;
    const chatPrompt = createDefaultField(() => defaultChatMediaPrompt(group.operation));
    const presets = () => form.draft().presets.filter((item) => item.operation === group.operation);
    const current = () => presets().find((item) => item.id === selected());
    const chatText = () => {
      const preset = current();
      return preset && 'chatPrompt' in preset
        ? preset.chatPrompt
        : defaultChatMediaPrompt(group.operation);
    };
    const galleryValue = (key: keyof StandalonePromptTemplate) => {
      const preset = current();
      return preset && 'systemPrompt' in preset ? preset[key] : defaults[key];
    };
    const patch = (changes: Partial<MediaPromptPreset>) =>
      form.setDraft((value) => ({
        ...value,
        presets: value.presets.map((item) =>
          item.id === selected() ? { ...item, ...changes } : item,
        ),
      }));
    const add = (copy = false) => {
      const id = nextCollectionId(form.draft().presets);
      const source = current();
      const baseName = copy && source ? `${source.name} (copy)` : 'New preset';
      const name = uniqueCollectionName(baseName, presets());
      form.setDraft((value) => ({
        ...value,
        defaults: { ...value.defaults, [group.operation]: id },
        presets: [
          ...value.presets,
          {
            ...(props.mode === 'chat'
              ? { chatPrompt: defaultChatMediaPrompt(group.operation) }
              : defaults),
            ...source,
            id,
            name,
            operation: group.operation,
          },
        ],
      }));
    };
    const remove = () => {
      const id = selected();
      form.setDraft((value) => ({
        ...value,
        presets: value.presets.filter((item) => item.id !== id),
        defaults: Object.fromEntries(
          Object.entries(value.defaults).filter(([, preset]) => preset !== id),
        ),
      }));
    };
    const select = (id: string) => {
      form.setDraft((value) => {
        const defaults = { ...value.defaults };
        if (id) {
          defaults[group.operation] = id;
        } else {
          delete defaults[group.operation];
        }
        return { ...value, defaults };
      });
    };
    return (
      <section class="settings-section">
        <h3>{group.label}</h3>
        <div
          class="form-stack field-group"
          role="group"
          aria-label={`${group.label} preset editor`}
        >
          <label>Saved presets</label>
          <NamedCollectionToolbar
            ref={toolbar}
            ariaLabel={`${group.label} saved prompt presets`}
            selected={selected()}
            options={[
              { value: '', label: 'Default' },
              ...presets().map((item) => ({ value: item.id, label: item.name })),
            ]}
            hasSelection={!!current()}
            name={current()?.name ?? ''}
            nameLabel="Preset name"
            onRename={(name) => patch({ name })}
            onSelect={select}
            onNew={() => add()}
            onDuplicate={() => add(true)}
            onDelete={remove}
          >
            <SettingsTransferButtons
              type={`media-prompt:${props.mode}:${group.operation}`}
              onError={props.onError}
              exportData={() => {
                const preset = current();
                if (preset) {
                  const { id, ...value } = preset;
                  return value;
                }
                return {
                  name: 'Default (imported)',
                  operation: group.operation,
                  ...(props.mode === 'chat'
                    ? { chatPrompt: defaultChatMediaPrompt(group.operation) }
                    : defaults),
                };
              }}
              importData={(data) => {
                const source = transferObject(data);
                if (source.operation !== group.operation)
                  throw new Error('This preset belongs to another operation');
                const previous = current();
                const imported = importPromptCollection(
                  { presets: [source], defaults: {} },
                  {
                    presets: previous ? [{ ...previous, name: String(source.name) }] : [],
                    defaults: {},
                  },
                  props.mode === 'chat',
                  props.kind === 'video',
                ).presets[0]!;
                form.setDraft((value) => ({
                  ...value,
                  presets: previous
                    ? value.presets.map((item) => (item.id === previous.id ? imported : item))
                    : [...value.presets, imported],
                  defaults: { ...value.defaults, [group.operation]: imported.id },
                }));
                toolbar.closeRename();
              }}
            />
          </NamedCollectionToolbar>
          <Show when={props.mode === 'chat'}>
            <SettingLabel field={current() ? chatPrompt : undefined}>
              Chat steering template{' '}
              <MacroHelp
                rows={[
                  ['{{instruction}}', 'Your generation instruction'],
                  ['{{prompt}}', 'The original prompt when revising'],
                  ['{{char}} / {{user}}', 'Character and persona names'],
                  ...inputMacroHelp,
                ]}
              />
            </SettingLabel>
            <MacroTextarea
              readOnly={!current()}
              ref={chatPrompt.ref}
              value={chatText()}
              rows={12}
              template
              keys={macroKeys}
              onText={(value) => {
                if (current() && chatText() !== value) {
                  patch({ chatPrompt: value });
                }
              }}
            />
            <p class="hint">
              Appended after the chat history. The chat's system prompt and reasoning prefill are
              retained. Put all media formatting instructions here.
            </p>
          </Show>
          <Show when={props.mode === 'gallery'}>
            <For each={FIELDS}>
              {([key, label]) => (
                <>
                  <SettingLabel field={current() ? fields[key] : undefined}>
                    {label}{' '}
                    <MacroHelp
                      rows={[
                        ['{{instruction}}', 'Your generation instruction'],
                        ['{{prompt}}', 'The original prompt when revising'],
                        ...inputMacroHelp,
                      ]}
                    />
                  </SettingLabel>
                  <MacroTextarea
                    readOnly={!current()}
                    ref={fields[key].ref}
                    value={galleryValue(key)}
                    rows={key.endsWith('Prefill') ? 3 : 7}
                    template
                    keys={macroKeys}
                    onText={(value) => {
                      if (current() && galleryValue(key) !== value) patch({ [key]: value });
                    }}
                  />
                </>
              )}
            </For>
          </Show>
          <Show when={!current()}>
            <span class="prompt-preset-status">
              Built-in default · create a preset to customize
            </span>
          </Show>
        </div>
      </section>
    );
  };
  return (
    <For each={MEDIA_OPERATIONS.filter((item) => item.kind === props.kind)}>
      {(operation) => <Group operation={operation.id} label={operation.label} />}
    </For>
  );
}

function MediaPromptsPage(props: { kind: 'image' | 'video'; mode: 'chat' | 'gallery' }) {
  const form = mediaSettingsDraft(
    mediaPromptSettingsKey(props.kind === 'image' ? 'image' : 'video', props.mode === 'chat'),
  );
  return (
    <div class="form">
      <MediaPromptFields
        kind={props.kind}
        mode={props.mode}
        value={form.draft()}
        onChange={form.setDraft}
        onError={form.setError}
      />
      <form.Actions />
    </div>
  );
}

export function GalleryImagePromptsTab() {
  return <MediaPromptsPage kind="image" mode="gallery" />;
}

export function ChatVideoPromptsTab() {
  return <MediaPromptsPage kind="video" mode="chat" />;
}

export function GalleryVideoPromptsTab() {
  return <MediaPromptsPage kind="video" mode="gallery" />;
}
