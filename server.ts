import "dotenv/config";
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
      const { imageBase64, mimeType, rambleText } = req.body as {
        imageBase64?: string;
        mimeType?: string;
        rambleText?: string;
      };
      if (!rambleText || !rambleText.trim()) {
        return res.status(400).json({ error: "Please enter or dictate what you need." });
      }
      const interpretation = await interpretSpaceAndRamble({
        imageBase64: imageBase64 ?? null,
        mimeType: mimeType ?? "image/jpeg",
        rambleText: rambleText.trim(),
      });
      res.json(interpretation);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not interpret space.";
      const status = msg.includes("GEMINI_API_KEY") ? 503 : 400;
      res.status(status).json({ error: msg });
    }
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
