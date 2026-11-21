import { describe, expect, it } from "vitest";
import type { Point2D } from "../src/types";
import {
  estimateCalibratedShelfWidth,
  ISO_CARD_HEIGHT_MM,
  ISO_CARD_WIDTH_MM,
  MM_PER_INCH,
  validateCalibrationTap,
} from "../src/utils/spatialCalibration";

/**
 * Projects a 3D planar point (X, Y, 0) in millimeters onto a synthetic pinhole camera
 * rotated by yaw + pitch and translated by (tx, ty, tz) in camera coordinates.
 */
function project3DPlanePointToPixel(
  X: number,
  Y: number,
  params: {
    yawDeg: number;
    pitchDeg: number;
    tx: number;
    ty: number;
    tz: number;
    fx: number;
    fy: number;
    cx: number;
    cy: number;
  },
): Point2D {
  const yaw = (params.yawDeg * Math.PI) / 180;
  const pitch = (params.pitchDeg * Math.PI) / 180;

  const cyaw = Math.cos(yaw);
  const syaw = Math.sin(yaw);
  const cpitch = Math.cos(pitch);
  const spitch = Math.sin(pitch);

  // Rotate around Y (yaw), then around X (pitch)
  const x1 = cyaw * X + 0 * Y;
  const y1 = Y;
  const z1 = -syaw * X;

  const xCam = x1 + params.tx;
  const yCam = cpitch * y1 - spitch * z1 + params.ty;
  const zCam = spitch * y1 + cpitch * z1 + params.tz;

  return {
    x: params.cx + (params.fx * xCam) / zCam,
    y: params.cy + (params.fy * yCam) / zCam,
  };
}

describe("spatialCalibration — planar homography, uncertainty & tap validation", () => {
  it("recovers exact coplanar span in mm and inches on a fronto-parallel frame", () => {
    const scalePxPerMm = 2.0;
    const ox = 120;
    const oy = 200;

    const cardCorners: [Point2D, Point2D, Point2D, Point2D] = [
      { x: ox, y: oy },
      { x: ox + ISO_CARD_WIDTH_MM * scalePxPerMm, y: oy },
      {
        x: ox + ISO_CARD_WIDTH_MM * scalePxPerMm,
        y: oy + ISO_CARD_HEIGHT_MM * scalePxPerMm,
      },
      { x: ox, y: oy + ISO_CARD_HEIGHT_MM * scalePxPerMm },
    ];

    const targetInches = 24.0;
    const targetMm = targetInches * MM_PER_INCH; // 609.6 mm
    const shelfEndpoints: [Point2D, Point2D] = [
      { x: 60, y: 360 },
      { x: 60 + targetMm * scalePxPerMm, y: 360 },
    ];

    const res = estimateCalibratedShelfWidth({
      cardCorners,
      shelfEndpoints,
      frameWidth: 1400,
      frameHeight: 900,
      cardOrientation: "landscape",
      tapUncertaintyPx: 2.5,
    });

    expect(res.nominalWidthMm).toBeCloseTo(targetMm, 3);
    expect(res.nominalWidthInches).toBeCloseTo(targetInches, 4);
    expect(res.reprojectionErrorMm).toBeLessThan(1e-6);
    expect(res.minWidthInches).toBeLessThan(res.nominalWidthInches);
    expect(res.maxWidthInches).toBeGreaterThan(res.nominalWidthInches);
  });

  it("recovers accurate coplanar span under 3D perspective tilt and foreshortening", () => {
    const cam = {
      yawDeg: 22,
      pitchDeg: 28,
      tx: -120,
      ty: -40,
      tz: 680,
      fx: 960,
      fy: 960,
      cx: 640,
      cy: 360,
    };

    // Place 85.60 x 53.98 mm reference card at (0, 0) on the Z=0 plane
    const cardCorners: [Point2D, Point2D, Point2D, Point2D] = [
      project3DPlanePointToPixel(0, 0, cam),
      project3DPlanePointToPixel(ISO_CARD_WIDTH_MM, 0, cam),
      project3DPlanePointToPixel(ISO_CARD_WIDTH_MM, ISO_CARD_HEIGHT_MM, cam),
      project3DPlanePointToPixel(0, ISO_CARD_HEIGHT_MM, cam),
    ];

    // Coplanar desk gap of 20.0 inches (508.0 mm) tilted along the plane
    const trueSpanMm = 20.0 * MM_PER_INCH;
    const shelfEndpoints: [Point2D, Point2D] = [
      project3DPlanePointToPixel(-80, 110, cam),
      project3DPlanePointToPixel(-80 + trueSpanMm, 110, cam),
    ];

    const res = estimateCalibratedShelfWidth({
      cardCorners,
      shelfEndpoints,
      frameWidth: 1280,
      frameHeight: 720,
      cardOrientation: "landscape",
    });

    expect(res.nominalWidthInches).toBeCloseTo(20.0, 2);
    expect(res.nominalWidthMm).toBeCloseTo(trueSpanMm, 1);
    expect(res.minWidthInches).toBeLessThan(20.0);
    expect(res.maxWidthInches).toBeGreaterThan(20.0);
  });

  it("produces identical nominal width whether card corners are tapped CW or CCW, and supports portrait orientation", () => {
    const cwCorners: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 200, y: 150 },
      { x: 200 + ISO_CARD_HEIGHT_MM * 2.5, y: 150 },
      {
        x: 200 + ISO_CARD_HEIGHT_MM * 2.5,
        y: 150 + ISO_CARD_WIDTH_MM * 2.5,
      },
      { x: 200, y: 150 + ISO_CARD_WIDTH_MM * 2.5 },
    ];
    const ccwCorners: [Point2D, Point2D, Point2D, Point2D] = [
      cwCorners[0],
      cwCorners[3],
      cwCorners[2],
      cwCorners[1],
    ];
    const endpoints: [Point2D, Point2D] = [
      { x: 100, y: 420 },
      { x: 100 + 457.2 * 2.5, y: 420 }, // 18.0 inches
    ];

    const cwRes = estimateCalibratedShelfWidth({
      cardCorners: cwCorners,
      shelfEndpoints: endpoints,
      frameWidth: 1280,
      frameHeight: 720,
      cardOrientation: "portrait",
    });
    const ccwRes = estimateCalibratedShelfWidth({
      cardCorners: ccwCorners,
      shelfEndpoints: endpoints,
      frameWidth: 1280,
      frameHeight: 720,
      cardOrientation: "portrait",
    });

    expect(cwRes.nominalWidthInches).toBeCloseTo(18.0, 3);
    expect(ccwRes.nominalWidthInches).toBeCloseTo(cwRes.nominalWidthInches, 5);
  });

  it("widens the uncertainty range monotonically when tapUncertaintyPx increases", () => {
    const cardCorners: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 300, y: 200 },
      { x: 471.2, y: 200 },
      { x: 471.2, y: 307.96 },
      { x: 300, y: 307.96 },
    ];
    const shelfEndpoints: [Point2D, Point2D] = [
      { x: 100, y: 400 },
      { x: 1116, y: 400 },
    ];

    const tight = estimateCalibratedShelfWidth({
      cardCorners,
      shelfEndpoints,
      frameWidth: 1280,
      frameHeight: 720,
      tapUncertaintyPx: 1.5,
    });
    const loose = estimateCalibratedShelfWidth({
      cardCorners,
      shelfEndpoints,
      frameWidth: 1280,
      frameHeight: 720,
      tapUncertaintyPx: 6.0,
    });

    const tightSpread = tight.maxWidthInches - tight.minWidthInches;
    const looseSpread = loose.maxWidthInches - loose.minWidthInches;
    expect(looseSpread).toBeGreaterThan(tightSpread * 2.5);
  });

  it("rejects out-of-frame, duplicate, collinear, bowtie, concave, and zero-span taps", () => {
    const fw = 1280;
    const fh = 720;

    // 1. Out of frame
    expect(
      validateCalibrationTap({
        cardCorners: [],
        shelfEndpoints: [],
        candidate: { x: -5, y: 100 },
        frameWidth: fw,
        frameHeight: fh,
      }).valid,
    ).toBe(false);

    // 2. Duplicate corner
    const c1 = { x: 200, y: 200 };
    expect(
      validateCalibrationTap({
        cardCorners: [c1],
        shelfEndpoints: [],
        candidate: { x: 203, y: 202 },
        frameWidth: fw,
        frameHeight: fh,
      }).valid,
    ).toBe(false);

    // 3. Collinear 3rd corner
    const c2 = { x: 400, y: 200 };
    expect(
      validateCalibrationTap({
        cardCorners: [c1, c2],
        shelfEndpoints: [],
        candidate: { x: 600, y: 200.2 },
        frameWidth: fw,
        frameHeight: fh,
      }).valid,
    ).toBe(false);

    // 4. Self-intersecting bowtie (Z-order: TL -> TR -> BL -> BR)
    const c3Bowtie = { x: 200, y: 330 };
    const c4Bowtie = { x: 400, y: 330 };
    const bowtieCheck = validateCalibrationTap({
      cardCorners: [c1, c2, c3Bowtie],
      shelfEndpoints: [],
      candidate: c4Bowtie,
      frameWidth: fw,
      frameHeight: fh,
    });
    expect(bowtieCheck.valid).toBe(false);
    expect(bowtieCheck.reason).toMatch(/bowtie|cross/i);

    // 5. Concave 4th corner (dart/chevron)
    const c3Valid = { x: 400, y: 330 };
    const concaveCandidate = { x: 350, y: 230 };
    const concaveCheck = validateCalibrationTap({
      cardCorners: [c1, c2, c3Valid],
      shelfEndpoints: [],
      candidate: concaveCandidate,
      frameWidth: fw,
      frameHeight: fh,
    });
    expect(concaveCheck.valid).toBe(false);

    // 6. Valid 4th corner passes, then near-zero second shelf endpoint is rejected
    const c4Valid = { x: 200, y: 330 };
    expect(
      validateCalibrationTap({
        cardCorners: [c1, c2, c3Valid],
        shelfEndpoints: [],
        candidate: c4Valid,
        frameWidth: fw,
        frameHeight: fh,
      }).valid,
    ).toBe(true);

    const s1 = { x: 150, y: 450 };
    expect(
      validateCalibrationTap({
        cardCorners: [c1, c2, c3Valid, c4Valid],
        shelfEndpoints: [s1],
        candidate: { x: 154, y: 451 },
        frameWidth: fw,
        frameHeight: fh,
      }).valid,
    ).toBe(false);
  });
});
