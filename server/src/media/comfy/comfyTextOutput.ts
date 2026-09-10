import { InvalidMediaOutput } from '../mediaFiles.ts';

/** Text nodes (including PreviewAny) expose history.outputs[node].text. */
export function comfyTextOutput(outputs: Record<string, unknown>, nodeId?: string): string {
  const candidates =
    nodeId === undefined
      ? Object.values(outputs)
      : [Object.hasOwn(outputs, nodeId) ? outputs[nodeId] : null];
  const textOutputs = candidates.filter(
    (output): output is { text: unknown } =>
      output !== null && typeof output === 'object' && 'text' in output,
  );
  if (textOutputs.length !== 1) {
    throw new InvalidMediaOutput('The selected output node must return text');
  }
  const text = textOutputs[0]!.text;
  if (!Array.isArray(text) || text.length !== 1 || typeof text[0] !== 'string') {
    throw new InvalidMediaOutput('The text output must contain exactly one string');
  }
  const prompt = text[0];
  if (!prompt.trim() || prompt.length > 200_000) {
    throw new InvalidMediaOutput('Comfy returned an empty or oversized prompt');
  }
  return prompt;
}
