import { describe, expect, it } from "vitest";
import { computeMicLevels, smoothLevel } from "../src/utils/micAudioMath";

describe("Web Audio API microphone volume indicator math", () => {
  it("returns zero volume and resting bands for silence (128 centered PCM & zero spectrum)", () => {
    const silentTime = new Uint8Array(128).fill(128);
    const silentFreq = new Uint8Array(64).fill(0);

    const snapshot = computeMicLevels(silentTime, silentFreq);
    expect(snapshot.volume).toBe(0);
    expect(snapshot.isSpeaking).toBe(false);
    expect(snapshot.bands).toEqual([0, 0, 0, 0, 0]);
  });

  it("ignores tiny ambient room noise below the noise floor", () => {
    const lowNoiseTime = new Uint8Array(128);
    for (let i = 0; i < lowNoiseTime.length; i++) {
      lowNoiseTime[i] = i % 2 === 0 ? 129 : 127;
    }
    const lowNoiseFreq = new Uint8Array(64).fill(2);

    const snapshot = computeMicLevels(lowNoiseTime, lowNoiseFreq);
    expect(snapshot.volume).toBe(0);
    expect(snapshot.isSpeaking).toBe(false);
  });

  it("detects active speech loudness and populates all 5 equalizer bands", () => {
    const voiceTime = new Uint8Array(128);
    for (let i = 0; i < voiceTime.length; i++) {
      const sample = Math.sin((i / 16) * Math.PI * 2) * 52;
      voiceTime[i] = Math.round(128 + sample);
    }

    const voiceFreq = new Uint8Array(64).fill(12);
    // Simulate vocal fundamentals and speech formants across bins 2..18
    for (let b = 2; b <= 18; b++) {
      voiceFreq[b] = 175;
    }

    const snapshot = computeMicLevels(voiceTime, voiceFreq);
    expect(snapshot.volume).toBeGreaterThan(0.5);
    expect(snapshot.isSpeaking).toBe(true);
    for (const band of snapshot.bands) {
      expect(band).toBeGreaterThan(0.35);
      expect(band).toBeLessThanOrEqual(1);
    }
  });

  it("applies faster attack than release for responsive voice meter motion", () => {
    const attacked = smoothLevel(0, 0.8);
    const released = smoothLevel(0.8, 0);

    expect(attacked).toBeGreaterThan(0.4);
    expect(released).toBeGreaterThan(0.55); // gentle decay rather than abrupt drop
  });
});
