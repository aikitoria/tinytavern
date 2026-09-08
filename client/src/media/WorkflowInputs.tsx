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
            <div class="workflow-input">
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
            <div class="workflow-input workflow-input-boolean">
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
              class="workflow-input"
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
          <div class="workflow-input">
            <div class="setting-label">
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
