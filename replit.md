# ViperCryo AI Discord Bot

An AI-powered Discord community assistant for ViperCryo with persistent SQLite knowledge and member activity tracking.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the Discord bot and health server
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required secret: `DISCORD_TOKEN`
- Optional env: `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL`, `GUILD_ID`, `AI_CHANNEL_ID`, `STAFF_ROLE_ID`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Bot: Node.js, discord.js v14
- HTTP health server: Express 5
- Persistence: SQLite via better-sqlite3
- AI: OpenAI-compatible API, optional with local fallback

## Where things live

- `artifacts/api-server/src/index.js` — bot runtime, commands, AI pipeline, activity tracking, and health server
- `artifacts/api-server/knowledge/` — seed knowledge files with safe placeholders
- `artifacts/api-server/data/` — persistent SQLite database, created on first start

## Architecture decisions

- Local verified knowledge is retrieved and prioritized before an optional AI call.
- The bot starts its health server even when optional AI credentials are absent.
- Discord-specific facts are placeholders until staff verifies them.
- Guild IDs are stored with user and knowledge records so multiple servers remain possible.

## Product

Members can ask gaming questions, view 6b6t information, earn XP, inspect rankings, and receive natural-language assistant replies. Staff can manage the knowledge base from Discord.

## User preferences

The bot should use the ViperCryo identity and avoid claiming unverified server-specific information.

## Gotchas

- Never commit `.env` or secrets. Use Replit Secrets.
- Use `GUILD_ID` while developing for fast command registration.
- Enable Discord Message Content Intent only when mention/channel natural-language handling is needed.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
