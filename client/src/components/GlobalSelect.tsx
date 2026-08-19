import { Show, createSignal } from 'solid-js';
import type { Settings } from '@minitavern/shared';
import { api, ApiError } from '../state/api.ts';
import { applySettings, state } from '../state/store.ts';
import { createSavedFlash, errorMessage, numberOrNull } from '../util.ts';
import Select from './Select.tsx';

const DASH = '\u2014';

/** Shared empty-selection labels (typographic dashes, kept ASCII via escapes). */
export const NONE_LABEL = `${DASH} none ${DASH}`;
export const BUILT_IN_TEMPLATE_LABEL = `${DASH} built-in default ${DASH}`;

type GlobalSelectKey =
  'activeEndpointId' | 'defaultPresetId' | 'defaultPersonaId' | 'defaultTemplateId';

/**
 * Global "which one is in use" picker shown above an entity CRUD tab, so
 * activating an entry lives on the same page as creating it. Saves on change
 * (no draft state): on a 409 the pick is retried once against the refreshed
 * revision, since the click is the newest intent for this one key.
 */
export default function GlobalSelect(props: {
  label: string;
  settingKey: GlobalSelectKey;
  items: readonly { id: number; name: string }[];
  noneLabel: string;
}) {
  const [saved, flashSaved] = createSavedFlash();
  const [error, setError] = createSignal('');

  const apply = async (value: string) => {
    const patch: Partial<Settings> = { [props.settingKey]: numberOrNull(value) };
    try {
      try {
        applySettings(await api.putSettings(patch, state.settings.revision));
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        const latest = await api.settings();
        applySettings(latest);
        applySettings(await api.putSettings(patch, latest.revision));
      }
      setError('');
      flashSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div class="global-select-bar">
      <label>{props.label}</label>
      <Select
        value={state.settings[props.settingKey]?.toString() ?? ''}
        onChange={(value) => void apply(value)}
        options={[
          { value: '', label: props.noneLabel },
          ...props.items.map((item) => ({ value: String(item.id), label: item.name })),
        ]}
      />
      <Show when={saved()}>
        <span class="saved-flash">{'\u2713'} Saved</span>
      </Show>
      <Show when={error()}>
        <span class="hint">{error()}</span>
      </Show>
    </div>
  );
}
