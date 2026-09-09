import { nextCollectionId } from '@tinytavern/shared';
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
  type StandalonePromptTemplate,
} from '@tinytavern/shared';
import FormField from '../FormFields.tsx';
import MacroHelp from '../MacroHelp.tsx';
import { createNamedCollection } from '../NamedCollectionEditor.tsx';
import { mediaSettingsDraft } from './mediaSettingsDraft.tsx';

const FIELDS: [keyof StandalonePromptTemplate, string][] = [
  ['systemPrompt', 'System instructions'],
  ['userMessage', 'User message template'],
  ['reasoningPrefill', 'Reasoning prefill'],
  ['messagePrefill', 'Assistant prefill'],
];

function MediaPromptsPage(props: { kind: 'image' | 'video'; mode: 'chat' | 'gallery' }) {
  const form = mediaSettingsDraft(mediaPromptSettingsKey(props.kind, props.mode === 'chat'));
  const Group = (group: { operation: MediaOperation; label: string }) => {
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
    const collection = createNamedCollection<MediaPromptPreset>({
      items: () => form.draft().presets,
      filter: (item) => item.operation === group.operation,
      selected,
      identify: (item) => item.id,
      newName: 'New preset',
      defaultLabel: 'Default',
      create: (source, name) => ({
        ...(props.mode === 'chat'
          ? { chatPrompt: defaultChatMediaPrompt(group.operation) }
          : defaults),
        ...source,
        id: nextCollectionId(form.draft().presets),
        name,
        operation: group.operation,
      }),
      commit: (presets, id, removed) =>
        form.setDraft((value) => {
          const defaults = Object.fromEntries(
            Object.entries(value.defaults).filter(([, preset]) => preset !== removed?.id),
          );
          if (id) defaults[group.operation] = id;
          else delete defaults[group.operation];
          return { ...value, presets, defaults };
        }),
    });
    const { current, patch } = collection;
    const value = (key: keyof StandalonePromptTemplate | 'chatPrompt') => {
      const preset = current();
      if (key === 'chatPrompt')
        return preset && 'chatPrompt' in preset
          ? preset.chatPrompt
          : defaultChatMediaPrompt(group.operation);
      return preset && 'systemPrompt' in preset ? preset[key] : defaults[key];
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
          <collection.Toolbar
            ariaLabel={`${group.label} saved prompt presets`}
            nameLabel="Preset name"
            transfer={{
              type: `media-prompt:${props.mode}:${group.operation}`,
              onError: form.setError,
              allowDefaultExport: true,
              exportData: (preset) => {
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
              },
              importData: (data, previous) => {
                const source = transferObject(data);
                if (source.operation !== group.operation)
                  throw new Error('This preset belongs to another operation');
                return importPromptCollection(
                  { presets: [source], defaults: {} },
                  {
                    presets: previous ? [{ ...previous, name: String(source.name) }] : [],
                    defaults: {},
                  },
                  props.mode === 'chat',
                  props.kind === 'video',
                ).presets[0]!;
              },
            }}
          />
          <For
            each={
              props.mode === 'chat' ? [['chatPrompt', 'Chat steering template'] as const] : FIELDS
            }
          >
            {([key, label]) => (
              <FormField
                label={
                  <>
                    {label}{' '}
                    <MacroHelp
                      rows={[
                        ['{{instruction}}', 'Your generation instruction'],
                        ['{{prompt}}', 'The original prompt when revising'],
                        ...(props.mode === 'chat'
                          ? [
                              ['{{char}} / {{user}}', 'Character and persona names'] as [
                                string,
                                string,
                              ],
                            ]
                          : []),
                        ...inputMacroHelp,
                      ]}
                    />
                  </>
                }
                kind="macro"
                readOnly={!current()}
                value={value(key)}
                defaultValue={
                  key === 'chatPrompt' ? defaultChatMediaPrompt(group.operation) : defaults[key]
                }
                rows={key === 'chatPrompt' ? 12 : key.endsWith('Prefill') ? 3 : 7}
                template
                keys={macroKeys}
                onChange={(text) => {
                  if (current() && value(key) !== text) patch({ [key]: text });
                }}
                hint={
                  key === 'chatPrompt'
                    ? "Appended after the chat history. The chat's system prompt and reasoning prefill are retained. Put all media formatting instructions here."
                    : undefined
                }
              />
            )}
          </For>
          <Show when={!current()}>
            <span class="text-dim text-caption">
              Built-in default · create a preset to customize
            </span>
          </Show>
        </div>
      </section>
    );
  };
  return (
    <div class="form [&_label]:text-label [&_label]:text-foreground [&_label]:mt-2">
      <For each={MEDIA_OPERATIONS.filter((item) => item.kind === props.kind)}>
        {(operation) => <Group operation={operation.id} label={operation.label} />}
      </For>
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
