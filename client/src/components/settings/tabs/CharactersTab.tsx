import SettingLabel, { createDefaultField } from '../../forms/SettingField.tsx';
import { faChevronDown, faChevronRight, faPen, faXmark } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from '../../ui/FontAwesomeIcon.tsx';
import { For, Show, createSignal } from 'solid-js';
import type { Character } from '@tinytavern/shared';
import { DEFAULT_PROMPT_TEMPLATE } from '@tinytavern/shared';
import { api } from '../../../state/api.ts';
import { createCharacterGroups } from '../../../state/characterGroups.ts';
import { state } from '../../../state/store.ts';
import { avatarGenerationAvailable } from '../../../images/imageGeneration.tsx';
import AvatarGenerateModal from '../../../images/AvatarGenerateModal.tsx';
import { createEntityEditor, download, errorMessage } from '../../../util.ts';
import { confirmAction } from '../../../state/confirm.ts';
import Avatar from '../../ui/Avatar.tsx';
import AvatarRow from '../../forms/AvatarRow.tsx';
import EntityEditorPane from '../EntityEditorPane.tsx';
import FormField, { createFormFields } from '../../forms/FormFields.tsx';
import TemplateFields, { type TemplateFieldsHandle } from '../../forms/TemplateFields.tsx';
import MacroHelp from '../../forms/MacroHelp.tsx';
import MacroTextarea from '../../forms/MacroTextarea.tsx';
import Modal from '../../ui/Modal.tsx';
import Select from '../../ui/Select.tsx';

export default function CharactersTab() {
  const [customPrompt, setCustomPrompt] = createSignal(false);
  const [customTemplate, setCustomTemplate] = createSignal(false);
  const [avatarGen, setAvatarGen] = createSignal(false);
  const [characterQuery, setCharacterQuery] = createSignal('');
  const [folderDialog, setFolderDialog] = createSignal<{ id: number | null } | null>(null);
  const [folderName, setFolderName] = createSignal('');
  const folderNameField = createDefaultField(() => '');
  const [folderError, setFolderError] = createSignal('');
  const [folderSaving, setFolderSaving] = createSignal(false);
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
    load: (character) => {
      form.load({
        ...character,
        folderId: String(character?.folderId ?? ''),
        presetId: character?.customPrompt != null ? 'custom' : String(character?.presetId ?? ''),
        templateId:
          character?.customTemplate != null ? 'custom' : String(character?.templateId ?? ''),
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

  const [collapsedFolders, setCollapsedFolders] = createSignal<ReadonlySet<number>>(new Set());
  const toggleFolder = (id: number) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const { rootCharacters, charactersInFolder, searchActive, matchingCharacterCount } =
    createCharacterGroups(characterQuery);

  const editFolder = (id: number | null, currentName = '') => {
    setFolderName(currentName);
    setFolderError('');
    setFolderDialog({ id });
  };

  const saveFolder = async (event: SubmitEvent) => {
    event.preventDefault();
    const dialog = folderDialog();
    const name = folderName().trim();
    if (!dialog || !name || folderSaving()) return;
    setFolderSaving(true);
    setFolderError('');
    try {
      if (dialog.id == null) await api.characterFolders.create({ name });
      else await api.characterFolders.patch(dialog.id, { name });
      setFolderDialog(null);
    } catch (err) {
      setFolderError(errorMessage(err));
    } finally {
      setFolderSaving(false);
    }
  };

  const deleteFolder = async (id: number, name: string) => {
    if (
      !(await confirmAction({
        title: 'Delete folder?',
        message: `Delete “${name}”? Its characters will move to the root.`,
        confirmLabel: 'Delete folder',
        danger: true,
      }))
    )
      return;
    try {
      await api.characterFolders.remove(id);
    } catch (err) {
      editor.setStatus(errorMessage(err));
    }
  };

  const CharacterButton = (props: { character: Character; child?: boolean }) => (
    <button
      class="character-tree-entry"
      classList={{
        active: editor.selectedId() === props.character.id,
        'character-tree-child': props.child,
      }}
      onClick={() => editor.select(props.character.id)}
    >
      <Avatar src={props.character.avatarThumbnail} name={props.character.name} />{' '}
      {props.character.name}
    </button>
  );

  const importCards = async (files: readonly File[]) => {
    if (files.length === 0) return;
    const imported: Character[] = [];
    const failed: string[] = [];
    for (const [index, file] of files.entries()) {
      editor.setStatus(
        files.length === 1 ? 'Importing…' : `Importing ${index + 1} of ${files.length}…`,
        'info',
      );
      try {
        imported.push(await api.characters.importCard(file));
      } catch (err) {
        failed.push(`${file.name}: ${errorMessage(err)}`);
      }
    }
    const last = imported.at(-1);
    if (last) {
      // Load the response directly to avoid racing WS-triggered list refetches.
      editor.adopt(last);
    }
    if (failed.length > 0) {
      editor.setStatus(
        `${imported.length} imported, ${failed.length} failed. ${failed.join(' · ')}`,
      );
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
        items={state.characters}
        itemLabel={(character) => (
          <>
            <Avatar src={character.avatarThumbnail} name={character.name} /> {character.name}
          </>
        )}
        newLabel="New"
        listActions={
          <>
            <button onClick={() => editFolder(null)}>Folder</button>
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
        listSearch={
          <div class="mb-2 [&_.search-input]:min-h-control">
            <input
              class="search-input flex-1 min-w-0"
              placeholder="Search characters…"
              value={characterQuery()}
              onInput={(event) => setCharacterQuery(event.currentTarget.value)}
            />
          </div>
        }
        listContent={
          <>
            <For each={state.characterFolders}>
              {(folder) => (
                <Show when={!searchActive() || charactersInFolder(folder.id).length > 0}>
                  <section class="character-folder">
                    <div class="character-folder-row">
                      <button
                        class="character-folder-toggle"
                        aria-expanded={searchActive() || !collapsedFolders().has(folder.id)}
                        title={
                          searchActive()
                            ? 'Matching characters'
                            : collapsedFolders().has(folder.id)
                              ? 'Expand folder'
                              : 'Collapse folder'
                        }
                        onClick={() => {
                          if (!searchActive()) toggleFolder(folder.id);
                        }}
                      >
                        <span class="w-2.5 text-center text-muted grow-0 shrink-0 basis-2.5">
                          {searchActive() || !collapsedFolders().has(folder.id) ? (
                            <FontAwesomeIcon icon={faChevronDown} size={10} />
                          ) : (
                            <FontAwesomeIcon icon={faChevronRight} size={12} />
                          )}
                        </span>
                        <span class="text-ellipsis overflow-hidden">{folder.name}</span>
                      </button>
                      <button
                        class="character-folder-action"
                        title="Rename folder"
                        aria-label={`Rename ${folder.name}`}
                        onClick={() => editFolder(folder.id, folder.name)}
                      >
                        <FontAwesomeIcon icon={faPen} size={14} />
                      </button>
                      <button
                        class="character-folder-action"
                        title="Delete folder"
                        aria-label={`Delete ${folder.name}`}
                        onClick={() => void deleteFolder(folder.id, folder.name)}
                      >
                        <FontAwesomeIcon icon={faXmark} size={14} />
                      </button>
                    </div>
                    <Show when={searchActive() || !collapsedFolders().has(folder.id)}>
                      <For each={charactersInFolder(folder.id)}>
                        {(character) => <CharacterButton character={character} child />}
                      </For>
                      <Show when={!searchActive() && charactersInFolder(folder.id).length === 0}>
                        <span class="character-folder-empty">Empty folder</span>
                      </Show>
                    </Show>
                  </section>
                </Show>
              )}
            </For>
            <For each={rootCharacters()}>
              {(character) => <CharacterButton character={character} />}
            </For>
            <Show when={searchActive() && matchingCharacterCount() === 0}>
              <p class="hint py-1 px-2">No matches.</p>
            </Show>
          </>
        }
        extraActions={
          <button onClick={() => download(`/api/characters/${editor.selectedId()}/card`)}>
            Export PNG
          </button>
        }
      >
        <section class="settings-section">
          <h3>Basics</h3>
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
            options={[
              { value: '', label: 'No folder' },
              ...state.characterFolders.map((folder) => ({
                value: String(folder.id),
                label: folder.name,
              })),
            ]}
          />
        </section>

        <section class="settings-section">
          <h3>Roleplay</h3>
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
        </section>

        <section class="settings-section">
          <h3>Prompting</h3>
          <div class="form-stack field-group" role="group" aria-label="System prompt settings">
            <SettingLabel field={form.fields.presetId}>System prompt</SettingLabel>
            <Select
              ref={form.fields.presetId.ref}
              ariaLabel="Character system prompt"
              onChange={(value) => setCustomPrompt(value === 'custom')}
              options={[
                { value: '', label: 'Global default' },
                ...state.presets.map((p) => ({ value: String(p.id), label: p.name })),
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
                { value: '', label: 'Global default' },
                ...state.templates.map((t) => ({ value: String(t.id), label: t.name })),
                { value: 'custom', label: 'Custom template…' },
              ]}
            />
            <div class="form-stack" classList={{ hidden: !customTemplate() }}>
              <TemplateFields ref={templateFields} inline />
            </div>
          </div>
        </section>

        <section class="settings-section">
          <h3>Generation</h3>
          <FormField
            kind="check"
            field={form.fields.disableBackgroundSwipeGeneration}
            label="Disable background swipe generation"
            hint="Overrides the global setting for all chats with this character."
          />
        </section>
      </EntityEditorPane>
      <Show when={folderDialog()}>
        {(dialog) => (
          <Modal
            title={dialog().id == null ? 'Create folder' : 'Rename folder'}
            class="confirm-modal [&.confirm-modal]:h-auto [&.confirm-modal]:w-full [&.confirm-modal]:max-w-107.5 [&.confirm-modal]:max-h-[min(80dvh,_520px)] [&_.modal-body]:p-5 small-touch:[&.confirm-modal]:border small-touch:[&.confirm-modal]:border-solid small-touch:[&.confirm-modal]:border-line small-touch:[&.confirm-modal]:rounded-lg small-touch:[&.confirm-modal]:pt-0"
            backdropClass="confirm-backdrop z-400 small-touch:[&.confirm-backdrop]:p-4"
            onClose={() => setFolderDialog(null)}
          >
            <form
              class="form [&_label]:text-label [&_label]:text-foreground [&_label]:mt-2 [&>label]:font-medium [&>label]:mt-0 [&>label]:text-foreground"
              onSubmit={saveFolder}
            >
              <SettingLabel field={folderNameField} for="folder-name">
                Folder name
              </SettingLabel>
              <input
                ref={folderNameField.ref}
                id="folder-name"
                data-modal-initial-focus
                value={folderName()}
                onInput={(event) => setFolderName(event.currentTarget.value)}
              />
              <Show when={folderError()}>
                <p class="notice notice-error" role="alert">
                  {folderError()}
                </p>
              </Show>
              <div class="form-actions flex items-center gap-2 flex-wrap mt-4 mt-5">
                <button
                  class="primary-btn"
                  type="submit"
                  disabled={!folderName().trim() || folderSaving()}
                >
                  {folderSaving() ? 'Saving…' : dialog().id == null ? 'Create' : 'Rename'}
                </button>
                <button
                  type="button"
                  disabled={folderSaving()}
                  onClick={() => setFolderDialog(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </Modal>
        )}
      </Show>
    </>
  );
}
