import { pageRevision } from './state/pageLocation.ts';
import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { installMouseBack, registerUiBack } from './state/uiBack.ts';
import { booting, state, setState, streamingMessage } from './state/store.ts';
import Sidebar from './components/Sidebar.tsx';
import Header from './components/Header.tsx';
import ChatView from './components/ChatView.tsx';
import Composer from './components/Composer.tsx';
import MapSearch from './components/MapSearch.tsx';
import SettingsModal from './components/SettingsModal.tsx';
import ConversationSettings from './components/ConversationSettings.tsx';
import PasswordGate from './components/PasswordGate.tsx';
import ConfirmDialogHost from './components/ConfirmDialogHost.tsx';
import { authPhase } from './state/auth.ts';
import {
  clearMessageSelection,
  messageSelection,
  messageSelectionActive,
  selectedMessageRange,
} from './state/messageSelection.ts';
import MessageSelectionBar from './components/MessageSelectionBar.tsx';
import GalleryModal from './components/GalleryModal.tsx';
import MediaToolsModal from './media/MediaToolsModal.tsx';
import { mediaToolSession } from './media/navigation.ts';

export default function App() {
  onMount(() => onCleanup(installMouseBack()));
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
      <div class="app" classList={{ 'sidebar-open': state.sidebarOpen }}>
        <Show when={!bootGone()}>
          <div class="boot-screen" classList={{ 'boot-done': !booting() }}>
            <img src="/icon.svg" alt="" width="72" height="72" />
            <span class="boot-name">TinyTavern</span>
            <span class="boot-dots">
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
            class="backdrop"
            onClick={() => setState('sidebarOpen', false)}
          />
        </Show>
        <main class="main">
          <Header />
          <ChatView />
          <Show
            when={state.viewMode === 'map'}
            fallback={
              <Show when={messageSelectionActive()} fallback={<Composer />}>
                <MessageSelectionBar />
              </Show>
            }
          >
            <MapSearch />
          </Show>
        </main>
        <Show when={state.modal === 'settings' && pageRevision()} keyed>
          <SettingsModal />
        </Show>
        <Show when={state.modal === 'conversation' && pageRevision()} keyed>
          <ConversationSettings />
        </Show>
        <Show
          when={
            (state.modal === 'gallery' ||
              (state.modal === 'media-tools' && mediaToolSession()?.returnModal === 'gallery')) &&
            pageRevision()
          }
          keyed
        >
          <GalleryModal active={state.modal === 'gallery'} />
        </Show>
        <Show when={state.modal === 'media-tools' && mediaToolSession()} keyed>
          {(session) => <MediaToolsModal session={session} />}
        </Show>
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
