export interface NormalizedPrice {
  amountMinor: number;
  currency: string;
  formatted: string;
}

export interface NormalizedMedia {
  url: string;
  altText: string;
  width: number | null;
  height: number | null;
}

export interface NormalizedSeller {
  id: string | null;
  name: string;
  url: string | null;
  domain: string | null;
}

export interface NormalizedOptionSelection {
  name: string;
  label: string;
}

export interface NormalizedProductOption {
  name: string;
  values: string[];
}

export interface NormalizedVariant {
  id: string;
  title: string;
  url: string | null;
  price: NormalizedPrice | null;
  available: boolean | null;
  selectedOptions: NormalizedOptionSelection[];
  seller: NormalizedSeller | null;
  media: NormalizedMedia[];
  condition: string | null;
}

export interface NormalizedProduct {
  id: string;
  title: string;
  handle: string | null;
  descriptionText: string;
  features: string[];
  rating: {
    value: number;
    scaleMax: number;
    count: number;
  } | null;
  media: NormalizedMedia[];
  options: NormalizedProductOption[];
  selectedOptions: NormalizedOptionSelection[];
  primaryVariant: NormalizedVariant | null;
  variants: NormalizedVariant[];
}

export interface NormalizedMessage {
  code: string;
  severity: "info" | "warning" | "error";
  text: string;
}

export interface SearchCatalogResult {
  query: string;
  country: string;
  currency: string;
  fetchedAt: string;
  products: NormalizedProduct[];
  messages: NormalizedMessage[];
  pagination: {
    hasNextPage: boolean;
    totalCount: number | null;
    cursor: string | null;
  };
}

export interface GetProductResult {
  fetchedAt: string;
  product: NormalizedProduct;
  messages: NormalizedMessage[];
}

export type ConstraintKind = "required" | "preferred" | "excluded" | "spatial";

export interface ActiveConstraint {
  text: string;
  kind: ConstraintKind;
}

export interface DimensionalRequirements {
  maxWidthInches: number | null;
  maxHeightInches: number | null;
  maxDepthInches: number | null;
  rawText: string | null;
}

export interface HydrogenIntentExtraction {
  model: "gemini-4-hydrogen";
  transcript: string;
  productCategory: string | null;
  shoppingIntent: string;
  searchQuery: string;
  maximumBudget: number | null;
  currency: string;
  requiredAttributes: string[];
  excludedAttributes: string[];
  preferredAttributes: string[];
  functionalRequirements: string[];
  dimensionalRequirements: DimensionalRequirements;
  supersededConstraints: string[];
  unresolvedConstraints: string[];
  confidence: number;
  clarificationQuestion: string | null;
  latencyMs: number;
}

export interface NeonSpatialPerception {
  model: "gemini-4-neon";
  targetSpace: string;
  sceneDescription: string;
  existingObjects: string[];
  usableRegion: string;
  dominantColors: string[];
  visibleMaterials: string[];
  aestheticStyle: string;
  referenceObject: string | null;
  calibrationStatus: "calibrated" | "partial" | "uncalibrated";
  estimatedWidthRangeInches: string | null;
  estimatedHeightRangeInches: string | null;
  estimatedDepthRangeInches: string | null;
  measurementConfidence: "high" | "medium" | "low" | "none";
  measurementLimitations: string;
  additionalViewRequired: boolean;
  suggestedStyleKeywords: string[];
  latencyMs: number;
}

export interface SpaceQueryInterpretation {
  searchQuery: string;
  maxPriceUsd: number | null;
  activeConstraints: ActiveConstraint[];
  supersededConstraints: string[];
  sceneSummary: string;
  hydrogenIntent?: HydrogenIntentExtraction;
  neonSpatial?: NeonSpatialPerception | null;
}

export type VerificationStatus = "VERIFIED" | "UNCERTAIN" | "REJECTED";
export type ConstraintVerdict = "PASS" | "FAIL" | "UNKNOWN";

export interface ExtractedProductAttribute {
  attributeName: string;
  extractedValue: string;
  unit: string | null;
  sourceType:
    | "listing_text"
    | "variant_option"
    | "product_image_diagram"
    | "product_image_visual";
  sourceCitation: string;
  imageIndex: number | null;
  confidence: number;
  observationType: "directly_observed" | "inferred";
}

export interface ConstraintVerificationCheck {
  constraint: string;
  mandatory: boolean;
  verdict: ConstraintVerdict;
  reason: string;
  evidenceSource: string;
  imageIndex: number | null;
}

export interface ProductEvidenceResult {
  model: "gemini-4-neon";
  productId: string;
  variantId: string | null;
  verificationStatus: VerificationStatus;
  statusSummary: string;
  extractedAttributes: ExtractedProductAttribute[];
  constraintChecks: ConstraintVerificationCheck[];
  spatialCompatibilityNote: string;
  inspectedImageCount: number;
  cached: boolean;
  latencyMs: number;
}

export type DecisionAction =
  | "CONTINUE_LISTENING"
  | "UPDATE_CONSTRAINTS"
  | "REPLACE_CONSTRAINT"
  | "REMOVE_CONSTRAINT"
  | "OBSERVE_SPACE"
  | "REQUEST_ANOTHER_ANGLE"
  | "REQUEST_CALIBRATION"
  | "REQUEST_MEASUREMENTS"
  | "CLARIFY_REQUIREMENT"
  | "SEARCH_PRODUCTS"
  | "VERIFY_PRODUCTS"
  | "REFINE_SEARCH"
  | "PRESENT_RESULTS";

export type DecisionTriggerSource =
  | "speech_pause"
  | "live_auto_sync"
  | "manual_submit";

export interface PreviousSessionContext {
  searchQuery?: string;
  maxPriceUsd?: number | null;
  activeConstraints?: ActiveConstraint[];
  sceneSummary?: string;
}

export interface ShoppingDecisionResult {
  model: "gemini-decision-1";
  action: DecisionAction;
  actionConfidence: number;
  topActionProbabilities: Array<{ action: string; probability: number }>;
  shouldSearch: boolean;
  shouldUpdateWishlist: boolean;
  isStillSpeaking: boolean;
  isConstraintCorrection: boolean;
  isVisualContextSufficient: boolean;
  needsCalibrationOrMeasurements: boolean;
  signals: {
    isStillSpeakingProb: number;
    shouldUpdateWishlistProb: number;
    isConstraintCorrectionProb: number;
    isVisualContextSufficientProb: number;
    needsCalibrationProb: number;
    shouldSearchNowProb: number;
  };
  readinessScore: number;
  readinessNormalized: number;
  readinessLabel: string;
  feedbackMessage: string;
  latencyMs: number;
  totalOutputTokens: number;
}

export interface RambleInterpretResponse {
  decision: ShoppingDecisionResult;
  shouldExecuteSearch: boolean;
  interpretation: SpaceQueryInterpretation | null;
}

export interface Point2D {
  x: number;
  y: number;
}

export type CardOrientation = "landscape" | "portrait";
export type DimensionAxis = "width" | "height" | "depth";

export interface ShelfCalibrationResult {
  cardCorners: [Point2D, Point2D, Point2D, Point2D];
  shelfEndpoints: [Point2D, Point2D];
  cardOrientation: CardOrientation;
  axis?: DimensionAxis;
  spanLabel?: string;
  frameWidth: number;
  frameHeight: number;
  nominalWidthMm: number;
  minWidthMm: number;
  maxWidthMm: number;
  nominalWidthInches: number;
  minWidthInches: number;
  maxWidthInches: number;
  tapUncertaintyPx: number;
  reprojectionErrorMm: number;
  capturedAt: string;
}

export interface ActiveSpatialLimit {
  source: "measured" | "spoken";
  axis: DimensionAxis;
  label: string;
  minInches: number;
  maxInches: number;
  nominalInches: number;
  minMm: number;
  maxMm: number;
  clearanceInches: number;
  calibration?: ShelfCalibrationResult | null;
}

export type WidthFitVerdict =
  | "Width fits"
  | "Too wide"
  | "Height fits"
  | "Too tall"
  | "Depth fits"
  | "Too deep"
  | "Too close to confirm"
  | "Width unknown"
  | "Height unknown"
  | "Depth unknown"
  | "Fit unknown";

export interface DocumentedWidthEvidence {
  axis: DimensionAxis;
  widthInches: number;
  widthMm: number;
  rawText: string;
  sourceKind:
    | "variant_option"
    | "neon_photo"
    | "neon_listing"
    | "listing_text";
  sourceLabel: string;
  citationText: string;
  imageIndex: number | null;
}

export interface WidthFitEvaluation {
  axis: DimensionAxis;
  verdict: WidthFitVerdict;
  documentedWidth: DocumentedWidthEvidence | null;
  clearanceInches: number;
  requiredWidthInches: number | null;
  shelfMinInches: number | null;
  shelfMaxInches: number | null;
  shelfNominalInches: number | null;
  marginToMinInches: number | null;
  explanation: string;
}

export type ResultViewMode = "standard" | "scenecart";

export interface BatchShelfFitEntry {
  productId: string;
  variantId: string | null;
  status: "pending" | "ready" | "error";
  productDetail: NormalizedProduct | null;
  neonEvidence: ProductEvidenceResult | null;
  fitEvaluation: WidthFitEvaluation | null;
  errorMessage?: string;
}

