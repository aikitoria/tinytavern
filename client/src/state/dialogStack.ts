import type { MediaJob } from '@tinytavern/shared';
import { createSignal } from 'solid-js';
import type { RestoredMediaInputs } from '../media/restoreInputs.ts';
import type { MediaToolSession } from '../media/navigation.ts';
import { formatPageLocation, pageStack, type PageLocation } from './pageLocation.ts';

export interface DialogFrame {
  readonly id: string;
  // Updated in place: the frame identity owns the mounted component and its local state.
  page: PageLocation;
  readonly media?: MediaToolSession;
}

function createFrame(
  page: PageLocation,
  session?: MediaToolSession,
  inputs?: RestoredMediaInputs,
): DialogFrame {
  const id = crypto.randomUUID();
  const media = page.media;
  return {
    id,
    page,
    media:
      session ??
      (media
        ? {
            id,
            ...media,
            destination: media.contextConversationId === null ? 'gallery' : 'chat',
            prompt: '',
            inputs: [],
            assets: [],
            ...inputs,
          }
        : undefined),
  };
}

export function createDialogStack() {
  const [frames, setFrames] = createSignal<DialogFrame[]>([]);
  let background: PageLocation = { chatId: null, modal: null };
  const top = () => frames().at(-1);
  const retainedCount = (page: PageLocation) => {
    const pages = pageStack(page).filter((item) => item.modal);
    const current = frames();
    let count = 0;
    while (
      count < pages.length &&
      count < current.length &&
      formatPageLocation(pages[count]!) === formatPageLocation(current[count]!.page)
    )
      count++;
    return count;
  };
  return {
    frames,
    top,
    findJob(jobId: string, jobs: Readonly<Record<string, MediaJob>>) {
      const draftId = jobs[jobId]?.draft?.id;
      return frames().find((frame) => {
        const media = frame.page.media;
        if (!media?.jobId) return false;
        return (
          media.jobId === jobId || (draftId != null && jobs[media.jobId]?.draft?.id === draftId)
        );
      });
    },
    parent: () => frames().at(-2)?.page ?? background,
    retains(frame: DialogFrame, page: PageLocation) {
      const index = frames().indexOf(frame);
      return index >= 0 && index < retainedCount(page);
    },
    restore(
      page: PageLocation,
      restoreInputs?: (page: PageLocation) => RestoredMediaInputs | undefined,
    ) {
      const pages = pageStack(page);
      background = pages[0]!;
      const dialogs = pages.filter((item) => item.modal);
      const keep = retainedCount(page);
      setFrames([
        ...frames().slice(0, keep),
        ...dialogs.slice(keep).map((item) => createFrame(item, undefined, restoreInputs?.(item))),
      ]);
    },
    push(page: PageLocation, from: PageLocation, session?: MediaToolSession) {
      if (!frames().length) background = from;
      setFrames([...frames(), createFrame(page, session)]);
    },
    pop(): PageLocation {
      setFrames(frames().slice(0, -1));
      return top()?.page ?? background;
    },
    remember(page: PageLocation): PageLocation {
      const frame = top();
      if (frame && frame.page.modal === page.modal) {
        page = { ...page, stack: frame.page.stack };
        frame.page = page;
      }
      return page;
    },
  };
}

export const dialogStack = createDialogStack();
