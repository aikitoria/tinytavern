import { Show } from 'solid-js';
import { faChevronDown, faChevronUp, faXmark } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from '../ui/FontAwesomeIcon.tsx';
import MobileSidebarButton from '../layout/MobileSidebarButton.tsx';
import {
  mapSearchQuery as query,
  setMapSearchQuery as setQuery,
  mapSearchResults,
  mapSearchTarget,
  navigateMapSearch,
} from './mapSearch.ts';

export default function MapSearch() {
  let input!: HTMLInputElement;
  const searching = () => query().trim().length > 0;
  const position = () => mapSearchResults().indexOf(mapSearchTarget()?.messageId ?? -1);
  const move = (direction: -1 | 1) => {
    navigateMapSearch(direction);
    input.focus({ preventScroll: true });
  };
  const clear = () => {
    setQuery('');
    input.focus({ preventScroll: true });
  };
  return (
    <div class="composer my-3 mx-auto p-1 flex relative bg-panel items-end border border-solid border-control-line gap-chat-gap max-w-composer [&_textarea]:shadow-clear [&_textarea]:flex-1 [&_textarea]:w-auto [&_textarea]:min-w-0 [&_textarea]:max-h-50 [&_textarea]:resize-none [&_textarea]:overflow-y-hidden [&_textarea]:bg-clear [&_textarea]:border-clear [&_textarea]:leading-6 [&_input[type=search]]:shadow-clear [&_input[type=search]]:flex-1 [&_input[type=search]]:w-auto [&_input[type=search]]:min-w-0 [&_input[type=search]]:max-h-50 [&_input[type=search]]:resize-none [&_input[type=search]]:overflow-y-hidden [&_input[type=search]]:bg-clear [&_input[type=search]]:border-clear [&_input[type=search]]:leading-6 [&_textarea:focus]:outline-clear [&_input[type=search]:focus]:outline-clear [&_input::-webkit-search-cancel-button]:display-none small-touch:w-auto small-touch:max-w-none small-touch:shrink-0 small-touch:m-0 small-touch:bg-panel small-touch:border-clear small-touch:rounded-none small-touch:[&_textarea]:bg-raised small-touch:[&_input[type=search]]:bg-raised w-[calc(100%_-_var(--space-6)_-_var(--space-6))] rounded-[calc(var(--composer-button-size)_/_2_+_var(--composer-shell-inset))] [&_textarea]:rounded-[calc(var(--composer-button-size)_/_2)] [&_input[type=search]]:rounded-[calc(var(--composer-button-size)_/_2)] small-touch:p-[4px_calc(4px_+_env(safe-area-inset-right))_calc(4px_+_env(safe-area-inset-bottom))_calc(4px_+_env(safe-area-inset-left))]">
      <MobileSidebarButton />
      <input
        ref={input}
        type="search"
        placeholder="Search messages…"
        aria-label="Search messages"
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.isComposing) return;
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            clear();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            move(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <Show when={searching()}>
        <div class="pr-1 flex items-center gap-1 h-composer-button [&_.icon-btn]:min-w-7 [&_.icon-btn]:size-7">
          <span
            class="whitespace-nowrap tabular-nums text-dim text-caption"
            role="status"
            title="Matching messages"
            aria-label={
              position() < 0
                ? `${mapSearchResults().length} matching messages`
                : `${position() + 1} of ${mapSearchResults().length} matching messages`
            }
          >
            {position() >= 0
              ? `${position() + 1} / ${mapSearchResults().length}`
              : mapSearchResults().length
                ? `${mapSearchResults().length} ${mapSearchResults().length === 1 ? 'match' : 'matches'}`
                : 'No matches'}
          </span>
          <button
            type="button"
            class="icon-btn"
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
            disabled={mapSearchResults().length === 0}
            onClick={() => move(-1)}
          >
            <FontAwesomeIcon icon={faChevronUp} size={12} />
          </button>
          <button
            type="button"
            class="icon-btn"
            title="Next match (Enter)"
            aria-label="Next match"
            disabled={mapSearchResults().length === 0}
            onClick={() => move(1)}
          >
            <FontAwesomeIcon icon={faChevronDown} size={12} />
          </button>
          <button
            type="button"
            class="icon-btn"
            title="Clear search (Escape)"
            aria-label="Clear search"
            onClick={clear}
          >
            <FontAwesomeIcon icon={faXmark} size={14} />
          </button>
        </div>
      </Show>
    </div>
  );
}
