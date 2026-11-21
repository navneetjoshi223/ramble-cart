export interface MicLevelSnapshot {
  /** Normalized overall microphone loudness in [0, 1] */
  volume: number;
  /** True when vocal/sound energy exceeds ambient noise floor */
  isSpeaking: boolean;
  /** Five normalized [0, 1] speech-band equalizer levels */
  bands: [number, number, number, number, number];
}

const NOISE_FLOOR = 0.018;
const SPEAKING_THRESHOLD = 0.08;

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function averageSlice(data: Uint8Array, startIdx: number, endIdx: number): number {
  const safeStart = Math.max(0, Math.min(data.length - 1, startIdx));
  const safeEnd = Math.max(safeStart + 1, Math.min(data.length, endIdx));
  let sum = 0;
  let count = 0;
  for (let i = safeStart; i < safeEnd; i++) {
    sum += data[i];
    count++;
  }
  return count > 0 ? sum / (count * 255) : 0;
}

/**
 * Computes perceptual voice loudness (RMS) and 5 speech-weighted equalizer bands
 * from Web Audio API AnalyserNode time-domain and frequency byte buffers.
 */
export function computeMicLevels(
  timeDomainData: Uint8Array,
  frequencyData: Uint8Array,
): MicLevelSnapshot {
  let sumSquares = 0;
  for (let i = 0; i < timeDomainData.length; i++) {
    const centered = (timeDomainData[i] - 128) / 128;
    sumSquares += centered * centered;
  }
  const rms =
    timeDomainData.length > 0 ? Math.sqrt(sumSquares / timeDomainData.length) : 0;

  const gatedRms = rms <= NOISE_FLOOR ? 0 : (rms - NOISE_FLOOR) / (0.35 - NOISE_FLOOR);
  const rmsVolume = clamp01(Math.pow(Math.max(0, gatedRms), 0.72));

  // Partition frequency bins (for fftSize = 128 -> 64 bins, ~375Hz/bin at 48kHz)
  // focusing on fundamental voice & speech formants (bins 1..22)
  const binCount = frequencyData.length;
  const b0 = averageSlice(frequencyData, 1, Math.max(2, Math.floor(binCount * 0.06)));
  const b1 = averageSlice(
    frequencyData,
    Math.max(1, Math.floor(binCount * 0.05)),
    Math.max(3, Math.floor(binCount * 0.11)),
  );
  const b2 = averageSlice(
    frequencyData,
    Math.max(2, Math.floor(binCount * 0.09)),
    Math.max(5, Math.floor(binCount * 0.18)),
  );
  const b3 = averageSlice(
    frequencyData,
    Math.max(4, Math.floor(binCount * 0.16)),
    Math.max(8, Math.floor(binCount * 0.28)),
  );
  const b4 = averageSlice(
    frequencyData,
    Math.max(6, Math.floor(binCount * 0.25)),
    Math.max(12, Math.floor(binCount * 0.42)),
  );

  const freqPeak = Math.max(b0, b1, b2, b3, b4);
  const combinedVolume = clamp01(Math.max(rmsVolume, freqPeak * 1.15));

  if (combinedVolume < 0.02) {
    return {
      volume: 0,
      isSpeaking: false,
      bands: [0, 0, 0, 0, 0],
    };
  }

  // Blend real per-band spectral energy with overall RMS envelope and a natural
  // vocal formant contour so quiet, conversational, and loud speech produce
  // distinct, organic bar heights rather than uniform flat-clipping.
  const bands: [number, number, number, number, number] = [
    clamp01((b0 * 1.15 + rmsVolume * 0.32) * 0.72),
    clamp01((b1 * 1.25 + rmsVolume * 0.52) * 0.9),
    clamp01(b2 * 1.35 + rmsVolume * 0.72),
    clamp01((b3 * 1.25 + rmsVolume * 0.48) * 0.86),
    clamp01((b4 * 1.2 + rmsVolume * 0.28) * 0.68),
  ];

  return {
    volume: combinedVolume,
    isSpeaking: combinedVolume >= SPEAKING_THRESHOLD,
    bands,
  };
}

/**
 * Applies asymmetric attack/release smoothing for responsive, non-jittery bar motion.
 */
export function smoothLevel(
  previous: number,
  target: number,
  attack = 0.58,
  release = 0.22,
): number {
  const factor = target > previous ? attack : release;
  return clamp01(previous + (target - previous) * factor);
}
