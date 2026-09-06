import { createMemo, type Accessor } from 'solid-js';
import type { Character } from '@tinytavern/shared';
import { state } from './store.ts';

const EMPTY: Character[] = [];

/** Preserve server ordering while filtering and assigning each character once. */
export function createCharacterGroups(query: Accessor<string>) {
  const grouped = createMemo(() => {
    const normalized = query().trim().toLocaleLowerCase();
    const folders = new Set(state.characterFolders.map((folder) => folder.id));
    const byFolder = new Map<number, Character[]>();
    const root: Character[] = [];
    let count = 0;
    for (const character of state.characters) {
      if (normalized && !character.name.toLocaleLowerCase().includes(normalized)) continue;
      count++;
      if (character.folderId == null || !folders.has(character.folderId)) {
        root.push(character);
      } else {
        let group = byFolder.get(character.folderId);
        if (!group) byFolder.set(character.folderId, (group = []));
        group.push(character);
      }
    }
    return { root, byFolder, count, searchActive: normalized.length > 0 };
  });
  return {
    rootCharacters: () => grouped().root,
    charactersInFolder: (id: number) => grouped().byFolder.get(id) ?? EMPTY,
    matchingCharacterCount: () => grouped().count,
    searchActive: () => grouped().searchActive,
  };
}
