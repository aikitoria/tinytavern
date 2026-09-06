import type { Message } from '@tinytavern/shared';
import type { Plugin, PluginCommand, PluginMessageView, PluginTool } from './api.ts';
import { imageGenerationPlugin } from './imageGeneration.tsx';

export const PLUGINS: Plugin[] = [imageGenerationPlugin];

/** Resolve on render so plugins can expose settings-backed tool variants. */
export function pluginTools(): PluginTool[] {
  return PLUGINS.flatMap((plugin) =>
    typeof plugin.tools === 'function' ? plugin.tools() : (plugin.tools ?? []),
  );
}
export const pluginCommands: PluginCommand[] = PLUGINS.flatMap((plugin) => plugin.commands ?? []);

export function findMessageView(message: Message): PluginMessageView | undefined {
  return PLUGINS.find((plugin) => plugin.messageView?.claims(message))?.messageView;
}
