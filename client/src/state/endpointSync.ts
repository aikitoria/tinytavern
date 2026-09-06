import type { Endpoint } from '@tinytavern/shared';

export type EndpointPatchPayload = Partial<Endpoint> & { replaceGenParams?: true };

/** The endpoint form submits its complete visible sampling configuration. */
export function prepareEndpointPatch(data: Partial<Endpoint>): EndpointPatchPayload {
  return data.genParams === undefined ? data : { ...data, replaceGenParams: true };
}
