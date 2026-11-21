import type {
  CardOrientation,
  Point2D,
  ShelfCalibrationResult,
} from "../types";

/** ISO/IEC 7810 ID-1 standard reference card dimensions in millimeters */
export const ISO_CARD_WIDTH_MM = 85.6;
export const ISO_CARD_HEIGHT_MM = 53.98;
export const MM_PER_INCH = 25.4;

export interface TapValidationResult {
  valid: boolean;
  reason?: string;
}

function dist2D(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function cross2D(o: Point2D, a: Point2D, b: Point2D): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function triangleArea2D(a: Point2D, b: Point2D, c: Point2D): number {
  return 0.5 * Math.abs(cross2D(a, b, c));
}

function segmentsProperlyOrImproperlyIntersect(
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  p4: Point2D,
): boolean {
  const d1 = cross2D(p3, p4, p1);
  const d2 = cross2D(p3, p4, p2);
  const d3 = cross2D(p1, p2, p3);
  const d4 = cross2D(p1, p2, p4);

  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    return true;
  }

  const eps = 1e-6;
  const onSeg = (a: Point2D, b: Point2D, p: Point2D) =>
    p.x >= Math.min(a.x, b.x) - eps &&
    p.x <= Math.max(a.x, b.x) + eps &&
    p.y >= Math.min(a.y, b.y) - eps &&
    p.y <= Math.max(a.y, b.y) + eps;

  if (Math.abs(d1) <= eps && onSeg(p3, p4, p1)) return true;
  if (Math.abs(d2) <= eps && onSeg(p3, p4, p2)) return true;
  if (Math.abs(d3) <= eps && onSeg(p1, p2, p3)) return true;
  if (Math.abs(d4) <= eps && onSeg(p1, p2, p4)) return true;

  return false;
}

function interiorAngleDeg(prev: Point2D, curr: Point2D, next: Point2D): number {
  const v1x = prev.x - curr.x;
  const v1y = prev.y - curr.y;
  const v2x = next.x - curr.x;
  const v2y = next.y - curr.y;
  const m1 = Math.hypot(v1x, v1y);
  const m2 = Math.hypot(v2x, v2y);
  if (m1 < 1e-9 || m2 < 1e-9) return 0;
  const cosTheta = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (m1 * m2)));
  return (Math.acos(cosTheta) * 180) / Math.PI;
}

/**
 * Canonicalizes a valid convex 4-corner polygon into screen-space
 * [Top-Left, Top-Right, Bottom-Right, Bottom-Left] clockwise order
 * (where +x is right and +y is down).
 */
export function canonicalizeCardQuad(
  quad: [Point2D, Point2D, Point2D, Point2D],
): [Point2D, Point2D, Point2D, Point2D] {
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;

  // In screen coordinates (+x right, +y down), increasing atan2(y - cy, x - cx) sweeps clockwise
  const sortedCw = [...quad].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );

  // Pick top-left-most vertex as index 0 (minimizes x + y among the two upper vertices)
  let bestIdx = 0;
  let bestScore = Infinity;
  for (let i = 0; i < 4; i++) {
    const score = sortedCw[i].x + sortedCw[i].y * 1.15;
    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return [
    sortedCw[bestIdx],
    sortedCw[(bestIdx + 1) % 4],
    sortedCw[(bestIdx + 2) % 4],
    sortedCw[(bestIdx + 3) % 4],
  ];
}

function getTargetCardWorldCorners(
  orientation: CardOrientation,
): [Point2D, Point2D, Point2D, Point2D] {
  const w = orientation === "landscape" ? ISO_CARD_WIDTH_MM : ISO_CARD_HEIGHT_MM;
  const h = orientation === "landscape" ? ISO_CARD_HEIGHT_MM : ISO_CARD_WIDTH_MM;
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
}

function computeHartleyNormalization(pts: [Point2D, Point2D, Point2D, Point2D]): {
  normalized: [Point2D, Point2D, Point2D, Point2D];
  T: number[];
  Tinv: number[];
} | null {
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;

  let meanDist = 0;
  for (let i = 0; i < 4; i++) {
    meanDist += Math.hypot(pts[i].x - cx, pts[i].y - cy);
  }
  meanDist /= 4;
  if (meanDist < 1e-8) return null;

  const s = Math.SQRT2 / meanDist;
  const normalized = pts.map((p) => ({
    x: (p.x - cx) * s,
    y: (p.y - cy) * s,
  })) as [Point2D, Point2D, Point2D, Point2D];

  const T = [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
  const invS = 1 / s;
  const Tinv = [invS, 0, cx, 0, invS, cy, 0, 0, 1];

  return { normalized, T, Tinv };
}

function matMul3x3(A: number[], B: number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        A[r * 3 + 0] * B[0 * 3 + c] +
        A[r * 3 + 1] * B[1 * 3 + c] +
        A[r * 3 + 2] * B[2 * 3 + c];
    }
  }
  return out;
}

function solveLinear8x8(A: number[][], b: number[]): number[] | null {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxAbs = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const candidate = Math.abs(M[r][col]);
      if (candidate > maxAbs) {
        maxAbs = candidate;
        pivotRow = r;
      }
    }

    if (maxAbs < 1e-11) {
      return null;
    }

    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }

    const pivotVal = M[col][col];
    for (let c = col; c <= n; c++) {
      M[col][c] /= pivotVal;
    }

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (Math.abs(factor) < 1e-15) continue;
      for (let c = col; c <= n; c++) {
        M[r][c] -= factor * M[col][c];
      }
    }
  }

  return M.map((row) => row[n]);
}

/**
 * Computes the exact 3x3 planar homography mapping 4 image pixel points
 * to 4 physical plane points using Hartley normalization + Gaussian elimination.
 */
export function computeHomography(
  srcPts: [Point2D, Point2D, Point2D, Point2D],
  dstPts: [Point2D, Point2D, Point2D, Point2D],
): number[] | null {
  const normSrc = computeHartleyNormalization(srcPts);
  const normDst = computeHartleyNormalization(dstPts);
  if (!normSrc || !normDst) return null;

  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const u = normSrc.normalized[i].x;
    const v = normSrc.normalized[i].y;
    const X = normDst.normalized[i].x;
    const Y = normDst.normalized[i].y;

    A.push([u, v, 1, 0, 0, 0, -u * X, -v * X]);
    b.push(X);
    A.push([0, 0, 0, u, v, 1, -u * Y, -v * Y]);
    b.push(Y);
  }

  const h8 = solveLinear8x8(A, b);
  if (!h8) return null;

  const Htilde = [...h8, 1];
  const H = matMul3x3(normDst.Tinv, matMul3x3(Htilde, normSrc.T));
  if (Math.abs(H[8]) < 1e-12) return null;

  return H.map((val) => val / H[8]);
}

export function projectPoint(
  H: number[],
  pt: Point2D,
): { x: number; y: number; w: number } | null {
  const w = H[6] * pt.x + H[7] * pt.y + H[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-7) {
    return null;
  }
  const x = (H[0] * pt.x + H[1] * pt.y + H[2]) / w;
  const y = (H[3] * pt.x + H[4] * pt.y + H[5]) / w;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return { x, y, w };
}

/**
 * Validates each user tap sequentially before accepting it into the 6-point
 * calibration state (4 card corners + 2 coplanar shelf endpoints).
 */
export function validateCalibrationTap(params: {
  cardCorners: Point2D[];
  shelfEndpoints: Point2D[];
  candidate: Point2D;
  frameWidth: number;
  frameHeight: number;
  cardOrientation?: CardOrientation;
}): TapValidationResult {
  const {
    cardCorners,
    shelfEndpoints,
    candidate,
    frameWidth,
    frameHeight,
    cardOrientation = "landscape",
  } = params;

  if (
    !Number.isFinite(candidate.x) ||
    !Number.isFinite(candidate.y) ||
    !Number.isFinite(frameWidth) ||
    !Number.isFinite(frameHeight) ||
    frameWidth <= 0 ||
    frameHeight <= 0
  ) {
    return { valid: false, reason: "Invalid tap coordinates." };
  }

  if (
    candidate.x < 0 ||
    candidate.y < 0 ||
    candidate.x > frameWidth ||
    candidate.y > frameHeight
  ) {
    return {
      valid: false,
      reason: "Tap is outside the captured camera frame.",
    };
  }

  const minScale = Math.min(frameWidth, frameHeight);
  const minCornerSeparationPx = Math.max(10, minScale * 0.02);
  const minTriangleAreaPx2 = Math.max(60, minScale * minScale * 0.00025);

  // Stage 1: Marking the 4 corners of the 85.60 x 53.98 mm card
  if (cardCorners.length < 4) {
    for (const existing of cardCorners) {
      if (dist2D(existing, candidate) < minCornerSeparationPx) {
        return {
          valid: false,
          reason:
            "Tap is too close to an already-marked card corner. Tap a distinct corner of the 85.60 × 53.98 mm card.",
        };
      }
    }

    if (cardCorners.length === 2) {
      const area = triangleArea2D(cardCorners[0], cardCorners[1], candidate);
      if (area < minTriangleAreaPx2) {
        return {
          valid: false,
          reason:
            "Three card corners are nearly collinear. Tap around the outer perimeter of the card.",
        };
      }
    }

    if (cardCorners.length === 3) {
      const quad: [Point2D, Point2D, Point2D, Point2D] = [
        cardCorners[0],
        cardCorners[1],
        cardCorners[2],
        candidate,
      ];

      // Reject self-intersecting (bowtie / Z-order) tap sequences
      if (
        segmentsProperlyOrImproperlyIntersect(quad[0], quad[1], quad[2], quad[3]) ||
        segmentsProperlyOrImproperlyIntersect(quad[1], quad[2], quad[3], quad[0])
      ) {
        return {
          valid: false,
          reason:
            "Card edges cross each other (bowtie order). Tap the 4 corners sequentially around the card perimeter, or click Undo.",
        };
      }

      // Check strict convexity (all 4 turns must have the same non-zero sign)
      const turns: number[] = [];
      for (let i = 0; i < 4; i++) {
        const prev = quad[i];
        const curr = quad[(i + 1) % 4];
        const next = quad[(i + 2) % 4];
        turns.push(cross2D(prev, curr, next));

        const angle = interiorAngleDeg(prev, curr, next);
        if (angle < 15 || angle > 165) {
          return {
            valid: false,
            reason:
              "Card corner angle is too extreme or grazing. Face the shelf more squarely and retake, or adjust the corner.",
          };
        }
      }

      const allPos = turns.every((t) => t > 1e-3);
      const allNeg = turns.every((t) => t < -1e-3);
      if (!allPos && !allNeg) {
        return {
          valid: false,
          reason:
            "Card corners form a concave shape. Mark all 4 outer corners of the flat card.",
        };
      }

      // Reject extreme opposite-edge foreshortening ratios (> 5.5x)
      const e01 = dist2D(quad[0], quad[1]);
      const e12 = dist2D(quad[1], quad[2]);
      const e23 = dist2D(quad[2], quad[3]);
      const e30 = dist2D(quad[3], quad[0]);
      const minEdge = Math.min(e01, e12, e23, e30);
      if (minEdge < minCornerSeparationPx) {
        return {
          valid: false,
          reason:
            "Reference card appears too small in the frame for reliable calibration. Move closer and retake.",
        };
      }

      const oppRatio1 = Math.max(e01, e23) / Math.max(1e-6, Math.min(e01, e23));
      const oppRatio2 = Math.max(e12, e30) / Math.max(1e-6, Math.min(e12, e30));
      if (oppRatio1 > 5.5 || oppRatio2 > 5.5) {
        return {
          valid: false,
          reason:
            "Perspective distortion on the card is too severe. Re-mark the corners accurately or retake from a less extreme angle.",
        };
      }

      const canonical = canonicalizeCardQuad(quad);
      const dst = getTargetCardWorldCorners(cardOrientation);
      const H = computeHomography(canonical, dst);
      if (!H) {
        return {
          valid: false,
          reason: "Could not solve planar homography from those card corners.",
        };
      }
    }

    return { valid: true };
  }

  // Stage 2: Marking the 2 coplanar shelf endpoints
  if (shelfEndpoints.length >= 2) {
    return {
      valid: false,
      reason: "Both shelf endpoints are already marked. Click Undo or Reset Marks to adjust.",
    };
  }

  const canonicalCard = canonicalizeCardQuad(
    cardCorners as [Point2D, Point2D, Point2D, Point2D],
  );
  const dst = getTargetCardWorldCorners(cardOrientation);
  const H = computeHomography(canonicalCard, dst);
  if (!H) {
    return { valid: false, reason: "Card calibration homography is invalid." };
  }

  // Ensure the tapped shelf point lies on the visible side of the vanishing horizon
  const cardCenter = {
    x: (canonicalCard[0].x + canonicalCard[1].x + canonicalCard[2].x + canonicalCard[3].x) / 4,
    y: (canonicalCard[0].y + canonicalCard[1].y + canonicalCard[2].y + canonicalCard[3].y) / 4,
  };
  const projCenter = projectPoint(H, cardCenter);
  const projCandidate = projectPoint(H, candidate);
  if (
    !projCenter ||
    !projCandidate ||
    projCenter.w * projCandidate.w <= 0 ||
    Math.abs(projCandidate.w / projCenter.w) < 0.08
  ) {
    return {
      valid: false,
      reason:
        "Shelf tap falls near or beyond the perspective vanishing horizon of the card plane. Ensure card and shelf are coplanar.",
    };
  }

  if (shelfEndpoints.length === 1) {
    const firstShelfPt = shelfEndpoints[0];
    const minShelfSpanPx = Math.max(14, minScale * 0.025);
    if (dist2D(firstShelfPt, candidate) < minShelfSpanPx) {
      return {
        valid: false,
        reason:
          "Second shelf endpoint is too close to the first endpoint. Tap the opposite end of the shelf.",
      };
    }

    const projFirst = projectPoint(H, firstShelfPt);
    if (!projFirst) {
      return { valid: false, reason: "First shelf endpoint could not be projected." };
    }

    const spanMm = dist2D(projFirst, projCandidate);
    if (spanMm < 25) {
      return {
        valid: false,
        reason: "Estimated shelf span is under 25 mm (1 in). Tap the full usable shelf width.",
      };
    }
    if (spanMm > 4500) {
      return {
        valid: false,
        reason:
          "Estimated span exceeds 4.5 meters—check that the card is flat on the same plane as the shelf.",
      };
    }
  }

  return { valid: true };
}

function rawShelfWidthMmForPoints(
  canonicalCard: [Point2D, Point2D, Point2D, Point2D],
  shelfA: Point2D,
  shelfB: Point2D,
  cardOrientation: CardOrientation,
): number | null {
  const dst = getTargetCardWorldCorners(cardOrientation);
  const H = computeHomography(canonicalCard, dst);
  if (!H) return null;
  const pA = projectPoint(H, shelfA);
  const pB = projectPoint(H, shelfB);
  if (!pA || !pB || pA.w * pB.w <= 0) return null;
  return dist2D(pA, pB);
}

/**
 * Estimates coplanar shelf width (nominal + 95% tap-uncertainty interval)
 * from 4 card corners (85.60 x 53.98 mm) and 2 coplanar shelf endpoints.
 */
export function estimateCalibratedShelfWidth(params: {
  cardCorners: [Point2D, Point2D, Point2D, Point2D];
  shelfEndpoints: [Point2D, Point2D];
  frameWidth: number;
  frameHeight: number;
  cardOrientation?: CardOrientation;
  tapUncertaintyPx?: number;
}): ShelfCalibrationResult {
  const {
    cardCorners,
    shelfEndpoints,
    frameWidth,
    frameHeight,
    cardOrientation = "landscape",
  } = params;

  const canonicalCard = canonicalizeCardQuad(cardCorners);
  const dst = getTargetCardWorldCorners(cardOrientation);
  const H = computeHomography(canonicalCard, dst);
  if (!H) {
    throw new Error("Unable to solve planar homography from the marked card corners.");
  }

  // Compute RMS reprojection error on the 4 card corners in mm
  let sqErrSum = 0;
  for (let i = 0; i < 4; i++) {
    const p = projectPoint(H, canonicalCard[i]);
    if (!p) {
      throw new Error("Singular card corner projection.");
    }
    const dx = p.x - dst[i].x;
    const dy = p.y - dst[i].y;
    sqErrSum += dx * dx + dy * dy;
  }
  const reprojectionErrorMm = Math.sqrt(sqErrSum / 4);

  const nominalWidthMm = rawShelfWidthMmForPoints(
    canonicalCard,
    shelfEndpoints[0],
    shelfEndpoints[1],
    cardOrientation,
  );
  if (nominalWidthMm === null || !Number.isFinite(nominalWidthMm) || nominalWidthMm <= 0) {
    throw new Error("Unable to project shelf endpoints onto the calibrated card plane.");
  }

  // Default tap localization uncertainty: ~2.0 px 1-sigma on a 1280x720 frame, scaled proportionally by diagonal
  const defaultSigmaPx =
    2.0 * (Math.hypot(frameWidth, frameHeight) / Math.hypot(1280, 720));
  const sigmaPx =
    typeof params.tapUncertaintyPx === "number" && params.tapUncertaintyPx > 0
      ? params.tapUncertaintyPx
      : Math.max(1.2, defaultSigmaPx);

  // Propagate tap uncertainty across ALL 6 points (12 coordinates: 4 card corners + 2 shelf endpoints)
  // via central finite differences of the full homography -> distance pipeline.
  const eps = 0.5;
  const baseCoords = [
    canonicalCard[0].x,
    canonicalCard[0].y,
    canonicalCard[1].x,
    canonicalCard[1].y,
    canonicalCard[2].x,
    canonicalCard[2].y,
    canonicalCard[3].x,
    canonicalCard[3].y,
    shelfEndpoints[0].x,
    shelfEndpoints[0].y,
    shelfEndpoints[1].x,
    shelfEndpoints[1].y,
  ];

  const evalFromVec = (vec: number[]): number | null =>
    rawShelfWidthMmForPoints(
      [
        { x: vec[0], y: vec[1] },
        { x: vec[2], y: vec[3] },
        { x: vec[4], y: vec[5] },
        { x: vec[6], y: vec[7] },
      ],
      { x: vec[8], y: vec[9] },
      { x: vec[10], y: vec[11] },
      cardOrientation,
    );

  let gradNormSq = 0;
  for (let k = 0; k < 12; k++) {
    const plusVec = [...baseCoords];
    const minusVec = [...baseCoords];
    plusVec[k] += eps;
    minusVec[k] -= eps;
    const fPlus = evalFromVec(plusVec);
    const fMinus = evalFromVec(minusVec);
    if (fPlus !== null && fMinus !== null) {
      const deriv = (fPlus - fMinus) / (2 * eps);
      gradNormSq += deriv * deriv;
    }
  }

  // 95% two-sided confidence half-width (1.96 * sigma * ||grad||)
  const jacobianHalfWidthMm = 1.96 * sigmaPx * Math.sqrt(gradNormSq);

  // Direct endpoint perturbation floor along image shelf axis
  const shelfDx = shelfEndpoints[1].x - shelfEndpoints[0].x;
  const shelfDy = shelfEndpoints[1].y - shelfEndpoints[0].y;
  const shelfPixLen = Math.max(1e-6, Math.hypot(shelfDx, shelfDy));
  const ux = shelfDx / shelfPixLen;
  const uy = shelfDy / shelfPixLen;

  const stretchedMm =
    rawShelfWidthMmForPoints(
      canonicalCard,
      { x: shelfEndpoints[0].x - ux * sigmaPx, y: shelfEndpoints[0].y - uy * sigmaPx },
      { x: shelfEndpoints[1].x + ux * sigmaPx, y: shelfEndpoints[1].y + uy * sigmaPx },
      cardOrientation,
    ) ?? nominalWidthMm;

  const endpointFloorMm = Math.abs(stretchedMm - nominalWidthMm);
  const halfWidthMm = Math.max(jacobianHalfWidthMm, endpointFloorMm, 1.0);

  const minWidthMm = Math.max(0, nominalWidthMm - halfWidthMm);
  const maxWidthMm = nominalWidthMm + halfWidthMm;

  return {
    cardCorners: canonicalCard,
    shelfEndpoints: [
      { x: shelfEndpoints[0].x, y: shelfEndpoints[0].y },
      { x: shelfEndpoints[1].x, y: shelfEndpoints[1].y },
    ],
    cardOrientation,
    frameWidth,
    frameHeight,
    nominalWidthMm,
    minWidthMm,
    maxWidthMm,
    nominalWidthInches: nominalWidthMm / MM_PER_INCH,
    minWidthInches: minWidthMm / MM_PER_INCH,
    maxWidthInches: maxWidthMm / MM_PER_INCH,
    tapUncertaintyPx: sigmaPx,
    reprojectionErrorMm,
    capturedAt: new Date().toISOString(),
  };
}
