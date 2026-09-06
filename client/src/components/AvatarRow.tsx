import { Show } from 'solid-js';
import { errorMessage } from '../util.ts';
import Avatar from './Avatar.tsx';

export default function AvatarRow(props: {
  src: string | null | undefined;
  name: string;
  upload: (file: File) => Promise<unknown>;
  remove: () => Promise<unknown>;
  generate?: () => void;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  let input!: HTMLInputElement;
  const uploadFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      await props.upload(file);
      props.onDone();
    } catch (err) {
      props.onError(errorMessage(err));
    }
  };
  const remove = async () => {
    try {
      await props.remove();
      props.onDone();
    } catch (err) {
      props.onError(errorMessage(err));
    }
  };
  return (
    <div class="avatar-row">
      <Avatar src={props.src} name={props.name} />
      <button onClick={() => input.click()}>Change avatar</button>
      <Show when={props.src}>
        <button onClick={() => void remove()}>Remove</button>
      </Show>
      <Show when={props.generate}>
        <button onClick={() => props.generate?.()}>Generate</button>
      </Show>
      <input
        ref={input}
        type="file"
        accept="image/png"
        hidden
        onChange={(e) => void uploadFile(e.currentTarget.files?.[0])}
      />
    </div>
  );
}
