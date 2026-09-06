import type { Message } from '@tinytavern/shared';
import { personasEnabled, selectedCharacter, selectedPersona } from '../state/store.ts';

export function speakerName(message: Message): string {
  if (message.role === 'user') {
    return (personasEnabled() ? selectedPersona() : null)?.name ?? 'You';
  }
  if (message.role === 'tool') return message.name ?? 'Tool';
  if (message.role === 'system') return message.name ?? 'System';
  return message.name ?? selectedCharacter()?.name ?? 'Assistant';
}

export function snippet(message: Message): string {
  const text = message.content.replace(/\s+/g, ' ').trim();
  if (text) return text.length > 500 ? text.slice(0, 500) : text;
  if (message.images.length > 0 || message.imagePending) return '[image]';
  return '(empty)';
}
