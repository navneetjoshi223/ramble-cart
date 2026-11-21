import dotenv from "dotenv";
dotenv.config({ override: true });
import http from "node:http";
import path from "node:path";
import express from "express";
import { ZodError } from "zod";
import {
  getShopProduct,
  searchShopCatalog,
  ShopMcpError,
  SlidingWindowRateLimiter,
} from "./server/shopMcp.js";
import { interpretSpaceAndRamble } from "./server/geminiAgent.js";
import { extractProductEvidenceWithNeon } from "./server/neonAgent.js";
import { evaluateShoppingDecision } from "./server/decisionsAgent.js";
import {
  attachLiveTranscribeWebSocket,
  LIVE_TRANSCRIBE_MODEL,
} from "./server/liveTranscribe.js";
import type {
  ActiveConstraint,
  DecisionTriggerSource,
  NormalizedProduct,
  PreviousSessionContext,
  RambleInterpretResponse,
} from "./src/types.js";

const PORT = Number(process.env.PORT) || 3000;
const shopRateLimiter = new SlidingWindowRateLimiter(30, 60_000);

function getClientKey(req: express.Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "local";
}

function handleGeminiRouteError(
  res: express.Response,
  routeLabel: string,
  err: unknown,
) {
  const body = (err as { body?: string })?.body;
  const rawMsg =
    body || (err instanceof Error ? err.message : "Could not process Gemini request.");

  let friendly = rawMsg;
  if (rawMsg.includes("API_KEY_INVALID") || rawMsg.includes("PERMISSION_DENIED")) {
    friendly =
      "Gemini API key in Settings > Secrets is invalid or not set. Update GEMINI_API_KEY there, or search Shop MCP directly below.";
    console.warn(`[${routeLabel}] Gemini API key invalid or missing.`);
  } else if (rawMsg.includes("RESOURCE_EXHAUSTED")) {
    friendly =
      "Gemini API quota exceeded. Check billing/quota in Settings > Secrets.";
    console.warn(`[${routeLabel}] Gemini API quota exceeded.`);
  } else if (rawMsg.includes("NOT_FOUND")) {
    friendly = "Requested Gemini model is unavailable for this API key.";
    console.warn(`[${routeLabel}] Requested Gemini model not found.`);
  } else {
    console.error(`[${routeLabel}] error:`, rawMsg);
  }

  const status = rawMsg.includes("GEMINI_API_KEY") ? 503 : 400;
  return res.status(status).json({ error: friendly });
}

function handleApiError(res: express.Response, err: unknown) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: err.issues[0]?.message || "Invalid request parameters.",
      code: "VALIDATION_ERROR",
    });
  }
  if (err instanceof ShopMcpError) {
    if (err.statusCode === 499) {
      return;
    }
    if (err.retryAfterSeconds) {
      res.setHeader("Retry-After", String(err.retryAfterSeconds));
    }
    return res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      details: err.details,
    });
  }
  const msg = err instanceof Error ? err.message : "Unexpected server error.";
  return res.status(500).json({ error: msg, code: "INTERNAL_ERROR" });
}

async function startServer() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "10mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      shopMcpEndpoint: "https://mcp.shop.com",
      decisionsModel: "gemini-decision-1",
      intentModel: "gemini-4-hydrogen",
      spatialAndEvidenceModel: "gemini-4-neon",
      liveTranscribeModel: LIVE_TRANSCRIBE_MODEL,
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY?.trim()),
    });
  });

  app.post("/api/shop/search", async (req, res) => {
    const rate = shopRateLimiter.check(getClientKey(req));
    if (!rate.allowed) {
      res.setHeader("Retry-After", String(rate.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many search requests. Please wait a moment and try again.",
        code: "LOCAL_RATE_LIMITED",
      });
    }

    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    try {
      const result = await searchShopCatalog(req.body, {
        signal: controller.signal,
      });
      res.json(result);
    } catch (err) {
      handleApiError(res, err);
    }
  });

  app.post("/api/shop/product", async (req, res) => {
    const rate = shopRateLimiter.check(getClientKey(req));
    if (!rate.allowed) {
      res.setHeader("Retry-After", String(rate.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many product detail requests. Please wait a moment.",
        code: "LOCAL_RATE_LIMITED",
      });
    }

    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    try {
      const result = await getShopProduct(req.body, {
        signal: controller.signal,
      });
      res.json(result);
    } catch (err) {
      handleApiError(res, err);
    }
  });

  app.post("/api/shop/product/evidence", async (req, res) => {
    const rate = shopRateLimiter.check(getClientKey(req));
    if (!rate.allowed) {
      res.setHeader("Retry-After", String(rate.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many product verification requests. Please wait a moment.",
        code: "LOCAL_RATE_LIMITED",
      });
    }

    try {
      const { product, activeConstraints, maxPriceUsd, spatialSummary } = (req.body ??
        {}) as {
        product?: NormalizedProduct;
        activeConstraints?: ActiveConstraint[];
        maxPriceUsd?: number | null;
        spatialSummary?: string | null;
      };

      if (!product || typeof product.id !== "string" || typeof product.title !== "string") {
        return res.status(400).json({
          error: "A valid NormalizedProduct with id and title is required for Neon verification.",
          code: "VALIDATION_ERROR",
        });
      }

      const safeConstraints = Array.isArray(activeConstraints)
        ? activeConstraints.filter(
            (c): c is ActiveConstraint =>
              Boolean(c && typeof c.text === "string" && typeof c.kind === "string"),
          )
        : [];

      const evidence = await extractProductEvidenceWithNeon({
        product,
        activeConstraints: safeConstraints,
        maxPriceUsd:
          typeof maxPriceUsd === "number" && Number.isFinite(maxPriceUsd) && maxPriceUsd > 0
            ? maxPriceUsd
            : null,
        spatialSummary:
          typeof spatialSummary === "string" && spatialSummary.trim()
            ? spatialSummary.trim()
            : null,
      });

      res.json(evidence);
    } catch (err) {
      handleGeminiRouteError(res, "/api/shop/product/evidence", err);
    }
  });

  app.post("/api/ramble/decide", async (req, res) => {
    try {
      const {
        videoFrames,
        imageBase64,
        mimeType,
        rambleText,
        triggerSource,
        previousContext,
      } = (req.body ?? {}) as {
        videoFrames?: string[];
        imageBase64?: string;
        mimeType?: string;
        rambleText?: string;
        triggerSource?: DecisionTriggerSource;
        previousContext?: PreviousSessionContext | null;
      };

      const cleanedFrames = Array.isArray(videoFrames)
        ? videoFrames
            .filter((f): f is string => typeof f === "string" && f.length > 0)
            .slice(-4)
        : [];
      const cleanedText = rambleText?.trim() || "";

      if (!cleanedText && cleanedFrames.length === 0 && !imageBase64) {
        return res.status(400).json({
          error: "Start live video or speak/type a request to evaluate a decision.",
        });
      }

      const decision = await evaluateShoppingDecision({
        videoFrames: cleanedFrames,
        imageBase64: imageBase64 ?? null,
        mimeType: mimeType ?? "image/jpeg",
        rambleText: cleanedText,
        triggerSource: triggerSource ?? "manual_submit",
        previousContext: previousContext ?? null,
      });

      res.json(decision);
    } catch (err) {
      handleGeminiRouteError(res, "/api/ramble/decide", err);
    }
  });

  app.post("/api/ramble/interpret", async (req, res) => {
    try {
      const {
        videoFrames,
        imageBase64,
        mimeType,
        rambleText,
        triggerSource,
        previousContext,
      } = (req.body ?? {}) as {
        videoFrames?: string[];
        imageBase64?: string;
        mimeType?: string;
        rambleText?: string;
        triggerSource?: DecisionTriggerSource;
        previousContext?: PreviousSessionContext | null;
      };
      const cleanedFrames = Array.isArray(videoFrames)
        ? videoFrames
            .filter((f): f is string => typeof f === "string" && f.length > 0)
            .slice(-4)
        : [];
      const cleanedText = rambleText?.trim() || "";
      if (!cleanedText && cleanedFrames.length === 0 && !imageBase64) {
        return res.status(400).json({
          error: "Start live video or describe what fits your space first.",
        });
      }

      // Step 1: Gemini Decisions API (`gemini-decision-1`) calibrated action & readiness check
      const decision = await evaluateShoppingDecision({
        videoFrames: cleanedFrames,
        imageBase64: imageBase64 ?? null,
        mimeType: mimeType ?? "image/jpeg",
        rambleText: cleanedText,
        triggerSource: triggerSource ?? "manual_submit",
        previousContext: previousContext ?? null,
      });

      // Prevent premature or redundant Shop MCP searches when Decisions API says to wait/clarify
      if (!decision.shouldSearch) {
        const gatedPayload: RambleInterpretResponse = {
          decision,
          shouldExecuteSearch: false,
          interpretation: null,
        };
        return res.json(gatedPayload);
      }

      // Step 2: Dual Gemini 4 (Hydrogen speech intent + Neon spatial perception)
      const effectivePrompt =
        cleanedText ||
        "Analyze the live camera video stream and generate a concise Shop MCP product search query for the main item or space need shown.";

      const interpretation = await interpretSpaceAndRamble({
        videoFrames: cleanedFrames,
        imageBase64: imageBase64 ?? null,
        mimeType: mimeType ?? "image/jpeg",
        rambleText: effectivePrompt,
        hasSpokenTranscript: Boolean(cleanedText),
        previousContext: previousContext ?? null,
        decisionHint: {
          action: decision.action,
          isConstraintCorrection: decision.isConstraintCorrection,
        },
      });

      const payload: RambleInterpretResponse = {
        decision,
        shouldExecuteSearch: true,
        interpretation,
      };
      res.json(payload);
    } catch (err) {
      handleGeminiRouteError(res, "/api/ramble/interpret", err);
    }
  });

  // Never let any /api/* request fall through to Vite or the SPA HTML fallback
  app.use("/api", (req, res) => {
    res.status(404).json({
      error: `API route not found: ${req.method} ${req.originalUrl}`,
      code: "NOT_FOUND",
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.use((_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Return JSON instead of Express's default HTML error page for API middleware errors (e.g., 413, bad JSON)
  app.use(
    (
      err: { status?: number; statusCode?: number; type?: string; message?: string },
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (res.headersSent) {
        return next(err);
      }
      const status = err.statusCode || err.status || 500;
      const message =
        err.type === "entity.too.large"
          ? "Uploaded camera frame is too large. Try again or disable camera."
          : err.message || "Unexpected server error.";
      if (req.originalUrl.startsWith("/api")) {
        return res.status(status).json({ error: message, code: err.type || "SERVER_ERROR" });
      }
      return res.status(status).send(message);
    },
  );

  const httpServer = http.createServer(app);
  attachLiveTranscribeWebSocket(httpServer, "/api/live/transcribe");

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
