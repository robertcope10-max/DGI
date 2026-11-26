export type JWTPayload = Record<string, unknown>;
export const createRemoteJWKSet = () => () => { throw new Error('Entra auth is not available in the browser demo'); };
export const jwtVerify = async (): Promise<{ payload: JWTPayload }> => { throw new Error('Entra auth is not available in the browser demo'); };
