import { faArrowRotateLeft } from '@fortawesome/free-solid-svg-icons';
import { Show, createSignal, createUniqueId, onCleanup, untrack } from 'solid-js';
import type { JSX } from 'solid-js';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import type { SelectHandle } from './Select.tsx';

type NativeControl = HTMLInputElement | HTMLTextAreaElement;
type FieldControl = NativeControl | SelectHandle;

export interface DefaultField<T extends string | boolean = string | boolean> {
  value: T;
  ref: (control: T extends boolean ? HTMLInputElement : NativeControl | SelectHandle) => void;
  changed: () => boolean;
  reset: () => void;
  id: () => string | undefined;
  element: () => FieldControl | undefined;
}

/** Tracks both typing and imperative editor loads without polling or rescanning forms. */
export function createDefaultField(defaultValue: () => string): DefaultField<string>;
export function createDefaultField(defaultValue: () => boolean): DefaultField<boolean>;
export function createDefaultField(defaultValue: () => string | boolean): DefaultField {
  const id = createUniqueId();
  const [control, setControl] = createSignal<FieldControl>();
  const [revision, setRevision] = createSignal(0);
  let detach: (() => void) | undefined;
  const boolean = typeof untrack(defaultValue) === 'boolean';
  const read = (): string | boolean => {
    revision();
    const target = control();
    if (!target) return defaultValue();
    return boolean ? (target as HTMLInputElement).checked : target.value;
  };
  const write = (value: string | boolean) => {
    const target = untrack(control);
    if (!target) return;
    if (boolean) (target as HTMLInputElement).checked = value as boolean;
    else target.value = value as string;
  };
  const ref = (target: FieldControl) => {
    detach?.();
    detach = undefined;
    setControl(target);
    if (!(target instanceof HTMLElement)) return;
    target.id ||= `setting-${id}`;
    const key = boolean ? 'checked' : 'value';
    const own = Object.getOwnPropertyDescriptor(target, key);
    let owner: object | null = target;
    let descriptor = own;
    while (!descriptor && (owner = Object.getPrototypeOf(owner))) {
      descriptor = Object.getOwnPropertyDescriptor(owner, key);
    }
    const original = descriptor!;
    const refresh = () => setRevision((value) => value + 1);
    const setter = (value: unknown) => {
      original.set!.call(target, value);
      refresh();
    };
    Object.defineProperty(target, key, {
      configurable: true,
      get: () => original.get!.call(target),
      set: setter,
    });
    target.addEventListener('input', refresh);
    target.addEventListener('change', refresh);
    detach = () => {
      target.removeEventListener('input', refresh);
      target.removeEventListener('change', refresh);
      if (Object.getOwnPropertyDescriptor(target, key)?.set !== setter) return;
      if (own) Object.defineProperty(target, key, own);
      else Reflect.deleteProperty(target, key);
    };
    refresh();
  };
  onCleanup(() => detach?.());

  return {
    get value() {
      return untrack(read);
    },
    set value(value) {
      write(value);
    },
    ref,
    changed: () => read() !== defaultValue(),
    reset() {
      const target = untrack(control);
      if (!target) return;
      if (target instanceof HTMLElement) {
        write(defaultValue());
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        target.focus({ preventScroll: true });
      } else {
        target.change(defaultValue() as string);
        target.focus();
      }
    },
    id: () => {
      revision();
      const target = control();
      return target instanceof HTMLElement ? target.id : undefined;
    },
    element: control,
  };
}

export function RevertButton(props: {
  changed: boolean;
  onRevert: () => void;
  describedBy?: string;
}) {
  return (
    <Show when={props.changed}>
      <button
        type="button"
        class="icon-btn [&.icon-btn]:min-w-6 [&.icon-btn]:p-0 [&.icon-btn]:flex-none [&.icon-btn]:text-muted [&.icon-btn]:size-6 [&.icon-btn:hover]:text-foreground"
        title="Revert to default"
        aria-label="Revert to default"
        aria-describedby={props.describedBy}
        onClick={props.onRevert}
      >
        <FontAwesomeIcon icon={faArrowRotateLeft} size={12} />
      </button>
    </Show>
  );
}

/** Keep the revert action outside the label so it cannot also toggle a checkbox. */
export default function SettingLabel(props: {
  field?: Pick<DefaultField, 'changed' | 'reset' | 'id'>;
  changed?: boolean;
  onRevert?: () => void;
  for?: string;
  check?: boolean;
  children: JSX.Element;
}) {
  const id = createUniqueId();
  return (
    <div
      class="setting-label flex items-center gap-2 min-h-6 mt-2 [&>label]:m-0 [&>label]:min-w-0"
      classList={{ 'setting-check': props.check }}
    >
      <label id={id} for={props.for ?? props.field?.id()} classList={{ 'check-row': props.check }}>
        {props.children}
      </label>
      <RevertButton
        changed={props.changed ?? props.field?.changed() ?? false}
        onRevert={() => (props.onRevert ? props.onRevert() : props.field?.reset())}
        describedBy={id}
      />
    </div>
  );
}
