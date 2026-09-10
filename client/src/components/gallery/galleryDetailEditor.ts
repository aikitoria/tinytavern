import { createEffect, createSignal, on } from 'solid-js';

export interface GalleryDetails {
  prompt: string;
  characterIds: number[];
}

/** The mounted gallery detail owns its draft until Save or Discard permits navigation. */
export function createGalleryDetailEditor(options: {
  value: () => GalleryDetails;
  generating: () => boolean;
  submit: (value: GalleryDetails, expected: GalleryDetails) => Promise<GalleryDetails>;
  onError: (message: string) => void;
}) {
  const initial = options.value();
  const [prompt, setPrompt] = createSignal(initial.prompt);
  const [characterIds, setCharacterIds] = createSignal(initial.characterIds);
  const [saved, setSaved] = createSignal(initial);
  const [saving, setSaving] = createSignal(false);
  const dirty = () =>
    prompt() !== saved().prompt ||
    JSON.stringify(characterIds()) !== JSON.stringify(saved().characterIds);
  const discard = () => {
    const value = options.value();
    setPrompt(value.prompt);
    setCharacterIds(value.characterIds);
    setSaved(value);
    options.onError('');
  };
  createEffect(
    on(options.value, () => {
      if (!dirty() && !saving() && !options.generating()) discard();
    }),
  );
  let pendingSave: Promise<boolean> | undefined;
  const save = (): Promise<boolean> => {
    if (pendingSave) return pendingSave;
    if (!dirty()) return Promise.resolve(true);
    const value = { prompt: prompt(), characterIds: characterIds() };
    setSaving(true);
    options.onError('');
    pendingSave = options
      .submit(value, saved())
      .then((value) => {
        setSaved(value);
        return !dirty();
      })
      .catch((error: unknown) => {
        options.onError(error instanceof Error ? error.message : String(error));
        return false;
      })
      .finally(() => {
        pendingSave = undefined;
        setSaving(false);
      });
    return pendingSave;
  };
  return { prompt, setPrompt, characterIds, setCharacterIds, dirty, saving, save, discard };
}
