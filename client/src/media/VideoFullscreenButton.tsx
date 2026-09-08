import { Show } from 'solid-js';
import { faExpand } from '@fortawesome/free-solid-svg-icons';
import type { MediaAsset } from '@tinytavern/shared';
import FontAwesomeIcon from '../components/FontAwesomeIcon.tsx';
import { toast } from '../state/store.ts';
import { errorMessage } from '../util.ts';

export default function VideoFullscreenButton(props: {
  asset: MediaAsset;
  player: () => HTMLVideoElement | undefined;
}) {
  const open = async () => {
    const player = props.player() as
      (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | undefined;
    if (!player?.isConnected) return;
    try {
      if (player.requestFullscreen) {
        await player.requestFullscreen();
      } else if (player.webkitEnterFullscreen) {
        player.webkitEnterFullscreen();
      } else {
        toast('Fullscreen video is unavailable in this browser.');
      }
    } catch (error) {
      toast(errorMessage(error));
    }
  };
  return (
    <button type="button" title="Fullscreen video" aria-label="Fullscreen video" onClick={open}>
      <FontAwesomeIcon icon={faExpand} size={14} />{' '}
      <Show when={props.asset.width && props.asset.height} fallback="Fullscreen">
        {props.asset.width} × {props.asset.height}
      </Show>
    </button>
  );
}
