import type { Endpoint } from '@tinytavern/shared';

export type EndpointPatchPayload = Partial<Endpoint> & { replaceGenParams?: true };

/** Model discovery updates a cache, not the endpoint's editable configuration. */
export function endpointEditorSnapshot({ models, ...settings }: Endpoint) {
  return settings;
}

/** The endpoint form submits its complete visible sampling configuration. */
export function prepareEndpointPatch(data: Partial<Endpoint>): EndpointPatchPayload {
  return data.genParams === undefined ? data : { ...data, replaceGenParams: true };
}
