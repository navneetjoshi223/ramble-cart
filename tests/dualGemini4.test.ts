import { beforeEach, describe, expect, it, vi } from "vitest";
import { interpretSpaceAndRamble } from "../server/geminiAgent";
import {
  clearProductEvidenceCache,
  extractProductEvidenceWithNeon,
  isSafePublicHttpsImageUrl,
} from "../server/neonAgent";
import type { NormalizedProduct } from "../src/types";

function makeSampleProduct(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    id: "gid://shopify/Product/9901",
    title: "Matte Black Steel Monitor Stand",
    handle: "matte-black-steel-monitor-stand",
    descriptionText: "Powder-coated steel riser with non-slip silicone pads.",
    features: ["Powder-coated steel", "Supports 40 lbs"],
    rating: { value: 4.8, scaleMax: 5, count: 84 },
    media: [
      {
        url: "https://cdn.shopify.com/s/files/1/0001/hero.jpg",
        altText: "Front hero view",
        width: 1000,
        height: 800,
      },
      {
        url: "https://cdn.shopify.com/s/files/1/0001/dimensions.jpg",
        altText: "Dimension diagram 23.6 in x 9.5 in x 4.2 in",
        width: 1000,
        height: 800,
      },
      {
        url: "https://cdn.shopify.com/s/files/1/0001/detail.jpg",
        altText: "Side steel thickness",
        width: 1000,
        height: 800,
      },
    ],
    options: [{ name: "Finish", values: ["Matte Black"] }],
    selectedOptions: [{ name: "Finish", label: "Matte Black" }],
    primaryVariant: {
      id: "gid://shopify/ProductVariant/8801",
      title: "Matte Black",
      url: "https://deskcraft.example.com/products/monitor-stand?variant=8801",
      price: {
        amountMinor: 4500,
        currency: "USD",
        formatted: "$45.00",
      },
      available: true,
      selectedOptions: [{ name: "Finish", label: "Matte Black" }],
      seller: {
        id: "seller-1",
        name: "DeskCraft",
        url: "https://deskcraft.example.com",
        domain: "deskcraft.example.com",
      },
      media: [],
      condition: "new",
    },
    variants: [],
    ...overrides,
  };
}

describe("Dual Gemini 4 Architecture (Hydrogen + Neon)", () => {
  beforeEach(() => {
    clearProductEvidenceCache();
  });

  it("enforces SSRF-safe public HTTPS checks for remote merchant product images", () => {
    expect(
      isSafePublicHttpsImageUrl("https://cdn.shopify.com/s/files/1/0001/dimensions.jpg"),
    ).toBe(true);
    expect(isSafePublicHttpsImageUrl("http://cdn.shopify.com/s/files/1/hero.jpg")).toBe(
      false,
    );
    expect(isSafePublicHttpsImageUrl("https://localhost:3000/secret.png")).toBe(false);
    expect(isSafePublicHttpsImageUrl("https://127.0.0.1/image.jpg")).toBe(false);
    expect(isSafePublicHttpsImageUrl("https://169.254.169.254/latest/meta-data")).toBe(
      false,
    );
    expect(isSafePublicHttpsImageUrl("https://10.0.0.8/internal.png")).toBe(false);
    expect(isSafePublicHttpsImageUrl("https://192.168.1.25/router.jpg")).toBe(false);
    expect(isSafePublicHttpsImageUrl("https://[::1]/loopback.png")).toBe(false);
  });

  it("runs Hydrogen (gemini-4-hydrogen) and Neon (gemini-4-neon) concurrently when video frames and speech are present", async () => {
    const hydrogenCalls: Array<Record<string, unknown>> = [];
    const neonCalls: Array<Record<string, unknown>> = [];

    const mockHydrogen = {
      models: {
        generateContent: vi.fn(async (params: Record<string, unknown>) => {
          hydrogenCalls.push(params);
          return {
            text: JSON.stringify({
              productCategory: "monitor stand",
              shoppingIntent:
                "Matte black metal monitor stand under $50 with no wood or plastic.",
              searchQuery: "matte black metal monitor stand",
              maximumBudget: 50,
              currency: "USD",
              requiredAttributes: ["matte black", "metal"],
              excludedAttributes: ["wood", "plastic"],
              preferredAttributes: [],
              functionalRequirements: [],
              maxWidthInches: 26,
              maxHeightInches: 0,
              maxDepthInches: 0,
              dimensionalRawText: "",
              supersededConstraints: ["wood"],
              unresolvedConstraints: [],
              confidence: 0.94,
              clarificationQuestion: "",
            }),
          };
        }),
      },
    };

    const mockNeon = {
      models: {
        generateContent: vi.fn(async (params: Record<string, unknown>) => {
          neonCalls.push(params);
          return {
            text: JSON.stringify({
              targetSpace: "dark walnut work desk",
              sceneDescription:
                "Dark walnut desk with matte black task lamp and 27-inch monitor.",
              existingObjects: ["monitor", "black desk lamp"],
              usableRegion: "center clearance beneath monitor",
              dominantColors: ["walnut brown", "matte black"],
              visibleMaterials: ["walnut wood", "powder-coated metal"],
              aestheticStyle: "warm mid-century walnut with industrial black accents",
              referenceObject: "",
              calibrationStatus: "uncalibrated",
              estimatedWidthRangeInches: "24-28 in",
              estimatedHeightRangeInches: "",
              estimatedDepthRangeInches: "8-11 in",
              measurementConfidence: "low",
              measurementLimitations:
                "Uncalibrated single-angle view; place a reference card for exact fit.",
              additionalViewRequired: false,
              suggestedStyleKeywords: ["industrial", "matte black"],
            }),
          };
        }),
      },
    };

    const result = await interpretSpaceAndRamble(
      {
        videoFrames: ["base64frame1", "base64frame2"],
        mimeType: "image/jpeg",
        rambleText:
          "I need a monitor stand under $50, preferably wood. Actually, forget wood. Matte black metal, no plastic, max 26 inches wide.",
        hasSpokenTranscript: true,
      },
      {
        hydrogenClient: mockHydrogen,
        neonClient: mockNeon,
      },
    );

    expect(hydrogenCalls).toHaveLength(1);
    expect(neonCalls).toHaveLength(1);
    expect(hydrogenCalls[0].model).toBe("gemini-4-hydrogen");
    expect(neonCalls[0].model).toBe("gemini-4-neon");

    expect(result.searchQuery).toBe("matte black metal monitor stand");
    expect(result.maxPriceUsd).toBe(50);
    expect(result.supersededConstraints).toEqual(["wood"]);
    expect(result.hydrogenIntent?.model).toBe("gemini-4-hydrogen");
    expect(result.neonSpatial?.model).toBe("gemini-4-neon");
    expect(result.neonSpatial?.targetSpace).toBe("dark walnut work desk");
    expect(
      result.activeConstraints.some(
        (c) => c.kind === "spatial" && c.text === "dark walnut work desk",
      ),
    ).toBe(true);
    expect(
      result.activeConstraints.some(
        (c) => c.kind === "excluded" && c.text === "no plastic",
      ),
    ).toBe(true);
  });

  it("extracts photo diagram specs with Neon, marks missing mandatory evidence UNCERTAIN, and caches results", async () => {
    const requestedUrls: string[] = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": "4",
        },
      });
    }) as unknown as typeof fetch;

    const mockNeon = {
      models: {
        generateContent: vi.fn(async () => ({
          text: JSON.stringify({
            extractedAttributes: [
              {
                attributeName: "Width",
                extractedValue: "23.6",
                unit: "in",
                sourceType: "product_image_diagram",
                sourceCitation: "Dimension callout in gallery image #2",
                imageIndex: 2,
                confidence: 0.96,
                observationType: "directly_observed",
              },
            ],
            constraintChecks: [
              {
                constraint: "no drilling",
                mandatory: true,
                verdict: "UNKNOWN",
                reason:
                  "Neither listing text nor attached product photos confirm drill-free adhesive mounting.",
                evidenceSource: "Merchant listing & photos",
                imageIndex: 0,
              },
            ],
            spatialCompatibilityNote:
              "Matte black steel matches the industrial desk lamp finish.",
          }),
        })),
      },
    };

    const product = makeSampleProduct();
    const first = await extractProductEvidenceWithNeon(
      {
        product,
        activeConstraints: [
          { text: "under $50", kind: "required" },
          { text: "no drilling", kind: "required" },
        ],
        maxPriceUsd: 50,
        fetchImpl: mockFetch,
      },
      mockNeon,
    );

    // Prioritizes gallery images 2 and 3 (diagrams) + image 1 (hero finish)
    expect(requestedUrls[0]).toContain("dimensions.jpg");
    expect(first.model).toBe("gemini-4-neon");
    expect(first.inspectedImageCount).toBe(3);
    // Budget ($45 <= $50) passes deterministically, while "no drilling" is UNKNOWN -> UNCERTAIN (never falsely VERIFIED)
    expect(first.verificationStatus).toBe("UNCERTAIN");
    expect(first.constraintChecks[0].verdict).toBe("PASS");
    expect(first.constraintChecks[1].verdict).toBe("UNKNOWN");
    expect(first.extractedAttributes[0].imageIndex).toBe(2);
    expect(first.cached).toBe(false);

    // Second call with identical inputs hits in-session cache without re-calling Neon
    const second = await extractProductEvidenceWithNeon(
      {
        product,
        activeConstraints: [
          { text: "under $50", kind: "required" },
          { text: "no drilling", kind: "required" },
        ],
        maxPriceUsd: 50,
        fetchImpl: mockFetch,
      },
      mockNeon,
    );
    expect(second.cached).toBe(true);
    expect(mockNeon.models.generateContent).toHaveBeenCalledTimes(1);

    // Deterministic budget violation -> REJECTED even when Neon checks pass
    const overBudget = await extractProductEvidenceWithNeon(
      {
        product,
        activeConstraints: [{ text: "under $35", kind: "required" }],
        maxPriceUsd: 35,
        fetchImpl: mockFetch,
      },
      {
        models: {
          generateContent: vi.fn(async () => ({
            text: JSON.stringify({
              extractedAttributes: [],
              constraintChecks: [],
              spatialCompatibilityNote: "Fits desk style.",
            }),
          })),
        },
      },
    );
    expect(overBudget.verificationStatus).toBe("REJECTED");
    expect(overBudget.constraintChecks[0].verdict).toBe("FAIL");
  });
});
