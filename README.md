# routetheoc

OpenAI-compatible proxy router that serves free models from the [OpenCode](https://opencode.ai) catalog.

Point any OpenAI-compatible client at routetheoc and get access to 9 free models — no API key required from your side.

## Features

- **OpenAI-compatible API** — drop-in replacement for `/v1/models` and `/v1/chat/completions`
- **9 free models** — curated from the OpenCode catalog, auto-refreshed every 5 minutes
- **Dead model detection** — models returning 401 are automatically hidden
- **Streaming support** — full SSE streaming passthrough
- **Optional auth** — lock down the router with your own API key
- **Proxy support** — route upstream traffic through an HTTP proxy
- **Docker ready** — Dockerfile and docker-compose included

## Available Models

| Model | Description |
|-------|-------------|
| `laguna-s-2.1-free` | Laguna S 2.1 |
| `nemotron-3-ultra-free` | Nemotron 3 Ultra |
| `deepseek-v4-flash-free` | DeepSeek V4 Flash |
| `north-mini-code-free` | North Mini Code |
| `ling-3.0-flash-free` | Ling 3.0 Flash |
| `big-pickle` | Big Pickle |
| `longcat-2.0-free` | LongCat 2.0 |
| `ling-3.0-tiny-free` | Ling 3.0 Tiny |
| `mimo-v2.5-free` | Mimo V2.5 |

## Quick Start

```bash
git clone https://github.com/arun-raze19/routetheoc.git
cd routetheoc
cp .env.example .env
npm install
npm start
```

Server starts on `http://localhost:3000`.

## Docker

```bash
docker compose up -d
```

Or build manually:

```bash
docker build -t routetheoc .
docker run -p 3000:3000 --env-file .env routetheoc
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `LISTEN` | `0.0.0.0` | Bind address |
| `API_KEY` | *(empty)* | If set, clients must send `Authorization: Bearer <key>` |
| `MODELS_URL` | `https://models.opencode.ai/api.json` | Upstream catalog URL |
| `PROXY_ADDRESS` | *(empty)* | HTTP proxy host |
| `PROXY_PORT` | *(empty)* | HTTP proxy port |
| `PROXY_USERNAME` | *(empty)* | Proxy auth username |
| `PROXY_PASSWORD` | *(empty)* | Proxy auth password |

## API

### List models

```
GET /v1/models
```

### Chat completions

```
POST /v1/chat/completions
```

Standard OpenAI chat completion request body. Supports `stream: true`.

### Health check

```
GET /health
```

Returns `ok`.

## Usage with OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="anything",  # or your API_KEY if set
)

response = client.chat.completions.create(
    model="mimo-v2.5-free",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

## License

[Apache 2.0](LICENSE)
