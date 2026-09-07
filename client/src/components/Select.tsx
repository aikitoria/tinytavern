import { faCheck, faChevronDown } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import { For, Show, createEffect, createSignal, createUniqueId, type JSX } from 'solid-js';
import DropdownSurface from './DropdownSurface.tsx';

export interface SelectOption {
  value: string;
  label: string;
}

/** Imperative handle mimicking HTMLSelectElement's value contract for ref-based forms. */
export interface SelectHandle {
  value: string;
  /** Apply an explicit edit, including the controlled-value callback. */
  change: (value: string) => void;
  focus: () => void;
}

/** Repositions on scroll to avoid native select dismissal on stray trackpad wheel events.
 * Supports controlled values and imperative settings-editor refs. */
export default function Select(props: {
  options: SelectOption[];
  value?: string;
  onChange?: (value: string) => void;
  ref?: SelectHandle | ((handle: SelectHandle) => void);
  class?: string;
  ariaLabel?: string;
  buttonLabel?: JSX.Element;
  disabled?: boolean;
  menuMinWidth?: number;
  menuClass?: string;
  showCheck?: boolean;
}) {
  const id = createUniqueId();
  const listboxId = `select-listbox-${id}`;
  const [current, setCurrent] = createSignal(props.value ?? '');
  const [open, setOpen] = createSignal(false);
  const [highlighted, setHighlighted] = createSignal(0);
  let button!: HTMLButtonElement;
  let menu: HTMLDivElement | undefined;

  createEffect(() => {
    if (props.value !== undefined) setCurrent(props.value);
  });

  const handle: SelectHandle = {
    get value() {
      return current();
    },
    set value(next: string) {
      setCurrent(next);
    },
    change(next) {
      setCurrent(next);
      setOpen(false);
      props.onChange?.(next);
    },
    focus() {
      button.focus({ preventScroll: true });
    },
  };
  if (typeof props.ref === 'function') props.ref(handle);

  const label = () =>
    props.buttonLabel ?? props.options.find((o) => o.value === current())?.label ?? current();

  const openMenu = () => {
    if (props.disabled) return;
    setHighlighted(
      Math.max(
        0,
        props.options.findIndex((o) => o.value === current()),
      ),
    );
    setOpen(true);
  };

  const pick = (value: string) => {
    if (props.disabled) return;
    setCurrent(value);
    setOpen(false);
    props.onChange?.(value);
    button.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open()) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const dir = event.key === 'ArrowDown' ? 1 : -1;
      const next = (highlighted() + dir + props.options.length) % props.options.length;
      setHighlighted(next);
      menu?.children[next]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = props.options[highlighted()];
      if (option) pick(option.value);
    }
  };

  return (
    <>
      <button
        type="button"
        class={`select-btn ${props.class ?? ''}`}
        ref={button}
        role="combobox"
        aria-label={props.ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-controls={listboxId}
        aria-activedescendant={open() ? `select-option-${id}-${highlighted()}` : undefined}
        disabled={props.disabled}
        onClick={() => (open() ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span class="select-label">{label()}</span>
        <span class="select-caret">
          <FontAwesomeIcon icon={faChevronDown} size={10} />
        </span>
      </button>
      <DropdownSurface
        open={open()}
        anchor={() => button}
        onClose={() => setOpen(false)}
        id={listboxId}
        class={`select-menu ${props.menuClass ?? ''}`}
        role="listbox"
        ariaLabel={props.ariaLabel}
        matchAnchorWidth
        minWidth={props.menuMinWidth}
        maxHeight={320}
        ref={(element) => (menu = element)}
      >
        <For each={props.options}>
          {(option, i) => (
            <button
              type="button"
              class="select-option"
              id={`select-option-${id}-${i()}`}
              role="option"
              tabIndex={-1}
              aria-selected={option.value === current()}
              classList={{
                highlighted: i() === highlighted(),
                selected: option.value === current(),
                active: props.showCheck && option.value === current(),
              }}
              onPointerEnter={() => setHighlighted(i())}
              onClick={() => pick(option.value)}
            >
              <span>{option.label}</span>
              <Show when={props.showCheck}>
                <span class="menu-check" aria-hidden="true">
                  {option.value === current() ? <FontAwesomeIcon icon={faCheck} size={12} /> : null}
                </span>
              </Show>
            </button>
          )}
        </For>
      </DropdownSurface>
    </>
  );
}
