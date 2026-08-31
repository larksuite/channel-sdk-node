import type { ConvertContext } from '../context';
import { convertAudio } from '../converters/audio';
import { convertUnknown } from '../converters/fallback';
import { convertFile } from '../converters/file';
import { convertImage } from '../converters/image';
import { convertLocation } from '../converters/location';
import { convertPost } from '../converters/post';
import { convertShareChat, convertShareUser } from '../converters/share';
import { convertSticker } from '../converters/sticker';
import { convertText } from '../converters/text';
import { convertVideo } from '../converters/video';
import { convertVideoChat } from '../converters/video-chat';

const ctx: ConvertContext = {
  messageId: 'om_x',
  mentions: new Map(),
  mentionsByOpenId: new Map(),
  stripBotMentions: true,
};

describe('simple converters', () => {
  test('text extracts .text', async () => {
    const r = await convertText('{"text":"hello"}', ctx);
    expect(r.content).toBe('hello');
    expect(r.resources).toEqual([]);
  });

  test('text missing field returns empty string', async () => {
    const r = await convertText('{}', ctx);
    expect(r.content).toBe('');
  });

  test('image renders Markdown + resource', async () => {
    const r = await convertImage('{"image_key":"img_v3_abc"}', ctx);
    expect(r.content).toBe('![image](img_v3_abc)');
    expect(r.resources).toEqual([{ type: 'image', fileKey: 'img_v3_abc' }]);
  });

  test('image missing key falls back to [image]', async () => {
    const r = await convertImage('{}', ctx);
    expect(r.content).toBe('[image]');
    expect(r.resources).toEqual([]);
  });

  test('file includes name attribute', async () => {
    const r = await convertFile('{"file_key":"f1","file_name":"doc.pdf"}', ctx);
    expect(r.content).toBe('<file key="f1" name="doc.pdf"/>');
    expect(r.resources[0].fileName).toBe('doc.pdf');
  });

  test('audio formats duration as "1.5s"', async () => {
    const r = await convertAudio('{"file_key":"a1","duration":1500}', ctx);
    expect(r.content).toBe('<audio key="a1" duration="1.5s"/>');
    expect(r.resources[0].durationMs).toBe(1500);
  });

  test('audio integer seconds shown without decimal', async () => {
    const r = await convertAudio('{"file_key":"a1","duration":1000}', ctx);
    expect(r.content).toBe('<audio key="a1" duration="1s"/>');
  });

  test('video includes name and duration', async () => {
    const r = await convertVideo('{"file_key":"v1","file_name":"clip.mp4","duration":30000}', ctx);
    expect(r.content).toBe('<video key="v1" name="clip.mp4" duration="30s"/>');
  });

  test('sticker minimal form', async () => {
    const r = await convertSticker('{"file_key":"s1"}', ctx);
    expect(r.content).toBe('<sticker key="s1"/>');
  });

  test('location with name and coords', async () => {
    const r = await convertLocation('{"name":"Cafe","latitude":"39.9","longitude":"116.4"}', ctx);
    expect(r.content).toBe('<location name="Cafe" coords="lat:39.9,lng:116.4"/>');
  });

  test('share_chat', async () => {
    const r = await convertShareChat('{"chat_id":"oc_abc"}', ctx);
    expect(r.content).toBe('<group_card id="oc_abc"/>');
  });

  test('share_user', async () => {
    const r = await convertShareUser('{"user_id":"ou_bob"}', ctx);
    expect(r.content).toBe('<contact_card id="ou_bob"/>');
  });

  test('video_chat includes meet_number from raw payload', async () => {
    const raw =
      '{"topic":"与 AI 开早会","meet_number":"976464587","start_time":"1780984497000","end_time":"1780985170000"}';
    const r = await convertVideoChat(raw, ctx);
    expect(r.content).toContain('📹 与 AI 开早会');
    expect(r.content).toContain('🔢 976464587');
  });

  test('video_chat without meet_number omits the line', async () => {
    const r = await convertVideoChat('{"topic":"sync"}', ctx);
    expect(r.content).toContain('📹 sync');
    expect(r.content).not.toContain('🔢');
  });
});

describe('fallback (unknown)', () => {
  test('extracts .text if present', async () => {
    const r = await convertUnknown('{"text":"fallback body"}', ctx);
    expect(r.content).toBe('fallback body');
  });

  test('otherwise returns [unsupported message]', async () => {
    const r = await convertUnknown('{"random":"data"}', ctx);
    expect(r.content).toBe('[unsupported message]');
  });

  test('handles bad JSON', async () => {
    const r = await convertUnknown('not-json', ctx);
    expect(r.content).toBe('[unsupported message]');
  });
});

describe('post converter', () => {
  test('plain title + paragraph', async () => {
    const raw = JSON.stringify({
      zh_cn: {
        title: 'Hello',
        content: [[{ tag: 'text', text: 'world' }]],
      },
    });
    const r = await convertPost(raw, ctx);
    expect(r.content).toContain('**Hello**');
    expect(r.content).toContain('world');
  });

  test('inline image becomes Markdown and adds resource', async () => {
    const raw = JSON.stringify({
      zh_cn: {
        content: [[{ tag: 'img', image_key: 'img_1' }]],
      },
    });
    const r = await convertPost(raw, ctx);
    expect(r.content).toContain('![image](img_1)');
    expect(r.resources).toContainEqual({ type: 'image', fileKey: 'img_1' });
  });

  test('at element uses placeholder key when reverse lookup hits', async () => {
    const ctxWithMention: ConvertContext = {
      ...ctx,
      mentionsByOpenId: new Map([
        ['ou_alice', { key: '@_user_1', openId: 'ou_alice', name: 'Alice', isBot: false }],
      ]),
    };
    const raw = JSON.stringify({
      zh_cn: {
        content: [[{ tag: 'at', user_id: 'ou_alice', user_name: 'Alice' }]],
      },
    });
    const r = await convertPost(raw, ctxWithMention);
    expect(r.content).toContain('@_user_1');
  });

  test('link tag renders as Markdown link', async () => {
    const raw = JSON.stringify({
      zh_cn: {
        content: [[{ tag: 'a', text: 'click', href: 'https://x.com' }]],
      },
    });
    const r = await convertPost(raw, ctx);
    expect(r.content).toContain('[click](https://x.com)');
  });

  test('style bold applied', async () => {
    const raw = JSON.stringify({
      zh_cn: {
        content: [[{ tag: 'text', text: 'strong', style: ['bold'] }]],
      },
    });
    const r = await convertPost(raw, ctx);
    expect(r.content).toContain('**strong**');
  });

  test('malformed post falls back to placeholder', async () => {
    const r = await convertPost('not json', ctx);
    expect(r.content).toBe('[rich text message]');
  });

  test('attachment zone renders files and folders', async () => {
    const raw = JSON.stringify({
      zh_cn: {
        title: '报告',
        content: [[{ tag: 'text', text: '正文' }]],
      },
      files: [
        { file_key: 'file_a', file_name: 'report.pdf' },
        { file_key: 'file_b' },
        { file_key: 'dir_1', file_name: 'assets', is_folder: true },
      ],
    });
    const r = await convertPost(raw, ctx);
    expect(r.content).toContain('**报告**');
    expect(r.content).toContain('正文');
    expect(r.content).toContain('<file key="file_a" name="report.pdf"/>');
    expect(r.content).toContain('<file key="file_b"/>');
    expect(r.content).toContain('<folder key="dir_1" name="assets"/>');
    // Files are downloadable resources; folders are tag-only.
    expect(r.resources).toContainEqual({ type: 'file', fileKey: 'file_a', fileName: 'report.pdf' });
    expect(r.resources).toContainEqual({ type: 'file', fileKey: 'file_b', fileName: undefined });
    expect(r.resources.filter((x) => x.type === 'file').length).toBe(2);
  });

  test('attachment zone ignores empty files array', async () => {
    const raw = JSON.stringify({
      zh_cn: { content: [[{ tag: 'text', text: 'hi' }]] },
      files: [],
    });
    const r = await convertPost(raw, ctx);
    expect(r.content).toContain('hi');
    expect(r.content).not.toContain('<file');
    expect(r.resources).toEqual([]);
  });

  test('attachment zone escapes key and handles non-string name', async () => {
    const raw = JSON.stringify({
      zh_cn: { content: [[{ tag: 'text', text: 'hi' }]] },
      files: [
        { file_key: 'file_a" onmouseover="x', file_name: 'r.pdf' },
        { file_key: 'file_b', file_name: 123 as unknown },
      ],
    });
    const r = await convertPost(raw, ctx);
    // key with a quote is escaped so it cannot forge attributes
    expect(r.content).toContain('<file key="file_a&quot; onmouseover=&quot;x" name="r.pdf"/>');
    // non-string file_name degrades to no name attribute, no throw
    expect(r.content).toContain('<file key="file_b"/>');
    expect(r.resources).toContainEqual({ type: 'file', fileKey: 'file_a" onmouseover="x', fileName: 'r.pdf' });
    expect(r.resources).toContainEqual({ type: 'file', fileKey: 'file_b', fileName: undefined });
  });
});
