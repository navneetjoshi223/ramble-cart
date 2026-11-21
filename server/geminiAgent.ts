import type {
  ActiveConstraint,
  DecisionAction,
  PreviousSessionContext,
  SpaceQueryInterpretation,
} from "../src/types.js";
import {
  extractShoppingIntentWithHydrogen,
  type HydrogenGenerateClientLike,
} from "./hydrogenAgent.js";
import {
  analyzeSpaceWithNeon,
  type NeonGenerateClientLike,
} from "./neonAgent.js";

/**
 * Dual Gemini 4 Coordinator (`gemini-4-hydrogen` + `gemini-4-neon`).
 * - Hydrogen extracts structured spoken shopping intent, budget, required/excluded/functional
 *   constraints, and mid-sentence self-corrections.
 * - Neon analyzes chronological 1 FPS camera frames to extract target space, surrounding
 *   aesthetic, materials, calibration references, and conservative dimension ranges.
 * - When both live video frames and speech are present, Hydrogen and Neon execute concurrently.
 */
export async function interpretSpaceAndRamble(
  params: {
    videoFrames?: string[] | null;
    imageBase64?: string | null;
    mimeType?: string | null;
    rambleText: string;
    hasSpokenTranscript?: boolean;
    previousContext?: PreviousSessionContext | null;
    decisionHint?: {
      action: DecisionAction;
      isConstraintCorrection: boolean;
    } | null;
  },
  clients?: {
    hydrogenClient?: HydrogenGenerateClientLike;
    neonClient?: NeonGenerateClientLike;
  },
): Promise<SpaceQueryInterpretation> {
  const frames =
    params.videoFrames && params.videoFrames.length > 0
      ? params.videoFrames.slice(-4)
      : params.imageBase64
        ? [params.imageBase64]
        : [];

  const spokenProvided =
    params.hasSpokenTranscript ?? Boolean(params.rambleText.trim());

  // Case 1: Camera-only sync (no spoken transcript yet) -> Neon observes space first,
  // then Hydrogen formulates a grounded shopping query for that space.
  if (frames.length > 0 && !spokenProvided) {
    const neonSpatial = await analyzeSpaceWithNeon(
      {
        videoFrames: frames,
        mimeType: params.mimeType,
        rambleText: null,
      },
      clients?.neonClient,
    );

    const spatialSummaryText = neonSpatial
      ? `${neonSpatial.targetSpace} (${neonSpatial.aestheticStyle}; materials: ${neonSpatial.visibleMaterials.join(", ") || "neutral"}; usable region: ${neonSpatial.usableRegion})`
      : null;

    const { intent, activeConstraints } = await extractShoppingIntentWithHydrogen(
      {
        rambleText:
          params.rambleText ||
          "Suggest a practical product that complements this visible space.",
        spatialHint: spatialSummaryText,
        previousContext: params.previousContext,
        decisionHint: params.decisionHint,
      },
      clients?.hydrogenClient,
    );

    const mergedConstraints = mergeSpatialConstraints(activeConstraints, neonSpatial);
    return {
      searchQuery: intent.searchQuery,
      maxPriceUsd: intent.maximumBudget,
      activeConstraints: mergedConstraints,
      supersededConstraints: intent.supersededConstraints,
      sceneSummary: neonSpatial
        ? `${neonSpatial.sceneDescription} (${neonSpatial.aestheticStyle})`
        : intent.shoppingIntent,
      hydrogenIntent: intent,
      neonSpatial,
    };
  }

  // Case 2: Both camera frames AND spoken transcript -> run Hydrogen + Neon concurrently!
  if (frames.length > 0) {
    const [hydrogenOut, neonSpatial] = await Promise.all([
      extractShoppingIntentWithHydrogen(
        {
          rambleText: params.rambleText,
          previousContext: params.previousContext,
          decisionHint: params.decisionHint,
        },
        clients?.hydrogenClient,
      ),
      analyzeSpaceWithNeon(
        {
          videoFrames: frames,
          mimeType: params.mimeType,
          rambleText: params.rambleText,
        },
        clients?.neonClient,
      ),
    ]);

    const { intent, activeConstraints } = hydrogenOut;
    const mergedConstraints = mergeSpatialConstraints(activeConstraints, neonSpatial);

    // Enrich bare category queries with 1 room-complementary keyword from Neon when user
    // asked to match their space without specifying a style/color
    let groundedQuery = intent.searchQuery;
    if (
      neonSpatial &&
      intent.requiredAttributes.length === 0 &&
      intent.preferredAttributes.length === 0 &&
      neonSpatial.suggestedStyleKeywords.length > 0
    ) {
      const styleWord = neonSpatial.suggestedStyleKeywords[0];
      if (
        styleWord &&
        !groundedQuery.toLowerCase().includes(styleWord.toLowerCase()) &&
        groundedQuery.split(/\s+/).length <= 4
      ) {
        groundedQuery = `${styleWord} ${groundedQuery}`.trim();
      }
    }

    return {
      searchQuery: groundedQuery,
      maxPriceUsd: intent.maximumBudget,
      activeConstraints: mergedConstraints,
      supersededConstraints: intent.supersededConstraints,
      sceneSummary: neonSpatial
        ? `${neonSpatial.sceneDescription} · Style: ${neonSpatial.aestheticStyle}`
        : intent.shoppingIntent,
      hydrogenIntent: intent,
      neonSpatial,
    };
  }

  // Case 3: Voice/text request with camera off -> Hydrogen speech & intent agent runs directly
  const { intent, activeConstraints } = await extractShoppingIntentWithHydrogen(
    {
      rambleText: params.rambleText,
      previousContext: params.previousContext,
      decisionHint: params.decisionHint,
    },
    clients?.hydrogenClient,
  );

  return {
    searchQuery: intent.searchQuery,
    maxPriceUsd: intent.maximumBudget,
    activeConstraints,
    supersededConstraints: intent.supersededConstraints,
    sceneSummary: intent.shoppingIntent,
    hydrogenIntent: intent,
    neonSpatial: null,
  };
}

function mergeSpatialConstraints(
  hydrogenConstraints: ActiveConstraint[],
  neonSpatial: Awaited<ReturnType<typeof analyzeSpaceWithNeon>>,
): ActiveConstraint[] {
  if (!neonSpatial) return hydrogenConstraints;

  const out = [...hydrogenConstraints];
  const existingTexts = new Set(out.map((c) => c.text.toLowerCase()));

  if (
    neonSpatial.targetSpace &&
    !existingTexts.has(neonSpatial.targetSpace.toLowerCase())
  ) {
    out.push({
      text: neonSpatial.targetSpace,
      kind: "spatial",
    });
  }

  if (
    neonSpatial.estimatedWidthRangeInches &&
    !out.some((c) => /width/i.test(c.text))
  ) {
    out.push({
      text: `est. width ${neonSpatial.estimatedWidthRangeInches}`,
      kind: "spatial",
    });
  }

  return out;
}
