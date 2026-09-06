import { faCircleQuestion } from '@fortawesome/free-regular-svg-icons';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import { For, createSignal } from 'solid-js';
import DropdownSurface from './DropdownSurface.tsx';

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

export default function MacroHelp(props: {
  template?: boolean;
  /** Replace the built-in rows. */
  rows?: [string, string][];
  /** Append to the built-in rows. */
  extra?: [string, string][];
}) {
  const [open, setOpen] = createSignal(false);
  let root: HTMLSpanElement | undefined;
  let trigger: HTMLButtonElement | undefined;

  const rows = () =>
    props.rows ?? [...(props.template ? [...BASIC, ...TEMPLATE] : BASIC), ...(props.extra ?? [])];

  return (
    <span class="macro-help" ref={root}>
      <button
        ref={trigger}
        class="help-btn"
        title="Available macros"
        aria-label="Available macros"
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <FontAwesomeIcon icon={faCircleQuestion} size={14} />
      </button>
      <DropdownSurface
        open={open()}
        anchor={() => root}
        focusTarget={() => trigger}
        onClose={() => setOpen(false)}
        class="help-card"
        role="dialog"
        ariaLabel="Available macros"
        minWidth={CARD_WIDTH}
        viewportGutter={VIEWPORT_GUTTER}
        anchorInset={-VIEWPORT_GUTTER}
        gap={CARD_GAP}
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
      </DropdownSurface>
    </span>
  );
}
