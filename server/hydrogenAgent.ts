import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import type {
  ActiveConstraint,
  DecisionAction,
  HydrogenIntentExtraction,
  PreviousSessionContext,
} from "../src/types.js";

export interface HydrogenGenerateClientLike {
  models: {
    generateContent: (params: Record<string, unknown>) => Promise<{
      text?: string;
    }>;
  };
}

export function createHydrogenClient(apiKey: string): HydrogenGenerateClientLike {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  }) as unknown as HydrogenGenerateClientLike;
}

/**
 * Gemini 4 Hydrogen — Speech & Shopping Intent Agent.
 * Extracts structured shopping intent, budgets, required/excluded/preferred/functional
 * attributes, dimensional constraints, and mid-sentence self-corrections.
 */
export async function extractShoppingIntentWithHydrogen(
  params: {
    rambleText: string;
    spatialHint?: string | null;
    previousContext?: PreviousSessionContext | null;
    decisionHint?: {
      action: DecisionAction;
      isConstraintCorrection: boolean;
    } | null;
  },
  injectedClient?: HydrogenGenerateClientLike,
): Promise<{
  intent: HydrogenIntentExtraction;
  activeConstraints: ActiveConstraint[];
}> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!injectedClient && !apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Configure GEMINI_API_KEY in Settings > Secrets for Gemini 4 Hydrogen speech intent extraction.",
    );
  }

  const ai = injectedClient ?? createHydrogenClient(apiKey!);

  const priorBlock = params.previousContext?.searchQuery
    ? `Previous shopping session state:\n${JSON.stringify({
        previousQuery: params.previousContext.searchQuery,
        previousMaxPriceUsd: params.previousContext.maxPriceUsd ?? null,
        previousActiveConstraints: params.previousContext.activeConstraints ?? [],
      })}\n`
    : "";

  const decisionBlock = params.decisionHint
    ? `Decisions API signal: action=${params.decisionHint.action}, isConstraintCorrection=${params.decisionHint.isConstraintCorrection}\n`
    : "";

  const spatialBlock = params.spatialHint
    ? `Observed physical space context (from Neon): ${params.spatialHint}\n`
    : "";

  const prompt = `${priorBlock}${decisionBlock}${spatialBlock}User spoken/typed transcript: "${params.rambleText}"

Extract structured shopping intent for Shopify catalog search:
1. Identify productCategory and a concise 2-to-6 word searchQuery.
2. Separate mandatory requiredAttributes, preferredAttributes, excludedAttributes, and functionalRequirements (e.g., "drill-free installation", "hides cables").
3. Extract dimensionalRequirements in inches when stated (or 0 if unstated).
4. Handle mid-sentence corrections or follow-up reversals ("actually, forget wood", "make it under $60", "no white anymore"): move overturned constraints into supersededConstraints and NEVER leave them in active attributes.`;

  const startedAt = performance.now();

  const response = await ai.models.generateContent({
    model: "gemini-4-hydrogen",
    contents: prompt,
    config: {
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.LOW,
      },
      systemInstruction:
        "You are SceneCart's Hydrogen Speech & Intent Agent. Convert spoken shopping requests and corrections into validated structured shopping requirements. Never invent attributes not requested or carried forward from valid session history, and cleanly separate superseded preferences when the user changes their mind.",
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          productCategory: {
            type: Type.STRING,
            description: "Target product category (e.g. 'monitor stand', 'cable management tray', 'framed wall art'), or empty string if unknown.",
          },
          shoppingIntent: {
            type: Type.STRING,
            description: "Concise 1-sentence summary of what the user wants to solve or buy.",
          },
          searchQuery: {
            type: Type.STRING,
            description: "Concise 2-to-6 word Shopify Shop MCP search query.",
          },
          maximumBudget: {
            type: Type.NUMBER,
            description: "Maximum budget in USD (or active currency), or 0 if no budget cap applies.",
          },
          currency: {
            type: Type.STRING,
            description: "ISO currency code, defaulting to USD.",
          },
          requiredAttributes: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Mandatory colors, materials, or attributes (excluding price, which goes in maximumBudget).",
          },
          excludedAttributes: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Explicitly excluded materials, colors, or styles (e.g. 'plastic', 'wood', 'abstract').",
          },
          preferredAttributes: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Soft preferences ('preferably black', 'minimalist', 'warm').",
          },
          functionalRequirements: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Functional needs such as 'no drilling', 'adhesive mount', 'organizes books'.",
          },
          maxWidthInches: {
            type: Type.NUMBER,
            description: "Maximum width in inches if specified, else 0.",
          },
          maxHeightInches: {
            type: Type.NUMBER,
            description: "Maximum height in inches if specified, else 0.",
          },
          maxDepthInches: {
            type: Type.NUMBER,
            description: "Maximum depth in inches if specified, else 0.",
          },
          dimensionalRawText: {
            type: Type.STRING,
            description: "Spoken spatial fit phrase such as 'nothing taller than this shelf', or empty string.",
          },
          supersededConstraints: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Earlier preferences or caps cancelled by the user.",
          },
          unresolvedConstraints: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Constraints needing spatial measurement or clarification.",
          },
          confidence: {
            type: Type.NUMBER,
            description: "Confidence in [0, 1].",
          },
          clarificationQuestion: {
            type: Type.STRING,
            description: "Brief clarification question if intent is ambiguous, else empty string.",
          },
        },
        required: [
          "productCategory",
          "shoppingIntent",
          "searchQuery",
          "maximumBudget",
          "currency",
          "requiredAttributes",
          "excludedAttributes",
          "preferredAttributes",
          "functionalRequirements",
          "supersededConstraints",
          "unresolvedConstraints",
          "confidence",
        ],
      },
    },
  });

  const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
  const rawJson = (response.text ?? "").trim();
  if (!rawJson) {
    throw new Error("Gemini 4 Hydrogen returned an empty intent response.");
  }

  const parsed = JSON.parse(rawJson) as Record<string, unknown>;

  const maxBudget =
    typeof parsed.maximumBudget === "number" && parsed.maximumBudget > 0
      ? parsed.maximumBudget
      : null;

  const toStringList = (val: unknown): string[] =>
    Array.isArray(val)
      ? val
          .filter((item): item is string => typeof item === "string")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  const requiredAttributes = toStringList(parsed.requiredAttributes);
  const excludedAttributes = toStringList(parsed.excludedAttributes);
  const preferredAttributes = toStringList(parsed.preferredAttributes);
  const functionalRequirements = toStringList(parsed.functionalRequirements);
  const supersededConstraints = toStringList(parsed.supersededConstraints);
  const unresolvedConstraints = toStringList(parsed.unresolvedConstraints);

  const maxWidthInches =
    typeof parsed.maxWidthInches === "number" && parsed.maxWidthInches > 0
      ? parsed.maxWidthInches
      : null;
  const maxHeightInches =
    typeof parsed.maxHeightInches === "number" && parsed.maxHeightInches > 0
      ? parsed.maxHeightInches
      : null;
  const maxDepthInches =
    typeof parsed.maxDepthInches === "number" && parsed.maxDepthInches > 0
      ? parsed.maxDepthInches
      : null;
  const dimensionalRawText =
    typeof parsed.dimensionalRawText === "string" && parsed.dimensionalRawText.trim()
      ? parsed.dimensionalRawText.trim()
      : null;

  const activeConstraints: ActiveConstraint[] = [];
  if (maxBudget !== null) {
    activeConstraints.push({ text: `under $${maxBudget}`, kind: "required" });
  }
  for (const req of requiredAttributes) {
    activeConstraints.push({ text: req, kind: "required" });
  }
  for (const fnReq of functionalRequirements) {
    activeConstraints.push({ text: fnReq, kind: "required" });
  }
  for (const pref of preferredAttributes) {
    activeConstraints.push({ text: pref, kind: "preferred" });
  }
  for (const excl of excludedAttributes) {
    const label = /^no\b/i.test(excl) ? excl : `no ${excl}`;
    activeConstraints.push({ text: label, kind: "excluded" });
  }
  if (maxWidthInches !== null) {
    activeConstraints.push({ text: `max width ${maxWidthInches} in`, kind: "spatial" });
  }
  if (maxHeightInches !== null) {
    activeConstraints.push({ text: `max height ${maxHeightInches} in`, kind: "spatial" });
  }
  if (maxDepthInches !== null) {
    activeConstraints.push({ text: `max depth ${maxDepthInches} in`, kind: "spatial" });
  }
  if (
    dimensionalRawText &&
    maxWidthInches === null &&
    maxHeightInches === null &&
    maxDepthInches === null
  ) {
    activeConstraints.push({ text: dimensionalRawText, kind: "spatial" });
  }

  const productCategory =
    typeof parsed.productCategory === "string" && parsed.productCategory.trim()
      ? parsed.productCategory.trim()
      : null;

  const searchQuery =
    (typeof parsed.searchQuery === "string" && parsed.searchQuery.trim()) ||
    productCategory ||
    params.previousContext?.searchQuery ||
    params.rambleText;

  const intent: HydrogenIntentExtraction = {
    model: "gemini-4-hydrogen",
    transcript: params.rambleText,
    productCategory,
    shoppingIntent:
      typeof parsed.shoppingIntent === "string" && parsed.shoppingIntent.trim()
        ? parsed.shoppingIntent.trim()
        : searchQuery,
    searchQuery,
    maximumBudget: maxBudget,
    currency:
      typeof parsed.currency === "string" && parsed.currency.trim()
        ? parsed.currency.trim().toUpperCase()
        : "USD",
    requiredAttributes,
    excludedAttributes,
    preferredAttributes,
    functionalRequirements,
    dimensionalRequirements: {
      maxWidthInches,
      maxHeightInches,
      maxDepthInches,
      rawText: dimensionalRawText,
    },
    supersededConstraints,
    unresolvedConstraints,
    confidence:
      typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.85,
    clarificationQuestion:
      typeof parsed.clarificationQuestion === "string" &&
      parsed.clarificationQuestion.trim()
        ? parsed.clarificationQuestion.trim()
        : null,
    latencyMs,
  };

  return { intent, activeConstraints };
}
