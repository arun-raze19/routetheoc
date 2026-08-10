import { createServer } from "node:http"

const MODELS_URL = process.env.MODELS_URL || "https://models.opencode.ai/api.json"
const PORT = parseInt(process.env.PORT || "3000", 10)
const API_KEY = process.env.API_KEY || ""
const LISTEN = process.env.LISTEN || "0.0.0.0"

// Proxy config — individual fields, optional
const PROXY_ADDRESS = process.env.PROXY_ADDRESS || ""
const PROXY_PORT = process.env.PROXY_PORT || ""
const PROXY_USERNAME = process.env.PROXY_USERNAME || ""
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || ""

let UPSTREAM_PROXY = ""
if (PROXY_ADDRESS) {
  const auth = PROXY_USERNAME ? `${PROXY_USERNAME}:${PROXY_PASSWORD}@` : ""
  UPSTREAM_PROXY = `http://${auth}${PROXY_ADDRESS}${PROXY_PORT ? ":" + PROXY_PORT : ""}`
}

let catalog = { providers: {}, models: [] }
let lastFetch = 0
const CATALOG_TTL = 5 * 60 * 1000 // refresh catalog metadata every 5 min

// Per-model status: "unknown" | "ok" | "dead" (401 — model doesn't exist)
const modelStatus = new Map()

async function fetchCatalog() {
  if (Date.now() - lastFetch < CATALOG_TTL && catalog.models.length) return catalog
  console.log(`[catalog] fetching from ${MODELS_URL}`)
  const res = await fetch(MODELS_URL)
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`)
  const data = await res.json()
  catalog = parseCatalog(data)
  lastFetch = Date.now()
  console.log(`[catalog] loaded ${catalog.models.length} free models from ${Object.keys(catalog.providers).length} providers`)
  return catalog
}

function parseCatalog(raw) {
  const providers = {}
  const models = []
  const ALLOWED_MODELS = [
    "laguna-s-2.1-free",
    "nemotron-3-ultra-free",
    "deepseek-v4-flash-free",
    "north-mini-code-free",
    "ling-3.0-flash-free",
    "big-pickle",
    "longcat-2.0-free",
    "ling-3.0-tiny-free",
    "mimo-v2.5-free",
  ]
  for (const [provId, prov] of Object.entries(raw)) {
    if (!prov.models) continue
    if (provId !== "opencode") continue
    const freeModels = Object.values(prov.models)
      .filter(m => m.cost && m.cost.input === 0)
      .filter(m => ALLOWED_MODELS.includes(m.id))
    if (!freeModels.length) continue
    providers[provId] = {
      id: provId,
      name: prov.name || provId,
      npm: prov.npm,
      api: prov.api || "",
      env: prov.env || [],
      models: freeModels.map(m => ({
        id: m.id,
        name: m.name || m.id,
        context: m.limit?.context || 128000,
        output: m.limit?.output || 4096,
        tool_call: m.tool_call || false,
        reasoning: m.reasoning || false,
      })),
    }
    for (const m of freeModels) {
      models.push({
        id: m.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: provId,
        provider: providers[provId],
        model: m,
        upstreamId: m.id,
      })
    }
  }
  return { providers, models }
}

function routeRequest(modelId) {
  const match = catalog.models.find(m => m.id === modelId)
  if (!match) return null
  // Skip models that returned 401 (genuinely unsupported)
  if (modelStatus.get(modelId) === "dead") return null
  return match
}

function checkAuth(req) {
  if (!API_KEY) return true
  const auth = req.headers.authorization || ""
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  return token === API_KEY
}

function upstreamHeaders(provider) {
  const h = { "content-type": "application/json" }
  if (provider.id === "opencode") {
    h["authorization"] = "Bearer public"
  }
  const envKeys = provider.env || []
  for (const k of envKeys) {
    const v = process.env[k]
    if (v) {
      h["authorization"] = `Bearer ${v}`
      break
    }
  }
  return h
}

function buildUpstreamUrl(provider) {
  let base = provider.api
  if (!base) return null
  base = base.replace(/\$\{[^}]+\}/g, (match) => {
    const varName = match.slice(2, -1)
    return process.env[varName] || ""
  })
  if (!base.endsWith("/")) base += "/"
  return base + "chat/completions"
}

async function handleModels(_req, res) {
  await fetchCatalog()
  const list = catalog.models
    .filter(m => modelStatus.get(m.id) !== "dead")
    .map(m => ({
      id: m.id,
      object: "model",
      created: m.created,
      owned_by: m.owned_by,
    }))
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify({ object: "list", data: list }))
}

async function handleChatCompletions(req, res) {
  if (!checkAuth(req)) return sendError(res, 401, "Invalid API key")

  let body = ""
  for await (const chunk of req) body += chunk
  let parsed
  try { parsed = JSON.parse(body) } catch { return sendError(res, 400, "Invalid JSON") }

  const modelId = parsed.model
  if (!modelId) return sendError(res, 400, "model is required")

  const match = routeRequest(modelId)
  if (!match) return sendError(res, 404, `Model '${modelId}' not found or not supported`)

  const url = buildUpstreamUrl(match.provider)
  if (!url) return sendError(res, 500, `No API URL configured for provider '${match.owned_by}'`)

  const headers = upstreamHeaders(match.provider)
  const upstreamBody = JSON.stringify({
    model: match.upstreamId,
    messages: parsed.messages,
    stream: parsed.stream || false,
    temperature: parsed.temperature,
    max_tokens: parsed.max_tokens,
    tools: parsed.tools,
    tool_choice: parsed.tool_choice,
  })

  const fetchOpts = { method: "POST", headers, body: upstreamBody }
  if (UPSTREAM_PROXY) {
    const { ProxyAgent } = await import("undici")
    fetchOpts.dispatcher = new ProxyAgent(UPSTREAM_PROXY)
  }

  try {
    const upstream = await fetch(url, fetchOpts)
    if (!upstream.ok) {
      const err = await upstream.text()
      console.error(`[upstream] ${match.owned_by}/${match.upstreamId} ${upstream.status}: ${err}`)
      // Mark permanently unsupported models so /v1/models hides them
      if (upstream.status === 401) modelStatus.set(match.id, "dead")
      res.writeHead(upstream.status, { "content-type": "application/json" })
      return res.end(JSON.stringify({ error: { message: err, type: "upstream_error", code: upstream.status } }))
    }

    if (parsed.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      const reader = upstream.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(decoder.decode(value, { stream: true }))
      }
      res.end()
    } else {
      const data = await upstream.json()
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(data))
    }
  } catch (err) {
    console.error(`[proxy] ${match.owned_by}/${match.upstreamId}: ${err.message}`)
    sendError(res, 502, `Upstream error: ${err.message}`)
  }
}

function sendError(res, code, message) {
  res.writeHead(code, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === "GET" && url.pathname === "/v1/models") return handleModels(req, res)
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") return handleChatCompletions(req, res)
  if (url.pathname === "/health") { res.writeHead(200); return res.end("ok") }

  sendError(res, 404, "Not found")
})

fetchCatalog().then(() => {
  server.listen(PORT, LISTEN, () => {
    console.log(`[router] listening on ${LISTEN}:${PORT}`)
    console.log(`[router] ${catalog.models.length} free models in catalog`)
    console.log(`[router] endpoints: GET /v1/models  POST /v1/chat/completions`)
    if (UPSTREAM_PROXY) console.log(`[router] proxy: ${UPSTREAM_PROXY}`)
  })
}).catch(err => {
  console.error("[fatal] failed to load catalog:", err)
  process.exit(1)
})

// Refresh catalog every 5 min, reset dead models so they can be retried
setInterval(() => {
  fetchCatalog().then(() => {
    for (const [id, status] of modelStatus) {
      if (status === "dead") modelStatus.delete(id)
    }
  }).catch(e => console.error("[refresh] failed:", e))
}, 5 * 60 * 1000)
