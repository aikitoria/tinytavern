import { createContext } from 'solid-js';
import type { SettingsFieldSchema } from '@tinytavern/shared';

export interface SettingsDraft {
  schema: SettingsFieldSchema;
  read: () => Record<string, unknown>;
  /** Changes even when leaving and reopening the same entity or new draft. */
  identity?: () => unknown;
  exportRead?: (fields: readonly string[]) => Record<string, unknown> | Promise<Record<string, unknown>>;
  write: (value: Record<string, unknown>) => void;
  onError: (message: string) => void;
}
export const SettingsDraftContext = createContext<SettingsDraft>();
