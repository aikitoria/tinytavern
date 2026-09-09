import { InvalidMediaOutput } from '../mediaFiles.ts';

/** PreviewAny exposes its string in history.outputs[node].text. */
export function comfyTextOutput(outputs: Record<string, unknown>): string {
  const textOutputs = Object.values(outputs).filter(
    (output): output is { text: unknown } =>
      output !== null && typeof output === 'object' && 'text' in output,
  );
  if (textOutputs.length !== 1) {
    throw new InvalidMediaOutput(
      'The workflow must return text from exactly one Preview as Text node',
    );
  }
  const text = textOutputs[0]!.text;
  if (!Array.isArray(text) || text.length !== 1 || typeof text[0] !== 'string') {
    throw new InvalidMediaOutput('Preview as Text must return one prompt');
  }
  const prompt = text[0];
  if (!prompt.trim() || prompt.length > 200_000) {
    throw new InvalidMediaOutput('Comfy returned an empty or oversized prompt');
  }
  return prompt;
}
