/**
 * Downsamples mono Float32 Web Audio samples from `inputSampleRate` (e.g. 48000 or 44100 Hz)
 * to 16kHz signed 16-bit little-endian PCM and encodes as base64 for Gemini Live API.
 */
export function downsampleFloat32ToPcm16(
  input: Float32Array,
  inputSampleRate: number,
  targetSampleRate = 16000,
): Int16Array {
  if (input.length === 0 || !Number.isFinite(inputSampleRate) || inputSampleRate <= 0) {
    return new Int16Array(0);
  }

  if (Math.round(inputSampleRate) === targetSampleRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const clamped = Math.max(-1, Math.min(1, input[i]));
      out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    }
    return out;
  }

  const ratio = inputSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outputLength);

  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < outputLength) {
    const nextOffsetBuffer = Math.min(
      input.length,
      Math.round((offsetResult + 1) * ratio),
    );
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i++) {
      accum += input[i];
      count++;
    }
    const sample = count > 0 ? accum / count : input[Math.min(offsetBuffer, input.length - 1)] ?? 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[offsetResult] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return out;
}

export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function downsampleFloat32ToPcm16Base64(
  input: Float32Array,
  inputSampleRate: number,
  targetSampleRate = 16000,
): string {
  const pcm = downsampleFloat32ToPcm16(input, inputSampleRate, targetSampleRate);
  return pcm.length > 0 ? pcm16ToBase64(pcm) : "";
}

export interface LiveTranscriptState {
  /** Accumulated finalized text for the current utterance */
  finalizedText: string;
  /** Live in-progress interim text for the current utterance */
  interimText: string;
  /** Combined display text shown in the input box */
  displayText: string;
  /** When true (after a speech pause auto-search), the next spoken text replaces the utterance */
  replaceOnNextSpeech: boolean;
}

function joinSegments(a: string, b: string): string {
  const left = a.trimEnd();
  const right = b.trim();
  if (!left) return right;
  if (!right) return left;
  // Avoid inserting a space before punctuation
  if (/^[,.;:!?']/.test(right)) {
    return `${left}${right}`;
  }
  return `${left} ${right}`;
}

/**
 * Merges streaming `interim` and `final` chunks from Gemini Live transcription
 * (`gemini-3.5-transcribe-live`), supporting clean utterance replacement after pauses.
 */
export function applyLiveTranscriptionChunk(
  prev: LiveTranscriptState,
  chunk: { type: "interim" | "final"; text: string },
): LiveTranscriptState {
  const incoming = chunk.text.replace(/\s+/g, " ").trim();
  if (!incoming) {
    return prev;
  }

  let finalizedText = prev.replaceOnNextSpeech ? "" : prev.finalizedText;
  let interimText = prev.replaceOnNextSpeech ? "" : prev.interimText;

  if (chunk.type === "final") {
    finalizedText = joinSegments(finalizedText, incoming);
    interimText = "";
  } else {
    interimText = incoming;
  }

  const displayText = joinSegments(finalizedText, interimText).trim();

  return {
    finalizedText,
    interimText,
    displayText,
    replaceOnNextSpeech: false,
  };
}
