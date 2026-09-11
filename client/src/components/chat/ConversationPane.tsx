import { Show, createEffect, createSignal } from 'solid-js';
import { ConversationContext, type ConversationView } from './ConversationContext.tsx';
import ChatView from './ChatView.tsx';
import Composer from './Composer.tsx';
import MessageSelectionBar from './MessageSelectionBar.tsx';
import MapSearch from '../tree/MapSearch.tsx';

/** A complete conversation view, hosted without changing application navigation. */
export default function ConversationPane(props: ConversationView & { showViewControls?: boolean }) {
  const [text, setText] = createSignal('');
  createEffect(() => {
    if (props.session.messageSelection() && !props.session.selectedMessageRange())
      props.session.clearMessageSelection();
  });
  return (
    <ConversationContext.Provider value={props}>
      <div class="conversation-pane flex flex-col min-h-0 min-w-0 flex-1">
        <Show when={props.showViewControls !== false}>
          <div
            class="conversation-view-controls flex flex-none items-center gap-2 p-2"
            role="group"
            aria-label="Conversation view"
          >
            <button
              classList={{ 'icon-btn-active': props.session.state.viewMode === 'chat' }}
              aria-pressed={props.session.state.viewMode === 'chat'}
              onClick={() => props.session.setState('viewMode', 'chat')}
            >
              Messages
            </button>
            <button
              classList={{ 'icon-btn-active': props.session.state.viewMode === 'map' }}
              aria-pressed={props.session.state.viewMode === 'map'}
              onClick={() => props.session.setState('viewMode', 'map')}
            >
              Tree
            </button>
            <button
              classList={{ 'icon-btn-active': props.session.state.viewMode === 'trace' }}
              aria-pressed={props.session.state.viewMode === 'trace'}
              onClick={() => props.session.setState('viewMode', 'trace')}
            >
              Trace
            </button>
          </div>
        </Show>
        <ChatView active={props.active()} pendingMessage={text()} />
        <Show
          when={props.session.state.viewMode === 'map'}
          fallback={
            <Show
              when={props.session.messageSelectionActive()}
              fallback={<Composer text={text()} onText={setText} />}
            >
              <MessageSelectionBar />
            </Show>
          }
        >
          <MapSearch />
        </Show>
      </div>
    </ConversationContext.Provider>
  );
}
