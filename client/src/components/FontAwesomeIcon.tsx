import { For } from 'solid-js';
import type { IconDefinition } from '@fortawesome/free-solid-svg-icons';

/** Render packaged icon data directly; no Font Awesome runtime or external requests. */
export default function FontAwesomeIcon(props: {
  icon: IconDefinition;
  size?: number;
  class?: string;
}) {
  const paths = () => {
    const path = props.icon.icon[4];
    return typeof path === 'string' ? [path] : path;
  };

  return (
    <svg
      class={`fa-icon ${props.class ?? ''}`}
      viewBox={`0 0 ${props.icon.icon[0]} ${props.icon.icon[1]}`}
      width={props.size ?? 18}
      height={props.size ?? 18}
      fill="currentColor"
      aria-hidden="true"
    >
      <For each={paths()}>{(path) => <path d={path} />}</For>
    </svg>
  );
}
