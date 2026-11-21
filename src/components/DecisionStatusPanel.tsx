import { useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type {
  ActiveConstraint,
  DecisionAction,
  ShoppingDecisionResult,
  SpaceQueryInterpretation,
} from "../types";

interface DecisionStatusPanelProps {
  decision: ShoppingDecisionResult | null;
  interpretation: SpaceQueryInterpretation | null;
  preventedSearchCount: number;
  onRemoveConstraint: (index: number) => void;
}

const ACTION_LABELS: Record<DecisionAction, string> = {
  CONTINUE_LISTENING: "Listening for full thought",
  UPDATE_CONSTRAINTS: "Constraints updated",
  REPLACE_CONSTRAINT: "Replaced superseded constraint",
  REMOVE_CONSTRAINT: "Constraint removed",
  OBSERVE_SPACE: "Camera view needed",
  REQUEST_ANOTHER_ANGLE: "Another angle suggested",
  REQUEST_CALIBRATION: "Reference calibration suggested",
  REQUEST_MEASUREMENTS: "Measurements suggested",
  CLARIFY_REQUIREMENT: "Clarification needed",
  SEARCH_PRODUCTS: "Catalog search ready",
  VERIFY_PRODUCTS: "Hard-constraint check active",
  REFINE_SEARCH: "Search refined",
  PRESENT_RESULTS: "Results up to date",
};

function getConstraintButtonClasses(kind: ActiveConstraint["kind"]): string {
  switch (kind) {
    case "required":
      return "border-[#1F4E3D] bg-[#ECFDF5] text-[#14532D] hover:bg-[#DCFCE7]";
    case "excluded":
      return "border-[#FECACA] bg-[#FEF2F2] text-[#991B1B] hover:bg-[#FEE2E2]";
    case "spatial":
      return "border-[#FED7AA] bg-[#FFF7ED] text-[#9A3412] hover:bg-[#FFEDD5]";
    case "preferred":
    default:
      return "border-[#E7E5E0] bg-[#F7F6F3] text-[#18181B] hover:border-[#18181B]";
  }
}

function getConstraintPrefix(kind: ActiveConstraint["kind"]): string {
  switch (kind) {
    case "required":
      return "Required:";
    case "excluded":
      return "Excluded:";
    case "spatial":
      return "Space:";
    case "preferred":
    default:
      return "Preferred:";
  }
}

export function DecisionStatusPanel({
  decision,
  interpretation,
  preventedSearchCount,
  onRemoveConstraint,
}: DecisionStatusPanelProps) {
  const [expanded, setExpanded] = useState(false);

  if (!decision && !interpretation) {
    return null;
  }

  const isWarningAction =
    decision?.action === "REQUEST_CALIBRATION" ||
    decision?.action === "REQUEST_MEASUREMENTS" ||
    decision?.action === "REQUEST_ANOTHER_ANGLE" ||
    decision?.action === "OBSERVE_SPACE" ||
    decision?.action === "CLARIFY_REQUIREMENT";

  return (
    <div
      data-testid="decisions-status-panel"
      className="rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] p-3.5 space-y-3 text-xs"
    >
      {decision && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p
              className={`font-medium ${
                isWarningAction
                  ? "text-[#9A3412]"
                  : decision.shouldSearch
                    ? "text-[#14532D]"
                    : "text-[#57534E]"
              }`}
            >
              {decision.feedbackMessage}
            </p>

            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              className="text-[#57534E] hover:text-[#18181B] font-medium flex items-center gap-1 whitespace-nowrap shrink-0"
            >
              <span>{expanded ? "Hide Decision Signals" : "Decision Signals"}</span>
              {expanded ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>
          </div>

          {/* Unboxed metadata row with typographic separators */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono-tabular text-[#57534E]">
            <span className="text-[#18181B] font-medium">
              {ACTION_LABELS[decision.action]} ({decision.action})
            </span>
            <span aria-hidden="true">·</span>
            <span>Conf {Math.round(decision.actionConfidence * 100)}%</span>
            <span aria-hidden="true">·</span>
            <span>Readiness {decision.readinessScore.toFixed(1)}/3.0</span>
            <span aria-hidden="true">·</span>
            <span>{decision.latencyMs} ms</span>
            {preventedSearchCount > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {preventedSearchCount} premature{" "}
                  {preventedSearchCount === 1 ? "search" : "searches"} skipped
                </span>
              </>
            )}
          </div>

          {expanded && (
            <div
              data-testid="decisions-signal-details"
              className="pt-2 mt-2 border-t border-[#E7E5E0] grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-[11px] font-mono-tabular text-[#57534E]"
            >
              <div className="flex justify-between gap-2">
                <span>Search ready (noul)</span>
                <span className="text-[#18181B]">
                  {Math.round(decision.signals.shouldSearchNowProb * 100)}%
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span>Update wishlist (noul)</span>
                <span className="text-[#18181B]">
                  {Math.round(decision.signals.shouldUpdateWishlistProb * 100)}%
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span>Constraint correction (noul)</span>
                <span className="text-[#18181B]">
                  {Math.round(decision.signals.isConstraintCorrectionProb * 100)}%
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span>Still speaking (noul)</span>
                <span className="text-[#18181B]">
                  {Math.round(decision.signals.isStillSpeakingProb * 100)}%
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span>Visual context sufficient</span>
                <span className="text-[#18181B]">
                  {Math.round(decision.signals.isVisualContextSufficientProb * 100)}%
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span>Needs spatial calibration</span>
                <span className="text-[#18181B]">
                  {Math.round(decision.signals.needsCalibrationProb * 100)}%
                </span>
              </div>
              {decision.topActionProbabilities.length > 0 && (
                <div className="sm:col-span-2 pt-1 text-[#57534E] leading-relaxed">
                  Top actions:{" "}
                  {decision.topActionProbabilities
                    .map(
                      (item) =>
                        `${item.action} (${Math.round(item.probability * 100)}%)`,
                    )
                    .join(" · ")}{" "}
                  · {decision.model} ({decision.totalOutputTokens} output tokens)
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {interpretation && (
        <div className="space-y-2 pt-2 border-t border-[#E7E5E0]/80">
          {interpretation.sceneSummary && (
            <p className="text-[#18181B]">{interpretation.sceneSummary}</p>
          )}

          {/* Dual Gemini 4 (Hydrogen + Neon) unboxed provenance metadata */}
          {(interpretation.hydrogenIntent || interpretation.neonSpatial) && (
            <div
              data-testid="dual-gemini4-provenance"
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono-tabular text-[#57534E]"
            >
              {interpretation.hydrogenIntent && (
                <span>
                  Intent: {interpretation.hydrogenIntent.model} (
                  {interpretation.hydrogenIntent.latencyMs} ms)
                </span>
              )}
              {interpretation.hydrogenIntent && interpretation.neonSpatial && (
                <span aria-hidden="true">·</span>
              )}
              {interpretation.neonSpatial && (
                <span>
                  Space: {interpretation.neonSpatial.model} (
                  {interpretation.neonSpatial.latencyMs} ms ·{" "}
                  {interpretation.neonSpatial.calibrationStatus})
                </span>
              )}
            </div>
          )}

          {interpretation.neonSpatial && (
            <div
              data-testid="neon-spatial-summary"
              className="space-y-1 text-[11px] text-[#57534E]"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-[#18181B] font-medium">
                  {interpretation.neonSpatial.targetSpace}
                </span>
                <span aria-hidden="true">·</span>
                <span>{interpretation.neonSpatial.usableRegion}</span>
                {interpretation.neonSpatial.visibleMaterials.length > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      Materials:{" "}
                      {interpretation.neonSpatial.visibleMaterials.join(", ")}
                    </span>
                  </>
                )}
                {interpretation.neonSpatial.estimatedWidthRangeInches && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono-tabular">
                      Est. width {interpretation.neonSpatial.estimatedWidthRangeInches}
                    </span>
                  </>
                )}
              </div>
              <p className="text-[#78716C]">
                {interpretation.neonSpatial.measurementLimitations}
              </p>
            </div>
          )}

          {interpretation.hydrogenIntent?.clarificationQuestion && (
            <p className="text-[11px] text-[#9A3412]">
              Clarification: {interpretation.hydrogenIntent.clarificationQuestion}
            </p>
          )}

          {interpretation.activeConstraints.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {interpretation.activeConstraints.map((constraint, idx) => (
                <button
                  key={`${constraint.kind}-${constraint.text}-${idx}`}
                  type="button"
                  onClick={() => onRemoveConstraint(idx)}
                  title="Click to relax or remove this constraint"
                  className={`px-2.5 py-1 rounded-md border text-[11px] font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${getConstraintButtonClasses(
                    constraint.kind,
                  )}`}
                >
                  <span>
                    {getConstraintPrefix(constraint.kind)} {constraint.text}
                  </span>
                  <X className="w-3 h-3 opacity-70" />
                </button>
              ))}
            </div>
          )}

          {interpretation.supersededConstraints.length > 0 && (
            <p className="text-[11px] text-[#78716C]">
              Superseded:{" "}
              <span className="line-through">
                {interpretation.supersededConstraints.join(" · ")}
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
