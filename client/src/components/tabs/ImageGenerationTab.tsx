import { ImageGenerationSettingsPage } from '../../images/imageGeneration.tsx';

export function ChatImagePromptsTab() {
  return (
    <div class="form">
      <ImageGenerationSettingsPage mode="chat" />
    </div>
  );
}

export function AvatarPromptsTab() {
  return (
    <div class="form">
      <ImageGenerationSettingsPage mode="avatar" />
    </div>
  );
}
