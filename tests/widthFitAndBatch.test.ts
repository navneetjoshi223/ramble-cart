import { describe, expect, it } from "vitest";
import type {
  BatchShelfFitEntry,
  NormalizedProduct,
  ProductEvidenceResult,
} from "../src/types";
import { MM_PER_INCH } from "../src/utils/spatialCalibration";
import {
  convertToMillimeters,
  createSkippedMeasurementEvaluation,
  detectPhysicalFitIntent,
  evaluateShelfWidthFit,
  evaluateSpatialLimitFit,
  extractDimensionFromClause,
  extractSelectedVariantDimension,
  extractSelectedVariantWidth,
  parseNumericMeasurement,
  parseSpokenDimensionLimit,
  stripSpokenDimensionPhrase,
} from "../src/utils/widthFitCheck";
import {
  orderProductsForViewMode,
  runBoundedVerificationBatch,
} from "../src/utils/batchVerifyQueue";

function makeProduct(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    id: overrides.id ?? "gid://shopify/Product/1",
    title: overrides.title ?? "Test Product",
    handle: "test-product",
    descriptionText: overrides.descriptionText ?? "",
    features: overrides.features ?? [],
    rating: null,
    media: [],
    options: overrides.options ?? [],
    selectedOptions: overrides.selectedOptions ?? [],
    primaryVariant: overrides.primaryVariant ?? {
      id: "gid://shopify/ProductVariant/10",
      title: "Default Title",
      url: "https://example.com/products/test",
      price: { amountMinor: 4500, currency: "USD", formatted: "$45.00" },
      available: true,
      selectedOptions: overrides.selectedOptions ?? [],
      seller: { id: "s1", name: "Merchant", url: "https://example.com", domain: "example.com" },
      media: [],
      condition: null,
    },
    variants: overrides.variants ?? [],
  };
}

describe("widthFitCheck — units, spoken limits, variant extraction & verdict boundaries", () => {
  it("parses decimals, fractions, mixed fractions, and converts mm/cm/m/in/ft cleanly", () => {
    expect(parseNumericMeasurement("23.6")).toBeCloseTo(23.6, 5);
    expect(parseNumericMeasurement("23 5/8")).toBeCloseTo(23.625, 5);
    expect(parseNumericMeasurement("19-1/2")).toBeCloseTo(19.5, 5);
    expect(parseNumericMeasurement("3/4")).toBeCloseTo(0.75, 5);

    expect(convertToMillimeters(600, "mm")).toBeCloseTo(600, 4);
    expect(convertToMillimeters(60, "cm")).toBeCloseTo(600, 4);
    expect(convertToMillimeters(0.6, "m")).toBeCloseTo(600, 4);
    expect(convertToMillimeters(20, "in")).toBeCloseTo(20 * MM_PER_INCH, 4);
    expect(convertToMillimeters(20, '"')).toBeCloseTo(20 * MM_PER_INCH, 4);
    expect(convertToMillimeters(2, "ft")).toBeCloseTo(24 * MM_PER_INCH, 4);
  });

  it("extracts product width/height/depth while rejecting shipping and box dimensions", () => {
    expect(extractDimensionFromClause("Shipping Width: 28 in", "width")).toBeNull();
    expect(extractDimensionFromClause("Package dimensions (W x D x H): 70 x 30 x 15 cm", "width")).toBeNull();

    const w = extractDimensionFromClause("Overall Width: 23 1/2 in", "width");
    expect(w).not.toBeNull();
    expect(w!.mm / MM_PER_INCH).toBeCloseTo(23.5, 4);

    const tupleW = extractDimensionFromClause("Dimensions (W x D x H): 60 x 24 x 12 cm", "width");
    const tupleD = extractDimensionFromClause("Dimensions (W x D x H): 60 x 24 x 12 cm", "depth");
    const tupleH = extractDimensionFromClause("Dimensions (W x D x H): 60 x 24 x 12 cm", "height");
    expect(tupleW!.mm).toBeCloseTo(600, 3);
    expect(tupleD!.mm).toBeCloseTo(240, 3);
    expect(tupleH!.mm).toBeCloseTo(120, 3);
  });

  it("parses spoken limits ('at most 20 inches wide') to skip the card step and strips them from catalog queries", () => {
    const spokenW = parseSpokenDimensionLimit("Find a walnut monitor stand, at most 20 inches wide");
    expect(spokenW).not.toBeNull();
    expect(spokenW?.source).toBe("spoken");
    expect(spokenW?.axis).toBe("width");
    expect(spokenW?.maxInches).toBeCloseTo(20.0, 4);
    expect(spokenW?.clearanceInches).toBe(0);

    const spokenCm = parseSpokenDimensionLimit("Nothing wider than 50 cm please");
    expect(spokenCm?.axis).toBe("width");
    expect(spokenCm?.maxMm).toBeCloseTo(500, 3);

    const spokenH = parseSpokenDimensionLimit("Ceramic vase under 12 inches tall");
    expect(spokenH?.axis).toBe("height");
    expect(spokenH?.maxInches).toBeCloseTo(12.0, 4);

    expect(
      stripSpokenDimensionPhrase("matte black monitor stand, at most 20 inches wide"),
    ).toBe("matte black monitor stand");
  });

  it("detects unmeasured physical-fit questions across desk gaps, walls, and shelves", () => {
    expect(
      detectPhysicalFitIntent({
        rambleText: "Will this speaker fit in my desk gap?",
      }),
    ).toEqual({ requested: true, suggestedAxis: "width" });

    expect(
      detectPhysicalFitIntent({
        rambleText: "Nothing taller than this shelf",
      }),
    ).toEqual({ requested: true, suggestedAxis: "height" });

    expect(
      detectPhysicalFitIntent({
        rambleText: "ceramic coffee dripper under $40",
      }).requested,
    ).toBe(false);
  });

  it("extracts dimension for the selected variant only and links Neon photo diagram evidence", () => {
    // Multi-size product: selected 36" x 10" must extract 36", not 24"
    const variantProduct = makeProduct({
      options: [{ name: "Size", values: ['24" x 10"', '36" x 10"'] }],
      selectedOptions: [{ name: "Size", label: '36" x 10"' }],
    });
    const variantWidth = extractSelectedVariantWidth(variantProduct, null);
    expect(variantWidth?.sourceKind).toBe("variant_option");
    expect(variantWidth?.widthInches).toBeCloseTo(36.0, 3);

    // Shelf with parenthesized unit "Length (cm): 70" extracts 700 mm width, while USB cable "Length: 6 ft" is rejected
    const cmShelf = makeProduct({
      title: "Rustic Floating Shelf",
      selectedOptions: [{ name: "Length (cm)", label: "70" }],
    });
    expect(extractSelectedVariantWidth(cmShelf, null)?.widthMm).toBeCloseTo(700, 3);

    const usbCable = makeProduct({
      title: "Braided USB-C Charging Cable",
      selectedOptions: [{ name: "Length", label: "6 ft" }],
    });
    expect(extractSelectedVariantWidth(usbCable, null)).toBeNull();

    // Multi-size product with ambiguous generic description and non-numeric size labels -> returns null unless Neon observes it
    const ambiguousMulti = makeProduct({
      options: [{ name: "Size", values: ["Small", "Large"] }],
      selectedOptions: [{ name: "Size", label: "Large" }],
      descriptionText: "Width: 18 in or Width: 28 in depending on size.",
    });
    expect(extractSelectedVariantWidth(ambiguousMulti, null)).toBeNull();

    // Directly observed Neon photo diagram on image #2 is extracted & linked
    const neonEvidence: ProductEvidenceResult = {
      model: "gemini-4-neon",
      productId: ambiguousMulti.id,
      variantId: ambiguousMulti.primaryVariant!.id,
      verificationStatus: "VERIFIED",
      statusSummary: "Dimension diagram inspected",
      extractedAttributes: [
        {
          attributeName: "Product Width",
          extractedValue: "28",
          unit: "in",
          sourceType: "product_image_diagram",
          sourceCitation: "Photo #2 dimension callout for Large",
          imageIndex: 2,
          confidence: 0.96,
          observationType: "directly_observed",
        },
      ],
      constraintChecks: [],
      spatialCompatibilityNote: "",
      inspectedImageCount: 3,
      cached: false,
      latencyMs: 420,
    };

    const fromNeon = extractSelectedVariantDimension(ambiguousMulti, neonEvidence, "width");
    expect(fromNeon?.sourceKind).toBe("neon_photo");
    expect(fromNeon?.imageIndex).toBe(2);
    expect(fromNeon?.widthInches).toBeCloseTo(28.0, 3);
  });

  it("enforces exact verdict boundaries for Width fits, Too close to confirm, Too wide, Width unknown, and Fit unknown", () => {
    const shelf = {
      minWidthInches: 24.0,
      nominalWidthInches: 24.5,
      maxWidthInches: 25.0,
    };

    const docAtMinBoundary = {
      axis: "width" as const,
      widthInches: 23.5, // + 0.5 clearance = 24.0 === minWidthInches -> Width fits
      widthMm: 23.5 * MM_PER_INCH,
      rawText: "23.5 in",
      sourceKind: "listing_text" as const,
      sourceLabel: "Merchant listing text",
      citationText: "Width: 23.5 in",
      imageIndex: null,
    };
    expect(
      evaluateShelfWidthFit({
        shelf,
        documentedWidth: docAtMinBoundary,
        clearanceInches: 0.5,
      }).verdict,
    ).toBe("Width fits");

    const docInsideUncertainty = {
      ...docAtMinBoundary,
      widthInches: 24.2, // + 0.5 = 24.7 in (inside 24.0..25.0) -> Too close to confirm
      widthMm: 24.2 * MM_PER_INCH,
    };
    expect(
      evaluateShelfWidthFit({
        shelf,
        documentedWidth: docInsideUncertainty,
        clearanceInches: 0.5,
      }).verdict,
    ).toBe("Too close to confirm");

    const docAtMaxBoundary = {
      ...docAtMinBoundary,
      widthInches: 24.5, // + 0.5 = 25.0 === maxWidthInches -> Too close to confirm
      widthMm: 24.5 * MM_PER_INCH,
    };
    expect(
      evaluateShelfWidthFit({
        shelf,
        documentedWidth: docAtMaxBoundary,
        clearanceInches: 0.5,
      }).verdict,
    ).toBe("Too close to confirm");

    const docOverMax = {
      ...docAtMinBoundary,
      widthInches: 24.6, // + 0.5 = 25.1 > 25.0 -> Too wide
      widthMm: 24.6 * MM_PER_INCH,
    };
    expect(
      evaluateShelfWidthFit({
        shelf,
        documentedWidth: docOverMax,
        clearanceInches: 0.5,
      }).verdict,
    ).toBe("Too wide");

    expect(
      evaluateShelfWidthFit({
        shelf,
        documentedWidth: null,
        clearanceInches: 0.5,
      }).verdict,
    ).toBe("Width unknown");

    // Spoken limit (20.0 in, 0 clearance): 20.0 fits, 20.1 Too wide
    const spokenLimit = parseSpokenDimensionLimit("at most 20 inches wide")!;
    expect(
      evaluateSpatialLimitFit({
        limit: spokenLimit,
        documentedDimension: { ...docAtMinBoundary, widthInches: 20.0, widthMm: 20 * MM_PER_INCH },
      }).verdict,
    ).toBe("Width fits");
    expect(
      evaluateSpatialLimitFit({
        limit: spokenLimit,
        documentedDimension: { ...docAtMinBoundary, widthInches: 20.2, widthMm: 20.2 * MM_PER_INCH },
      }).verdict,
    ).toBe("Too wide");

    // Skipped measurement -> Fit unknown
    expect(createSkippedMeasurementEvaluation("width", docAtMinBoundary).verdict).toBe(
      "Fit unknown",
    );
  });
});

describe("batchVerifyQueue — bounded concurrency, stale discarding & Standard/SceneCart ordering", () => {
  it("caps in-flight concurrency strictly to maxConcurrent = 2 across 5 products", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const currentRunId = 1;
    const controller = new AbortController();

    const results = await runBoundedVerificationBatch({
      items: ["p1", "p2", "p3", "p4", "p5"],
      maxConcurrent: 2,
      runId: currentRunId,
      getCurrentRunId: () => currentRunId,
      signal: controller.signal,
      worker: async (item) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 18));
        inFlight -= 1;
        return `checked:${item}`;
      },
    });

    expect(peakInFlight).toBeLessThanOrEqual(2);
    expect(peakInFlight).toBe(2);
    expect(results).toEqual([
      "checked:p1",
      "checked:p2",
      "checked:p3",
      "checked:p4",
      "checked:p5",
    ]);
  });

  it("discards stale batch runs when runId advances or AbortSignal aborts", async () => {
    let activeRunId = 7;
    const controller = new AbortController();
    const resolvedCallbacks: string[] = [];

    const batchPromise = runBoundedVerificationBatch({
      items: ["p1", "p2", "p3", "p4"],
      maxConcurrent: 2,
      runId: 7,
      getCurrentRunId: () => activeRunId,
      signal: controller.signal,
      worker: async (item, idx) => {
        await new Promise((r) => setTimeout(r, idx === 0 ? 5 : 30));
        if (idx === 0) {
          // Simulate a newer search/calibration arriving after p1 resolves
          activeRunId = 8;
        }
        return item;
      },
      onItemResolved: (res) => {
        resolvedCallbacks.push(res);
      },
    });

    const finalOut = await batchPromise;
    expect(finalOut).toBeNull();
    expect(resolvedCallbacks).toHaveLength(0);
  });

  it("preserves 100% original Shopify ranking in Standard mode and stable-sorts top 5 in SceneCart mode", () => {
    const products = ["p1", "p2", "p3", "p4", "p5", "p6"].map((id) =>
      makeProduct({ id, title: `Item ${id}` }),
    );

    const makeEntry = (
      id: string,
      verdict:
        | "Width fits"
        | "Too wide"
        | "Too close to confirm"
        | "Width unknown",
    ): BatchShelfFitEntry => ({
      productId: id,
      variantId: "v1",
      status: "ready",
      productDetail: null,
      neonEvidence: null,
      fitEvaluation: {
        axis: "width",
        verdict,
        documentedWidth: null,
        clearanceInches: 0.5,
        requiredWidthInches: null,
        shelfMinInches: 20,
        shelfMaxInches: 21,
        shelfNominalInches: 20.5,
        marginToMinInches: null,
        explanation: "",
      },
    });

    const entries: Record<string, BatchShelfFitEntry> = {
      p1: makeEntry("p1", "Too wide"),
      p2: makeEntry("p2", "Width unknown"),
      p3: makeEntry("p3", "Width fits"),
      p4: makeEntry("p4", "Too close to confirm"),
      p5: makeEntry("p5", "Width fits"),
    };

    const standardOrder = orderProductsForViewMode({
      products,
      entriesByProductId: entries,
      viewMode: "standard",
      checkedLimit: 5,
    }).map((p) => p.id);
    expect(standardOrder).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);

    const sceneCartOrder = orderProductsForViewMode({
      products,
      entriesByProductId: entries,
      viewMode: "scenecart",
      checkedLimit: 5,
    }).map((p) => p.id);
    // p3 and p5 both fit (preserving p3 before p5), then p4 (Too close), p2 (Width unknown), p1 (Too wide), followed by unchecked p6
    expect(sceneCartOrder).toEqual(["p3", "p5", "p4", "p2", "p1", "p6"]);
  });
});
