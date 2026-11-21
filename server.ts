import dotenv from "dotenv";
dotenv.config({ override: true });
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

const PORT = Number(process.env.PORT) || 3000;
const shopRateLimiter = new SlidingWindowRateLimiter(30, 60_000);

function getClientKey(req: express.Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "local";
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

  app.post("/api/ramble/interpret", async (req, res) => {
    try {
      const { videoFrames, imageBase64, mimeType, rambleText } = (req.body ?? {}) as {
        videoFrames?: string[];
        imageBase64?: string;
        mimeType?: string;
        rambleText?: string;
      };
      const cleanedFrames = Array.isArray(videoFrames)
        ? videoFrames.filter((f): f is string => typeof f === "string" && f.length > 0).slice(-4)
        : [];
      const cleanedText = rambleText?.trim() || "";
      if (!cleanedText && cleanedFrames.length === 0 && !imageBase64) {
        return res.status(400).json({
          error: "Start live video or describe what fits your space first.",
        });
      }
      const effectivePrompt =
        cleanedText ||
        "Analyze the live camera video stream and generate a concise Shop MCP product search query for the main item or space need shown.";
      const interpretation = await interpretSpaceAndRamble({
        videoFrames: cleanedFrames,
        imageBase64: imageBase64 ?? null,
        mimeType: mimeType ?? "image/jpeg",
        rambleText: effectivePrompt,
      });
      res.json(interpretation);
    } catch (err) {
      const body = (err as { body?: string })?.body;
      const rawMsg = body || (err instanceof Error ? err.message : "Could not interpret space.");

      let friendly = rawMsg;
      if (rawMsg.includes("API_KEY_INVALID") || rawMsg.includes("PERMISSION_DENIED")) {
        friendly =
          "Gemini API key in Settings > Secrets is invalid or not set. Update GEMINI_API_KEY there, or search Shop MCP directly below.";
        console.warn("[/api/ramble/interpret] Gemini API key invalid or missing.");
      } else if (rawMsg.includes("RESOURCE_EXHAUSTED")) {
        friendly =
          "Gemini API quota exceeded. Check billing/quota in Settings > Secrets.";
        console.warn("[/api/ramble/interpret] Gemini API quota exceeded.");
      } else if (rawMsg.includes("NOT_FOUND")) {
        friendly = "Requested Gemini model is unavailable for this API key.";
        console.warn("[/api/ramble/interpret] Requested Gemini model not found.");
      } else {
        console.error("[/api/ramble/interpret] error:", rawMsg);
      }

      const status = rawMsg.includes("GEMINI_API_KEY") ? 503 : 400;
      res.status(status).json({ error: friendly });
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
