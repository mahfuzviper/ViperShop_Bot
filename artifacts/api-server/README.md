# ViperCryo AI Discord Bot

A persistent Discord community assistant built with Node.js, discord.js v14, SQLite, and an OpenAI-compatible AI API. It answers in English, Bangla, or Banglish when possible, uses verified local knowledge first, and never invents ViperCryo-specific facts.

## Setup

1. Create an application at the Discord Developer Portal and add a Bot user.
2. Copy the bot token into the Replit Secret named `DISCORD_TOKEN`. Never commit it or put it in a file.
3. Invite the bot using OAuth2 URL Generator with the `bot` and `applications.commands` scopes. Enable `Send Messages`, `Embed Links`, and `Read Message History`.
4. If natural-language replies are wanted, enable **Message Content Intent** in the Bot settings, then set `ENABLE_MESSAGE_CONTENT=true` plus `AI_CHANNEL_ID` or `AI_TRIGGER`.
5. Optional AI: set `AI_API_KEY`, `AI_MODEL`, and optionally `AI_BASE_URL`. The bot still runs and uses stored knowledge if this is missing.
6. Optional configuration can be added as Replit environment variables. See `.env.example`.
7. Start with `npm start` or the configured Replit workflow. The health endpoints are `/` and `/health`.

Set `GUILD_ID` during development to register slash commands immediately to one server. Remove it and restart to register globally (global command updates can take longer to appear).

## Commands

Members can use `/ask`, `/6b6t`, `/minecraft`, `/game`, `/rank`, `/leaderboard`, `/stats`, and `/help`.

Administrators, or the configured `STAFF_ROLE_ID`, can use `/knowledge search`, `/knowledge list`, `/knowledge add`, `/knowledge edit`, `/knowledge delete`, `/knowledge import`, and `/knowledge export`. For add, pass JSON in `text`, for example:

```json
{"category":"6b6t","topic":"joining","question":"How do I join?","answer":"Use the verified address listed by staff.","source":"Official server page","verified":true}
```

The initial seed files live in `knowledge/`. Replace placeholders such as `ADD_SERVER_ADDRESS_HERE` only with information you have verified.

## XP

Messages in guild channels increment activity counters. XP is awarded randomly between `XP_MIN` and `XP_MAX`, at most once per `XP_COOLDOWN_SECONDS`. SQLite is stored in `data/vipercyro.sqlite`. Levels use a quadratic curve so higher levels take longer to earn.

## Troubleshooting

- Check `/health` first; it reports Discord connection, database status, and whether AI credentials are configured.
- If commands do not appear quickly, set `GUILD_ID` and restart.
- If the bot does not reply to mentions, check Message Content Intent and the bot's channel permissions.
- AI failures fall back to the local knowledge base and are logged without exposing credentials or user content.