import { Show, type ComponentProps, type JSX } from 'solid-js';
import SettingLabel, { createDefaultField, type DefaultField } from './SettingField.tsx';
import MacroTextarea, { DEFAULT_TEXTAREA_ROWS } from './MacroTextarea.tsx';
import Select, { type SelectOption, type SelectHandle } from '../ui/Select.tsx';
import MacroHelp from './MacroHelp.tsx';

type Value = string | number | boolean;
export interface FormFieldProps<T extends Value> extends Omit<
  ComponentProps<typeof MacroTextarea>,
  'ref' | 'value' | 'onText'
> {
  label: JSX.Element;
  field?: DefaultField<string> | DefaultField<boolean>;
  kind?: 'text' | 'number' | 'password' | 'check' | 'macro' | 'textarea';
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  hint?: JSX.Element;
  help?: true | 'template' | [string, string][];
  disabled?: boolean;
  options?: SelectOption[];
  ariaLabel?: string;
  autocomplete?: string;
  inputEvent?: 'change' | 'input';
  mono?: boolean;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  id?: string;
  changed?: boolean;
  onRevert?: () => void;
  ref?: (element: HTMLTextAreaElement) => void;
}

/** Keep controls DOM-backed, including programmatic loads and native reset/focus behavior. */
export default function FormField<T extends Value>(props: FormFieldProps<T>) {
  // Control kind is fixed for each mounted field; its values and options remain reactive.
  const check = props.kind === 'check';
  const field =
    props.field ??
    (check
      ? createDefaultField(() => Boolean(props.defaultValue))
      : createDefaultField(() => String(props.defaultValue ?? '')));
  const ref = (el: HTMLInputElement | HTMLTextAreaElement | SelectHandle) => {
    if (props.id && el instanceof HTMLElement) el.id = props.id;
    (field.ref as (value: typeof el) => void)(el);
  };
  const change = (value: Value) => props.onChange?.(value as T);
  const inputChange = (el: HTMLInputElement) => change(typeof props.value === 'number' ? el.valueAsNumber : el.value);
  let control: JSX.Element;
  if (check)
    control = (
      <input
        ref={ref}
        type="checkbox"
        checked={props.value as boolean | undefined}
        disabled={props.disabled || props.readOnly}
        onChange={(e) => change(e.currentTarget.checked)}
      />
    );
  else if (props.options)
    control = (
      <Select
        id={props.id}
        ref={ref}
        options={props.options}
        value={props.value as string | undefined}
        ariaLabel={props.ariaLabel ?? (typeof props.label === 'string' ? props.label : undefined)}
        disabled={props.disabled || props.readOnly}
        onChange={change}
      />
    );
  else if (props.kind === 'macro')
    control = (
      <MacroTextarea
        ref={(el) => {
          ref(el);
          props.ref?.(el);
        }}
        value={props.value as string | undefined}
        onText={change}
        readOnly={props.readOnly}
        placeholder={props.placeholder}
        rows={props.rows}
        keys={props.keys}
        extraKeys={props.extraKeys}
        template={props.template}
        class={props.mono ? 'mono' : props.class}
        classList={props.classList}
      />
    );
  else if (props.kind === 'textarea')
    control = (
      <textarea
        ref={(el) => {
          ref(el);
          props.ref?.(el);
        }}
        value={props.value as string | undefined}
        readOnly={props.readOnly}
        disabled={props.disabled}
        placeholder={props.placeholder}
        rows={props.rows ?? DEFAULT_TEXTAREA_ROWS}
        class={props.class}
        classList={props.classList}
        onInput={(event) => change(event.currentTarget.value)}
      />
    );
  else
    control = (
      <input
        ref={ref}
        type={props.kind ?? 'text'}
        value={props.value as string | number | undefined}
        readOnly={props.readOnly}
        disabled={props.disabled}
        placeholder={props.placeholder}
        autocomplete={props.autocomplete}
        min={props.min}
        max={props.max}
        step={props.step}
        onInput={(e) => {
          if (props.inputEvent !== 'change') inputChange(e.currentTarget);
        }}
        onChange={(e) => {
          if (props.inputEvent === 'change') inputChange(e.currentTarget);
        }}
      />
    );
  const inlineControl = check ? control : undefined;
  const afterControl = check ? undefined : control;
  return (
    <>
      <SettingLabel
        field={props.readOnly ? undefined : field}
        for={props.id ?? field.id()}
        check={check}
        changed={props.readOnly ? false : props.changed}
        onRevert={props.onRevert}
      >
        {inlineControl}
        {props.label}
        <Show when={props.help}>
          <MacroHelp template={props.help === 'template'} rows={Array.isArray(props.help) ? props.help : undefined} />
        </Show>
      </SettingLabel>
      {afterControl}
      <Show when={props.hint}>
        <p class="hint">{props.hint}</p>
      </Show>
    </>
  );
}

/** The same keys and defaults drive field handles, loading and snapshots. */
export function createFormFields<D extends Record<string, string | boolean>>(defaults: D) {
  type Values = { [K in keyof D]: D[K] extends boolean ? boolean : string };
  const fields = Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => [
      key,
      typeof value === 'boolean' ? createDefaultField(() => value) : createDefaultField(() => value),
    ]),
  ) as { [K in keyof D]: DefaultField<D[K] extends boolean ? boolean : string> };
  return {
    fields,
    load(value?: { [K in keyof D]?: Values[K] | null } | null) {
      for (const key in defaults) fields[key].value = (value?.[key] ?? defaults[key]) as never;
    },
    value: () => Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])) as Values,
  };
}
