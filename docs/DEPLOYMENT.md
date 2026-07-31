# Advanced Deployment Guide

## Manual Deployment

### 1. Install Wrangler CLI

```bash
npm install -g wrangler
```

2. Login to Cloudflare

```bash
wrangler login
```

3. Create D1 Database

```bash
wrangler d1 create support-agent-db
```

4. Update wrangler.jsonc

Add the database_id from the previous step.

5. Deploy Worker

```bash
cd worker
npm install
wrangler deploy
```

6. Apply Database Migration

```bash
wrangler d1 execute support-agent-db --file=../migrations/001_init.sql
```

7. Add JWT Secret

```bash
wrangler secret put JWT_SECRET
```

8. Deploy Frontend

· Link your GitHub repository to Cloudflare Pages
· The frontend will be deployed automatically

---

Automated Deployment (GitHub Actions)

The repository includes a GitHub Actions workflow (.github/workflows/deploy.yml) that automatically deploys the Worker on every push to the main branch.

Required GitHub Secrets

Secret Description
CLOUDFLARE_API_TOKEN API token from Cloudflare
CLOUDFLARE_ACCOUNT_ID Your Cloudflare account ID

Getting Cloudflare API Token

1. Go to Cloudflare Dashboard → My Profile → API Tokens
2. Click Create Token
3. Select Edit Cloudflare Workers
4. Copy the token

---

Environment Variables

Variable Description Required
JWT_SECRET Secret key for JWT (32+ chars) ✅
AI_GATEWAY_ID Your AI Gateway ID ✅
ENVIRONMENT production or development ❌

---

Monitoring

· Cloudflare Dashboard: View usage, requests, and errors
· Worker Logs: Available in Cloudflare Dashboard → Workers → Logs
· D1 Console: Query and manage database

---

Troubleshooting

401 Unauthorized

· Check that the JWT token is valid and not expired
· Ensure the Authorization header is correctly formatted

429 Too Many Requests

· Wait for the rate limit window to reset (60 seconds)
· Reduce request frequency

500 Internal Server Error

· Check Worker logs in Cloudflare Dashboard
· Verify database connection and schema
