import { For, Show, createMemo, createSignal } from 'solid-js';
import SettingsSection from '../SettingsSection.tsx';
import { unwrap } from 'solid-js/store';
import {
  nextCollectionId,
  namedItem,
  settingsFields,
  settingsReference,
  exportPromptCollection,
  importPromptCollection,
  defaultMediaPrompt,
  defaultChatMediaPrompt,
  mediaPromptSettingsKey,
  MEDIA_INPUT_PROMPT_KEYS,
  MAX_MEDIA_INPUTS,
  type MediaPromptPreset,
  type StandalonePromptTemplate,
} from '@tinytavern/shared';
import { state } from '../../../state/store.ts';
import { selectMediaPromptPreset } from '../../../state/settingsSelection.ts';
import { createEntityEditor } from '../../../util.ts';
import FormField from '../../forms/FormFields.tsx';
import MacroHelp from '../../forms/MacroHelp.tsx';
import EntityEditorPane from '../EntityEditorPane.tsx';
import SettingsTransferButtons from '../SettingsTransferButtons.tsx';
import { createFolderBrowser } from '../FolderEntityList.tsx';
import { useSettingsNavigation } from '../SettingsGuard.tsx';
import { settingsCollection } from './settingsCollection.ts';

type PromptItem = MediaPromptPreset & { folderId: string | null };

function MediaPromptsPage(props: { chat: boolean }) {
  const key = mediaPromptSettingsKey(props.chat);
  const collection = () => state.settings[key];
  const update = settingsCollection(key);
  const defaults = defaultMediaPrompt();
  const blank = (): PromptItem => ({
    id: '',
    name: '',
    folderId: null,
    ...(props.chat ? { chatPrompt: defaultChatMediaPrompt() } : defaults),
  });
  const [draft, setDraft] = createSignal(blank());
  const folderMap = createMemo(
    () =>
      new Map(
        collection().folders.flatMap((folder) =>
          folder.presetIds.map((id) => [id, folder.id] as const),
        ),
      ),
  );
  const items = createMemo(() =>
    collection().presets.map((preset): PromptItem => ({
      ...preset,
      folderId: folderMap().get(preset.id) ?? null,
    })),
  );
  const write = async (
    id: string,
    data: Partial<PromptItem>,
    creating = false,
  ): Promise<PromptItem> => {
    const next = await update((current) => {
      const existing = current.presets.find((item) => item.id === id);
      if (!creating && !existing) throw new Error('This preset was deleted. Discard to continue.');
      const { folderId: _unused, ...empty } = blank();
      const { folderId, ...fields } = data;
      const preset = { ...empty, ...existing, ...fields, id } as MediaPromptPreset;
      if (folderId && !current.folders.some((folder) => folder.id === folderId))
        throw new Error('The selected folder no longer exists');
      return {
        ...current,
        presets: creating
          ? [...current.presets, preset]
          : current.presets.map((item) => (item.id === id ? preset : item)),
        defaultPresetId: creating ? id : current.defaultPresetId,
        folders:
          folderId === undefined
            ? current.folders
            : current.folders.map((folder) => ({
                ...folder,
                presetIds:
                  folder.id === folderId
                    ? [...folder.presetIds.filter((value) => value !== id), id]
                    : folder.presetIds.filter((value) => value !== id),
              })),
      };
    });
    return {
      ...next.presets.find((item) => item.id === id)!,
      folderId: next.folders.find((folder) => folder.presetIds.includes(id))?.id ?? null,
    };
  };
  const editor = createEntityEditor({
    items,
    initialId: () => collection().defaultPresetId,
    load: (item) => setDraft(structuredClone(unwrap(item ?? blank()))),
    data: () => {
      const { id, ...fields } = draft();
      return fields;
    },
    create: (data) => write(nextCollectionId(collection().presets), data, true),
    patch: (id, data) => write(id, data),
    duplicate: async (id) => {
      const source = items().find((item) => item.id === id);
      if (!source) throw new Error('The preset no longer exists');
      let name = `${source.name} (copy)`;
      for (let index = 2; namedItem(items(), name); index++)
        name = `${source.name} (copy ${index})`;
      return write(nextCollectionId(items()), { ...source, name }, true);
    },
    remove: async (id) => {
      await update((current) => ({
        ...current,
        presets: current.presets.filter((item) => item.id !== id),
        defaultPresetId: current.defaultPresetId === id ? null : current.defaultPresetId,
        folders: current.folders.map((folder) => ({
          ...folder,
          presetIds: folder.presetIds.filter((value) => value !== id),
        })),
      }));
    },
    activate: (id) => selectMediaPromptPreset(key, id),
    deletePrompt: 'Delete this preset?',
  });
  const folders = createFolderBrowser({
    items,
    folders: () => collection().folders,
    folderId: (item) => item.folderId,
    selectedId: editor.selectedId,
    select: editor.select,
    activeId: () => collection().defaultPresetId,
    label: (item) => item.name,
    noun: 'presets',
    create: (name) =>
      update((current) => ({
        ...current,
        folders: [
          ...current.folders,
          { id: nextCollectionId(current.folders), name, presetIds: [] },
        ],
      })),
    rename: (id, name) =>
      update((current) => ({
        ...current,
        folders: current.folders.map((folder) => (folder.id === id ? { ...folder, name } : folder)),
      })),
    remove: (id) =>
      update((current) => ({
        ...current,
        folders: current.folders.filter((folder) => folder.id !== id),
      })),
    onError: editor.setStatus,
  });
  const navigate = useSettingsNavigation();
  const keys = [
    'instruction',
    'no_instruction',
    'prompt',
    'workflow',
    'char',
    'user',
    ...MEDIA_INPUT_PROMPT_KEYS,
  ];
  const value = (field: keyof StandalonePromptTemplate | 'chatPrompt') => {
    const preset = draft();
    if (field === 'chatPrompt')
      return preset && 'chatPrompt' in preset ? preset.chatPrompt : defaultChatMediaPrompt();
    return preset && 'systemPrompt' in preset ? preset[field] : defaults[field];
  };
  const fields: [keyof StandalonePromptTemplate | 'chatPrompt', string][] = props.chat
    ? [['chatPrompt', 'Prompt template']]
    : [
        ['systemPrompt', 'System instructions'],
        ['userMessage', 'User message template'],
        ['reasoningPrefill', 'Reasoning prefill'],
        ['messagePrefill', 'Assistant message prefill'],
      ];

  const promptFields = fields.filter(([field]) => !field.endsWith('Prefill'));
  const prefillFields = fields.filter(([field]) => field.endsWith('Prefill'));
  const Fields = (props: { readOnly?: boolean; prefills?: boolean }) => (
    <>
      <For each={props.prefills ? prefillFields : promptFields}>
        {([field, label]) => (
          <FormField
            label={
              <>
                {label}{' '}
                <MacroHelp
                  rows={[
                    ['{{instruction}}', 'Your generation instruction'],
                    ['{{prompt}}', 'The original prompt when revising'],
                    ['{{workflow}}', 'The selected workflow name'],
                    ['{{char}} / {{user}}', 'Character and persona names in chat'],
                    [
                      '{{input1_prompt}}',
                      'Saved prompt for the first image input listed in the editor; empty if unavailable.',
                    ],
                    [
                      '{{input2_prompt}}',
                      `Saved prompt for the second image input. Continue numbering up to ${MAX_MEDIA_INPUTS}; absent inputs and images without saved prompts give empty text.`,
                    ],
                    [
                      '{{#if input1_prompt}}…{{/if}}',
                      'Include a block only when the first input has a saved prompt.',
                    ],
                    [
                      '{{#if instruction}}…{{/if}}',
                      'Include a block when the variable is nonempty',
                    ],
                    [
                      '{{#if no_instruction}}…{{/if}}',
                      'Include a block when no instruction was entered',
                    ],
                  ]}
                />
              </>
            }
            kind="macro"
            value={value(field)}
            defaultValue={field === 'chatPrompt' ? defaultChatMediaPrompt() : defaults[field]}
            readOnly={props.readOnly}
            rows={field.endsWith('Prefill') ? 3 : 10}
            template
            keys={keys}
            onChange={(text) => {
              if (!props.readOnly && value(field) !== text)
                setDraft((value) => ({ ...value, [field]: text }));
            }}
            hint={
              field === 'chatPrompt'
                ? 'Appended after the full chat history. The conversation system prompt and reasoning prefill are retained.'
                : undefined
            }
          />
        )}
      </For>
    </>
  );
  const Prefills = (props: { readOnly?: boolean }) => (
    <Show when={prefillFields.length}>
      <SettingsSection
        title="Advanced prefills"
        id="media-prompt-prefills"
        fields={prefillFields.map(([field]) => field)}
        disclosure={{
          key: editor.selectedId(),
          hasContent: Boolean(value('reasoningPrefill') || value('messagePrefill')),
        }}
      >
        <Fields readOnly={props.readOnly} prefills />
      </SettingsSection>
    </Show>
  );
  const presetTransfer = () => (
    <SettingsTransferButtons
      type={`media-prompt:${props.chat ? 'chat' : 'standalone'}`}
      onError={editor.setStatus}
      exportData={() => {
        const { id, folderId, ...value } = draft();
        return { ...value, name: value.name || 'Default (imported)' };
      }}
      importData={(data) => {
        const preset = importPromptCollection(
          { presets: [data], defaultPreset: null },
          { folders: [], presets: [], defaultPresetId: null },
          props.chat,
        ).presets[0]!;
        editor.importData({ ...preset, id: draft().id });
      }}
    />
  );
  return (
    <>
      <EntityEditorPane
        editor={editor}
        sectionSchema={settingsFields(
          { ...blank() },
          { folderId: settingsReference(() => collection().folders) },
        )}
        items={items()}
        itemLabel={(item) => item.name}
        newLabel="New"
        activeId={collection().defaultPresetId}
        defaultOption={{
          label: 'Built-in default',
          description: 'Used when a workflow has no explicit prompt preset.',
        }}
        defaultContent={
          <>
            <SettingsSection
              title="Built-in default"
              id={`media-prompt-${props.chat ? 'chat' : 'standalone'}`}
              fields={fields.map(([field]) => field)}
            >
              <Fields readOnly />
            </SettingsSection>
            <Prefills readOnly />
          </>
        }
        defaultActions={
          <>
            <button class="primary-btn" onClick={() => editor.select('new')}>
              Create preset
            </button>
            {presetTransfer()}
          </>
        }
        listActions={<folders.NewButton />}
        listContent={<folders.List />}
        listFooter={
          <SettingsTransferButtons
            type={`page:${key}`}
            importLabel="Import all"
            exportLabel="Export all"
            onError={editor.setStatus}
            exportData={() => exportPromptCollection(collection())}
            importData={(data) =>
              navigate(() => {
                void update((current) => importPromptCollection(data, current, props.chat))
                  .then(() => editor.setStatus('Presets imported.', 'success'))
                  .catch((error) =>
                    editor.setStatus(error instanceof Error ? error.message : String(error)),
                  );
              })
            }
          />
        }
        formActions={presetTransfer()}
      >
        <SettingsSection
          title={props.chat ? 'Chat media prompt' : 'Standalone media prompt'}
          id={`media-prompt-${props.chat ? 'chat' : 'standalone'}`}
          fields={['name', 'folderId', ...fields.map(([field]) => field)]}
        >
          <p class="hint">
            Selecting a preset makes it the default when a workflow has no explicit preset.
          </p>
          <FormField
            label="Name"
            value={draft().name}
            defaultValue=""
            onChange={(name) => setDraft((value) => ({ ...value, name }))}
          />
          <FormField
            label="Folder"
            ariaLabel="Preset folder"
            value={draft().folderId ?? ''}
            defaultValue=""
            options={[{ value: '', label: 'Root' }, ...folders.options()]}
            onChange={(folderId) => setDraft((value) => ({ ...value, folderId: folderId || null }))}
          />
          <Fields />
        </SettingsSection>
        <Prefills />
      </EntityEditorPane>
      <folders.Dialog />
    </>
  );
}
export function ChatMediaPromptsTab() {
  return <MediaPromptsPage chat />;
}
export function StandaloneMediaPromptsTab() {
  return <MediaPromptsPage chat={false} />;
}
