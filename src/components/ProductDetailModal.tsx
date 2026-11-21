import { useEffect, useRef, useState } from "react";
import { ExternalLink, X, CheckCircle2, AlertCircle, Clock, Star } from "lucide-react";
import type {
  GetProductResult,
  NormalizedOptionSelection,
  NormalizedProduct,
} from "../types";
import { ProductImage } from "./ProductImage";

interface ProductDetailModalProps {
  product: NormalizedProduct | null;
  country: string;
  currency: string;
  onClose: () => void;
}

export function ProductDetailModal({
  product,
  country,
  currency,
  onClose,
}: ProductDetailModalProps) {
  const [liveDetails, setLiveDetails] = useState<GetProductResult | null>(null);
  const [selectedOptions, setSelectedOptions] = useState<NormalizedOptionSelection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!product) {
      setLiveDetails(null);
      setSelectedOptions([]);
      setError(null);
      return;
    }

    const initialSelection =
      product.selectedOptions.length > 0
        ? product.selectedOptions
        : product.options.map((o) => ({ name: o.name, label: o.values[0] })).filter((o) => o.label);

    setSelectedOptions(initialSelection);
    setLiveDetails(null);
    setError(null);

    // Confirm full details & stock for initial selection via get_product
    fetchProductCombination(product.id, initialSelection);

    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id, country, currency]);

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
      const res = await fetch("/api/shop/product", {
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
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Could not load product combination details.");
      }
      setLiveDetails(data as GetProductResult);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to confirm product details.");
    } finally {
      if (abortRef.current === controller) {
        setLoading(false);
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
  const heroImage =
    activeVariant?.media[0]?.url ?? activeProduct.media[0]?.url ?? "";
  const heroAlt =
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
    fetchProductCombination(activeProduct.id, nextSelection);
  }

  const fetchedTimeLabel = liveDetails?.fetchedAt
    ? new Date(liveDetails.fetchedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 bg-black/45 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label={activeProduct.title}
    >
      <div className="relative w-full max-w-4xl max-h-[92vh] overflow-y-auto bg-white rounded-t-3xl sm:rounded-xl border border-[#E7E5E0] shadow-2xl grid grid-cols-1 md:grid-cols-2">
        <button
          type="button"
          onClick={onClose}
          className="sticky sm:absolute top-4 right-4 z-10 ml-auto m-3 sm:m-0 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg bg-white/95 text-[#18181B] border border-[#E7E5E0] hover:bg-[#F7F6F3] transition-colors"
          aria-label="Close product details"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="bg-[#F7F6F3] flex flex-col">
          <div className="aspect-[4/3] w-full overflow-hidden">
            <ProductImage
              src={heroImage}
              alt={heroAlt}
              className="w-full h-full object-cover"
            />
          </div>
          {activeProduct.media.length > 1 && (
            <div className="grid grid-cols-4 gap-2 p-3 border-t border-[#E7E5E0]">
              {activeProduct.media.slice(0, 4).map((m, idx) => (
                <div key={idx} className="aspect-square rounded overflow-hidden bg-white border border-[#E7E5E0]">
                  <ProductImage src={m.url} alt={m.altText} className="w-full h-full object-cover" />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="p-6 md:p-8 flex flex-col justify-between gap-6">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#57534E]">
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
            <div className="flex flex-wrap items-center gap-3 text-xs pt-1">
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

            {/* Option Pickers */}
            {activeProduct.options.length > 0 && (
              <div className="space-y-3 pt-2 border-t border-[#E7E5E0]">
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
                              className={`min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
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
                className="w-full min-h-[44px] py-3 px-5 rounded-lg bg-[#1F4E3D] text-white text-sm font-medium hover:bg-[#173B2E] transition-colors flex items-center justify-center gap-2"
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
