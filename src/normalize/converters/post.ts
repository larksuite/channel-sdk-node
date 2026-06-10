import type { ResourceDescriptor } from '../../types';
import type { ContentConverterFn, ConvertContext, PostElement } from '../context';
import { applyStyle, safeParse, unwrapLocale } from '../utils';

interface PostBody {
    title?: string;
    content?: PostElement[][];
    content_v2?: PostElement[][];
}

const atMentionRe = /<at(\s+)user_id(\s*)=(\s*)"(.*?)">(.*?)<\/at>/g;
const imageKeyRe = /!\[(.*?)\]\(([^)]+)\)/g;

export const convertPost: ContentConverterFn = async (raw, ctx) => {
  const rawParsed = safeParse(raw);
  if (rawParsed == null || typeof rawParsed !== 'object') {
    return { content: '[rich text message]', resources: [] };
  }

  const body = unwrapLocale<PostBody>(rawParsed as Record<string, unknown>);
  if (!body) return { content: '[rich text message]', resources: [] };

  // Choose source paragraphs: prefer content_v2, fallback to content.
  const sourceParagraphs =
    (body.content_v2 && body.content_v2.length > 0)
        ? body.content_v2
        : (body.content ?? []);

  const resources: ResourceDescriptor[] = [];
  const lines: string[] = [];

  if (body.title) {
    lines.push(`**${body.title}**`);
    lines.push('');
  }

  for (const paragraph of sourceParagraphs) {
    if (!Array.isArray(paragraph)) continue;
    let line = '';
    for (const el of paragraph) {
      line += renderElement(el, ctx, resources);
    }
    lines.push(line);
  }

  const content = lines.join('\n').trim() || '[rich text message]';
  return { content, resources };
};

/**
 * Post-process raw markdown text from an "md" element.
 * Splits by fenced code block delimiters (```) and only applies
 * transformations to text outside of properly paired code blocks.
 * Unclosed fences are treated as outside-code-block text.
 */
function processMdText(text: string, resources: ResourceDescriptor[]): string {
    const parts = text.split('```');
    const total = parts.length;
    for (let i = 0; i < parts.length; i++) {
      // Odd-index segments are inside code blocks, UNLESS it's the last
      // segment of an even-length split (unclosed fence).
      let isInside = (i % 2 === 1);
      if (isInside && total % 2 === 0 && i === total - 1) {
          isInside = false;
      }
      if (!isInside) {
          // Outside code block: apply transformations.
          parts[i] = parts[i].replace(atMentionRe, (_match, _sp1, _sp2, _sp3, userId, name) => {
              if (userId === 'all' || userId === 'all_members') return '@all';
              return name ? `@${name}` : `@${userId}`;
          });
          // Extract image keys from ![...](key) patterns.
          let imgMatch: RegExpExecArray | null;
          imageKeyRe.lastIndex = 0;
          while ((imgMatch = imageKeyRe.exec(parts[i])) !== null) {
              if (imgMatch[2]) {
                  resources.push({ type: 'image', fileKey: imgMatch[2] });
              }
          }
      }
      // Inside code block: preserve as-is.
    }
    return parts.join('```');
}

function renderElement(
  el: PostElement,
  ctx: ConvertContext,
  resources: ResourceDescriptor[],
): string {
  switch (el.tag) {
    case 'text':
      return applyStyle(el.text ?? '', el.style);
    case 'a': {
      const label = el.text ?? el.href ?? '';
      return el.href ? `[${label}](${el.href})` : label;
    }
    case 'at': {
      const userId = el.user_id ?? '';
      if (userId === 'all' || userId === 'all_members') return '@all';
      // Prefer placeholder key so resolveMentions handles it uniformly
      const info = ctx.mentionsByOpenId.get(userId);
      if (info) return info.key;
      return el.user_name ? `@${el.user_name}` : `@${userId}`;
    }
    case 'img': {
      if (el.image_key) {
        resources.push({ type: 'image', fileKey: el.image_key });
        return `![image](${el.image_key})`;
      }
      return '';
    }
    case 'media': {
      if (el.file_key) {
        resources.push({ type: 'file', fileKey: el.file_key });
        return `<file key="${el.file_key}"/>`;
      }
      return '';
    }
    case 'code_block': {
      const lang = el.language ?? '';
      const code = el.text ?? '';
      return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
    }
    case 'hr':
      return '\n---\n';
    case 'md':
      return processMdText(el.text ?? '', resources);
    default:
      return el.text ?? '';
  }
}
