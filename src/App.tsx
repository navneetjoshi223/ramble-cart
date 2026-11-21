import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Video,
  ExternalLink,
  Search,
  VideoOff,
  Clock,
  Info,
  AlertTriangle,
  Sparkles,
  RefreshCw,
  Radio,
} from "lucide-react";
import type {
  DecisionTriggerSource,
  NormalizedProduct,
  RambleInterpretResponse,
  SearchCatalogResult,
  ShoppingDecisionResult,
  SpaceQueryInterpretation,
} from "./types";
import { ProductImage } from "./components/ProductImage";
import { ProductDetailModal } from "./components/ProductDetailModal";
import { DictationButton } from "./components/DictationButton";
import { DecisionStatusPanel } from "./components/DecisionStatusPanel";
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

  // Live Video & Voice Stream Input for Shop MCP search
  const [spaceOpen, setSpaceOpen] = useState(true);
  const [cameraActive, setCameraActive] = useState(false);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [liveFrameCount, setLiveFrameCount] = useState(0);
  const [liveAutoSync, setLiveAutoSync] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [rambleText, setRambleText] = useState("");
  const [dictating, setDictating] = useState(false);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [interpreting, setInterpreting] = useState(false);
  const [interpretation, setInterpretation] = useState<SpaceQueryInterpretation | null>(null);
  const [latestDecision, setLatestDecision] = useState<ShoppingDecisionResult | null>(null);
  const [preventedSearchCount, setPreventedSearchCount] = useState(0);
  const [interpretError, setInterpretError] = useState<string | null>(null);

  const searchAbortRef = useRef<AbortController | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const startingDictationRef = useRef(false);
  const videoFramesRef = useRef<string[]>([]);
  const rambleTextRef = useRef("");
  const interpretationRef = useRef<SpaceQueryInterpretation | null>(null);
  const lastAutoInterpretedTextRef = useRef("");
  const speechPauseTimerRef = useRef<number | null>(null);
  const dictationRestartTimerRef = useRef<number | null>(null);
  const dictationStartedAtRef = useRef(0);
  const consecutiveQuickEndsRef = useRef(0);
  const lastSpeechErrorRef = useRef<string | null>(null);
  const autoDictateEnabledRef = useRef(false);
  const dictatingRef = useRef(false);
  const interpretingRef = useRef(false);
  const recognitionRef = useRef<{ start: () => void; stop: () => void } | null>(null);

  useEffect(() => {
    runSearch("ceramic coffee dripper");
    // Auto-start dictation on mount ONLY if microphone permission was already granted
    // for this origin, avoiding iframe gesture rejections and start/error flicker loops.
    if (navigator.permissions?.query) {
      navigator.permissions
        .query({ name: "microphone" as PermissionName })
        .then((status) => {
          if (status.state === "granted") {
            void startAutoDictation(true);
          }
        })
        .catch(() => {});
    }
    return () => {
      searchAbortRef.current?.abort();
      stopDictation();
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
    rambleTextRef.current = rambleText;
  }, [rambleText]);

  useEffect(() => {
    if (cameraActive && videoRef.current && cameraStreamRef.current) {
      videoRef.current.srcObject = cameraStreamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [cameraActive, spaceOpen]);

  function sampleCurrentVideoFrame(): string | null {
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
    const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
    const base64 = dataUrl.split(",")[1] || "";
    if (!base64) return null;

    const nextBuffer = [...videoFramesRef.current.slice(-3), base64];
    videoFramesRef.current = nextBuffer;
    setLiveFrameCount(nextBuffer.length);
    return base64;
  }

  // Continuous 1 FPS live video stream sampler while camera is active
  useEffect(() => {
    if (!cameraActive) {
      videoFramesRef.current = [];
      setLiveFrameCount(0);
      return;
    }
    const interval = window.setInterval(() => {
      sampleCurrentVideoFrame();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [cameraActive]);

  // Optional continuous Live Auto-Search sync from rolling 1 FPS video stream
  useEffect(() => {
    if (!cameraActive || !liveAutoSync) return;
    const syncTimer = window.setInterval(() => {
      if (!interpretingRef.current && videoFramesRef.current.length > 0) {
        void handleInterpretAndSearch("live_auto_sync");
      }
    }, 5000);
    return () => window.clearInterval(syncTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraActive, liveAutoSync]);

  async function startCamera(preferredFacing: "environment" | "user" = facingMode) {
    setCameraError(null);

    // Ensure auto-dictation starts on this user gesture if not already active
    if (!dictatingRef.current && !startingDictationRef.current) {
      void startAutoDictation(true);
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError("Live video input is not supported in this browser context.");
      return;
    }

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
            frameRate: { ideal: 24 },
          },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      }

      cameraStreamRef.current = stream;
      videoFramesRef.current = [];
      setLiveFrameCount(0);
      setFacingMode(preferredFacing);
      setCameraActive(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
    } catch (err) {
      setCameraError(
        err instanceof Error
          ? `Live video unavailable (${err.message}). Check camera permissions.`
          : "Camera permission denied for live video.",
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
    videoFramesRef.current = [];
    setLiveFrameCount(0);
    setLiveAutoSync(false);
    setCameraActive(false);
  }

  function flipCamera() {
    const nextFacing = facingMode === "environment" ? "user" : "environment";
    startCamera(nextFacing);
  }

  function stopDictation() {
    startingDictationRef.current = false;
    autoDictateEnabledRef.current = false;
    if (dictationRestartTimerRef.current) {
      window.clearTimeout(dictationRestartTimerRef.current);
      dictationRestartTimerRef.current = null;
    }
    if (speechPauseTimerRef.current) {
      window.clearTimeout(speechPauseTimerRef.current);
      speechPauseTimerRef.current = null;
    }
    const activeRec = recognitionRef.current;
    recognitionRef.current = null;
    try {
      activeRec?.stop();
    } catch {
      // ignore if already stopped
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    setMicStream(null);
    dictatingRef.current = false;
    setDictating(false);
  }

  async function startAutoDictation(silentIfUnsupported = false) {
    if (startingDictationRef.current) return;

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
      stopDictation();
      if (!silentIfUnsupported) {
        setInterpretError(
          "Speech dictation is unavailable in this browser. Type your request below.",
        );
      }
      return;
    }

    startingDictationRef.current = true;

    if (dictationRestartTimerRef.current) {
      window.clearTimeout(dictationRestartTimerRef.current);
      dictationRestartTimerRef.current = null;
    }

    if (recognitionRef.current) {
      const prevRec = recognitionRef.current;
      recognitionRef.current = null;
      try {
        prevRec.stop();
      } catch {
        // ignore if already stopped
      }
    }

    // Open microphone stream BEFORE SpeechRecognition.start() so macOS/iOS audio unit
    // initialization never interrupts an already-running SpeechRecognition session.
    if (!micStreamRef.current && navigator.mediaDevices?.getUserMedia) {
      try {
        const openedMic = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        if (!startingDictationRef.current) {
          openedMic.getTracks().forEach((t) => t.stop());
          return;
        }
        micStreamRef.current = openedMic;
        setMicStream(openedMic);
      } catch {
        // If mic permission was denied, abort cleanly without flickering
        startingDictationRef.current = false;
        stopDictation();
        if (!silentIfUnsupported) {
          setInterpretError(
            "Microphone permission denied. Allow microphone access or type your request below.",
          );
        }
        return;
      }
    }

    const rec = new SpeechRec() as {
      continuous: boolean;
      interimResults: boolean;
      lang: string;
      onstart: (() => void) | null;
      onresult: (e: {
        results: ArrayLike<{ isFinal?: boolean; 0: { transcript: string } }>;
      }) => void;
      onerror: (e: { error?: string }) => void;
      onend: () => void;
      start: () => void;
      stop: () => void;
    };
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onstart = () => {
      if (recognitionRef.current !== rec) return;
      startingDictationRef.current = false;
      dictationStartedAtRef.current = Date.now();
      lastSpeechErrorRef.current = null;
      dictatingRef.current = true;
      setDictating(true);
    };

    rec.onresult = (event) => {
      if (recognitionRef.current !== rec) return;
      consecutiveQuickEndsRef.current = 0;

      let text = "";
      for (let i = 0; i < event.results.length; i++) {
        text += event.results[i][0]?.transcript ?? "";
      }
      const cleaned = text.trim();
      if (!cleaned) return;

      rambleTextRef.current = cleaned;
      setRambleText(cleaned);

      // Automatically interpret & search when the user pauses speaking for 1.4s
      if (speechPauseTimerRef.current) {
        window.clearTimeout(speechPauseTimerRef.current);
      }
      speechPauseTimerRef.current = window.setTimeout(() => {
        const latest = rambleTextRef.current.trim();
        if (
          latest &&
          latest !== lastAutoInterpretedTextRef.current &&
          !interpretingRef.current
        ) {
          lastAutoInterpretedTextRef.current = latest;
          void handleInterpretAndSearch("speech_pause");
        }
      }, 1400);
    };

    rec.onerror = (event) => {
      if (recognitionRef.current !== rec) return;
      startingDictationRef.current = false;
      const errCode = event.error || "unknown";
      lastSpeechErrorRef.current = errCode;

      // Quiet silence timeout ('no-speech') is normal during continuous listening:
      // keep the button & micStream steady so onend rolls over seamlessly without flicker.
      if (errCode === "no-speech" && autoDictateEnabledRef.current) {
        return;
      }

      // Terminal permission, gesture, or hardware errors must halt auto-restart immediately
      if (
        errCode === "not-allowed" ||
        errCode === "service-not-allowed" ||
        errCode === "audio-capture" ||
        errCode === "language-not-supported" ||
        errCode === "network"
      ) {
        stopDictation();
        return;
      }

      if (!autoDictateEnabledRef.current) {
        stopDictation();
      }
    };

    rec.onend = () => {
      if (recognitionRef.current !== rec) return;
      startingDictationRef.current = false;

      if (!autoDictateEnabledRef.current) {
        stopDictation();
        return;
      }

      // Guard against rapid start->end failure loops (< 1200ms without 'no-speech')
      const elapsedMs = Date.now() - dictationStartedAtRef.current;
      if (elapsedMs < 1200 && lastSpeechErrorRef.current !== "no-speech") {
        consecutiveQuickEndsRef.current += 1;
      } else {
        consecutiveQuickEndsRef.current = 0;
      }

      if (consecutiveQuickEndsRef.current >= 2) {
        stopDictation();
        return;
      }

      // Seamless rollover restart without toggling dictating false -> true
      if (dictationRestartTimerRef.current) {
        window.clearTimeout(dictationRestartTimerRef.current);
      }
      dictationRestartTimerRef.current = window.setTimeout(() => {
        dictationRestartTimerRef.current = null;
        if (!autoDictateEnabledRef.current || recognitionRef.current !== rec) {
          return;
        }
        try {
          dictationStartedAtRef.current = Date.now();
          rec.start();
        } catch {
          stopDictation();
        }
      }, 250);
    };

    recognitionRef.current = rec;
    consecutiveQuickEndsRef.current = 0;
    lastSpeechErrorRef.current = null;
    autoDictateEnabledRef.current = true;

    try {
      dictationStartedAtRef.current = Date.now();
      rec.start();
    } catch {
      stopDictation();
    }
  }

  function toggleDictation() {
    if (dictatingRef.current || dictating || startingDictationRef.current) {
      stopDictation();
      return;
    }
    void startAutoDictation(false);
  }

  async function handleInterpretAndSearch(
    triggerSource: DecisionTriggerSource = "manual_submit",
  ) {
    if (cameraActive) {
      sampleCurrentVideoFrame();
    }
    const framesToSend = [...videoFramesRef.current];
    const currentText = rambleTextRef.current.trim();

    if (!currentText && framesToSend.length === 0) {
      setInterpretError(
        "Start live video or speak/type what fits your space first.",
      );
      return;
    }

    interpretingRef.current = true;
    setInterpreting(true);
    setInterpretError(null);

    const prev = interpretationRef.current;

    try {
      const response = await safeFetchJson<RambleInterpretResponse>(
        "/api/ramble/interpret",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoFrames: framesToSend,
            mimeType: "image/jpeg",
            rambleText: currentText,
            triggerSource,
            previousContext: prev
              ? {
                  searchQuery: prev.searchQuery,
                  maxPriceUsd: prev.maxPriceUsd,
                  activeConstraints: prev.activeConstraints,
                  sceneSummary: prev.sceneSummary,
                }
              : null,
          }),
        },
      );

      setLatestDecision(response.decision);

      if (!response.shouldExecuteSearch || !response.interpretation) {
        if (triggerSource !== "manual_submit") {
          setPreventedSearchCount((count) => count + 1);
        }
        return;
      }

      const parsed = response.interpretation;
      interpretationRef.current = parsed;
      setInterpretation(parsed);
      setQuery(parsed.searchQuery);
      setMaxPriceInput(parsed.maxPriceUsd ? String(parsed.maxPriceUsd) : "");
      await runSearch(parsed.searchQuery, {
        overrideMaxUsd: parsed.maxPriceUsd,
      });
    } catch (err) {
      setInterpretError(
        err instanceof Error ? err.message : "Live video interpretation failed.",
      );
    } finally {
      interpretingRef.current = false;
      setInterpreting(false);
    }
  }

  function handleRemoveConstraint(index: number) {
    const current = interpretationRef.current;
    if (!current) return;
    const removed = current.activeConstraints[index];
    if (!removed) return;

    const nextActive = current.activeConstraints.filter((_, idx) => idx !== index);
    const removedLooksLikePrice =
      /\$|\b(under|below|max|budget)\b/i.test(removed.text);
    const nextMaxUsd = removedLooksLikePrice ? null : current.maxPriceUsd;

    // Strip the relaxed constraint token from the search query when present
    const strippedWords = removed.text
      .replace(/^(no|without|under|below)\s+/i, "")
      .trim();
    const escaped = strippedWords.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nextQueryCandidate = escaped
      ? current.searchQuery.replace(new RegExp(`\\b${escaped}\\b`, "ig"), "").replace(/\s{2,}/g, " ").trim()
      : current.searchQuery;
    const finalQuery = nextQueryCandidate || current.searchQuery;

    const updated: SpaceQueryInterpretation = {
      ...current,
      searchQuery: finalQuery,
      maxPriceUsd: nextMaxUsd,
      activeConstraints: nextActive,
      supersededConstraints: [...current.supersededConstraints, removed.text],
    };

    interpretationRef.current = updated;
    setInterpretation(updated);
    setQuery(finalQuery);
    if (removedLooksLikePrice) {
      setMaxPriceInput("");
    }
    void runSearch(finalQuery, { overrideMaxUsd: nextMaxUsd });
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
              <h1 className="font-display text-3xl sm:text-4xl font-medium text-[#18181B] leading-tight text-balance">
                Search products from millions of Shopify merchants.
              </h1>
            </div>

            <button
              type="button"
              onClick={() => setSpaceOpen((v) => !v)}
              className="min-h-[44px] px-4 py-2 rounded-lg border border-[#E7E5E0] bg-white text-xs font-medium text-[#18181B] hover:border-[#18181B] transition-colors flex items-center gap-2 self-start md:self-auto whitespace-nowrap shrink-0"
            >
              <Video className="w-4 h-4 text-[#1F4E3D]" />
              <span>{spaceOpen ? "Hide Live Video & Voice" : "Live Video & Voice Input"}</span>
            </button>
          </div>

          {/* Live Video & Voice Stream Panel */}
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
                      cameraActive
                        ? "w-full h-full object-cover"
                        : "hidden"
                    }
                  />
                  {cameraActive ? (
                    <div className="absolute top-2.5 left-2.5 px-2.5 py-1 rounded-md bg-black/75 text-white text-[11px] font-mono-tabular flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-[#EF4444] animate-pulse" />
                      <span>LIVE VIDEO · 1 FPS ({liveFrameCount}f window)</span>
                    </div>
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center text-[#A8A29E] px-4 text-center">
                      <Video className="w-7 h-7 mb-2 opacity-70" />
                      <p className="text-xs">
                        Start live video to stream your space continuously at 1 FPS while you talk.
                      </p>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => (cameraActive ? stopCamera() : startCamera())}
                    className="min-h-[40px] px-3.5 py-2 rounded-lg bg-[#18181B] text-white text-xs font-medium flex items-center gap-1.5"
                  >
                    {cameraActive ? <VideoOff className="w-3.5 h-3.5" /> : <Video className="w-3.5 h-3.5" />}
                    <span>{cameraActive ? "Stop Live Video" : "Start Live Video"}</span>
                  </button>

                  {cameraActive && (
                    <>
                      <button
                        type="button"
                        onClick={flipCamera}
                        aria-label="Flip camera"
                        className="min-h-[40px] px-3 py-2 rounded-lg border border-[#E7E5E0] bg-white text-[#18181B] text-xs font-medium hover:border-[#18181B] flex items-center gap-1"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Flip Camera</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setLiveAutoSync((v) => !v)}
                        className={`min-h-[40px] px-3 py-2 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors ${
                          liveAutoSync
                            ? "border-[#1F4E3D] bg-[#1F4E3D] text-white"
                            : "border-[#E7E5E0] bg-white text-[#18181B] hover:border-[#18181B]"
                        }`}
                      >
                        <Radio className="w-3.5 h-3.5" />
                        <span>{liveAutoSync ? "Live Auto-Sync: ON" : "Live Auto-Sync: OFF"}</span>
                      </button>
                    </>
                  )}
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
                    <DictationButton
                      dictating={dictating}
                      micStream={micStream}
                      onToggle={toggleDictation}
                    />
                  </div>
                  <textarea
                    id="space-ramble"
                    rows={2}
                    value={rambleText}
                    onChange={(e) => setRambleText(e.target.value)}
                    placeholder="Speak freely while panning your camera—auto-dictation transcribes and searches when you pause."
                    className="w-full rounded-lg border border-[#E7E5E0] bg-[#F7F6F3] px-3.5 py-2.5 text-sm focus:bg-white focus:outline-none focus:border-[#1F4E3D]"
                  />

                  <DecisionStatusPanel
                    decision={latestDecision}
                    interpretation={interpretation}
                    preventedSearchCount={preventedSearchCount}
                    onRemoveConstraint={handleRemoveConstraint}
                  />

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
                  onClick={() => void handleInterpretAndSearch("manual_submit")}
                  disabled={interpreting}
                  className="min-h-[44px] px-4 py-2.5 rounded-lg bg-[#1F4E3D] text-white text-xs font-medium hover:bg-[#173B2E] disabled:opacity-60 flex items-center justify-center gap-2 self-start"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>
                    {interpreting
                      ? "Evaluating Decision & Space..."
                      : "Interpret Live Video & Search"}
                  </span>
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
        activeConstraints={interpretation?.activeConstraints ?? []}
        maxPriceUsd={
          interpretation?.maxPriceUsd ??
          (maxPriceInput.trim() && Number(maxPriceInput) > 0
            ? Number(maxPriceInput)
            : null)
        }
        spatialSummary={interpretation?.sceneSummary ?? null}
        onClose={() => setInspectedProduct(null)}
      />
    </div>
  );
}

export default App;
