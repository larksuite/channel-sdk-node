import { LarkChannelError } from '../../types';
import { classifyError, isFormatError, isReplyTargetGone, isRetryable } from '../errors';

describe('classifyError', () => {
  test('passes through existing LarkChannelError', () => {
    const orig = new LarkChannelError('rate_limited', 'too many');
    const out = classifyError(orig);
    expect(out).toBe(orig);
  });

  test('infers rate_limited from HTTP 429', () => {
    const err = classifyError({ response: { status: 429 } });
    expect(err.code).toBe('rate_limited');
  });

  test('infers permission_denied from HTTP 403', () => {
    const err = classifyError({ response: { status: 403 } });
    expect(err.code).toBe('permission_denied');
  });

  test('infers format_error from HTTP 400', () => {
    const err = classifyError({ response: { status: 400 } });
    expect(err.code).toBe('format_error');
  });

  test('infers target_revoked from Feishu code 230020', () => {
    const err = classifyError({ response: { data: { code: 230020 } } });
    expect(err.code).toBe('target_revoked');
  });

  test('infers target_revoked from a withdrawn-message response without a Feishu code', () => {
    const err = classifyError({
      response: {
        status: 400,
        data: { message: 'The message was withdrawn.' },
      },
    });
    expect(err.code).toBe('target_revoked');
    expect(err.message).toBe('The message was withdrawn.');
  });

  test('does not classify an unrelated HTTP 400 as target_revoked', () => {
    const err = classifyError({
      response: {
        status: 400,
        data: { message: 'Invalid message format.' },
      },
    });
    expect(err.code).toBe('format_error');
  });

  test('infers target_revoked from a withdrawn-message response carried in `msg`', () => {
    const err = classifyError({
      response: { status: 400, data: { msg: 'The Message Was Withdrawn.' } },
    });
    expect(err.code).toBe('target_revoked');
    expect(err.message).toBe('The Message Was Withdrawn.');
  });

  test('keeps the HTTP status classification when a non-400 body mentions withdrawn', () => {
    const err = classifyError({
      response: { status: 403, data: { message: 'message withdrawn from scope' } },
    });
    expect(err.code).toBe('permission_denied');
  });

  test('tolerates a non-string response body message', () => {
    const err = classifyError({
      message: 'Request failed with status code 400',
      response: { status: 400, data: { msg: 400, message: { detail: 'nested' } } },
    });
    expect(err.code).toBe('format_error');
    expect(err.message).toBe('Request failed with status code 400');
  });

  test('classifies a very long unmatched HTTP 400 body quickly', () => {
    const body = 'message '.repeat(50_000); // ~400KB, no "withdrawn"
    const started = Date.now();
    const err = classifyError({ response: { status: 400, data: { message: body } } });
    expect(Date.now() - started).toBeLessThan(500);
    expect(err.code).toBe('format_error');
  });

  test('detects ssrf_blocked from error message prefix', () => {
    const err = classifyError(new Error('ssrf_blocked: 10.0.0.1'));
    expect(err.code).toBe('ssrf_blocked');
  });

  test('detects timeout from error code', () => {
    const err = classifyError({ code: 'ETIMEDOUT', message: 'timeout' });
    expect(err.code).toBe('send_timeout');
  });

  test('falls through to unknown', () => {
    const err = classifyError(new Error('mystery'));
    expect(err.code).toBe('unknown');
  });
});

describe('error predicates', () => {
  test('isRetryable: rate_limited and unknown only', () => {
    expect(isRetryable(new LarkChannelError('rate_limited', ''))).toBe(true);
    expect(isRetryable(new LarkChannelError('unknown', ''))).toBe(true);
    expect(isRetryable(new LarkChannelError('format_error', ''))).toBe(false);
    expect(isRetryable(new LarkChannelError('permission_denied', ''))).toBe(false);
    expect(isRetryable(new LarkChannelError('send_timeout', ''))).toBe(false);
  });

  test('isFormatError', () => {
    expect(isFormatError(new LarkChannelError('format_error', ''))).toBe(true);
    expect(isFormatError(new LarkChannelError('rate_limited', ''))).toBe(false);
  });

  test('isReplyTargetGone', () => {
    expect(isReplyTargetGone(new LarkChannelError('target_revoked', ''))).toBe(true);
    expect(isReplyTargetGone(new LarkChannelError('unknown', ''))).toBe(false);
  });
});
