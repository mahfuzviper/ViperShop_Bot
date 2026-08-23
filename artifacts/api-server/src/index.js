import "dotenv/config";
import express from "express";
import { Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder } from "discord.js";
import Database from "better-sqlite3";
import OpenAI from "openai";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(root, "data");
mkdirSync(dataDir, { recursive: true });
const db = new Database(resolve(dataDir, "vipercyro.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT NOT NULL, guild_id TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 1, messages INTEGER NOT NULL DEFAULT 0,
    daily_messages INTEGER NOT NULL DEFAULT 0, weekly_messages INTEGER NOT NULL DEFAULT 0,
    monthly_messages INTEGER NOT NULL DEFAULT 0, last_xp_time INTEGER NOT NULL DEFAULT 0,
    period_day TEXT, period_week TEXT, period_month TEXT, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY (user_id, guild_id)
  );
  CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL DEFAULT '*',
    category TEXT NOT NULL, topic TEXT NOT NULL, question TEXT NOT NULL,
    answer TEXT NOT NULL, source TEXT, verified INTEGER NOT NULL DEFAULT 0,
    created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    guild_id TEXT PRIMARY KEY, ai_channel_id TEXT, staff_role_id TEXT, prefix TEXT DEFAULT '!',
    xp_enabled INTEGER DEFAULT 1, ai_enabled INTEGER DEFAULT 1
  );
`);

const log = (message, extra = {}) => console.log(`[ViperCryo] ${message}`, extra);
const embed = (title, description, color = 0x58a6ff) => new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setFooter({ text: "ViperCryo Assistant" }).setTimestamp();
const replyEmbed = (interaction, title, description, color) => interaction.reply({ embeds: [embed(title, description, color)] });
const now = () => new Date().toISOString();
const envNum = (key, fallback) => Number.isFinite(Number(process.env[key])) ? Number(process.env[key]) : fallback;
const xpCooldown = envNum("XP_COOLDOWN_SECONDS", 60) * 1000;
const levelForXp = (xp) => Math.max(1, Math.floor(Math.sqrt(xp / 100)) + 1);
const xpForNext = (level) => 100 * level * level;
const xpGain = () => Math.floor(Math.random() * (envNum("XP_MAX", 15) - envNum("XP_MIN", 5) + 1)) + envNum("XP_MIN", 5);
const key = (userId, guildId) => `${userId}:${guildId}`;
const cooldowns = new Map();
const aiCooldowns = new Map();
const aiGlobal = { until: 0 };

function seedKnowledge() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM knowledge").get().n;
  const files = ["vipercyro.json", "6b6t.json", "minecraft.json", "games.json"];
  const insert = db.prepare(`INSERT INTO knowledge
    (category, topic, question, answer, source, verified, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'seed', ?, ?)`);
  for (const file of count ? [] : files) {
    const full = resolve(root, "knowledge", file);
    const payload = JSON.parse(readFileSync(full, "utf8"));
    for (const item of payload.entries ?? []) insert.run(
      payload.category, item.topic, item.question, item.answer, item.source ?? null,
      item.verified ? 1 : 0, now(), now()
    );
  }
  const official = JSON.parse(readFileSync(resolve(root, "knowledge", "vipercyro-official.json"), "utf8"));
  const addOfficial = db.prepare(`INSERT INTO knowledge
    (guild_id, category, topic, question, answer, source, verified, created_by, created_at, updated_at)
    SELECT '*', ?, ?, ?, ?, ?, 1, 'ViperCryo Official Information', ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM knowledge WHERE category=? AND topic=? AND question=? AND source=?)`);
  for (const item of official.entries ?? []) {
    const timestamp = now();
    addOfficial.run(official.category, item.topic, item.question, item.answer, official.source, timestamp, timestamp, official.category, item.topic, item.question, official.source);
  }
}
seedKnowledge();

function getUser(userId, guildId) {
  const row = db.prepare("SELECT * FROM users WHERE user_id=? AND guild_id=?").get(userId, guildId);
  return row ?? { user_id: userId, guild_id: guildId, xp: 0, level: 1, messages: 0, daily_messages: 0, weekly_messages: 0, monthly_messages: 0, last_xp_time: 0 };
}
function trackActivity(userId, guildId) {
  const t = new Date(), day = t.toISOString().slice(0, 10);
  const week = `${t.getUTCFullYear()}-${Math.ceil((t.getUTCDate() + new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)).getUTCDay()) / 7)}`;
  const month = day.slice(0, 7), old = getUser(userId, guildId);
  const daily = old.period_day === day ? old.daily_messages : 0;
  const weekly = old.period_week === week ? old.weekly_messages : 0;
  const monthly = old.period_month === month ? old.monthly_messages : 0;
  const last = Date.now(), give = last - Number(old.last_xp_time || 0) >= xpCooldown;
  const xp = old.xp + (give ? xpGain() : 0), level = levelForXp(xp);
  db.prepare(`INSERT INTO users (user_id,guild_id,xp,level,messages,daily_messages,weekly_messages,monthly_messages,last_xp_time,period_day,period_week,period_month,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,guild_id) DO UPDATE SET xp=excluded.xp,level=excluded.level,messages=excluded.messages,daily_messages=excluded.daily_messages,weekly_messages=excluded.weekly_messages,monthly_messages=excluded.monthly_messages,last_xp_time=excluded.last_xp_time,period_day=excluded.period_day,period_week=excluded.period_week,period_month=excluded.period_month,updated_at=excluded.updated_at`)
    .run(userId, guildId, xp, level, old.messages + 1, daily + 1, weekly + 1, monthly + 1, give ? last : old.last_xp_time, day, week, month, now(), now());
  return { ...old, xp, level, messages: old.messages + 1, leveledUp: level > old.level };
}
function searchKnowledge(query, category) {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return [];
  const rows = db.prepare(`SELECT * FROM knowledge WHERE (guild_id='*' OR guild_id=?) ${category ? "AND lower(category)=lower(?)" : ""} ORDER BY verified DESC, updated_at DESC`).all(category ? [category] : []);
  return rows.map((r) => ({ ...r, score: terms.reduce((n, term) => n + (JSON.stringify(r).toLowerCase().includes(term) ? 1 : 0), 0) }))
    .filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
}
async function answerQuestion(question, category) {
  const context = searchKnowledge(question, category);
  const sourceText = context.map((r) => `[${r.category}/${r.topic}] ${r.question}: ${r.answer}${r.source ? ` (Source: ${r.source})` : ""}`).join("\n");
  if (!process.env.AI_API_KEY) {
    return context.length ? `🤖 **ViperCryo Assistant**\n\n${context[0].answer}\n\n📚 Based on: ${context[0].source || "verified ViperCryo knowledge"}` : "⚠️ I don't have verified information about that yet.\n\nYou can ask a ViperCryo staff member or provide the information using `/knowledge add`.";
  }
  try {
    const client = new OpenAI({ apiKey: process.env.AI_API_KEY, baseURL: process.env.AI_BASE_URL || undefined });
    const response = await client.chat.completions.create({ model: process.env.AI_MODEL || "gpt-4o-mini", temperature: 0.2, messages: [
      { role: "system", content: "You are the official ViperCryo Discord Assistant. Answer in the user's language (English, Bangla, or Banglish). Use verified context; never invent ViperCryo-specific facts. If context is insufficient, say you do not have verified information. Be concise and friendly." },
      { role: "user", content: `Question: ${question}\nVerified context:\n${sourceText || "(none)"}` }
    ]});
    return `🤖 **ViperCryo Assistant**\n\n${response.choices[0]?.message?.content || "I could not generate an answer."}${context[0]?.source ? `\n\n📚 Based on: ${context[0].source}` : ""}`;
  } catch (error) {
    log("AI failure", { message: error.message });
    return context.length ? `🤖 **ViperCryo Assistant**\n\n${context[0].answer}\n\n📚 Based on: ${context[0].source || "stored knowledge"}` : "⚠️ The AI service is temporarily unavailable and I don't have verified information about that yet.";
  }
}
const isStaff = (interaction) => interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) || (process.env.STAFF_ROLE_ID && interaction.member?.roles?.cache?.has(process.env.STAFF_ROLE_ID));
const commands = [
  { name: "ask", description: "Ask the ViperCryo assistant a question", options: [{ name: "question", description: "Your question", type: 3, required: true }] },
  { name: "6b6t", description: "Show verified 6b6t information" },
  { name: "minecraft", description: "Ask a Minecraft question", options: [{ name: "question", description: "Your question", type: 3, required: true }] },
  { name: "game", description: "Ask about a game", options: [{ name: "name", description: "Game name", type: 3, required: true }, { name: "question", description: "Your question", type: 3, required: true }] },
  { name: "rank", description: "Show your ViperCryo rank" },
  { name: "leaderboard", description: "Show the most active members" },
  { name: "stats", description: "Show your activity statistics" },
  { name: "help", description: "Show available commands" },
  { name: "knowledge", description: "Manage assistant knowledge", options: [
    { type: 1, name: "add", description: "Add one knowledge record", options: [{ type: 3, name: "data", description: "JSON knowledge record", required: true }] },
    { type: 1, name: "edit", description: "Edit a knowledge record", options: [{ type: 4, name: "id", description: "Entry ID", required: true }, { type: 3, name: "data", description: "JSON replacement fields", required: true }] },
    { type: 1, name: "delete", description: "Delete a knowledge record", options: [{ type: 4, name: "id", description: "Entry ID", required: true }] },
    { type: 1, name: "search", description: "Search stored knowledge", options: [{ type: 3, name: "query", description: "Search text", required: true }] },
    { type: 1, name: "list", description: "List categories and topics" },
    { type: 1, name: "import", description: "Import a JSON array", options: [{ type: 3, name: "data", description: "JSON array of records", required: true }] },
    { type: 1, name: "export", description: "Export stored knowledge" }
  ] }
];
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (process.env.ENABLE_MESSAGE_CONTENT === "true" || process.env.AI_CHANNEL_ID || process.env.AI_TRIGGER) intents.push(GatewayIntentBits.MessageContent);
const client = new Client({ intents });
client.once("clientReady", async () => {
  log(`Discord connected as ${client.user.tag}`);
  if (process.env.GUILD_ID) await client.application.commands.set(commands, process.env.GUILD_ID);
  else await client.application.commands.set(commands);
  log("Commands registered");
});
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  const activity = trackActivity(message.author.id, message.guild.id);
  if (activity.leveledUp) await message.channel.send(`Congratulations ${message.author}! You reached Level ${activity.level}. Keep being active in ViperCryo.`);
  const configured = process.env.AI_CHANNEL_ID && message.channel.id === process.env.AI_CHANNEL_ID;
  const mention = message.mentions.has(client.user);
  const prefix = process.env.AI_TRIGGER || "";
  if ((configured || mention || (prefix && message.content.startsWith(prefix))) && Date.now() >= aiGlobal.until && !aiCooldowns.has(key(message.author.id, message.guild.id))) {
    aiGlobal.until = Date.now() + envNum("AI_GLOBAL_COOLDOWN_SECONDS", 2) * 1000;
    aiCooldowns.set(key(message.author.id, message.guild.id), Date.now() + envNum("AI_USER_COOLDOWN_SECONDS", 10) * 1000);
    const question = message.content.replace(/<@!?\d+>/g, "").replace(prefix, "").trim();
    if (question) await message.reply(await answerQuestion(question));
  }
});
client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
    const name = i.commandName, guildId = i.guildId;
    if (["ask", "minecraft", "game"].includes(name)) {
      if (Date.now() < aiGlobal.until || (aiCooldowns.get(key(i.user.id, guildId)) || 0) > Date.now()) return i.reply({ content: "Please wait a moment before asking another AI question.", ephemeral: true });
      aiGlobal.until = Date.now() + envNum("AI_GLOBAL_COOLDOWN_SECONDS", 2) * 1000; aiCooldowns.set(key(i.user.id, guildId), Date.now() + envNum("AI_USER_COOLDOWN_SECONDS", 10) * 1000);
      await i.deferReply(); const q = name === "game" ? `${i.options.getString("name")}: ${i.options.getString("question")}` : i.options.getString("question");
      return i.editReply(await answerQuestion(q, name === "minecraft" ? "Minecraft" : undefined));
    }
    if (name === "6b6t") return i.reply({ embeds: [embed("6b6t Information", await answerQuestion("What is 6b6t and how do I join?", "6b6t"))] });
    if (name === "help") return replyEmbed(i, "ViperCryo Assistant", "`/ask` questions · `/6b6t` info · `/minecraft` Minecraft help · `/game` game help · `/rank` · `/leaderboard` · `/stats` · `/knowledge` staff tools");
    if (["rank", "stats"].includes(name)) { const u = getUser(i.user.id, guildId); return replyEmbed(i, `${i.user.username}'s Activity`, `Level: **${u.level}**\nXP: **${u.xp} / ${xpForNext(u.level)}**\nMessages: **${u.messages}**\nDaily: **${u.daily_messages}** · Weekly: **${u.weekly_messages}** · Monthly: **${u.monthly_messages}`); }
    if (name === "leaderboard") { const rows = db.prepare("SELECT * FROM users WHERE guild_id=? ORDER BY xp DESC LIMIT 10").all(guildId); return replyEmbed(i, "ViperCryo Leaderboard", rows.length ? rows.map((u, n) => `**${n + 1}.** <@${u.user_id}> — Level ${u.level}, ${u.xp} XP, ${u.messages} messages`).join("\n") : "No activity recorded yet."); }
    if (name === "knowledge") {
      if (!isStaff(i)) return i.reply({ content: "Only administrators or configured staff can manage knowledge.", ephemeral: true });
      const action = i.options.getSubcommand();
      const text = i.options.getString("data") || i.options.getString("query") || "";
      if (action === "search") return replyEmbed(i, "Knowledge Search", searchKnowledge(text).map((r) => `**${r.id}. ${r.topic}** — ${r.answer}`).join("\n") || "No matching knowledge found.");
      if (action === "list") return replyEmbed(i, "Knowledge Categories", [...new Set(db.prepare("SELECT category, topic FROM knowledge WHERE guild_id IN ('*', ?)").all(guildId).map((r) => `${r.category} / ${r.topic}`))].join("\n") || "Knowledge base is empty.");
      if (action === "add") { const item = JSON.parse(text); db.prepare("INSERT INTO knowledge (guild_id,category,topic,question,answer,source,verified,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(guildId, item.category, item.topic, item.question, item.answer, item.source || null, item.verified ? 1 : 0, i.user.id, now(), now()); return i.reply("Knowledge entry added."); }
      if (action === "edit") { const item = JSON.parse(text); const id = i.options.getInteger("id"); const result = db.prepare("UPDATE knowledge SET category=?, topic=?, question=?, answer=?, source=?, verified=?, updated_at=? WHERE id=? AND guild_id=?").run(item.category, item.topic, item.question, item.answer, item.source || null, item.verified ? 1 : 0, now(), id, guildId); return replyEmbed(i, result.changes ? "Knowledge Updated" : "Knowledge Not Found", result.changes ? `Entry **${id}** was updated.` : `No guild entry exists with ID **${id}**.`, result.changes ? 0x2ecc71 : 0xe74c3c); }
      if (action === "delete") { const id = i.options.getInteger("id"); const result = db.prepare("DELETE FROM knowledge WHERE id=? AND guild_id=?").run(id, guildId); return replyEmbed(i, result.changes ? "Knowledge Deleted" : "Knowledge Not Found", result.changes ? `Entry **${id}** was deleted.` : `No guild entry exists with ID **${id}**.`, result.changes ? 0x2ecc71 : 0xe74c3c); }
      if (action === "import") { const items = JSON.parse(text); const list = Array.isArray(items) ? items : [items]; const insert = db.prepare("INSERT INTO knowledge (guild_id,category,topic,question,answer,source,verified,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"); const addMany = db.transaction((entries) => { for (const item of entries) insert.run(guildId, item.category, item.topic, item.question, item.answer, item.source || null, item.verified ? 1 : 0, i.user.id, now(), now()); }); addMany(list); return i.reply(`Imported ${list.length} knowledge entr${list.length === 1 ? "y" : "ies"}.`); }
      if (action === "export") { const rows = db.prepare("SELECT category,topic,question,answer,source,verified FROM knowledge WHERE guild_id IN ('*', ?)").all(guildId); return i.reply({ content: "Knowledge export", files: [{ attachment: Buffer.from(JSON.stringify(rows, null, 2)), name: "vipercyro-knowledge.json" }] }); }
      return i.reply("Use `/knowledge add`, `/knowledge edit`, or `/knowledge import` with JSON, and `search`, `list`, `delete`, or `export` as needed.");
    }
  } catch (error) { log("Interaction failure", { message: error.message }); if (i.replied || i.deferred) await i.editReply("Something went wrong while handling that command."); else await i.reply({ content: "Something went wrong while handling that command.", ephemeral: true }); }
});
const app = express();
app.get("/", (_req, res) => res.send("ViperCryo Bot is online."));
app.get("/health", (_req, res) => res.json({ status: "online", discord: client.isReady() ? "connected" : "waiting", database: "connected", ai: Boolean(process.env.AI_API_KEY) }));
app.get("/api", (_req, res) => res.send("ViperCryo Bot is online."));
app.get("/api/health", (_req, res) => res.json({ status: "online", discord: client.isReady() ? "connected" : "waiting", database: "connected", ai: Boolean(process.env.AI_API_KEY) }));
app.get("/api/healthz", (_req, res) => res.json({ status: "online" }));
const port = Number(process.env.PORT || 8080);
app.listen(port, () => log(`Health server listening on ${port}`));
if (process.env.DISCORD_TOKEN) client.login(process.env.DISCORD_TOKEN).catch((error) => log("Discord login failed", { message: error.message }));
else log("DISCORD_TOKEN is not configured; health server will remain available.");
process.on("SIGTERM", () => { db.close(); client.destroy(); process.exit(0); });