import { Show, createSignal } from 'solid-js';
import { faWandMagicSparkles } from '@fortawesome/free-solid-svg-icons';
import type { MediaAsset, MediaJobInput, MediaOperation } from '@tinytavern/shared';
import DropdownSurface from '../components/ui/DropdownSurface.tsx';
import FontAwesomeIcon from '../components/ui/FontAwesomeIcon.tsx';
import { openMediaTool } from './navigation.ts';

export default function MediaActions(props: {
  asset: MediaAsset;
  conversationId?: number | null;
  compact?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  let button!: HTMLButtonElement;
  const launch = (operation: MediaOperation, slot: MediaJobInput['slot']) => {
    if (props.disabled) return;
    setOpen(false);
    openMediaTool(operation, {
      conversationId: props.conversationId,
      input: { asset: props.asset, slot },
    });
  };
  return (
    <Show when={props.asset.kind === 'image'}>
      <button
        ref={button}
        type="button"
        classList={{ 'icon-btn': props.compact }}
        aria-label="Image tools"
        title="Image tools"
        aria-haspopup="menu"
        aria-expanded={open()}
        disabled={props.disabled}
        onClick={() => setOpen(!open())}
      >
        <FontAwesomeIcon icon={faWandMagicSparkles} size={14} />
        <Show when={!props.compact}> Image tools</Show>
      </button>
      <DropdownSurface
        open={open()}
        anchor={() => button}
        onClose={() => setOpen(false)}
        role="menu"
        ariaLabel="Image tools"
        fitContentWidth
        minWidth={240}
        keyboardNavigation
        autoFocus
      >
        <button role="menuitem" onClick={() => launch('image-edit', 'reference1')}>
          Edit image
        </button>
        <button role="menuitem" onClick={() => launch('video-first', 'first_frame')}>
          Create video
        </button>
        <button role="menuitem" onClick={() => launch('video-references', 'reference1')}>
          Reference for a video
        </button>
      </DropdownSurface>
    </Show>
  );
}
