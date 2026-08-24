import type { Component, JSX } from 'solid-js';
import type { Message } from '@minitavern/shared';
import { api } from '../state/api.ts';
import { applySettings, state } from '../state/store.ts';

/** A button in the composer's tools menu. */
export interface PluginTool {
  label: string;
  icon: () => JSX.Element;
  run: () => void;
}

/** A composer slash command (same contract as the built-ins). */
export interface PluginCommand {
  name: string;
  params: string;
  description: string;
  /** The command starts independent work and remains available while a chat
   * generation is streaming (for example, parallel image prompts). */
  allowDuringGeneration?: boolean;
  /** Return false to keep the composer text (e.g. validation failed upstream). */
  run: (args: string) => Promise<boolean | void>;
}

/**
 * Custom rendering for tool messages a plugin owns. `create` is called once
 * per mounted message node with reactive accessors, so Header and Body can
 * share per-message state (expanders, viewers) through closures.
 */
export interface PluginMessageView {
  /** Whether this plugin owns the given tool message (key off its data). */
  claims: (message: Message) => boolean;
  /** Current render configuration to use for a manual regeneration. */
  currentImageConfig?: () => { workflow: string; comfyUrl: string } | undefined;
  /** Optional Left/Right action when this is the last message above the composer. */
  swipe?: (message: Message, dir: 1 | -1) => void;
  /** Optional plugin-owned swipe deletion (for alternatives stored inside one
   * message rather than as sibling message rows). */
  canDeleteSwipe?: (message: Message) => boolean;
  deleteSwipe?: (message: Message) => Promise<unknown>;
  create: (
    message: () => Message,
    ctx: { streaming: () => boolean },
  ) => {
    /** Rendered among the chips in the message header. */
    Header?: () => JSX.Element;
    /** Rendered in the right-aligned group with swipe and action controls. */
    HeaderTools?: () => JSX.Element;
    /** Suppress the normal message-name label (the plugin supplies its own visual identity). */
    hideName?: boolean;
    /** Switch the message to a media-first card once visual output exists. */
    fullBleed?: () => boolean;
    /** Replaces the default content rendering of the message body. */
    Body: () => JSX.Element;
  };
}

/**
 * A client-side plugin: contributes any combination of tools-menu buttons,
 * slash commands, a page in the Tools settings tab, and custom rendering for
 * its tool messages. Settings persist in the global Settings under
 * pluginSettings[id] (revision-guarded like the rest, synced across devices
 * via the settings invalidate).
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

/** Persists one plugin's settings blob under the global revision guard. */
export async function savePluginSettings(
  id: string,
  values: Record<string, unknown>,
): Promise<void> {
  const next = await api.putSettings(
    { pluginSettings: { ...state.settings.pluginSettings, [id]: values } },
    state.settings.revision,
  );
  applySettings(next);
}
