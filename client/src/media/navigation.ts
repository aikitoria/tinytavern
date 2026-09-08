import { restoreMediaInputs } from './restoreInputs.ts';
import {
  applyPageLocation,
  navigatePageWithGuards,
  readPageLocation,
  returnToPageLocation,
  type PageLocation,
} from '../state/pageLocation.ts';
import { batch } from 'solid-js';
import { dialogStack } from '../state/dialogStack.ts';
import type { MediaAsset, MediaJobInput, MediaOperation } from '@tinytavern/shared';
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
  id: string;
  operation: MediaOperation;
  jobId: string | null;
  contextConversationId: number | null;
  destination: 'gallery' | 'chat';
  prompt: string;
  inputs: MediaJobInput[];
  assets: MediaAsset[];
}

export function openMediaTool(
  operation: MediaOperation,
  options: {
    conversationId?: number | null;
    prompt?: string;
    input?: { asset: MediaAsset; slot: MediaJobInput['slot'] };
    jobId?: string;
  } = {},
): void {
  const existing = options.jobId ? dialogStack.findJob(options.jobId, state.mediaJobs) : undefined;
  if (existing) {
    if (existing !== dialogStack.top()) {
      const target = existing.page;
      navigatePageWithGuards(target, () => returnToPageLocation(target, () => restorePage(target)));
    }
    return;
  }
  const input = options.input;
  const conversationId = options.conversationId ?? null;
  const session: MediaToolSession = {
    id: crypto.randomUUID(),
    operation,
    jobId: options.jobId ?? null,
    contextConversationId: conversationId,
    destination: conversationId === null ? 'gallery' : 'chat',
    prompt: options.prompt ?? '',
    inputs: input ? [{ slot: input.slot, assetId: input.asset.id }] : [],
    assets: input ? [input.asset] : [],
  };
  const current = readPageLocation();
  openDialog(
    { chatId: current.chatId, viewMode: current.viewMode, modal: 'media-tools', media: session },
    session,
  );
}

export function openMediaJobs(): void {
  openModal('media-jobs');
}

export function leaveMediaTool(): void {
  openModal(null);
}

export async function openMediaRerun(
  asset: MediaAsset,
  conversationId?: number | null,
): Promise<void> {
  const job = await api.rerunMediaAsset(asset.id, crypto.randomUUID(), {
    contextConversationId: conversationId ?? null,
    destination: conversationId == null ? 'gallery' : 'chat',
    reviewBeforeSave: true,
  });
  applyMediaJob(job);
  openMediaTool(job.operation, { jobId: job.id, conversationId });
}

export const MEDIA_TOOL_LINKS = [
  { operation: 'image', label: 'Create image' },
  { operation: 'image-edit', label: 'Edit image' },
  { operation: 'video', label: 'Create video' },
] as const;

export const CHAT_MEDIA_TOOL_LINKS = [
  { operation: 'image', label: 'Create image from chat' },
  { operation: 'video', label: 'Create video from chat' },
] as const;

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
