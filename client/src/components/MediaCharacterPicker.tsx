import { createSignal, For, Show } from 'solid-js';
import { faCheck, faChevronDown } from '@fortawesome/free-solid-svg-icons';
import { state } from '../state/store.ts';
import Avatar from './Avatar.tsx';
import DropdownSurface from './DropdownSurface.tsx';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';

export default function MediaCharacterPicker(props: {
  value: number[];
  disabled?: boolean;
  onChange: (value: number[]) => void;
}) {
  const [open, setOpen] = createSignal(false);
  let button!: HTMLButtonElement;
  const label = () =>
    state.characters
      .filter((character) => props.value.includes(character.id))
      .map((character) => character.name)
      .join(', ') || 'Choose characters';
  const toggle = (id: number) =>
    props.onChange(
      props.value.includes(id)
        ? props.value.filter((value) => value !== id)
        : [...props.value, id].sort((a, b) => a - b),
    );
  return (
    <>
      <button
        ref={button}
        type="button"
        class="select-btn"
        aria-label="Associated characters"
        aria-haspopup="menu"
        aria-expanded={open()}
        disabled={props.disabled}
        onClick={() => setOpen(!open())}
      >
        <span class="select-label">{label()}</span>
        <FontAwesomeIcon icon={faChevronDown} size={10} />
      </button>
      <DropdownSurface
        open={open()}
        anchor={() => button}
        onClose={() => setOpen(false)}
        role="menu"
        ariaLabel="Associated characters"
        class="gallery-character-menu"
        matchAnchorWidth
        minWidth={230}
        maxHeight={360}
        keyboardNavigation
        autoFocus
      >
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={props.value.length === 0}
          onClick={() => props.onChange([])}
          disabled={props.disabled}
        >
          <span>No characters</span>
          <span class="menu-check">
            <Show when={props.value.length === 0}>
              <FontAwesomeIcon icon={faCheck} size={12} />
            </Show>
          </span>
        </button>
        <For each={state.characters}>
          {(character) => (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-label={character.name}
              aria-checked={props.value.includes(character.id)}
              onClick={() => toggle(character.id)}
              disabled={props.disabled}
            >
              <Avatar src={character.avatarThumbnail} name={character.name} />
              <span>{character.name}</span>
              <span class="menu-check">
                <Show when={props.value.includes(character.id)}>
                  <FontAwesomeIcon icon={faCheck} size={12} />
                </Show>
              </span>
            </button>
          )}
        </For>
      </DropdownSurface>
    </>
  );
}
