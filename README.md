<div align="center">

# Pushify Backend

The API server for [Pushify](https://github.com/pushify-dev/pushify) — an open-source cloud deployment platform.

![License](https://img.shields.io/badge/license-MIT-22d3ee?style=for-the-badge&labelColor=1a1a2e)
![Hono](https://img.shields.io/badge/Hono-E36002?style=for-the-badge&logo=hono&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![Drizzle](https://img.shields.io/badge/Drizzle_ORM-C5F74F?style=for-the-badge&logo=drizzle&logoColor=black)

</div>

## About

This is the backend API for Pushify. It handles authentication, server provisioning, deployments, database management, real-time monitoring, and more.

For the frontend dashboard, see [pushify-frontend](https://github.com/pushify-dev/pushify-frontend).

## Tech Stack

| | Technology |
|---|---|
| **Framework** | Hono |
| **Language** | TypeScript |
| **ORM** | Drizzle ORM |
| **Database** | PostgreSQL |
| **Queue** | BullMQ + Redis |
| **Real-time** | WebSocket |
| **AI** | Anthropic Claude |
| **Email** | Gmail SMTP |

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL 15+
- Redis (optional, for job queues)

### Setup

```bash
git clone https://github.com/pushify-dev/pushify-backend.git
cd pushify-backend
npm install
cp .env.example .env    # Edit with your database URL and secrets
npm run db:push
npm run dev
```

The API server starts at [http://localhost:4000](http://localhost:4000).

> [!NOTE]
> See [.env.example](.env.example) for all available environment variables.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | JWT signing key (min 32 chars) |
| `REDIS_URL` | No | Redis URL for job queues |
| `GITHUB_CLIENT_ID` | No | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | No | GitHub OAuth app secret |
| `GMAIL_USER` | No | SMTP email sender |
| `GMAIL_APP_PASSWORD` | No | Gmail app password |
| `ANTHROPIC_API_KEY` | No | Claude AI assistant |

See [.env.example](.env.example) for the full list with defaults.

## API Routes

| Route | Description |
|-------|-------------|
| `/api/v1/auth` | Authentication (register, login, 2FA) |
| `/api/v1/projects` | Project CRUD & settings |
| `/api/v1/deployments` | Deploy, rollback, logs |
| `/api/v1/servers` | Server provisioning & management |
| `/api/v1/databases` | Database creation & management |
| `/api/v1/domains` | Custom domain & SSL config |
| `/api/v1/envvars` | Environment variable management |
| `/api/v1/metrics` | CPU, memory, disk, network metrics |
| `/api/v1/healthchecks` | Endpoint health monitoring |
| `/api/v1/notifications` | Email, webhook, Slack alerts |
| `/api/v1/webhooks` | GitHub webhook receiver |
| `/api/v1/activity` | Audit logs |
| `/api/v1/organizations` | Team & role management |
| `/api/v1/billing` | Plans & usage |
| `/api/v1/ai` | AI assistant |
| `/ws` | WebSocket for real-time updates |

## Project Structure

```
src/
├── routes/          # API route handlers
├── services/        # Business logic
├── repositories/    # Data access layer (Drizzle)
├── db/              # Schema & migrations
├── middleware/       # Auth, rate limiting, CORS
├── workers/         # Background job processors (BullMQ)
├── providers/       # Cloud provider integrations
├── config/          # Environment & app config
└── index.ts         # Server entry point
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Type check & build for production |
| `npm run start` | Start production server |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run db:push` | Push schema changes to database |
| `npm run test` | Run tests |

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) before submitting a pull request.

## License

This project is licensed under the [MIT License](LICENSE).
