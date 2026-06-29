/**
 * Channel-level API behavior:
 *   - downloadResource handles Feishu's stream wrapper
 *     `{ getReadableStream, writeFile, headers }` by consuming the readable
 *     into a Buffer.
 *   - editMessage routes text edits through `im.v1.message.update`
 *     (the one API that supports editing text/post), not `message.patch`
 *     (cards only).
 *   - shareChat / shareUser / sticker outbound routes reach the correct
 *     msg_type on the wire.
 */

import { readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoggerLevel } from '@larksuiteoapi/node-sdk';
import { Readable } from 'stream';
import { createLarkChannel } from '../index';

function createChannel() {
  const ch = createLarkChannel({
    appId: 'cli_test',
    appSecret: 'secret',
    loggerLevel: LoggerLevel.error,
  });
  // Pre-populate bot identity so we skip the network fetch for tests
  // that don't care about the connect path.
  (ch as any).botIdentity = { openId: 'ou_bot', name: 'TestBot' };
  return ch;
}

describe('downloadResource stream wrapper', () => {
  function makeStreamWrapper(bytes: Buffer) {
    return {
      getReadableStream: () => Readable.from([bytes]),
      writeFile: async () => '/tmp/x',
      headers: {},
    };
  }

  test('image download: uses messageResource.get and consumes the stream', async () => {
    const ch = createChannel();
    const payload = Buffer.from('fake-png-bytes');
    const get = vi.fn().mockResolvedValue(makeStreamWrapper(payload));
    (ch.rawClient.im.v1.messageResource as any).get = get;

    const buf = await ch.downloadResource('om_1', 'img_v3_xyz', 'image');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.equals(payload)).toBe(true);
    expect(get).toHaveBeenCalledWith({
      path: { message_id: 'om_1', file_key: 'img_v3_xyz' },
      params: { type: 'image' },
    });
  });

  test('file download: passes type=file with message_id', async () => {
    const ch = createChannel();
    const payload = Buffer.from('hello file contents');
    const get = vi.fn().mockResolvedValue(makeStreamWrapper(payload));
    (ch.rawClient.im.v1.messageResource as any).get = get;

    const buf = await ch.downloadResource('om_2', 'file_v3_xyz', 'file');
    expect(buf.equals(payload)).toBe(true);
    expect(get).toHaveBeenCalledWith({
      path: { message_id: 'om_2', file_key: 'file_v3_xyz' },
      params: { type: 'file' },
    });
  });

  test('legacy Buffer response still works (defensive)', async () => {
    const ch = createChannel();
    const payload = Buffer.from('legacy');
    (ch.rawClient.im.v1.messageResource as any).get = vi.fn().mockResolvedValue(payload);
    const buf = await ch.downloadResource('om_x', 'img_x', 'image');
    expect(buf.equals(payload)).toBe(true);
  });

  test('{ data: Buffer } shape still works (defensive)', async () => {
    const ch = createChannel();
    const payload = Buffer.from('nested');
    (ch.rawClient.im.v1.messageResource as any).get = vi.fn().mockResolvedValue({ data: payload });
    const buf = await ch.downloadResource('om_x', 'img_x', 'image');
    expect(buf.equals(payload)).toBe(true);
  });

  test('unknown shape throws LarkChannelError', async () => {
    const ch = createChannel();
    (ch.rawClient.im.v1.messageResource as any).get = vi.fn().mockResolvedValue({ some: 'random' });
    await expect(ch.downloadResource('om_x', 'img_x', 'image')).rejects.toMatchObject({
      code: 'unknown',
      message: expect.stringContaining('unexpected download response type'),
    });
  });

  test('downloadResourceWithMeta surfaces response content-type (params stripped)', async () => {
    const ch = createChannel();
    const payload = Buffer.from('jpeg-bytes');
    (ch.rawClient.im.v1.messageResource as any).get = vi.fn().mockResolvedValue({
      getReadableStream: () => Readable.from([payload]),
      writeFile: async () => '/tmp/x',
      headers: { 'content-type': 'image/jpeg; charset=binary' },
    });
    const { buffer, contentType } = await ch.downloadResourceWithMeta('om_1', 'img_1', 'image');
    expect(buffer.equals(payload)).toBe(true);
    expect(contentType).toBe('image/jpeg');
  });

  test('downloadResourceWithMeta returns undefined content-type when header absent', async () => {
    const ch = createChannel();
    const payload = Buffer.from('x');
    (ch.rawClient.im.v1.messageResource as any).get = vi.fn().mockResolvedValue({
      getReadableStream: () => Readable.from([payload]),
      writeFile: async () => '/tmp/x',
      headers: {},
    });
    const { contentType } = await ch.downloadResourceWithMeta('om_1', 'f_1', 'file');
    expect(contentType).toBeUndefined();
  });
});

describe('downloadResourceToFile (streaming, no heap buffering)', () => {
  test('pipes the response stream to disk and reports size + content-type', async () => {
    const ch = createChannel();
    const payload = Buffer.from('streamed-attachment-bytes');
    const dest = join(tmpdir(), `chan-dl-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    (ch.rawClient.im.v1.messageResource as any).get = vi.fn().mockResolvedValue({
      getReadableStream: () => Readable.from([payload]),
      writeFile: async () => dest,
      headers: { 'content-type': 'application/pdf; charset=binary' },
    });

    try {
      const r = await ch.downloadResourceToFile('om_1', 'f_1', 'file', dest);
      expect(r.contentType).toBe('application/pdf');
      expect(r.bytesWritten).toBe(payload.length);
      const onDisk = await readFile(dest);
      expect(onDisk.equals(payload)).toBe(true);
      expect((await stat(dest)).size).toBe(payload.length);
    } finally {
      await rm(dest, { force: true });
    }
  });

  test('falls back to writing a defensive raw-Buffer response', async () => {
    const ch = createChannel();
    const payload = Buffer.from('legacy-buffer');
    const dest = join(tmpdir(), `chan-dl-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    (ch.rawClient.im.v1.messageResource as any).get = vi.fn().mockResolvedValue(payload);

    try {
      const r = await ch.downloadResourceToFile('om_1', 'f_1', 'file', dest);
      expect(r.bytesWritten).toBe(payload.length);
      expect((await readFile(dest)).equals(payload)).toBe(true);
    } finally {
      await rm(dest, { force: true });
    }
  });
});

describe('reaction add / remove round-trip', () => {
  test('addReaction returns the reaction_id from response', async () => {
    const ch = createChannel();
    const create = vi.fn().mockResolvedValue({
      data: { reaction_id: 'rx_1234', reaction_type: { emoji_type: 'OK' } },
    });
    (ch.rawClient.im.v1.messageReaction as any).create = create;

    const rid = await ch.addReaction('om_xyz', 'OK');
    expect(rid).toBe('rx_1234');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_xyz' },
        data: { reaction_type: { emoji_type: 'OK' } },
      }),
    );
  });

  test('addReaction accepts top-level reaction_id as a defensive fallback', async () => {
    const ch = createChannel();
    (ch.rawClient.im.v1.messageReaction as any).create = vi
      .fn()
      .mockResolvedValue({ reaction_id: 'rx_top' });
    const rid = await ch.addReaction('om_xyz', 'OK');
    expect(rid).toBe('rx_top');
  });

  test('addReaction throws when reaction_id missing', async () => {
    const ch = createChannel();
    (ch.rawClient.im.v1.messageReaction as any).create = vi.fn().mockResolvedValue({ data: {} });
    await expect(ch.addReaction('om_xyz', 'OK')).rejects.toMatchObject({
      code: 'unknown',
      message: expect.stringContaining('no reaction_id'),
    });
  });

  test('removeReaction calls messageReaction.delete with reaction_id', async () => {
    const ch = createChannel();
    const del = vi.fn().mockResolvedValue({ data: {} });
    (ch.rawClient.im.v1.messageReaction as any).delete = del;

    await ch.removeReaction('om_xyz', 'rx_1234');
    expect(del).toHaveBeenCalledWith({
      path: { message_id: 'om_xyz', reaction_id: 'rx_1234' },
    });
  });

  test('removeReactionByEmoji finds bot-added reaction and deletes it', async () => {
    const ch = createChannel();
    const list = vi.fn().mockResolvedValue({
      data: {
        items: [
          {
            reaction_id: 'rx_user',
            operator: { operator_type: 'user' },
          },
          {
            reaction_id: 'rx_bot',
            operator: { operator_type: 'app' },
          },
        ],
      },
    });
    const del = vi.fn().mockResolvedValue({ data: {} });
    (ch.rawClient.im.v1.messageReaction as any).list = list;
    (ch.rawClient.im.v1.messageReaction as any).delete = del;

    const deleted = await ch.removeReactionByEmoji('om_xyz', 'OK');
    expect(deleted).toBe(true);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_xyz' },
        params: expect.objectContaining({ reaction_type: 'OK' }),
      }),
    );
    expect(del).toHaveBeenCalledWith({
      path: { message_id: 'om_xyz', reaction_id: 'rx_bot' },
    });
  });

  test('removeReactionByEmoji returns false when bot has not reacted', async () => {
    const ch = createChannel();
    (ch.rawClient.im.v1.messageReaction as any).list = vi.fn().mockResolvedValue({
      data: {
        items: [{ reaction_id: 'rx_user', operator: { operator_type: 'user' } }],
      },
    });
    const del = vi.fn();
    (ch.rawClient.im.v1.messageReaction as any).delete = del;

    const deleted = await ch.removeReactionByEmoji('om_xyz', 'OK');
    expect(deleted).toBe(false);
    expect(del).not.toHaveBeenCalled();
  });

  test('removeReactionByEmoji returns false when list is empty', async () => {
    const ch = createChannel();
    (ch.rawClient.im.v1.messageReaction as any).list = vi
      .fn()
      .mockResolvedValue({ data: { items: [] } });
    const del = vi.fn();
    (ch.rawClient.im.v1.messageReaction as any).delete = del;
    expect(await ch.removeReactionByEmoji('om_xyz', 'OK')).toBe(false);
    expect(del).not.toHaveBeenCalled();
  });
});

describe('editMessage routes to im.v1.message.update', () => {
  test('uses message.update with msg_type=text (NOT message.patch)', async () => {
    const ch = createChannel();
    const update = vi.fn().mockResolvedValue({ data: {} });
    const patch = vi.fn();
    (ch.rawClient.im.v1.message as any).update = update;
    (ch.rawClient.im.v1.message as any).patch = patch;

    await ch.editMessage('om_xyz', 'new body');

    expect(patch).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_xyz' },
        data: expect.objectContaining({
          msg_type: 'text',
          content: JSON.stringify({ text: 'new body' }),
        }),
      }),
    );
  });
});

describe('card.action dedup key includes button identity', () => {
  // Regression: previously the dedup key was
  //   card:${messageId}:${operatorId}
  // so the second click on ANY button of the same card by the same user
  // got silently dropped. The fix folds action.tag + action.value into
  // the key so distinct buttons never collide.

  function buildRawCardAction(value: unknown, messageId = 'om_card1'): unknown {
    return {
      schema: '2.0',
      event_type: 'card.action.trigger',
      context: {
        open_message_id: messageId,
        open_chat_id: 'oc_test',
      },
      operator: { open_id: 'ou_alice' },
      action: { tag: 'button', value },
    };
  }

  async function dispatchRaw(ch: any, raw: unknown) {
    // The dispatcher routes by event_type -> handler registered in
    // `registerDispatcherHandlers()`. We invoke that handler directly.
    await ch.dispatcher.handles.get('card.action.trigger')(raw);
  }

  test('two different buttons on the same card both fire the handler', async () => {
    const ch = createChannel();
    (ch as any).registerDispatcherHandlers();

    const fired: unknown[] = [];
    ch.on('cardAction', (evt) => {
      fired.push(evt.action.value);
    });

    await dispatchRaw(ch, buildRawCardAction({ cmd: 'A' }));
    await dispatchRaw(ch, buildRawCardAction({ cmd: 'B' }));

    expect(fired).toEqual([{ cmd: 'A' }, { cmd: 'B' }]);
  });

  test('same button clicked twice (e.g. Feishu re-delivery) only fires once', async () => {
    const ch = createChannel();
    (ch as any).registerDispatcherHandlers();

    let calls = 0;
    ch.on('cardAction', () => {
      calls++;
    });

    // Use a fresh messageId so this test doesn't inherit state from the
    // previous test case in the same module (internalCache is a
    // module-level singleton and persists across jest tests in the same
    // file).
    await dispatchRaw(ch, buildRawCardAction({ cmd: 'A' }, 'om_dedup_probe'));
    await dispatchRaw(ch, buildRawCardAction({ cmd: 'A' }, 'om_dedup_probe'));

    expect(calls).toBe(1);
  });
});

describe('cardAction handler return value flows back out of the dispatcher', () => {
  // The dispatcher's `card.action.trigger` handler must return whatever the
  // user's cardAction handler returns, so the underlying node-sdk WS adapter
  // can encode it as the card callback response payload (toast / inline card
  // update). Returning undefined => no response payload (legacy behavior).

  function buildRawCardAction(value: unknown, messageId: string): unknown {
    return {
      schema: '2.0',
      event_type: 'card.action.trigger',
      context: {
        open_message_id: messageId,
        open_chat_id: 'oc_test',
      },
      operator: { open_id: 'ou_alice' },
      action: { tag: 'button', value },
    };
  }

  // Invoke the dispatcher handler directly AND surface its return value.
  // (The dedup-focused tests above intentionally ignore the return value; here
  // the return value is the contract under test.)
  async function dispatchRawAndReturn(ch: any, raw: unknown): Promise<unknown> {
    return ch.dispatcher.handles.get('card.action.trigger')(raw);
  }

  test('handler returning a response object is returned verbatim by the dispatcher', async () => {
    const ch = createChannel();
    (ch as any).registerDispatcherHandlers();

    const response = { toast: { type: 'success', content: 'ok' } };
    ch.on('cardAction', () => response);

    const ret = await dispatchRawAndReturn(ch, buildRawCardAction({ cmd: 'A' }, 'om_ret_verbatim'));

    expect(ret).toEqual({ toast: { type: 'success', content: 'ok' } });
  });

  test('handler returning undefined makes the dispatcher return undefined', async () => {
    const ch = createChannel();
    (ch as any).registerDispatcherHandlers();

    ch.on('cardAction', () => {
      /* no return — legacy void handler */
    });

    // Fresh messageId so the module-level internalCache can't dedup-drop this
    // dispatch on account of an earlier test case.
    const ret = await dispatchRawAndReturn(
      ch,
      buildRawCardAction({ cmd: 'A' }, 'om_ret_undefined'),
    );

    expect(ret).toBeUndefined();
  });

  test('no registered cardAction handler makes the dispatcher return undefined (no throw)', async () => {
    const ch = createChannel();
    (ch as any).registerDispatcherHandlers();

    // No ch.on('cardAction', ...) at all.
    const ret = await dispatchRawAndReturn(
      ch,
      buildRawCardAction({ cmd: 'A' }, 'om_ret_no_handler'),
    );

    expect(ret).toBeUndefined();
  });

  test('dedup re-delivery: handler fires once, second dispatch returns undefined', async () => {
    const ch = createChannel();
    (ch as any).registerDispatcherHandlers();

    let calls = 0;
    ch.on('cardAction', () => {
      calls++;
      return { toast: { type: 'success', content: 'ok' } };
    });

    const first = await dispatchRawAndReturn(ch, buildRawCardAction({ cmd: 'A' }, 'om_ret_dedup'));
    const second = await dispatchRawAndReturn(ch, buildRawCardAction({ cmd: 'A' }, 'om_ret_dedup'));

    expect(calls).toBe(1);
    expect(first).toEqual({ toast: { type: 'success', content: 'ok' } });
    // The deduped re-delivery must not re-emit a response — matches Feishu's
    // retry semantics (the first delivery already produced the response).
    expect(second).toBeUndefined();
  });
});

describe('comment dedup key includes replyId', () => {
  // Regression: previously the dedup key was
  //   comment:${fileToken}:${commentId}
  // so any reply within an existing comment thread (same commentId,
  // different replyId) silently collided with the top-level comment
  // and got dropped. The fix folds replyId into the key.

  function buildRawComment(opts: {
    fileToken?: string;
    commentId: string;
    replyId?: string;
  }): unknown {
    return {
      file_token: opts.fileToken ?? 'doccn_x',
      file_type: 'doc',
      comment_id: opts.commentId,
      reply_id: opts.replyId,
      is_mentioned: true,
      create_time: String(Date.now()),
      notice_meta: {
        from_user_id: { open_id: 'ou_alice' },
      },
    };
  }

  async function dispatchRaw(ch: any, raw: unknown) {
    await ch.dispatcher.handles.get('drive.notice.comment_add_v1')(raw);
  }

  test('top-level comment fires the handler', async () => {
    const ch = createChannel();
    (ch as any).registerDispatcherHandlers();

    const fired: Array<string | undefined> = [];
    ch.on('comment', (evt) => {
      fired.push(evt.replyId);
    });

    await dispatchRaw(
      ch,
      buildRawComment({
        commentId: 'cmt_top_a',
        // Use a unique fileToken/commentId so a previous test in this
        // module can't collide via the module-level internalCache.
      }),
    );

    expect(fired).toEqual([undefined]);
  });

  test('multiple replies in the same comment thread all fire the handler', async () => {
    const ch = createChannel();
    (ch as any).registerDispatcherHandlers();

    const fired: Array<string | undefined> = [];
    ch.on('comment', (evt) => {
      fired.push(evt.replyId);
    });

    // Use a fresh commentId so this case doesn't inherit dedup state.
    await dispatchRaw(
      ch,
      buildRawComment({
        fileToken: 'doc_thread',
        commentId: 'cmt_thread_a',
        replyId: 'rpl_1',
      }),
    );
    await dispatchRaw(
      ch,
      buildRawComment({
        fileToken: 'doc_thread',
        commentId: 'cmt_thread_a',
        replyId: 'rpl_2',
      }),
    );
    await dispatchRaw(
      ch,
      buildRawComment({
        fileToken: 'doc_thread',
        commentId: 'cmt_thread_a',
        replyId: 'rpl_3',
      }),
    );

    expect(fired).toEqual(['rpl_1', 'rpl_2', 'rpl_3']);
  });

  test('genuine duplicate (same commentId + replyId) is still deduped once', async () => {
    const ch = createChannel();
    (ch as any).registerDispatcherHandlers();

    let calls = 0;
    ch.on('comment', () => {
      calls++;
    });

    const raw = buildRawComment({
      fileToken: 'doc_dup',
      commentId: 'cmt_dup_a',
      replyId: 'rpl_x',
    });
    // Simulate Feishu re-delivery: same exact payload twice.
    await dispatchRaw(ch, raw);
    await dispatchRaw(ch, raw);

    expect(calls).toBe(1);
  });

  test('top-level and a reply on the same comment do not collide', async () => {
    const ch = createChannel();
    (ch as any).registerDispatcherHandlers();

    const fired: Array<string | undefined> = [];
    ch.on('comment', (evt) => {
      fired.push(evt.replyId);
    });

    await dispatchRaw(
      ch,
      buildRawComment({
        fileToken: 'doc_mix',
        commentId: 'cmt_mix_a',
        // top-level
      }),
    );
    await dispatchRaw(
      ch,
      buildRawComment({
        fileToken: 'doc_mix',
        commentId: 'cmt_mix_a',
        replyId: 'rpl_1',
      }),
    );

    expect(fired).toEqual([undefined, 'rpl_1']);
  });
});

describe('share_chat / share_user / sticker outbound', () => {
  function stubSender(ch: ReturnType<typeof createChannel>) {
    const create = vi.fn().mockResolvedValue({ data: { message_id: 'om_ok' } });
    (ch.rawClient.im.v1.message as any).create = create;
    (ch.rawClient.im.v1.message as any).reply = vi.fn();
    return create;
  }

  test('shareChat → msg_type=share_chat, content={chat_id}', async () => {
    const ch = createChannel();
    const create = stubSender(ch);
    const r = await ch.send('oc_abc', { shareChat: { chatId: 'oc_target' } });
    expect(r.messageId).toBe('om_ok');
    const call = create.mock.calls[0][0];
    expect(call.data.msg_type).toBe('share_chat');
    expect(JSON.parse(call.data.content)).toEqual({ chat_id: 'oc_target' });
  });

  test('shareUser → msg_type=share_user, content={user_id}', async () => {
    const ch = createChannel();
    const create = stubSender(ch);
    const r = await ch.send('oc_abc', { shareUser: { userId: 'ou_alice' } });
    expect(r.messageId).toBe('om_ok');
    const call = create.mock.calls[0][0];
    expect(call.data.msg_type).toBe('share_user');
    expect(JSON.parse(call.data.content)).toEqual({ user_id: 'ou_alice' });
  });

  test('sticker → msg_type=sticker, content={file_key}', async () => {
    const ch = createChannel();
    const create = stubSender(ch);
    const r = await ch.send('oc_abc', { sticker: { fileKey: 'sticker_abc' } });
    expect(r.messageId).toBe('om_ok');
    const call = create.mock.calls[0][0];
    expect(call.data.msg_type).toBe('sticker');
    expect(JSON.parse(call.data.content)).toEqual({ file_key: 'sticker_abc' });
  });
});

describe('getChatMode', () => {
  function stubChatGet(ch: ReturnType<typeof createChannel>, response: unknown) {
    const get = vi.fn().mockResolvedValue(response);
    (ch.rawClient.im.v1.chat as any).get = get;
    return get;
  }

  test('chat_mode="p2p" → "p2p"', async () => {
    const ch = createChannel();
    stubChatGet(ch, { data: { chat_mode: 'p2p' } });
    expect(await ch.getChatMode('oc_x')).toBe('p2p');
  });

  test('chat_mode="group" → "group"', async () => {
    const ch = createChannel();
    stubChatGet(ch, { data: { chat_mode: 'group' } });
    expect(await ch.getChatMode('oc_x')).toBe('group');
  });

  test('chat_mode="topic" → "topic"', async () => {
    const ch = createChannel();
    stubChatGet(ch, { data: { chat_mode: 'topic' } });
    expect(await ch.getChatMode('oc_x')).toBe('topic');
  });

  test('missing chat_mode falls back to "group"', async () => {
    const ch = createChannel();
    stubChatGet(ch, { data: {} });
    expect(await ch.getChatMode('oc_x')).toBe('group');
  });

  test('unknown chat_mode value falls back to "group"', async () => {
    const ch = createChannel();
    stubChatGet(ch, { data: { chat_mode: 'something_new' } });
    expect(await ch.getChatMode('oc_x')).toBe('group');
  });

  test('chat.get API error propagates to caller', async () => {
    const ch = createChannel();
    const apiErr = new Error('permission_denied');
    (ch.rawClient.im.v1.chat as any).get = vi.fn().mockRejectedValue(apiErr);
    await expect(ch.getChatMode('oc_x')).rejects.toBe(apiErr);
  });
});

describe('createChat', () => {
  test('maps options to im.v1.chat.create and returns chat_id', async () => {
    const ch = createChannel();
    const create = vi.fn().mockResolvedValue({ data: { chat_id: 'oc_new' } });
    (ch.rawClient.im.v1.chat as any).create = create;

    const r = await ch.createChat({
      name: 'AI standup',
      description: 'daily',
      inviteUserIds: ['ou_a', 'ou_b'],
    });
    expect(r).toEqual({ chatId: 'oc_new' });
    expect(create).toHaveBeenCalledWith({
      params: { user_id_type: 'open_id' },
      data: {
        name: 'AI standup',
        description: 'daily',
        chat_mode: 'group',
        chat_type: 'private',
        user_id_list: ['ou_a', 'ou_b'],
      },
    });
  });

  test('honors explicit userIdType / chatType', async () => {
    const ch = createChannel();
    const create = vi.fn().mockResolvedValue({ data: { chat_id: 'oc_x' } });
    (ch.rawClient.im.v1.chat as any).create = create;
    await ch.createChat({
      name: 'g',
      inviteUserIds: ['u1'],
      userIdType: 'user_id',
      chatType: 'public',
    });
    const call = create.mock.calls[0][0];
    expect(call.params.user_id_type).toBe('user_id');
    expect(call.data.chat_type).toBe('public');
  });

  test('throws when chat_id missing', async () => {
    const ch = createChannel();
    (ch.rawClient.im.v1.chat as any).create = vi.fn().mockResolvedValue({ data: {} });
    await expect(ch.createChat({ name: 'g' })).rejects.toMatchObject({
      code: 'unknown',
      message: expect.stringContaining('no chat_id'),
    });
  });
});

describe('listChats', () => {
  test('follows pagination and accumulates {id,name}', async () => {
    const ch = createChannel();
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          items: [{ chat_id: 'oc_1', name: 'A' }],
          has_more: true,
          page_token: 'tok2',
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [{ chat_id: 'oc_2', name: 'B' }],
          has_more: false,
        },
      });
    (ch.rawClient.im.v1.chat as any).list = list;

    const chats = await ch.listChats();
    expect(chats).toEqual([
      { id: 'oc_1', name: 'A' },
      { id: 'oc_2', name: 'B' },
    ]);
    expect(list).toHaveBeenNthCalledWith(1, {
      params: { page_size: 100, page_token: undefined },
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      params: { page_size: 100, page_token: 'tok2' },
    });
  });

  test('stops at maxPages even when has_more stays true', async () => {
    const ch = createChannel();
    const list = vi.fn().mockResolvedValue({
      data: { items: [{ chat_id: 'oc_x', name: 'X' }], has_more: true, page_token: 't' },
    });
    (ch.rawClient.im.v1.chat as any).list = list;
    const chats = await ch.listChats({ maxPages: 2 });
    expect(list).toHaveBeenCalledTimes(2);
    expect(chats).toHaveLength(2);
  });

  test('clamps pageSize to 100', async () => {
    const ch = createChannel();
    const list = vi.fn().mockResolvedValue({ data: { items: [], has_more: false } });
    (ch.rawClient.im.v1.chat as any).list = list;
    await ch.listChats({ pageSize: 5000 });
    expect(list.mock.calls[0][0].params.page_size).toBe(100);
  });
});

describe('getAppInfo', () => {
  test('uses constructed appId and extracts owner_id', async () => {
    const ch = createChannel();
    const get = vi.fn().mockResolvedValue({
      data: { app: { app_name: 'MyBot', owner: { owner_id: 'ou_owner' } } },
    });
    (ch.rawClient.application.v6.application as any).get = get;

    const info = await ch.getAppInfo();
    expect(info).toEqual({ ownerId: 'ou_owner', appName: 'MyBot' });
    expect(get).toHaveBeenCalledWith({
      path: { app_id: 'cli_test' },
      params: { lang: 'zh_cn', user_id_type: 'open_id' },
    });
  });
});

describe('fetchRawMessage', () => {
  test('returns raw items and defaults card_msg_content_type', async () => {
    const ch = createChannel();
    const items = [{ message_id: 'om_1', msg_type: 'text', body: { content: '{"text":"hi"}' } }];
    const get = vi.fn().mockResolvedValue({ data: { items } });
    (ch.rawClient.im.v1.message as any).get = get;

    const r = await ch.fetchRawMessage('om_1');
    expect(r).toBe(items);
    expect(get).toHaveBeenCalledWith({
      path: { message_id: 'om_1' },
      params: { card_msg_content_type: 'user_card_content' },
    });
  });

  test('omits param when cardContentType is null', async () => {
    const ch = createChannel();
    const get = vi.fn().mockResolvedValue({ data: { items: [] } });
    (ch.rawClient.im.v1.message as any).get = get;
    await ch.fetchRawMessage('om_1', { cardContentType: null });
    expect(get).toHaveBeenCalledWith({ path: { message_id: 'om_1' }, params: undefined });
  });
});

describe('managed card lifecycle', () => {
  test('createCard → cardkit.v1.card.create, returns card_id', async () => {
    const ch = createChannel();
    const create = vi.fn().mockResolvedValue({ data: { card_id: 'cd_1' } });
    (ch.rawClient.cardkit.v1.card as any).create = create;

    const r = await ch.createCard({ schema: '2.0', body: {} });
    expect(r).toEqual({ cardId: 'cd_1' });
    const call = create.mock.calls[0][0];
    expect(call.data.type).toBe('card_json');
    expect(JSON.parse(call.data.data)).toEqual({ schema: '2.0', body: {} });
  });

  test('updateCardById → cardkit.v1.card.update with card_id + sequence', async () => {
    const ch = createChannel();
    const update = vi.fn().mockResolvedValue({ data: {} });
    (ch.rawClient.cardkit.v1.card as any).update = update;

    await ch.updateCardById('cd_1', { schema: '2.0' }, 7);
    const call = update.mock.calls[0][0];
    expect(call.path).toEqual({ card_id: 'cd_1' });
    expect(call.data.sequence).toBe(7);
    expect(call.data.card.type).toBe('card_json');
    expect(JSON.parse(call.data.card.data)).toEqual({ schema: '2.0' });
  });

  test('send({ cardId }) routes interactive message referencing the card', async () => {
    const ch = createChannel();
    const create = vi.fn().mockResolvedValue({ data: { message_id: 'om_card' } });
    (ch.rawClient.im.v1.message as any).create = create;

    const r = await ch.send('oc_abc', { cardId: 'cd_1' });
    expect(r.messageId).toBe('om_card');
    const call = create.mock.calls[0][0];
    expect(call.data.msg_type).toBe('interactive');
    expect(JSON.parse(call.data.content)).toEqual({ type: 'card', data: { card_id: 'cd_1' } });
  });
});
