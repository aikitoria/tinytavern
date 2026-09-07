/** Slash commands exposed by the composer. */
export interface ComposerCommand {
  name: string;
  params: string;
  description: string;
  /** Allows independent work while chat generation streams. */
  allowDuringGeneration?: boolean;
  /** Return false to retain the composer's text after a failed request. */
  run: (args: string) => Promise<boolean | void>;
}
