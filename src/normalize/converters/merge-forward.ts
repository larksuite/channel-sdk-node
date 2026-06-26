import type { ResourceDescriptor } from '../../types';
import type { ApiMessageItem, ContentConverterFn, ConvertContext } from '../context';
import { formatRFC3339Beijing, indentLines } from '../utils';

const MAX_ITEMS = 50;

// Internal render result: a sub-item's rendered text plus the resources it (and
// any descendants) carry, each already stamped with its owning message id.
interface RenderedItem {
  content: string;
  resources: ResourceDescriptor[];
}

export const convertMergeForward: ContentConverterFn = async (_raw, ctx) => {
  const { messageId, fetchSubMessages, dispatch } = ctx;

  if (!fetchSubMessages || !dispatch) {
    return { content: '<forwarded_messages/>', resources: [] };
  }

  let items: ApiMessageItem[];
  try {
    items = await fetchSubMessages(messageId);
  } catch {
    return { content: '<forwarded_messages/>', resources: [] };
  }

  if (!items || items.length === 0) {
    return { content: '<forwarded_messages/>', resources: [] };
  }

  const capped = items.slice(0, MAX_ITEMS);
  const truncated = items.length > MAX_ITEMS;

  // Pre-warm sender name cache in one batch call.
  if (ctx.batchResolveNames) {
    const senderIds = new Set<string>();
    for (const it of capped) {
      const sid = it.sender?.id;
      if (sid && it.message_id !== messageId) senderIds.add(sid);
    }
    if (senderIds.size > 0) {
      try {
        await ctx.batchResolveNames([...senderIds]);
      } catch {
        // best effort
      }
    }
  }

  const childrenMap = buildChildrenMap(capped, messageId);
  const { content, resources } = await formatSubTree(messageId, childrenMap, ctx, truncated);
  return { content, resources };
};

function buildChildrenMap(items: ApiMessageItem[], rootId: string): Map<string, ApiMessageItem[]> {
  const map = new Map<string, ApiMessageItem[]>();
  for (const it of items) {
    if (it.message_id === rootId && !it.upper_message_id) continue;
    const pid = it.upper_message_id ?? rootId;
    let arr = map.get(pid);
    if (!arr) {
      arr = [];
      map.set(pid, arr);
    }
    arr.push(it);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => {
      const ta = parseInt(String(a.create_time ?? '0'), 10);
      const tb = parseInt(String(b.create_time ?? '0'), 10);
      return ta - tb;
    });
  }
  return map;
}

async function formatSubTree(
  parentId: string,
  map: Map<string, ApiMessageItem[]>,
  ctx: ConvertContext,
  truncated = false,
): Promise<RenderedItem> {
  const children = map.get(parentId);
  if (!children || children.length === 0) {
    return { content: '<forwarded_messages/>', resources: [] };
  }

  const parts: string[] = [];
  const resources: ResourceDescriptor[] = [];
  for (const item of children) {
    try {
      const sub = await renderItem(item, map, ctx);
      if (sub.content) parts.push(sub.content);
      resources.push(...sub.resources);
    } catch {
      // skip bad item
    }
  }

  if (parts.length === 0) return { content: '<forwarded_messages/>', resources };
  const body = parts.join('\n');
  const footer = truncated ? '\n... (truncated)' : '';
  return { content: `<forwarded_messages>\n${body}${footer}\n</forwarded_messages>`, resources };
}

async function renderItem(
  item: ApiMessageItem,
  map: Map<string, ApiMessageItem[]>,
  ctx: ConvertContext,
): Promise<RenderedItem> {
  const msgType = item.msg_type ?? 'text';
  const senderId = item.sender?.id ?? 'unknown';
  const createMs = parseInt(String(item.create_time ?? '0'), 10);
  const timestamp = createMs > 0 ? formatRFC3339Beijing(createMs) : 'unknown';
  const displayName = ctx.resolveUserName?.(senderId) ?? senderId;

  let content: string;
  let resources: ResourceDescriptor[] = [];
  if (msgType === 'merge_forward') {
    // Nested forward — recurse locally without another API call. Descendant
    // resources already carry their own (innermost) sourceMessageId.
    const nestedId = item.message_id;
    if (nestedId) {
      const sub = await formatSubTree(nestedId, map, ctx);
      content = sub.content;
      resources = sub.resources;
    } else {
      content = '<forwarded_messages/>';
    }
  } else {
    const rawContent = item.body?.content ?? '{}';
    if (!ctx.dispatch) {
      content = rawContent;
    } else {
      const r = await ctx.dispatch(rawContent, msgType, ctx);
      content = r.content;
      // Bubble the sub-message's own resources up so the caller can download
      // them. Feishu's messageResource.get accepts the top-level merge_forward
      // container id (= NormalizedMessage.messageId) for these — verified
      // against a real forward — so no per-resource owning id is needed.
      resources = r.resources;
    }
  }

  const indented = indentLines(content, '    ');
  return { content: `[${timestamp}] ${displayName}:\n${indented}`, resources };
}
