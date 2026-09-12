import { faCheck, faChevronDown } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import { For, Show, createEffect, createMemo, createSignal, createUniqueId, type JSX } from 'solid-js';
import DropdownSurface from './DropdownSurface.tsx';
import ReferenceEditButton from './ReferenceEditButton.tsx';

export interface SelectOption {
  value: string;
  label: string;
  group?: string;
  edit?: () => void;
}

/** Imperative handle mimicking HTMLSelectElement's value contract for ref-based forms. */
export interface SelectHandle {
  readonly id: string;
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
  id?: string;
  ariaLabel?: string;
  buttonLabel?: JSX.Element;
  disabled?: boolean;
  menuMinWidth?: number;
  menuClass?: string;
  showCheck?: boolean;
  searchPlaceholder?: string;
  /** Let a searched value be selected even when it is absent from the supplied options. */
  allowCustom?: boolean;
}) {
  const id = createUniqueId();
  const listboxId = `select-listbox-${id}`;
  const [current, setCurrent] = createSignal(props.value ?? '');
  const [open, setOpen] = createSignal(false);
  const [highlighted, setHighlighted] = createSignal(0);
  const [query, setQuery] = createSignal('');
  const choices = createMemo(() => props.options);
  const options = createMemo<SelectOption[]>(() => {
    const value = query().trim();
    const needle = value.toLowerCase();
    const matches = needle
      ? choices().filter(
          (option) =>
            option.label.toLowerCase().includes(needle) ||
            option.value.toLowerCase().includes(needle) ||
            option.group?.toLowerCase().includes(needle),
        )
      : choices();
    return props.allowCustom && value && !choices().some((option) => option.value === value)
      ? [...matches, { value, label: `Use “${value}”` }]
      : matches;
  });
  let button!: HTMLButtonElement;
  let menu: HTMLDivElement | undefined;
  let search: HTMLInputElement | undefined;
  const activeDescendant = () =>
    open() && options()[highlighted()] ? `select-option-${id}-${highlighted()}` : undefined;

  createEffect(() => {
    if (props.value !== undefined) setCurrent(props.value);
  });

  const handle: SelectHandle = {
    get id() {
      return props.id ?? `select-control-${id}`;
    },
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

  const label = () => props.buttonLabel ?? selectedOption()?.label ?? current();
  const selectedOption = createMemo(() => choices().find((option) => option.value === current()));

  const openMenu = () => {
    if (props.disabled) return;
    setQuery('');
    setHighlighted(
      Math.max(
        0,
        choices().findIndex((o) => o.value === current()),
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
    if (event.isComposing) return;
    const searching = event.currentTarget === search;
    if (!open()) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (searching) button.focus({ preventScroll: true });
      setOpen(false);
      return;
    }
    if (searching && [' ', 'Home', 'End'].includes(event.key)) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!options().length) return;
      const dir = event.key === 'ArrowDown' ? 1 : -1;
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? options().length - 1
            : (highlighted() + dir + options().length) % options().length;
      setHighlighted(next);
      menu?.querySelector<HTMLElement>(`[id="select-option-${id}-${next}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options()[highlighted()];
      if (option) pick(option.value);
    }
  };

  return (
    <>
      <div class={`select-control ${props.class ?? ''}`}>
        <button
          type="button"
          id={handle.id}
          class="select-btn"
          ref={button}
          role={props.searchPlaceholder ? undefined : 'combobox'}
          aria-label={props.ariaLabel}
          aria-haspopup={props.searchPlaceholder ? 'dialog' : 'listbox'}
          aria-expanded={open()}
          aria-controls={props.searchPlaceholder ? `select-popup-${id}` : listboxId}
          aria-activedescendant={props.searchPlaceholder ? undefined : activeDescendant()}
          disabled={props.disabled}
          onClick={() => (open() ? setOpen(false) : openMenu())}
          onKeyDown={onKeyDown}
        >
          <span class="select-label truncate">{label()}</span>
          <span class="select-caret text-dim text-tiny shrink-0">
            <FontAwesomeIcon icon={faChevronDown} size={10} />
          </span>
        </button>
        <Show when={selectedOption()?.edit}>
          <ReferenceEditButton
            label={selectedOption()!.label}
            onClick={() => {
              setOpen(false);
              selectedOption()?.edit?.();
            }}
          />
        </Show>
      </div>
      <DropdownSurface
        open={open()}
        anchor={() => button}
        onClose={() => setOpen(false)}
        id={`select-popup-${id}`}
        class={`select-menu ${props.menuClass ?? ''}`}
        role={props.searchPlaceholder ? 'dialog' : undefined}
        ariaLabel={props.ariaLabel}
        matchAnchorWidth
        minWidth={props.menuMinWidth}
        maxHeight={320}
        autoFocus={!!props.searchPlaceholder}
        initialFocus={() => search}
      >
        <Show when={props.searchPlaceholder}>
          <div class="sticky top-0 z-1 bg-panel p-1">
            <input
              ref={search}
              type="search"
              class="w-full min-w-0"
              placeholder={props.searchPlaceholder}
              aria-label={props.searchPlaceholder}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open()}
              aria-controls={listboxId}
              aria-activedescendant={activeDescendant()}
              value={query()}
              onInput={(event) => {
                setQuery(event.currentTarget.value);
                setHighlighted(0);
                if (menu?.parentElement) menu.parentElement.scrollTop = 0;
              }}
              onKeyDown={onKeyDown}
            />
          </div>
        </Show>
        <div ref={menu} id={listboxId} role="listbox" aria-label={props.ariaLabel}>
          <For each={options()}>
            {(option, i) => (
              <>
                <Show when={option.group && option.group !== options()[i() - 1]?.group}>
                  <div class="px-2 pt-2 pb-1 text-dim text-xs font-semibold" role="presentation">
                    {option.group}
                  </div>
                </Show>
                <button
                  type="button"
                  class="select-option"
                  id={`select-option-${id}-${i()}`}
                  role="option"
                  aria-label={option.group ? `${option.group}: ${option.label}` : undefined}
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
                  <span classList={{ 'pl-3': !!option.group }}>{option.label}</span>
                  <Show when={props.showCheck}>
                    <span class="menu-check" aria-hidden="true">
                      {option.value === current() ? <FontAwesomeIcon icon={faCheck} size={12} /> : null}
                    </span>
                  </Show>
                </button>
              </>
            )}
          </For>
        </div>
        <Show when={!options().length}>
          <p class="m-0 p-2 text-dim text-sm" role="status">
            No matching options.
          </p>
        </Show>
      </DropdownSurface>
    </>
  );
}
