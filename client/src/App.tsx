import { For, Show, createEffect, createSignal } from 'solid-js';
import { booting, state, setState } from './state/store.ts';
import Sidebar from './components/Sidebar.tsx';
import Header from './components/Header.tsx';
import ChatView from './components/ChatView.tsx';
import Composer from './components/Composer.tsx';
import { TreeSearch } from './components/TreeView.tsx';
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

export default function App() {
  // Boot is one-way: once booting() clears, fade the cover out and unmount it
  // after the transition instead of popping it away.
  const [bootGone, setBootGone] = createSignal(false);
  createEffect(() => {
    if (!booting()) setTimeout(() => setBootGone(true), 350);
  });
  createEffect(() => {
    if (messageSelection() && !selectedMessageRange()) clearMessageSelection();
  });
  return (
    <Show when={authPhase() !== 'locked'} fallback={<PasswordGate />}>
      <div class="app" classList={{ 'sidebar-open': state.sidebarOpen }}>
        <Show when={!bootGone()}>
          <div class="boot-screen" classList={{ 'boot-done': !booting() }}>
            <img src="/icon.svg" alt="" width="72" height="72" />
            <span class="boot-name">MiniTavern</span>
            <span class="boot-dots">
              <i />
              <i />
              <i />
            </span>
          </div>
        </Show>
        <Sidebar />
        <Show when={state.sidebarOpen}>
          <div class="backdrop" onClick={() => setState('sidebarOpen', false)} />
        </Show>
        <main class="main">
          <Header />
          <ChatView />
          <Show
            when={state.viewMode === 'tree'}
            fallback={
              <Show when={messageSelectionActive()} fallback={<Composer />}>
                <MessageSelectionBar />
              </Show>
            }
          >
            <TreeSearch />
          </Show>
        </main>
        <Show when={state.modal === 'settings'}>
          <SettingsModal />
        </Show>
        <Show when={state.modal === 'conversation'}>
          <ConversationSettings />
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
