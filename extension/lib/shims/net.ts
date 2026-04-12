// Browser shim for node:net — only type-level usage reaches the browser.
// The Multiplexer's wrapSocket() takes the WebSocketLike path and never
// calls connect() or references AddressInfo at runtime.
export type AddressInfo = { address: string; family: string; port: number };
export function connect() { throw new Error("node:net is not available in the browser"); }
