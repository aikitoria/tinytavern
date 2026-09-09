import { For, Show } from 'solid-js';
import Modal from '../components/Modal.tsx';
import type { resultWorkflowDetails } from './resultWorkflowDetails.ts';

export default function MediaResultDetails(props: {
  instruction: string;
  prompt: string;
  variation?: number;
  workflow: ReturnType<typeof resultWorkflowDetails>;
  disabled?: boolean;
  onCopy: (text: string) => void;
  onUseInstruction?: () => void;
  onUsePrompt?: () => void;
  onClose: () => void;
}) {
  const fields = [
    { label: 'Instruction', text: () => props.instruction, use: () => props.onUseInstruction },
    { label: 'Prompt', text: () => props.prompt, use: () => props.onUsePrompt },
  ];
  return (
    <Modal
      title={
        props.variation === undefined ? 'Result details' : `Variation ${props.variation} details`
      }
      class="h-auto overflow-hidden [&_.modal-head]:flex-none [&_.modal-body]:flex [&_.modal-body]:flex-col [&_.modal-body]:gap-3 [&_.modal-body]:min-h-0 [&_.hint]:m-0 phone:[&_.modal-body]:p-2 w-full max-w-190 max-h-[min(calc(100dvh_-_40px),_900px)]"
      onClose={props.onClose}
    >
      <section
        class="p-3 border border-solid border-subtle rounded-md bg-canvas flex-none min-w-0"
        aria-label="Workflow settings"
      >
        <dl class="wrap-anywhere grid m-0 gap-y-1 gap-x-3 text-sm leading-body [&_dt]:text-dim [&_dd]:m-0 [&_dd]:whitespace-pre-wrap grid-cols-[minmax(0,_140px)_minmax(0,_1fr)] phone:grid-cols-[minmax(0,_1fr)_minmax(0,_2fr)]">
          <dt>Workflow</dt>
          <dd>{props.workflow.name}</dd>
          <dt>Seed</dt>
          <dd>{props.workflow.seed ?? 'Unavailable'}</dd>
          <For each={props.workflow.parameters}>
            {(parameter) => (
              <>
                <dt>{parameter.label}</dt>
                <dd>{parameter.value}</dd>
              </>
            )}
          </For>
        </dl>
        <Show when={!props.workflow.available}>
          <p class="hint">
            Workflow defaults are unavailable. Only saved parameter overrides are shown.
          </p>
        </Show>
      </section>
      <For each={fields}>
        {(field) => (
          <section class="p-3 border border-solid border-subtle rounded-md bg-canvas flex-none min-w-0">
            <div class="mb-2 flex items-center gap-2 flex-wrap [&_h3]:text-sm [&_h3]:m-0 [&_h3]:mr-auto">
              <h3>{field.label}</h3>
              <button disabled={!field.text()} onClick={() => props.onCopy(field.text())}>
                Copy
              </button>
              <Show when={field.use()}>
                {(use) => (
                  <button disabled={props.disabled} onClick={() => use()()}>
                    Use in editor
                  </button>
                )}
              </Show>
            </div>
            <Show
              when={field.text()}
              fallback={<p class="hint">No {field.label.toLowerCase()} was used.</p>}
            >
              <p class="whitespace-pre-wrap wrap-anywhere text-field m-0 text-body-small leading-prose">
                {field.text()}
              </p>
            </Show>
          </section>
        )}
      </For>
    </Modal>
  );
}
