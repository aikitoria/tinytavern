import type { Component, JSX } from 'solid-js';
import type { Message } from '@minitavern/shared';
import { state } from '../state/store.ts';

/** A button in the composer's tools menu. */
export interface PluginTool {
  label: string;
  icon: () => JSX.Element;
  run: () => void;
}

/** Composer slash command, using the built-in command contract. */
export interface PluginCommand {
  name: string;
  params: string;
  description: string;
  /** Allows independent work while chat generation streams. */
  allowDuringGeneration?: boolean;
  /** Return false to keep the composer text (e.g. validation failed upstream). */
  run: (args: string) => Promise<boolean | void>;
}

/**
 * `create` runs once per mounted tool message with reactive accessors;
 * returned renderers share per-message state through closures.
 */
export interface PluginMessageView {
  /** Whether this plugin owns the given tool message (key off its data). */
  claims: (message: Message) => boolean;
  /** Current render configuration to use for a manual regeneration. */
  currentImageConfig?: () => { workflow: string; comfyUrl: string } | undefined;
  /** Optional Left/Right action when this is the last message above the composer. */
  swipe?: (message: Message, dir: 1 | -1) => void;
  /** Deletes alternatives stored within one message. */
  canDeleteSwipe?: (message: Message) => boolean;
  deleteSwipe?: (message: Message) => Promise<unknown>;
  create: (
    message: () => Message,
    ctx: { streaming: () => boolean },
  ) => {
    /** Rendered among the chips in the message header. */
    Header?: () => JSX.Element;
    /** Visual identity in the message rail; defaults to the generic tool gear. */
    RailIcon?: () => JSX.Element;
    /** Rendered in the right-aligned group with swipe and action controls. */
    HeaderTools?: () => JSX.Element;
    /** The plugin supplies its own identity instead of the message-name label. */
    hideName?: boolean;
    /** Switch the message to a media-first card once visual output exists. */
    fullBleed?: () => boolean;
    Body: () => JSX.Element;
  };
}

/**
 * Settings persist in Settings.pluginSettings[id], guarded by its revision
 * and synced across devices through settings invalidation.
 */
export interface Plugin {
  /** Key into settings.pluginSettings; never rename once shipped. */
  id: string;
  /** Name shown in the Tools settings list. */
  name: string;
  /** Static tools, or a reactive factory when settings determine the menu. */
  tools?: PluginTool[] | (() => PluginTool[]);
  commands?: PluginCommand[];
  settingsPage?: Component;
  messageView?: PluginMessageView;
}

/** Current settings for a plugin, with defaults filled in (reactive). */
export function pluginSettings<T extends Record<string, unknown>>(id: string, defaults: T): T {
  return { ...defaults, ...(state.settings.pluginSettings[id] as Partial<T> | undefined) };
}
