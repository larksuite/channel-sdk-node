/**
 * User access token handling for the follow path.
 *
 * Everything downstream takes a function, never a string: a string would sit on the
 * session and its poll loop as an enumerable property, where `{...session}` or
 * `Object.entries` would find it. A closure variable is not a property.
 */

import { LarkChannelError } from '../types';
import type { MeetingTokenSource } from './types';

export type UserTokenProvider = () => Promise<string>;

/**
 * Normalize either form of {@link MeetingTokenSource} into a provider. A function is
 * re-invoked per request, which is how a meeting outlives a shorter-lived token.
 */
export function toTokenProvider(source: MeetingTokenSource): UserTokenProvider {
  if (typeof source === 'function') return async () => validate(await source());
  const fixed = validate(source);
  return async () => fixed;
}

function validate(token: unknown): string {
  if (typeof token !== 'string' || token.length === 0) {
    throw new LarkChannelError('format_error', 'userAccessToken resolved to an empty value');
  }
  return token;
}
