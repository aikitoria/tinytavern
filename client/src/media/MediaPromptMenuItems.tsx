import { For } from 'solid-js';
import { openMediaTool } from './navigation.ts';

const ACTIONS = [
  { operation: 'image', label: 'Use as image prompt' },
  { operation: 'video', label: 'Use as video prompt' },
] as const;

/** Shared by message and code-block menus; text goes straight into the final prompt. */
export default function MediaPromptMenuItems(props: {
  text: string;
  conversationId?: number;
  onClose: () => void;
}) {
  return (
    <For each={ACTIONS}>
      {(action) => (
        <button
          type="button"
          role="menuitem"
          disabled={!props.text.trim()}
          onClick={() => {
            const prompt = props.text;
            props.onClose();
            openMediaTool(action.operation, { conversationId: props.conversationId, prompt });
          }}
        >
          {action.label}
        </button>
      )}
    </For>
  );
}
