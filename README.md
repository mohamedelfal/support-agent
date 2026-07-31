6<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue.svg" alt="Version" />
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License" />
  <img src="https://img.shields.io/badge/Cloudflare-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
</p>

# 🤖 Support Agent Platform

**AI-powered customer support automation — Zero-cost, serverless, and production-ready.**

---

## 📖 Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Demo](#demo)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Deployment Guide](#deployment-guide)
- [API Documentation](#api-documentation)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

---

## 📋 Overview

**Support Agent Platform** is a fully autonomous AI-powered customer support system that handles tickets, answers customer queries, and tracks resolution status — all without human intervention. Built on Cloudflare's serverless ecosystem, it costs **$0/month** within free tier limits.

> 🎯 **Ideal for:** Startups, SaaS companies, and enterprises looking to reduce support costs by 60-80%.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🤖 **AI-Powered Responses** | Uses Groq/OpenAI via Cloudflare AI Gateway |
| 🎫 **Ticket Management** | Create, view, resolve, and delete tickets |
| 📊 **Real-time Dashboard** | Track open tickets, resolved today, avg response time |
| 💬 **Conversational Interface** | Chat with the AI agent |
| 🔐 **Secure Authentication** | JWT-based authentication with 7-day expiry |
| 🛡️ **Rate Limiting** | Prevents abuse (50 requests/minute per user) |
| 📝 **Audit Logging** | Full activity tracking for compliance |
| 📱 **Mobile-First** | Fully responsive, works on any device |
| ⚡ **Serverless** | Auto-scales, no infrastructure management |
| 💰 **Zero Cost** | Runs entirely on Cloudflare Free Plan |

---

## 🏗️ Architecture

```

┌─────────────────────────────────────────────────────────────┐
│                    Browser (Any Device)                     │
└─────────────────────────────────────────────────────────────┘
│
▼
┌─────────────────────────────────────────────────────────────┐
│              Cloudflare Pages (Static Frontend)             │
│                 HTML + CSS + Vanilla JS                     │
└─────────────────────────────────────────────────────────────┘
│
▼
┌─────────────────────────────────────────────────────────────┐
│              Cloudflare Worker API (TypeScript)             │
│                   REST Endpoints + Middleware               │
└─────────────────────────────────────────────────────────────┘
│
┌───────────────┼───────────────┐
▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────────┐
│  Durable Object │ │  D1 Database    │ │  AI Gateway         │
│ • Rate Limiting │ │ • Users         │ │ • Groq / OpenAI     │
│ • Session State │ │ • Tickets       │ │ • Caching           │
└─────────────────┘ │ • Chat Logs     │ │ • Analytics        │
│ • Audit Logs    │ └─────────────────────┘
└─────────────────┘

```

---

## 🛠️ Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Frontend** | HTML5, CSS3, Vanilla JS | Lightweight, no build required |
| **API** | Cloudflare Workers (TypeScript) | Serverless backend |
| **Database** | Cloudflare D1 (SQLite) | Metadata, users, logs |
| **State** | Durable Objects | Rate limiting, session state |
| **AI** | Cloudflare AI Gateway (Groq/OpenAI) | LLM-powered responses |
| **Auth** | JWT (HS256) | Secure authentication |
| **CI/CD** | GitHub Actions | Automated deployment |

---

## 📊 Cost Breakdown

| Service | Free Tier Limit | Monthly Cost |
|---------|-----------------|--------------|
| Cloudflare Workers | 100,000 requests/day | **$0** |
| Cloudflare Pages | 500 builds/month | **$0** |
| D1 Database | Included in Workers Free | **$0** |
| Durable Objects | Included in Workers Free | **$0** |
| AI Gateway | Core features free | **$0** |
| GitHub | Public repositories | **$0** |
| **Total** | | **$0 / month** |

> ⚠️ Exceeding free tier limits may incur charges. Monitor usage via Cloudflare Dashboard.

---

## 📁 Project Structure

```

support-agent/
├── .github/                    # GitHub configurations
│   ├── ISSUE_TEMPLATE/         # Issue templates
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── workflows/
│       └── deploy.yml          # CI/CD pipeline
├── frontend/                   # Static frontend
│   ├── index.html
│   ├── style.css
│   └── app.js
├── worker/                     # Cloudflare Worker
│   ├── src/
│   │   ├── index.ts            # Entry point
│   │   ├── types.ts
│   │   ├── middleware/         # Auth, Rate limiting
│   │   ├── routes/             # API endpoints
│   │   ├── services/           # Business logic
│   │   └── durable/            # Durable Objects
│   ├── wrangler.jsonc          # Cloudflare config
│   ├── package.json
│   └── tsconfig.json
├── migrations/                 # Database schema
│   └── 001_init.sql
├── docs/                       # Documentation
│   ├── API.md
│   └── DEPLOYMENT.md
├── README.md                   # Main documentation
├── README.ar.md                # Arabic documentation
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── SECURITY.md
├── .env.example
├── .gitignore
└── LICENSE

```

---

## 🔧 Prerequisites

- [ ] GitHub account (free)
- [ ] Cloudflare account (free)
- [ ] Modern web browser (Chrome, Firefox, Safari)
- [ ] Basic knowledge of Git and web technologies

---

## 🚀 Quick Start

### 1. Fork & Clone

```bash
git clone https://github.com/mohamedelfal/support-agent.git
cd support-agent
```

2. Deploy to Cloudflare (Step-by-Step)

1. Create a D1 Database
   ```bash
   npx wrangler d1 create support-agent-db
   ```
   Copy the database_id.
2. Create an AI Gateway
   · Go to Cloudflare Dashboard → AI → AI Gateway
   · Create gateway named support-gateway
   · Copy the gateway_id
3. Update wrangler.jsonc
   ```jsonc
   {
     "d1_databases": [
       { "binding": "DB", "database_name": "support-agent-db", "database_id": "YOUR_D1_ID" }
     ],
     "ai_gateway": { "binding": "AI_GATEWAY", "gateway_id": "YOUR_GATEWAY_ID" }
   }
   ```
4. Deploy the Worker
   ```bash
   cd worker
   npm install
   npx wrangler deploy
   ```
5. Link GitHub to Cloudflare Pages
   · Cloudflare Dashboard → Pages → Connect to Git
   · Select your repository
   · Deploy (no build command needed)
6. Add Bindings in Pages
   · DB → D1: support-agent-db
   · AI_GATEWAY → AI Gateway: support-gateway
   · RATE_LIMITER → Durable Object: RateLimiter
7. Run Database Migration
   ```bash
   npx wrangler d1 execute support-agent-db --file=./migrations/001_init.sql
   ```
8. Add JWT Secret
   · Cloudflare Dashboard → Worker → Settings → Variables → Secrets
   · Add JWT_SECRET (32+ random characters)

---

📡 API Documentation

Authentication

Endpoint Method Description
/api/auth/login POST Login with email → returns JWT

Tickets

Endpoint Method Description
/api/tickets POST Create a new ticket
/api/tickets GET List user's tickets
/api/tickets/:id/resolve PUT Resolve a ticket
/api/tickets/:id DELETE Delete a ticket

Chat

Endpoint Method Description
/api/chat POST Send a message to the AI agent

Dashboard

Endpoint Method Description
/api/dashboard GET Get statistics

---

🔒 Security

Measure Implementation
Authentication JWT with 7-day expiry
Rate Limiting 50 requests/minute per user (Durable Objects)
Input Sanitization XSS and SQL injection prevention
Prompt Injection Sanitized before sending to LLM
Audit Logging All actions logged with IP hash
Data Isolation Row-level security via user_id checks
Secrets Management Cloudflare Secrets (not in code)
TLS Enforced via Cloudflare (TLS 1.3)

---

🤝 Contributing

We welcome contributions! Please see CONTRIBUTING.md for guidelines.

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Open a Pull Request

---

📄 License

This project is licensed under the MIT License — see the LICENSE file for details.

---

🙏 Acknowledgements

· Cloudflare for their generous free tier
· Hono for the lightweight web framework
· The open-source community for tools and inspiration

---

<p align="center">
  <b>Built with ❤️ for zero-cost AI innovation</b>
</p>
