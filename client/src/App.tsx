import { dialogStack } from './state/dialogStack.ts';
import { DialogContext } from './state/dialogContext.ts';
import { For, Show, Switch, Match, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { installUiBack, registerUiBack } from './state/uiBack.ts';
import { booting, state, setState, streamingMessage } from './state/store.ts';
import Sidebar from './components/layout/Sidebar.tsx';
import Header from './components/layout/Header.tsx';
import ChatView from './components/chat/ChatView.tsx';
import Composer from './components/chat/Composer.tsx';
import MapSearch from './components/tree/MapSearch.tsx';
import SettingsModal from './components/settings/SettingsModal.tsx';
import ConversationSettings from './components/chat/ConversationSettings.tsx';
import PasswordGate from './components/layout/PasswordGate.tsx';
import ConfirmDialogHost from './components/ui/ConfirmDialogHost.tsx';
import { authPhase } from './state/auth.ts';
import {
  clearMessageSelection,
  messageSelection,
  messageSelectionActive,
  selectedMessageRange,
} from './state/messageSelection.ts';
import MessageSelectionBar from './components/chat/MessageSelectionBar.tsx';
import GalleryModal from './components/gallery/GalleryModal.tsx';
import MediaToolsModal from './media/MediaToolsModal.tsx';
import MediaJobsModal from './media/MediaJobsModal.tsx';

export default function App() {
  const [composerText, setComposerText] = createSignal('');
  const workspaceCovered = () =>
    dialogStack
      .frames()
      .some(
        (frame) =>
          frame.page.modal === 'gallery' ||
          frame.page.modal === 'media-tools' ||
          frame.page.modal === 'media-jobs' ||
          frame.page.modal === 'settings',
      );
  onMount(() => onCleanup(installUiBack()));
  // Boot is one-way; wait for the fade before unmounting its cover.
  const [bootGone, setBootGone] = createSignal(false);
  createEffect(() => {
    if (!booting()) setTimeout(() => setBootGone(true), 350);
  });
  createEffect(() => {
    if (messageSelection() && !selectedMessageRange()) clearMessageSelection();
  });
  createEffect(() => {
    document.title = streamingMessage() ? '● TinyTavern' : 'TinyTavern';
  });
  return (
    <Show when={authPhase() !== 'locked'} fallback={<PasswordGate />}>
      <div
        class="app isolate flex h-full small-touch:[&:where(.sidebar-open)_.header]:visible narrow:[&:where(.sidebar-open)_.header-view-btn]:display-none narrow:[&:where(.sidebar-open)_.header>.icon-btn]:display-none narrow:[&:where(.sidebar-open)_.header]:px-2"
        classList={{ 'sidebar-open': state.sidebarOpen, 'workspace-covered': workspaceCovered() }}
      >
        <Show when={!bootGone()}>
          <div
            class="boot-screen fixed inset-0 z-200 bg-canvas items-center gap-4 flex flex-col justify-center [&.boot-done]:opacity-0 [&.boot-done]:pointer-events-none"
            classList={{ 'boot-done': !booting() }}
          >
            <img src="/icon.svg" alt="" width="72" height="72" />
            <span class="text-intro font-bold">TinyTavern</span>
            <span class="boot-dots flex gap-2 [&_i]:rounded-circle [&_i]:bg-accent [&_i]:size-2 [&_i:nth-child(2)]:bg-accent-hot [&_i:nth-child(3)]:bg-secondary">
              <i />
              <i />
              <i />
            </span>
          </div>
        </Show>
        <Sidebar />
        <Show when={state.sidebarOpen}>
          <div
            ref={(element) => registerUiBack(element, () => setState('sidebarOpen', false))}
            class="backdrop display-none small-touch:block small-touch:fixed small-touch:inset-0 small-touch:z-50"
            onClick={() => setState('sidebarOpen', false)}
          />
        </Show>
        <main class="main bg-canvas flex flex-col flex-1 min-w-0 relative">
          <Header />
          <ChatView active={!workspaceCovered()} pendingMessage={composerText()} />
          <Show
            when={state.viewMode === 'map'}
            fallback={
              <Show
                when={messageSelectionActive()}
                fallback={<Composer text={composerText()} onText={setComposerText} />}
              >
                <MessageSelectionBar />
              </Show>
            }
          >
            <MapSearch />
          </Show>
        </main>
        <For each={dialogStack.frames()}>
          {(frame) => {
            const active = () => dialogStack.top() === frame;
            return (
              <DialogContext.Provider value={{ frame, active }}>
                <Switch>
                  <Match when={frame.page.modal === 'settings'}>
                    <SettingsModal />
                  </Match>
                  <Match when={frame.page.modal === 'conversation'}>
                    <ConversationSettings />
                  </Match>
                  <Match when={frame.page.modal === 'gallery'}>
                    <GalleryModal active={active()} />
                  </Match>
                  <Match when={frame.page.modal === 'media-jobs'}>
                    <MediaJobsModal />
                  </Match>
                  <Match when={frame.media}>
                    <MediaToolsModal session={frame.media!} />
                  </Match>
                </Switch>
              </DialogContext.Provider>
            );
          }}
        </For>
        <ConfirmDialogHost />
        <div class="toasts" aria-live="polite" aria-atomic="false">
          <For each={state.toasts}>
            {(t) => (
              <div class={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
                {t.text}
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
