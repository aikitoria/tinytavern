import { Show, createMemo, createSignal, onMount } from 'solid-js';
import { faArrowLeft } from '@fortawesome/free-solid-svg-icons';
import type { MediaJob } from '@tinytavern/shared';
import Modal from '../components/Modal.tsx';
import FontAwesomeIcon from '../components/FontAwesomeIcon.tsx';
import { api } from '../state/api.ts';
import { useDialogActive } from '../state/dialogContext.ts';
import { applyMediaJob, handleServerEvent, openModal, state, toast } from '../state/store.ts';
import { errorMessage } from '../util.ts';
import MediaJobList from './MediaJobList.tsx';
import { groupMediaJobs } from './jobCards.ts';
import { openMediaTool } from './navigation.ts';
import './media.css';

export default function MediaJobsModal() {
  const active = useDialogActive();
  const [cursor, setCursor] = createSignal<MediaJob | undefined>();
  const [more, setMore] = createSignal(true);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const groups = createMemo(() => groupMediaJobs(Object.values(state.mediaJobs)));
  const back = () => openModal(null);

  const loadMore = async () => {
    if (loading()) return;
    setLoading(true);
    setError('');
    try {
      const page = await api.mediaJobs(cursor());
      for (const item of page) applyMediaJob(item);
      setCursor(page.at(-1));
      setMore(page.length === 100);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  onMount(() => void loadMore());

  const remove = async (job: MediaJob) => {
    try {
      if (job.draft?.state === 'open') {
        await api.discardMediaDraft(job, job.draft.revision);
      } else {
        await api.deleteMediaJob(job);
        handleServerEvent({ t: 'mediaJobDeleted', id: job.id });
      }
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  return (
    <Modal
      title="Media jobs"
      fullscreen
      hideCloseButton
      class="media-tools-modal"
      onClose={back}
      headerExtra={
        <div class="page-header-actions">
          <button class="page-back" onClick={back}>
            <FontAwesomeIcon icon={faArrowLeft} size={13} /> Back
          </button>
        </div>
      }
    >
      <div class="media-workspace">
        <Show when={error()}>
          <p class="notice notice-error" role="alert">
            {error()}
          </p>
        </Show>
        <MediaJobList
          active={active()}
          groups={groups()}
          busy={false}
          more={more()}
          loading={loading()}
          onOpen={(job) =>
            openMediaTool(job.operation, {
              jobId: job.id,
              conversationId: job.contextConversationId,
            })
          }
          onRemove={(job) => void remove(job)}
          onLoadMore={() => void loadMore()}
        />
      </div>
    </Modal>
  );
}
