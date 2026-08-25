import "dotenv/config";
import express from "express";
import { ActionRowBuilder, ButtonBuilder, Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder } from "discord.js";
import Database from "better-sqlite3";
import OpenAI from "openai";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { get6b6tStatus, search6b6t, sync6b6t } from "./sixb6t-sync.js";
import { expireKitRequests, handleCheckoutModal, handleKitButton, handleKitModal, kitCommands, kitProfile, markKitChannelDeleted, migrateKitSystem, isStaff as isKitStaff, openCheckoutModal, openKitRequestModal, publishKitPanel } from "./kit-system.js";

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
    dynamic INTEGER NOT NULL DEFAULT 0, historical INTEGER NOT NULL DEFAULT 0,
    last_verified_at TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    guild_id TEXT PRIMARY KEY, ai_channel_id TEXT, staff_role_id TEXT, prefix TEXT DEFAULT '!',
    xp_enabled INTEGER DEFAULT 1, ai_enabled INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS "6b6t_sources" (
    source_key TEXT PRIMARY KEY, url TEXT NOT NULL, source_name TEXT NOT NULL,
    kind TEXT NOT NULL, last_fetched_at TEXT, status TEXT NOT NULL DEFAULT 'unknown', error TEXT
  );
  CREATE TABLE IF NOT EXISTS "6b6t_knowledge" (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_url TEXT NOT NULL, section_title TEXT NOT NULL,
    title TEXT NOT NULL, category TEXT NOT NULL, subcategory TEXT, content TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '[]', verified INTEGER NOT NULL DEFAULT 0, dynamic INTEGER NOT NULL DEFAULT 0,
    historical INTEGER NOT NULL DEFAULT 0, last_verified_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(source_url, section_title)
  );
  CREATE TABLE IF NOT EXISTS "6b6t_commands" (
    command TEXT PRIMARY KEY, aliases TEXT NOT NULL DEFAULT '[]', category TEXT, rank_requirement TEXT,
    description TEXT NOT NULL, syntax TEXT, example TEXT, restrictions TEXT, source_url TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS "6b6t_ranks" (rank TEXT PRIMARY KEY, price TEXT, currency TEXT, dynamic INTEGER NOT NULL DEFAULT 1, source_url TEXT, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS "6b6t_rank_features" (rank TEXT NOT NULL, feature TEXT NOT NULL, value TEXT, source_url TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(rank, feature));
  CREATE TABLE IF NOT EXISTS "6b6t_events" (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, start_at TEXT, end_at TEXT, status TEXT, description TEXT, source_url TEXT, historical INTEGER DEFAULT 0, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS "6b6t_updates" (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, published_at TEXT, summary TEXT, source_url TEXT UNIQUE, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS "6b6t_history" (id INTEGER PRIMARY KEY AUTOINCREMENT, event_date TEXT, title TEXT, description TEXT, source_url TEXT, historical INTEGER DEFAULT 1, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS "6b6t_stats_cache" (stat_key TEXT PRIMARY KEY, value TEXT, source_url TEXT, fetched_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS "6b6t_dynamic" (data_key TEXT PRIMARY KEY, value TEXT NOT NULL, source_url TEXT NOT NULL, fetched_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS "6b6t_faq" (question TEXT PRIMARY KEY, answer TEXT NOT NULL, source_url TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS "6b6t_socials" (name TEXT PRIMARY KEY, url TEXT NOT NULL, source_url TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS "6b6t_versions" (version TEXT PRIMARY KEY, release_date TEXT, announcement TEXT, source_url TEXT NOT NULL, historical INTEGER DEFAULT 0, updated_at TEXT NOT NULL);
`);
migrateKitSystem(db);
for (const statement of [
  "ALTER TABLE knowledge ADD COLUMN dynamic INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE knowledge ADD COLUMN historical INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE knowledge ADD COLUMN last_verified_at TEXT"
]) {
  try { db.exec(statement); } catch (error) { if (!error.message.includes("duplicate column name")) throw error; }
}

const log = (message, extra = {}) => console.log(`[ViperCryo] ${message}`, extra);
const embed = (title, description, color = 0x58a6ff) => new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setFooter({ text: "ViperCryo Assistant" }).setTimestamp();
const replyEmbed = (interaction, title, description, color) => interaction.reply({ embeds: [embed(title, description, color)] });
const limitDiscordText = (text) => text.length > 1900 ? `${text.slice(0, 1897)}...` : text;
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
  const files = ["vipercyro.json", "6b6t.json", "minecraft.json", "games.json"];
  const insert = db.prepare(`INSERT INTO knowledge
    (category, topic, question, answer, source, verified, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'seed', ?, ?)`);
  if (db.prepare("SELECT COUNT(*) AS n FROM knowledge").get().n === 0) for (const file of files) {
    const full = resolve(root, "knowledge", file);
    const payload = JSON.parse(readFileSync(full, "utf8"));
    for (const item of payload.entries ?? []) insert.run(
      payload.category, item.topic, item.question, item.answer, item.source ?? null,
      item.verified ? 1 : 0, now(), now()
    );
  }
  const official = JSON.parse(readFileSync(resolve(root, "knowledge", "vipercyro-official.json"), "utf8"));
  const addOfficial = db.prepare(`INSERT INTO knowledge
    (guild_id, category, topic, question, answer, source, verified, dynamic, historical, last_verified_at, created_by, created_at, updated_at)
    SELECT '*', ?, ?, ?, ?, ?, 1, ?, ?, ?, 'ViperCryo Official Information', ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM knowledge WHERE category=? AND topic=? AND question=? AND source=?)`);
  for (const item of official.entries ?? []) {
    const timestamp = now();
    addOfficial.run(official.category, item.topic, item.question, item.answer, official.source, item.dynamic ? 1 : 0, item.historical ? 1 : 0, item.last_verified_at ?? null, timestamp, timestamp, official.category, item.topic, item.question, official.source);
  }
  const sixb6t = JSON.parse(readFileSync(resolve(root, "knowledge", "6b6t.json"), "utf8"));
  const addSixb6t = db.prepare(`INSERT INTO knowledge
    (guild_id, category, topic, question, answer, source, verified, dynamic, historical, last_verified_at, created_by, created_at, updated_at)
    SELECT '*', ?, ?, ?, ?, ?, ?, ?, ?, ?, '6b6t Official Seed', ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM knowledge WHERE category=? AND topic=? AND question=? AND source=?)`);
  for (const item of sixb6t.entries ?? []) {
    const timestamp = now();
    addSixb6t.run(sixb6t.category, item.topic, item.question, item.answer, item.source ?? "Official 6b6t Website", item.verified ? 1 : 0, item.dynamic ? 1 : 0, item.historical ? 1 : 0, item.last_verified_at ?? null, timestamp, timestamp, sixb6t.category, item.topic, item.question, item.source ?? "Official 6b6t Website");
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
function searchKnowledge(query, category, guildId = "*") {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return [];
  const params = category ? [guildId, category] : [guildId];
  const rows = db.prepare(`SELECT * FROM knowledge WHERE (guild_id='*' OR guild_id=?) ${category ? "AND lower(category)=lower(?)" : ""} ORDER BY verified DESC, updated_at DESC`).all(...params);
  return rows.map((r) => ({ ...r, score: terms.reduce((n, term) => n + (JSON.stringify(r).toLowerCase().includes(term) ? 1 : 0), 0) }))
    .filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
}
async function answerQuestion(question, category, guildId = "*") {
  const context = searchKnowledge(question, category, guildId);
  const officialContext = /6b6t|anarchymod|play\.6b6t|hotspot|buildermode|dupe event/i.test(question) ? search6b6t(db, question) : [];
  const sourceText = [...officialContext.map((r) => `[Official 6b6t/${r.title}] ${r.content} (Source: ${r.source_url})`), ...context.map((r) => `[${r.category}/${r.topic}] ${r.question}: ${r.answer}${r.source ? ` (Source: ${r.source})` : ""}`)].join("\n");
  if (!process.env.AI_API_KEY) {
    if (officialContext.length) return `🤖 **ViperCryo Assistant**\n\n${officialContext[0].content}\n\n📚 Source: Official 6b6t\n${officialContext[0].source_url}`;
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
  kitCommands(),
  { name: "ask", description: "Ask the ViperCryo assistant a question", options: [{ name: "question", description: "Your question", type: 3, required: true }] },
  { name: "6b6t", description: "Search official 6b6t information", options: [
    { type: 3, name: "question", description: "What do you want to know?", required: false }
  ] },
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
    { type: 1, name: "export", description: "Export stored knowledge" },
    { type: 1, name: "sync6b6t", description: "Fetch and update official 6b6t knowledge" },
    { type: 1, name: "refresh6b6t", description: "Refresh official 6b6t dynamic pages" },
    { type: 1, name: "6b6tstatus", description: "Show 6b6t sync health and record counts" }
  ] }
];
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates];
if (process.env.ENABLE_MESSAGE_CONTENT === "true" || process.env.AI_CHANNEL_ID || process.env.AI_TRIGGER) intents.push(GatewayIntentBits.MessageContent);
const client = new Client({ intents });
client.once("clientReady", async () => {
  log(`Discord connected as ${client.user.tag}`);
  if (process.env.GUILD_ID) await client.application.commands.set(commands, process.env.GUILD_ID);
  else await client.application.commands.set(commands);
  log("Commands registered");
});
client.on("error", (error) => log("Discord client error", { message: error.message, code: error.code }));
client.on("channelDelete", async (channel) => {
  const request = markKitChannelDeleted(db, channel.id);
  if (!request) return;
  await client.users.fetch(request.discord_user_id).then((user) => user.send(`⚠️ Your ViperCryo ticket #${request.id} was deleted. You can create another ticket after 24 hours.`)).catch(() => {});
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
    if (question) await message.reply(limitDiscordText(await answerQuestion(question, undefined, message.guild.id)));
  }
});
client.on("interactionCreate", async (i) => {
  if (i.isModalSubmit()) {
    if (i.customId === "kit-request-modal" || i.customId.startsWith("kit-order-modal:")) try { await handleKitModal(i, db); } catch (error) { log("Kit modal failure", { message: error.message }); if (!i.replied) await i.reply({ content: "The kit request could not be created. Please try again later.", ephemeral: true }).catch((replyError) => log("Kit modal response expired", { message: replyError.message })); }
    if (i.customId === "kit-checkout-modal") try { await handleCheckoutModal(i, db); } catch (error) { log("Kit checkout failure", { message: error.message }); if (!i.replied) await i.reply({ content: "The basket order could not be created. Please try again later.", ephemeral: true }).catch((replyError) => log("Kit checkout response expired", { message: replyError.message })); }
    return;
  }
  if (i.isButton()) {
    if (i.customId.startsWith("kit:")) try { await handleKitButton(i, db); } catch (error) { log("Kit button failure", { message: error.message }); if (!i.replied) await i.reply({ content: "The kit action could not be completed.", ephemeral: true }).catch((replyError) => log("Kit button response expired", { message: replyError.message })); }
    return;
  }
  if (!i.isChatInputCommand()) return;
  try {
    const name = i.commandName, guildId = i.guildId;
    if (name === "kit") {
      const action = i.options.getSubcommand();
      if (action === "request") return openKitRequestModal(i, db);
      if (action === "basket") { const rows = db.prepare("SELECT c.quantity,k.kit_name FROM kit_cart c JOIN kits k ON k.kit_id=c.kit_id WHERE c.discord_user_id=? AND c.guild_id=? AND k.availability=1").all(i.user.id, guildId); if (!rows.length) return i.reply({ content: "Your kit basket is empty.", ephemeral: true }); const total = rows.reduce((sum, row) => sum + row.quantity, 0); const checkout = new ButtonBuilder().setCustomId("kit:checkout").setLabel("Checkout Basket").setEmoji("🛒").setStyle(3); return i.reply({ content: `🛒 **Your basket (${total}/3 kits)**\n${rows.map((row) => `• ${row.kit_name} ×${row.quantity}`).join("\n")}`, components: [new ActionRowBuilder().addComponents(checkout)], ephemeral: true }); }
      if (action === "profile") return replyEmbed(i, "ViperCryo Reward Profile", kitProfile(i, db));
      if (action === "history") { const rows = db.prepare("SELECT kit_name,status,delivered_at,staff_id FROM kit_claims WHERE discord_user_id=? ORDER BY requested_at DESC LIMIT 10").all(i.user.id); return replyEmbed(i, "ViperCryo Kit History", rows.length ? rows.map((row) => `**${row.kit_name}** — ${row.status}${row.delivered_at ? ` (${row.delivered_at.slice(0, 10)})` : ""}`).join("\n") : "No kit history yet."); }
      if (action === "stats") { if (!isKitStaff(i)) return i.reply({ content: "Only kit staff or administrators can view kit statistics.", ephemeral: true }); const kits = db.prepare("SELECT COUNT(*) n FROM kits").get().n; const pending = db.prepare("SELECT COUNT(*) n FROM kit_requests WHERE status='PENDING'").get().n; return replyEmbed(i, "ViperCryo Kit Statistics", `Kits: **${kits}**\nPending requests: **${pending}**\nDelivered claims: **${db.prepare("SELECT COUNT(*) n FROM kit_claims WHERE status='DELIVERED'").get().n}`); }
      if (action === "config") { if (!isKitStaff(i)) return i.reply({ content: "Only kit staff or administrators can view kit configuration.", ephemeral: true }); return replyEmbed(i, "ViperCryo Kit Configuration", `Kit system: **Enabled**\nTicket system: **Enabled**\nMinecraft integration: **${process.env.MINECRAFT_INTEGRATION_ENABLED === "true" || process.env.RCON_ENABLED === "true" ? "Configured" : "Not configured"}**\nStaff role: **${process.env.KIT_STAFF_ROLE_ID ? "Configured" : "Not configured"}**\nTiers: **${db.prepare("SELECT COUNT(*) n FROM kit_tiers WHERE active=1").get().n}**\nKits: **${db.prepare("SELECT COUNT(*) n FROM kits").get().n}**`); }
      if (action === "publish") { if (!isKitStaff(i)) return i.reply({ content: "Only kit staff or administrators can publish kits.", ephemeral: true }); const channel = i.options.getChannel("channel"); if (!channel?.isTextBased()) return i.reply({ content: "Choose a text channel.", ephemeral: true }); return publishKitPanel(i, db, channel, i.options.getString("kit_id")); }
      if (action === "setchannel") { if (!isKitStaff(i)) return i.reply({ content: "Only kit staff or administrators can configure kits.", ephemeral: true }); const channel = i.options.getChannel("channel"); db.prepare("INSERT INTO kit_settings (guild_id,setting_key,setting_value,updated_at) VALUES (?,?,?,?) ON CONFLICT(guild_id,setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=excluded.updated_at").run(guildId, "showcase_channel_id", channel.id, now()); return i.reply(`Kit showcase channel set to ${channel}.`); }
      if (action === "setcategory") { if (!isKitStaff(i)) return i.reply({ content: "Only kit staff or administrators can configure kits.", ephemeral: true }); const categoryId = i.options.getString("category_id"); db.prepare("INSERT INTO kit_settings (guild_id,setting_key,setting_value,updated_at) VALUES (?,?,?,?) ON CONFLICT(guild_id,setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=excluded.updated_at").run(guildId, "ticket_category_id", categoryId, now()); return i.reply(`Kit ticket category saved: **${categoryId}**.`); }
      if (!isKitStaff(i)) return i.reply({ content: "Only configured kit staff or administrators can manage kits.", ephemeral: true });
      if (action === "add") { const name = i.options.getString("name").trim(); const kitId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); const existing = db.prepare("SELECT id,kit_name FROM kits WHERE kit_id=?").get(kitId); if (existing) return i.reply({ content: `A kit with this name already exists (ID **${existing.id}**). Use **/kit edit** to update it, or choose a different name.`, ephemeral: true }); const itemText = i.options.getString("items") || ""; const items = itemText ? itemText.split(",").map((entry) => { const match = entry.trim().match(/^(.+?)(?:\s*[x×]\s*(\d+))?$/i); return { name: match?.[1]?.trim() || entry.trim(), quantity: Number(match?.[2] || 1) }; }) : []; const time = now(); const result = db.prepare("INSERT INTO kits (kit_id,kit_name,kit_tier,description,image_url,items,required_discord_rank,required_activity,required_online_minutes,required_invites,required_boosts,required_xp,cooldown_seconds,availability,staff_approval,server,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(kitId, name, i.options.getString("tier") || null, i.options.getString("description") || "", i.options.getAttachment("image")?.url || null, JSON.stringify(items), null, 0, 0, 0, 0, 0, 0, i.options.getBoolean("availability") ? 1 : 0, 1, "6b6t", null, time, time); return i.reply(`Kit **${name}** added with ID **${result.lastInsertRowid}**${i.options.getAttachment("image") ? " and image attached" : ""}.`); }
      if (action === "edit") { const item = JSON.parse(i.options.getString("data")); const id = i.options.getInteger("id"); const fields = Object.entries(item).filter(([key]) => ["kit_name", "kit_tier", "description", "image_url", "required_activity", "required_online_minutes", "required_invites", "required_boosts", "required_xp", "cooldown_seconds", "availability", "server", "notes"].includes(key)); if (!fields.length) return i.reply({ content: "No editable kit fields supplied.", ephemeral: true }); const set = fields.map(([key]) => `${key}=?`).join(", "); const values = fields.map(([key, value]) => key === "availability" ? (value ? 1 : 0) : value); const result = db.prepare(`UPDATE kits SET ${set}, updated_at=? WHERE id=?`).run(...values, now(), id); return i.reply(result.changes ? `Kit **${id}** updated.` : "Kit not found."); }
      if (action === "delete") { const result = db.prepare("UPDATE kits SET availability=0,updated_at=? WHERE id=?").run(now(), i.options.getInteger("id")); return i.reply(result.changes ? "Kit disabled." : "Kit not found."); }
      if (action === "setimage") { const image = i.options.getAttachment("image"); const result = db.prepare("UPDATE kits SET image_url=?,updated_at=? WHERE id=?").run(image.url, now(), i.options.getInteger("id")); return i.reply(result.changes ? "Kit image updated. Publish the panel again to show the new image." : "Kit not found."); }
      if (action === "cooldown") { const result = db.prepare("UPDATE kits SET cooldown_seconds=?,updated_at=? WHERE id=?").run(i.options.getInteger("seconds"), now(), i.options.getInteger("id")); return i.reply(result.changes ? "Kit cooldown updated." : "Kit not found."); }
      if (action === "setrole") { const tier = i.options.getString("tier"); const role = i.options.getString("role_id"); const result = db.prepare("UPDATE kit_tiers SET role_id=?,updated_at=? WHERE lower(name)=lower(?)").run(role, now(), tier); return i.reply(result.changes ? `Role configured for **${tier}**.` : "Tier not found. Use Viper X, Viper Y, or Viper Z."); }
      if (["approve", "reject", "tpa", "deliver", "delete_ticket"].includes(action)) { const requestId = i.options.getInteger("request_id"); const buttonAction = action === "delete_ticket" ? "delete" : action; const fake = Object.create(i); fake.customId = `kit:${buttonAction}:${requestId}`; fake.isButton = () => true; return handleKitButton(fake, db); }
    }
    if (["ask", "minecraft", "game"].includes(name)) {
      if (Date.now() < aiGlobal.until || (aiCooldowns.get(key(i.user.id, guildId)) || 0) > Date.now()) return i.reply({ content: "Please wait a moment before asking another AI question.", ephemeral: true });
      aiGlobal.until = Date.now() + envNum("AI_GLOBAL_COOLDOWN_SECONDS", 2) * 1000; aiCooldowns.set(key(i.user.id, guildId), Date.now() + envNum("AI_USER_COOLDOWN_SECONDS", 10) * 1000);
      await i.deferReply(); const q = name === "game" ? `${i.options.getString("name")}: ${i.options.getString("question")}` : i.options.getString("question");
      return i.editReply(limitDiscordText(await answerQuestion(q, name === "minecraft" ? "Minecraft" : undefined, guildId)));
    }
    if (name === "6b6t") {
      const question = i.options.getString("question") || "What is 6b6t and how do I join?";
      const official = search6b6t(db, question);
      if (official.length) return i.reply({ embeds: [embed("Official 6b6t", limitDiscordText(`${official[0].content}\n\nSource: Official 6b6t\n${official[0].source_url}`))] });
      return i.reply({ embeds: [embed("6b6t Information", await answerQuestion(question, "6b6t", guildId))] });
    }
    if (name === "help") return replyEmbed(i, "ViperCryo Assistant", "`/ask` questions · `/6b6t` info · `/minecraft` Minecraft help · `/game` game help · `/rank` · `/leaderboard` · `/stats` · `/knowledge` staff tools");
    if (["rank", "stats"].includes(name)) { const u = getUser(i.user.id, guildId); return replyEmbed(i, `${i.user.username}'s Activity`, `Level: **${u.level}**\nXP: **${u.xp} / ${xpForNext(u.level)}**\nMessages: **${u.messages}**\nDaily: **${u.daily_messages}** · Weekly: **${u.weekly_messages}** · Monthly: **${u.monthly_messages}`); }
    if (name === "leaderboard") { const rows = db.prepare("SELECT * FROM users WHERE guild_id=? ORDER BY xp DESC LIMIT 10").all(guildId); return replyEmbed(i, "ViperCryo Leaderboard", rows.length ? rows.map((u, n) => `**${n + 1}.** <@${u.user_id}> — Level ${u.level}, ${u.xp} XP, ${u.messages} messages`).join("\n") : "No activity recorded yet."); }
    if (name === "knowledge") {
      if (!isStaff(i)) return i.reply({ content: "Only administrators or configured staff can manage knowledge.", ephemeral: true });
      const action = i.options.getSubcommand();
      const text = i.options.getString("data") || i.options.getString("query") || "";
      if (["sync6b6t", "refresh6b6t"].includes(action)) {
        await i.deferReply({ ephemeral: true });
        const result = await sync6b6t(db, { force: true });
        return i.editReply(`6b6t sync finished: ${result.fetched} pages fetched, ${result.knowledge} records updated, ${result.commands} commands found, ${result.failed.length} failed.`);
      }
      if (action === "6b6tstatus") {
        const status = get6b6tStatus(db);
        return replyEmbed(i, "6b6t Sync Status", `Last sync: **${status.lastSync || "never"}**\nOfficial sources: **${status.sources}**\nFailed sources: **${status.failedSources}**\nKnowledge records: **${status.knowledge}**\nCommands: **${status.commands}**\nDynamic: **${status.dynamic}** · Historical: **${status.historical}**`);
      }
      if (action === "search") return replyEmbed(i, "Knowledge Search", searchKnowledge(text, undefined, guildId).map((r) => `**${r.id}. ${r.topic}** — ${r.answer}`).join("\n") || "No matching knowledge found.");
      if (action === "list") return replyEmbed(i, "Knowledge Categories", [...new Set(db.prepare("SELECT category, topic FROM knowledge WHERE guild_id IN ('*', ?)").all(guildId).map((r) => `${r.category} / ${r.topic}`))].join("\n") || "Knowledge base is empty.");
      if (action === "add") { const item = JSON.parse(text); db.prepare("INSERT INTO knowledge (guild_id,category,topic,question,answer,source,verified,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(guildId, item.category, item.topic, item.question, item.answer, item.source || null, item.verified ? 1 : 0, i.user.id, now(), now()); return i.reply("Knowledge entry added."); }
      if (action === "edit") { const item = JSON.parse(text); const id = i.options.getInteger("id"); const result = db.prepare("UPDATE knowledge SET category=?, topic=?, question=?, answer=?, source=?, verified=?, updated_at=? WHERE id=? AND guild_id=?").run(item.category, item.topic, item.question, item.answer, item.source || null, item.verified ? 1 : 0, now(), id, guildId); return replyEmbed(i, result.changes ? "Knowledge Updated" : "Knowledge Not Found", result.changes ? `Entry **${id}** was updated.` : `No guild entry exists with ID **${id}**.`, result.changes ? 0x2ecc71 : 0xe74c3c); }
      if (action === "delete") { const id = i.options.getInteger("id"); const result = db.prepare("DELETE FROM knowledge WHERE id=? AND guild_id=?").run(id, guildId); return replyEmbed(i, result.changes ? "Knowledge Deleted" : "Knowledge Not Found", result.changes ? `Entry **${id}** was deleted.` : `No guild entry exists with ID **${id}**.`, result.changes ? 0x2ecc71 : 0xe74c3c); }
      if (action === "import") { const items = JSON.parse(text); const list = Array.isArray(items) ? items : [items]; const insert = db.prepare("INSERT INTO knowledge (guild_id,category,topic,question,answer,source,verified,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"); const addMany = db.transaction((entries) => { for (const item of entries) insert.run(guildId, item.category, item.topic, item.question, item.answer, item.source || null, item.verified ? 1 : 0, i.user.id, now(), now()); }); addMany(list); return i.reply(`Imported ${list.length} knowledge entr${list.length === 1 ? "y" : "ies"}.`); }
      if (action === "export") { const rows = db.prepare("SELECT category,topic,question,answer,source,verified FROM knowledge WHERE guild_id IN ('*', ?)").all(guildId); return i.reply({ content: "Knowledge export", files: [{ attachment: Buffer.from(JSON.stringify(rows, null, 2)), name: "vipercyro-knowledge.json" }] }); }
      return i.reply("Use `/knowledge add`, `/knowledge edit`, or `/knowledge import` with JSON, and `search`, `list`, `delete`, or `export` as needed.");
    }
  } catch (error) { log("Interaction failure", { message: error.message }); if (i.replied || i.deferred) await i.editReply("Something went wrong while handling that command.").catch((replyError) => log("Interaction response expired", { message: replyError.message })); else await i.reply({ content: "Something went wrong while handling that command.", ephemeral: true }).catch((replyError) => log("Interaction response expired", { message: replyError.message })); }
});
const app = express();
app.get("/", (_req, res) => res.send("ViperCryo Bot is online."));
app.get("/health", (_req, res) => res.json({ status: "online", discord: client.isReady() ? "connected" : "waiting", database: "connected", ai: Boolean(process.env.AI_API_KEY) }));
app.get("/api", (_req, res) => res.send("ViperCryo Bot is online."));
app.get("/api/health", (_req, res) => res.json({ status: "online", discord: client.isReady() ? "connected" : "waiting", database: "connected", ai: Boolean(process.env.AI_API_KEY) }));
app.get("/api/healthz", (_req, res) => res.json({ status: "online" }));
const port = Number(process.env.PORT || 8080);
app.listen(port, () => log(`Health server listening on ${port}`));
expireKitRequests(db, client).catch((error) => log("Ticket expiry failed", { message: error.message }));
setInterval(() => expireKitRequests(db, client).catch((error) => log("Ticket expiry failed", { message: error.message })), 60 * 60 * 1000);
if (process.env.SIXB6T_AUTO_SYNC !== "false") {
  sync6b6t(db).then((result) => log("6b6t sync complete", result)).catch((error) => log("6b6t sync failed", { message: error.message }));
  setInterval(() => sync6b6t(db).then((result) => log("6b6t scheduled sync complete", result)).catch((error) => log("6b6t scheduled sync failed", { message: error.message })), 3 * 60 * 60 * 1000);
}
if (process.env.DISCORD_TOKEN) client.login(process.env.DISCORD_TOKEN).catch((error) => log("Discord login failed", { message: error.message }));
else log("DISCORD_TOKEN is not configured; health server will remain available.");
process.on("SIGTERM", () => { db.close(); client.destroy(); process.exit(0); });