import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { neon } from "@neon/ai-sdk-provider"
import type { LanguageModel, LanguageModelUsage } from "ai"

type Model = ReturnType<typeof neon>
type CallOptions = Parameters<Model["doStream"]>[0]

// Kilo Code gateway: one OpenAI-compatible endpoint that routes to many
// models behind a single API key. Override the base URL with
// KILO_AI_GATEWAY_URL if Kilo moves it again.
const KILO_BASE_URL =
  process.env.KILO_AI_GATEWAY_URL ?? "https://ai-gateway.kilo.ai/api/v1"
// kilo-auto/frontier routes to the strongest model per request (with an
// x-kilocode-mode header, default mode = claude-sonnet). Cheaper tiers:
// kilo-auto/efficient, kilo-auto/free, kilo-auto/small. Or pin one directly,
// e.g. anthropic/claude-sonnet-4.6 or x-ai/grok-code-fast-1.
const KILO_DEFAULT_MODEL = "kilo-auto/frontier"

// Reads the Kilo key from either name; Kilo's docs use KILO_API_KEY and some
// tools document KILOCODE_API_KEY.
function kiloKey() {
  return process.env.KILO_API_KEY ?? process.env.KILOCODE_API_KEY
}

// AI SDK 7 hands every file in a tool result to this older provider as a
// document upload, which the model rejects for images. Send images as images.
function withImageToolResults(options: CallOptions): CallOptions {
  return {
    ...options,
    prompt: options.prompt.map((message) => {
      if (message.role !== "tool") return message

      return {
        ...message,
        content: message.content.map((part) => {
          if (part.type !== "tool-result" || part.output.type !== "content")
            return part

          return {
            ...part,
            output: {
              ...part.output,
              value: part.output.value.map((item) =>
                item.type === "file-data" && item.mediaType.startsWith("image/")
                  ? {
                      type: "image-data" as const,
                      data: item.data,
                      mediaType: item.mediaType,
                    }
                  : item
              ),
            },
          }
        }),
      }
    }),
  }
}

// The model the chat agent talks to when no Kilo key is configured
function neonModel(): Model {
  const model = neon("gpt-5")

  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: (options) => model.doGenerate(withImageToolResults(options)),
    doStream: (options) => model.doStream(withImageToolResults(options)),
  }
}

// The model the chat agent talks to when a Kilo API key is configured
function kiloModel(): LanguageModel {
  const provider = createOpenAICompatible({
    name: "kilo",
    baseURL: KILO_BASE_URL,
    apiKey: kiloKey(),
  })

  return provider.languageModel(process.env.KILO_MODEL ?? KILO_DEFAULT_MODEL)
}

// The model the chat agent talks to
export function chatModel(): LanguageModel {
  return kiloKey() ? kiloModel() : neonModel()
}

// Dollars per million tokens. kilo-auto/frontier routes each request to a
// frontier model of its choosing, so its per-model prices don't map to one
// rate: the defaults below are the price of the models it resolves to most
// (claude-sonnet class). Check GET <baseURL>/models for live per-model
// prices and set KILO_PRICING_INPUT and KILO_PRICING_OUTPUT to what Kilo
// bills you.
function pricing() {
  return kiloKey()
    ? {
        input: Number(process.env.KILO_PRICING_INPUT ?? 3),
        output: Number(process.env.KILO_PRICING_OUTPUT ?? 15),
      }
    : // The Neon gateway bills the provider's list price; it publishes no
      // cheaper rate for cached input.
      { input: 1.25, output: 10 }
}

// What a call to the chat model cost, in millionths of a dollar
export function chatModelCost(usage: LanguageModelUsage) {
  // Dollars per million tokens is millionths of a dollar per token
  const { input, output } = pricing()
  return Math.ceil(
    (usage.inputTokens ?? 0) * input + (usage.outputTokens ?? 0) * output
  )
}
