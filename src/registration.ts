import { registerApp } from '@larksuiteoapi/node-sdk';

// Types are derived from node-sdk's function signature (it exports the function
// but not these named types) — so they stay in sync without copying.
export type RegisterAppOptions = Parameters<typeof registerApp>[0];
export type RegisterAppResult = Awaited<ReturnType<typeof registerApp>>;
export type QRCodeInfo = Parameters<RegisterAppOptions['onQRCodeReady']>[0];

/**
 * One-click QR-code app registration (device-code flow), re-exported from
 * node-sdk. You receive a QR URL via `onQRCodeReady`; after the user scans it
 * and creates / authorizes the app, this resolves with
 * `{ client_id, client_secret }` — feed those into {@link createLarkChannel} as
 * `appId` / `appSecret`.
 *
 * `source` is passed through unchanged (not defaulted): node-sdk already tags
 * the QR URL with the SDK name, and `source` appends `source/<name>` for your
 * own attribution if you want it.
 *
 * @example
 * const { client_id, client_secret } = await registerApp({
 *   onQRCodeReady: ({ url }) => console.log('scan to register:', url),
 * });
 * const channel = createLarkChannel({ appId: client_id, appSecret: client_secret });
 */
export { registerApp };
