# ADO Finder — Remote MCP Server

An MCP server that searches Azure DevOps Feature work items over **HTTPS**, designed for
[Figma Make custom connectors](https://help.figma.com/hc/en-us/articles/MCP) and any
other remote-MCP client.

- **Transport**: MCP Streamable HTTP (`POST /mcp`)
- **Auth**: `x-api-key` request header
- **Search**: ADO Search API with automatic WIQL fallback + relevance scoring
- **Scope**: Features in `MSTeams\Design`, open states only

---

## File tree

```
.
├── src/
│   ├── index.ts        # Express HTTP server + MCP endpoint
│   └── ado.ts          # ADO Search API / WIQL fallback logic
├── .env.example
├── .gitignore
├── Dockerfile
├── .dockerignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Environment variables

| Variable    | Required | Description                                       |
|-------------|----------|---------------------------------------------------|
| `ADO_ORG`   | Yes      | Azure DevOps organisation name                    |
| `ADO_PROJECT` | Yes    | Azure DevOps project name                         |
| `ADO_PAT`   | Yes      | PAT with **Work Items → Read** scope              |
| `API_KEY`   | Yes      | Secret sent as `x-api-key` by the MCP client     |
| `PORT`      | No       | HTTP port (default `3000`)                        |

Copy `.env.example` → `.env` and fill in the values. **Never commit `.env`.**

```bash
cp .env.example .env
# then edit .env with real values
```

Generate a strong `API_KEY`:
```bash
openssl rand -hex 32
```

---

## Run locally (Node)

```bash
npm install
npm run build
npm start
# MCP endpoint: http://localhost:3000/mcp
# Health check: http://localhost:3000/healthz
```

---

## Run locally with Docker

### Build the image

```bash
docker build -t ado-finder-mcp .
```

### Run the container

```bash
docker run --rm -p 3000:3000 \
  -e ADO_ORG=<your-org> \
  -e ADO_PROJECT=<your-project> \
  -e ADO_PAT=<your-pat> \
  -e API_KEY=<your-api-key> \
  ado-finder-mcp
```

Or with an env file:
```bash
docker run --rm -p 3000:3000 --env-file .env ado-finder-mcp
```

Verify it's running:
```bash
curl http://localhost:3000/healthz   # → ok
```

---

## Deploy to Render (recommended — free HTTPS)

Render provides a free tier with automatic HTTPS and zero infrastructure to manage.

### Steps

1. **Push this repo to GitHub** (or GitLab / Bitbucket).

2. Go to [render.com](https://render.com) → **New → Web Service**.

3. Connect your repository and configure:

   | Setting         | Value                       |
   |-----------------|-----------------------------|
   | **Environment** | Docker                      |
   | **Region**      | Any                         |
   | **Instance type** | Free (or Starter)         |
   | **Health check path** | `/healthz`            |

4. Set **Environment Variables** in the Render dashboard:
   ```
   ADO_ORG      = <your-org>
   ADO_PROJECT  = <your-project>
   ADO_PAT      = <your-pat>
   API_KEY      = <your-api-key>
   PORT         = 3000
   ```

5. Click **Deploy**.

### Result

Your MCP server URL will be:
```
https://<service-name>.onrender.com/mcp
```

> **Note**: Free tier services spin down after 15 minutes of inactivity. The first
> request after a cold start may take ~30 s. Upgrade to a paid instance to avoid this.

---

## Deploy to Azure Container Apps

### Prerequisites

```bash
az login
az extension add --name containerapp
az provider register --namespace Microsoft.App --wait
```

### Deploy

```bash
# 1. Create a resource group (if needed)
az group create --name rg-ado-mcp --location eastus

# 2. Create a Container Apps environment
az containerapp env create \
  --name env-ado-mcp \
  --resource-group rg-ado-mcp \
  --location eastus

# 3. Deploy from source (builds the Dockerfile automatically)
az containerapp up \
  --name ado-finder-mcp \
  --resource-group rg-ado-mcp \
  --environment env-ado-mcp \
  --ingress external \
  --target-port 3000 \
  --source . \
  --env-vars \
    ADO_ORG=<your-org> \
    ADO_PROJECT=<your-project> \
    "ADO_PAT=secretref:ado-pat" \
    "API_KEY=secretref:api-key"
```

> Tip: Store secrets with `az containerapp secret set` first, then reference them via
> `secretref:` as shown above.

### Result

```bash
az containerapp show \
  --name ado-finder-mcp \
  --resource-group rg-ado-mcp \
  --query properties.configuration.ingress.fqdn -o tsv
# → ado-finder-mcp.gentlebeach-abc123.eastus.azurecontainerapps.io
```

Your MCP server URL:
```
https://<fqdn>/mcp
```

---

## Connect to Figma Make

Once deployed, open Figma Make → **Settings → Custom Connectors → Add MCP Server**:

| Field            | Value                                         |
|------------------|-----------------------------------------------|
| **MCP Server URL** | `https://<your-host>/mcp`                   |
| **Header name**  | `x-api-key`                                   |
| **Header value** | `<your-api-key>`                              |

The `search_ado_features` tool will appear in the Figma Make tool list automatically.

---

## MCP tool: search_ado_features

Searches Azure DevOps Features in `MSTeams\Design` for a keyword.

**Parameters**

| Name      | Type   | Required | Description                                    |
|-----------|--------|----------|------------------------------------------------|
| `keyword` | string | Yes      | Term to match in title, tags, or description   |
| `topK`    | number | No       | Max results to return (default: `10`)          |

**Returns** — JSON array:

```json
[
  {
    "id": 12345,
    "title": "Feature title",
    "state": "Active",
    "assignedTo": "Jane Doe",
    "url": "https://dev.azure.com/org/project/_workitems/edit/12345",
    "reason": "Found via Search API",
    "workItemType": "Feature",
    "areaPath": "MSTeams\\Design"
  }
]
```

**Search logic**

1. **Search API** (`almsearch.dev.azure.com`) — fast, index-based
2. **WIQL fallback** — used automatically on 403/404; scores results by title (×10) / tags (×5) / description (×1)

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `401 Unauthorized` | `x-api-key` header missing or wrong — check `API_KEY` env var |
| `500 Server misconfigured` | `API_KEY` env var not set on the server |
| No results | Verify PAT has Work Items → Read; confirm items exist in `MSTeams\Design` |
| Cold-start timeout (Render free) | Upgrade to a paid Render instance or use Azure Container Apps |

---

## License

MIT
