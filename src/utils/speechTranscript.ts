export interface SpeechResultItemLike {
  isFinal?: boolean;
  0?: { transcript?: string };
}

export interface SpeechTranscriptStepInput {
  results: ArrayLike<SpeechResultItemLike>;
  offset: number;
  committedInterimIndex: number;
}

export interface SpeechTranscriptStepOutput {
  /** Latest spoken utterance text from the active offset onward, or null if no new speech */
  utterance: string | null;
  /** Updated offset (advances if a previously committed interim result just finalized) */
  nextOffset: number;
  /** Updated committed interim index (-1 once resolved or superseded by newer results) */
  nextCommittedInterimIndex: number;
  /** Highest index in `results` that was finalized (contiguous from offset) */
  finalizedEndIndex: number;
  /** Last index present in `results`, or -1 if empty */
  lastResultIndex: number;
  /** Whether the last included result is marked final */
  lastIsFinal: boolean;
}

/**
 * Joins Web Speech API results starting at `offset`, replacing stale pre-pause
 * utterances cleanly while preserving smooth interim + final streaming.
 */
export function extractLatestSpeechUtterance(
  input: SpeechTranscriptStepInput,
): SpeechTranscriptStepOutput {
  const len = input.results.length;
  let offset = Math.max(0, Math.min(input.offset, len));
  let committedIdx = input.committedInterimIndex;

  if (len === 0) {
    return {
      utterance: null,
      nextOffset: 0,
      nextCommittedInterimIndex: -1,
      finalizedEndIndex: 0,
      lastResultIndex: -1,
      lastIsFinal: false,
    };
  }

  if (committedIdx >= offset && committedIdx < len) {
    if (len > committedIdx + 1) {
      offset = committedIdx + 1;
      committedIdx = -1;
    } else if (input.results[committedIdx]?.isFinal) {
      offset = committedIdx + 1;
      committedIdx = -1;
      return {
        utterance: null,
        nextOffset: offset,
        nextCommittedInterimIndex: -1,
        finalizedEndIndex: offset,
        lastResultIndex: len - 1,
        lastIsFinal: true,
      };
    } else {
      return {
        utterance: null,
        nextOffset: offset,
        nextCommittedInterimIndex: committedIdx,
        finalizedEndIndex: offset,
        lastResultIndex: len - 1,
        lastIsFinal: false,
      };
    }
  }

  let text = "";
  let finalizedEndIndex = offset;
  let stillContiguousFinal = true;

  for (let i = offset; i < len; i++) {
    const item = input.results[i];
    const chunk = item?.[0]?.transcript ?? "";
    if (chunk) {
      if (text && !text.endsWith(" ") && !chunk.startsWith(" ")) {
        text += " ";
      }
      text += chunk;
    }
    if (stillContiguousFinal && item?.isFinal) {
      finalizedEndIndex = i + 1;
    } else {
      stillContiguousFinal = false;
    }
  }

  const cleaned = text.trim();
  const lastIsFinal = Boolean(input.results[len - 1]?.isFinal);

  return {
    utterance: cleaned || null,
    nextOffset: offset,
    nextCommittedInterimIndex: committedIdx,
    finalizedEndIndex,
    lastResultIndex: len - 1,
    lastIsFinal,
  };
}
