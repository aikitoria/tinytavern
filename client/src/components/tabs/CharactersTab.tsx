import { faChevronDown, faChevronRight, faPen, faXmark } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from '../FontAwesomeIcon.tsx';
import { For, Show, createSignal } from 'solid-js';
import type { Character } from '@tinytavern/shared';
import { DEFAULT_PROMPT_TEMPLATE } from '@tinytavern/shared';
import { api } from '../../state/api.ts';
import { createCharacterGroups } from '../../state/characterGroups.ts';
import { state } from '../../state/store.ts';
import { avatarGenerationAvailable } from '../../plugins/imageGeneration.tsx';
import AvatarGenerateModal from '../../plugins/AvatarGenerateModal.tsx';
import { createEntityEditor, download, errorMessage } from '../../util.ts';
import { confirmAction } from '../../state/confirm.ts';
import Avatar from '../Avatar.tsx';
import AvatarRow from '../AvatarRow.tsx';
import EntityEditorPane from '../EntityEditorPane.tsx';
import TemplateFields, { type TemplateFieldsHandle } from '../TemplateFields.tsx';
import MacroHelp from '../MacroHelp.tsx';
import MacroTextarea from '../MacroTextarea.tsx';
import Modal from '../Modal.tsx';
import Select from '../Select.tsx';
import type { SelectHandle } from '../Select.tsx';

export default function CharactersTab() {
  const [customPrompt, setCustomPrompt] = createSignal(false);
  const [customTemplate, setCustomTemplate] = createSignal(false);
  const [avatarGen, setAvatarGen] = createSignal(false);
  const [characterQuery, setCharacterQuery] = createSignal('');
  const [folderDialog, setFolderDialog] = createSignal<{ id: number | null } | null>(null);
  const [folderName, setFolderName] = createSignal('');
  const [folderError, setFolderError] = createSignal('');
  const [folderSaving, setFolderSaving] = createSignal(false);
  let nameEl!: HTMLInputElement;
  let folderEl!: SelectHandle;
  let personalityEl!: HTMLTextAreaElement;
  let scenarioEl!: HTMLTextAreaElement;
  let examplesEl!: HTMLTextAreaElement;
  let firstMessageEl!: HTMLTextAreaElement;
  let presetEl!: SelectHandle;
  let customEl!: HTMLTextAreaElement;
  let templateEl!: SelectHandle;
  let disableBackgroundSwipeEl!: HTMLInputElement;
  let templateFields!: TemplateFieldsHandle;
  let cardInput!: HTMLInputElement;

  const editor = createEntityEditor({
    items: () => state.characters,
    load: (character) => {
      nameEl.value = character?.name ?? '';
      folderEl.value = String(character?.folderId ?? '');
      personalityEl.value = character?.personality ?? '';
      scenarioEl.value = character?.scenario ?? '';
      examplesEl.value = character?.examples ?? '';
      firstMessageEl.value = character?.firstMessage ?? '';
      presetEl.value =
        character?.customPrompt != null ? 'custom' : String(character?.presetId ?? '');
      customEl.value = character?.customPrompt ?? '';
      disableBackgroundSwipeEl.checked = character?.disableBackgroundSwipeGeneration ?? false;
      templateEl.value =
        character?.customTemplate != null ? 'custom' : String(character?.templateId ?? '');
      templateFields.value = character?.customTemplate;
      setCustomPrompt(character?.customPrompt != null);
      setCustomTemplate(character?.customTemplate != null);
    },
    data: () => {
      const promptChoice = presetEl.value;
      const templateChoice = templateEl.value;
      return {
        name: nameEl.value,
        folderId: folderEl.value ? Number(folderEl.value) : null,
        personality: personalityEl.value,
        scenario: scenarioEl.value,
        examples: examplesEl.value,
        firstMessage: firstMessageEl.value,
        presetId: promptChoice && promptChoice !== 'custom' ? Number(promptChoice) : null,
        customPrompt: promptChoice === 'custom' ? customEl.value : null,
        templateId: templateChoice && templateChoice !== 'custom' ? Number(templateChoice) : null,
        disableBackgroundSwipeGeneration: disableBackgroundSwipeEl.checked,
        customTemplate: templateChoice === 'custom' ? templateFields.value : null,
      };
    },
    create: api.createCharacter,
    patch: api.patchCharacter,
    remove: api.deleteCharacter,
    duplicate: api.duplicateCharacter,
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
      if (dialog.id == null) await api.createCharacterFolder(name);
      else await api.patchCharacterFolder(dialog.id, name);
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
      await api.deleteCharacterFolder(id);
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
      <Avatar src={props.character.avatar} name={props.character.name} /> {props.character.name}
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
        imported.push(await api.importCard(file));
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
            <Avatar src={character.avatar} name={character.name} /> {character.name}
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
          <div class="entity-list-search">
            <input
              class="search-input"
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
                        <span class="tree-disclosure">
                          {searchActive() || !collapsedFolders().has(folder.id) ? (
                            <FontAwesomeIcon icon={faChevronDown} size={10} />
                          ) : (
                            <FontAwesomeIcon icon={faChevronRight} size={12} />
                          )}
                        </span>
                        <span class="character-folder-name">{folder.name}</span>
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
              <p class="hint search-empty">No matches.</p>
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
              name={editor.selected()?.name ?? '?'}
              upload={(file) => api.uploadCharacterAvatar(editor.selectedId() as number, file)}
              remove={() => api.deleteCharacterAvatar(editor.selectedId() as number)}
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

          <label>Name</label>
          <input ref={nameEl} placeholder="Character name" />
          <label>Folder</label>
          <Select
            ref={folderEl}
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
          <label>
            Personality <MacroHelp />
          </label>
          <MacroTextarea ref={personalityEl} placeholder="Who is {{char}}?" />
          <label>
            Scenario <MacroHelp />
          </label>
          <MacroTextarea ref={scenarioEl} placeholder="Setting / situation (optional)" />
          <label>
            Example conversations <MacroHelp />
          </label>
          <MacroTextarea
            ref={examplesEl}
            placeholder="Example dialogue between {{user}} and {{char}} (optional; separate with <START>)"
          />
          <label>
            First message <MacroHelp />
          </label>
          <MacroTextarea
            ref={firstMessageEl}
            placeholder="Greeting sent when a chat starts (optional)"
          />
        </section>

        <section class="settings-section">
          <h3>Prompting</h3>
          <label>System prompt</label>
          <Select
            ref={presetEl}
            ariaLabel="Character system prompt"
            onChange={(value) => setCustomPrompt(value === 'custom')}
            options={[
              { value: '', label: 'Global default' },
              ...state.presets.map((p) => ({ value: String(p.id), label: p.name })),
              { value: 'custom', label: 'Custom prompt…' },
            ]}
          />
          <Show when={customPrompt()}>
            <label>
              Custom prompt text <MacroHelp />
            </label>
          </Show>
          <MacroTextarea
            ref={customEl}
            classList={{ hidden: !customPrompt() }}
            placeholder="Custom system prompt for this character"
          />

          <label>Prompt template</label>
          <Select
            ref={templateEl}
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
        </section>

        <section class="settings-section">
          <h3>Generation</h3>
          <label class="check-row">
            <input type="checkbox" ref={disableBackgroundSwipeEl} />
            Disable background swipe generation
          </label>
          <p class="hint">Overrides the global setting for all chats with this character.</p>
        </section>

        <section
          class="settings-section settings-section-advanced"
          classList={{ hidden: !customTemplate() }}
        >
          <h3>Advanced template overrides</h3>
          <TemplateFields ref={templateFields} inline />
        </section>
      </EntityEditorPane>
      <Show when={folderDialog()}>
        {(dialog) => (
          <Modal
            title={dialog().id == null ? 'Create folder' : 'Rename folder'}
            class="confirm-modal"
            backdropClass="confirm-backdrop"
            onClose={() => setFolderDialog(null)}
          >
            <form class="form folder-dialog-form" onSubmit={saveFolder}>
              <label for="folder-name">Folder name</label>
              <input
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
              <div class="form-actions confirm-actions">
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
