import { entityOptions, editReferencedEntity } from '../../../state/entityReferences.ts';
import SettingsSection from '../SettingsSection.tsx';
import SettingLabel from '../../forms/SettingField.tsx';
import { createFolderBrowser } from '../FolderEntityList.tsx';
import { For, Show, createSignal } from 'solid-js';
import type { Character } from '@tinytavern/shared';
import { DEFAULT_PROMPT_TEMPLATE } from '@tinytavern/shared';
import { api } from '../../../state/api.ts';
import { state } from '../../../state/store.ts';
import { avatarGenerationAvailable } from '../../../images/imageGeneration.tsx';
import AvatarGenerateModal from '../../../images/AvatarGenerateModal.tsx';
import { createEntityEditor, download, errorMessage } from '../../../util.ts';
import Avatar from '../../ui/Avatar.tsx';
import AvatarRow from '../../forms/AvatarRow.tsx';
import EntityEditorPane from '../EntityEditorPane.tsx';
import FormField, { createFormFields } from '../../forms/FormFields.tsx';
import TemplateFields, { type TemplateFieldsHandle } from '../../forms/TemplateFields.tsx';
import MacroHelp from '../../forms/MacroHelp.tsx';
import MacroTextarea from '../../forms/MacroTextarea.tsx';
import Select from '../../ui/Select.tsx';
import { avatarEditorSnapshot } from '../../../state/editorSync.ts';

export default function CharactersTab() {
  const [customPrompt, setCustomPrompt] = createSignal(false);
  const [customTemplate, setCustomTemplate] = createSignal(false);
  const [avatarGen, setAvatarGen] = createSignal(false);
  const form = createFormFields({
    name: '',
    chatName: '',
    folderId: '',
    personality: '',
    scenario: '',
    examples: '',
    firstMessage: '',
    presetId: '',
    customPrompt: '',
    templateId: '',
    disableBackgroundSwipeGeneration: false,
  });
  let templateFields!: TemplateFieldsHandle;
  let cardInput!: HTMLInputElement;

  const editor = createEntityEditor({
    ...api.characters,
    items: () => state.characters,
    snapshot: avatarEditorSnapshot,
    load: (character) => {
      form.load({
        ...character,
        folderId: String(character?.folderId ?? ''),
        presetId: character?.customPrompt != null ? 'custom' : String(character?.presetId ?? ''),
        templateId: character?.customTemplate != null ? 'custom' : String(character?.templateId ?? ''),
      });
      templateFields.value = character?.customTemplate;
      setCustomPrompt(character?.customPrompt != null);
      setCustomTemplate(character?.customTemplate != null);
    },
    data: () => {
      const promptChoice = form.fields.presetId.value;
      const templateChoice = form.fields.templateId.value;
      return {
        ...form.value(),
        chatName: form.fields.chatName.value.trim() || null,
        folderId: form.fields.folderId.value ? Number(form.fields.folderId.value) : null,
        presetId: promptChoice && promptChoice !== 'custom' ? Number(promptChoice) : null,
        customPrompt: promptChoice === 'custom' ? form.fields.customPrompt.value : null,
        templateId: templateChoice && templateChoice !== 'custom' ? Number(templateChoice) : null,
        customTemplate: templateChoice === 'custom' ? templateFields.value : null,
      };
    },
    deletePrompt: 'Delete this character?',
  });

  const folders = createFolderBrowser({
    items: () => state.characters,
    folders: () => state.characterFolders,
    folderId: (item) => item.folderId,
    selectedId: editor.selectedId,
    select: editor.select,
    label: (item) => (
      <>
        <Avatar src={item.avatarThumbnail} name={item.name} /> {item.name}
      </>
    ),
    noun: 'characters',
    create: (name) => api.entityFolders.characters.create({ name }),
    rename: (id, name) => api.entityFolders.characters.patch(id, { name }),
    remove: api.entityFolders.characters.remove,
    onError: editor.setStatus,
  });

  const importCards = async (files: readonly File[]) => {
    if (files.length === 0) return;
    const current = editor.capture();
    const imported: Character[] = [];
    const failed: string[] = [];
    for (const [index, file] of files.entries()) {
      if (current())
        editor.setStatus(files.length === 1 ? 'Importing…' : `Importing ${index + 1} of ${files.length}…`, 'info');
      try {
        imported.push(await api.characters.importCard(file));
      } catch (err) {
        failed.push(`${file.name}: ${errorMessage(err)}`);
      }
    }
    const last = imported.at(-1);
    if (!current()) return;
    if (last) {
      // Load the response directly to avoid racing WS-triggered list refetches.
      editor.adopt(last);
    }
    if (failed.length > 0) {
      editor.setStatus(`${imported.length} imported, ${failed.length} failed. ${failed.join(' · ')}`);
    } else if (imported.length === 1) {
      editor.setStatus(`Imported ${imported[0]!.name}.`, 'success');
    } else {
      editor.setStatus(`Imported ${imported.length} characters.`, 'success');
    }
  };

  return (
    <>
      <EntityEditorPane
        editor={editor}
        sectionType="characters"
        items={state.characters}
        itemLabel={(character) => (
          <>
            <Avatar src={character.avatarThumbnail} name={character.name} /> {character.name}
          </>
        )}
        newLabel="New"
        listActions={
          <>
            <button title="Import character PNGs" onClick={() => cardInput.click()}>
              Import
            </button>
            <input
              ref={cardInput}
              type="file"
              accept=".png,image/png"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.currentTarget.files ?? []);
                e.currentTarget.value = '';
                void importCards(files);
              }}
            />
          </>
        }
        folderBrowser={folders}
        extraActions={
          <button onClick={() => download(`/api/characters/${editor.selectedId()}/card`)}>Export PNG</button>
        }
      >
        <SettingsSection title="Basics" id="character-basics" fields={['name', 'chatName', 'folderId']}>
          <Show when={editor.selectedId() !== 'new'}>
            <AvatarRow
              src={editor.selected()?.avatar}
              thumbnail={editor.selected()?.avatarThumbnail}
              name={editor.selected()?.name ?? '?'}
              upload={(file) => api.characters.uploadAvatar(editor.selectedId() as number, file)}
              remove={() => api.characters.deleteAvatar(editor.selectedId() as number)}
              generate={avatarGenerationAvailable() ? () => setAvatarGen(true) : undefined}
              onDone={editor.flashSaved}
              onError={editor.setStatus}
            />
            <Show when={avatarGen()}>
              <AvatarGenerateModal
                kind="character"
                id={editor.selectedId() as number}
                onClose={() => setAvatarGen(false)}
              />
            </Show>
          </Show>

          <FormField field={form.fields.name} label="Name" placeholder="Character name" />
          <FormField
            field={form.fields.chatName}
            label="Chat name override"
            placeholder="Use the character name"
            hint="Used for {{char}} and message speaker names. The main name stays in character lists and other UI."
          />
          <FormField
            field={form.fields.folderId}
            label="Folder"
            ariaLabel="Character folder"
            options={[{ value: '', label: 'Root' }, ...folders.options()]}
          />
        </SettingsSection>

        <SettingsSection
          title="Roleplay"
          id="character-roleplay"
          fields={['personality', 'scenario', 'examples', 'firstMessage']}
        >
          <For
            each={
              [
                ['personality', 'Personality', 'Who is {{char}}?'],
                ['scenario', 'Scenario', 'Setting / situation (optional)'],
                [
                  'examples',
                  'Example conversations',
                  'Example dialogue between {{user}} and {{char}} (optional; separate with <START>)',
                ],
                ['firstMessage', 'First message', 'Greeting sent when a chat starts (optional)'],
              ] as const
            }
          >
            {([key, label, placeholder]) => (
              <FormField
                kind="macro"
                field={form.fields[key]}
                label={
                  <>
                    {label} <MacroHelp />
                  </>
                }
                placeholder={placeholder}
              />
            )}
          </For>
        </SettingsSection>

        <SettingsSection
          title="Prompting"
          id="character-prompting"
          fields={['presetId', 'customPrompt', 'templateId', 'customTemplate']}
        >
          <div class="form-stack field-group" role="group" aria-label="System prompt settings">
            <SettingLabel field={form.fields.presetId}>System prompt</SettingLabel>
            <Select
              ref={form.fields.presetId.ref}
              ariaLabel="Character system prompt"
              onChange={(value) => setCustomPrompt(value === 'custom')}
              options={[
                {
                  value: '',
                  label: 'Global default',
                  edit:
                    state.settings.defaultPresetId != null
                      ? () => editReferencedEntity('presets', state.settings.defaultPresetId!)
                      : undefined,
                },
                ...entityOptions('presets', state.presets),
                { value: 'custom', label: 'Custom prompt…' },
              ]}
            />
            <Show when={customPrompt()}>
              <SettingLabel field={form.fields.customPrompt}>
                Custom prompt text <MacroHelp />
              </SettingLabel>
            </Show>
            <MacroTextarea
              ref={form.fields.customPrompt.ref}
              classList={{ hidden: !customPrompt() }}
              placeholder="Custom system prompt for this character"
            />
          </div>
          <div class="form-stack field-group" role="group" aria-label="Prompt template settings">
            <SettingLabel field={form.fields.templateId}>Prompt template</SettingLabel>
            <Select
              ref={form.fields.templateId.ref}
              ariaLabel="Character prompt template"
              onChange={(value) => {
                const custom = value === 'custom';
                setCustomTemplate(custom);
                if (custom && !templateFields.value.content)
                  templateFields.value = {
                    ...templateFields.value,
                    content: DEFAULT_PROMPT_TEMPLATE,
                  };
              }}
              options={[
                {
                  value: '',
                  label: 'Global default',
                  edit:
                    state.settings.defaultTemplateId != null
                      ? () => editReferencedEntity('templates', state.settings.defaultTemplateId!)
                      : undefined,
                },
                ...entityOptions('templates', state.templates),
                { value: 'custom', label: 'Custom template…' },
              ]}
            />
            <div class="form-stack" classList={{ hidden: !customTemplate() }}>
              <TemplateFields ref={templateFields} inline />
            </div>
          </div>
        </SettingsSection>

        <SettingsSection title="Generation" id="character-generation" fields={['disableBackgroundSwipeGeneration']}>
          <FormField
            kind="check"
            field={form.fields.disableBackgroundSwipeGeneration}
            label="Disable background swipe generation"
            hint="Overrides the global setting for all chats with this character."
          />
        </SettingsSection>
      </EntityEditorPane>
    </>
  );
}
