import { describe, expect, it, vi } from "vitest";
import {
  callShopMcpTool,
  formatMinorCurrency,
  getShopProduct,
  normalizeProduct,
  parseMcpResponseBody,
  sanitizeExternalUrl,
  sanitizePlainText,
  searchShopCatalog,
  ShopMcpError,
  SlidingWindowRateLimiter,
  SHOP_MCP_ENDPOINT,
} from "../server/shopMcp.js";

describe("Shop MCP client & normalization", () => {
  it("sends required headers, _meta, and exact endpoint on search_catalog", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(SHOP_MCP_ENDPOINT);
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["Accept"]).toBe("application/json, text/event-stream");
      expect(headers["MCP-Protocol-Version"]).toBe("2026-07-28");
      expect(headers["Mcp-Method"]).toBe("tools/call");
      expect(headers["Mcp-Name"]).toBe("search_catalog");

      const body = JSON.parse(String(init?.body));
      expect(body.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
      expect(body.params._meta["io.modelcontextprotocol/clientInfo"].name).toBe("ramble-cart");

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            structuredContent: {
              products: [
                {
                  id: "gid://shopify/p/123",
                  title: "Matte Black Coffee Dripper",
                  description: { plain: "<p>Handcrafted <b>porcelain</b> &amp; matte glaze.</p>" },
                  options: [{ name: "Color", values: [{ label: "Matte Black" }] }],
                  variants: [
                    {
                      id: "gid://shopify/ProductVariant/456",
                      title: "Matte Black",
                      url: "https://example-shop.com/products/dripper?variant=456&_gsid=xyz&utm_source=shopify",
                      price: { amount: 3500, currency: "USD" },
                      availability: { available: true },
                      options: [{ name: "Color", label: "Matte Black" }],
                      seller: {
                        id: "gid://shopify/Shop/1",
                        name: "Studio Ceramics",
                        url: "https://example-shop.com",
                        domain: "example-shop.myshopify.com",
                      },
                      media: [
                        {
                          url: "https://cdn.shopify.com/s/files/1/dripper.jpg",
                          alt_text: "Black ceramic dripper",
                        },
                      ],
                    },
                  ],
                },
              ],
              messages: [{ code: "price_filter_applied", severity: "info", text: "Applied USD filter" }],
              pagination: { has_next_page: false, total_count: 1, cursor: null },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await searchShopCatalog(
      { query: "ceramic coffee dripper", country: "us", currency: "usd", limit: 10 },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.products).toHaveLength(1);
    const p = result.products[0];
    expect(p.descriptionText).toBe("Handcrafted porcelain & matte glaze.");
    expect(p.primaryVariant?.price?.formatted).toBe("$35.00 USD");
    expect(p.primaryVariant?.url).toBe(
      "https://example-shop.com/products/dripper?variant=456&_gsid=xyz&utm_source=shopify",
    );
    expect(result.messages[0]?.text).toBe("Applied USD filter");
  });

  it("parses text/event-stream responses carrying data: lines", async () => {
    const sseBody = [
      "event: message",
      'data: {"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"products":[],"messages":[{"code":"empty","text":"No matching items"}]}}}',
      "",
    ].join("\n");

    const parsed = parseMcpResponseBody(sseBody, "text/event-stream") as {
      result: { structuredContent: { products: unknown[] } };
    };
    expect(parsed.result.structuredContent.products).toEqual([]);
  });

  it("handles HTTP 429 without retry loops", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": "15" },
      });
    });

    await expect(
      searchShopCatalog(
        { query: "desk lamp" },
        { fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({
      name: "ShopMcpError",
      statusCode: 429,
      code: "RATE_LIMITED",
      retryAfterSeconds: 15,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces top-level JSON-RPC errors and result.isError diagnostics", async () => {
    const rpcErrorFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32602, message: "Invalid country code" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      searchShopCatalog(
        { query: "lamp" },
        { fetchImpl: rpcErrorFetch as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({
      code: "-32602",
      message: "Invalid country code",
    });

    const isErrorFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            isError: true,
            structuredContent: {
              messages: [{ code: "invalid_cursor", text: "Cursor expired" }],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      searchShopCatalog(
        { query: "lamp" },
        { fetchImpl: isErrorFetch as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({
      code: "MCP_TOOL_ERROR",
      message: "Cursor expired",
    });
  });

  it("rejects non-allowlisted tools and invalid inputs", async () => {
    await expect(
      callShopMcpTool("create_cart" as unknown as "search_catalog", {}),
    ).rejects.toThrow(/not allowlisted/i);

    await expect(searchShopCatalog({ query: "  " })).rejects.toThrow();
    await expect(searchShopCatalog({ query: "lamp", country: "USA" })).rejects.toThrow();
  });

  it("formats minor-unit currencies accurately across 0, 2, and 3 decimals", () => {
    expect(formatMinorCurrency(3500, "USD")?.formatted).toBe("$35.00 USD");
    expect(formatMinorCurrency(1500, "JPY")?.formatted).toBe("¥1,500 JPY");
    expect(formatMinorCurrency(1250, "KWD")?.amountMinor).toBe(1250);
    expect(formatMinorCurrency(1250, "KWD")?.formatted).toContain("1.250");
    expect(formatMinorCurrency(8000, "CAD")?.formatted).toBe("CA$80.00 CAD");
    expect(formatMinorCurrency(Number.NaN, "USD")).toBeNull();
  });

  it("rejects unsafe URLs and strips untrusted HTML scripts", () => {
    expect(sanitizeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeExternalUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(sanitizeExternalUrl("http://insecure.example/item")).toBeNull();
    expect(sanitizeExternalUrl("/relative/path")).toBeNull();
    expect(
      sanitizeExternalUrl("https://shop.example/p?variant=1&_gsid=abc&utm_source=shopify"),
    ).toBe("https://shop.example/p?variant=1&_gsid=abc&utm_source=shopify");

    expect(
      sanitizePlainText('<script>evil()</script><p>Solid <strong>Oak</strong> &amp; Brass</p>'),
    ).toBe("Solid Oak & Brass");
  });

  it("handles missing fields gracefully during normalization", () => {
    const partial = normalizeProduct({
      id: "gid://shopify/p/999",
      title: "Minimalist Tray",
      variants: [
        {
          id: "gid://shopify/ProductVariant/1",
          url: "javascript:void(0)",
          price: { amount: 2400, currency: "USD" },
        },
      ],
    });
    expect(partial).not.toBeNull();
    expect(partial?.primaryVariant?.url).toBeNull();
    expect(partial?.primaryVariant?.available).toBeNull();
    expect(partial?.media).toEqual([]);
    expect(normalizeProduct({ title: "Missing ID" })).toBeNull();
  });

  it("confirms selected option combination in getShopProduct", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.params.name).toBe("get_product");
      expect(body.params.arguments.catalog.selected).toEqual([
        { name: "Color", label: "Matte Black" },
      ]);

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            structuredContent: {
              product: {
                id: "gid://shopify/p/123",
                title: "V60 Ceramic Dripper",
                selected: [{ name: "Color", label: "Matte Black" }],
                options: [{ name: "Color", values: [{ label: "Matte Black" }, { label: "White" }] }],
                variants: [
                  {
                    id: "gid://shopify/ProductVariant/3245",
                    title: "Matte Black",
                    url: "https://www.hario-usa.com/products/v60?variant=3245&_gsid=test",
                    price: { amount: 3500, currency: "USD" },
                    availability: { available: false },
                    options: [{ name: "Color", label: "Matte Black" }],
                    seller: { name: "Hario USA", url: "https://www.hario-usa.com" },
                  },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const details = await getShopProduct(
      {
        id: "gid://shopify/p/123",
        country: "US",
        currency: "USD",
        selected: [{ name: "Color", label: "Matte Black" }],
      },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );

    expect(details.product.primaryVariant?.available).toBe(false);
    expect(details.product.primaryVariant?.price?.formatted).toBe("$35.00 USD");
    expect(details.product.primaryVariant?.seller?.name).toBe("Hario USA");
    expect(details.product.primaryVariant?.url).toBe(
      "https://www.hario-usa.com/products/v60?variant=3245&_gsid=test",
    );
  });

  it("enforces local sliding-window rate limits", () => {
    const limiter = new SlidingWindowRateLimiter(2, 10_000);
    expect(limiter.check("ip1", 1000).allowed).toBe(true);
    expect(limiter.check("ip1", 2000).allowed).toBe(true);
    const blocked = limiter.check("ip1", 3000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(limiter.check("ip1", 12_000).allowed).toBe(true);
  });
});
