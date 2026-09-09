import { ImageGenerationSettingsPage } from '../../images/imageGeneration.tsx';

export function ChatImagePromptsTab() {
  return (
    <div class="form [&_label]:text-label [&_label]:text-foreground [&_label]:mt-2">
      <ImageGenerationSettingsPage mode="chat" />
    </div>
  );
}

export function AvatarPromptsTab() {
  return (
    <div class="form [&_label]:text-label [&_label]:text-foreground [&_label]:mt-2">
      <ImageGenerationSettingsPage mode="avatar" />
    </div>
  );
}
