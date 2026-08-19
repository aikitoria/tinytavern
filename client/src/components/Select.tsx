import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';

const MENU_GAP = 4;
const VIEWPORT_GUTTER = 8;
const MAX_MENU_HEIGHT = 320;

export interface SelectOption {
  value: string;
  label: string;
}

/** Imperative handle mimicking HTMLSelectElement's value contract for ref-based forms. */
export interface SelectHandle {
  value: string;
}

/**
 * Custom dropdown replacing native <select>: the popup repositions on scroll
 * instead of closing (native popups dismiss on any wheel tick, which trackpads
 * emit while merely moving the cursor). Supports controlled use (value +
 * onChange) and the imperative handle used by the settings editors.
 */
export default function Select(props: {
  options: SelectOption[];
  value?: string;
  onChange?: (value: string) => void;
  ref?: SelectHandle | ((handle: SelectHandle) => void);
  class?: string;
}) {
  const [current, setCurrent] = createSignal(props.value ?? '');
  const [open, setOpen] = createSignal(false);
  const [highlighted, setHighlighted] = createSignal(0);
  const [pos, setPos] = createSignal({
    left: 0,
    top: 0,
    width: 0,
    maxHeight: MAX_MENU_HEIGHT,
    up: false,
  });
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
  };
  if (typeof props.ref === 'function') props.ref(handle);

  const label = () => props.options.find((o) => o.value === current())?.label ?? current();

  const reposition = () => {
    const rect = button.getBoundingClientRect();
    const naturalHeight = Math.min(props.options.length * 34 + 12, MAX_MENU_HEIGHT);
    const spaceAbove = Math.max(0, rect.top - MENU_GAP - VIEWPORT_GUTTER);
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_GUTTER);
    const up = naturalHeight > spaceBelow && spaceAbove > spaceBelow;
    const maxHeight = Math.min(MAX_MENU_HEIGHT, up ? spaceAbove : spaceBelow);
    const width = Math.min(rect.width, window.innerWidth - VIEWPORT_GUTTER * 2);
    const left = Math.min(
      Math.max(rect.left, VIEWPORT_GUTTER),
      window.innerWidth - VIEWPORT_GUTTER - width,
    );
    setPos({ left, top: up ? rect.top : rect.bottom, width, maxHeight, up });
  };

  const openMenu = () => {
    reposition();
    setHighlighted(
      Math.max(
        0,
        props.options.findIndex((o) => o.value === current()),
      ),
    );
    setOpen(true);
  };

  const pick = (value: string) => {
    setCurrent(value);
    setOpen(false);
    props.onChange?.(value);
    button.focus();
  };

  const onDocPointerDown = (event: PointerEvent) => {
    if (!open()) return;
    const target = event.target as Node;
    if (!button.contains(target) && !menu?.contains(target)) setOpen(false);
  };
  const onScrollOrResize = () => {
    if (open()) reposition();
  };
  document.addEventListener('pointerdown', onDocPointerDown);
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);
  onCleanup(() => {
    document.removeEventListener('pointerdown', onDocPointerDown);
    window.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize);
  });

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
        onClick={() => (open() ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span class="select-label">{label()}</span>
        <span class="select-caret">▾</span>
      </button>
      <Show when={open()}>
        <Portal>
          <div
            class="select-menu"
            ref={menu}
            style={{
              left: `${pos().left}px`,
              width: `${pos().width}px`,
              'max-height': `${pos().maxHeight}px`,
              ...(pos().up
                ? { bottom: `${window.innerHeight - pos().top + MENU_GAP}px` }
                : { top: `${pos().top + MENU_GAP}px` }),
            }}
          >
            <For each={props.options}>
              {(option, i) => (
                <button
                  type="button"
                  class="select-option"
                  classList={{
                    highlighted: i() === highlighted(),
                    selected: option.value === current(),
                  }}
                  onPointerEnter={() => setHighlighted(i())}
                  onClick={() => pick(option.value)}
                >
                  {option.label}
                </button>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </>
  );
}
