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
  imageBase64?: string | null;
  mimeType?: string | null;
  rambleText: string;
}): Promise<SpaceQueryInterpretation> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Direct Shop MCP search works without a key, or add GEMINI_API_KEY in Settings > Secrets for live camera & voice interpretation.",
    );
  }

  const ai = new GoogleGenAI({ apiKey });

  const inputBlocks: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        data: string;
        mime_type: string;
        resolution: "low" | "medium" | "high" | "ultra_high";
      }
  > = [];

  if (params.imageBase64 && params.mimeType) {
    inputBlocks.push({
      type: "image",
      data: params.imageBase64,
      mime_type: params.mimeType,
      resolution: "medium",
    });
  }

  inputBlocks.push({
    type: "text",
    text: `Customer spoken/typed request: "${params.rambleText}"\n\nConvert this into a concise Shop MCP product search query, extract active constraints (handling self-corrections such as "forget wood, matte black metal"), and list superseded constraints separately.`,
  });

  const interaction = await ai.interactions.create({
    model: "gemini-4-hydrogen",
    system_instruction:
      "You translate a user's camera scene and spoken shopping constraints into a concise Shop MCP catalog search query. Preserve intent without adding extraneous adjectives. Handle mid-sentence corrections cleanly so superseded traits move into supersededConstraints.",
    input: inputBlocks,
    response_format: {
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
  });

  const lastStep = interaction.steps?.at(-1);
  let rawJson = "";
  if (lastStep && lastStep.type === "model_output") {
    const textPart = lastStep.content?.find((c) => c.type === "text");
    if (textPart && "text" in textPart && typeof textPart.text === "string") {
      rawJson = textPart.text.trim();
    }
  }
  if (!rawJson && interaction.output_text) {
    rawJson = interaction.output_text.trim();
  }
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
