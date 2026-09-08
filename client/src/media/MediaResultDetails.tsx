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
      class="media-result-details"
      onClose={props.onClose}
    >
      <section class="media-result-section" aria-label="Workflow settings">
        <dl class="media-result-parameters">
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
          <section class="media-result-section">
            <div class="media-result-text-heading">
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
              <p class="media-result-text">{field.text()}</p>
            </Show>
          </section>
        )}
      </For>
    </Modal>
  );
}
