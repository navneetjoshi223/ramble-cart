import type {
  ActiveSpatialLimit,
  DimensionAxis,
  DocumentedWidthEvidence,
  NormalizedProduct,
  ProductEvidenceResult,
  ShelfCalibrationResult,
  ShoppingDecisionResult,
  SpaceQueryInterpretation,
  WidthFitEvaluation,
  WidthFitVerdict,
} from "../types";
import { MM_PER_INCH } from "./spatialCalibration";

const SHIPPING_NOISE_REGEX =
  /\b(shipping|shipped|package|packaged|packaging|box|carton|master\s*case|parcel|crate)\b/i;

const SIZE_OPTION_NAME_REGEX =
  /\b(size|dimension|dimensions|width|height|depth|length|span)\b/i;

const UNMEASURED_FIT_REQUEST_REGEX =
  /\b(will\s+(?:it|this|these|that)\s+fit|does\s+(?:it|this)\s+fit|fit\s+(?:here|in\s+this|on\s+this|into\s+this|between|under|inside|my\s+(?:desk|shelf|wall|space|gap|niche|corner))|fits?\s+(?:this|my)\s+(?:space|desk|shelf|wall|gap|opening|corner)|measure\s+this\s+space|desk\s+gap|shelf\s+opening|wall\s+width|nothing\s+(?:wider|taller|deeper|larger|bigger)\s+than\s+this)\b/i;

/**
 * Parses numeric values including decimals ("23.6"), integers ("600"),
 * mixed fractions ("23 5/8" or "23-5/8"), and simple fractions ("3/4").
 */
export function parseNumericMeasurement(raw: string): number | null {
  const cleaned = raw.trim().replace(/,/g, "");
  if (!cleaned) return null;

  const mixedMatch = cleaned.match(/^(\d+)\s*(?:\s+|-)\s*(\d+)\s*\/\s*(\d+)$/);
  if (mixedMatch) {
    const whole = Number(mixedMatch[1]);
    const num = Number(mixedMatch[2]);
    const den = Number(mixedMatch[3]);
    if (den > 0 && Number.isFinite(whole) && Number.isFinite(num)) {
      return whole + num / den;
    }
    return null;
  }

  const fracMatch = cleaned.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fracMatch) {
    const num = Number(fracMatch[1]);
    const den = Number(fracMatch[2]);
    if (den > 0 && Number.isFinite(num)) {
      return num / den;
    }
    return null;
  }

  if (/^\d+(?:\.\d+)?$/.test(cleaned)) {
    const val = Number(cleaned);
    return Number.isFinite(val) && val > 0 ? val : null;
  }

  return null;
}

/**
 * Converts a numeric measurement + unit token ("mm", "cm", "m", "in", '"', "ft")
 * into millimeters. Returns null for unknown/unsupported units or non-positive values.
 */
export function convertToMillimeters(value: number, rawUnit: string): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const u = rawUnit.trim().toLowerCase();

  if (
    u === "mm" ||
    u === "millimeter" ||
    u === "millimeters" ||
    u === "millimetre" ||
    u === "millimetres"
  ) {
    return value;
  }
  if (
    u === "cm" ||
    u === "centimeter" ||
    u === "centimeters" ||
    u === "centimetre" ||
    u === "centimetres"
  ) {
    return value * 10;
  }
  if (u === "m" || u === "meter" || u === "meters" || u === "metre" || u === "metres") {
    return value * 1000;
  }
  if (
    u === "in" ||
    u === "in." ||
    u === "inch" ||
    u === "inches" ||
    u === '"' ||
    u === "”" ||
    u === "''"
  ) {
    return value * MM_PER_INCH;
  }
  if (u === "ft" || u === "ft." || u === "foot" || u === "feet" || u === "'") {
    return value * 12 * MM_PER_INCH;
  }

  return null;
}

export function parseLengthStringToMm(
  text: string,
  fallbackUnit?: string | null,
): {
  mm: number;
  matchedText: string;
} | null {
  const numPattern = String.raw`(\d+\s*(?:\s+|-)\s*\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:\.\d+)?)`;
  const unitPattern = String.raw`(mm|millimeters?|cm|centimeters?|inches|inch|in\.?|""|''|"|”|feet|foot|ft\.?|meters?|metres?)`;

  const withUnit = new RegExp(`^\\s*${numPattern}\\s*${unitPattern}\\s*$`, "i");
  const m1 = text.match(withUnit);
  if (m1) {
    const num = parseNumericMeasurement(m1[1]);
    if (num !== null) {
      const unitToken = m1[2] === '""' ? '"' : m1[2];
      const mm = convertToMillimeters(num, unitToken);
      if (mm !== null) {
        return { mm, matchedText: text.trim() };
      }
    }
  }

  if (fallbackUnit && fallbackUnit.trim()) {
    const num = parseNumericMeasurement(text);
    if (num !== null) {
      const mm = convertToMillimeters(num, fallbackUnit);
      if (mm !== null) {
        return { mm, matchedText: `${text.trim()} ${fallbackUnit.trim()}` };
      }
    }
  }

  return null;
}

/**
 * Parses a direct spoken or typed dimension limit such as:
 * - "at most 20 inches wide"
 * - "no wider than 60 cm"
 * - "max width 24 in"
 * - "under 14 inches tall"
 * - "at most 10 inches deep"
 * When matched, the shopper skips the reference-card calibration step.
 */
export function parseSpokenDimensionLimit(
  rawText: string,
  interpretation?: SpaceQueryInterpretation | null,
): ActiveSpatialLimit | null {
  const text = rawText.trim();
  const numPat = String.raw`(\d+(?:\s*(?:\s+|-)\s*\d+\s*\/\s*\d+|\.\d+|\/\d+)?)`;
  const unitPat = String.raw`(mm|millimeters?|cm|centimeters?|inches|inch|in\.?|''|"|”|feet|foot|ft\.?)`;

  if (text) {
    // Pattern A: "(at most | max | maximum | under | below | up to | less than | no more than) 20 inches (wide|tall|high|deep)"
    const capBeforeDim = new RegExp(
      String.raw`\b(?:at\s+most|max(?:imum)?|under|below|up\s+to|less\s+than|no\s+more\s+than)\s+${numPat}\s*${unitPat}\s*(wide|width|tall|high|height|deep|depth)\b`,
      "i",
    );
    const mA = text.match(capBeforeDim);
    if (mA) {
      const val = parseNumericMeasurement(mA[1]);
      const mm = val !== null ? convertToMillimeters(val, mA[2]) : null;
      if (mm !== null && mm > 10 && mm <= 6000) {
        const axis = axisFromWord(mA[3]);
        const inches = mm / MM_PER_INCH;
        return {
          source: "spoken",
          axis,
          label: mA[0].trim(),
          minInches: inches,
          maxInches: inches,
          nominalInches: inches,
          minMm: mm,
          maxMm: mm,
          clearanceInches: 0,
          calibration: null,
        };
      }
    }

    // Pattern B: "no (wider|taller|higher|deeper) than 20 inches"
    const comparativeCap = new RegExp(
      String.raw`\b(?:no|not|nothing)\s+(wider|taller|higher|deeper)\s+than\s+${numPat}\s*${unitPat}`,
      "i",
    );
    const mB = text.match(comparativeCap);
    if (mB) {
      const val = parseNumericMeasurement(mB[2]);
      const mm = val !== null ? convertToMillimeters(val, mB[3]) : null;
      if (mm !== null && mm > 10 && mm <= 6000) {
        const axis = axisFromWord(mB[1]);
        const inches = mm / MM_PER_INCH;
        return {
          source: "spoken",
          axis,
          label: mB[0].trim(),
          minInches: inches,
          maxInches: inches,
          nominalInches: inches,
          minMm: mm,
          maxMm: mm,
          clearanceInches: 0,
          calibration: null,
        };
      }
    }

    // Pattern C: "(max|maximum) (width|height|depth) [of|:|-]? 20 inches" or "20 inches wide max"
    const axisBeforeNum = new RegExp(
      String.raw`\b(?:at\s+most|max(?:imum)?)\s+(width|height|depth)\s*(?:of\s*|[:=-]\s*)?${numPat}\s*${unitPat}`,
      "i",
    );
    const mC = text.match(axisBeforeNum);
    if (mC) {
      const val = parseNumericMeasurement(mC[2]);
      const mm = val !== null ? convertToMillimeters(val, mC[3]) : null;
      if (mm !== null && mm > 10 && mm <= 6000) {
        const axis = axisFromWord(mC[1]);
        const inches = mm / MM_PER_INCH;
        return {
          source: "spoken",
          axis,
          label: mC[0].trim(),
          minInches: inches,
          maxInches: inches,
          nominalInches: inches,
          minMm: mm,
          maxMm: mm,
          clearanceInches: 0,
          calibration: null,
        };
      }
    }

    const trailingMax = new RegExp(
      String.raw`${numPat}\s*${unitPat}\s*(wide|width|tall|high|height|deep|depth)\s+(?:max(?:imum)?|or\s+less|at\s+most)\b`,
      "i",
    );
    const mD = text.match(trailingMax);
    if (mD) {
      const val = parseNumericMeasurement(mD[1]);
      const mm = val !== null ? convertToMillimeters(val, mD[2]) : null;
      if (mm !== null && mm > 10 && mm <= 6000) {
        const axis = axisFromWord(mD[3]);
        const inches = mm / MM_PER_INCH;
        return {
          source: "spoken",
          axis,
          label: mD[0].trim(),
          minInches: inches,
          maxInches: inches,
          nominalInches: inches,
          minMm: mm,
          maxMm: mm,
          clearanceInches: 0,
          calibration: null,
        };
      }
    }
  }

  // Fallback to structured Hydrogen dimensionalRequirements when present
  const dims = interpretation?.hydrogenIntent?.dimensionalRequirements;
  if (dims) {
    if (typeof dims.maxWidthInches === "number" && dims.maxWidthInches > 0) {
      const mm = dims.maxWidthInches * MM_PER_INCH;
      return {
        source: "spoken",
        axis: "width",
        label: `at most ${dims.maxWidthInches} in wide`,
        minInches: dims.maxWidthInches,
        maxInches: dims.maxWidthInches,
        nominalInches: dims.maxWidthInches,
        minMm: mm,
        maxMm: mm,
        clearanceInches: 0,
        calibration: null,
      };
    }
    if (typeof dims.maxHeightInches === "number" && dims.maxHeightInches > 0) {
      const mm = dims.maxHeightInches * MM_PER_INCH;
      return {
        source: "spoken",
        axis: "height",
        label: `at most ${dims.maxHeightInches} in tall`,
        minInches: dims.maxHeightInches,
        maxInches: dims.maxHeightInches,
        nominalInches: dims.maxHeightInches,
        minMm: mm,
        maxMm: mm,
        clearanceInches: 0,
        calibration: null,
      };
    }
    if (typeof dims.maxDepthInches === "number" && dims.maxDepthInches > 0) {
      const mm = dims.maxDepthInches * MM_PER_INCH;
      return {
        source: "spoken",
        axis: "depth",
        label: `at most ${dims.maxDepthInches} in deep`,
        minInches: dims.maxDepthInches,
        maxInches: dims.maxDepthInches,
        nominalInches: dims.maxDepthInches,
        minMm: mm,
        maxMm: mm,
        clearanceInches: 0,
        calibration: null,
      };
    }
  }

  return null;
}

/**
 * Strips explicit spoken limit clauses (e.g. "at most 20 inches wide", "no wider than 60 cm")
 * from a raw search string so Shop MCP receives clean product keywords while SceneCart
 * enforces the numeric dimension limit against returned variants.
 */
export function stripSpokenDimensionPhrase(rawQuery: string): string {
  const numPat = String.raw`(?:\d+(?:\s*(?:\s+|-)\s*\d+\s*\/\s*\d+|\.\d+|\/\d+)?)`;
  const unitPat = String.raw`(?:mm|millimeters?|cm|centimeters?|inches|inch|in\.?|''|"|”|feet|foot|ft\.?)`;
  const patterns = [
    new RegExp(
      String.raw`[,;.]?\s*\b(?:at\s+most|max(?:imum)?|under|below|up\s+to|less\s+than|no\s+more\s+than)\s+${numPat}\s*${unitPat}\s*(?:wide|width|tall|high|height|deep|depth)\b`,
      "ig",
    ),
    new RegExp(
      String.raw`[,;.]?\s*\b(?:no|not|nothing)\s+(?:wider|taller|higher|deeper)\s+than\s+${numPat}\s*${unitPat}(?![a-z])`,
      "ig",
    ),
    new RegExp(
      String.raw`[,;.]?\s*\b(?:at\s+most|max(?:imum)?)\s+(?:width|height|depth)\s*(?:of\s*|[:=-]\s*)?${numPat}\s*${unitPat}(?![a-z])`,
      "ig",
    ),
    new RegExp(
      String.raw`[,;.]?\s*${numPat}\s*${unitPat}\s*(?:wide|width|tall|high|height|deep|depth)\s+(?:max(?:imum)?|or\s+less|at\s+most)\b`,
      "ig",
    ),
  ];

  let cleaned = rawQuery;
  for (const pat of patterns) {
    cleaned = cleaned.replace(pat, " ");
  }
  cleaned = cleaned.replace(/^[\s,;.-]+|[\s,;.-]+$/g, "").replace(/\s{2,}/g, " ").trim();
  return cleaned || rawQuery.trim();
}

function axisFromWord(word: string): DimensionAxis {
  const w = word.trim().toLowerCase();
  if (w.startsWith("tall") || w.startsWith("high") || w.startsWith("height")) {
    return "height";
  }
  if (w.startsWith("deep") || w.startsWith("depth")) {
    return "depth";
  }
  return "width";
}

/**
 * Detects when a shopper asked about physical fit (e.g., "will this fit my desk gap?",
 * "nothing taller than this shelf") without providing an explicit numeric limit.
 */
export function detectPhysicalFitIntent(params: {
  rambleText: string;
  queryText?: string;
  interpretation?: SpaceQueryInterpretation | null;
  decision?: ShoppingDecisionResult | null;
}): { requested: boolean; suggestedAxis: DimensionAxis } {
  const { rambleText, queryText = "", interpretation, decision } = params;
  const combined = `${rambleText} ${queryText}`.trim();

  const inferAxis = (str: string): DimensionAxis => {
    if (/\b(tall|taller|height|high|under\s+monitor|shelf\s+height)\b/i.test(str)) {
      return "height";
    }
    if (/\b(deep|deeper|depth|shallow)\b/i.test(str)) {
      return "depth";
    }
    return "width";
  };

  if (UNMEASURED_FIT_REQUEST_REGEX.test(combined)) {
    return { requested: true, suggestedAxis: inferAxis(combined) };
  }

  const rawDimPhrase = interpretation?.hydrogenIntent?.dimensionalRequirements.rawText;
  if (rawDimPhrase && rawDimPhrase.trim()) {
    return { requested: true, suggestedAxis: inferAxis(rawDimPhrase) };
  }

  if (
    decision?.needsCalibrationOrMeasurements ||
    decision?.action === "REQUEST_CALIBRATION" ||
    decision?.action === "REQUEST_MEASUREMENTS"
  ) {
    return { requested: true, suggestedAxis: inferAxis(combined) };
  }

  return { requested: false, suggestedAxis: "width" };
}

/**
 * Converts a camera ShelfCalibrationResult into an ActiveSpatialLimit.
 */
export function calibrationToSpatialLimit(
  calibration: ShelfCalibrationResult,
  clearanceInches: number,
): ActiveSpatialLimit {
  return {
    source: "measured",
    axis: calibration.axis ?? "width",
    label: calibration.spanLabel ?? "Measured space",
    minInches: calibration.minWidthInches,
    maxInches: calibration.maxWidthInches,
    nominalInches: calibration.nominalWidthInches,
    minMm: calibration.minWidthMm,
    maxMm: calibration.maxWidthMm,
    clearanceInches,
    calibration,
  };
}

/**
 * Extracts an unambiguous dimension (`width`, `height`, or `depth`) from a single text clause
 * while ignoring shipping/package dimensions.
 */
export function extractDimensionFromClause(
  clause: string,
  axis: DimensionAxis = "width",
): {
  mm: number;
  matchedText: string;
} | null {
  const trimmed = clause.trim();
  if (!trimmed || SHIPPING_NOISE_REGEX.test(trimmed)) {
    return null;
  }

  const numPat = String.raw`(\d+(?:\s*(?:\s+|-)\s*\d+\s*\/\s*\d+|\.\d+|\/\d+)?)`;
  const unitPat = String.raw`(mm|millimeters?|cm|centimeters?|inches|inch|in\.?|''|"|”|feet|foot|ft\.?)`;

  const axisTerms =
    axis === "width"
      ? {
          keyAfter: String.raw`(?:product\s+|overall\s+|item\s+|exterior\s+|shelf\s+|stand\s+|frame\s+)?width`,
          valAfter: String.raw`(?:wide\b|width\b|w\b)`,
          shortCode: "w",
        }
      : axis === "height"
        ? {
            keyAfter: String.raw`(?:product\s+|overall\s+|item\s+|total\s+)?height`,
            valAfter: String.raw`(?:tall\b|high\b|height\b|h\b)`,
            shortCode: "h",
          }
        : {
            keyAfter: String.raw`(?:product\s+|overall\s+|item\s+)?depth`,
            valAfter: String.raw`(?:deep\b|depth\b|d\b)`,
            shortCode: "d",
          };

  // 1. Explicit "Width: 23.6 in" / "Height: 12 cm" / "Depth - 9.5""
  const explicitKeyAfter = new RegExp(
    String.raw`\b${axisTerms.keyAfter}\s*(?:is\s*)?[:=-]?\s*${numPat}\s*${unitPat}`,
    "i",
  );
  const mKey = trimmed.match(explicitKeyAfter);
  if (mKey) {
    const num = parseNumericMeasurement(mKey[1]);
    const mm = num !== null ? convertToMillimeters(num, mKey[2]) : null;
    if (mm !== null) {
      return { mm, matchedText: mKey[0].trim() };
    }
  }

  // 2. Value followed by unit + W/H/D: '23.6" W', '600 mm wide', '102mm high'
  const valUnitAxis = new RegExp(
    String.raw`(?:^|[\s(,;:x×])(${numPat})\s*${unitPat}\s*${axisTerms.valAfter}`,
    "i",
  );
  const mVal = trimmed.match(valUnitAxis);
  if (mVal) {
    const num = parseNumericMeasurement(mVal[1]);
    const mm = num !== null ? convertToMillimeters(num, mVal[3]) : null;
    if (mm !== null) {
      return { mm, matchedText: mVal[0].replace(/^[\s(,;:x×]+/, "").trim() };
    }
  }

  // 3. Labeled 3-tuple or 2-tuple: "Dimensions (W x D x H): 60 x 24 x 10 cm"
  const tupleLabeled = new RegExp(
    String.raw`\b(?:dimensions?\s*)?\(\s*([wdhl])\w*\s*[x×]\s*([wdhl])\w*(?:\s*[x×]\s*([wdhl])\w*)?\s*\)\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*(?:${unitPat})?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:${unitPat})?(?:\s*[x×]\s*(\d+(?:\.\d+)?))?\s*${unitPat}`,
    "i",
  );
  const mTuple = trimmed.match(tupleLabeled);
  if (mTuple) {
    const axesOrder = [
      mTuple[1]?.toLowerCase(),
      mTuple[2]?.toLowerCase(),
      mTuple[3]?.toLowerCase(),
    ];
    const nums = [mTuple[4], mTuple[6], mTuple[8]];
    const sharedUnit = mTuple[9] || mTuple[7] || mTuple[5];
    const targetLetter = axisTerms.shortCode;
    const idx = axesOrder.findIndex((a) => a === targetLetter);
    if (idx >= 0 && nums[idx] && sharedUnit) {
      const num = parseNumericMeasurement(nums[idx]);
      const mm = num !== null ? convertToMillimeters(num, sharedUnit) : null;
      if (mm !== null) {
        return { mm, matchedText: mTuple[0].trim() };
      }
    }
  }

  // 4. Short prefix: "W: 140mm", "H: 102mm", "D: 120mm"
  const prefixShort = new RegExp(
    String.raw`(?:^|[\s(,;])${axisTerms.shortCode}\s*[:=]\s*${numPat}\s*${unitPat}`,
    "i",
  );
  const mPrefix = trimmed.match(prefixShort);
  if (mPrefix) {
    const num = parseNumericMeasurement(mPrefix[1]);
    const mm = num !== null ? convertToMillimeters(num, mPrefix[3]) : null;
    if (mm !== null) {
      return { mm, matchedText: mPrefix[0].replace(/^[\s(,;]+/, "").trim() };
    }
  }

  return null;
}

export function extractWidthFromClause(clause: string): {
  mm: number;
  matchedText: string;
} | null {
  return extractDimensionFromClause(clause, "width");
}

/**
 * Extracts the selected variant's documented dimension (`width`, `height`, or `depth`) from:
 * 1. Selected variant options / variant title
 * 2. Directly observed Gemini 4 Neon product photo / listing attributes
 * 3. Deterministic listing features & description text (only when unambiguous for the selected variant)
 */
export function extractSelectedVariantDimension(
  product: NormalizedProduct,
  neonEvidence?: ProductEvidenceResult | null,
  axis: DimensionAxis = "width",
): DocumentedWidthEvidence | null {
  const activeSelections =
    product.selectedOptions.length > 0
      ? product.selectedOptions
      : product.primaryVariant?.selectedOptions ?? [];

  const directOptionRegex =
    axis === "width"
      ? /^(?:product\s+|overall\s+|shelf\s+)?width$/i
      : axis === "height"
        ? /^(?:product\s+|overall\s+)?height$/i
        : /^(?:product\s+|overall\s+)?depth$/i;

  const hasExplicitWidthOption = activeSelections.some((s) =>
    /^(?:product\s+|overall\s+|shelf\s+)?width\b/i.test(s.name.trim()),
  );
  const hasDepthOption = activeSelections.some((s) =>
    /^(?:product\s+|overall\s+|shelf\s+)?depth\b/i.test(s.name.trim()),
  );
  const isRigidHorizontalSpanProduct =
    /\b(shelf|shelves|ledge|stand|riser|desk|table|bench|cabinet|console|mantel|tray)\b/i.test(
      product.title,
    ) &&
    !/\b(cable|cord|wire|rope|hose|chain|necklace|bracelet|shirt|pants|dress)\b/i.test(
      product.title,
    );

  // 1. Check selected variant options first
  for (const sel of activeSelections) {
    const optName = sel.name.trim();
    const optVal = sel.label.trim();
    if (!optVal || /^default\s+title$/i.test(optVal)) continue;

    const unitInNameMatch = optName.match(
      /\(\s*(mm|millimeters?|cm|centimeters?|m|in\.?|inches|inch|''|"|”|ft\.?|feet|foot)\s*\)/i,
    );
    const optNameUnit = unitInNameMatch ? unitInNameMatch[1] : null;
    const optNameBase = optName.replace(/\s*\([^)]*\)\s*$/, "").trim();

    const matchesLengthAsWidth =
      axis === "width" &&
      !hasExplicitWidthOption &&
      /^(?:overall\s+|shelf\s+)?length$/i.test(optNameBase) &&
      (hasDepthOption || isRigidHorizontalSpanProduct);

    if (directOptionRegex.test(optNameBase) || matchesLengthAsWidth) {
      const direct = parseLengthStringToMm(optVal, optNameUnit);
      if (direct && direct.mm >= 15 && direct.mm <= 5000) {
        return {
          axis,
          widthMm: direct.mm,
          widthInches: direct.mm / MM_PER_INCH,
          rawText: direct.matchedText,
          sourceKind: "variant_option",
          sourceLabel: `Selected option (${optName}: ${optVal})`,
          citationText: `${optName}: ${optVal}`,
          imageIndex: null,
        };
      }
    }

    const fromClause = extractDimensionFromClause(`${optName}: ${optVal}`, axis);
    if (fromClause && fromClause.mm >= 15 && fromClause.mm <= 5000) {
      return {
        axis,
        widthMm: fromClause.mm,
        widthInches: fromClause.mm / MM_PER_INCH,
        rawText: fromClause.matchedText,
        sourceKind: "variant_option",
        sourceLabel: `Selected option (${optName}: ${optVal})`,
        citationText: `${optName}: ${optVal}`,
        imageIndex: null,
      };
    }

    // For width on standard 2D Size option: "Size: 24" x 10""
    if (axis === "width" && SIZE_OPTION_NAME_REGEX.test(optName)) {
      const dimPair = optVal.match(
        /^\s*(\d+(?:\.\d+)?)\s*(mm|cm|in\.?|''|"|”)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm|cm|in\.?|''|"|”)(?![a-z])/i,
      );
      if (dimPair) {
        const num = parseNumericMeasurement(dimPair[1]);
        const unit = dimPair[2] || dimPair[4];
        const mm = num !== null && unit ? convertToMillimeters(num, unit) : null;
        if (mm !== null && mm >= 15 && mm <= 5000) {
          return {
            axis,
            widthMm: mm,
            widthInches: mm / MM_PER_INCH,
            rawText: `${dimPair[1]}${unit} (from ${optVal})`,
            sourceKind: "variant_option",
            sourceLabel: `Selected option (${optName}: ${optVal})`,
            citationText: `${optName}: ${optVal}`,
            imageIndex: null,
          };
        }
      }
    }
  }

  // 2. Check Gemini 4 Neon extracted evidence (directly_observed only, matching variant)
  const currentVariantId = product.primaryVariant?.id ?? null;
  const evidenceMatchesVariant =
    neonEvidence &&
    neonEvidence.productId === product.id &&
    (neonEvidence.variantId === currentVariantId ||
      !currentVariantId ||
      !neonEvidence.variantId);

  if (evidenceMatchesVariant && neonEvidence) {
    const matchingNames =
      axis === "width"
        ? new Set([
            "width",
            "product width",
            "overall width",
            "item width",
            "exterior width",
            "stand width",
            "shelf width",
            "frame width",
            "diameter",
            "base diameter",
          ])
        : axis === "height"
          ? new Set(["height", "product height", "overall height", "item height", "total height"])
          : new Set(["depth", "product depth", "overall depth", "item depth"]);

    for (const attr of neonEvidence.extractedAttributes) {
      if (attr.observationType !== "directly_observed") continue;
      if (
        SHIPPING_NOISE_REGEX.test(attr.attributeName) ||
        SHIPPING_NOISE_REGEX.test(attr.sourceCitation)
      ) {
        continue;
      }

      const nameNorm = attr.attributeName.trim().toLowerCase();
      if (matchingNames.has(nameNorm)) {
        const parsed = parseLengthStringToMm(attr.extractedValue, attr.unit);
        if (parsed && parsed.mm >= 15 && parsed.mm <= 5000) {
          const fromPhoto = Boolean(attr.imageIndex && attr.imageIndex > 0);
          return {
            axis,
            widthMm: parsed.mm,
            widthInches: parsed.mm / MM_PER_INCH,
            rawText: parsed.matchedText,
            sourceKind: fromPhoto ? "neon_photo" : "neon_listing",
            sourceLabel: fromPhoto
              ? `Neon Photo #${attr.imageIndex} diagram`
              : "Neon listing spec",
            citationText: attr.sourceCitation,
            imageIndex: fromPhoto ? attr.imageIndex : null,
          };
        }
      }

      if (nameNorm.includes("dimension")) {
        const combined = attr.unit
          ? `${attr.extractedValue} ${attr.unit}`
          : attr.extractedValue;
        const fromDim = extractDimensionFromClause(combined, axis);
        if (fromDim && fromDim.mm >= 15 && fromDim.mm <= 5000) {
          const fromPhoto = Boolean(attr.imageIndex && attr.imageIndex > 0);
          return {
            axis,
            widthMm: fromDim.mm,
            widthInches: fromDim.mm / MM_PER_INCH,
            rawText: fromDim.matchedText,
            sourceKind: fromPhoto ? "neon_photo" : "neon_listing",
            sourceLabel: fromPhoto
              ? `Neon Photo #${attr.imageIndex} diagram`
              : "Neon listing spec",
            citationText: attr.sourceCitation,
            imageIndex: fromPhoto ? attr.imageIndex : null,
          };
        }
      }
    }
  }

  // 3. Check deterministic listing features & description text
  const multiSizeOption = product.options.find(
    (o) => SIZE_OPTION_NAME_REGEX.test(o.name) && o.values.length > 1,
  );
  const selectedSizeLabel = multiSizeOption
    ? activeSelections.find((s) => s.name === multiSizeOption.name)?.label?.trim() ?? null
    : null;

  const textLines = [
    ...product.features,
    ...product.descriptionText.split(/[\n.;•|]+/),
  ]
    .map((s) => s.trim())
    .filter(Boolean);

  const matchedCandidates: Array<{ mm: number; matchedText: string; line: string }> = [];

  for (const line of textLines) {
    if (SHIPPING_NOISE_REGEX.test(line)) continue;
    if (multiSizeOption) {
      if (!selectedSizeLabel) continue;
      if (!line.toLowerCase().includes(selectedSizeLabel.toLowerCase())) {
        continue;
      }
    }
    const extracted = extractDimensionFromClause(line, axis);
    if (extracted && extracted.mm >= 15 && extracted.mm <= 5000) {
      matchedCandidates.push({ ...extracted, line });
    }
  }

  if (matchedCandidates.length > 0) {
    const first = matchedCandidates[0];
    const hasConflict = matchedCandidates.some(
      (c) => Math.abs(c.mm - first.mm) > 5,
    );
    if (!hasConflict) {
      return {
        axis,
        widthMm: first.mm,
        widthInches: first.mm / MM_PER_INCH,
        rawText: first.matchedText,
        sourceKind: "listing_text",
        sourceLabel: "Merchant listing text",
        citationText: first.line.slice(0, 140),
        imageIndex: null,
      };
    }
  }

  return null;
}

export function extractSelectedVariantWidth(
  product: NormalizedProduct,
  neonEvidence?: ProductEvidenceResult | null,
): DocumentedWidthEvidence | null {
  return extractSelectedVariantDimension(product, neonEvidence, "width");
}

function verdictsForAxis(axis: DimensionAxis): {
  fits: WidthFitVerdict;
  tooLarge: WidthFitVerdict;
  unknownDim: WidthFitVerdict;
} {
  if (axis === "height") {
    return {
      fits: "Height fits",
      tooLarge: "Too tall",
      unknownDim: "Height unknown",
    };
  }
  if (axis === "depth") {
    return {
      fits: "Depth fits",
      tooLarge: "Too deep",
      unknownDim: "Depth unknown",
    };
  }
  return {
    fits: "Width fits",
    tooLarge: "Too wide",
    unknownDim: "Width unknown",
  };
}

/**
 * Returns a "Fit unknown" evaluation when the shopper asked about physical fit
 * and skipped measuring the space without giving a spoken numeric limit.
 */
export function createSkippedMeasurementEvaluation(
  axis: DimensionAxis = "width",
  documentedWidth: DocumentedWidthEvidence | null = null,
): WidthFitEvaluation {
  return {
    axis,
    verdict: "Fit unknown",
    documentedWidth,
    clearanceInches: 0,
    requiredWidthInches: documentedWidth ? documentedWidth.widthInches : null,
    shelfMinInches: null,
    shelfMaxInches: null,
    shelfNominalInches: null,
    marginToMinInches: null,
    explanation:
      "Measurement was skipped—measure this space or state a size limit (e.g., 'at most 20 inches wide') to confirm fit.",
  };
}

/**
 * Compares an ActiveSpatialLimit (either camera-measured with homography uncertainty
 * or a direct spoken limit) against the selected variant's matching dimension + clearance.
 */
export function evaluateSpatialLimitFit(params: {
  limit: ActiveSpatialLimit;
  documentedDimension: DocumentedWidthEvidence | null;
  clearanceOverrideInches?: number;
}): WidthFitEvaluation {
  const { limit, documentedDimension } = params;
  const axis = limit.axis;
  const labels = verdictsForAxis(axis);
  const clearanceInches =
    typeof params.clearanceOverrideInches === "number" &&
    Number.isFinite(params.clearanceOverrideInches) &&
    params.clearanceOverrideInches >= 0
      ? params.clearanceOverrideInches
      : limit.clearanceInches;

  if (!documentedDimension) {
    return {
      axis,
      verdict: labels.unknownDim,
      documentedWidth: null,
      clearanceInches,
      requiredWidthInches: null,
      shelfMinInches: limit.minInches,
      shelfMaxInches: limit.maxInches,
      shelfNominalInches: limit.nominalInches,
      marginToMinInches: null,
      explanation: `No unambiguous product ${axis} was found for the selected variant in variant options, listing text, or Neon product photos.`,
    };
  }

  const requiredInches = documentedDimension.widthInches + clearanceInches;
  const marginToMinInches = limit.minInches - requiredInches;
  const eps = 1e-6;

  const limitDesc =
    limit.source === "spoken"
      ? `spoken limit ${limit.maxInches.toFixed(1)} in`
      : `measured ${limit.label.toLowerCase()} minimum ${limit.minInches.toFixed(1)} in`;

  if (requiredInches <= limit.minInches + eps) {
    return {
      axis,
      verdict: labels.fits,
      documentedWidth: documentedDimension,
      clearanceInches,
      requiredWidthInches: requiredInches,
      shelfMinInches: limit.minInches,
      shelfMaxInches: limit.maxInches,
      shelfNominalInches: limit.nominalInches,
      marginToMinInches,
      explanation:
        clearanceInches > 0
          ? `Documented ${axis} ${documentedDimension.widthInches.toFixed(1)} in + ${clearanceInches.toFixed(2)} in clearance (${requiredInches.toFixed(1)} in) fits within ${limitDesc}.`
          : `Documented ${axis} ${documentedDimension.widthInches.toFixed(1)} in fits within ${limitDesc}.`,
    };
  }

  if (requiredInches > limit.maxInches + eps) {
    return {
      axis,
      verdict: labels.tooLarge,
      documentedWidth: documentedDimension,
      clearanceInches,
      requiredWidthInches: requiredInches,
      shelfMinInches: limit.minInches,
      shelfMaxInches: limit.maxInches,
      shelfNominalInches: limit.nominalInches,
      marginToMinInches,
      explanation:
        clearanceInches > 0
          ? `Documented ${axis} ${documentedDimension.widthInches.toFixed(1)} in + ${clearanceInches.toFixed(2)} in clearance (${requiredInches.toFixed(1)} in) exceeds upper bound ${limit.maxInches.toFixed(1)} in.`
          : `Documented ${axis} ${documentedDimension.widthInches.toFixed(1)} in exceeds ${limitDesc}.`,
    };
  }

  return {
    axis,
    verdict: "Too close to confirm",
    documentedWidth: documentedDimension,
    clearanceInches,
    requiredWidthInches: requiredInches,
    shelfMinInches: limit.minInches,
    shelfMaxInches: limit.maxInches,
    shelfNominalInches: limit.nominalInches,
    marginToMinInches,
    explanation: `Required ${axis} ${requiredInches.toFixed(1)} in falls inside the tap-uncertainty range ${limit.minInches.toFixed(1)}–${limit.maxInches.toFixed(1)} in.`,
  };
}

/**
 * Convenience wrapper for width-axis camera calibration comparison.
 */
export function evaluateShelfWidthFit(params: {
  shelf: Pick<
    ShelfCalibrationResult,
    "minWidthInches" | "maxWidthInches" | "nominalWidthInches"
  >;
  documentedWidth: DocumentedWidthEvidence | null;
  clearanceInches?: number;
}): WidthFitEvaluation {
  const clearance =
    typeof params.clearanceInches === "number" &&
    Number.isFinite(params.clearanceInches) &&
    params.clearanceInches >= 0
      ? params.clearanceInches
      : 0.5;

  return evaluateSpatialLimitFit({
    limit: {
      source: "measured",
      axis: "width",
      label: "Shelf opening",
      minInches: params.shelf.minWidthInches,
      maxInches: params.shelf.maxWidthInches,
      nominalInches: params.shelf.nominalWidthInches,
      minMm: params.shelf.minWidthInches * MM_PER_INCH,
      maxMm: params.shelf.maxWidthInches * MM_PER_INCH,
      clearanceInches: clearance,
    },
    documentedDimension: params.documentedWidth,
    clearanceOverrideInches: clearance,
  });
}
