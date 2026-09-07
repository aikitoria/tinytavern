import { For, createEffect, createSignal, onCleanup, type JSX } from 'solid-js';

interface ImageLayer {
  id: number;
  src: string;
  fade: boolean;
}

/**
 * Retain the previous image during fades; changing img.src replaces pixels
 * immediately, so an opacity transition on one element would still snap.
 */
export default function CrossfadeImage(props: {
  src: string;
  alt: string;
  class?: string;
  classList?: Record<string, boolean | undefined>;
  wrapperClass?: string;
  onClick?: JSX.EventHandlerUnion<HTMLImageElement, MouseEvent>;
}) {
  const [layers, setLayers] = createSignal<ImageLayer[]>([]);
  let nextId = 0;
  const animations = new Map<number, Animation>();

  createEffect(() => {
    const src = props.src;
    const current = layers().at(-1);
    if (current?.src === src) return;

    const layer = { id: ++nextId, src, fade: current != null };
    // Keep one underlay to bound retained preview data URLs.
    setLayers((existing) => [...existing.slice(-1), layer]);
  });

  const reveal = (layer: ImageLayer, image: HTMLImageElement) => {
    // A superseded preview may finish decoding after its replacement.
    if (layer.id !== currentId()) return;
    if (!layer.fade) {
      image.style.opacity = '1';
      return;
    }

    const animation = image.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 300,
      easing: 'ease-out',
      fill: 'forwards',
    });
    animations.set(layer.id, animation);
    void animation.finished
      .then(() => {
        image.style.opacity = '1';
        animation.cancel();
        animations.delete(layer.id);
        if (layer.id === currentId()) {
          setLayers((existing) => existing.filter((item) => item.id >= layer.id));
        }
      })
      .catch(() => {
        animations.delete(layer.id);
      });
  };

  onCleanup(() => {
    for (const animation of animations.values()) animation.cancel();
    animations.clear();
  });

  const currentId = () => layers().at(-1)?.id;

  return (
    <span class={`image-crossfade ${props.wrapperClass ?? ''}`}>
      <For each={layers()}>
        {(layer) => {
          const current = () => layer.id === currentId();
          return (
            <img
              src={layer.src}
              alt={current() ? props.alt : ''}
              aria-hidden={!current()}
              class={props.class}
              // Grid order stacks frames; increasing z-index would eventually cover controls.
              style={{ opacity: layer.fade ? 0 : 1 }}
              classList={{
                ...(props.classList ?? {}),
                'image-crossfade-underlay': !current(),
              }}
              onClick={current() ? props.onClick : undefined}
              onLoad={(event) => reveal(layer, event.currentTarget)}
            />
          );
        }}
      </For>
    </span>
  );
}
