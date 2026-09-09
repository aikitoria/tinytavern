export const DEFAULT_STEER_TEMPLATE =
  '[System Note]\n[Revision request: modify only this aspect of the immediately preceding assistant response: {{instruction}}. Preserve all other content and details. Do not modify anything else. Return only the revised response.]';

export const DEFAULT_SPEAKER_HANDOFF_TEMPLATE = '[System Note]\n<Note: Reply as {{speaker}}>';

export const DEFAULT_CUSTOM_TEMPLATE = {
  /** Template for the system message. */
  content: '',
  /** Fake first user message; empty = omitted. */
  userPrologue: '',
  /** Seeds the final assistant turn's reasoning; empty = no prefill. */
  reasoningPrefill: '',
  /** Seeds the final assistant turn's visible content; empty = no prefill. */
  messagePrefill: '',
  /** Prefix speaker names into message contents ("User: …", "Char: …") and prefill "Char:" for the reply. */
  prefixNames: false,
  /** When false, chats using this template ignore personas entirely ({{user}} = "User"). */
  usesPersonas: true,
  /** Expands {{instruction}} for this regeneration only. */
  steerTemplate: DEFAULT_STEER_TEMPLATE,
  /** Speaker handoff when prefills are disabled; empty = no note. */
  speakerHandoffTemplate: DEFAULT_SPEAKER_HANDOFF_TEMPLATE,
};
export type CustomTemplate = typeof DEFAULT_CUSTOM_TEMPLATE;
