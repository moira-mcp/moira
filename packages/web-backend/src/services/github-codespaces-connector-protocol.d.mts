export const CONNECTOR_MAX_REQUEST_BYTES: number;
export const CONNECTOR_MAX_RESPONSE_BYTES: number;
export const CONNECTOR_MAX_CONTROL_OUTPUT_BYTES: number;
export const CONNECTOR_MAX_CREDENTIAL_BYTES: number;
export function encodeConnectorRequest(value: unknown): Buffer;
export function decodeConnectorRequest(bytes: Buffer): unknown;
export function encodeConnectorResponse(value: unknown): Buffer;
export function decodeConnectorResponse(bytes: Buffer): unknown;
export function validGitHubUserCredential(value: unknown): value is string;
