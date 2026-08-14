/**
 * Caption settling.
 *
 * Nothing on the wire says which send of a sentence is the final one, so
 * settling is a debounce: later sends of the same `sentence_id` overwrite
 * earlier ones, and the caller sees the sentence once it stops changing.
 *
 * Two ways to lose a caption, both silent, both covered below. Tearing the
 * session down while a sentence is still pending must flush it, not drop it
 * with the timer — the last thing anyone said before the meeting ended is
 * usually the part that mattered. And when the pending buffer hits its
 * ceiling, the oldest entry has to be pushed out to the caller rather than
 * discarded; a bound on memory is not a licence to lose data.
 */

import { TranscriptStabilizer } from '../stabilizer';
import { MEETING_ID } from './fixtures';

interface Settled {
  text: string;
  sentenceId?: string;
}

function transcript(sentenceId: string, text: string, endMs?: number): any {
  return {
    meetingId: MEETING_ID,
    actor: { id: 'ou_alice', name: 'Alice' },
    selfEcho: false,
    sentenceId,
    text,
    ...(endMs === undefined ? {} : { endMs }),
  };
}

function collector() {
  const settled: Settled[] = [];
  const onFlush = (e: Settled) => {
    settled.push({ text: e.text, sentenceId: e.sentenceId });
  };
  return { settled, onFlush };
}

describe('stabilizeMs: 0', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('every update goes straight through', async () => {
    const { settled, onFlush } = collector();
    const stabilizer = new TranscriptStabilizer({ stabilizeMs: 0, onFlush });

    stabilizer.push(transcript('s1', 'he'));
    stabilizer.push(transcript('s1', 'he said'));
    stabilizer.push(transcript('s1', 'he said hello'));
    await vi.advanceTimersByTimeAsync(0);

    expect(settled.map((s) => s.text)).toEqual(['he', 'he said', 'he said hello']);
  });
});

describe('stabilizeMs: 800', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a sentence still being updated stays pending, then settles once', async () => {
    const { settled, onFlush } = collector();
    const stabilizer = new TranscriptStabilizer({ stabilizeMs: 800, onFlush });

    stabilizer.push(transcript('s1', 'he'));
    await vi.advanceTimersByTimeAsync(500);
    stabilizer.push(transcript('s1', 'he said'));
    await vi.advanceTimersByTimeAsync(500);
    stabilizer.push(transcript('s1', 'he said hello'));

    // Each update restarts the window, so nothing has settled 500ms in.
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toEqual([]);

    await vi.advanceTimersByTimeAsync(300);
    expect(settled).toEqual([{ text: 'he said hello', sentenceId: 's1' }]);
  });

  test('separate sentences settle independently', async () => {
    const { settled, onFlush } = collector();
    const stabilizer = new TranscriptStabilizer({ stabilizeMs: 800, onFlush });

    stabilizer.push(transcript('s1', 'first sentence'));
    stabilizer.push(transcript('s2', 'second sentence'));
    await vi.advanceTimersByTimeAsync(800);

    expect(settled.map((s) => s.sentenceId)).toEqual(['s1', 's2']);
  });

  test('dispose() flushes what is still pending instead of dropping it', async () => {
    const { settled, onFlush } = collector();
    const stabilizer = new TranscriptStabilizer({ stabilizeMs: 800, onFlush });

    stabilizer.push(transcript('s1', 'the last thing anyone said'));
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toEqual([]);

    stabilizer.dispose();

    expect(settled).toEqual([{ text: 'the last thing anyone said', sentenceId: 's1' }]);
  });

  test('exceeding the pending ceiling flushes the oldest entry out, not away', async () => {
    const { settled, onFlush } = collector();
    const stabilizer = new TranscriptStabilizer({ stabilizeMs: 800, maxPending: 2, onFlush });

    stabilizer.push(transcript('s1', 'oldest'));
    stabilizer.push(transcript('s2', 'middle'));
    expect(settled).toEqual([]);

    stabilizer.push(transcript('s3', 'newest'));
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toEqual([{ text: 'oldest', sentenceId: 's1' }]);

    await vi.advanceTimersByTimeAsync(800);
    expect(settled.map((s) => s.sentenceId)).toEqual(['s1', 's2', 's3']);
  });
});

describe('a late send must not undo a newer one', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Two transports feed one session, and the probe's cursor can lag the push stream, so
  // an earlier version of a sentence can arrive last. Its text differs, so the duplicate
  // check does not suppress it — only `endMs` distinguishes the two.
  test('an older endMs is ignored, and does not restart the window either', async () => {
    const { settled, onFlush } = collector();
    const stabilizer = new TranscriptStabilizer({ stabilizeMs: 800, onFlush });

    stabilizer.push(transcript('s1', 'today we have three things', 5000));
    await vi.advanceTimersByTimeAsync(700);
    stabilizer.push(transcript('s1', 'today we have', 3000));

    // 100ms more completes the ORIGINAL window: a restarted timer would still be waiting.
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toEqual([{ text: 'today we have three things', sentenceId: 's1' }]);
  });

  test('a growing endMs still supersedes', async () => {
    const { settled, onFlush } = collector();
    const stabilizer = new TranscriptStabilizer({ stabilizeMs: 800, onFlush });

    stabilizer.push(transcript('s1', 'today we have', 3000));
    stabilizer.push(transcript('s1', 'today we have three things', 5000));
    await vi.advanceTimersByTimeAsync(800);

    expect(settled).toEqual([{ text: 'today we have three things', sentenceId: 's1' }]);
  });

  // A transcription fix rewrites a sentence without extending it, and may shorten it.
  test('an equal endMs keeps last-arrival-wins, so corrections land', async () => {
    const { settled, onFlush } = collector();
    const stabilizer = new TranscriptStabilizer({ stabilizeMs: 800, onFlush });

    stabilizer.push(transcript('s1', 'the room is on floor three', 5000));
    stabilizer.push(transcript('s1', 'the room is on floor 3', 5000));
    await vi.advanceTimersByTimeAsync(800);

    expect(settled).toEqual([{ text: 'the room is on floor 3', sentenceId: 's1' }]);
  });

  test('with no endMs on either side the rule is unchanged', async () => {
    const { settled, onFlush } = collector();
    const stabilizer = new TranscriptStabilizer({ stabilizeMs: 800, onFlush });

    stabilizer.push(transcript('s1', 'first'));
    stabilizer.push(transcript('s1', 'second'));
    await vi.advanceTimersByTimeAsync(800);

    expect(settled).toEqual([{ text: 'second', sentenceId: 's1' }]);
  });
});

describe('timers do not hold the process open', () => {
  // Real timers on purpose: the assertion is about the handle the runtime
  // hands back, and `unref` only exists on the real one.
  test('every timer the stabilizer creates is unref-ed', () => {
    const unrefCalls: boolean[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const realSetInterval = globalThis.setInterval;

    const track = (handle: any) => {
      const index = unrefCalls.push(false) - 1;
      const originalUnref = handle.unref?.bind(handle);
      handle.unref = () => {
        unrefCalls[index] = true;
        return originalUnref ? originalUnref() : handle;
      };
      return handle;
    };

    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((...args: any[]) => track((realSetTimeout as any)(...args))) as any);
    const intervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(((...args: any[]) => track((realSetInterval as any)(...args))) as any);

    try {
      const { onFlush } = collector();
      const stabilizer = new TranscriptStabilizer({ stabilizeMs: 800, onFlush });
      stabilizer.push(transcript('s1', 'pending'));
      stabilizer.push(transcript('s2', 'also pending'));
      stabilizer.dispose();

      expect(unrefCalls.length).toBeGreaterThan(0);
      expect(unrefCalls.every(Boolean)).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
      intervalSpy.mockRestore();
    }
  });
});
