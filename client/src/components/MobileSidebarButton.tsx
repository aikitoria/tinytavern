import { faBars } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
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
        <FontAwesomeIcon icon={faBars} />
      </button>
    </Show>
  );
}
