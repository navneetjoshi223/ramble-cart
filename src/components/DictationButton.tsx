import { useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import { computeMicLevels, smoothLevel } from "../utils/micAudioMath";

interface DictationButtonProps {
  dictating: boolean;
  micStream?: MediaStream | null;
  disabled?: boolean;
  onToggle: () => void;
}

const BAR_X_POSITIONS = [1, 5, 9, 13, 17] as const;
const MIN_BAR_HEIGHT = 3;
const MAX_BAR_HEIGHT = 15;
const SVG_VIEWBOX_HEIGHT = 16;

type WebkitWindow = Window & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};

export function DictationButton({
  dictating,
  micStream,
  disabled = false,
  onToggle,
}: DictationButtonProps) {
  const [meterReady, setMeterReady] = useState(false);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const barRefs = useRef<Array<SVGRectElement | null>>([null, null, null, null, null]);
  const smoothedBandsRef = useRef<[number, number, number, number, number]>([
    0, 0, 0, 0, 0,
  ]);
  const smoothedVolumeRef = useRef(0);
  const speakingHoldUntilRef = useRef(0);

  useEffect(() => {
    function resetBars() {
      smoothedBandsRef.current = [0, 0, 0, 0, 0];
      smoothedVolumeRef.current = 0;
      setMeterReady(false);
      if (svgRef.current) {
        svgRef.current.setAttribute("data-volume", "0.00");
        svgRef.current.setAttribute("data-speaking", "false");
      }
      for (const rect of barRefs.current) {
        if (!rect) continue;
        const y = (SVG_VIEWBOX_HEIGHT - MIN_BAR_HEIGHT) / 2;
        rect.setAttribute("y", y.toFixed(2));
        rect.setAttribute("height", MIN_BAR_HEIGHT.toFixed(2));
        rect.setAttribute("fill", "#1F4E3D");
        rect.setAttribute("fill-opacity", "0.45");
      }
    }

    if (!dictating || !micStream) {
      resetBars();
      return;
    }

    let cancelled = false;
    let rafId: number | null = null;
    let audioCtx: AudioContext | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const unlockAudioContext = () => {
      if (audioCtx && audioCtx.state === "suspended") {
        void audioCtx.resume().catch(() => {});
      }
    };

    function attachMicAnalyser(activeStream: MediaStream) {
      const AudioCtx =
        (window as WebkitWindow).AudioContext ||
        (window as WebkitWindow).webkitAudioContext;

      if (!AudioCtx || activeStream.getAudioTracks().length === 0) {
        return;
      }

      try {
        audioCtx = new AudioCtx();
        if (audioCtx.state === "suspended") {
          void audioCtx.resume().catch(() => {});
          window.addEventListener("pointerdown", unlockAudioContext, { passive: true });
          window.addEventListener("keydown", unlockAudioContext, { passive: true });
        }

        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.65;

        sourceNode = audioCtx.createMediaStreamSource(activeStream);
        sourceNode.connect(analyser);

        const timeData = new Uint8Array(analyser.fftSize);
        const freqData = new Uint8Array(analyser.frequencyBinCount);
        let lastFrameTime = 0;

        setMeterReady(true);

        const tick = (now: number) => {
          if (cancelled) return;

          if (!prefersReducedMotion || now - lastFrameTime >= 90) {
            lastFrameTime = now;

            if (audioCtx && audioCtx.state === "suspended") {
              void audioCtx.resume().catch(() => {});
            }

            if (audioCtx && audioCtx.state !== "closed") {
              analyser.getByteTimeDomainData(timeData);
              analyser.getByteFrequencyData(freqData);

              const snapshot = computeMicLevels(timeData, freqData);
              smoothedVolumeRef.current = smoothLevel(
                smoothedVolumeRef.current,
                snapshot.volume,
              );

              if (snapshot.isSpeaking) {
                speakingHoldUntilRef.current = now + 220;
              }
              const isVoiceActive =
                snapshot.isSpeaking || now < speakingHoldUntilRef.current;

              for (let i = 0; i < 5; i++) {
                const nextBand = smoothLevel(
                  smoothedBandsRef.current[i],
                  snapshot.bands[i],
                );
                smoothedBandsRef.current[i] = nextBand;

                const rect = barRefs.current[i];
                if (rect) {
                  const barHeight =
                    MIN_BAR_HEIGHT + nextBand * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT);
                  const barY = (SVG_VIEWBOX_HEIGHT - barHeight) / 2;
                  rect.setAttribute("y", barY.toFixed(2));
                  rect.setAttribute("height", barHeight.toFixed(2));
                  rect.setAttribute("fill", isVoiceActive ? "#14532D" : "#1F4E3D");
                  rect.setAttribute("fill-opacity", isVoiceActive ? "1" : "0.75");
                }
              }

              if (svgRef.current) {
                svgRef.current.setAttribute(
                  "data-volume",
                  smoothedVolumeRef.current.toFixed(2),
                );
                svgRef.current.setAttribute(
                  "data-speaking",
                  isVoiceActive ? "true" : "false",
                );
              }
            }
          }

          rafId = window.requestAnimationFrame(tick);
        };

        rafId = window.requestAnimationFrame(tick);
      } catch {
        resetBars();
      }
    }

    attachMicAnalyser(micStream);

    return () => {
      cancelled = true;
      window.removeEventListener("pointerdown", unlockAudioContext);
      window.removeEventListener("keydown", unlockAudioContext);
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      if (sourceNode) {
        try {
          sourceNode.disconnect();
        } catch {
          // ignore disconnect errors
        }
      }
      if (audioCtx) {
        void audioCtx.close().catch(() => {});
      }
      resetBars();
    };
  }, [dictating, micStream]);

  const restingY = (SVG_VIEWBOX_HEIGHT - MIN_BAR_HEIGHT) / 2;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      aria-pressed={dictating}
      aria-label={
        disabled
          ? "Voice dictation disabled while viewing product"
          : dictating
            ? "Auto-dictation active — click to mute"
            : "Start automatic voice dictation"
      }
      className={`min-h-[40px] min-w-[196px] px-3.5 py-2 rounded-lg border text-xs font-medium flex items-center justify-center gap-2 whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${
        dictating
          ? "border-[#1F4E3D] bg-[#ECFDF5] text-[#14532D]"
          : "border-[#E7E5E0] bg-white text-[#18181B] hover:border-[#18181B] disabled:hover:border-[#E7E5E0]"
      }`}
    >
      {dictating ? (
        <>
          <Mic className="w-3.5 h-3.5 shrink-0 text-[#1F4E3D]" />
          <svg
            ref={svgRef}
            width="20"
            height="16"
            viewBox="0 0 20 16"
            aria-hidden="true"
            data-testid="mic-volume-meter"
            data-mic-ready={meterReady ? "true" : "false"}
            data-volume="0.00"
            data-speaking="false"
            className="shrink-0 overflow-visible"
          >
            {BAR_X_POSITIONS.map((xPos, idx) => (
              <rect
                key={xPos}
                ref={(el) => {
                  barRefs.current[idx] = el;
                }}
                x={xPos}
                y={restingY}
                width="2.4"
                height={MIN_BAR_HEIGHT}
                rx="1.2"
                fill="#1F4E3D"
                fillOpacity={meterReady ? 0.75 : 0.45}
              />
            ))}
          </svg>
          <span>Auto-Dictating (Mute)</span>
        </>
      ) : (
        <>
          <MicOff className="w-3.5 h-3.5 shrink-0 text-[#57534E]" />
          <span>Auto-Dictate</span>
        </>
      )}
    </button>
  );
}
