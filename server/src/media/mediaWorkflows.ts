import { getSettings } from '../settings/settingsStore.ts';
import { HttpError } from '../http/router.ts';

export function requireMediaWorkflow(id: string) {
  const workflow = getSettings().mediaRendering.workflows.find((item) => item.id === id);
  if (!workflow) throw new HttpError(404, 'The selected workflow no longer exists');
  return workflow;
}
