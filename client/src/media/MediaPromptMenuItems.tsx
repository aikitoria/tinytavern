import { openMediaTool } from './navigation.ts';

/** Text goes straight into the final prompt, independent of the workflow's asset types. */
export default function MediaPromptMenuItems(props: {
  text: string;
  conversationId?: number;
  onClose: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={!props.text.trim()}
      onClick={() => {
        const prompt = props.text;
        props.onClose();
        openMediaTool(null, { conversationId: props.conversationId, prompt });
      }}
    >
      Use as media prompt
    </button>
  );
}
