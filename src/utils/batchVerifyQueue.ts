import type {
  BatchShelfFitEntry,
  NormalizedProduct,
  ResultViewMode,
  WidthFitVerdict,
} from "../types";

export const BATCH_SHELF_CHECK_LIMIT = 5;
export const MAX_CONCURRENT_SHELF_CHECKS = 2;

const VERDICT_SORT_PRIORITY: Record<WidthFitVerdict, number> = {
  "Width fits": 0,
  "Height fits": 0,
  "Depth fits": 0,
  "Too close to confirm": 1,
  "Width unknown": 2,
  "Height unknown": 2,
  "Depth unknown": 2,
  "Fit unknown": 2,
  "Too wide": 3,
  "Too tall": 3,
  "Too deep": 3,
};

/**
 * Executes async verification tasks over `items` with a strict upper bound on
 * in-flight concurrency (`maxConcurrent`) and discards stale results whenever
 * `signal.aborted` is true or `getCurrentRunId() !== runId`.
 */
export async function runBoundedVerificationBatch<TItem, TResult>(params: {
  items: TItem[];
  maxConcurrent?: number;
  runId: number;
  getCurrentRunId: () => number;
  signal: AbortSignal;
  worker: (item: TItem, index: number, signal: AbortSignal) => Promise<TResult>;
  onItemResolved?: (result: TResult, item: TItem, index: number) => void;
}): Promise<TResult[] | null> {
  const {
    items,
    maxConcurrent = MAX_CONCURRENT_SHELF_CHECKS,
    runId,
    getCurrentRunId,
    signal,
    worker,
    onItemResolved,
  } = params;

  const isStale = () => signal.aborted || getCurrentRunId() !== runId;
  if (isStale()) return null;
  if (items.length === 0) return [];

  const cap = Math.max(1, Math.floor(maxConcurrent));
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  async function runLane() {
    while (true) {
      if (isStale()) return;
      const currentIdx = nextIndex;
      if (currentIdx >= items.length) return;
      nextIndex += 1;

      const item = items[currentIdx];
      const out = await worker(item, currentIdx, signal);
      if (isStale()) return;

      results[currentIdx] = out;
      onItemResolved?.(out, item, currentIdx);
    }
  }

  const laneCount = Math.min(cap, items.length);
  await Promise.all(Array.from({ length: laneCount }, () => runLane()));

  return isStale() ? null : results;
}

/**
 * Produces the product display list for the Standard / SceneCart toggle:
 * - "standard": preserves 100% of the original Shopify search ranking without mutation.
 * - "scenecart": stable-sorts the checked slice (first 5 real Shopify products) by
 *   Width fits -> Too close to confirm -> Width unknown -> Too wide (preserving original
 *   Shopify rank on ties), followed by any remaining unchecked items in original order.
 */
export function orderProductsForViewMode(params: {
  products: NormalizedProduct[];
  entriesByProductId: Record<string, BatchShelfFitEntry | undefined>;
  viewMode: ResultViewMode;
  checkedLimit?: number;
}): NormalizedProduct[] {
  const {
    products,
    entriesByProductId,
    viewMode,
    checkedLimit = BATCH_SHELF_CHECK_LIMIT,
  } = params;

  if (viewMode === "standard") {
    return [...products];
  }

  const head = products.slice(0, checkedLimit).map((product, originalIndex) => {
    const entry = entriesByProductId[product.id];
    const verdict = entry?.fitEvaluation?.verdict;
    const rankBucket = verdict !== undefined ? VERDICT_SORT_PRIORITY[verdict] : 4;
    return { product, originalIndex, rankBucket };
  });

  head.sort((a, b) => {
    if (a.rankBucket !== b.rankBucket) {
      return a.rankBucket - b.rankBucket;
    }
    return a.originalIndex - b.originalIndex;
  });

  const tail = products.slice(checkedLimit);
  return [...head.map((h) => h.product), ...tail];
}
