import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import type { MediaAsset } from '@tinytavern/shared';
import { download } from '../util.ts';

export default function MediaPlayer(props: {
  asset: MediaAsset;
  class?: string;
  active?: boolean;
  autoPlay?: boolean;
  loop?: boolean;
  controls?: boolean;
  muted?: boolean;
  ref?: (player: HTMLVideoElement | undefined) => void;
}) {
  let player: HTMLVideoElement | undefined;
  const [failed, setFailed] = createSignal(false);
  const [naturalRatio, setNaturalRatio] = createSignal(1);
  const ratio = () =>
    props.asset.width && props.asset.height ? props.asset.width / props.asset.height : naturalRatio();
  createEffect(() => {
    const url = props.asset.url;
    const active = props.active !== false;
    setFailed(false);
    setNaturalRatio(1);
    if (player) {
      player.pause();
      if (active) {
        player.src = url;
      } else {
        player.removeAttribute('src');
      }
      player.load();
      if (active && props.autoPlay) {
        player.muted = props.muted ?? false;
        void player.play().catch(() => {
          // Keep the native play control available if the browser blocks autoplay.
        });
      }
    }
  });
  onCleanup(() => {
    props.ref?.(undefined);
    if (player) {
      player.pause();
      player.removeAttribute('src');
      player.load();
    }
  });
  return (
    <Show
      when={!failed()}
      fallback={
        <div class="notice notice-info">
          <p>This video cannot be played here.</p>
          <button onClick={() => download(props.asset.url)}>Download video</button>
        </div>
      }
    >
      <div
        class={`relative aspect-video-media [&>video]:absolute [&>video]:inset-0 [&>video]:block [&>video]:object-contain [&>video]:size-full [&.media-result]:h-auto [&.media-result]:aspect-video-media [&.media-result]:w-[min(100%,_calc(100cqh_*_var(--media-video-ratio)))] ${props.class ?? ''}`}
        style={{ '--media-video-ratio': ratio() }}
      >
        <video
          ref={(element) => {
            player = element;
            props.ref?.(element);
          }}
          width={props.asset.width ?? undefined}
          height={props.asset.height ?? undefined}
          src={props.active === false ? undefined : props.asset.url}
          controls={props.controls !== false}
          muted={props.muted}
          autoplay={props.autoPlay && props.active !== false}
          loop={props.loop}
          playsinline
          preload="auto"
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            if (video.videoWidth && video.videoHeight) {
              setNaturalRatio(video.videoWidth / video.videoHeight);
            }
          }}
          onError={() => setFailed(true)}
        />
      </div>
    </Show>
  );
}
