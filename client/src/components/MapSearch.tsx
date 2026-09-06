import { Show } from 'solid-js';
import { faChevronDown, faChevronUp, faXmark } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';
import MobileSidebarButton from './MobileSidebarButton.tsx';
import {
  mapSearchQuery as query,
  setMapSearchQuery as setQuery,
  mapSearchResults,
  mapSearchTarget,
  navigateMapSearch,
} from './mapSearch.ts';
import '../styles/treemap.css';

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
    <div class="composer map-search">
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
        <div class="map-search-controls">
          <span
            class="map-search-status"
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
