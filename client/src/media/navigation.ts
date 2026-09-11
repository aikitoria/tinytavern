import { newRequestId } from '@tinytavern/shared';
import { restoreMediaInputs } from './restoreInputs.ts';
import {
  applyPageLocation,
  navigatePageWithGuards,
  readPageLocation,
  returnToPageLocation,
  type PageLocation,
} from '../state/pageLocation.ts';
import { batch } from 'solid-js';
import { dialogStack, type DialogFrame } from '../state/dialogStack.ts';
import type { MediaAsset, MediaJobInput } from '@tinytavern/shared';
import {
  applyMediaJob,
  openModal,
  openDialog,
  selectConversation,
  setState,
  state,
} from '../state/store.ts';
import { api } from '../state/api.ts';

export interface MediaToolSession {
  /** Stable retry identity, independent of the browser's local dialog numbering. */
  requestKey: string;
  workflowId: string | null;
  jobId: number | null;
  previewJobId?: number;
  assetId?: number;
  contextConversationId: number | null;
  galleryFolderId?: number | null;
  destination: 'gallery' | 'chat';
  prompt: string;
  inputs: MediaJobInput[];
  assets: MediaAsset[];
}

function revisitDialog(frame: DialogFrame | undefined, onReturn?: () => void): boolean {
  if (!frame) return false;
  if (frame !== dialogStack.top()) {
    const target = frame.page;
    navigatePageWithGuards(target, () => {
      onReturn?.();
      returnToPageLocation(target, () => restorePage(target));
    });
  } else onReturn?.();
  return true;
}

export function openMediaTool(
  workflowId: string | null = null,
  options: {
    conversationId?: number | null;
    galleryFolderId?: number | null;
    prompt?: string;
    input?: { asset: MediaAsset; slot?: MediaJobInput['slot'] };
    jobId?: number;
    assetId?: number;
  } = {},
): void {
  const existing = options.jobId ? dialogStack.findJob(options.jobId, state.mediaJobs) : undefined;
  if (
    revisitDialog(existing, () =>
      existing!.selectMediaPreview({ jobId: options.jobId!, assetId: options.assetId }),
    )
  )
    return;
  const input = options.input;
  const conversationId = options.conversationId ?? null;
  const session: MediaToolSession = {
    requestKey: newRequestId(),
    workflowId,
    jobId: options.jobId ?? null,
    assetId: options.assetId,
    contextConversationId: conversationId,
    galleryFolderId: conversationId === null ? (options.galleryFolderId ?? null) : null,
    destination: conversationId === null ? 'gallery' : 'chat',
    prompt: options.prompt ?? '',
    inputs: input?.slot ? [{ slot: input.slot, assetId: input.asset.id }] : [],
    assets: input ? [input.asset] : [],
  };
  const current = readPageLocation();
  openDialog(
    { chatId: current.chatId, viewMode: current.viewMode, modal: 'media-tools', media: session },
    session,
  );
}

export function openMediaJobs(): void {
  if (!revisitDialog(dialogStack.frames().find((frame) => frame.page.modal === 'media-jobs')))
    openModal('media-jobs');
}

export function leaveMediaTool(): void {
  openModal(null);
}

export async function openMediaRerun(
  asset: MediaAsset,
  conversationId?: number | null,
): Promise<void> {
  const job = await api.rerunMediaAsset(asset.id, newRequestId(), {
    contextConversationId: conversationId ?? null,
    destination: conversationId == null ? 'gallery' : 'chat',
    reviewBeforeSave: true,
  });
  applyMediaJob(job);
  openMediaTool(job.workflowId, { jobId: job.id, conversationId });
}

export function mediaToolLinks() {
  return [
    { workflowId: null, label: 'Generate media' },
    ...state.settings.mediaRendering.shortcuts.map((shortcut) => ({
      workflowId: shortcut.workflowId,
      label: shortcut.name,
    })),
  ];
}

export function restorePage(page: PageLocation): void {
  const chatId = state.conversations.some((chat) => chat.id === page.chatId) ? page.chatId : null;
  const restored = { ...page, chatId, stack: page.stack?.map((pane) => ({ ...pane, chatId })) };
  batch(() =>
    applyPageLocation(restored, () => {
      selectConversation(chatId);
      setState('viewMode', page.viewMode ?? 'chat');
      dialogStack.restore(restored, (pane) =>
        restoreMediaInputs(pane, state.gallery, state.mediaJobs),
      );
      setState('modal', page.modal);
    }),
  );
}

let pageRestored = false;
export function restoreOpenPage(): void {
  if (pageRestored) return;
  pageRestored = true;
  restorePage(readPageLocation());
}
