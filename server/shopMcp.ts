import { z } from "zod";

export const SHOP_MCP_ENDPOINT = "https://mcp.shop.com" as const;
export const MCP_PROTOCOL_VERSION = "2026-07-28" as const;
export const DEFAULT_TIMEOUT_MS = 12_000;

export const ALLOWED_SHOP_MCP_TOOLS = ["search_catalog", "get_product"] as const;
export type AllowedShopMcpTool = (typeof ALLOWED_SHOP_MCP_TOOLS)[number];

const CLIENT_INFO = {
  name: "ramble-cart",
  version: "1.0.0",
} as const;

export const SearchCatalogInputSchema = z.object({
  query: z.string().trim().min(1, "Enter a product search query.").max(200),
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "Use a 2-letter country code.")
    .transform((v) => v.toUpperCase())
    .default("US"),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, "Use a 3-letter currency code.")
    .transform((v) => v.toUpperCase())
    .default("USD"),
  availableOnly: z.boolean().default(true),
  maxPriceMinor: z.number().int().positive().max(100_000_000).optional(),
  limit: z.number().int().min(1).max(25).default(12),
  cursor: z.string().trim().min(1).max(512).optional(),
});

export type SearchCatalogInput = z.infer<typeof SearchCatalogInputSchema>;

export const GetProductInputSchema = z.object({
  id: z.string().trim().min(1, "Product ID is required.").max(256),
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((v) => v.toUpperCase())
    .default("US"),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .transform((v) => v.toUpperCase())
    .default("USD"),
  selected: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        label: z.string().trim().min(1).max(160),
      }),
    )
    .max(20)
    .optional(),
});

export type GetProductInput = z.infer<typeof GetProductInputSchema>;

export class ShopMcpError extends Error {
  statusCode: number;
  code: string;
  retryAfterSeconds?: number;
  details?: unknown;

  constructor(
    message: string,
    options: {
      statusCode?: number;
      code?: string;
      retryAfterSeconds?: number;
      details?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "ShopMcpError";
    this.statusCode = options.statusCode ?? 502;
    this.code = options.code ?? "SHOP_MCP_ERROR";
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.details = options.details;
  }
}

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

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function getCurrencyMinorExponent(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

export function formatMinorCurrency(
  amountMinor: unknown,
  currencyCode: unknown,
): NormalizedPrice | null {
  if (typeof amountMinor !== "number" || !Number.isFinite(amountMinor)) return null;
  const currency =
    typeof currencyCode === "string" && /^[A-Za-z]{3}$/.test(currencyCode.trim())
      ? currencyCode.trim().toUpperCase()
      : "USD";
  const exponent = getCurrencyMinorExponent(currency);
  const majorAmount = amountMinor / Math.pow(10, exponent);

  try {
    const formattedNumber = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(majorAmount);
    return {
      amountMinor,
      currency,
      formatted: `${formattedNumber} ${currency}`,
    };
  } catch {
    return {
      amountMinor,
      currency,
      formatted: `${majorAmount.toFixed(exponent)} ${currency}`,
    };
  }
}

export function sanitizeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") {
      return null;
    }
    // Preserve exact returned string (including every query parameter) when it is a valid https URL
    return trimmed;
  } catch {
    return null;
  }
}

export function sanitizePlainText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeMediaList(rawMedia: unknown): NormalizedMedia[] {
  if (!Array.isArray(rawMedia)) return [];
  const results: NormalizedMedia[] = [];
  for (const item of rawMedia) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const previewObj =
      obj.preview && typeof obj.preview === "object"
        ? (obj.preview as Record<string, unknown>)
        : null;
    const safeUrl = sanitizeExternalUrl(obj.url) ?? sanitizeExternalUrl(previewObj?.url);
    if (!safeUrl) continue;
    results.push({
      url: safeUrl,
      altText: sanitizePlainText(obj.alt_text) || "Product image",
      width: typeof obj.width === "number" ? obj.width : null,
      height: typeof obj.height === "number" ? obj.height : null,
    });
  }
  return results;
}

function normalizeSeller(rawSeller: unknown): NormalizedSeller | null {
  if (!rawSeller || typeof rawSeller !== "object") return null;
  const s = rawSeller as Record<string, unknown>;
  const name = sanitizePlainText(s.name);
  if (!name) return null;
  return {
    id: typeof s.id === "string" ? s.id : null,
    name,
    url: sanitizeExternalUrl(s.url),
    domain: typeof s.domain === "string" ? sanitizePlainText(s.domain) : null,
  };
}

function normalizeSelectedOptions(raw: unknown): NormalizedOptionSelection[] {
  if (!Array.isArray(raw)) return [];
  const list: NormalizedOptionSelection[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : "";
    const label = typeof o.label === "string" ? o.label : "";
    if (name && label) {
      list.push({ name, label });
    }
  }
  return list;
}

function normalizeVariant(raw: unknown): NormalizedVariant | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id) return null;

  const priceObj =
    v.price && typeof v.price === "object" ? (v.price as Record<string, unknown>) : null;
  const availObj =
    v.availability && typeof v.availability === "object"
      ? (v.availability as Record<string, unknown>)
      : null;

  const available =
    typeof availObj?.available === "boolean"
      ? availObj.available
      : typeof v.available === "boolean"
        ? v.available
        : null;

  return {
    id: v.id,
    title: sanitizePlainText(v.title) || "Default option",
    url: sanitizeExternalUrl(v.url),
    price: priceObj ? formatMinorCurrency(priceObj.amount, priceObj.currency) : null,
    available,
    selectedOptions: normalizeSelectedOptions(v.options ?? v.selected_options),
    seller: normalizeSeller(v.seller),
    media: normalizeMediaList(v.media),
    condition: typeof v.condition === "string" ? sanitizePlainText(v.condition) : null,
  };
}

export function normalizeProduct(raw: unknown): NormalizedProduct | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || !p.id) return null;

  const title = sanitizePlainText(p.title);
  if (!title) return null;

  let descriptionText = "";
  if (typeof p.description === "string") {
    descriptionText = sanitizePlainText(p.description);
  } else if (p.description && typeof p.description === "object") {
    const d = p.description as Record<string, unknown>;
    descriptionText = sanitizePlainText(d.plain ?? d.text ?? "");
  }

  const metadataObj =
    p.metadata && typeof p.metadata === "object"
      ? (p.metadata as Record<string, unknown>)
      : null;
  const rawFeatures = Array.isArray(metadataObj?.top_features)
    ? metadataObj.top_features
    : Array.isArray(metadataObj?.unique_selling_points)
      ? metadataObj.unique_selling_points
      : [];
  const features = rawFeatures
    .filter((f): f is string => typeof f === "string")
    .map((f) => sanitizePlainText(f))
    .filter(Boolean)
    .slice(0, 6);

  const ratingObj =
    p.rating && typeof p.rating === "object" ? (p.rating as Record<string, unknown>) : null;
  const rating =
    ratingObj &&
    typeof ratingObj.value === "number" &&
    typeof ratingObj.count === "number" &&
    ratingObj.count > 0
      ? {
          value: ratingObj.value,
          scaleMax: typeof ratingObj.scale_max === "number" ? ratingObj.scale_max : 5,
          count: ratingObj.count,
        }
      : null;

  const options: NormalizedProductOption[] = [];
  if (Array.isArray(p.options)) {
    for (const opt of p.options) {
      if (!opt || typeof opt !== "object") continue;
      const o = opt as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name : "";
      const values: string[] = [];
      if (Array.isArray(o.values)) {
        for (const val of o.values) {
          if (val && typeof val === "object" && typeof (val as Record<string, unknown>).label === "string") {
            values.push((val as Record<string, unknown>).label as string);
          } else if (typeof val === "string") {
            values.push(val);
          }
        }
      }
      if (name && values.length > 0) {
        options.push({ name, values });
      }
    }
  }

  const variants: NormalizedVariant[] = [];
  if (Array.isArray(p.variants)) {
    for (const rawVar of p.variants) {
      const normalized = normalizeVariant(rawVar);
      if (normalized) variants.push(normalized);
    }
  }

  const primaryVariant = variants[0] ?? null;
  const productMedia = normalizeMediaList(p.media);
  const media =
    productMedia.length > 0 ? productMedia : primaryVariant ? primaryVariant.media : [];
  const selectedOptions = normalizeSelectedOptions(p.selected);

  return {
    id: p.id,
    title,
    handle: typeof p.handle === "string" ? p.handle : null,
    descriptionText: descriptionText || sanitizePlainText(primaryVariant?.title ?? ""),
    features,
    rating,
    media,
    options,
    selectedOptions:
      selectedOptions.length > 0
        ? selectedOptions
        : primaryVariant?.selectedOptions ?? [],
    primaryVariant,
    variants,
  };
}

export function normalizeMessages(rawMessages: unknown): NormalizedMessage[] {
  if (!Array.isArray(rawMessages)) return [];
  const out: NormalizedMessage[] = [];
  for (const m of rawMessages) {
    if (typeof m === "string") {
      const text = sanitizePlainText(m);
      if (text) out.push({ code: "info", severity: "info", text });
      continue;
    }
    if (!m || typeof m !== "object") continue;
    const obj = m as Record<string, unknown>;
    const code = typeof obj.code === "string" ? sanitizePlainText(obj.code) : "notice";
    const severity =
      obj.severity === "error" || obj.type === "error"
        ? "error"
        : obj.severity === "warning" || obj.type === "warning"
          ? "warning"
          : "info";
    const text = sanitizePlainText(obj.text ?? obj.message ?? obj.detail ?? "");
    if (text) {
      out.push({ code, severity, text });
    } else if (code !== "notice") {
      out.push({ code, severity, text: code.replace(/_/g, " ") });
    }
  }
  return out;
}

export function parseMcpResponseBody(rawBody: string, contentType: string | null): unknown {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    throw new ShopMcpError("Empty response received from Shop MCP.", {
      statusCode: 502,
      code: "EMPTY_RESPONSE",
    });
  }

  const isSse =
    contentType?.toLowerCase().includes("text/event-stream") ||
    trimmed.startsWith("event:") ||
    trimmed.startsWith("data:");

  if (!isSse) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new ShopMcpError("Invalid JSON response from Shop MCP.", {
        statusCode: 502,
        code: "INVALID_JSON",
      });
    }
  }

  // Extract JSON-RPC payload(s) from SSE data: lines
  const lines = trimmed.split(/\r?\n/);
  const payloads: unknown[] = [];
  let dataBuffer: string[] = [];

  for (const line of lines) {
    if (line.startsWith("data:")) {
      const chunk = line.slice(5).trim();
      if (chunk && chunk !== "[DONE]") {
        dataBuffer.push(chunk);
      }
    } else if (line.trim() === "" && dataBuffer.length > 0) {
      const joined = dataBuffer.join("\n");
      dataBuffer = [];
      try {
        payloads.push(JSON.parse(joined));
      } catch {
        // ignore keepalive/non-JSON comments
      }
    }
  }

  if (dataBuffer.length > 0) {
    const joined = dataBuffer.join("\n");
    try {
      payloads.push(JSON.parse(joined));
    } catch {
      // ignore trailing fragment
    }
  }

  if (payloads.length === 0) {
    throw new ShopMcpError("No JSON-RPC payload found in Shop MCP event stream.", {
      statusCode: 502,
      code: "INVALID_SSE",
    });
  }

  return payloads[payloads.length - 1];
}

function extractToolStructuredContent(rpcPayload: unknown): Record<string, unknown> {
  if (!rpcPayload || typeof rpcPayload !== "object") {
    throw new ShopMcpError("Malformed JSON-RPC response from Shop MCP.", {
      statusCode: 502,
      code: "MALFORMED_RPC",
    });
  }

  const payload = rpcPayload as Record<string, unknown>;

  if (payload.error && typeof payload.error === "object") {
    const errObj = payload.error as Record<string, unknown>;
    const msg =
      sanitizePlainText(errObj.message) || "Shop MCP returned a JSON-RPC error.";
    throw new ShopMcpError(msg, {
      statusCode: 502,
      code: String(errObj.code ?? "JSON_RPC_ERROR"),
      details: errObj.data,
    });
  }

  const result = payload.result;
  if (!result || typeof result !== "object") {
    throw new ShopMcpError("Missing result object in Shop MCP response.", {
      statusCode: 502,
      code: "MISSING_RESULT",
    });
  }

  const resObj = result as Record<string, unknown>;
  const structured =
    resObj.structuredContent && typeof resObj.structuredContent === "object"
      ? (resObj.structuredContent as Record<string, unknown>)
      : null;

  if (resObj.isError === true) {
    const structuredMsgs = structured ? normalizeMessages(structured.messages) : [];
    const contentText = Array.isArray(resObj.content)
      ? resObj.content
          .map((c) =>
            c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string"
              ? sanitizePlainText((c as Record<string, unknown>).text)
              : "",
          )
          .filter(Boolean)
          .join(" ")
      : "";
    const reason =
      structuredMsgs.map((m) => m.text).join(" ") ||
      contentText ||
      "Shop MCP tool reported an error.";
    throw new ShopMcpError(reason, {
      statusCode: 400,
      code: "MCP_TOOL_ERROR",
      details: structured,
    });
  }

  if (structured) {
    return structured;
  }

  // Fallback: parse text content if structuredContent was omitted
  if (Array.isArray(resObj.content)) {
    for (const part of resObj.content) {
      if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
        try {
          const parsed = JSON.parse((part as Record<string, unknown>).text as string);
          if (parsed && typeof parsed === "object") {
            return parsed as Record<string, unknown>;
          }
        } catch {
          // continue
        }
      }
    }
  }

  throw new ShopMcpError("Shop MCP response did not include structuredContent.", {
    statusCode: 502,
    code: "MISSING_STRUCTURED_CONTENT",
  });
}

export async function callShopMcpTool(
  toolName: AllowedShopMcpTool,
  toolArguments: Record<string, unknown>,
  options: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<Record<string, unknown>> {
  if (!ALLOWED_SHOP_MCP_TOOLS.includes(toolName)) {
    throw new ShopMcpError(`Tool "${toolName}" is not allowlisted.`, {
      statusCode: 400,
      code: "TOOL_NOT_ALLOWED",
    });
  }

  const fetchFn = options.fetchImpl ?? fetch;
  const requestBody = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: {
      name: toolName,
      arguments: toolArguments,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };

  const maxAttempts = options.fetchImpl ? 1 : 2;
  let lastError: ShopMcpError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const combinedSignal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    let rawText: string;
    try {
      response = await fetchFn(SHOP_MCP_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          "Mcp-Method": "tools/call",
          "Mcp-Name": toolName,
        },
        body: JSON.stringify(requestBody),
        signal: combinedSignal,
      });

      if (response.status === 429) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
        throw new ShopMcpError(
          "Shop MCP rate limit reached (HTTP 429). Wait briefly before searching again.",
          {
            statusCode: 429,
            code: "RATE_LIMITED",
            retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
          },
        );
      }

      if (!response.ok) {
        const upstreamErr = new ShopMcpError(
          `Shop MCP returned HTTP ${response.status}.`,
          {
            statusCode: response.status >= 500 ? 502 : response.status,
            code: "UPSTREAM_HTTP_ERROR",
          },
        );
        if (response.status >= 500 && attempt < maxAttempts && !options.signal?.aborted) {
          lastError = upstreamErr;
          await new Promise((r) => setTimeout(r, 350));
          continue;
        }
        throw upstreamErr;
      }

      rawText = await response.text();
    } catch (err) {
      if (err instanceof ShopMcpError) {
        throw err;
      }
      if (options.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw new ShopMcpError("Search request was cancelled.", {
          statusCode: 499,
          code: "REQUEST_ABORTED",
        });
      }
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new ShopMcpError("Shop MCP request timed out. Please try again.", {
          statusCode: 504,
          code: "UPSTREAM_TIMEOUT",
        });
      }
      const netErr = new ShopMcpError(
        err instanceof Error ? `Network error reaching Shop MCP: ${err.message}` : "Network error",
        { statusCode: 502, code: "NETWORK_ERROR" },
      );
      if (attempt < maxAttempts && !options.signal?.aborted) {
        lastError = netErr;
        await new Promise((r) => setTimeout(r, 350));
        continue;
      }
      throw netErr;
    }

    const parsedRpc = parseMcpResponseBody(rawText, response.headers.get("content-type"));
    return extractToolStructuredContent(parsedRpc);
  }

  throw (
    lastError ??
    new ShopMcpError("Failed to reach Shop MCP.", {
      statusCode: 502,
      code: "UPSTREAM_HTTP_ERROR",
    })
  );
}

export async function searchShopCatalog(
  rawInput: unknown,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<SearchCatalogResult> {
  const input = SearchCatalogInputSchema.parse(rawInput);

  const filters: Record<string, unknown> = {
    available: input.availableOnly,
    ships_to: { country: input.country },
  };
  if (typeof input.maxPriceMinor === "number") {
    filters.price = { max: input.maxPriceMinor };
  }

  const pagination: Record<string, unknown> = {
    limit: input.limit,
  };
  if (input.cursor) {
    pagination.cursor = input.cursor;
  }

  const structured = await callShopMcpTool(
    "search_catalog",
    {
      catalog: {
        query: input.query,
        filters,
        context: {
          address_country: input.country,
          currency: input.currency,
        },
        pagination,
      },
    },
    options,
  );

  const rawProducts = Array.isArray(structured.products) ? structured.products : [];
  const products = rawProducts
    .map((item) => normalizeProduct(item))
    .filter((p): p is NormalizedProduct => p !== null);

  const paginationObj =
    structured.pagination && typeof structured.pagination === "object"
      ? (structured.pagination as Record<string, unknown>)
      : null;

  return {
    query: input.query,
    country: input.country,
    currency: input.currency,
    fetchedAt: new Date().toISOString(),
    products,
    messages: normalizeMessages(structured.messages),
    pagination: {
      hasNextPage: Boolean(paginationObj?.has_next_page),
      totalCount:
        typeof paginationObj?.total_count === "number" ? paginationObj.total_count : null,
      cursor: typeof paginationObj?.cursor === "string" ? paginationObj.cursor : null,
    },
  };
}

export async function getShopProduct(
  rawInput: unknown,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<GetProductResult> {
  const input = GetProductInputSchema.parse(rawInput);

  const catalogArgs: Record<string, unknown> = {
    id: input.id,
    context: {
      address_country: input.country,
      currency: input.currency,
    },
  };
  if (input.selected && input.selected.length > 0) {
    catalogArgs.selected = input.selected;
  }

  const structured = await callShopMcpTool(
    "get_product",
    { catalog: catalogArgs },
    options,
  );

  const product = normalizeProduct(structured.product);
  if (!product) {
    throw new ShopMcpError("Product details were unavailable or incomplete.", {
      statusCode: 404,
      code: "PRODUCT_NOT_FOUND",
    });
  }

  return {
    fetchedAt: new Date().toISOString(),
    product,
    messages: normalizeMessages(structured.messages),
  };
}

export class SlidingWindowRateLimiter {
  private hits = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests = 30, windowMs = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const windowStart = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((ts) => ts > windowStart);
    if (recent.length >= this.maxRequests) {
      const oldest = recent[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSeconds };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
