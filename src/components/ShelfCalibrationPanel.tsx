import { useState, type MouseEvent } from "react";
import {
  RotateCcw,
  Undo2,
  Camera,
  AlertCircle,
  CheckCircle2,
  Ruler,
  X,
} from "lucide-react";
import type {
  CardOrientation,
  DimensionAxis,
  Point2D,
  ShelfCalibrationResult,
} from "../types";
import {
  canonicalizeCardQuad,
  estimateCalibratedShelfWidth,
  ISO_CARD_HEIGHT_MM,
  ISO_CARD_WIDTH_MM,
  validateCalibrationTap,
} from "../utils/spatialCalibration";

export interface FrozenCameraFrame {
  dataUrl: string;
  width: number;
  height: number;
}

export interface SpanPresetOption {
  id: string;
  label: string;
  axis: DimensionAxis;
}

const SPAN_PRESETS: SpanPresetOption[] = [
  { id: "shelf-opening", label: "Shelf opening", axis: "width" },
  { id: "desk-gap", label: "Desk gap", axis: "width" },
  { id: "wall-width", label: "Wall width", axis: "width" },
  { id: "height-clearance", label: "Height clearance", axis: "height" },
  { id: "surface-depth", label: "Surface depth", axis: "depth" },
];

function inferInitialPreset(
  existing: ShelfCalibrationResult | null,
  suggestedAxis: DimensionAxis,
  contextHintText: string,
): SpanPresetOption {
  if (existing?.spanLabel) {
    const found = SPAN_PRESETS.find((p) => p.label === existing.spanLabel);
    if (found) return found;
  }
  if (suggestedAxis === "height") return SPAN_PRESETS[3];
  if (suggestedAxis === "depth") return SPAN_PRESETS[4];
  if (/\bdesk\b/i.test(contextHintText)) return SPAN_PRESETS[1];
  if (/\bwall\b/i.test(contextHintText)) return SPAN_PRESETS[2];
  return SPAN_PRESETS[0];
}

interface ShelfCalibrationPanelProps {
  frozenFrame: FrozenCameraFrame;
  calibration: ShelfCalibrationResult | null;
  clearanceInches: number;
  suggestedAxis?: DimensionAxis;
  contextHintText?: string;
  onClearanceChange: (nextInches: number) => void;
  onCalibrationChange: (next: ShelfCalibrationResult | null) => void;
  onRetake: () => void;
  onSkipMeasurement: () => void;
}

export function ShelfCalibrationPanel({
  frozenFrame,
  calibration,
  clearanceInches,
  suggestedAxis = "width",
  contextHintText = "",
  onClearanceChange,
  onCalibrationChange,
  onRetake,
  onSkipMeasurement,
}: ShelfCalibrationPanelProps) {
  const [selectedSpan, setSelectedSpan] = useState<SpanPresetOption>(() =>
    inferInitialPreset(calibration, suggestedAxis, contextHintText),
  );
  const [cardCorners, setCardCorners] = useState<Point2D[]>(
    calibration ? [...calibration.cardCorners] : [],
  );
  const [shelfEndpoints, setShelfEndpoints] = useState<Point2D[]>(
    calibration ? [...calibration.shelfEndpoints] : [],
  );
  const [cardOrientation, setCardOrientation] = useState<CardOrientation>(
    calibration?.cardOrientation ?? "landscape",
  );
  const [tapRejection, setTapRejection] = useState<string | null>(null);

  const totalTapped = cardCorners.length + shelfEndpoints.length;

  function recomputeOrClear(
    nextCorners: Point2D[],
    nextEndpoints: Point2D[],
    nextOrientation: CardOrientation,
    spanPreset: SpanPresetOption,
  ) {
    if (nextCorners.length === 4 && nextEndpoints.length === 2) {
      try {
        const result = estimateCalibratedShelfWidth({
          cardCorners: nextCorners as [Point2D, Point2D, Point2D, Point2D],
          shelfEndpoints: nextEndpoints as [Point2D, Point2D],
          frameWidth: frozenFrame.width,
          frameHeight: frozenFrame.height,
          cardOrientation: nextOrientation,
        });
        onCalibrationChange({
          ...result,
          axis: spanPreset.axis,
          spanLabel: spanPreset.label,
        });
        setTapRejection(null);
      } catch (err) {
        onCalibrationChange(null);
        setTapRejection(
          err instanceof Error
            ? err.message
            : "Could not compute span from those points.",
        );
      }
    } else {
      onCalibrationChange(null);
    }
  }

  function handleSpanPresetChange(preset: SpanPresetOption) {
    setSelectedSpan(preset);
    recomputeOrClear(cardCorners, shelfEndpoints, cardOrientation, preset);
  }

  function handleSvgClick(e: MouseEvent<SVGSVGElement>) {
    if (totalTapped >= 6) {
      setTapRejection(
        "All 6 calibration points are marked. Click Undo or Reset Marks to adjust.",
      );
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const x = ((e.clientX - rect.left) / rect.width) * frozenFrame.width;
    const y = ((e.clientY - rect.top) / rect.height) * frozenFrame.height;
    const candidate: Point2D = { x, y };

    const validation = validateCalibrationTap({
      cardCorners,
      shelfEndpoints,
      candidate,
      frameWidth: frozenFrame.width,
      frameHeight: frozenFrame.height,
      cardOrientation,
    });

    if (!validation.valid) {
      setTapRejection(validation.reason ?? "Invalid tap rejected.");
      return;
    }

    setTapRejection(null);

    if (cardCorners.length < 4) {
      const nextCorners = [...cardCorners, candidate];
      setCardCorners(nextCorners);
      recomputeOrClear(nextCorners, shelfEndpoints, cardOrientation, selectedSpan);
    } else {
      const nextEndpoints = [...shelfEndpoints, candidate];
      setShelfEndpoints(nextEndpoints);
      recomputeOrClear(cardCorners, nextEndpoints, cardOrientation, selectedSpan);
    }
  }

  function handleUndo() {
    setTapRejection(null);
    if (shelfEndpoints.length > 0) {
      const nextEndpoints = shelfEndpoints.slice(0, -1);
      setShelfEndpoints(nextEndpoints);
      recomputeOrClear(cardCorners, nextEndpoints, cardOrientation, selectedSpan);
      return;
    }
    if (cardCorners.length > 0) {
      const nextCorners = cardCorners.slice(0, -1);
      setCardCorners(nextCorners);
      recomputeOrClear(nextCorners, [], cardOrientation, selectedSpan);
    }
  }

  function handleResetMarks() {
    setCardCorners([]);
    setShelfEndpoints([]);
    setTapRejection(null);
    onCalibrationChange(null);
  }

  function handleOrientationChange(next: CardOrientation) {
    setCardOrientation(next);
    recomputeOrClear(cardCorners, shelfEndpoints, next, selectedSpan);
  }

  const markerScale = Math.max(1, frozenFrame.width / 640);
  const pointRadius = Math.round(7 * markerScale);
  const strokeW = Math.max(2, Math.round(2.5 * markerScale));
  const fontSize = Math.round(13 * markerScale);

  const canonicalPolygonPoints =
    cardCorners.length === 4
      ? canonicalizeCardQuad(cardCorners as [Point2D, Point2D, Point2D, Point2D])
          .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
          .join(" ")
      : null;

  let stepPrompt: string;
  if (cardCorners.length < 4) {
    stepPrompt = `Step 1 of 2: Tap corner ${cardCorners.length + 1} of 4 around your ${ISO_CARD_WIDTH_MM.toFixed(2)} × ${ISO_CARD_HEIGHT_MM.toFixed(2)} mm reference card in perimeter order.`;
  } else if (shelfEndpoints.length < 2) {
    stepPrompt = `Step 2 of 2: Tap coplanar endpoint ${shelfEndpoints.length + 1} of 2 across your ${selectedSpan.label.toLowerCase()}.`;
  } else {
    stepPrompt = `${selectedSpan.label} calibrated via planar homography. Inspect any product or toggle Standard / SceneCart.`;
  }

  return (
    <div
      data-testid="shelf-calibration-panel"
      className="space-y-3 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] p-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-1.5 font-semibold text-[#18181B]">
          <Ruler className="w-4 h-4 text-[#1F4E3D] shrink-0" />
          <span>Measure this space · {totalTapped}/6 marks</span>
        </div>

        <div
          role="group"
          aria-label="Reference card orientation"
          className="flex items-center gap-1 p-0.5 rounded-md bg-[#ECEAE4]"
        >
          <button
            type="button"
            onClick={() => handleOrientationChange("landscape")}
            className={`px-2 py-1 rounded text-[11px] font-medium whitespace-nowrap transition-colors ${
              cardOrientation === "landscape"
                ? "bg-white text-[#18181B] shadow-xs"
                : "text-[#57534E] hover:text-[#18181B]"
            }`}
          >
            85.60 × 53.98 mm
          </button>
          <button
            type="button"
            onClick={() => handleOrientationChange("portrait")}
            className={`px-2 py-1 rounded text-[11px] font-medium whitespace-nowrap transition-colors ${
              cardOrientation === "portrait"
                ? "bg-white text-[#18181B] shadow-xs"
                : "text-[#57534E] hover:text-[#18181B]"
            }`}
          >
            53.98 × 85.60 mm
          </button>
        </div>
      </div>

      {/* Span Preset Selector (Shelf opening, Desk gap, Wall width, Height clearance, Surface depth) */}
      <div
        role="group"
        aria-label="Span type to measure"
        className="flex flex-wrap items-center gap-1.5"
      >
        {SPAN_PRESETS.map((preset) => {
          const active = selectedSpan.id === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              data-testid={`span-preset-${preset.id}`}
              onClick={() => handleSpanPresetChange(preset)}
              className={`px-2.5 py-1 rounded-md border text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors ${
                active
                  ? "border-[#18181B] bg-[#18181B] text-white"
                  : "border-[#E7E5E0] bg-white text-[#57534E] hover:text-[#18181B] hover:border-[#18181B]"
              }`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <p className="text-xs text-[#57534E]" data-testid="calibration-step-prompt">
        {stepPrompt}
      </p>

      {/* Interactive Frozen Camera Frame SVG Canvas (zero inline styles) */}
      <div className="relative rounded-lg overflow-hidden border border-[#18181B]/20 bg-[#18181B] select-none">
        <svg
          data-testid="calibration-svg-canvas"
          viewBox={`0 0 ${frozenFrame.width} ${frozenFrame.height}`}
          onClick={handleSvgClick}
          className="w-full h-auto block cursor-crosshair touch-none"
          role="img"
          aria-label={`Frozen camera frame for marking 4 card corners and 2 ${selectedSpan.label.toLowerCase()} endpoints`}
        >
          <image
            href={frozenFrame.dataUrl}
            x={0}
            y={0}
            width={frozenFrame.width}
            height={frozenFrame.height}
            preserveAspectRatio="none"
          />

          {/* Partial card polyline for 2 or 3 points */}
          {cardCorners.length >= 2 && cardCorners.length < 4 && (
            <polyline
              points={cardCorners.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
              fill="none"
              stroke="#10B981"
              strokeWidth={strokeW}
              strokeDasharray={`${strokeW * 2} ${strokeW}`}
            />
          )}

          {/* Completed 4-corner card polygon */}
          {canonicalPolygonPoints && (
            <polygon
              points={canonicalPolygonPoints}
              fill="#10B981"
              fillOpacity={0.22}
              stroke="#10B981"
              strokeWidth={strokeW}
            />
          )}

          {/* Card corner markers C1..C4 */}
          {cardCorners.map((pt, idx) => (
            <g key={`card-${idx}`}>
              <circle
                cx={pt.x}
                cy={pt.y}
                r={pointRadius}
                fill="#1F4E3D"
                stroke="#FFFFFF"
                strokeWidth={Math.max(1.5, strokeW * 0.75)}
              />
              <text
                x={pt.x + pointRadius + 4 * markerScale}
                y={pt.y - 4 * markerScale}
                fill="#FFFFFF"
                fontSize={fontSize}
                fontWeight="700"
                stroke="#18181B"
                strokeWidth={Math.max(0.6, markerScale * 0.6)}
                paintOrder="stroke"
              >
                C{idx + 1}
              </text>
            </g>
          ))}

          {/* Coplanar span segment S1-S2 */}
          {shelfEndpoints.length === 2 && (
            <line
              x1={shelfEndpoints[0].x}
              y1={shelfEndpoints[0].y}
              x2={shelfEndpoints[1].x}
              y2={shelfEndpoints[1].y}
              stroke="#F59E0B"
              strokeWidth={strokeW * 1.25}
            />
          )}

          {/* Span endpoint markers S1, S2 */}
          {shelfEndpoints.map((pt, idx) => (
            <g key={`shelf-${idx}`}>
              <circle
                cx={pt.x}
                cy={pt.y}
                r={pointRadius * 1.05}
                fill="#D97706"
                stroke="#FFFFFF"
                strokeWidth={Math.max(1.5, strokeW * 0.75)}
              />
              <text
                x={pt.x + pointRadius + 4 * markerScale}
                y={pt.y - 4 * markerScale}
                fill="#FEF3C7"
                fontSize={fontSize}
                fontWeight="700"
                stroke="#18181B"
                strokeWidth={Math.max(0.6, markerScale * 0.6)}
                paintOrder="stroke"
              >
                S{idx + 1}
              </text>
            </g>
          ))}
        </svg>
      </div>

      {tapRejection && (
        <div
          role="alert"
          data-testid="calibration-tap-rejection"
          className="rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs text-[#991B1B] flex items-start gap-2"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{tapRejection}</span>
        </div>
      )}

      {calibration && (
        <div
          data-testid="calibration-shelf-readout"
          className="rounded-lg border border-[#E7E5E0] bg-white p-3 space-y-2 text-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-[#14532D] flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>
                {calibration.spanLabel ?? selectedSpan.label} range:{" "}
                <span className="font-mono-tabular">
                  {calibration.minWidthInches.toFixed(1)}–
                  {calibration.maxWidthInches.toFixed(1)} in
                </span>
              </span>
            </span>

            <span className="font-mono-tabular text-[11px] text-[#57534E]">
              Nominal {calibration.nominalWidthInches.toFixed(1)} in (
              {Math.round(calibration.minWidthMm)}–
              {Math.round(calibration.maxWidthMm)} mm) · ±
              {calibration.tapUncertaintyPx.toFixed(1)} px tap uncertainty
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-[#E7E5E0]">
            <label
              htmlFor="shelf-clearance-input"
              className="text-[11px] font-medium text-[#57534E]"
            >
              Clearance margin (in):
            </label>
            <div className="flex items-center gap-1.5">
              {[0, 0.5, 1.0].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => onClearanceChange(preset)}
                  className={`px-2 py-1 rounded border text-[11px] font-mono-tabular transition-colors ${
                    Math.abs(clearanceInches - preset) < 1e-4
                      ? "border-[#18181B] bg-[#18181B] text-white"
                      : "border-[#E7E5E0] bg-[#F7F6F3] text-[#18181B] hover:border-[#18181B]"
                  }`}
                >
                  {preset.toFixed(1)}&quot;
                </button>
              ))}
              <input
                id="shelf-clearance-input"
                type="number"
                min="0"
                max="12"
                step="0.1"
                value={clearanceInches}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (Number.isFinite(val) && val >= 0) {
                    onClearanceChange(val);
                  }
                }}
                aria-label="Clearance margin in inches"
                className="w-16 px-2 py-1 rounded border border-[#E7E5E0] bg-[#F7F6F3] text-xs font-mono-tabular text-[#18181B] focus:bg-white focus:outline-none focus:border-[#1F4E3D]"
              />
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleUndo}
          disabled={totalTapped === 0}
          data-testid="calibration-undo-btn"
          className="min-h-[38px] px-3 py-1.5 rounded-lg border border-[#E7E5E0] bg-white text-xs font-medium text-[#18181B] hover:border-[#18181B] disabled:opacity-45 flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <Undo2 className="w-3.5 h-3.5" />
          <span>Undo</span>
        </button>

        <button
          type="button"
          onClick={handleResetMarks}
          disabled={totalTapped === 0}
          data-testid="calibration-reset-btn"
          className="min-h-[38px] px-3 py-1.5 rounded-lg border border-[#E7E5E0] bg-white text-xs font-medium text-[#18181B] hover:border-[#18181B] disabled:opacity-45 flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>Reset</span>
        </button>

        <button
          type="button"
          onClick={onSkipMeasurement}
          data-testid="calibration-skip-btn"
          className="min-h-[38px] px-3 py-1.5 rounded-lg border border-[#E7E5E0] bg-white text-xs font-medium text-[#57534E] hover:text-[#18181B] hover:border-[#18181B] flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <X className="w-3.5 h-3.5" />
          <span>Skip measurement</span>
        </button>

        <button
          type="button"
          onClick={onRetake}
          data-testid="calibration-retake-btn"
          className="min-h-[38px] px-3 py-1.5 rounded-lg bg-[#18181B] text-white text-xs font-medium hover:bg-[#27272A] flex items-center gap-1.5 whitespace-nowrap shrink-0 ml-auto"
        >
          <Camera className="w-3.5 h-3.5" />
          <span>Retake Live Frame</span>
        </button>
      </div>
    </div>
  );
}
