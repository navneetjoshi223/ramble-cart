import { GoogleGenAI, Type } from "@google/genai";

export interface SpaceQueryInterpretation {
  searchQuery: string;
  maxPriceUsd: number | null;
  activeConstraints: Array<{
    text: string;
    kind: "required" | "preferred" | "excluded" | "spatial";
  }>;
  supersededConstraints: string[];
  sceneSummary: string;
}

export async function interpretSpaceAndRamble(params: {
  videoFrames?: string[] | null;
  imageBase64?: string | null;
  mimeType?: string | null;
  rambleText: string;
}): Promise<SpaceQueryInterpretation> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Direct Shop MCP search works without a key, or add GEMINI_API_KEY in Settings > Secrets for live video & voice interpretation.",
    );
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  const parts: Array<
    | { text: string }
    | { inlineData: { mimeType: string; data: string } }
  > = [];

  const mime = params.mimeType || "image/jpeg";
  const frames =
    params.videoFrames && params.videoFrames.length > 0
      ? params.videoFrames.slice(-4)
      : params.imageBase64
        ? [params.imageBase64]
        : [];

  for (const frameBase64 of frames) {
    parts.push({
      inlineData: {
        mimeType: mime,
        data: frameBase64,
      },
    });
  }

  parts.push({
    text: `Live video stream frames captured at 1 FPS (${frames.length} frame(s) attached).\nCustomer spoken/typed request: "${params.rambleText}"\n\nConvert this live video scene and spoken request into a concise Shop MCP product search query, extract active constraints (handling self-corrections such as "forget wood, matte black metal"), and list superseded constraints separately.`,
  });

  const response = await ai.models.generateContent({
    model: "gemini-4-hydrogen",
    contents: { parts },
    config: {
      systemInstruction:
        "You translate a user's live camera video stream (chronological 1 FPS frames) and spoken shopping constraints into a concise Shop MCP catalog search query. Preserve intent without adding extraneous adjectives. Handle mid-sentence corrections cleanly so superseded traits move into supersededConstraints.",
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          searchQuery: {
            type: Type.STRING,
            description: "Concise Shop MCP catalog search query (2 to 6 words).",
          },
          maxPriceUsd: {
            type: Type.NUMBER,
            description: "Maximum budget in USD if specified, or 0 if none.",
          },
          activeConstraints: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                text: { type: Type.STRING },
                kind: {
                  type: Type.STRING,
                  description: "One of: required, preferred, excluded, spatial",
                },
              },
              required: ["text", "kind"],
            },
          },
          supersededConstraints: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          sceneSummary: {
            type: Type.STRING,
            description: "Brief 1-sentence summary of the visible space or request.",
          },
        },
        required: [
          "searchQuery",
          "activeConstraints",
          "supersededConstraints",
          "sceneSummary",
        ],
      },
    },
  });

  const rawJson = (response.text ?? "").trim();
  if (!rawJson) {
    throw new Error("Gemini 4 Hydrogen returned no structured interpretation.");
  }

  const parsed = JSON.parse(rawJson) as SpaceQueryInterpretation;
  return {
    searchQuery: parsed.searchQuery?.trim() || params.rambleText,
    maxPriceUsd:
      typeof parsed.maxPriceUsd === "number" && parsed.maxPriceUsd > 0
        ? parsed.maxPriceUsd
        : null,
    activeConstraints: parsed.activeConstraints ?? [],
    supersededConstraints: parsed.supersededConstraints ?? [],
    sceneSummary: parsed.sceneSummary ?? "",
  };
}
