import { For, createEffect, createSignal, onCleanup } from 'solid-js';

const TOKEN_RE = /\{\{[^{}]*\}\}/g;
const BASIC_KEYS = new Set(['char', 'user']);
const TEMPLATE_KEYS = new Set([
  'char',
  'user',
  'system',
  'personality',
  'persona',
  'scenario',
  'examples',
]);

type MacroKind = 'valid' | 'invalid' | 'cond';

function classify(token: string, keys: Set<string>, template: boolean): MacroKind {
  const lower = token.toLowerCase();
  const slot = /^\{\{([a-z]+)\}\}$/.exec(lower);
  if (slot) return keys.has(slot[1]!) ? 'valid' : 'invalid';
  if (template) {
    if (lower === '{{/if}}') return 'cond';
    const cond = /^\{\{#if ([a-z]+)\}\}$/.exec(lower);
    if (cond) return TEMPLATE_KEYS.has(cond[1]!) ? 'cond' : 'invalid';
  }
  return 'invalid';
}

interface Segment {
  text: string;
  kind: MacroKind | null;
}

function segments(text: string, keys: Set<string>, template: boolean): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    if (match.index! > last) out.push({ text: text.slice(last, match.index), kind: null });
    out.push({ text: match[0], kind: classify(match[0], keys, template) });
    last = match.index! + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: null });
  return out;
}

/** An overlay highlights macros while preserving native textarea text metrics and caret. */
export default function MacroTextarea(props: {
  ref?: HTMLTextAreaElement | ((el: HTMLTextAreaElement) => void);
  /** Enables the template macro set ({{system}}, {{#if x}}…) on top of {{char}}/{{user}}. */
  template?: boolean;
  /** Additional macro names to treat as valid (e.g. a plugin's {{instruction}}). */
  extraKeys?: string[];
  /** Exclusive macro set: replaces the base {{char}}/{{user}} keys entirely. */
  keys?: string[];
  rows?: number | string;
  class?: string;
  classList?: { [key: string]: boolean | undefined };
  placeholder?: string;
  /** Notified on every text change, including programmatic .value loads. */
  onText?: (text: string) => void;
}) {
  const [text, setTextSignal] = createSignal('');
  const setText = (next: string) => {
    setTextSignal(next);
    props.onText?.(next);
  };
  let overlay!: HTMLDivElement;
  let area: HTMLTextAreaElement | undefined;
  let observer: ResizeObserver | undefined;

  // Match the textarea's scrollbar inset and scroll position to keep highlights aligned.
  const sync = () => {
    if (!area) return;
    overlay.style.right = `${Math.max(0, area.offsetWidth - area.clientWidth - 2)}px`;
    overlay.scrollTop = area.scrollTop;
  };
  createEffect(() => {
    void text();
    queueMicrotask(sync); // after the overlay re-rendered (scrollbar may have appeared)
  });
  onCleanup(() => observer?.disconnect());

  // Intercept editor .value loads: they fire no input event.
  const attach = (el: HTMLTextAreaElement) => {
    area = el;
    const base = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
    Object.defineProperty(el, 'value', {
      get: () => base.get!.call(el) as string,
      set: (next: unknown) => {
        base.set!.call(el, next);
        setText(String(next ?? ''));
      },
    });
    observer = new ResizeObserver(sync);
    observer.observe(el);
    (props.ref as ((el: HTMLTextAreaElement) => void) | undefined)?.(el);
  };

  return (
    <div class="macro-box" classList={props.classList}>
      <div class={`macro-overlay ${props.class ?? ''}`} ref={overlay} aria-hidden="true">
        <For
          each={segments(
            text(),
            props.keys
              ? new Set(props.keys)
              : new Set([
                  ...(props.template ? TEMPLATE_KEYS : BASIC_KEYS),
                  ...(props.extraKeys ?? []),
                ]),
            props.template === true,
          )}
        >
          {(seg) => (seg.kind ? <mark class={`macro-${seg.kind}`}>{seg.text}</mark> : seg.text)}
        </For>
        {'\n'}
      </div>
      <textarea
        ref={attach}
        rows={props.rows ?? 8}
        class={props.class}
        placeholder={props.placeholder}
        onInput={(e) => setText(e.currentTarget.value)}
        onScroll={sync}
      />
    </div>
  );
}
