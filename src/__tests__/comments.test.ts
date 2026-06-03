/**
 * CommentSurface (L4) protocol-quirk handling, sunk from bridge:
 *   - resolveTarget: wiki node → obj_token swap; non-wiki → passthrough;
 *     unsupported file type → null
 *   - fetch: `.get` success path; `.get` failure → `.list` pagination fallback
 *   - reply: in-thread success; 1069302 → fresh top-level comment fallback
 *   - addReaction/removeReaction: single endpoint distinguished by `action`
 */
import { CommentSurface } from '../comments';
import type { Logger } from '../internal';

const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};

function apiErr(code: number): unknown {
  return { response: { data: { code } } };
}

/** Build a CommentSurface over a minimal fake Client with the drive/wiki
 *  methods the surface touches. */
function makeSurface(
  overrides: {
    getNode?: ReturnType<typeof vi.fn>;
    commentGet?: ReturnType<typeof vi.fn>;
    commentList?: ReturnType<typeof vi.fn>;
    commentCreate?: ReturnType<typeof vi.fn>;
    request?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const client = {
    wiki: { v2: { space: { getNode: overrides.getNode ?? vi.fn() } } },
    drive: {
      v1: {
        fileComment: {
          get: overrides.commentGet ?? vi.fn(),
          list: overrides.commentList ?? vi.fn(),
          create: overrides.commentCreate ?? vi.fn().mockResolvedValue({ data: {} }),
        },
      },
    },
    request: overrides.request ?? vi.fn().mockResolvedValue({}),
  };
  const surface = new CommentSurface(client as never, silentLogger);
  return { surface, client };
}

describe('CommentSurface.resolveTarget', () => {
  test('unsupported file type → null', async () => {
    const { surface } = makeSurface();
    expect(await surface.resolveTarget('tok', 'slides')).toBeNull();
  });

  test('wiki node → swaps to obj_token / obj_type', async () => {
    const getNode = vi.fn().mockResolvedValue({
      data: { node: { obj_token: 'doccnReal', obj_type: 'docx' } },
    });
    const { surface } = makeSurface({ getNode });
    const t = await surface.resolveTarget('wikicnXyz', 'docx');
    expect(t).toEqual({ fileToken: 'doccnReal', fileType: 'docx' });
  });

  test('non-wiki token (getNode throws) → passthrough', async () => {
    const getNode = vi.fn().mockRejectedValue(new Error('not a wiki node'));
    const { surface } = makeSurface({ getNode });
    const t = await surface.resolveTarget('doccnPlain', 'doc');
    expect(t).toEqual({ fileToken: 'doccnPlain', fileType: 'doc' });
  });
});

describe('CommentSurface.fetch', () => {
  test('get success returns replies/quote/isWhole', async () => {
    const commentGet = vi.fn().mockResolvedValue({
      data: {
        reply_list: { replies: [{ reply_id: 'r1' }] },
        quote: 'selected text',
        is_whole: false,
      },
    });
    const { surface } = makeSurface({ commentGet });
    const c = await surface.fetch({ fileToken: 'd', fileType: 'docx' }, 'cmt1');
    expect(c).toEqual({
      commentId: 'cmt1',
      replies: [{ reply_id: 'r1' }],
      quote: 'selected text',
      isWhole: false,
    });
  });

  test('get failure (1069307) falls back to list pagination', async () => {
    const commentGet = vi.fn().mockRejectedValue(apiErr(1069307));
    const commentList = vi
      .fn()
      .mockResolvedValueOnce({
        data: { items: [{ comment_id: 'other' }], has_more: true, page_token: 'p2' },
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            { comment_id: 'cmt1', reply_list: { replies: [{ reply_id: 'rX' }] }, is_whole: true },
          ],
          has_more: false,
        },
      });
    const { surface } = makeSurface({ commentGet, commentList });
    const c = await surface.fetch({ fileToken: 'd', fileType: 'docx' }, 'cmt1');
    expect(c).toEqual({
      commentId: 'cmt1',
      replies: [{ reply_id: 'rX' }],
      quote: undefined,
      isWhole: true,
    });
    expect(commentList).toHaveBeenCalledTimes(2);
  });

  test('not found via list → null', async () => {
    const commentGet = vi.fn().mockRejectedValue(apiErr(1069307));
    const commentList = vi.fn().mockResolvedValue({ data: { items: [], has_more: false } });
    const { surface } = makeSurface({ commentGet, commentList });
    expect(await surface.fetch({ fileToken: 'd', fileType: 'docx' }, 'missing')).toBeNull();
  });
});

describe('CommentSurface.reply', () => {
  test('in-thread reply uses the replies endpoint', async () => {
    const request = vi.fn().mockResolvedValue({});
    const { surface } = makeSurface({ request });
    await surface.reply({ fileToken: 'd', fileType: 'docx' }, 'cmt1', 'hello');
    expect(request).toHaveBeenCalledTimes(1);
    const arg = request.mock.calls[0][0];
    expect(arg.method).toBe('POST');
    expect(arg.url).toContain('/comments/cmt1/replies');
    expect(arg.data.content.elements[0].text_run.text).toBe('hello');
  });

  test('1069302 → falls back to fresh top-level comment', async () => {
    const request = vi.fn().mockRejectedValue(apiErr(1069302));
    const commentCreate = vi.fn().mockResolvedValue({ data: {} });
    const { surface } = makeSurface({ request, commentCreate });
    await surface.reply({ fileToken: 'd', fileType: 'docx' }, 'cmt1', 'fallback text');
    expect(commentCreate).toHaveBeenCalledTimes(1);
    const arg = commentCreate.mock.calls[0][0];
    expect(arg.data.reply_list.replies[0].content.elements[0].text_run.text).toBe('fallback text');
  });

  test('non-1069302 error propagates', async () => {
    const request = vi.fn().mockRejectedValue(apiErr(99999));
    const commentCreate = vi.fn();
    const { surface } = makeSurface({ request, commentCreate });
    await expect(
      surface.reply({ fileToken: 'd', fileType: 'docx' }, 'cmt1', 'x'),
    ).rejects.toBeDefined();
    expect(commentCreate).not.toHaveBeenCalled();
  });
});

describe('CommentSurface reactions', () => {
  test('addReaction posts action=add and returns true', async () => {
    const request = vi.fn().mockResolvedValue({});
    const { surface } = makeSurface({ request });
    const ok = await surface.addReaction({ fileToken: 'd', fileType: 'docx' }, 'r1');
    expect(ok).toBe(true);
    const arg = request.mock.calls[0][0];
    expect(arg.url).toContain('/comments/reaction');
    expect(arg.data).toMatchObject({ action: 'add', reply_id: 'r1', reaction_type: 'Typing' });
  });

  test('addReaction returns false on failure (best-effort)', async () => {
    const request = vi.fn().mockRejectedValue(new Error('boom'));
    const { surface } = makeSurface({ request });
    expect(await surface.addReaction({ fileToken: 'd', fileType: 'docx' }, 'r1')).toBe(false);
  });

  test('removeReaction posts action=delete', async () => {
    const request = vi.fn().mockResolvedValue({});
    const { surface } = makeSurface({ request });
    await surface.removeReaction({ fileToken: 'd', fileType: 'docx' }, 'r1', 'OK');
    const arg = request.mock.calls[0][0];
    expect(arg.data).toMatchObject({ action: 'delete', reply_id: 'r1', reaction_type: 'OK' });
  });
});
