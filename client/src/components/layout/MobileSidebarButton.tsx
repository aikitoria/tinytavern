import { faBars } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';
import { Show } from 'solid-js';
import { isMobileLayout, toggleSidebar } from '../../state/store.ts';

export default function MobileSidebarButton() {
  return (
    <Show when={isMobileLayout()}>
      <button
        class="send-btn rounded-circle flex items-center justify-center p-0 shrink-0 tools-btn text-xl small-touch:text-base"
        title="Conversations"
        aria-label="Open conversations"
        onClick={toggleSidebar}
      >
        <FontAwesomeIcon icon={faBars} />
      </button>
    </Show>
  );
}
