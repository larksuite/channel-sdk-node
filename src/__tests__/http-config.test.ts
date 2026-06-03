/**
 * L1 sink: httpTimeoutMs + respectProxyEnv configure node-sdk's shared
 * `defaultHttpInstance` (REST). A caller-supplied `httpInstance` is left
 * untouched (they own its configuration).
 */
import { defaultHttpInstance, LoggerLevel } from '@larksuiteoapi/node-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createLarkChannel } from '../index';

// defaultHttpInstance is a process-wide singleton — snapshot & restore the
// fields we touch so tests don't leak into one another.
type Defaults = { timeout?: number; httpsAgent?: unknown; httpAgent?: unknown };
const d = defaultHttpInstance.defaults as Defaults;
let snapshot: Defaults;

beforeEach(() => {
  snapshot = { timeout: d.timeout, httpsAgent: d.httpsAgent, httpAgent: d.httpAgent };
});
afterEach(() => {
  d.timeout = snapshot.timeout;
  d.httpsAgent = snapshot.httpsAgent;
  d.httpAgent = snapshot.httpAgent;
  vi.unstubAllEnvs();
});

function make(opts: Record<string, unknown>) {
  createLarkChannel({
    appId: 'cli_test',
    appSecret: 'secret',
    loggerLevel: LoggerLevel.error,
    ...opts,
  });
}

describe('HTTP instance configuration', () => {
  test('httpTimeoutMs sets defaultHttpInstance.defaults.timeout', () => {
    make({ httpTimeoutMs: 30_000 });
    expect(d.timeout).toBe(30_000);
  });

  test('no opts → default instance left untouched', () => {
    d.timeout = undefined;
    make({});
    expect(d.timeout).toBeUndefined();
    expect(d.httpsAgent).toBeUndefined();
  });

  test('respectProxyEnv wires a proxy agent onto the default instance', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.local:8080');
    make({ respectProxyEnv: true });
    expect(d.httpsAgent).toBeInstanceOf(HttpsProxyAgent);
    expect(d.httpAgent).toBe(d.httpsAgent);
  });

  test('respectProxyEnv with no proxy env → untouched', () => {
    d.httpsAgent = undefined;
    vi.stubEnv('HTTPS_PROXY', '');
    vi.stubEnv('HTTP_PROXY', '');
    vi.stubEnv('https_proxy', '');
    vi.stubEnv('http_proxy', '');
    make({ respectProxyEnv: true });
    expect(d.httpsAgent).toBeUndefined();
  });

  test('a caller-supplied httpInstance is NOT mutated', () => {
    const custom = { defaults: {} as Defaults, request: vi.fn() };
    make({ httpInstance: custom, httpTimeoutMs: 30_000 });
    expect(custom.defaults.timeout).toBeUndefined();
  });
});
