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
  const slot = /^\{\{([a-z][a-z0-9_]*)\}\}$/.exec(lower);
  if (slot) return keys.has(slot[1]!) ? 'valid' : 'invalid';
  if (template) {
    if (lower === '{{/if}}') return 'cond';
    const cond = /^\{\{#if ([a-z][a-z0-9_]*)\}\}$/.exec(lower);
    if (cond) return keys.has(cond[1]!) ? 'cond' : 'invalid';
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
  /** Additional macro names to treat as valid (e.g. {{instruction}}). */
  extraKeys?: string[];
  /** Exclusive macro set: replaces the base {{char}}/{{user}} keys entirely. */
  keys?: string[];
  rows?: number | string;
  class?: string;
  classList?: { [key: string]: boolean | undefined };
  placeholder?: string;
  /** Optional controlled draft; existing imperative editors can continue using ref. */
  value?: string;
  readOnly?: boolean;
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
  createEffect(() => {
    const value = props.value;
    if (area && value !== undefined && area.value !== value) area.value = value;
  });

  // Match the textarea's scrollbar inset and scroll position to keep highlights aligned.
  const syncScroll = () => {
    if (area && overlay.scrollTop !== area.scrollTop) overlay.scrollTop = area.scrollTop;
  };
  const sync = () => {
    if (!area?.isConnected) return;
    const right = `${Math.max(0, area.offsetWidth - area.clientWidth - 2)}px`;
    const scrollTop = area.scrollTop;
    const insetChanged = overlay.style.right !== right;
    const scrollChanged = overlay.scrollTop !== scrollTop;
    if (insetChanged) overlay.style.right = right;
    if (insetChanged || scrollChanged) overlay.scrollTop = scrollTop;
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
      configurable: true,
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
    <div
      class="macro-box [&_textarea]:block [&_textarea]:relative [&_textarea]:bg-clear [&_textarea::-webkit-scrollbar]:w-2.5 [&_textarea::-webkit-scrollbar-thumb]:bg-hover [&_textarea::-webkit-scrollbar-track]:bg-clear [&_textarea::-webkit-scrollbar-corner]:bg-clear"
      classList={props.classList}
    >
      <div
        class={`macro-overlay overflow-hidden wrap-break-word absolute inset-0 border border-solid border-transparent rounded-sm py-control-y px-3 whitespace-pre-wrap text-transparent pointer-events-none [&_mark]:text-transparent ${props.class ?? ''}`}
        ref={overlay}
        aria-hidden="true"
      >
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
        readOnly={props.readOnly}
        rows={props.rows ?? 8}
        class={props.class}
        placeholder={props.placeholder}
        onInput={(e) => setText(e.currentTarget.value)}
        onScroll={syncScroll}
      />
    </div>
  );
}
