import {
  applyPageLocation,
  parsePageLocation as readPageLocationFromHash,
  readPageLocation,
  rememberMediaPage,
  writePageLocation,
  type PageLocation,
} from '../state/pageLocation.ts';
import { createSignal } from 'solid-js';
import type { MediaAsset, MediaJobInput, MediaOperation } from '@tinytavern/shared';
import {
  applyMediaJob,
  openModal,
  selectConversation,
  setState,
  state,
  type ModalKind,
} from '../state/store.ts';
import { api } from '../state/api.ts';

export interface MediaToolSession {
  id: string;
  operation: MediaOperation;
  jobId: string | null;
  contextConversationId: number | null;
  destination: 'gallery' | 'chat';
  prompt: string;
  returnModal: ModalKind;
  returnHash?: string;
  inputs: MediaJobInput[];
  assets: MediaAsset[];
  showJobs: boolean;
}

export const [mediaToolSession, setMediaToolSession] = createSignal<MediaToolSession | null>(null);

export function openMediaTool(
  operation: MediaOperation,
  options: {
    conversationId?: number | null;
    prompt?: string;
    input?: { asset: MediaAsset; slot: MediaJobInput['slot'] };
    jobId?: string;
    showJobs?: boolean;
  } = {},
): void {
  const previous = mediaToolSession();
  const returnModal = state.modal === 'media-tools' ? (previous?.returnModal ?? null) : state.modal;
  const returnHash = state.modal === 'media-tools' ? previous?.returnHash : location.hash;
  const input = options.input;
  const conversationId = options.conversationId ?? null;
  setMediaToolSession({
    id: crypto.randomUUID(),
    operation,
    jobId: options.jobId ?? null,
    contextConversationId: conversationId,
    destination: conversationId === null ? 'gallery' : 'chat',
    prompt: options.prompt ?? '',
    returnModal,
    returnHash,
    inputs: input ? [{ slot: input.slot, assetId: input.asset.id }] : [],
    assets: input ? [input.asset] : [],
    showJobs: options.showJobs ?? false,
  });
  openModal('media-tools');
  rememberMediaPage(mediaToolSession()!);
}

export function leaveMediaTool(): void {
  const session = mediaToolSession();
  if (session?.returnHash) {
    const page = readPageLocationFromHash(session.returnHash);
    if (page.chatId === state.selectedId && page.modal === session.returnModal) {
      openModal(page.modal);
      writePageLocation(page);
    } else {
      restorePage(page);
    }
  } else openModal(session?.returnModal ?? null);
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
  applyPageLocation({ ...page, chatId }, () => {
    selectConversation(chatId);
    setState('viewMode', page.viewMode ?? 'chat');
    if (page.modal === 'media-tools' && page.media) {
      const media = page.media;
      setMediaToolSession({
        id: crypto.randomUUID(),
        ...media,
        destination: media.contextConversationId === null ? 'gallery' : 'chat',
        prompt: '',
        inputs: [],
        assets: [],
      });
      openModal('media-tools');
    } else {
      openModal(page.modal);
    }
  });
}

let pageRestored = false;
export function restoreOpenPage(): void {
  if (pageRestored) return;
  pageRestored = true;
  restorePage(readPageLocation());
}
