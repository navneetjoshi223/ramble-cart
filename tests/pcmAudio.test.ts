import { describe, expect, it } from "vitest";
import {
  applyLiveTranscriptionChunk,
  downsampleFloat32ToPcm16,
  downsampleFloat32ToPcm16Base64,
  type LiveTranscriptState,
} from "../src/utils/pcmAudio";

describe("Gemini Live 16kHz PCM audio downsampler & live transcript accumulator", () => {
  it("downsamples 48kHz mono Float32 samples cleanly to 16kHz Int16 PCM", () => {
    // 480 samples at 48kHz = 10ms -> 160 samples at 16kHz
    const input = new Float32Array(480);
    for (let i = 0; i < input.length; i++) {
      input[i] = 0.5;
    }
    const pcm = downsampleFloat32ToPcm16(input, 48000, 16000);
    expect(pcm.length).toBe(160);
    expect(pcm[0]).toBeGreaterThan(16000);
    expect(pcm[0]).toBeLessThan(16500);

    const b64 = downsampleFloat32ToPcm16Base64(input, 48000, 16000);
    expect(b64.length).toBeGreaterThan(100);
  });

  it("streams interim and final chunks live on the fly and replaces cleanly after a pause", () => {
    let state: LiveTranscriptState = {
      finalizedText: "",
      interimText: "",
      displayText: "",
      replaceOnNextSpeech: false,
    };

    state = applyLiveTranscriptionChunk(state, {
      type: "interim",
      text: "I need a matte black",
    });
    expect(state.displayText).toBe("I need a matte black");

    state = applyLiveTranscriptionChunk(state, {
      type: "final",
      text: "I need a matte black monitor stand",
    });
    expect(state.displayText).toBe("I need a matte black monitor stand");
    expect(state.interimText).toBe("");

    // Simulate 1.4s pause committing the utterance
    state = { ...state, replaceOnNextSpeech: true };

    state = applyLiveTranscriptionChunk(state, {
      type: "interim",
      text: "under 50 dollars",
    });
    expect(state.displayText).toBe("under 50 dollars");
    expect(state.replaceOnNextSpeech).toBe(false);
  });
});
