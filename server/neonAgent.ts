import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import type {
  ActiveConstraint,
  ConstraintVerdict,
  ConstraintVerificationCheck,
  ExtractedProductAttribute,
  NeonSpatialPerception,
  NormalizedProduct,
  ProductEvidenceResult,
  VerificationStatus,
} from "../src/types.js";

export interface NeonGenerateClientLike {
  models: {
    generateContent: (params: Record<string, unknown>) => Promise<{
      text?: string;
    }>;
  };
}

export function createNeonClient(apiKey: string): NeonGenerateClientLike {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  }) as unknown as NeonGenerateClientLike;
}

const EVIDENCE_CACHE_MAX = 120;
const productEvidenceCache = new Map<string, ProductEvidenceResult>();

export function clearProductEvidenceCache() {
  productEvidenceCache.clear();
}

/**
 * SSRF-safe validation for remote merchant product image URLs.
 * Allows only public HTTPS hosts and blocks loopback, link-local, and private RFC1918 literals.
 */
export function isSafePublicHttpsImageUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host === "[::1]" ||
      host === "0.0.0.0"
    ) {
      return false;
    }
    // Block private / loopback IPv4 literals
    const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const [a, b] = [Number(ipv4Match[1]), Number(ipv4Match[2])];
      if (
        a === 10 ||
        a === 127 ||
        a === 0 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
      ) {
        return false;
      }
    }
    if (host.startsWith("[fe80:") || host.startsWith("[fc") || host.startsWith("[fd")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchProductImageInline(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ mimeType: string; data: string } | null> {
  if (!isSafePublicHttpsImageUrl(url)) return null;

  try {
    const res = await fetchFn(url, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
      headers: {
        Accept: "image/jpeg,image/png,image/webp,image/*;q=0.8",
      },
    });
    if (!res.ok) return null;
    if (res.url && !isSafePublicHttpsImageUrl(res.url)) return null;

    const contentType = (res.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!contentType.startsWith("image/")) return null;

    const contentLength = Number(res.headers.get("content-length") || "0");
    if (contentLength > 4 * 1024 * 1024) return null;

    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength === 0 || arrayBuf.byteLength > 4 * 1024 * 1024) {
      return null;
    }

    return {
      mimeType: contentType,
      data: Buffer.from(arrayBuf).toString("base64"),
    };
  } catch {
    return null;
  }
}

/**
 * Gemini 4 Neon — Spatial Perception Agent.
 * Analyzes chronological 1 FPS camera frames to extract target space, surrounding
 * objects, dominant colors, materials, design aesthetic, calibration status, and
 * conservative dimension estimates.
 */
export async function analyzeSpaceWithNeon(
  params: {
    videoFrames: string[];
    mimeType?: string | null;
    rambleText?: string | null;
  },
  injectedClient?: NeonGenerateClientLike,
): Promise<NeonSpatialPerception | null> {
  const frames = params.videoFrames.filter(Boolean).slice(-4);
  if (frames.length === 0) {
    return null;
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!injectedClient && !apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Configure GEMINI_API_KEY in Settings > Secrets for Gemini 4 Neon spatial perception.",
    );
  }

  const ai = injectedClient ?? createNeonClient(apiKey!);
  const mime = params.mimeType || "image/jpeg";

  const parts: Array<
    | { text: string }
    | { inlineData: { mimeType: string; data: string } }
  > = [];

  for (const frameBase64 of frames) {
    parts.push({
      inlineData: {
        mimeType: mime,
        data: frameBase64,
      },
    });
  }

  parts.push({
    text: `Analyze these ${frames.length} chronological 1 FPS camera frame(s) of the user's physical environment.${
      params.rambleText?.trim()
        ? `\nUser spoken context: "${params.rambleText.trim()}"`
        : ""
    }

Identify:
- targetSpace (desk, empty wall, shelf, table, corner, cable area, etc.) and usableRegion
- existingObjects, dominantColors, visibleMaterials, and aestheticStyle
- Whether a known-size calibration reference object (credit-card-sized card 85.6x53.98mm or US Letter sheet 8.5x11in) is clearly visible on the target plane
- Conservative available dimension ranges ONLY when visual cues justify an approximate range; never claim exact LiDAR precision without a calibration reference.`,
  });

  const startedAt = performance.now();

  const response = await ai.models.generateContent({
    model: "gemini-4-neon",
    contents: { parts },
    config: {
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.LOW,
      },
      systemInstruction:
        "You are SceneCart's Neon Spatial Perception Agent. Analyze camera frames objectively. Report observable materials, finishes, aesthetic style, calibration objects, perspective limitations, and conservative uncertainty ranges. Never claim exact real-world dimensions without a calibrated reference object.",
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          targetSpace: {
            type: Type.STRING,
            description: "Primary surface or area shown (e.g. 'dark walnut work desk', 'empty wall above console').",
          },
          sceneDescription: {
            type: Type.STRING,
            description: "Concise 1-sentence visual description of the space and lighting.",
          },
          existingObjects: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          usableRegion: {
            type: Type.STRING,
            description: "Where a new product can be placed (e.g. 'center desk clearance beneath monitor').",
          },
          dominantColors: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          visibleMaterials: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          aestheticStyle: {
            type: Type.STRING,
            description: "Surrounding interior style (e.g. 'warm mid-century walnut with matte black industrial accents').",
          },
          referenceObject: {
            type: Type.STRING,
            description: "Detected calibration reference object if visible, else empty string.",
          },
          calibrationStatus: {
            type: Type.STRING,
            description: "One of: calibrated, partial, uncalibrated",
          },
          estimatedWidthRangeInches: {
            type: Type.STRING,
            description: "Approximate width range like '24-30 in' if estimable, else empty string.",
          },
          estimatedHeightRangeInches: {
            type: Type.STRING,
            description: "Approximate height range if estimable, else empty string.",
          },
          estimatedDepthRangeInches: {
            type: Type.STRING,
            description: "Approximate depth range if estimable, else empty string.",
          },
          measurementConfidence: {
            type: Type.STRING,
            description: "One of: high, medium, low, none",
          },
          measurementLimitations: {
            type: Type.STRING,
            description: "Honest note on camera angle, depth ambiguity, or missing reference calibration.",
          },
          additionalViewRequired: {
            type: Type.BOOLEAN,
          },
          suggestedStyleKeywords: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "1 to 3 concise style/material keywords that complement the room.",
          },
        },
        required: [
          "targetSpace",
          "sceneDescription",
          "existingObjects",
          "usableRegion",
          "dominantColors",
          "visibleMaterials",
          "aestheticStyle",
          "calibrationStatus",
          "measurementConfidence",
          "measurementLimitations",
          "additionalViewRequired",
          "suggestedStyleKeywords",
        ],
      },
    },
  });

  const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
  const rawJson = (response.text ?? "").trim();
  if (!rawJson) {
    throw new Error("Gemini 4 Neon returned an empty spatial perception response.");
  }

  const parsed = JSON.parse(rawJson) as Record<string, unknown>;
  const toList = (val: unknown): string[] =>
    Array.isArray(val)
      ? val
          .filter((x): x is string => typeof x === "string")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  const nonEmpty = (val: unknown): string | null =>
    typeof val === "string" && val.trim() ? val.trim() : null;

  const calRaw = typeof parsed.calibrationStatus === "string" ? parsed.calibrationStatus : "";
  const calibrationStatus: NeonSpatialPerception["calibrationStatus"] =
    calRaw === "calibrated" || calRaw === "partial" ? calRaw : "uncalibrated";

  const confRaw =
    typeof parsed.measurementConfidence === "string" ? parsed.measurementConfidence : "";
  const measurementConfidence: NeonSpatialPerception["measurementConfidence"] =
    confRaw === "high" || confRaw === "medium" || confRaw === "low" ? confRaw : "none";

  return {
    model: "gemini-4-neon",
    targetSpace: nonEmpty(parsed.targetSpace) ?? "Observed space",
    sceneDescription: nonEmpty(parsed.sceneDescription) ?? "Live camera view analyzed.",
    existingObjects: toList(parsed.existingObjects),
    usableRegion: nonEmpty(parsed.usableRegion) ?? "Primary visible surface",
    dominantColors: toList(parsed.dominantColors),
    visibleMaterials: toList(parsed.visibleMaterials),
    aestheticStyle: nonEmpty(parsed.aestheticStyle) ?? "Contemporary neutral",
    referenceObject: nonEmpty(parsed.referenceObject),
    calibrationStatus,
    estimatedWidthRangeInches: nonEmpty(parsed.estimatedWidthRangeInches),
    estimatedHeightRangeInches: nonEmpty(parsed.estimatedHeightRangeInches),
    estimatedDepthRangeInches: nonEmpty(parsed.estimatedDepthRangeInches),
    measurementConfidence,
    measurementLimitations:
      nonEmpty(parsed.measurementLimitations) ??
      "Uncalibrated monocular camera view; place a reference card for exact fit.",
    additionalViewRequired: Boolean(parsed.additionalViewRequired),
    suggestedStyleKeywords: toList(parsed.suggestedStyleKeywords).slice(0, 3),
    latencyMs,
  };
}

function getMajorPriceAmount(amountMinor: number, currency: string): number {
  const code = currency.toUpperCase();
  const zeroDec = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
  const threeDec = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);
  const exp = zeroDec.has(code) ? 0 : threeDec.has(code) ? 3 : 2;
  return amountMinor / Math.pow(10, exp);
}

/**
 * Gemini 4 Neon — Multimodal Product Photo & Specification Verification Agent.
 * Inspects listing text, variant options, AND actual product photographs (prioritizing
 * images 2-4 for annotated dimension diagrams and size charts) to extract specifications
 * and verify active constraints with PASS / FAIL / UNKNOWN verdicts.
 */
export async function extractProductEvidenceWithNeon(
  params: {
    product: NormalizedProduct;
    activeConstraints?: ActiveConstraint[];
    maxPriceUsd?: number | null;
    spatialSummary?: string | null;
    fetchImpl?: typeof fetch;
  },
  injectedClient?: NeonGenerateClientLike,
): Promise<ProductEvidenceResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!injectedClient && !apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Configure GEMINI_API_KEY in Settings > Secrets for Gemini 4 Neon product evidence verification.",
    );
  }

  const product = params.product;
  const variant = product.primaryVariant;
  const constraints = params.activeConstraints ?? [];
  const maxPriceUsd =
    typeof params.maxPriceUsd === "number" && params.maxPriceUsd > 0
      ? params.maxPriceUsd
      : null;

  const cacheKey = JSON.stringify({
    productId: product.id,
    variantId: variant?.id ?? null,
    priceMinor: variant?.price?.amountMinor ?? null,
    constraints,
    maxPriceUsd,
  });

  const cachedHit = productEvidenceCache.get(cacheKey);
  if (cachedHit) {
    return { ...cachedHit, cached: true };
  }

  // Select up to 3 product photos, prioritizing images 2-4 (indices 1, 2, 3) where
  // dimension diagrams & spec charts usually appear, plus image 1 for color/finish.
  const allMedia =
    product.media.length > 0 ? product.media : variant?.media ?? [];
  const candidateOrder: Array<{ url: string; galleryIndex1Based: number }> = [];
  if (allMedia[1]) candidateOrder.push({ url: allMedia[1].url, galleryIndex1Based: 2 });
  if (allMedia[2]) candidateOrder.push({ url: allMedia[2].url, galleryIndex1Based: 3 });
  if (allMedia[0]) candidateOrder.push({ url: allMedia[0].url, galleryIndex1Based: 1 });
  if (candidateOrder.length < 3 && allMedia[3]) {
    candidateOrder.push({ url: allMedia[3].url, galleryIndex1Based: 4 });
  }

  const selectedSlots = candidateOrder.slice(0, 3);
  const fetchedImages = await Promise.all(
    selectedSlots.map(async (slot) => {
      const inline = await fetchProductImageInline(slot.url, params.fetchImpl);
      return inline ? { ...inline, galleryIndex1Based: slot.galleryIndex1Based } : null;
    }),
  );
  const validImages = fetchedImages.filter(
    (img): img is { mimeType: string; data: string; galleryIndex1Based: number } =>
      img !== null,
  );

  // Deterministic budget evaluation on actual selected variant price
  const deterministicChecks: ConstraintVerificationCheck[] = [];
  if (maxPriceUsd !== null) {
    if (variant?.price && variant.price.currency.toUpperCase() === "USD") {
      const actualUsd = getMajorPriceAmount(variant.price.amountMinor, "USD");
      const passes = actualUsd <= maxPriceUsd;
      deterministicChecks.push({
        constraint: `Max budget $${maxPriceUsd} USD`,
        mandatory: true,
        verdict: passes ? "PASS" : "FAIL",
        reason: passes
          ? `Selected variant price (${variant.price.formatted}) is within $${maxPriceUsd} USD.`
          : `Selected variant price (${variant.price.formatted}) exceeds $${maxPriceUsd} USD.`,
        evidenceSource: "Shopify variant price",
        imageIndex: null,
      });
    } else if (variant?.price) {
      deterministicChecks.push({
        constraint: `Max budget $${maxPriceUsd} USD`,
        mandatory: true,
        verdict: "UNKNOWN",
        reason: `Variant is priced in ${variant.price.currency} (${variant.price.formatted}); unverified USD conversion.`,
        evidenceSource: "Shopify variant price",
        imageIndex: null,
      });
    } else {
      deterministicChecks.push({
        constraint: `Max budget $${maxPriceUsd} USD`,
        mandatory: true,
        verdict: "UNKNOWN",
        reason: "Selected variant price is missing.",
        evidenceSource: "Shopify variant metadata",
        imageIndex: null,
      });
    }
  }

  // Filter out pure price constraints from LLM evaluation since deterministic arithmetic handled budget
  const nonBudgetConstraints = constraints.filter(
    (c) => !/^\s*(under|below|max|budget)\s*\$\d+/i.test(c.text),
  );

  const ai = injectedClient ?? createNeonClient(apiKey!);
  const parts: Array<
    | { text: string }
    | { inlineData: { mimeType: string; data: string } }
  > = [];

  for (const img of validImages) {
    parts.push({
      text: `Attached Product Gallery Image #${img.galleryIndex1Based}:`,
    });
    parts.push({
      inlineData: {
        mimeType: img.mimeType,
        data: img.data,
      },
    });
  }

  const listingPayload = {
    title: product.title,
    merchant: variant?.seller?.name ?? null,
    selectedVariantTitle: variant?.title ?? null,
    selectedOptions:
      product.selectedOptions.length > 0
        ? product.selectedOptions
        : variant?.selectedOptions ?? [],
    price: variant?.price?.formatted ?? null,
    available: variant?.available ?? null,
    features: product.features,
    description: product.descriptionText.slice(0, 2000),
    attachedGalleryImageNumbers: validImages.map((i) => i.galleryIndex1Based),
  };

  parts.push({
    text: `Shopify Product Listing Metadata:\n${JSON.stringify(listingPayload)}
${params.spatialSummary ? `\nUser Space Context: ${params.spatialSummary}` : ""}
Non-budget constraints to verify:\n${JSON.stringify(nonBudgetConstraints)}

Instructions for Neon Product Evidence Extraction:
1. Inspect structured metadata, description, AND attached product photographs (especially annotated dimension diagrams, measurement callouts, size charts, and material labels).
2. Do NOT confuse shipping/package dimensions with actual product dimensions.
3. Do NOT infer mandatory material composition solely from shiny/metallic visual appearance—if neither text nor image text confirms a mandatory material or drill-free requirement, mark verdict as UNKNOWN.
4. For every extracted attribute or image-based constraint check, set imageIndex to the exact Attached Product Gallery Image # (e.g. 2) when sourced from a photo, or 0 when sourced from listing text.`,
  });

  const startedAt = performance.now();

  const response = await ai.models.generateContent({
    model: "gemini-4-neon",
    contents: { parts },
    config: {
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.LOW,
      },
      systemInstruction:
        "You are SceneCart's Neon Product Verification & Specification Extraction Agent. Extract verifiable dimensions, materials, colors, and installation details from product text and product images. Never guess missing specifications—use UNKNOWN when mandatory constraint evidence is absent or ambiguous.",
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          extractedAttributes: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                attributeName: { type: Type.STRING },
                extractedValue: { type: Type.STRING },
                unit: { type: Type.STRING },
                sourceType: {
                  type: Type.STRING,
                  description:
                    "One of: listing_text, variant_option, product_image_diagram, product_image_visual",
                },
                sourceCitation: { type: Type.STRING },
                imageIndex: {
                  type: Type.INTEGER,
                  description: "1-based gallery image number if extracted from a photo, else 0.",
                },
                confidence: { type: Type.NUMBER },
                observationType: {
                  type: Type.STRING,
                  description: "One of: directly_observed, inferred",
                },
              },
              required: [
                "attributeName",
                "extractedValue",
                "sourceType",
                "sourceCitation",
                "imageIndex",
                "confidence",
                "observationType",
              ],
            },
          },
          constraintChecks: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                constraint: { type: Type.STRING },
                mandatory: { type: Type.BOOLEAN },
                verdict: {
                  type: Type.STRING,
                  description: "One of: PASS, FAIL, UNKNOWN",
                },
                reason: { type: Type.STRING },
                evidenceSource: { type: Type.STRING },
                imageIndex: {
                  type: Type.INTEGER,
                  description: "1-based gallery image number if sourced from a photo, else 0.",
                },
              },
              required: [
                "constraint",
                "mandatory",
                "verdict",
                "reason",
                "evidenceSource",
                "imageIndex",
              ],
            },
          },
          spatialCompatibilityNote: {
            type: Type.STRING,
            description: "Concise assessment of aesthetic and spatial fit with the user's space.",
          },
        },
        required: [
          "extractedAttributes",
          "constraintChecks",
          "spatialCompatibilityNote",
        ],
      },
    },
  });

  const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
  const rawJson = (response.text ?? "").trim();
  if (!rawJson) {
    throw new Error("Gemini 4 Neon returned an empty product evidence response.");
  }

  const parsed = JSON.parse(rawJson) as Record<string, unknown>;

  const validSourceTypes = new Set<ExtractedProductAttribute["sourceType"]>([
    "listing_text",
    "variant_option",
    "product_image_diagram",
    "product_image_visual",
  ]);

  const extractedAttributes: ExtractedProductAttribute[] = Array.isArray(
    parsed.extractedAttributes,
  )
    ? parsed.extractedAttributes
        .filter((a): a is Record<string, unknown> => Boolean(a && typeof a === "object"))
        .map((a) => ({
          attributeName: String(a.attributeName ?? "").trim() || "Specification",
          extractedValue: String(a.extractedValue ?? "").trim(),
          unit:
            typeof a.unit === "string" && a.unit.trim() ? a.unit.trim() : null,
          sourceType: validSourceTypes.has(
            a.sourceType as ExtractedProductAttribute["sourceType"],
          )
            ? (a.sourceType as ExtractedProductAttribute["sourceType"])
            : "listing_text",
          sourceCitation: String(a.sourceCitation ?? "Merchant listing").trim(),
          imageIndex:
            typeof a.imageIndex === "number" && a.imageIndex > 0
              ? a.imageIndex
              : null,
          confidence:
            typeof a.confidence === "number"
              ? Math.max(0, Math.min(1, a.confidence))
              : 0.8,
          observationType:
            a.observationType === "inferred"
              ? ("inferred" as const)
              : ("directly_observed" as const),
        }))
        .filter((a) => Boolean(a.extractedValue))
    : [];

  const validVerdicts = new Set<ConstraintVerdict>(["PASS", "FAIL", "UNKNOWN"]);
  const neonChecks: ConstraintVerificationCheck[] = Array.isArray(parsed.constraintChecks)
    ? parsed.constraintChecks
        .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === "object"))
        .map((c) => ({
          constraint: String(c.constraint ?? "").trim(),
          mandatory: Boolean(c.mandatory),
          verdict: validVerdicts.has(c.verdict as ConstraintVerdict)
            ? (c.verdict as ConstraintVerdict)
            : "UNKNOWN",
          reason: String(c.reason ?? "").trim(),
          evidenceSource: String(c.evidenceSource ?? "Product listing").trim(),
          imageIndex:
            typeof c.imageIndex === "number" && c.imageIndex > 0
              ? c.imageIndex
              : null,
        }))
        .filter((c) => Boolean(c.constraint))
    : [];

  const allChecks = [...deterministicChecks, ...neonChecks];
  const mandatoryChecks = allChecks.filter((c) => c.mandatory);

  let verificationStatus: VerificationStatus;
  let statusSummary: string;

  const failedMandatory = mandatoryChecks.filter((c) => c.verdict === "FAIL");
  const unknownMandatory = mandatoryChecks.filter((c) => c.verdict === "UNKNOWN");

  if (failedMandatory.length > 0) {
    verificationStatus = "REJECTED";
    statusSummary = `Violates ${failedMandatory.length} mandatory ${
      failedMandatory.length === 1 ? "constraint" : "constraints"
    }: ${failedMandatory.map((c) => c.constraint).join(", ")}.`;
  } else if (unknownMandatory.length > 0) {
    verificationStatus = "UNCERTAIN";
    statusSummary = `Missing verifiable evidence for: ${unknownMandatory
      .map((c) => c.constraint)
      .join(", ")}.`;
  } else if (mandatoryChecks.length > 0) {
    verificationStatus = "VERIFIED";
    statusSummary = `All ${mandatoryChecks.length} mandatory ${
      mandatoryChecks.length === 1 ? "constraint" : "constraints"
    } passed with supporting evidence.`;
  } else if (extractedAttributes.length > 0) {
    verificationStatus = "VERIFIED";
    statusSummary =
      "Product specifications extracted; no hard constraints were violated.";
  } else {
    verificationStatus = "UNCERTAIN";
    statusSummary =
      "Limited specification evidence in listing text and photos; add constraints or check seller page.";
  }

  const result: ProductEvidenceResult = {
    model: "gemini-4-neon",
    productId: product.id,
    variantId: variant?.id ?? null,
    verificationStatus,
    statusSummary,
    extractedAttributes,
    constraintChecks: allChecks,
    spatialCompatibilityNote:
      typeof parsed.spatialCompatibilityNote === "string" &&
      parsed.spatialCompatibilityNote.trim()
        ? parsed.spatialCompatibilityNote.trim()
        : "Evaluated against available listing and visual evidence.",
    inspectedImageCount: validImages.length,
    cached: false,
    latencyMs,
  };

  if (productEvidenceCache.size >= EVIDENCE_CACHE_MAX) {
    const oldestKey = productEvidenceCache.keys().next().value;
    if (oldestKey !== undefined) {
      productEvidenceCache.delete(oldestKey);
    }
  }
  productEvidenceCache.set(cacheKey, result);

  return result;
}
