import { describe, expect, it } from "vitest";
import { extractLatestSpeechUtterance } from "../src/utils/speechTranscript";

describe("Live Web Speech API utterance streaming & replacement", () => {
  it("streams interim words live as the user speaks", () => {
    const step1 = extractLatestSpeechUtterance({
      results: [{ isFinal: false, 0: { transcript: "I need a" } }],
      offset: 0,
      committedInterimIndex: -1,
    });
    expect(step1.utterance).toBe("I need a");
    expect(step1.lastIsFinal).toBe(false);

    const step2 = extractLatestSpeechUtterance({
      results: [{ isFinal: false, 0: { transcript: "I need a matte black monitor stand" } }],
      offset: 0,
      committedInterimIndex: -1,
    });
    expect(step2.utterance).toBe("I need a matte black monitor stand");

    const step3 = extractLatestSpeechUtterance({
      results: [{ isFinal: true, 0: { transcript: "I need a matte black monitor stand" } }],
      offset: 0,
      committedInterimIndex: -1,
    });
    expect(step3.utterance).toBe("I need a matte black monitor stand");
    expect(step3.finalizedEndIndex).toBe(1);
    expect(step3.lastIsFinal).toBe(true);
  });

  it("replaces input with the fresh utterance after a pause when prior result was final", () => {
    const first = extractLatestSpeechUtterance({
      results: [{ isFinal: true, 0: { transcript: "ceramic coffee dripper" } }],
      offset: 0,
      committedInterimIndex: -1,
    });
    expect(first.utterance).toBe("ceramic coffee dripper");

    const second = extractLatestSpeechUtterance({
      results: [
        { isFinal: true, 0: { transcript: "ceramic coffee dripper" } },
        { isFinal: false, 0: { transcript: "matte black kettle under 60" } },
      ],
      offset: first.finalizedEndIndex,
      committedInterimIndex: -1,
    });
    expect(second.utterance).toBe("matte black kettle under 60");
  });

  it("handles pause auto-search firing while the last result is still interim, then replaces on next utterance", () => {
    const finalizeEcho = extractLatestSpeechUtterance({
      results: [{ isFinal: true, 0: { transcript: "brass desk lamp" } }],
      offset: 0,
      committedInterimIndex: 0,
    });
    expect(finalizeEcho.utterance).toBeNull();
    expect(finalizeEcho.nextOffset).toBe(1);
    expect(finalizeEcho.nextCommittedInterimIndex).toBe(-1);

    const newUtterance = extractLatestSpeechUtterance({
      results: [
        { isFinal: false, 0: { transcript: "brass desk lamp" } },
        { isFinal: false, 0: { transcript: "actually make that matte black" } },
      ],
      offset: 0,
      committedInterimIndex: 0,
    });
    expect(newUtterance.utterance).toBe("actually make that matte black");
    expect(newUtterance.nextOffset).toBe(1);
    expect(newUtterance.nextCommittedInterimIndex).toBe(-1);
  });
});
