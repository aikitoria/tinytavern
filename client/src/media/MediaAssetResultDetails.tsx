import { Show, createResource } from 'solid-js';
import Modal from '../components/ui/Modal.tsx';
import { api } from '../state/api.ts';
import { toast } from '../state/store.ts';
import { errorMessage } from '../util.ts';
import MediaResultDetails from './MediaResultDetails.tsx';
import { resultWorkflowDetails } from './resultWorkflowDetails.ts';

export default function MediaAssetResultDetails(props: { assetId: number; onClose: () => void }) {
  const [result, { refetch }] = createResource(
    () => props.assetId,
    async (id) => {
      try {
        const details = await api.mediaAssetResultDetails(id);
        return { details, workflow: resultWorkflowDetails(details), error: '' };
      } catch (error) {
        return { details: null, workflow: null, error: errorMessage(error) };
      }
    },
  );
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied.', 'success');
    } catch {
      toast('Could not copy the text.');
    }
  };
  return (
    <Show
      when={result()?.details ? result() : undefined}
      fallback={
        <Modal
          title="Result details"
          class="h-auto overflow-hidden [&_.modal-head]:flex-none [&_.modal-body]:flex [&_.modal-body]:flex-col [&_.modal-body]:gap-3 [&_.modal-body]:min-h-0 [&_.hint]:m-0 phone:[&_.modal-body]:p-2 w-full max-w-190 max-h-[min(calc(100dvh_-_40px),_900px)]"
          onClose={props.onClose}
        >
          <Show
            when={result()?.error}
            fallback={
              <p class="hint" role="status">
                Loading result details…
              </p>
            }
          >
            <p class="notice notice-error" role="alert">
              {result()?.error}
            </p>
            <button disabled={result.loading} onClick={() => void refetch()}>
              Retry
            </button>
          </Show>
        </Modal>
      }
    >
      {(loaded) => (
        <MediaResultDetails
          instruction={loaded().details!.instruction}
          prompt={loaded().details!.prompt}
          workflow={loaded().workflow!}
          onCopy={(text) => void copy(text)}
          onClose={props.onClose}
        />
      )}
    </Show>
  );
}
