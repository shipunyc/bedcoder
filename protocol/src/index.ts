// @bedcoder/protocol — canonical wire protocol.
// Envelope + channel payloads + pairing handshake, with Zod schemas and a
// MessagePack codec. This is the single source of truth mirrored by the Go
// relay and the Dart app (DESIGN §4).

export * from './envelope';
export * from './terminal';
export * from './tunnel';
export * from './files';
export * from './pairing';
export * from './preview';
export * from './codec';
export * from './crypto';
