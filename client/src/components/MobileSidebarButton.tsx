import { Show } from 'solid-js';
import { isMobileLayout, toggleSidebar } from '../state/store.ts';

export default function MobileSidebarButton() {
  return (
    <Show when={isMobileLayout()}>
      <button
        class="send-btn tools-btn mobile-sidebar-btn"
        title="Conversations"
        aria-label="Open conversations"
        onClick={toggleSidebar}
      >
        ☰
      </button>
    </Show>
  );
}
