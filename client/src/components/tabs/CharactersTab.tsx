import { For, Show, createSignal } from 'solid-js';
import type { Character } from '@minitavern/shared';
import { DEFAULT_PROMPT_TEMPLATE, DEFAULT_STEER_TEMPLATE } from '@minitavern/shared';
import { api } from '../../state/api.ts';
import { state } from '../../state/store.ts';
import { avatarGenerationAvailable } from '../../plugins/imageGeneration.tsx';
import AvatarGenerateModal from '../../plugins/AvatarGenerateModal.tsx';
import { createEntityEditor, download, errorMessage } from '../../util.ts';
import Avatar from '../Avatar.tsx';
import AvatarRow from '../AvatarRow.tsx';
import EntityEditorPane from '../EntityEditorPane.tsx';
import MacroHelp from '../MacroHelp.tsx';
import MacroTextarea from '../MacroTextarea.tsx';
import Select from '../Select.tsx';
import type { SelectHandle } from '../Select.tsx';

export default function CharactersTab() {
  const [customPrompt, setCustomPrompt] = createSignal(false);
  const [customTemplate, setCustomTemplate] = createSignal(false);
  const [avatarGen, setAvatarGen] = createSignal(false);
  const [characterQuery, setCharacterQuery] = createSignal('');
  let nameEl!: HTMLInputElement;
  let folderEl!: SelectHandle;
  let personalityEl!: HTMLTextAreaElement;
  let scenarioEl!: HTMLTextAreaElement;
  let examplesEl!: HTMLTextAreaElement;
  let firstMessageEl!: HTMLTextAreaElement;
  let presetEl!: SelectHandle;
  let customEl!: HTMLTextAreaElement;
  let templateEl!: SelectHandle;
  let customTemplateEl!: HTMLTextAreaElement;
  let customPrologueEl!: HTMLTextAreaElement;
  let customReasoningPrefillEl!: HTMLTextAreaElement;
  let customMessagePrefillEl!: HTMLTextAreaElement;
  let customPrefixEl!: HTMLInputElement;
  let customUsesPersonasEl!: HTMLInputElement;
  let customSteerEl!: HTMLTextAreaElement;
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
      templateEl.value =
        character?.customTemplate != null ? 'custom' : String(character?.templateId ?? '');
      customTemplateEl.value = character?.customTemplate?.content ?? '';
      customPrologueEl.value = character?.customTemplate?.userPrologue ?? '';
      customReasoningPrefillEl.value = character?.customTemplate?.reasoningPrefill ?? '';
      customMessagePrefillEl.value = character?.customTemplate?.messagePrefill ?? '';
      customPrefixEl.checked = character?.customTemplate?.prefixNames ?? false;
      customUsesPersonasEl.checked = character?.customTemplate?.usesPersonas ?? true;
      customSteerEl.value = character?.customTemplate?.steerTemplate ?? DEFAULT_STEER_TEMPLATE;
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
        customTemplate:
          templateChoice === 'custom'
            ? {
                content: customTemplateEl.value,
                userPrologue: customPrologueEl.value,
                reasoningPrefill: customReasoningPrefillEl.value,
                messagePrefill: customMessagePrefillEl.value,
                prefixNames: customPrefixEl.checked,
                usesPersonas: customUsesPersonasEl.checked,
                steerTemplate: customSteerEl.value,
              }
            : null,
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
  const characterFolderExists = (id: number) => state.characterFolders.some((f) => f.id === id);
  const normalizedCharacterQuery = () => characterQuery().trim().toLocaleLowerCase();
  const characterMatches = (character: Character) =>
    !normalizedCharacterQuery() ||
    character.name.toLocaleLowerCase().includes(normalizedCharacterQuery());
  const rootCharacters = () =>
    state.characters.filter(
      (character) =>
        (character.folderId == null || !characterFolderExists(character.folderId)) &&
        characterMatches(character),
    );
  const charactersInFolder = (id: number) =>
    state.characters.filter(
      (character) => character.folderId === id && characterMatches(character),
    );
  const searchActive = () => normalizedCharacterQuery().length > 0;
  const matchingCharacterCount = () =>
    rootCharacters().length +
    state.characterFolders.reduce(
      (total, folder) => total + charactersInFolder(folder.id).length,
      0,
    );

  const createFolder = async () => {
    const name = prompt('Folder name?')?.trim();
    if (!name) return;
    try {
      await api.createCharacterFolder(name);
    } catch (err) {
      editor.setStatus(errorMessage(err));
    }
  };

  const renameFolder = async (id: number, currentName: string) => {
    const name = prompt('Rename folder:', currentName)?.trim();
    if (!name || name === currentName) return;
    try {
      await api.patchCharacterFolder(id, name);
    } catch (err) {
      editor.setStatus(errorMessage(err));
    }
  };

  const deleteFolder = async (id: number, name: string) => {
    if (!confirm(`Delete the “${name}” folder? Its characters will move to the root.`)) return;
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
      );
      try {
        imported.push(await api.importCard(file));
      } catch (err) {
        failed.push(`${file.name}: ${errorMessage(err)}`);
      }
    }
    const last = imported.at(-1);
    if (last) {
      // The list refreshes via WS invalidate; load the form straight from the
      // final response instead of racing those refetches.
      editor.adopt(last);
    }
    if (failed.length > 0) {
      editor.setStatus(
        `${imported.length} imported, ${failed.length} failed. ${failed.join(' · ')}`,
      );
    } else if (imported.length === 1) {
      editor.setStatus(`Imported ${imported[0]!.name}.`);
    } else {
      editor.setStatus(`Imported ${imported.length} characters.`);
    }
  };

  return (
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
          <button onClick={() => void createFolder()}>Folder</button>
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
                        {searchActive() || !collapsedFolders().has(folder.id) ? '▾' : '▸'}
                      </span>
                      <span class="character-folder-name">{folder.name}</span>
                    </button>
                    <button
                      class="character-folder-action"
                      title="Rename folder"
                      onClick={() => void renameFolder(folder.id, folder.name)}
                    >
                      ✎
                    </button>
                    <button
                      class="character-folder-action"
                      title="Delete folder"
                      onClick={() => void deleteFolder(folder.id, folder.name)}
                    >
                      ×
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
      <Show when={editor.selectedId() !== 'new'}>
        <AvatarRow
          src={editor.selected()?.avatar}
          name={editor.selected()?.name ?? '?'}
          upload={(file) => api.uploadCharacterAvatar(editor.selectedId() as number, file)}
          remove={() => api.deleteCharacterAvatar(editor.selectedId() as number)}
          generate={
            avatarGenerationAvailable()
              ? async () => {
                  setAvatarGen(true);
                }
              : undefined
          }
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
        options={[
          { value: '', label: 'No folder' },
          ...state.characterFolders.map((folder) => ({
            value: String(folder.id),
            label: folder.name,
          })),
        ]}
      />
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

      <label>System prompt</label>
      <Select
        ref={presetEl}
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
        onChange={(value) => {
          const custom = value === 'custom';
          setCustomTemplate(custom);
          // Start from the built-in template rather than a blank page.
          if (custom && !customTemplateEl.value) customTemplateEl.value = DEFAULT_PROMPT_TEMPLATE;
        }}
        options={[
          { value: '', label: 'Global default' },
          ...state.templates.map((t) => ({ value: String(t.id), label: t.name })),
          { value: 'custom', label: 'Custom template…' },
        ]}
      />
      <Show when={customTemplate()}>
        <label>
          Custom template — system prompt <MacroHelp template />
        </label>
      </Show>
      <MacroTextarea
        ref={customTemplateEl}
        template
        class="mono"
        classList={{ hidden: !customTemplate() }}
      />
      <Show when={customTemplate()}>
        <label>
          First user message (optional — sent as a fake user turn before the history){' '}
          <MacroHelp template />
        </label>
      </Show>
      <MacroTextarea
        ref={customPrologueEl}
        template
        class="mono"
        classList={{ hidden: !customTemplate() }}
        placeholder="Leave empty to send no fake user message"
      />
      <Show when={customTemplate()}>
        <label>
          Custom template — reasoning prefill (optional) <MacroHelp template />
        </label>
      </Show>
      <MacroTextarea
        ref={customReasoningPrefillEl}
        template
        class="mono"
        classList={{ hidden: !customTemplate() }}
        placeholder="Leave empty to let the model start reasoning"
      />
      <Show when={customTemplate()}>
        <label>
          Custom template — assistant message prefill (optional) <MacroHelp template />
        </label>
      </Show>
      <MacroTextarea
        ref={customMessagePrefillEl}
        template
        class="mono"
        classList={{ hidden: !customTemplate() }}
        placeholder="Leave empty to let the model start the visible reply"
      />
      <Show when={customTemplate()}>
        <p class="hint">
          A reasoning prefill continues the model's reasoning. Adding a message prefill continues
          the visible reply from that text. Both become part of the saved response.
        </p>
      </Show>
      <label class="check-row" classList={{ hidden: !customTemplate() }}>
        <input ref={customPrefixEl} type="checkbox" />
        Prefix speaker names into messages ("{'{{user}}'}: …", "{'{{char}}'}: …") and prefill the
        reply with the current speaker name (see /char)
      </label>
      <label class="check-row" classList={{ hidden: !customTemplate() }}>
        <input ref={customUsesPersonasEl} type="checkbox" />
        Uses personas — when off, chats with this character ignore the persona entirely ("
        {'{{user}}'}" becomes "User", the persona description is not sent)
      </label>
      <Show when={customTemplate()}>
        <label>Custom template — steer template (regenerate with instruction)</label>
      </Show>
      <MacroTextarea
        ref={customSteerEl}
        keys={['instruction']}
        rows={2}
        classList={{ hidden: !customTemplate() }}
      />
      <Show when={customTemplate()}>
        <p class="hint">
          {'{{instruction}}'} is replaced with your instruction and injected into that
          regeneration's prompt only. Leave empty to use the built-in default.
        </p>
      </Show>
    </EntityEditorPane>
  );
}
