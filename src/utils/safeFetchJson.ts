export async function safeFetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    credentials: "same-origin",
    ...init,
  });

  const rawText = await res.text();
  const contentType = res.headers.get("content-type") || "";
  const trimmed = rawText.trim();

  let parsed: unknown = null;
  if (trimmed) {
    const looksLikeHtml =
      contentType.includes("text/html") ||
      trimmed.startsWith("<!") ||
      trimmed.startsWith("<html") ||
      trimmed.startsWith("<HTML");

    if (looksLikeHtml) {
      throw new Error(
        `API returned an HTML page instead of JSON (HTTP ${res.status}). Refresh the page or re-publish the app so the backend is active.`,
      );
    }

    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(
        `Unexpected non-JSON response from server (HTTP ${res.status}).`,
      );
    }
  }

  if (!res.ok) {
    const errMessage =
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : `Request failed (HTTP ${res.status}).`;
    throw new Error(errMessage);
  }

  if (parsed === null) {
    throw new Error(`Empty response from server (HTTP ${res.status}).`);
  }

  return parsed as T;
}
