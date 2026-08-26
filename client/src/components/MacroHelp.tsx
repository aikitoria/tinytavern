import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import { useDismiss } from '../util.ts';

const CARD_WIDTH = 460;
const VIEWPORT_GUTTER = 8;
const CARD_GAP = 8;

const BASIC: [string, string][] = [
  ['{{char}}', 'The character\'s name (or "Assistant")'],
  ['{{user}}', 'The persona\'s name (or "User")'],
];

const TEMPLATE: [string, string][] = [
  [
    '{{system}}',
    'Resolved system prompt: character custom → character preset → global default preset',
  ],
  ['{{personality}}', "The character's personality text"],
  ['{{persona}}', "The persona's description text"],
  ['{{scenario}}', "The conversation override, otherwise the character's scenario text"],
  ['{{examples}}', "The character's example conversations"],
  [
    '{{#if x}}…{{/if}}',
    'Include the block only when slot x is non-empty (x = system, personality, persona, scenario, examples)',
  ],
];

/** "?" chip that pops a reference card of the macros usable in the adjacent field. */
export default function MacroHelp(props: {
  template?: boolean;
  /** Exclusive row set replacing the built-ins (e.g. a plugin's workflow macros). */
  rows?: [string, string][];
  /** Rows appended after the built-ins (e.g. a plugin's {{instruction}}). */
  extra?: [string, string][];
}) {
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal({
    left: VIEWPORT_GUTTER,
    top: VIEWPORT_GUTTER,
    width: CARD_WIDTH,
    maxHeight: 320,
  });
  let root: HTMLSpanElement | undefined;
  let card: HTMLDivElement | undefined;

  useDismiss(
    () => root,
    open,
    () => setOpen(false),
    () => card,
  );

  // Basics first, then content slots in built-in template order, syntax last.
  const rows = () =>
    props.rows ?? [...(props.template ? [...BASIC, ...TEMPLATE] : BASIC), ...(props.extra ?? [])];

  const reposition = () => {
    if (!open() || !root || !card) return;
    const anchor = root.getBoundingClientRect();
    const width = Math.max(
      0,
      Math.min(CARD_WIDTH, document.documentElement.clientWidth - VIEWPORT_GUTTER * 2),
    );
    const left = Math.min(
      Math.max(anchor.left - VIEWPORT_GUTTER, VIEWPORT_GUTTER),
      document.documentElement.clientWidth - width - VIEWPORT_GUTTER,
    );
    const availableBelow = window.innerHeight - anchor.bottom - CARD_GAP - VIEWPORT_GUTTER;
    const availableAbove = anchor.top - CARD_GAP - VIEWPORT_GUTTER;
    const naturalHeight = card.scrollHeight;
    const openAbove = naturalHeight > availableBelow && availableAbove > availableBelow;
    const maxHeight = Math.max(80, openAbove ? availableAbove : availableBelow);
    const top = openAbove
      ? Math.max(VIEWPORT_GUTTER, anchor.top - Math.min(naturalHeight, maxHeight) - CARD_GAP)
      : anchor.bottom + CARD_GAP;
    setPosition({ left, top, width, maxHeight });
  };

  createEffect(() => {
    if (!open()) return;
    queueMicrotask(() => {
      reposition();
      requestAnimationFrame(reposition);
    });
  });
  onMount(() => {
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
  });
  onCleanup(() => {
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
  });

  return (
    <span class="macro-help" ref={root}>
      <button
        class="help-btn"
        title="Available macros"
        aria-label="Available macros"
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        ?
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={card}
            class="help-card popover-surface"
            role="dialog"
            aria-label="Available macros"
            style={{
              left: `${position().left}px`,
              top: `${position().top}px`,
              width: `${position().width}px`,
              'max-height': `${position().maxHeight}px`,
            }}
          >
            <div class="help-title">Available macros</div>
            <For each={rows()}>
              {([macro, description]) => (
                <div class="help-row">
                  <code>{macro}</code>
                  <span>{description}</span>
                </div>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </span>
  );
}
