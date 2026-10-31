// Smoke test for the Kilo Code gateway setup.
// Reads KILO_API_KEY / KILO_MODEL / KILO_AI_GATEWAY_URL from .env.local
// (or the environment) and checks:
//   1. GET  /models            — the key works and the catalog is reachable
//   2. POST /chat/completions  — a one-shot completion
//   3. POST /chat/completions  — a streamed completion
// Run it on a machine with internet access: npm run test:kilo
import { readFileSync } from "node:fs"

function loadEnv(path = ".env.local") {
  let text = ""
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return {}
  }
  const env = {}
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1)
    if (value && !value.startsWith("#")) env[match[1]] = value
  }
  return env
}

const env = { ...loadEnv(), ...process.env }
const apiKey = env.KILO_API_KEY ?? env.KILOCODE_API_KEY
const baseURL =
  env.KILO_AI_GATEWAY_URL ?? "https://ai-gateway.kilo.ai/api/v1"
const model = env.KILO_MODEL ?? "kilo-auto/frontier"

if (!apiKey) {
  console.error("No KILO_API_KEY found in .env.local or the environment.")
  process.exit(1)
}

const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
}

let failed = false
async function step(name, fn) {
  try {
    await fn()
  } catch (error) {
    failed = true
    console.error(`\n✖ ${name} failed: ${error.message}`)
  }
}

console.log(`Kilo gateway: ${baseURL}`)
console.log(`Model: ${model}`)
console.log(`Key: ${apiKey.slice(0, 12)}…${apiKey.slice(-6)} (length ${apiKey.length})\n`)

// 1. Model catalog
await step("GET /models", async () => {
  const response = await fetch(`${baseURL}/models`, { headers })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  }
  const body = await response.json()
  const models = body.data ?? []
  console.log(`✔ GET /models — ${models.length} models, e.g.:`)
  console.log(
    models.slice(0, 12).map((m) => `  ${m.id}`).join("\n") ||
      "  (empty catalog)"
  )
})

// 2. One-shot completion
await step("POST /chat/completions (one-shot)", async () => {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly: Kilo works." }],
      max_tokens: 64,
      stream: false,
    }),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  }
  const body = await response.json()
  const reply = body.choices?.[0]?.message?.content ?? "(no content)"
  console.log(`✔ One-shot reply: ${reply}`)
  console.log(
    `  usage: ${JSON.stringify(body.usage ?? "(no usage reported)")}`
  )
})

// 3. Streamed completion
await step("POST /chat/completions (streamed)", async () => {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Count from 1 to 5, comma separated." }],
      max_tokens: 64,
      stream: true,
    }),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  }
  let text = ""
  for await (const chunk of response.body) {
    const events = new TextDecoder().decode(chunk)
    for (const line of events.split("\n")) {
      const data = line.trimStart().startsWith("data:")
        ? line.trim().slice(5).trim()
        : ""
      if (!data || data === "[DONE]") continue
      try {
        const event = JSON.parse(data)
        const delta = event.choices?.[0]?.delta?.content ?? ""
        if (delta) text += delta
      } catch {
        // partial JSON across chunks — the next chunk completes it
      }
    }
  }
  if (!text) throw new Error("stream produced no text")
  console.log(`✔ Streamed reply: ${text}`)
})

console.log(
  failed
    ? "\nResult: something failed (see above)."
    : "\nResult: all good — the Kilo key works."
)
process.exit(failed ? 1 : 0)
