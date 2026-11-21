import { GoogleGenAI } from "@google/genai";
import type {
  DecisionAction,
  DecisionTriggerSource,
  PreviousSessionContext,
  ShoppingDecisionResult,
} from "../src/types.js";

const VALID_DECISION_ACTIONS = new Set<DecisionAction>([
  "CONTINUE_LISTENING",
  "UPDATE_CONSTRAINTS",
  "REPLACE_CONSTRAINT",
  "REMOVE_CONSTRAINT",
  "OBSERVE_SPACE",
  "REQUEST_ANOTHER_ANGLE",
  "REQUEST_CALIBRATION",
  "REQUEST_MEASUREMENTS",
  "CLARIFY_REQUIREMENT",
  "SEARCH_PRODUCTS",
  "VERIFY_PRODUCTS",
  "REFINE_SEARCH",
  "PRESENT_RESULTS",
]);

const READINESS_RUBRIC = [
  "Incomplete fragment, silence, or filler speech with no shopping intent yet.",
  "Ambiguous room question or unclear target requiring another camera angle, calibration, or clarification.",
  "Clear product category or functional problem ready for Shopify catalog discovery.",
  "Specific product category with concrete budget, material, color, exclusion, or spatial constraints ready for search and verification.",
];

const ACTION_CRITERIA: { [key: string]: string } = {
  CLARIFY_REQUIREMENT:
    "Ask a concise clarification because the spoken request is too vague to identify a product category.",
  CONTINUE_LISTENING:
    "Keep listening without searching because the user stopped mid-sentence or uttered filler words.",
  OBSERVE_SPACE:
    "Ask the user to start or aim their camera because they said 'here' or 'this space' with no camera frames.",
  PRESENT_RESULTS:
    "Keep existing search results displayed because nothing material changed in the scene or request.",
  REFINE_SEARCH:
    "Re-run catalog search with narrowed criteria such as a lower budget, new style, or updated attribute.",
  REMOVE_CONSTRAINT:
    "Lift or remove a previously active restriction or exclusion that the user cancelled.",
  REPLACE_CONSTRAINT:
    "Replace an earlier material, color, style, or price preference after a user self-correction.",
  REQUEST_ANOTHER_ANGLE:
    "Ask the user to pan or show another camera angle because visibility of the target space is poor.",
  REQUEST_CALIBRATION:
    "Prompt the user to place a credit-card or Letter-paper reference in view to calibrate physical fit.",
  REQUEST_MEASUREMENTS:
    "Ask for approximate width, height, or depth measurements when verifying tight physical fit.",
  SEARCH_PRODUCTS:
    "Run a fresh Shopify catalog search for a newly stated product category or functional problem.",
  UPDATE_CONSTRAINTS:
    "Add newly stated requirements or preferences to the active wishlist and refresh search.",
  VERIFY_PRODUCTS:
    "Search and verify products against explicit hard constraints such as max price, required material, or exclusions.",
  other: "Any input outside the shopping actions above.",
};

export interface DecisionsClientLike {
  decisions: {
    create: (params: Record<string, unknown>) => Promise<{
      answers?: Record<string, unknown>;
      prompt_feedback?: { block_reason?: string };
      usage?: { total_output_tokens?: number };
    }>;
  };
}

export function createDecisionsClient(apiKey: string): DecisionsClientLike {
  // Decisions API requires @google/genai >= 3.2.0 and apiVersion: "v1beta"
  return new GoogleGenAI({
    apiKey,
    apiVersion: "v1beta",
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  }) as unknown as DecisionsClientLike;
}

function buildFeedbackMessage(
  action: DecisionAction,
  flags: {
    shouldSearch: boolean;
    needsCalibration: boolean;
    isVisualSufficient: boolean;
    hasFrames: boolean;
  },
): string {
  switch (action) {
    case "CONTINUE_LISTENING":
      return "Listening — finish your thought and search will update automatically.";
    case "OBSERVE_SPACE":
      return "Start live video or point your camera at the space you want to furnish.";
    case "REQUEST_ANOTHER_ANGLE":
      return flags.shouldSearch
        ? "Searching initial matches — pan to another angle for clearer spatial context."
        : "Show another angle so the target surface and surrounding items are clearly visible.";
    case "REQUEST_CALIBRATION":
      return flags.shouldSearch
        ? "Searching candidates — place a standard card or Letter sheet in view to calibrate exact fit."
        : "Place a known-size reference object (blank card or US Letter sheet) in view to calibrate space dimensions.";
    case "REQUEST_MEASUREMENTS":
      return flags.shouldSearch
        ? "Searching candidates — share approximate width or height inches to verify tight fit."
        : "State approximate available width, height, or depth so physical fit can be verified.";
    case "CLARIFY_REQUIREMENT":
      return "Describe what kind of item or problem you want to solve in this space.";
    case "REPLACE_CONSTRAINT":
      return "Replaced superseded preference and refreshed Shopify catalog search.";
    case "REMOVE_CONSTRAINT":
      return "Removed earlier restriction and refreshed Shopify catalog search.";
    case "UPDATE_CONSTRAINTS":
      return "Updated active shopping constraints and refreshed catalog results.";
    case "REFINE_SEARCH":
      return "Refined Shopify search parameters from your follow-up request.";
    case "VERIFY_PRODUCTS":
      return flags.needsCalibration && !flags.hasFrames
        ? "Retrieved Shopify matches for hard constraints — add camera view or measurements to verify physical fit."
        : "Checking Shopify candidates against your active budget and material constraints.";
    case "PRESENT_RESULTS":
      return "Current Shopify results already reflect your active scene and constraints.";
    case "SEARCH_PRODUCTS":
    default:
      if (flags.needsCalibration) {
        return "Found Shopify products — add a reference object or dimensions if you need strict fit verification.";
      }
      if (!flags.isVisualSufficient && !flags.hasFrames) {
        return "Searching from spoken constraints — enable Live Video to match your room aesthetic.";
      }
      return "Searching Shopify catalog for products that match your space and constraints.";
  }
}

export async function evaluateShoppingDecision(
  params: {
    videoFrames?: string[] | null;
    imageBase64?: string | null;
    mimeType?: string | null;
    rambleText: string;
    triggerSource?: DecisionTriggerSource;
    previousContext?: PreviousSessionContext | null;
  },
  injectedClient?: DecisionsClientLike,
): Promise<ShoppingDecisionResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!injectedClient && !apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Configure GEMINI_API_KEY in Settings > Secrets to run Gemini Decisions API.",
    );
  }

  const decisionsAi = injectedClient ?? createDecisionsClient(apiKey!);
  const mime = params.mimeType || "image/jpeg";
  const frames =
    params.videoFrames && params.videoFrames.length > 0
      ? params.videoFrames.slice(-4)
      : params.imageBase64
        ? [params.imageBase64]
        : [];

  const trigger: DecisionTriggerSource = params.triggerSource ?? "manual_submit";
  const cleanedText = params.rambleText.trim();

  const inputBlocks: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        data: string;
        mime_type: string;
        resolution: "low" | "medium" | "high";
      }
  > = [];

  const sessionPayload = {
    trigger_source: trigger,
    camera_frames_attached: frames.length,
    previous_search_query: params.previousContext?.searchQuery ?? null,
    previous_max_price_usd: params.previousContext?.maxPriceUsd ?? null,
    previous_active_constraints: params.previousContext?.activeConstraints ?? [],
    previous_scene_summary: params.previousContext?.sceneSummary ?? null,
    latest_user_utterance:
      cleanedText || "(No speech transcript; user is streaming live camera frames.)",
  };

  inputBlocks.push({
    type: "text",
    text: `SceneCart live shopping session state:\n${JSON.stringify(sessionPayload)}\n`,
  });

  for (const frameBase64 of frames) {
    inputBlocks.push({
      type: "image",
      data: frameBase64,
      mime_type: mime,
      resolution: "low",
    });
  }

  const startedAt = performance.now();

  const response = await decisionsAi.decisions.create({
    model: "gemini-decision-1",
    input: inputBlocks,
    questions: {
      is_still_speaking: {
        type: "noul",
        instructions:
          "Does `latest_user_utterance` end mid-sentence, trail off on a conjunction or preposition, or contain only filler words indicating the user has not finished speaking?",
        criteria: {
          true_description:
            "Unfinished sentence fragment ('I want a...', 'maybe under', 'and also'), hesitation ('um', 'let me think'), or single stray word with no product meaning.",
          false_description:
            "Complete phrase, clear product noun, actionable constraint update, or intentional camera-only sync.",
        },
      },
      should_update_wishlist: {
        type: "noul",
        instructions:
          "Does `latest_user_utterance` or the visible space introduce or modify a shopping category, budget, material, color, style, exclusion, or dimension requirement?",
        criteria: {
          true_description:
            "Expresses or updates a product need, budget cap, material, color, exclusion, or room problem.",
          false_description:
            "No new or changed shopping requirement compared with `previous_active_constraints`.",
        },
      },
      is_constraint_correction: {
        type: "noul",
        instructions:
          "Is the user revising, negating, replacing, or removing an earlier shopping preference or constraint?",
        criteria: {
          true_description:
            "Contains self-correction or reversal phrasing such as 'actually', 'forget wood', 'instead', 'make that under $50', 'cheaper', 'no longer', or 'remove the plastic rule'.",
          false_description:
            "First-time request or purely additive constraint that keeps prior preferences intact.",
        },
      },
      is_visual_context_sufficient: {
        type: "noul",
        instructions:
          "Is there enough visual or spoken context to identify what product to search for without immediately requesting another camera angle?",
        criteria: {
          true_description:
            "Clear camera frames show the space or the user explicitly stated a searchable product type or problem.",
          false_description:
            "The user asks a purely spatial question ('what fits right here?') with zero camera frames or an unusable/completely dark view.",
        },
      },
      needs_calibration_or_measurements: {
        type: "noul",
        instructions:
          "Did the user state a strict physical dimension fit requirement ('must fit this narrow gap', 'nothing taller than this shelf') without giving numeric dimensions or showing a known-size reference object?",
        criteria: {
          true_description:
            "Strict physical size/clearance constraint tied to an unmeasured space in view without numeric inches/cm or a reference card/sheet.",
          false_description:
            "General product search, style/budget filtering, or numeric dimensions are already provided.",
        },
      },
      should_search_now: {
        type: "noul",
        instructions:
          "Should SceneCart execute or refresh a Shopify product catalog search right now based on `latest_user_utterance` and the attached camera frames?",
        criteria: {
          true_description:
            "A concrete product category, room need, or constraint refinement is actionable now, or camera frames show a clear space ready for initial product suggestions.",
          false_description:
            "Premature unfinished utterance, ambiguous chit-chat with no product target, or unchanged periodic sync where `previous_search_query` already matches.",
        },
      },
      search_readiness: {
        type: "score",
        instructions:
          "Rate how ready this live session input is for Shopify product search and constraint verification.",
        criteria: READINESS_RUBRIC,
      },
      recommended_action: {
        type: "choice",
        instructions:
          "Select the best SceneCart agent action to take next for this user turn.",
        criteria: ACTION_CRITERIA,
      },
    },
  });

  const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));

  if (!response.answers) {
    const blockReason = response.prompt_feedback?.block_reason;
    throw new Error(
      blockReason
        ? `Gemini Decisions API blocked the input (${blockReason}).`
        : "Gemini Decisions API returned no answers.",
    );
  }

  const readNoul = (key: string, fallback = 0.5): number => {
    const ans = response.answers?.[key] as
      | { type?: string; noul?: number }
      | undefined;
    if (ans?.type === "noul" && typeof ans.noul === "number") {
      return ans.noul;
    }
    return fallback;
  };

  const isStillSpeakingProb = readNoul("is_still_speaking", 0.1);
  const shouldUpdateWishlistProb = readNoul("should_update_wishlist", 0.5);
  const isConstraintCorrectionProb = readNoul("is_constraint_correction", 0.1);
  const isVisualContextSufficientProb = readNoul("is_visual_context_sufficient", 0.7);
  const needsCalibrationProb = readNoul("needs_calibration_or_measurements", 0.15);
  const shouldSearchNowProb = readNoul("should_search_now", 0.6);

  const scoreAnswer = response.answers.search_readiness as
    | {
        type?: string;
        score?: number;
        legend?: Record<string, string>;
        probabilities?: Record<string, number>;
      }
    | undefined;

  const rawScore =
    scoreAnswer?.type === "score" && typeof scoreAnswer.score === "number"
      ? scoreAnswer.score
      : 2;
  const readinessNormalized = Math.max(
    0,
    Math.min(1, rawScore / (READINESS_RUBRIC.length - 1)),
  );
  const roundedIdx = Math.max(
    0,
    Math.min(READINESS_RUBRIC.length - 1, Math.round(rawScore)),
  );
  const readinessLabel =
    scoreAnswer?.legend?.[String(roundedIdx)] ?? READINESS_RUBRIC[roundedIdx];

  const choiceAnswer = response.answers.recommended_action as
    | {
        type?: string;
        choice?: string;
        confidence?: number;
        probabilities?: Record<string, number>;
      }
    | undefined;

  const rawChoice = choiceAnswer?.type === "choice" ? choiceAnswer.choice ?? "other" : "other";
  const actionConfidence =
    choiceAnswer?.type === "choice" && typeof choiceAnswer.confidence === "number"
      ? choiceAnswer.confidence
      : 0.5;

  const topActionProbabilities =
    choiceAnswer?.type === "choice" && choiceAnswer.probabilities
      ? Object.entries(choiceAnswer.probabilities)
          .filter(([k]) => k !== "other")
          .sort(([, a], [, b]) => b - a)
          .slice(0, 4)
          .map(([action, probability]) => ({ action, probability }))
      : [];

  // Map calibrated probabilities (strictly inside (0.01, 0.99)) to deterministic session control
  const isStillSpeaking = isStillSpeakingProb > 0.62;
  const shouldUpdateWishlist = shouldUpdateWishlistProb > 0.5;
  const isConstraintCorrection = isConstraintCorrectionProb > 0.55;
  const isVisualContextSufficient = isVisualContextSufficientProb > 0.45;
  const needsCalibrationOrMeasurements = needsCalibrationProb > 0.58;

  let resolvedAction: DecisionAction = VALID_DECISION_ACTIONS.has(
    rawChoice as DecisionAction,
  )
    ? (rawChoice as DecisionAction)
    : isConstraintCorrection
      ? "REPLACE_CONSTRAINT"
      : shouldUpdateWishlist
        ? "UPDATE_CONSTRAINTS"
        : shouldSearchNowProb >= 0.45
          ? "SEARCH_PRODUCTS"
          : "CLARIFY_REQUIREMENT";

  let shouldSearch = shouldSearchNowProb >= 0.45;

  if (trigger === "speech_pause" && isStillSpeaking && shouldSearchNowProb < 0.72) {
    resolvedAction = "CONTINUE_LISTENING";
    shouldSearch = false;
  } else if (
    trigger === "live_auto_sync" &&
    !cleanedText &&
    params.previousContext?.searchQuery &&
    shouldSearchNowProb < 0.55
  ) {
    resolvedAction = "PRESENT_RESULTS";
    shouldSearch = false;
  } else if (
    frames.length === 0 &&
    !isVisualContextSufficient &&
    shouldSearchNowProb < 0.45
  ) {
    resolvedAction = "OBSERVE_SPACE";
    shouldSearch = false;
  } else if (
    resolvedAction === "CONTINUE_LISTENING" ||
    resolvedAction === "CLARIFY_REQUIREMENT" ||
    resolvedAction === "OBSERVE_SPACE" ||
    resolvedAction === "PRESENT_RESULTS"
  ) {
    if (trigger !== "manual_submit" && shouldSearchNowProb < 0.55) {
      shouldSearch = false;
    } else if (trigger === "manual_submit" && (cleanedText.length > 0 || frames.length > 0)) {
      // Explicit button click with valid input executes search unless purely empty
      shouldSearch = shouldSearchNowProb >= 0.25 || rawScore >= 1.2;
      if (shouldSearch && resolvedAction === "CONTINUE_LISTENING") {
        resolvedAction = isConstraintCorrection ? "REPLACE_CONSTRAINT" : "SEARCH_PRODUCTS";
      }
    }
  } else if (isConstraintCorrection && resolvedAction === "SEARCH_PRODUCTS") {
    resolvedAction = "REPLACE_CONSTRAINT";
  }

  const feedbackMessage = buildFeedbackMessage(resolvedAction, {
    shouldSearch,
    needsCalibration: needsCalibrationOrMeasurements,
    isVisualSufficient: isVisualContextSufficient,
    hasFrames: frames.length > 0,
  });

  return {
    model: "gemini-decision-1",
    action: resolvedAction,
    actionConfidence,
    topActionProbabilities,
    shouldSearch,
    shouldUpdateWishlist,
    isStillSpeaking,
    isConstraintCorrection,
    isVisualContextSufficient,
    needsCalibrationOrMeasurements,
    signals: {
      isStillSpeakingProb,
      shouldUpdateWishlistProb,
      isConstraintCorrectionProb,
      isVisualContextSufficientProb,
      needsCalibrationProb,
      shouldSearchNowProb,
    },
    readinessScore: Number(rawScore.toFixed(2)),
    readinessNormalized: Number(readinessNormalized.toFixed(3)),
    readinessLabel,
    feedbackMessage,
    latencyMs,
    totalOutputTokens: response.usage?.total_output_tokens ?? 0,
  };
}
