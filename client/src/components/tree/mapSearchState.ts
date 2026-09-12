import { createSignal } from 'solid-js';
import { characterChatName, type Message } from '@tinytavern/shared';
import type { ConversationSession } from '../../state/conversationSession.ts';

export function createMapSearch({
  personasEnabled,
  selectedCharacter,
  selectedPersona,
}: Pick<ConversationSession, 'personasEnabled' | 'selectedCharacter' | 'selectedPersona'>) {
  function speakerName(message: Message): string {
    if (message.role === 'user') {
      return (personasEnabled() ? selectedPersona() : null)?.name ?? 'You';
    }
    if (message.role === 'tool') return message.name ?? 'Tool';
    if (message.role === 'system') return message.name ?? 'System';
    return message.name ?? characterChatName(selectedCharacter());
  }

  /** Keep the map search query while switching between conversation views. */
  const [mapSearchQuery, setMapSearchQuery] = createSignal('');

  function matchesMapSearch(message: Message, query: string): boolean {
    return `${speakerName(message)}\n${message.content}`.toLowerCase().includes(query);
  }

  /** The mounted map publishes matching messages in tree order for search navigation. */
  const [mapSearchResults, setMapSearchResults] = createSignal<readonly number[]>([]);
  const [mapSearchTarget, setMapSearchTarget] = createSignal<{ messageId: number } | null>(null);

  function navigateMapSearch(direction: -1 | 1): void {
    const results = mapSearchResults();
    if (!results.length) return;
    const current = results.indexOf(mapSearchTarget()?.messageId ?? -1);
    const next =
      current < 0 ? (direction > 0 ? 0 : results.length - 1) : (current + direction + results.length) % results.length;
    setMapSearchTarget({ messageId: results[next]! });
  }

  return {
    mapSearchQuery,
    setMapSearchQuery,
    matchesMapSearch,
    mapSearchResults,
    setMapSearchResults,
    mapSearchTarget,
    setMapSearchTarget,
    navigateMapSearch,
  };
}
export function snippet(message: Message, query: string): string {
  const text = message.content.replace(/\s+/g, ' ').trim();
  if (text) {
    const match = query.trim() ? text.toLowerCase().indexOf(query.trim().toLowerCase()) : -1;
    const start = Math.max(0, match - 60);
    return `${start ? '…' : ''}${text.slice(start, start + 500)}`;
  }
  if (message.media.length > 0 || message.imagePending) return '[image]';
  return '(empty)';
}
