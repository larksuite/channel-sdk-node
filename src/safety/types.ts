import type { NormalizedMessage, RejectEvent, SafetyConfig } from '../types';

export interface BatchConfig {
  delayMs: number;
  longThresholdChars: number;
  longDelayMs: number;
  maxMessages: number;
  maxChars: number;
  /** Accumulate messages arriving while a flush is in-flight and emit them
   *  as one batch when it drains. See SafetyConfig.chatQueue.mergeWhileBusy. */
  mergeWhileBusy: boolean;
}

export const DEFAULT_BATCH: BatchConfig = {
  delayMs: 600,
  longThresholdChars: 1000,
  longDelayMs: 2000,
  maxMessages: 8,
  maxChars: 4000,
  mergeWhileBusy: false,
};

export const DEFAULT_DEDUP = {
  ttl: 12 * 3600_000,
  maxEntries: 5000,
  sweepIntervalMs: 5 * 60_000,
  namespace: 'channel:seen',
} as const;

export const DEFAULT_STALE_MS = 30 * 60_000;
export const DEFAULT_LOCK_TTL_MS = 5 * 60_000;

export interface BatchedDispatch {
  message: NormalizedMessage;
  sourceIds: string[];
}

export type OnReject = (evt: RejectEvent) => void;
export type OnMessageDispatch = (merged: NormalizedMessage) => Promise<void>;

export function resolveBatchConfig(cfg?: SafetyConfig): BatchConfig {
  const t = cfg?.batch?.text ?? {};
  return {
    delayMs: t.delayMs ?? DEFAULT_BATCH.delayMs,
    longThresholdChars: t.longThresholdChars ?? DEFAULT_BATCH.longThresholdChars,
    longDelayMs: t.longDelayMs ?? DEFAULT_BATCH.longDelayMs,
    maxMessages: t.maxMessages ?? DEFAULT_BATCH.maxMessages,
    maxChars: t.maxChars ?? DEFAULT_BATCH.maxChars,
    mergeWhileBusy: cfg?.chatQueue?.mergeWhileBusy ?? DEFAULT_BATCH.mergeWhileBusy,
  };
}

export type CardActionQueueMode = NonNullable<
  NonNullable<SafetyConfig['chatQueue']>['cardActions']
>;

const CARD_ACTION_QUEUE_MODES: readonly CardActionQueueMode[] = ['same', 'separate'];

/**
 * `undefined` is the silent default. Anything outside the accepted set falls
 * back to `'same'` and is flagged, so the pipeline can warn once instead of
 * refusing to start over a typo.
 */
export function resolveCardActionQueueMode(value: unknown): {
  mode: CardActionQueueMode;
  unrecognized: boolean;
} {
  if (value === undefined) return { mode: 'same', unrecognized: false };
  if (isCardActionQueueMode(value)) return { mode: value, unrecognized: false };
  return { mode: 'same', unrecognized: true };
}

function isCardActionQueueMode(value: unknown): value is CardActionQueueMode {
  return (CARD_ACTION_QUEUE_MODES as readonly unknown[]).includes(value);
}
