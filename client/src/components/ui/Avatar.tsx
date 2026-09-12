import { Show } from 'solid-js';

export default function Avatar(props: { src: string | null | undefined; name: string }) {
  return (
    <Show
      when={props.src}
      fallback={<span class="avatar avatar-fallback">{props.name.slice(0, 1).toUpperCase() || '?'}</span>}
    >
      <img class="avatar" src={props.src!} alt={props.name} loading="lazy" />
    </Show>
  );
}
