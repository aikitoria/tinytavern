import { For, Show, createSignal } from 'solid-js';
import { useDismiss } from '../util.ts';

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
  let root: HTMLSpanElement | undefined;

  useDismiss(
    () => root,
    open,
    () => setOpen(false),
  );

  // Basics first, then content slots in built-in template order, syntax last.
  const rows = () =>
    props.rows ?? [...(props.template ? [...BASIC, ...TEMPLATE] : BASIC), ...(props.extra ?? [])];

  return (
    <span class="macro-help" ref={root}>
      <button class="help-btn" title="Available macros" onClick={() => setOpen(!open())}>
        ?
      </button>
      <Show when={open()}>
        <div class="help-card popover-surface">
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
      </Show>
    </span>
  );
}
