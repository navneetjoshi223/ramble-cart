import type http from "node:http";
import { GoogleGenAI, Modality, type LiveServerMessage } from "@google/genai";
import { WebSocket, WebSocketServer } from "ws";

export const LIVE_TRANSCRIBE_MODEL = "gemini-3.5-transcribe-live";

interface ClientAudioMessage {
  audio?: string;
}

/**
 * Bridges browser WebSocket 16kHz PCM microphone streams to Gemini Live API
 * (`gemini-3.5-transcribe-live`) for real-time word-by-word transcription that
 * works across all browsers, iframes, and networks without Chrome Web Speech.
 */
export function attachLiveTranscribeWebSocket(
  httpServer: http.Server,
  wsPath = "/api/live/transcribe",
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname !== wsPath) {
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } catch {
      socket.destroy();
    }
  });

  wss.on("connection", (clientWs) => {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({
            type: "error",
            message:
              "GEMINI_API_KEY is not configured in Settings > Secrets for live voice transcription.",
          }),
        );
      }
      clientWs.close(1011, "Missing GEMINI_API_KEY");
      return;
    }

    let closed = false;
    let readySent = false;
    const ai = new GoogleGenAI({
      apiKey,
      apiVersion: "v1alpha",
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });

    const safeSend = (payload: Record<string, unknown>) => {
      if (!closed && clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.send(JSON.stringify(payload));
        } catch {
          // ignore send errors on closing socket
        }
      }
    };

    const emitReadyOnce = () => {
      if (!readySent) {
        readySent = true;
        safeSend({ type: "ready", model: LIVE_TRANSCRIBE_MODEL });
      }
    };

    const sessionPromise = ai.live
      .connect({
        model: LIVE_TRANSCRIBE_MODEL,
        config: {
          responseModalities: [Modality.TEXT],
          inputAudioTranscription: {
            languageCodes: [],
          },
        },
        callbacks: {
          onopen: () => {
            // Wait for setupComplete in onmessage so Gemini Live is ready for PCM frames
          },
          onmessage: (message: LiveServerMessage) => {
            if (closed) return;
            if (message.setupComplete) {
              emitReadyOnce();
            }

            const content = message.serverContent as
              | (NonNullable<LiveServerMessage["serverContent"]> & {
                  interimInputTranscription?: { text?: string };
                })
              | undefined;

            const interimText = content?.interimInputTranscription?.text;
            if (typeof interimText === "string" && interimText.length > 0) {
              safeSend({ type: "interim", text: interimText });
            }

            const finalText = content?.inputTranscription?.text;
            if (typeof finalText === "string" && finalText.length > 0) {
              safeSend({ type: "final", text: finalText });
            }
          },
          onerror: (err: unknown) => {
            const msg =
              err instanceof Error
                ? err.message
                : typeof err === "object" && err && "message" in err
                  ? String((err as { message?: unknown }).message)
                  : "Live transcription session error.";
            console.error("[/api/live/transcribe] Gemini Live error:", msg);
            safeSend({ type: "error", message: msg });
          },
          onclose: (event?: { reason?: string; code?: number }) => {
            safeSend({
              type: "closed",
              reason: event?.reason || "",
              code: event?.code || 1000,
            });
            if (!closed && clientWs.readyState === WebSocket.OPEN) {
              clientWs.close();
            }
          },
        },
      })
      .catch((err: unknown) => {
        const rawMsg =
          err instanceof Error ? err.message : "Could not connect to Gemini Live transcription.";
        console.error("[/api/live/transcribe] connect failed:", rawMsg);
        safeSend({ type: "error", message: rawMsg });
        if (!closed && clientWs.readyState === WebSocket.OPEN) {
          clientWs.close(1011, "Live connect failed");
        }
        return null;
      });

    clientWs.on("message", (rawData) => {
      if (closed) return;
      let parsed: ClientAudioMessage | null = null;
      try {
        parsed = JSON.parse(rawData.toString()) as ClientAudioMessage;
      } catch {
        return;
      }
      if (!parsed || typeof parsed.audio !== "string" || !parsed.audio) {
        return;
      }
      const audioBase64 = parsed.audio;
      void sessionPromise.then((session) => {
        if (!session || closed) return;
        try {
          session.sendRealtimeInput({
            audio: {
              data: audioBase64,
              mimeType: "audio/pcm;rate=16000",
            },
          });
        } catch {
          // ignore write errors if session already closed
        }
      });
    });

    const cleanup = () => {
      if (closed) return;
      closed = true;
      void sessionPromise.then((session) => {
        if (!session) return;
        try {
          session.close();
        } catch {
          // ignore close errors
        }
      });
    };

    clientWs.on("close", cleanup);
    clientWs.on("error", cleanup);
  });

  return wss;
}
