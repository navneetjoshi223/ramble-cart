import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  Camera,
  ExternalLink,
  Mic,
  MicOff,
  Search,
  VideoOff,
  Clock,
  Info,
  AlertTriangle,
  Sparkles,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import type {
  NormalizedProduct,
  SearchCatalogResult,
  SpaceQueryInterpretation,
} from "./types";
import { ProductImage } from "./components/ProductImage";
import { ProductDetailModal } from "./components/ProductDetailModal";
import { safeFetchJson } from "./utils/safeFetchJson";

const SAMPLE_QUERIES = [
  "ceramic coffee dripper",
  "matte black monitor stand",
  "brushed brass desk lamp",
  "walnut valet tray",
];

const COUNTRY_CURRENCY_OPTIONS = [
  { country: "US", currency: "USD", label: "United States (USD)" },
  { country: "CA", currency: "CAD", label: "Canada (CAD)" },
  { country: "GB", currency: "GBP", label: "United Kingdom (GBP)" },
  { country: "JP", currency: "JPY", label: "Japan (JPY)" },
];

export function App() {
  // Search state
  const [query, setQuery] = useState("ceramic coffee dripper");
  const [country, setCountry] = useState("US");
  const [currency, setCurrency] = useState("USD");
  const [maxPriceInput, setMaxPriceInput] = useState("");
  const [availableOnly, setAvailableOnly] = useState(true);

  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<SearchCatalogResult | null>(null);
  const [inspectedProduct, setInspectedProduct] = useState<NormalizedProduct | null>(null);

  // Minimal Phase 1 Space Camera & Voice Capture (optional helper for Shop MCP search)
  const [spaceOpen, setSpaceOpen] = useState(true);
  const [cameraActive, setCameraActive] = useState(false);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [capturedImage, setCapturedImage] = useState<{
    dataUrl: string;
    base64: string;
    mimeType: string;
  } | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [rambleText, setRambleText] = useState("");
  const [dictating, setDictating] = useState(false);
  const [interpreting, setInterpreting] = useState(false);
  const [interpretation, setInterpretation] = useState<SpaceQueryInterpretation | null>(null);
  const [interpretError, setInterpretError] = useState<string | null>(null);

  const searchAbortRef = useRef<AbortController | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);

  useEffect(() => {
    runSearch("ceramic coffee dripper");
    return () => {
      searchAbortRef.current?.abort();
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function getMaxPriceMinor(rawPrice: string, curr: string): number | undefined {
    const num = Number(rawPrice);
    if (!rawPrice.trim() || !Number.isFinite(num) || num <= 0) return undefined;
    const zeroDecimal = new Set(["JPY", "KRW", "VND", "CLP", "ISK"]);
    const multiplier = zeroDecimal.has(curr.toUpperCase()) ? 1 : 100;
    return Math.round(num * multiplier);
  }

  async function runSearch(
    overrideQuery?: string,
    options: { cursor?: string; append?: boolean; overrideMaxUsd?: number | null } = {},
  ) {
    const activeQuery = (overrideQuery ?? query).trim();
    if (!activeQuery) {
      setSearchError("Enter a product keyword to search Shop MCP.");
      return;
    }

    // Abort superseded in-flight searches
    if (!options.append) {
      searchAbortRef.current?.abort();
    }
    const controller = new AbortController();
    searchAbortRef.current = controller;

    if (options.append) {
      setLoadingMore(true);
    } else {
      setSearching(true);
    }
    setSearchError(null);

    const maxPriceMinor =
      typeof options.overrideMaxUsd === "number" && options.overrideMaxUsd > 0
        ? Math.round(options.overrideMaxUsd * 100)
        : getMaxPriceMinor(maxPriceInput, currency);

    try {
      const typed = await safeFetchJson<SearchCatalogResult>("/api/shop/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: activeQuery,
          country,
          currency,
          availableOnly,
          maxPriceMinor,
          limit: 12,
          cursor: options.cursor,
        }),
        signal: controller.signal,
      });
      if (options.append && searchResult) {
        setSearchResult({
          ...typed,
          products: [...searchResult.products, ...typed.products],
        });
      } else {
        setSearchResult(typed);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      setSearchError(
        err instanceof Error ? err.message : "Could not reach Shop MCP search.",
      );
    } finally {
      if (searchAbortRef.current === controller) {
        setSearching(false);
        setLoadingMore(false);
      }
    }
  }

  function handleSearchSubmit(e: FormEvent) {
    e.preventDefault();
    runSearch();
  }

  useEffect(() => {
    if (cameraActive && videoRef.current && cameraStreamRef.current) {
      videoRef.current.srcObject = cameraStreamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [cameraActive, spaceOpen]);

  async function startCamera(preferredFacing: "environment" | "user" = facingMode) {
    setCameraError(null);
    setCapturedImage(null);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError(
        "Live camera stream is not supported in this browser context. Use 'Snap / Upload Photo' below.",
      );
      return;
    }

    // Stop any existing tracks before opening a new stream
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current = null;
    }

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: preferredFacing },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      } catch {
        // Fallback to any available video input device
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      }

      cameraStreamRef.current = stream;
      setFacingMode(preferredFacing);
      setCameraActive(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
    } catch (err) {
      setCameraError(
        err instanceof Error
          ? `Live camera blocked (${err.message}). Use 'Snap / Upload Photo' instead.`
          : "Camera permission denied. Use 'Snap / Upload Photo' instead.",
      );
      setCameraActive(false);
    }
  }

  function stopCamera() {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  }

  function flipCamera() {
    const nextFacing = facingMode === "environment" ? "user" : "environment";
    startCamera(nextFacing);
  }

  function captureVideoFrame(): { dataUrl: string; base64: string; mimeType: string } | null {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = Math.round((video.videoHeight / video.videoWidth) * 640) || 360;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
    const base64 = dataUrl.split(",")[1] || "";
    if (!base64) return null;
    const snap = { dataUrl, base64, mimeType: "image/jpeg" };
    setCapturedImage(snap);
    return snap;
  }

  function handlePhotoFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setCameraError(null);

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const maxDim = 640;
        const scale = Math.min(1, maxDim / Math.max(img.width || 640, img.height || 640));
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.78);
          const base64 = dataUrl.split(",")[1] || "";
          if (base64) {
            setCapturedImage({ dataUrl, base64, mimeType: "image/jpeg" });
            stopCamera();
          }
        }
      };
      if (typeof reader.result === "string") {
        img.src = reader.result;
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  function toggleDictation() {
    if (dictating && recognitionRef.current) {
      recognitionRef.current.stop();
      setDictating(false);
      return;
    }

    const SpeechRec =
      (
        window as unknown as {
          SpeechRecognition?: new () => unknown;
          webkitSpeechRecognition?: new () => unknown;
        }
      ).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => unknown })
        .webkitSpeechRecognition;

    if (!SpeechRec) {
      setInterpretError("Speech dictation is unavailable in this browser. Type your request below.");
      return;
    }

    const rec = new SpeechRec() as {
      continuous: boolean;
      interimResults: boolean;
      lang: string;
      onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
      onerror: () => void;
      onend: () => void;
      start: () => void;
      stop: () => void;
    };
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (event) => {
      let text = "";
      for (let i = 0; i < event.results.length; i++) {
        text += event.results[i][0]?.transcript ?? "";
      }
      if (text.trim()) setRambleText(text.trim());
    };
    rec.onerror = () => setDictating(false);
    rec.onend = () => setDictating(false);
    recognitionRef.current = rec;
    setDictating(true);
    rec.start();
  }

  async function handleInterpretAndSearch() {
    let activeSnap = capturedImage;
    if (!activeSnap && cameraActive) {
      activeSnap = captureVideoFrame();
    }

    if (!rambleText.trim() && !activeSnap) {
      setInterpretError(
        "Enable the camera, snap/upload a photo, or describe what fits your space first.",
      );
      return;
    }

    setInterpreting(true);
    setInterpretError(null);

    try {
      const parsed = await safeFetchJson<SpaceQueryInterpretation>("/api/ramble/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: activeSnap?.base64,
          mimeType: activeSnap?.mimeType ?? "image/jpeg",
          rambleText: rambleText.trim(),
        }),
      });
      setInterpretation(parsed);
      setQuery(parsed.searchQuery);
      if (parsed.maxPriceUsd) {
        setMaxPriceInput(String(parsed.maxPriceUsd));
      }
      await runSearch(parsed.searchQuery, {
        overrideMaxUsd: parsed.maxPriceUsd,
      });
    } catch (err) {
      setInterpretError(
        err instanceof Error ? err.message : "Space interpretation failed.",
      );
    } finally {
      setInterpreting(false);
    }
  }

  const fetchedTimestamp = searchResult?.fetchedAt
    ? new Date(searchResult.fetchedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  return (
    <div className="min-h-screen flex flex-col bg-[#F7F6F3] text-[#18181B]">
      {/* 3-Zone Top Bar */}
      <header className="sticky top-0 z-40 bg-[#F7F6F3] border-b border-[#E7E5E0]">
        <div className="max-w-[1320px] mx-auto px-5 sm:px-8 h-16 flex items-center justify-between gap-8">
          <a
            href="#search"
            className="font-display text-xl font-semibold tracking-tight text-[#18181B] whitespace-nowrap shrink-0"
          >
            Ramble Cart
          </a>

          <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-[#57534E]">
            <a href="#search" className="hover:text-[#18181B] whitespace-nowrap shrink-0">
              Shop Search
            </a>
            <a href="#results" className="hover:text-[#18181B] whitespace-nowrap shrink-0">
              Results
            </a>
            <button
              type="button"
              onClick={() => setSpaceOpen((v) => !v)}
              className="hover:text-[#18181B] whitespace-nowrap shrink-0"
            >
              {spaceOpen ? "Hide Space Camera" : "Space Camera"}
            </button>
          </nav>

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs font-mono-tabular text-[#57534E] whitespace-nowrap">
              {country} · {currency}
            </span>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-[1320px] w-full mx-auto px-5 sm:px-8 py-8 sm:py-10 space-y-8">
        {/* Search Header & Shop MCP Search Bar */}
        <section id="search" className="space-y-6">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div className="max-w-2xl">
              <p className="text-xs font-medium uppercase tracking-widest text-[#57534E] mb-2">
                Shop MCP · Stateless Catalog Discovery
              </p>
              <h1
                className="font-display text-3xl sm:text-4xl font-medium text-[#18181B] leading-tight"
                style={{ textWrap: "balance" }}
              >
                Search products from millions of Shopify merchants.
              </h1>
            </div>

            <button
              type="button"
              onClick={() => setSpaceOpen((v) => !v)}
              className="min-h-[44px] px-4 py-2 rounded-lg border border-[#E7E5E0] bg-white text-xs font-medium text-[#18181B] hover:border-[#18181B] transition-colors flex items-center gap-2 self-start md:self-auto whitespace-nowrap shrink-0"
            >
              <Camera className="w-4 h-4 text-[#1F4E3D]" />
              <span>{spaceOpen ? "Hide Camera & Voice" : "Camera & Voice Input"}</span>
            </button>
          </div>

          {/* Optional Minimal Camera & Voice Panel */}
          {spaceOpen && (
            <div className="bg-white rounded-xl border border-[#E7E5E0] p-5 grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-5 space-y-3">
                <div className="relative aspect-video rounded-lg overflow-hidden bg-[#18181B] border border-[#E7E5E0]">
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    autoPlay
                    className={
                      cameraActive && !capturedImage
                        ? "w-full h-full object-cover"
                        : "hidden"
                    }
                  />
                  {capturedImage ? (
                    <div className="relative w-full h-full">
                      <img
                        src={capturedImage.dataUrl}
                        alt="Captured space frame"
                        className="w-full h-full object-cover"
                      />
                      <span className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-black/75 text-white text-[11px] font-medium">
                        Frame ready for Gemini
                      </span>
                      <button
                        type="button"
                        onClick={() => setCapturedImage(null)}
                        aria-label="Clear captured photo"
                        className="absolute top-2 right-2 min-h-[32px] px-2.5 py-1 rounded-md bg-black/75 text-white text-xs font-medium hover:bg-black flex items-center gap-1"
                      >
                        <X className="w-3.5 h-3.5" />
                        <span>Clear</span>
                      </button>
                    </div>
                  ) : !cameraActive ? (
                    <div className="w-full h-full flex flex-col items-center justify-center text-[#A8A29E] px-4 text-center">
                      <Camera className="w-7 h-7 mb-2 opacity-70" />
                      <p className="text-xs">
                        Enable live camera or snap/upload a photo of your desk, shelf, or item.
                      </p>
                    </div>
                  ) : null}
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handlePhotoFileChange}
                  className="hidden"
                  aria-label="Upload or capture space photo"
                />

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => (cameraActive ? stopCamera() : startCamera())}
                    className="min-h-[40px] px-3.5 py-2 rounded-lg bg-[#18181B] text-white text-xs font-medium flex items-center gap-1.5"
                  >
                    {cameraActive ? <VideoOff className="w-3.5 h-3.5" /> : <Camera className="w-3.5 h-3.5" />}
                    <span>{cameraActive ? "Stop Camera" : "Enable Camera"}</span>
                  </button>

                  {cameraActive && (
                    <>
                      <button
                        type="button"
                        onClick={captureVideoFrame}
                        className="min-h-[40px] px-3 py-2 rounded-lg border border-[#1F4E3D] bg-[#F7F6F3] text-[#1F4E3D] text-xs font-medium hover:bg-[#1F4E3D] hover:text-white transition-colors"
                      >
                        Snap Frame
                      </button>
                      <button
                        type="button"
                        onClick={flipCamera}
                        aria-label="Flip camera"
                        className="min-h-[40px] px-3 py-2 rounded-lg border border-[#E7E5E0] bg-white text-[#18181B] text-xs font-medium hover:border-[#18181B] flex items-center gap-1"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Flip</span>
                      </button>
                    </>
                  )}

                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="min-h-[40px] px-3 py-2 rounded-lg border border-[#E7E5E0] bg-white text-[#18181B] text-xs font-medium hover:border-[#18181B] flex items-center gap-1.5"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>Snap / Upload Photo</span>
                  </button>
                </div>

                {cameraError && (
                  <p className="text-xs text-[#991B1B]">{cameraError}</p>
                )}
              </div>

              <div className="lg:col-span-7 flex flex-col justify-between gap-4">
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor="space-ramble" className="text-sm font-semibold text-[#18181B]">
                      Describe what fits your space
                    </label>
                    <button
                      type="button"
                      onClick={toggleDictation}
                      className={`min-h-[36px] px-3 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 ${
                        dictating
                          ? "border-[#991B1B] bg-[#FEF2F2] text-[#991B1B]"
                          : "border-[#E7E5E0] text-[#18181B]"
                      }`}
                    >
                      {dictating ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                      <span>{dictating ? "Stop Mic" : "Dictate"}</span>
                    </button>
                  </div>
                  <textarea
                    id="space-ramble"
                    rows={2}
                    value={rambleText}
                    onChange={(e) => setRambleText(e.target.value)}
                    placeholder="e.g. Need a monitor stand under $50. Actually forget wood, matte black metal."
                    className="w-full rounded-lg border border-[#E7E5E0] bg-[#F7F6F3] px-3.5 py-2.5 text-sm focus:bg-white focus:outline-none focus:border-[#1F4E3D]"
                  />

                  {interpretation && (
                    <div className="text-xs text-[#57534E] space-y-1 pt-1">
                      <p className="text-[#18181B]">{interpretation.sceneSummary}</p>
                      <p>
                        Query: <strong className="text-[#18181B]">{interpretation.searchQuery}</strong>
                        {interpretation.activeConstraints.length > 0 &&
                          ` · ${interpretation.activeConstraints.map((c) => `${c.kind}: ${c.text}`).join(" · ")}`}
                      </p>
                      {interpretation.supersededConstraints.length > 0 && (
                        <p className="line-through text-[#A8A29E]">
                          Replaced: {interpretation.supersededConstraints.join(", ")}
                        </p>
                      )}
                    </div>
                  )}

                  {interpretError && (
                    <div className="text-xs text-[#991B1B] bg-[#FEF2F2] border border-[#FECACA] rounded-lg px-3 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <span>{interpretError}</span>
                      {rambleText.trim() && (
                        <button
                          type="button"
                          onClick={() => {
                            setQuery(rambleText.trim());
                            runSearch(rambleText.trim());
                          }}
                          className="px-2.5 py-1.5 rounded bg-[#18181B] text-white text-xs font-medium whitespace-nowrap shrink-0 self-start sm:self-auto"
                        >
                          Search Shop MCP Directly
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={handleInterpretAndSearch}
                  disabled={interpreting}
                  className="min-h-[44px] px-4 py-2.5 rounded-lg bg-[#1F4E3D] text-white text-xs font-medium hover:bg-[#173B2E] disabled:opacity-60 flex items-center justify-center gap-2 self-start"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{interpreting ? "Translating to Shop Search..." : "Interpret Space & Search"}</span>
                </button>
              </div>
            </div>
          )}

          {/* Direct Shop MCP Search Form */}
          <form
            onSubmit={handleSearchSubmit}
            className="bg-white rounded-xl border border-[#E7E5E0] p-4 sm:p-5 space-y-4"
          >
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-6 relative">
                <Search className="w-4 h-4 text-[#57534E] absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search Shopify catalog (e.g. ceramic coffee dripper)"
                  aria-label="Product search query"
                  className="w-full min-h-[44px] pl-10 pr-4 py-2.5 text-sm rounded-lg border border-[#E7E5E0] bg-[#F7F6F3] focus:bg-white focus:outline-none focus:border-[#1F4E3D]"
                />
              </div>

              <div className="md:col-span-3">
                <select
                  aria-label="Shipping country and currency"
                  value={`${country}:${currency}`}
                  onChange={(e) => {
                    const [c, curr] = e.target.value.split(":");
                    setCountry(c);
                    setCurrency(curr);
                  }}
                  className="w-full min-h-[44px] px-3 py-2.5 text-xs font-medium rounded-lg border border-[#E7E5E0] bg-[#F7F6F3] focus:bg-white focus:outline-none focus:border-[#1F4E3D]"
                >
                  {COUNTRY_CURRENCY_OPTIONS.map((opt) => (
                    <option key={opt.country} value={`${opt.country}:${opt.currency}`}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="md:col-span-2">
                <input
                  type="number"
                  min="1"
                  step="any"
                  value={maxPriceInput}
                  onChange={(e) => setMaxPriceInput(e.target.value)}
                  placeholder={`Max (${currency})`}
                  aria-label="Maximum price"
                  className="w-full min-h-[44px] px-3 py-2.5 text-xs font-mono-tabular rounded-lg border border-[#E7E5E0] bg-[#F7F6F3] focus:bg-white focus:outline-none focus:border-[#1F4E3D]"
                />
              </div>

              <div className="md:col-span-1">
                <button
                  type="submit"
                  disabled={searching}
                  className="w-full min-h-[44px] px-4 py-2.5 rounded-lg bg-[#1F4E3D] text-white text-xs font-medium hover:bg-[#173B2E] disabled:opacity-60 transition-colors whitespace-nowrap"
                >
                  {searching ? "..." : "Search"}
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-xs text-[#57534E]">
              <div className="flex flex-wrap items-center gap-2">
                <span>Try:</span>
                {SAMPLE_QUERIES.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => {
                      setQuery(q);
                      runSearch(q);
                    }}
                    className="px-2.5 py-1 rounded border border-[#E7E5E0] bg-[#F7F6F3] hover:border-[#18181B] text-[#18181B] transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={availableOnly}
                  onChange={(e) => setAvailableOnly(e.target.checked)}
                  className="rounded border-[#D6D3D1] accent-[#1F4E3D]"
                />
                <span>In-stock items only</span>
              </label>
            </div>
          </form>
        </section>

        {/* Search Results & Freshness Status */}
        <section id="results" className="space-y-5">
          {searchError && (
            <div className="p-4 rounded-xl bg-[#FEF2F2] border border-[#FECACA] text-sm text-[#991B1B] flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Search could not be completed</p>
                <p className="text-xs mt-1">{searchError}</p>
              </div>
            </div>
          )}

          {searchResult && searchResult.messages.length > 0 && (
            <div className="p-3.5 rounded-xl bg-white border border-[#E7E5E0] text-xs text-[#57534E] flex items-start gap-2.5">
              <Info className="w-4 h-4 text-[#1F4E3D] shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                {searchResult.messages.map((msg, i) => (
                  <p key={i}>{msg.text}</p>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-baseline justify-between gap-2 pb-3 border-b border-[#E7E5E0]">
            <h2 className="font-display text-2xl font-medium text-[#18181B]">
              {searchResult
                ? `Results for “${searchResult.query}”`
                : "Catalog Results"}
            </h2>
            {searchResult && (
              <div className="flex items-center gap-3 text-xs font-mono-tabular text-[#57534E]">
                <span>
                  Showing {searchResult.products.length}
                  {searchResult.pagination.totalCount != null
                    ? ` of ${searchResult.pagination.totalCount}`
                    : ""}
                </span>
                {fetchedTimestamp && (
                  <span className="flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" />
                    Fetched {fetchedTimestamp}
                  </span>
                )}
              </div>
            )}
          </div>

          {searching ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {[0, 1, 2, 3, 4, 5].map((skeleton) => (
                <div
                  key={skeleton}
                  className="bg-white rounded-xl border border-[#E7E5E0] overflow-hidden animate-pulse"
                >
                  <div className="aspect-[4/3] bg-[#ECEAE4]" />
                  <div className="p-5 space-y-3">
                    <div className="h-3 bg-[#ECEAE4] rounded w-1/3" />
                    <div className="h-5 bg-[#ECEAE4] rounded w-3/4" />
                    <div className="h-4 bg-[#ECEAE4] rounded w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : searchResult && searchResult.products.length === 0 ? (
            <div className="bg-white rounded-xl border border-[#E7E5E0] p-10 text-center space-y-2">
              <p className="text-base font-medium text-[#18181B]">
                No matching products found
              </p>
              <p className="text-sm text-[#57534E]">
                Try broader terms, remove a price cap, or uncheck in-stock filtering.
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {searchResult?.products.map((product) => {
                  const v = product.primaryVariant;
                  const image = v?.media[0]?.url ?? product.media[0]?.url ?? "";
                  const alt =
                    v?.media[0]?.altText ?? product.media[0]?.altText ?? product.title;
                  const sellerName = v?.seller?.name ?? "Shopify Merchant";
                  const optionSummary = product.selectedOptions
                    .map((o) => `${o.name}: ${o.label}`)
                    .join(" · ");

                  return (
                    <article
                      key={product.id}
                      className="bg-white rounded-xl border border-[#E7E5E0] overflow-hidden flex flex-col transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-md"
                    >
                      <div
                        onClick={() => setInspectedProduct(product)}
                        className="aspect-[4/3] bg-[#ECEAE4] cursor-pointer overflow-hidden"
                      >
                        <ProductImage
                          src={image}
                          alt={alt}
                          className="w-full h-full object-cover"
                        />
                      </div>

                      <div className="p-5 flex-1 flex flex-col justify-between gap-4">
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2 text-xs text-[#57534E]">
                            <span className="uppercase tracking-wider truncate">
                              {sellerName}
                            </span>
                            <span
                              className={`shrink-0 font-medium ${
                                v?.available === true
                                  ? "text-[#1F4E3D]"
                                  : v?.available === false
                                    ? "text-[#991B1B]"
                                    : "text-[#57534E]"
                              }`}
                            >
                              {v?.available === true
                                ? "In Stock"
                                : v?.available === false
                                  ? "Out of Stock"
                                  : "Check Stock"}
                            </span>
                          </div>

                          <div className="flex items-baseline justify-between gap-3">
                            <button
                              type="button"
                              onClick={() => setInspectedProduct(product)}
                              className="text-left text-base font-semibold text-[#18181B] hover:underline underline-offset-2 line-clamp-2"
                            >
                              {product.title}
                            </button>
                            <span className="text-sm font-mono-tabular font-medium text-[#18181B] shrink-0">
                              {v?.price?.formatted ?? "—"}
                            </span>
                          </div>

                          {optionSummary && (
                            <p className="text-xs text-[#57534E] truncate">
                              {optionSummary}
                            </p>
                          )}
                        </div>

                        <div className="flex items-center gap-2 pt-2 border-t border-[#E7E5E0]">
                          <button
                            type="button"
                            onClick={() => setInspectedProduct(product)}
                            className="flex-1 min-h-[40px] py-2 px-3 rounded-lg bg-[#18181B] text-white text-xs font-medium hover:bg-[#27272A] transition-colors whitespace-nowrap"
                          >
                            Product Details
                          </button>

                          {v?.url && (
                            <a
                              href={v.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="min-h-[40px] py-2 px-3.5 rounded-lg border border-[#E7E5E0] text-xs font-medium text-[#18181B] hover:border-[#18181B] transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
                            >
                              <span>Seller</span>
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>

              {searchResult?.pagination.hasNextPage && searchResult.pagination.cursor && (
                <div className="pt-4 flex justify-center">
                  <button
                    type="button"
                    disabled={loadingMore}
                    onClick={() =>
                      runSearch(searchResult.query, {
                        cursor: searchResult.pagination.cursor ?? undefined,
                        append: true,
                      })
                    }
                    className="min-h-[44px] px-6 py-2.5 rounded-lg border border-[#18181B] text-xs font-medium text-[#18181B] hover:bg-[#18181B] hover:text-white disabled:opacity-50 transition-colors"
                  >
                    {loadingMore ? "Loading more products..." : "Load More Results"}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </main>

      <footer className="border-t border-[#E7E5E0] bg-white">
        <div className="max-w-[1320px] mx-auto px-5 sm:px-8 py-5 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-[#57534E]">
          <span>Ramble Cart · Powered by Shop MCP anonymous catalog search</span>
          <span>Live metadata refreshed per request · Cart & checkout pending next phase</span>
        </div>
      </footer>

      <ProductDetailModal
        product={inspectedProduct}
        country={country}
        currency={currency}
        onClose={() => setInspectedProduct(null)}
      />
    </div>
  );
}

export default App;
