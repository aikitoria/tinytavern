import { For, Show, createUniqueId } from 'solid-js';
import type { MediaWorkflowInput, MediaWorkflowValues } from '@tinytavern/shared';
import Select from '../components/Select.tsx';
import ResolutionHelp from './ResolutionHelp.tsx';

export default function WorkflowInputs(props: {
  controls: MediaWorkflowInput[];
  values: MediaWorkflowValues;
  disabled: boolean;
  onChange: (key: string, value: number | string | boolean) => void;
}) {
  return (
    <For each={props.controls}>
      {(control) => {
        const id = createUniqueId();
        const value = () => props.values[control.key] ?? control.value;
        if (control.type === 'select') {
          return (
            <div class="workflow-input items-center grid min-w-0 gap-y-2 gap-x-3 [&>*]:min-w-0 narrow-panel:[&:not(.workflow-input-boolean)]:grid-cols-1 narrow-panel:[&:not(.workflow-input-boolean)]:gap-1 grid-cols-[minmax(0,_42%)_minmax(0,_1fr)] [&:where(.workflow-input-multiline)]:grid-cols-[minmax(0,_1fr)]">
              <label>{control.label}</label>
              <Select
                ariaLabel={control.label}
                value={String(value())}
                disabled={props.disabled}
                options={control.options.map((option) => ({ value: option, label: option }))}
                onChange={(value) => props.onChange(control.key, value)}
              />
            </div>
          );
        }
        if (control.type === 'boolean') {
          return (
            <div class="workflow-input items-center grid min-w-0 workflow-input-boolean min-h-control gap-y-2 gap-x-3 [&>*]:min-w-0 narrow-panel:[&:not(.workflow-input-boolean)]:grid-cols-1 narrow-panel:[&:not(.workflow-input-boolean)]:gap-1 [&>input]:justify-self-start [&>input]:w-auto [&>input]:m-0 grid-cols-[minmax(0,_42%)_minmax(0,_1fr)] [&:where(.workflow-input-multiline)]:grid-cols-[minmax(0,_1fr)]">
              <label for={id}>{control.label}</label>
              <input
                id={id}
                type="checkbox"
                checked={value() === true}
                disabled={props.disabled}
                onChange={(event) => props.onChange(control.key, event.currentTarget.checked)}
              />
            </div>
          );
        }
        if (control.type === 'string') {
          return (
            <div
              class="workflow-input items-center grid min-w-0 gap-y-2 gap-x-3 [&>*]:min-w-0 narrow-panel:[&:not(.workflow-input-boolean)]:grid-cols-1 narrow-panel:[&:not(.workflow-input-boolean)]:gap-1 grid-cols-[minmax(0,_42%)_minmax(0,_1fr)] [&:where(.workflow-input-multiline)]:grid-cols-[minmax(0,_1fr)]"
              classList={{ 'workflow-input-multiline': control.multiline }}
            >
              <label for={id}>{control.label}</label>
              {control.multiline ? (
                <textarea
                  id={id}
                  rows={4}
                  value={String(value())}
                  disabled={props.disabled}
                  onInput={(event) => props.onChange(control.key, event.currentTarget.value)}
                />
              ) : (
                <input
                  id={id}
                  type="text"
                  value={String(value())}
                  disabled={props.disabled}
                  onInput={(event) => props.onChange(control.key, event.currentTarget.value)}
                />
              )}
            </div>
          );
        }
        return (
          <div class="workflow-input items-center grid min-w-0 gap-y-2 gap-x-3 [&>*]:min-w-0 narrow-panel:[&:not(.workflow-input-boolean)]:grid-cols-1 narrow-panel:[&:not(.workflow-input-boolean)]:gap-1 grid-cols-[minmax(0,_42%)_minmax(0,_1fr)] [&:where(.workflow-input-multiline)]:grid-cols-[minmax(0,_1fr)]">
            <div class="setting-label flex items-center gap-2 min-h-6 mt-2 [&>label]:m-0 [&>label]:min-w-0">
              <label for={id}>{control.label}</label>
              <Show when={control.input === 'megapixels'}>
                <ResolutionHelp />
              </Show>
            </div>
            <input
              id={id}
              type="number"
              value={String(value())}
              min={control.min}
              max={control.max}
              step={control.step}
              disabled={props.disabled}
              onInput={(event) => props.onChange(control.key, event.currentTarget.valueAsNumber)}
            />
          </div>
        );
      }}
    </For>
  );
}
