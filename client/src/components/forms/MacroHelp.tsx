import { faCircleQuestion } from '@fortawesome/free-regular-svg-icons';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';
import { For, createSignal } from 'solid-js';
import DropdownSurface from '../ui/DropdownSurface.tsx';

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
    <span class="align-text-bottom ml-2 inline-flex relative" ref={root}>
      <button
        ref={trigger}
        class="icon-btn [&.icon-btn]:p-0 [&.icon-btn]:flex-none [&.icon-btn]:text-muted [&.icon-btn]:text-size-inherit [&.icon-btn]:w-4.5 [&.icon-btn]:min-w-4.5 [&.icon-btn]:h-4.5 [&.icon-btn:hover]:text-foreground"
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
        class="z-150 p-3 items-baseline grid gap-y-2 gap-x-3 max-w-[calc(100vw_-_16px)] grid-cols-[max-content_1fr]"
        role="dialog"
        ariaLabel="Available macros"
        minWidth={CARD_WIDTH}
        viewportGutter={VIEWPORT_GUTTER}
        anchorInset={-VIEWPORT_GUTTER}
        gap={CARD_GAP}
      >
        <div class="text-foreground mb-0.5 col-span-full font-semibold text-caption">
          Available macros
        </div>
        <For each={rows()}>
          {([macro, description]) => (
            <div class="contents text-dim text-caption [&_code]:font-code [&_code]:text-xs [&_code]:text-accent [&_code]:whitespace-nowrap [&_span]:text-caption [&_span]:text-dim [&_span]:leading-hint">
              <code>{macro}</code>
              <span>{description}</span>
            </div>
          )}
        </For>
      </DropdownSurface>
    </span>
  );
}
