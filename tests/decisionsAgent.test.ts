import { describe, expect, it, vi } from "vitest";
import {
  evaluateShoppingDecision,
  type DecisionsClientLike,
} from "../server/decisionsAgent";

describe("Gemini Decisions API agent router (gemini-decision-1)", () => {
  it("prevents premature catalog search when user pauses mid-sentence on speech_pause", async () => {
    const createSpy = vi.fn().mockResolvedValue({
      answers: {
        is_still_speaking: { type: "noul", noul: 0.91, confidence: 0.91 },
        should_update_wishlist: { type: "noul", noul: 0.18, confidence: 0.82 },
        is_constraint_correction: { type: "noul", noul: 0.04, confidence: 0.96 },
        is_visual_context_sufficient: { type: "noul", noul: 0.72, confidence: 0.72 },
        needs_calibration_or_measurements: { type: "noul", noul: 0.08, confidence: 0.92 },
        should_search_now: { type: "noul", noul: 0.12, confidence: 0.88 },
        search_readiness: {
          type: "score",
          score: 0.25,
          confidence: 0.85,
          legend: {
            "0": "Incomplete fragment, silence, or filler speech with no shopping intent yet.",
          },
          probabilities: { "0": 0.8, "1": 0.15, "2": 0.04, "3": 0.01 },
        },
        recommended_action: {
          type: "choice",
          choice: "CONTINUE_LISTENING",
          confidence: 0.89,
          probabilities: {
            CONTINUE_LISTENING: 0.89,
            CLARIFY_REQUIREMENT: 0.07,
            SEARCH_PRODUCTS: 0.04,
          },
        },
      },
      usage: { total_output_tokens: 0 },
    });

    const mockClient: DecisionsClientLike = { decisions: { create: createSpy } };

    const result = await evaluateShoppingDecision(
      {
        rambleText: "Um maybe something around...",
        triggerSource: "speech_pause",
        videoFrames: ["ZmFrZWpwZWc="],
      },
      mockClient,
    );

    expect(createSpy).toHaveBeenCalledOnce();
    const callArg = createSpy.mock.calls[0][0];
    expect(callArg.model).toBe("gemini-decision-1");
    expect(Array.isArray(callArg.input)).toBe(true);
    expect(callArg.input[1]).toEqual({
      type: "image",
      data: "ZmFrZWpwZWc=",
      mime_type: "image/jpeg",
      resolution: "low",
    });

    expect(result.model).toBe("gemini-decision-1");
    expect(result.action).toBe("CONTINUE_LISTENING");
    expect(result.shouldSearch).toBe(false);
    expect(result.isStillSpeaking).toBe(true);
    expect(result.totalOutputTokens).toBe(0);
  });

  it("routes mid-sentence corrections to REPLACE_CONSTRAINT and enables search", async () => {
    const mockClient: DecisionsClientLike = {
      decisions: {
        create: vi.fn().mockResolvedValue({
          answers: {
            is_still_speaking: { type: "noul", noul: 0.06, confidence: 0.94 },
            should_update_wishlist: { type: "noul", noul: 0.95, confidence: 0.95 },
            is_constraint_correction: { type: "noul", noul: 0.93, confidence: 0.93 },
            is_visual_context_sufficient: { type: "noul", noul: 0.86, confidence: 0.86 },
            needs_calibration_or_measurements: { type: "noul", noul: 0.14, confidence: 0.86 },
            should_search_now: { type: "noul", noul: 0.94, confidence: 0.94 },
            search_readiness: {
              type: "score",
              score: 2.85,
              confidence: 0.9,
              legend: {
                "3": "Specific product category with concrete budget, material, color, exclusion, or spatial constraints ready for search and verification.",
              },
              probabilities: { "0": 0.01, "1": 0.02, "2": 0.09, "3": 0.88 },
            },
            recommended_action: {
              type: "choice",
              choice: "REPLACE_CONSTRAINT",
              confidence: 0.84,
              probabilities: {
                REPLACE_CONSTRAINT: 0.84,
                VERIFY_PRODUCTS: 0.11,
                SEARCH_PRODUCTS: 0.05,
              },
            },
          },
          usage: { total_output_tokens: 0 },
        }),
      },
    };

    const result = await evaluateShoppingDecision(
      {
        rambleText: "Actually, forget wood. Make it matte black metal under $50.",
        triggerSource: "speech_pause",
        previousContext: {
          searchQuery: "wood monitor stand",
          maxPriceUsd: 80,
          activeConstraints: [{ text: "wood", kind: "preferred" }],
        },
      },
      mockClient,
    );

    expect(result.action).toBe("REPLACE_CONSTRAINT");
    expect(result.isConstraintCorrection).toBe(true);
    expect(result.shouldSearch).toBe(true);
    expect(result.readinessScore).toBeGreaterThan(2.5);
  });

  it("propagates errors cleanly when Decisions API blocks input without fabricating fallbacks", async () => {
    const mockClient: DecisionsClientLike = {
      decisions: {
        create: vi.fn().mockResolvedValue({
          prompt_feedback: { block_reason: "safety" },
        }),
      },
    };

    await expect(
      evaluateShoppingDecision(
        { rambleText: "test blocked input", triggerSource: "manual_submit" },
        mockClient,
      ),
    ).rejects.toThrow("Gemini Decisions API blocked the input (safety).");
  });
});
