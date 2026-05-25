// Generates committed cross-language test vectors (vectors.json) for 1.0.6.
// Run manually: `pnpm exec tsx protocol/fixtures/generate.ts`
// The committed output is the contract; Go and Dart read it to prove the wire
// formats interoperate with this canonical TypeScript implementation.
import { writeFileSync } from 'node:fs';
import {
  encodeEnvelope,
  type Envelope,
  generateKey,
  encrypt,
  genEphemeralKeyPair,
  wrapKey,
  deriveSAS,
  commit,
  genSalt,
  type TunnelInput,
  type TunnelOutput,
  type FilesInput,
  type FilesOutput,
} from '../src/index';

const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');

const envSamples: Envelope[] = [
  { v: 1, sid: 'sess-1', from: 'agent', ch: 'terminal', seq: 0, ts: 1_700_000_000, encrypted: new Uint8Array([1, 2, 3, 4, 250, 0, 255]) },
  { v: 1, sid: 'sess-2', from: 'app', ch: 'files', seq: 7, ts: 1_700_000_099, notify: 'permission_needed', encrypted: new Uint8Array([9, 8, 7]) },
];

const envelopes = envSamples.map((e) => ({
  v: e.v,
  sid: e.sid,
  from: e.from,
  ch: e.ch,
  seq: e.seq,
  ts: e.ts,
  notify: e.notify ?? null,
  encryptedHex: hex(e.encrypted),
  msgpackHex: hex(encodeEnvelope(e)),
}));

const symKey = generateKey();
const symValues: unknown[] = ['hello 世界', 42, true];
const symmetric = {
  keyHex: hex(symKey),
  cases: symValues.map((v) => ({ plaintext: v, sealedHex: hex(encrypt(v, symKey)) })),
};

const agent = genEphemeralKeyPair();
const app = genEphemeralKeyPair();
const k = generateKey();
const box = {
  agentPubHex: hex(agent.publicKey),
  agentSecHex: hex(agent.secretKey),
  appPubHex: hex(app.publicKey),
  appSecHex: hex(app.secretKey),
  kHex: hex(k),
  wrappedHex: hex(wrapKey(k, app.publicKey, agent.secretKey)),
};

const sas = {
  agentPubHex: hex(agent.publicKey),
  appPubHex: hex(app.publicKey),
  sas: deriveSAS(agent.publicKey, app.publicKey),
};

const salt = genSalt();
const commitVector = {
  pubHex: hex(agent.publicKey),
  saltHex: hex(salt),
  commitHex: hex(commit(agent.publicKey, salt)),
};

// Tunnel channel test vectors (Phase 2.1)
const tunnelInputs: TunnelInput[] = [
  { type: 'http_request', id: 'req-1', method: 'GET', port: 3000, path: '/' },
  {
    type: 'http_request',
    id: 'req-2',
    method: 'POST',
    port: 8080,
    path: '/api/data',
    headers: { 'Content-Type': 'application/json' },
    bodyBase64: 'eyJuYW1lIjoiZm9vIn0=', // {"name":"foo"}
  },
  { type: 'refresh_ports' },
];

const tunnelOutputs: TunnelOutput[] = [
  {
    type: 'port_list',
    ports: [
      { port: 3000, pid: 12345, process: 'node' },
      { port: 8080, pid: 5678, process: 'python', cmdline: 'python -m http.server 8080' },
    ],
  },
  {
    type: 'http_response',
    id: 'req-1',
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': 'text/html' },
    bodyBase64: 'PGh0bWw+SGVsbG88L2h0bWw+', // <html>Hello</html>
  },
  {
    type: 'http_error',
    id: 'req-3',
    code: 'connection_refused',
    message: 'Port 4000 is not listening',
  },
];

const tunnel = {
  inputs: tunnelInputs,
  outputs: tunnelOutputs,
};

// Files channel test vectors (Phase 2.2)
const filesInputs: FilesInput[] = [
  { type: 'ls', id: 'files-1', path: '.' },
  { type: 'ls', id: 'files-2', path: 'src', showHidden: true },
  { type: 'read', id: 'files-3', path: 'README.md' },
  { type: 'write', id: 'files-4', path: 'test.txt', contentBase64: 'SGVsbG8gV29ybGQ=' },
  { type: 'mkdir', id: 'files-5', path: 'newdir', recursive: true },
  { type: 'rm', id: 'files-6', path: 'old.txt' },
  { type: 'mv', id: 'files-7', src: 'a.txt', dst: 'b.txt' },
  { type: 'stat', id: 'files-8', path: 'package.json' },
  { type: 'search', id: 'files-9', pattern: '*.ts', maxResults: 100 },
];

const filesOutputs: FilesOutput[] = [
  {
    type: 'ls_result',
    id: 'files-1',
    path: '.',
    entries: [
      { name: 'src', type: 'dir', size: 0, mtime: 1700000000, mode: 493 },
      { name: 'package.json', type: 'file', size: 1024, mtime: 1700000000, mode: 420 },
    ],
  },
  {
    type: 'read_result',
    id: 'files-3',
    path: 'README.md',
    contentBase64: 'IyBQcm9qZWN0',
    size: 10,
    truncated: false,
  },
  { type: 'ok', id: 'files-4', message: 'File written successfully' },
  {
    type: 'stat_result',
    id: 'files-8',
    path: 'package.json',
    entry: { name: 'package.json', type: 'file', size: 1024, mtime: 1700000000 },
  },
  {
    type: 'search_result',
    id: 'files-9',
    pattern: '*.ts',
    matches: ['src/index.ts', 'src/utils.ts'],
    truncated: false,
  },
  { type: 'error', id: 'files-10', code: 'permission_denied', message: 'Access denied: ~/.ssh/id_rsa' },
];

const files = {
  inputs: filesInputs,
  outputs: filesOutputs,
};

const vectors = { envelopes, symmetric, box, sas, commit: commitVector, tunnel, files };
writeFileSync(new URL('./vectors.json', import.meta.url), `${JSON.stringify(vectors, null, 2)}\n`);
console.log('wrote protocol/fixtures/vectors.json');
