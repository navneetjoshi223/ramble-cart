import { useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  X,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Clock,
  Star,
  ScanSearch,
} from "lucide-react";
import type {
  ActiveConstraint,
  ConstraintVerdict,
  GetProductResult,
  NormalizedOptionSelection,
  NormalizedProduct,
  ProductEvidenceResult,
  VerificationStatus,
} from "../types";
import { ProductImage } from "./ProductImage";
import { safeFetchJson } from "../utils/safeFetchJson";

interface ProductDetailModalProps {
  product: NormalizedProduct | null;
  country: string;
  currency: string;
  activeConstraints?: ActiveConstraint[];
  maxPriceUsd?: number | null;
  spatialSummary?: string | null;
  onClose: () => void;
}

function getStatusPresentation(status: VerificationStatus) {
  switch (status) {
    case "VERIFIED":
      return {
        label: "VERIFIED FIT",
        textClass: "text-[#14532D]",
        surfaceClass: "bg-[#FAF9F6] border-[#E7E5E0]",
        Icon: CheckCircle2,
      };
    case "REJECTED":
      return {
        label: "CONSTRAINT VIOLATION",
        textClass: "text-[#991B1B]",
        surfaceClass: "bg-[#FEF2F2] border-[#FECACA]",
        Icon: AlertCircle,
      };
    case "UNCERTAIN":
    default:
      return {
        label: "UNCERTAIN · UNVERIFIED SPEC",
        textClass: "text-[#9A3412]",
        surfaceClass: "bg-[#FFF7ED] border-[#FED7AA]",
        Icon: HelpCircle,
      };
  }
}

function getVerdictTextClass(verdict: ConstraintVerdict): string {
  switch (verdict) {
    case "PASS":
      return "text-[#14532D]";
    case "FAIL":
      return "text-[#991B1B]";
    case "UNKNOWN":
    default:
      return "text-[#9A3412]";
  }
}

function formatSourceType(sourceType: string): string {
  switch (sourceType) {
    case "product_image_diagram":
      return "Photo diagram";
    case "product_image_visual":
      return "Product photo";
    case "variant_option":
      return "Variant option";
    case "listing_text":
    default:
      return "Listing text";
  }
}

export function ProductDetailModal({
  product,
  country,
  currency,
  activeConstraints = [],
  maxPriceUsd = null,
  spatialSummary = null,
  onClose,
}: ProductDetailModalProps) {
  const [liveDetails, setLiveDetails] = useState<GetProductResult | null>(null);
  const [selectedOptions, setSelectedOptions] = useState<NormalizedOptionSelection[]>([]);
  const [selectedImageIdx, setSelectedImageIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [evidence, setEvidence] = useState<ProductEvidenceResult | null>(null);
  const [verifyingEvidence, setVerifyingEvidence] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const evidenceAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!product) {
      setLiveDetails(null);
      setSelectedOptions([]);
      setSelectedImageIdx(0);
      setError(null);
      setEvidence(null);
      setEvidenceError(null);
      return;
    }

    const initialSelection =
      product.selectedOptions.length > 0
        ? product.selectedOptions
        : product.options
            .map((o) => ({ name: o.name, label: o.values[0] }))
            .filter((o) => o.label);

    setSelectedOptions(initialSelection);
    setSelectedImageIdx(0);
    setLiveDetails(null);
    setError(null);
    setEvidence(null);
    setEvidenceError(null);

    void fetchProductCombination(product.id, initialSelection);

    return () => {
      abortRef.current?.abort();
      evidenceAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id, country, currency]);

  const hasAutoVerifyTargets =
    activeConstraints.length > 0 ||
    (typeof maxPriceUsd === "number" && maxPriceUsd > 0);

  // Automatically verify with Gemini 4 Neon when live variant details arrive and constraints exist
  useEffect(() => {
    if (!liveDetails?.product || !hasAutoVerifyTargets) return;
    void runNeonEvidenceVerification(liveDetails.product);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    liveDetails?.product.id,
    liveDetails?.product.primaryVariant?.id,
    hasAutoVerifyTargets,
  ]);

  async function fetchProductCombination(
    productId: string,
    selection: NormalizedOptionSelection[],
  ) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const data = await safeFetchJson<GetProductResult>("/api/shop/product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: productId,
          country,
          currency,
          selected: selection.length > 0 ? selection : undefined,
        }),
        signal: controller.signal,
      });
      setLiveDetails(data);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to confirm product details.");
    } finally {
      if (abortRef.current === controller) {
        setLoading(false);
      }
    }
  }

  async function runNeonEvidenceVerification(targetProduct: NormalizedProduct) {
    evidenceAbortRef.current?.abort();
    const controller = new AbortController();
    evidenceAbortRef.current = controller;

    setVerifyingEvidence(true);
    setEvidenceError(null);

    try {
      const res = await safeFetchJson<ProductEvidenceResult>(
        "/api/shop/product/evidence",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            product: targetProduct,
            activeConstraints,
            maxPriceUsd,
            spatialSummary,
          }),
          signal: controller.signal,
        },
      );
      setEvidence(res);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setEvidenceError(
        err instanceof Error
          ? err.message
          : "Could not verify product photos and specifications.",
      );
    } finally {
      if (evidenceAbortRef.current === controller) {
        setVerifyingEvidence(false);
      }
    }
  }

  if (!product) return null;

  const activeProduct = liveDetails?.product ?? product;
  const activeVariant = activeProduct.primaryVariant;
  const activeSelection =
    activeProduct.selectedOptions.length > 0
      ? activeProduct.selectedOptions
      : selectedOptions;

  const galleryMedia =
    activeProduct.media.length > 0
      ? activeProduct.media
      : activeVariant?.media ?? [];

  const boundedImageIdx =
    selectedImageIdx >= 0 && selectedImageIdx < galleryMedia.length
      ? selectedImageIdx
      : 0;

  const heroImage =
    galleryMedia[boundedImageIdx]?.url ??
    activeVariant?.media[0]?.url ??
    activeProduct.media[0]?.url ??
    "";
  const heroAlt =
    galleryMedia[boundedImageIdx]?.altText ??
    activeVariant?.media[0]?.altText ??
    activeProduct.media[0]?.altText ??
    activeProduct.title;

  const availability = activeVariant?.available;
  const seller = activeVariant?.seller;
  const safeOfferUrl = activeVariant?.url ?? null;
  const safeSellerUrl = seller?.url ?? null;

  function handleOptionChange(optionName: string, label: string) {
    const nextSelection = activeProduct.options.map((opt) => {
      if (opt.name === optionName) {
        return { name: opt.name, label };
      }
      const existing = selectedOptions.find((s) => s.name === opt.name);
      return { name: opt.name, label: existing?.label ?? opt.values[0] ?? label };
    });
    setSelectedOptions(nextSelection);
    setEvidence(null);
    void fetchProductCombination(activeProduct.id, nextSelection);
  }

  function jumpToGalleryImage(imageIndex1Based: number) {
    const zeroBased = imageIndex1Based - 1;
    if (zeroBased >= 0 && zeroBased < galleryMedia.length) {
      setSelectedImageIdx(zeroBased);
    }
  }

  const fetchedTimeLabel = liveDetails?.fetchedAt
    ? new Date(liveDetails.fetchedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  const statusMeta = evidence
    ? getStatusPresentation(evidence.verificationStatus)
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 bg-black/45 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label={activeProduct.title}
    >
      <div className="relative w-full max-w-5xl max-h-[92vh] overflow-y-auto bg-white rounded-t-3xl sm:rounded-xl border border-[#E7E5E0] shadow-2xl grid grid-cols-1 md:grid-cols-2">
        <button
          type="button"
          onClick={onClose}
          className="sticky sm:absolute top-4 right-4 z-10 ml-auto m-3 sm:m-0 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg bg-white/95 text-[#18181B] border border-[#E7E5E0] hover:bg-[#F7F6F3] transition-colors"
          aria-label="Close product details"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="bg-[#F7F6F3] flex flex-col">
          <div className="relative aspect-[4/3] w-full overflow-hidden">
            <ProductImage
              src={heroImage}
              alt={heroAlt}
              className="w-full h-full object-cover"
            />
            {galleryMedia.length > 1 && (
              <div className="absolute bottom-2.5 left-2.5 px-2.5 py-1 rounded bg-black/70 text-white text-[11px] font-mono-tabular">
                Photo #{boundedImageIdx + 1} of {Math.min(galleryMedia.length, 4)}
              </div>
            )}
          </div>
          {galleryMedia.length > 1 && (
            <div className="grid grid-cols-4 gap-2 p-3 border-t border-[#E7E5E0]">
              {galleryMedia.slice(0, 4).map((m, idx) => {
                const isSelected = idx === boundedImageIdx;
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setSelectedImageIdx(idx)}
                    aria-label={`View product photo ${idx + 1}`}
                    className={`aspect-square rounded overflow-hidden bg-white border transition-colors ${
                      isSelected
                        ? "border-[#18181B] ring-1 ring-[#18181B]"
                        : "border-[#E7E5E0] hover:border-[#78716C]"
                    }`}
                  >
                    <ProductImage
                      src={m.url}
                      alt={m.altText || `${activeProduct.title} photo ${idx + 1}`}
                      className="w-full h-full object-cover"
                    />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="p-6 md:p-7 flex flex-col justify-between gap-5">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 pr-12 text-xs text-[#57534E]">
              <span className="uppercase tracking-wider">
                {seller?.name ?? "Independent Merchant"}
              </span>
              {activeProduct.rating && (
                <span className="flex items-center gap-1 font-mono-tabular text-[#18181B]">
                  <Star className="w-3.5 h-3.5 fill-[#18181B]" />
                  {activeProduct.rating.value.toFixed(1)}/{activeProduct.rating.scaleMax} (
                  {activeProduct.rating.count})
                </span>
              )}
            </div>

            <div className="flex items-baseline justify-between gap-4">
              <h2 className="font-display text-2xl font-medium text-[#18181B] leading-tight">
                {activeProduct.title}
              </h2>
              <span className="text-lg font-mono-tabular font-medium text-[#18181B] shrink-0">
                {activeVariant?.price?.formatted ?? "Price unavailable"}
              </span>
            </div>

            {/* Live option confirmation status */}
            <div className="flex flex-wrap items-center gap-3 text-xs pt-0.5">
              {loading ? (
                <span className="text-[#57534E]">Confirming selected combination...</span>
              ) : availability === true ? (
                <span className="text-[#1F4E3D] font-medium flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" />
                  In stock for {country}
                </span>
              ) : availability === false ? (
                <span className="text-[#991B1B] font-medium flex items-center gap-1.5">
                  <AlertCircle className="w-4 h-4" />
                  Out of stock in selected option
                </span>
              ) : (
                <span className="text-[#B45309] font-medium flex items-center gap-1.5">
                  <AlertCircle className="w-4 h-4" />
                  Stock status unconfirmed
                </span>
              )}

              {fetchedTimeLabel && (
                <span className="text-[#57534E] font-mono-tabular flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" />
                  Verified {fetchedTimeLabel}
                </span>
              )}
            </div>

            {error && (
              <p className="text-xs text-[#991B1B] bg-[#FEF2F2] border border-[#FECACA] rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            {liveDetails?.messages && liveDetails.messages.length > 0 && (
              <div className="text-xs text-[#57534E] bg-[#F7F6F3] border border-[#E7E5E0] rounded-lg px-3 py-2 space-y-1">
                {liveDetails.messages.map((m, i) => (
                  <p key={i}>{m.text}</p>
                ))}
              </div>
            )}

            {/* Gemini 4 Neon Multimodal Product Photo & Spec Verification */}
            <div
              data-testid="neon-evidence-section"
              className="pt-3 border-t border-[#E7E5E0] space-y-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold text-[#18181B]">
                  Photo &amp; Spec Verification (Gemini 4 Neon)
                </div>
                <button
                  type="button"
                  disabled={verifyingEvidence || loading}
                  onClick={() => void runNeonEvidenceVerification(activeProduct)}
                  className="min-h-[34px] px-3 py-1.5 rounded-lg border border-[#E7E5E0] bg-[#F7F6F3] hover:border-[#18181B] text-xs font-medium text-[#18181B] disabled:opacity-55 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
                >
                  <ScanSearch className="w-3.5 h-3.5 text-[#1F4E3D]" />
                  <span>
                    {verifyingEvidence
                      ? "Inspecting Photos & Specs..."
                      : evidence
                        ? "Re-verify Specs & Photos"
                        : "Verify Specs & Photos"}
                  </span>
                </button>
              </div>

              {verifyingEvidence && !evidence && (
                <p className="text-xs text-[#57534E]">
                  Inspecting merchant photos (dimension diagrams, size charts) and listing text with gemini-4-neon...
                </p>
              )}

              {evidenceError && (
                <p className="text-xs text-[#991B1B] bg-[#FEF2F2] border border-[#FECACA] rounded-lg px-3 py-2">
                  {evidenceError}
                </p>
              )}

              {evidence && statusMeta && (
                <div
                  data-testid="neon-evidence-result"
                  className={`rounded-lg border p-3 space-y-2.5 text-xs ${statusMeta.surfaceClass}`}
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span
                        className={`font-semibold flex items-center gap-1.5 ${statusMeta.textClass}`}
                      >
                        <statusMeta.Icon className="w-4 h-4 shrink-0" />
                        <span>{statusMeta.label}</span>
                      </span>
                      <span className="text-[11px] font-mono-tabular text-[#57534E]">
                        {evidence.model} · {evidence.inspectedImageCount}{" "}
                        {evidence.inspectedImageCount === 1 ? "photo" : "photos"} ·{" "}
                        {evidence.cached ? "cached" : `${evidence.latencyMs} ms`}
                      </span>
                    </div>
                    <p className="text-[#18181B]">{evidence.statusSummary}</p>
                    <p className="text-[#57534E]">{evidence.spatialCompatibilityNote}</p>
                  </div>

                  {evidence.constraintChecks.length > 0 && (
                    <div className="pt-2 border-t border-[#E7E5E0]/80 space-y-1.5">
                      <p className="text-[11px] font-semibold text-[#18181B]">
                        Constraint Checks
                      </p>
                      <div className="space-y-1.5">
                        {evidence.constraintChecks.map((check, i) => (
                          <div
                            key={`${check.constraint}-${i}`}
                            className="flex flex-col gap-0.5 text-[11px]"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-medium text-[#18181B]">
                                {check.constraint}
                                {check.mandatory ? "" : " (preferred)"}
                              </span>
                              <div className="flex items-center gap-2 font-mono-tabular">
                                <span
                                  className={`font-semibold ${getVerdictTextClass(
                                    check.verdict,
                                  )}`}
                                >
                                  {check.verdict}
                                </span>
                                {check.imageIndex &&
                                  check.imageIndex <= Math.min(galleryMedia.length, 4) && (
                                    <button
                                      type="button"
                                      onClick={() => jumpToGalleryImage(check.imageIndex!)}
                                      className="underline underline-offset-2 text-[#18181B] hover:text-[#1F4E3D] whitespace-nowrap"
                                    >
                                      Photo #{check.imageIndex}
                                    </button>
                                  )}
                              </div>
                            </div>
                            <p className="text-[#57534E]">
                              {check.reason} · Source: {check.evidenceSource}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {evidence.extractedAttributes.length > 0 && (
                    <div className="pt-2 border-t border-[#E7E5E0]/80 space-y-1.5">
                      <p className="text-[11px] font-semibold text-[#18181B]">
                        Extracted Specifications &amp; Photo Evidence
                      </p>
                      <div className="space-y-1">
                        {evidence.extractedAttributes.slice(0, 6).map((attr, i) => (
                          <div
                            key={`${attr.attributeName}-${i}`}
                            className="flex flex-wrap items-baseline justify-between gap-2 text-[11px]"
                          >
                            <span className="text-[#18181B]">
                              <span className="font-medium">{attr.attributeName}:</span>{" "}
                              <span className="font-mono-tabular">
                                {attr.extractedValue}
                                {attr.unit ? ` ${attr.unit}` : ""}
                              </span>
                            </span>
                            <span className="text-[#57534E] font-mono-tabular flex items-center gap-1.5">
                              <span>{formatSourceType(attr.sourceType)}</span>
                              <span aria-hidden="true">·</span>
                              <span>
                                {attr.observationType === "directly_observed"
                                  ? "Observed"
                                  : "Inferred"}
                              </span>
                              {attr.imageIndex &&
                                attr.imageIndex <= Math.min(galleryMedia.length, 4) && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <button
                                      type="button"
                                      onClick={() => jumpToGalleryImage(attr.imageIndex!)}
                                      className="underline underline-offset-2 text-[#18181B] hover:text-[#1F4E3D] whitespace-nowrap"
                                    >
                                      Photo #{attr.imageIndex}
                                    </button>
                                  </>
                                )}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Option Pickers */}
            {activeProduct.options.length > 0 && (
              <div className="space-y-3 pt-3 border-t border-[#E7E5E0]">
                {activeProduct.options.map((opt) => {
                  const currentVal =
                    activeSelection.find((s) => s.name === opt.name)?.label ??
                    opt.values[0];
                  return (
                    <div key={opt.name} className="space-y-1.5">
                      <label className="block text-xs font-medium text-[#57534E]">
                        {opt.name}: <span className="text-[#18181B]">{currentVal}</span>
                      </label>
                      <div className="flex flex-wrap gap-1.5">
                        {opt.values.map((val) => {
                          const isSelected = val === currentVal;
                          return (
                            <button
                              key={val}
                              type="button"
                              onClick={() => handleOptionChange(opt.name, val)}
                              className={`min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
                                isSelected
                                  ? "border-[#18181B] bg-[#18181B] text-white"
                                  : "border-[#E7E5E0] bg-[#F7F6F3] text-[#18181B] hover:border-[#18181B]"
                              }`}
                            >
                              {val}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {activeProduct.descriptionText && (
              <div className="pt-3 border-t border-[#E7E5E0]">
                <p className="text-xs font-semibold text-[#18181B] mb-1.5">
                  Merchant Listing Details
                </p>
                <p className="text-sm text-[#57534E] leading-relaxed whitespace-pre-line max-h-40 overflow-y-auto">
                  {activeProduct.descriptionText}
                </p>
              </div>
            )}

            {activeProduct.features.length > 0 && (
              <ul className="pt-2 space-y-1 text-xs text-[#57534E] list-disc list-inside">
                {activeProduct.features.slice(0, 4).map((feat, idx) => (
                  <li key={idx}>{feat}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="pt-4 border-t border-[#E7E5E0] space-y-2.5">
            {safeOfferUrl ? (
              <a
                href={safeOfferUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full min-h-[44px] py-3 px-5 rounded-lg bg-[#1F4E3D] text-white text-sm font-medium hover:bg-[#173B2E] transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
              >
                <span>Visit {seller?.name ?? "Seller"} Listing</span>
                <ExternalLink className="w-4 h-4" />
              </a>
            ) : (
              <p className="text-xs text-[#991B1B]">
                No verified HTTPS seller URL was returned for this variant.
              </p>
            )}

            {safeSellerUrl && (
              <div className="flex items-center justify-between text-xs text-[#57534E]">
                <span>Seller store</span>
                <a
                  href={safeSellerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 text-[#18181B] hover:text-[#1F4E3D] flex items-center gap-1"
                >
                  <span>{seller?.domain || seller?.name}</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
