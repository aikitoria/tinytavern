import { For, Show, createMemo, onCleanup, onMount } from 'solid-js';
import type { MediaJob } from '@tinytavern/shared';
import { state } from '../state/store.ts';
import MediaJobCard from './MediaJobCard.tsx';
import type { MediaJobGroup } from './jobCards.ts';

export default function MediaJobList(props: {
  groups: MediaJobGroup[];
  active?: boolean;
  busy: boolean;
  more: boolean;
  loading: boolean;
  onOpen: (job: MediaJob) => void;
  onRemove: (job: MediaJob) => void;
  onLoadMore: () => void;
}) {
  const groups = createMemo(() => new Map(props.groups.map((group) => [group.id, group])));
  const characters = createMemo(
    () => new Map(state.characters.map((character) => [character.id, character])),
  );
  const conversations = createMemo(
    () => new Map(state.conversations.map((conversation) => [conversation.id, conversation])),
  );
  const elements = new Map<Element, (visible: boolean) => void>();
  let root!: HTMLDivElement;
  let observer: IntersectionObserver | undefined;
  onMount(() => {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) elements.get(entry.target)?.(entry.isIntersecting);
      },
      { root },
    );
    for (const element of elements.keys()) observer.observe(element);
  });
  onCleanup(() => observer?.disconnect());
  const observe = (element: Element, visible: (value: boolean) => void) => {
    elements.set(element, visible);
    observer?.observe(element);
    return () => {
      observer?.unobserve(element);
      elements.delete(element);
    };
  };
  return (
    <div class="media-job-list" ref={root}>
      <Show
        when={props.groups.length}
        fallback={<p class="hint">{props.loading ? 'Loading jobs…' : 'No media jobs yet.'}</p>}
      >
        <For each={[...groups().keys()]}>
          {(id) => (
            <MediaJobCard
              group={groups().get(id)!}
              characters={characters()}
              conversations={conversations()}
              disabled={props.busy}
              active={props.active}
              observe={observe}
              onOpen={props.onOpen}
              onRemove={props.onRemove}
            />
          )}
        </For>
      </Show>
      <Show when={props.more}>
        <button class="media-job-load-more" disabled={props.loading} onClick={props.onLoadMore}>
          {props.loading ? 'Loading…' : 'Load more'}
        </button>
      </Show>
    </div>
  );
}
