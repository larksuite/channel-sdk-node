import type { Client } from '@larksuiteoapi/node-sdk';
import type { Logger } from './internal';

/**
 * Cloud-doc comment surface (L4 outbound). Wraps the Feishu drive-comment
 * APIs and internalizes the quirks any bot integrating doc comments would
 * otherwise hit:
 *   - wiki node → underlying obj_token resolution
 *   - `fileComment.get` returning 1069307 for some comment types → `.list`
 *     pagination fallback
 *   - in-thread reply rejected with 1069302 on whole-document comments →
 *     fresh top-level comment fallback
 *   - comment reaction add/delete being the same endpoint with an `action`
 *     field (and not returning a reaction_id)
 *
 * Business concerns stay with the caller: which reply is "the question",
 * prompt assembly, markdown stripping, session mapping. This surface only
 * speaks the Feishu comment protocol.
 */

export type CommentFileType = 'doc' | 'docx' | 'sheet' | 'file';

/** File types the drive comment APIs support here. Others (slides, bitable,
 *  mindnote) use different APIs and are out of scope. */
const SUPPORTED_FILE_TYPES = new Set<string>(['doc', 'docx', 'sheet', 'file']);

export interface CommentTarget {
  fileToken: string;
  fileType: CommentFileType;
}

export interface CommentReplyContentElement {
  type: 'text_run' | 'docs_link' | 'person';
  text_run?: { text: string };
  docs_link?: { url: string };
  person?: { user_id: string };
}

export interface CommentReply {
  reply_id?: string;
  content?: { elements?: CommentReplyContentElement[] };
}

export interface FetchedComment {
  commentId: string;
  replies: CommentReply[];
  /** The text the user selected (inline comment); empty for whole-doc. */
  quote?: string;
  /** True when the comment targets the whole document rather than a selection. */
  isWhole: boolean;
}

interface CommentGetResponse {
  data?: { reply_list?: { replies?: CommentReply[] }; quote?: string; is_whole?: boolean };
}
interface CommentListItem {
  comment_id?: string;
  reply_list?: { replies?: CommentReply[] };
  is_whole?: boolean;
  quote?: string;
}
interface CommentListResponse {
  data?: { items?: CommentListItem[]; has_more?: boolean; page_token?: string };
}

function errCode(err: unknown): number | undefined {
  return (err as { response?: { data?: { code?: number } } })?.response?.data?.code;
}

export class CommentSurface {
  constructor(
    private readonly client: Client,
    private readonly logger: Logger,
  ) {}

  /**
   * Resolve the (fileToken, fileType) to hit for the comment APIs. If the
   * token is a wiki node, swap to its underlying obj_token; otherwise pass
   * through. Returns `null` when the file type is unsupported.
   */
  async resolveTarget(fileToken: string, fileType: string): Promise<CommentTarget | null> {
    if (!SUPPORTED_FILE_TYPES.has(fileType)) return null;
    const passthrough: CommentTarget = {
      fileToken,
      fileType: fileType as CommentFileType,
    };

    // Try wiki node lookup; non-wiki tokens throw here → fall back to passthrough.
    try {
      const r = (await this.client.wiki.v2.space.getNode({
        params: { token: fileToken },
      })) as { data?: { node?: { obj_token?: string; obj_type?: string } } };
      const node = r?.data?.node;
      if (node?.obj_token && node.obj_type && SUPPORTED_FILE_TYPES.has(node.obj_type)) {
        this.logger.info?.('channel: comment wiki-resolved', {
          objToken: node.obj_token,
          objType: node.obj_type,
        });
        return {
          fileToken: node.obj_token,
          fileType: node.obj_type as CommentFileType,
        };
      }
    } catch {
      // not a wiki node — fall through
    }
    return passthrough;
  }

  /**
   * Fetch a comment with its replies. Tries `fileComment.get`; for comment
   * types that return 1069307 there, falls back to paginating `.list` and
   * locating the comment by id. Returns `null` when not found.
   */
  async fetch(target: CommentTarget, commentId: string): Promise<FetchedComment | null> {
    try {
      const r = (await this.client.drive.v1.fileComment.get({
        params: { file_type: target.fileType },
        path: { file_token: target.fileToken, comment_id: commentId },
      })) as CommentGetResponse;
      return {
        commentId,
        replies: r?.data?.reply_list?.replies ?? [],
        quote: r?.data?.quote || undefined,
        isWhole: Boolean(r?.data?.is_whole),
      };
    } catch (err) {
      this.logger.warn?.('channel: comment get failed, falling back to list', {
        code: errCode(err),
      });
      const found = await this.findViaList(target, commentId);
      if (!found) return null;
      return {
        commentId,
        replies: found.reply_list?.replies ?? [],
        quote: found.quote || undefined,
        isWhole: Boolean(found.is_whole),
      };
    }
  }

  /**
   * Reply to a comment in-thread. Whole-document comments reject in-thread
   * replies with 1069302 (they have no thread, only a flat list) — in that
   * case post a fresh top-level comment instead.
   */
  async reply(target: CommentTarget, commentId: string, text: string): Promise<void> {
    const url =
      `/open-apis/drive/v1/files/${encodeURIComponent(target.fileToken)}/comments/` +
      `${encodeURIComponent(commentId)}/replies?file_type=${encodeURIComponent(target.fileType)}`;
    try {
      await this.client.request({
        method: 'POST',
        url,
        data: { content: { elements: [{ type: 'text_run', text_run: { text } }] } },
      });
      this.logger.info?.('channel: comment replied', { mode: 'in-thread' });
      return;
    } catch (err) {
      // 1069302: whole-document comments don't accept in-thread replies.
      if (errCode(err) !== 1069302) throw err;
      this.logger.warn?.('channel: comment reply rejected, posting fresh top-level', {
        code: 1069302,
      });
    }

    await this.client.drive.v1.fileComment.create({
      params: { file_type: target.fileType as 'doc' | 'docx' },
      path: { file_token: target.fileToken },
      data: {
        reply_list: {
          replies: [{ content: { elements: [{ type: 'text_run', text_run: { text } }] } }],
        },
      },
    });
    this.logger.info?.('channel: comment replied', { mode: 'new-top-level' });
  }

  /**
   * Add a reaction to a comment reply. Doc-comment reactions use a dedicated
   * endpoint (separate from IM message reactions); add/delete are the same
   * POST distinguished by an `action` field, and it returns no reaction_id.
   * Returns `true` on success. Defaults to the "Typing" emoji.
   */
  async addReaction(
    target: CommentTarget,
    replyId: string,
    emojiType = 'Typing',
  ): Promise<boolean> {
    return this.reaction(target, replyId, emojiType, 'add');
  }

  /** Remove a previously-added comment reaction. Same endpoint, action=delete. */
  async removeReaction(
    target: CommentTarget,
    replyId: string,
    emojiType = 'Typing',
  ): Promise<void> {
    await this.reaction(target, replyId, emojiType, 'delete');
  }

  private async reaction(
    target: CommentTarget,
    replyId: string,
    emojiType: string,
    action: 'add' | 'delete',
  ): Promise<boolean> {
    const url =
      `/open-apis/drive/v2/files/${encodeURIComponent(target.fileToken)}/comments/reaction` +
      `?file_type=${encodeURIComponent(target.fileType)}`;
    try {
      await this.client.request({
        method: 'POST',
        url,
        data: { action, reply_id: replyId, reaction_type: emojiType },
      });
      this.logger.info?.(`channel: comment reaction ${action}`, {
        fileToken: target.fileToken,
        replyId,
      });
      return true;
    } catch (err) {
      this.logger.warn?.(`channel: comment reaction ${action} failed`, {
        fileToken: target.fileToken,
        replyId,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async findViaList(
    target: CommentTarget,
    commentId: string,
  ): Promise<CommentListItem | null> {
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = (await this.client.drive.v1.fileComment.list({
        params: {
          file_type: target.fileType,
          page_size: 100,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
        path: { file_token: target.fileToken },
      })) as CommentListResponse;
      const items = r?.data?.items ?? [];
      const hit = items.find((it) => it.comment_id === commentId);
      if (hit) return hit;
      if (!r?.data?.has_more || !r.data.page_token) break;
      pageToken = r.data.page_token;
    }
    return null;
  }
}
