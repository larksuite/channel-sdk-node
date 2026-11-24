import { LarkChannelError } from '../../types';
import { classifyMeetingError, isRetryableMeetingError, meetingError } from '../errors';

describe('classifyMeetingError', () => {
  test('Feishu code 99991400 is a rate limit, not a credential failure', () => {
    expect(
      classifyMeetingError({
        response: { status: 429, data: { code: 99991400, msg: 'request trigger frequency limit' } },
      }),
    ).toBe('rate_limited');
  });

  test('99991400 on a legacy HTTP 400 is still a rate limit', () => {
    expect(
      classifyMeetingError({
        response: { status: 400, data: { code: 99991400, msg: 'request trigger frequency limit' } },
      }),
    ).toBe('rate_limited');
  });

  test('credential codes stay permission_denied', () => {
    for (const code of [99991401, 99991663, 99991668, 99991672, 20017]) {
      expect(classifyMeetingError({ response: { status: 400, data: { code } } })).toBe(
        'permission_denied',
      );
    }
  });
});

describe('isRetryableMeetingError', () => {
  test('a rate limit is retryable even when it arrived as HTTP 400', () => {
    const err = meetingError({
      response: { status: 400, data: { code: 99991400, msg: 'request trigger frequency limit' } },
    });
    expect(err.code).toBe('rate_limited');
    expect(isRetryableMeetingError(err)).toBe(true);
  });

  test('permission and format errors stay non-retryable', () => {
    expect(isRetryableMeetingError(new LarkChannelError('permission_denied', ''))).toBe(false);
    expect(isRetryableMeetingError(new LarkChannelError('format_error', ''))).toBe(false);
  });
});
