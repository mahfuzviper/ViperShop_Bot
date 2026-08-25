import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";

const KIT_ROLE_KEYS = { "Viper X": "VIPER_X_ROLE_ID", "Viper Y": "VIPER_Y_ROLE_ID", "Viper Z": "VIPER_Z_ROLE_ID" };
const timestamp = () => new Date().toISOString();
const roleIdForTier = (tier) => process.env[KIT_ROLE_KEYS[tier] || ""] || null;
const staffRoleId = () => process.env.KIT_STAFF_ROLE_ID || process.env.STAFF_ROLE_ID || null;
const isStaff = (interaction) => interaction.memberPermissions?.has("Administrator") || (staffRoleId() && interaction.member?.roles?.cache?.has(staffRoleId()));
const discordSafe = (value) => String(value || "").replace(/[<>`]/g, "").slice(0, 900);
const categoryIdFor = (interaction, db) => {
  const configured = process.env.KIT_TICKET_CATEGORY_ID || db.prepare("SELECT setting_value FROM kit_settings WHERE guild_id=? AND setting_key='ticket_category_id'").get(interaction.guildId)?.setting_value;
  if (!configured) return null;
  if (/^\d{17,20}$/.test(configured)) return configured;
  return interaction.guild.channels.cache.find((channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === configured.toLowerCase())?.id || null;
};

export function migrateKitSystem(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kit_tiers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, description TEXT, role_id TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kits (id INTEGER PRIMARY KEY AUTOINCREMENT, kit_id TEXT UNIQUE NOT NULL, kit_name TEXT NOT NULL, kit_tier TEXT, description TEXT, image_url TEXT, items TEXT NOT NULL DEFAULT '[]', required_discord_rank TEXT, required_activity INTEGER NOT NULL DEFAULT 0, required_online_minutes INTEGER NOT NULL DEFAULT 0, required_invites INTEGER NOT NULL DEFAULT 0, required_boosts INTEGER NOT NULL DEFAULT 0, required_xp INTEGER NOT NULL DEFAULT 0, cooldown_seconds INTEGER NOT NULL DEFAULT 0, availability INTEGER NOT NULL DEFAULT 0, staff_approval INTEGER NOT NULL DEFAULT 1, server TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kit_requirements (id INTEGER PRIMARY KEY AUTOINCREMENT, kit_id TEXT NOT NULL, requirement_type TEXT NOT NULL, requirement_value TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(kit_id, requirement_type));
    CREATE TABLE IF NOT EXISTS kit_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, discord_user_id TEXT NOT NULL, guild_id TEXT NOT NULL, minecraft_ign TEXT NOT NULL, server TEXT NOT NULL, kit_id TEXT NOT NULL, kit_name TEXT NOT NULL, reason TEXT, image_url TEXT, ticket_channel_id TEXT, status TEXT NOT NULL DEFAULT 'PENDING', requested_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, delete_reason TEXT);
    CREATE TABLE IF NOT EXISTS kit_claims (id INTEGER PRIMARY KEY AUTOINCREMENT, discord_user_id TEXT NOT NULL, minecraft_ign TEXT NOT NULL, server TEXT NOT NULL, kit_id TEXT NOT NULL, kit_name TEXT NOT NULL, staff_id TEXT, request_id INTEGER, requested_at TEXT NOT NULL, approved_at TEXT, delivered_at TEXT, status TEXT NOT NULL DEFAULT 'PENDING', notes TEXT);
    CREATE TABLE IF NOT EXISTS invite_rewards (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, inviter_id TEXT NOT NULL, invited_user_id TEXT NOT NULL, invite_code TEXT, invited_at TEXT NOT NULL, left_at TEXT, valid INTEGER NOT NULL DEFAULT 1, rewarded INTEGER NOT NULL DEFAULT 0, UNIQUE(guild_id, invited_user_id));
    CREATE TABLE IF NOT EXISTS boost_rewards (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, boost_started_at TEXT NOT NULL, boost_ended_at TEXT, active INTEGER NOT NULL DEFAULT 1, reward_claimed INTEGER NOT NULL DEFAULT 0, last_reward_at TEXT);
    CREATE TABLE IF NOT EXISTS kit_activity (user_id TEXT NOT NULL, guild_id TEXT NOT NULL, voice_minutes INTEGER NOT NULL DEFAULT 0, sessions INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT, PRIMARY KEY(user_id, guild_id));
    CREATE TABLE IF NOT EXISTS kit_settings (guild_id TEXT NOT NULL, setting_key TEXT NOT NULL, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(guild_id, setting_key));
    CREATE TABLE IF NOT EXISTS kit_cart (discord_user_id TEXT NOT NULL, guild_id TEXT NOT NULL, kit_id TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, PRIMARY KEY(discord_user_id, guild_id, kit_id));
  `);
  for (const column of ["quantity INTEGER NOT NULL DEFAULT 1"]) {
    try { db.exec(`ALTER TABLE kit_requests ADD COLUMN ${column}`); } catch (error) { if (!error.message.includes("duplicate column name")) throw error; }
    try { db.exec(`ALTER TABLE kit_claims ADD COLUMN ${column}`); } catch (error) { if (!error.message.includes("duplicate column name")) throw error; }
  }
  for (const column of ["deleted_at TEXT", "delete_reason TEXT"]) {
    try { db.exec(`ALTER TABLE kit_requests ADD COLUMN ${column}`); } catch (error) { if (!error.message.includes("duplicate column name")) throw error; }
  }
  const insertTier = db.prepare("INSERT OR IGNORE INTO kit_tiers (name, description, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
  for (const tier of ["Viper X", "Viper Y", "Viper Z"]) insertTier.run(tier, "Configurable ViperCryo reward tier. Benefits are set by staff.", roleIdForTier(tier), timestamp(), timestamp());
  const addKnowledge = db.prepare(`INSERT INTO knowledge (guild_id, category, topic, question, answer, source, verified, dynamic, historical, last_verified_at, created_by, created_at, updated_at)
    SELECT '*', 'ViperCryo', ?, ?, ?, 'ViperCryo community configuration', 1, 0, 0, ?, 'kit-system', ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM knowledge WHERE category='ViperCryo' AND topic=?)`);
  for (const [topic, question, answer] of [
    ["identity", "What is ViperCryo?", "ViperCryo is a 6b6t-focused Discord community and clan that provides community support, gaming information, and configurable community rewards."],
    ["kits", "How do I request a free kit?", "According to ViperCryo's community reward system, members can use /kit request when an available kit has been configured by staff. Eligibility and staff approval may be required."],
    ["activity", "How does activity affect ViperCryo kits?", "ViperCryo can use measurable bot-observable activity such as messages, XP, levels, and voice activity for configurable kit eligibility. The bot does not claim historical Discord online time."],
    ["owner", "Who owns ViperCryo?", "ViperCryo is owned by MahfuzViper; the Minecraft or game tag associated with the community is GodMahfuz."]
  ]) { const time = timestamp(); addKnowledge.run(topic, question, answer, time, time, time, topic); }
}

export function kitCommands() {
  const stringOption = (name, description, required = true) => ({ type: 3, name, description, required });
  return { name: "kit", description: "ViperCryo kits and rewards", options: [
    { type: 1, name: "request", description: "Create a private kit request ticket" },
    { type: 1, name: "basket", description: "View your kit basket and checkout up to 3 kits" },
    { type: 1, name: "profile", description: "View your ViperCryo reward profile" },
    { type: 1, name: "history", description: "View your delivered kit history" },
    { type: 1, name: "stats", description: "View kit system statistics" },
    { type: 1, name: "config", description: "View kit system configuration" },
    { type: 1, name: "publish", description: "Publish configured kits with Order Now buttons", options: [{ type: 7, name: "channel", description: "Kit showcase channel", required: true }, stringOption("kit_id", "Optional kit ID", false)] },
    { type: 1, name: "setchannel", description: "Save the kit showcase channel", options: [{ type: 7, name: "channel", description: "Kit showcase channel", required: true }] },
    { type: 1, name: "setcategory", description: "Save the ticket category ID", options: [stringOption("category_id", "Discord category channel ID")] },
    { type: 1, name: "add", description: "Add a configurable kit", options: [stringOption("name", "Kit name"), stringOption("tier", "Viper X, Viper Y, or Viper Z", false), stringOption("description", "Kit description", false), { type: 11, name: "image", description: "Kit image upload", required: false }, stringOption("items", "Optional item list", false), { type: 5, name: "availability", description: "Show this kit in the order panel", required: false }] },
    { type: 1, name: "edit", description: "Edit a configurable kit", options: [{ type: 4, name: "id", description: "Kit database ID", required: true }, stringOption("data", "JSON fields")] },
    { type: 1, name: "delete", description: "Disable a kit", options: [{ type: 4, name: "id", description: "Kit database ID", required: true }] },
    { type: 1, name: "setimage", description: "Replace a kit image", options: [{ type: 4, name: "id", description: "Kit database ID", required: true }, { type: 11, name: "image", description: "New kit image", required: true }] },
    { type: 1, name: "approve", description: "Approve a pending request", options: [{ type: 4, name: "request_id", description: "Request ID", required: true }] },
    { type: 1, name: "reject", description: "Reject a pending request", options: [{ type: 4, name: "request_id", description: "Request ID", required: true }, stringOption("reason", "Reason", false)] },
    { type: 1, name: "tpa", description: "Send TPA through configured integration", options: [{ type: 4, name: "request_id", description: "Request ID", required: true }] },
    { type: 1, name: "deliver", description: "Mark a kit as delivered", options: [{ type: 4, name: "request_id", description: "Request ID", required: true }] },
    { type: 1, name: "delete_ticket", description: "Delete a kit request ticket", options: [{ type: 4, name: "request_id", description: "Request ID", required: true }] },
    { type: 1, name: "cooldown", description: "Set a kit cooldown", options: [{ type: 4, name: "id", description: "Kit database ID", required: true }, { type: 4, name: "seconds", description: "Cooldown in seconds", required: true }] },
    { type: 1, name: "setrole", description: "Set a tier role ID", options: [stringOption("tier", "Viper X, Viper Y, or Viper Z"), stringOption("role_id", "Discord role ID")] }
  ] };
}

export function openKitRequestModal(interaction, db, presetKitId = null) {
  const available = db.prepare("SELECT kit_id, kit_name FROM kits WHERE availability=1 ORDER BY kit_name").all();
  if (!available.length) return interaction.reply({ content: "No ViperCryo kits are currently configured by staff.", ephemeral: true });
  const modal = new ModalBuilder().setCustomId(presetKitId ? `kit-order-modal:${presetKitId}` : "kit-request-modal").setTitle("ViperCryo Kit Request");
  const fields = [
    ["minecraft_ign", "Minecraft IGN", "Your Minecraft username"],
    ["server", "Server", "Example: 6b6t"],
    ...(presetKitId ? [] : [["kit_id", `Kit (${available.map((kit) => kit.kit_id).join(", ")})`, "Enter a kit ID"]]),
    ...(presetKitId ? [["quantity", "Quantity", "Quantity allowed by your level"]] : []),
    ["reason", "Why do you need this kit?", "Tell kit staff briefly"],
    ["image_url", "Optional image URL", "Leave blank if unused"]
  ];
  modal.addComponents(...fields.map(([id, label, placeholder]) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder).setRequired(id !== "image_url").setStyle(id === "reason" ? TextInputStyle.Paragraph : TextInputStyle.Short))));
  return interaction.showModal(modal);
}

function maxQuantity(interaction, db) {
  const firstOrder = !db.prepare("SELECT 1 FROM kit_requests WHERE discord_user_id=? AND guild_id=? LIMIT 1").get(interaction.user.id, interaction.guildId);
  if (firstOrder) return 3;
  const user = db.prepare("SELECT level FROM users WHERE user_id=? AND guild_id=?").get(interaction.user.id, interaction.guildId);
  const level = user?.level || 1;
  const divisor = Math.max(1, Number(process.env.KIT_LEVELS_PER_QUANTITY || 5));
  return Math.max(1, Math.floor(level / divisor) + 1);
}

function orderLimit(interaction, db) {
  if (isStaff(interaction)) return null;
  const recent = db.prepare("SELECT requested_at FROM kit_requests WHERE discord_user_id=? AND guild_id=? ORDER BY requested_at DESC LIMIT 1").get(interaction.user.id, interaction.guildId);
  if (!recent) return null;
  const remaining = 24 * 60 * 60 * 1000 - (Date.now() - Date.parse(recent.requested_at));
  return remaining > 0 ? remaining : null;
}

function orderLimitMessage(remaining) {
  const hours = Math.ceil(remaining / (60 * 60 * 1000));
  return `You can place only 1 kit order every 24 hours. Please wait about ${hours} hour${hours === 1 ? "" : "s"} before ordering again.`;
}

function eligibility(interaction, db, kit, quantity = 1) {
  const user = db.prepare("SELECT * FROM users WHERE user_id=? AND guild_id=?").get(interaction.user.id, interaction.guildId) || { xp: 0, level: 1, messages: 0 };
  const activity = db.prepare("SELECT * FROM kit_activity WHERE user_id=? AND guild_id=?").get(interaction.user.id, interaction.guildId) || { voice_minutes: 0 };
  const validInvites = db.prepare("SELECT COUNT(*) AS n FROM invite_rewards WHERE guild_id=? AND inviter_id=? AND valid=1 AND (left_at IS NULL OR left_at='')").get(interaction.guildId, interaction.user.id).n;
  const boosts = db.prepare("SELECT COUNT(*) AS n FROM boost_rewards WHERE guild_id=? AND user_id=? AND active=1").get(interaction.guildId, interaction.user.id).n;
  const reasons = [], missing = [];
  const roleId = kit.kit_tier ? roleIdForTier(kit.kit_tier) : null;
  if (roleId && !interaction.member?.roles?.cache?.has(roleId)) { reasons.push(`Required role: ${kit.kit_tier}`); missing.push(kit.kit_tier); }
  if (user.xp < kit.required_xp) missing.push(`${kit.required_xp - user.xp} more XP`);
  if (user.messages < kit.required_activity) missing.push(`${kit.required_activity - user.messages} more messages`);
  if (activity.voice_minutes < kit.required_online_minutes) missing.push(`${kit.required_online_minutes - activity.voice_minutes} more voice activity minutes`);
  if (validInvites < kit.required_invites) missing.push(`${kit.required_invites - validInvites} more valid invites`);
  if (boosts < kit.required_boosts) missing.push(`${kit.required_boosts - boosts} more active boosts`);
  const last = db.prepare("SELECT delivered_at FROM kit_claims WHERE discord_user_id=? AND kit_id=? AND status='DELIVERED' ORDER BY delivered_at DESC LIMIT 1").get(interaction.user.id, kit.kit_id);
  const cooldownRemaining = last && kit.cooldown_seconds ? Math.max(0, kit.cooldown_seconds - (Date.now() - Date.parse(last.delivered_at)) / 1000) : 0;
  if (cooldownRemaining > 0) missing.push(`cooldown: ${Math.ceil(cooldownRemaining)} seconds remaining`);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQuantity(interaction, db)) missing.push(`quantity limit: max ${maxQuantity(interaction, db)} at your current level`);
  return { eligible: missing.length === 0, reasons, missingRequirements: missing, cooldownRemaining, requiredRole: kit.kit_tier, requiredActivity: kit.required_activity, requiredInvites: kit.required_invites, requiredBoosts: kit.required_boosts };
}

export async function handleKitModal(interaction, db) {
  const value = (name) => interaction.fields.getTextInputValue(name).trim();
  const presetKitId = interaction.customId.startsWith("kit-order-modal:") ? interaction.customId.split(":")[1] : null;
  const kit = db.prepare("SELECT * FROM kits WHERE kit_id=? AND availability=1").get(presetKitId || value("kit_id"));
  if (!kit) return interaction.reply({ content: "That kit is unavailable or not configured. Ask kit staff for the current kit IDs.", ephemeral: true });
  const orderRemaining = orderLimit(interaction, db);
  if (orderRemaining) return interaction.reply({ content: orderLimitMessage(orderRemaining), ephemeral: true });
  const deleted = db.prepare("SELECT deleted_at FROM kit_requests WHERE discord_user_id=? AND guild_id=? AND status='DELETED' ORDER BY deleted_at DESC LIMIT 1").get(interaction.user.id, interaction.guildId);
  if (deleted && Date.now() - Date.parse(deleted.deleted_at) < 24 * 60 * 60 * 1000 && !isStaff(interaction)) return interaction.reply({ content: "Your deleted ticket has a 24-hour cooldown. You can create another ticket after that cooldown ends.", ephemeral: true });
  const active = !isStaff(interaction) && db.prepare("SELECT COUNT(*) AS n FROM kit_requests WHERE discord_user_id=? AND guild_id=? AND status IN ('PENDING','APPROVED','TPA_SENT')").get(interaction.user.id, interaction.guildId).n;
  if (active) return interaction.reply({ content: "You already have an active kit ticket. Complete it before placing another order.", ephemeral: true });
  const quantity = presetKitId ? Number(value("quantity")) : 1;
  const check = eligibility(interaction, db, kit, quantity);
  const requestTime = timestamp();
  const result = db.prepare("INSERT INTO kit_requests (discord_user_id,guild_id,minecraft_ign,server,kit_id,kit_name,quantity,reason,image_url,status,requested_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(interaction.user.id, interaction.guildId, value("minecraft_ign"), value("server"), kit.kit_id, kit.kit_name, quantity, value("reason"), value("image_url") || null, "PENDING", requestTime, requestTime);
  const requestId = result.lastInsertRowid;
  db.prepare("INSERT INTO kit_claims (discord_user_id,minecraft_ign,server,kit_id,kit_name,quantity,request_id,requested_at,status,notes) VALUES (?,?,?,?,?,?,?,?,?,?)").run(interaction.user.id, value("minecraft_ign"), value("server"), kit.kit_id, kit.kit_name, quantity, requestId, requestTime, "PENDING", check.missingRequirements.join("; "));
  const staffMention = staffRoleId() ? `<@&${staffRoleId()}>` : "Kit staff";
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`kit:approve:${requestId}`).setLabel("Accept").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`kit:reject:${requestId}`).setLabel("Reject").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`kit:tpa:${requestId}`).setLabel("TPA Player").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`kit:deliver:${requestId}`).setLabel("Kit Given").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`kit:delete:${requestId}`).setLabel("Delete Ticket").setStyle(ButtonStyle.Danger)
  );
  const description = `Minecraft IGN: **${discordSafe(value("minecraft_ign"))}**\nServer: **${discordSafe(value("server"))}**\nRequested kit: **${kit.kit_name}** × **${quantity}**\nReason: ${discordSafe(value("reason"))}\nEligibility: ${check.eligible ? "✅ Eligible" : `❌ Not eligible\nMissing: ${check.missingRequirements.join(", ")}`}\nStatus: **⏳ Waiting for Staff**`;
  const channelName = `kit-request-${interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80)}-${requestId}`;
  const categoryId = categoryIdFor(interaction, db);
  const channel = await interaction.guild.channels.create({ name: channelName, type: ChannelType.GuildText, ...(categoryId ? { parent: categoryId } : {}), permissionOverwrites: [{ id: interaction.guild.roles.everyone.id, deny: ["ViewChannel"] }, { id: interaction.user.id, allow: ["ViewChannel", "SendMessages", "AttachFiles"] }, ...(staffRoleId() ? [{ id: staffRoleId(), allow: ["ViewChannel", "SendMessages", "AttachFiles"] }] : [])] });
  db.prepare("UPDATE kit_requests SET ticket_channel_id=?, updated_at=? WHERE id=?").run(channel.id, timestamp(), requestId);
  const message = await channel.send({ content: staffMention, embeds: [{ title: "🎁 VIPERCRYO KIT REQUEST", description, ...(kit.image_url ? { image: { url: kit.image_url } } : {}) }], components: [buttons] });
  await message.pin().catch(() => {});
  return interaction.reply({ content: `Your kit request #${requestId} was created: ${channel}`, ephemeral: true });
}

export function openCheckoutModal(interaction, db) {
  const total = db.prepare("SELECT COALESCE(SUM(quantity),0) AS n FROM kit_cart WHERE discord_user_id=? AND guild_id=?").get(interaction.user.id, interaction.guildId).n;
  if (!total) return interaction.reply({ content: "Your basket is empty. Add a kit first.", ephemeral: true });
  const modal = new ModalBuilder().setCustomId("kit-checkout-modal").setTitle(`Checkout ${total} kit${total === 1 ? "" : "s"}`);
  const fields = [["minecraft_ign", "Minecraft IGN", "Your Minecraft username"], ["server", "Server", "Example: 6b6t"], ["reason", "Reason", "Tell kit staff briefly"], ["image_url", "Optional image URL", "Leave blank if unused"]];
  modal.addComponents(...fields.map(([id, label, placeholder]) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder).setRequired(id !== "image_url").setStyle(id === "reason" ? TextInputStyle.Paragraph : TextInputStyle.Short))));
  return interaction.showModal(modal);
}

export async function handleCheckoutModal(interaction, db) {
  const value = (name) => interaction.fields.getTextInputValue(name).trim();
  const orderRemaining = orderLimit(interaction, db);
  if (orderRemaining) return interaction.reply({ content: orderLimitMessage(orderRemaining), ephemeral: true });
  const deleted = db.prepare("SELECT deleted_at FROM kit_requests WHERE discord_user_id=? AND guild_id=? AND status='DELETED' ORDER BY deleted_at DESC LIMIT 1").get(interaction.user.id, interaction.guildId);
  if (deleted && Date.now() - Date.parse(deleted.deleted_at) < 24 * 60 * 60 * 1000 && !isStaff(interaction)) return interaction.reply({ content: "Your deleted ticket has a 24-hour cooldown. You can create another ticket after that cooldown ends.", ephemeral: true });
  const active = !isStaff(interaction) && db.prepare("SELECT COUNT(*) AS n FROM kit_requests WHERE discord_user_id=? AND guild_id=? AND status IN ('PENDING','APPROVED','TPA_SENT')").get(interaction.user.id, interaction.guildId).n;
  if (active) return interaction.reply({ content: "You already have an active kit ticket. Complete it before placing another order.", ephemeral: true });
  const cart = db.prepare("SELECT c.*,k.* FROM kit_cart c JOIN kits k ON k.kit_id=c.kit_id WHERE c.discord_user_id=? AND c.guild_id=? AND k.availability=1").all(interaction.user.id, interaction.guildId);
  if (!cart.length) return interaction.reply({ content: "Your basket is empty or its kits are unavailable.", ephemeral: true });
  for (const kit of cart) { const check = eligibility(interaction, db, kit, kit.quantity); if (!check.eligible) return interaction.reply({ content: `You are not eligible for **${kit.kit_name}** yet.\nMissing: ${check.missingRequirements.join(", ")}`, ephemeral: true }); }
  const time = timestamp(), requestIds = [], insertRequest = db.prepare("INSERT INTO kit_requests (discord_user_id,guild_id,minecraft_ign,server,kit_id,kit_name,quantity,reason,image_url,status,requested_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"), insertClaim = db.prepare("INSERT INTO kit_claims (discord_user_id,minecraft_ign,server,kit_id,kit_name,quantity,request_id,requested_at,status,notes) VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (const kit of cart) { const result = insertRequest.run(interaction.user.id, interaction.guildId, value("minecraft_ign"), value("server"), kit.kit_id, kit.kit_name, kit.quantity, value("reason"), value("image_url") || null, "PENDING", time, time); requestIds.push(result.lastInsertRowid); insertClaim.run(interaction.user.id, value("minecraft_ign"), value("server"), kit.kit_id, kit.kit_name, kit.quantity, result.lastInsertRowid, time, "PENDING", "Basket order"); }
  const channelName = `kit-order-${interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 70)}-${requestIds[0]}`;
  const categoryId = categoryIdFor(interaction, db);
  const channel = await interaction.guild.channels.create({ name: channelName, type: ChannelType.GuildText, ...(categoryId ? { parent: categoryId } : {}), permissionOverwrites: [{ id: interaction.guild.roles.everyone.id, deny: ["ViewChannel"] }, { id: interaction.user.id, allow: ["ViewChannel", "SendMessages", "AttachFiles"] }, ...(staffRoleId() ? [{ id: staffRoleId(), allow: ["ViewChannel", "SendMessages", "AttachFiles"] }] : [])] });
  db.prepare("UPDATE kit_requests SET ticket_channel_id=?,updated_at=? WHERE id IN (" + requestIds.map(() => "?").join(",") + ")").run(channel.id, time, ...requestIds);
  const summary = cart.map((kit) => `**${kit.kit_name}** × **${kit.quantity}**`).join("\n");
  const buttons = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`kit:approve:${requestIds[0]}`).setLabel("Accept").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`kit:reject:${requestIds[0]}`).setLabel("Reject").setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`kit:tpa:${requestIds[0]}`).setLabel("TPA Player").setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`kit:deliver:${requestIds[0]}`).setLabel("Kit Given").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`kit:delete:${requestIds[0]}`).setLabel("Delete Ticket").setStyle(ButtonStyle.Danger));
  await channel.send({ content: staffRoleId() ? `<@&${staffRoleId()}>` : "Kit staff", embeds: [{ title: "🎁 VIPERCRYO BASKET ORDER", description: `Minecraft IGN: **${discordSafe(value("minecraft_ign"))}**\nServer: **${discordSafe(value("server"))}**\n${summary}\nReason: ${discordSafe(value("reason"))}\nStatus: **⏳ Waiting for Staff**` }], components: [buttons] });
  db.prepare("DELETE FROM kit_cart WHERE discord_user_id=? AND guild_id=?").run(interaction.user.id, interaction.guildId);
  return interaction.reply({ content: `Your basket order was created in ${channel}.`, ephemeral: true });
}

export async function publishKitPanel(interaction, db, channel, kitId = null) {
  const kits = db.prepare(`SELECT * FROM kits WHERE availability=1 ${kitId ? "AND (kit_id=? OR CAST(id AS TEXT)=?)" : ""} ORDER BY id`).all(...(kitId ? [kitId, kitId] : []));
  if (!kits.length) return interaction.reply({ content: "No available kits found. Add a kit and set availability to true first.", ephemeral: true });
  for (const kit of kits) {
    let items = [];
    try { items = JSON.parse(kit.items || "[]"); } catch { items = []; }
    const itemText = items.length ? items.map((item) => `${item.name || "Item"} ×${item.quantity || 1}`).join("\n") : "Configured by ViperCryo staff";
    const requirements = [`Level quantity limit: ${process.env.KIT_LEVELS_PER_QUANTITY || 5} levels per additional kit`];
    if (kit.required_activity) requirements.push(`${kit.required_activity} messages`);
    if (kit.required_xp) requirements.push(`${kit.required_xp} XP`);
    if (kit.required_invites) requirements.push(`${kit.required_invites} valid invites`);
      const buttons = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`kit:order:${kit.kit_id}`).setLabel("Order Now").setEmoji("🎁").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`kit:cart:${kit.kit_id}`).setLabel("Add to Basket").setEmoji("🛒").setStyle(ButtonStyle.Primary));
      await channel.send({ embeds: [{ title: `🎁 ${kit.kit_name}`, description: `${kit.description || "ViperCryo community reward"}\n\n**Includes**\n${itemText}\n\n**Requirements**\n${requirements.join("\n")}\n\nQuantity is checked from the member's current ViperCryo level. Maximum basket size: **3 kits**.`, ...(kit.image_url ? { image: { url: kit.image_url } } : {}) }], components: [buttons] });
  }
  return interaction.reply({ content: `${kits.length} kit panel${kits.length === 1 ? "" : "s"} published in ${channel}.`, ephemeral: true });
}

export async function handleKitButton(interaction, db) {
  const [, action, requestIdText] = interaction.customId.split(":");
  if (action === "order") return openKitRequestModal(interaction, db, requestIdText);
  if (action === "cart") {
    const kit = db.prepare("SELECT kit_id,kit_name FROM kits WHERE kit_id=? AND availability=1").get(requestIdText);
    if (!kit) return interaction.reply({ content: "That kit is no longer available.", ephemeral: true });
    const total = db.prepare("SELECT COALESCE(SUM(quantity),0) AS n FROM kit_cart WHERE discord_user_id=? AND guild_id=?").get(interaction.user.id, interaction.guildId).n;
    const current = db.prepare("SELECT quantity FROM kit_cart WHERE discord_user_id=? AND guild_id=? AND kit_id=?").get(interaction.user.id, interaction.guildId, kit.kit_id)?.quantity || 0;
    if (total >= 3) return interaction.reply({ content: "Your basket is full. Checkout or remove a kit first. Maximum: 3 kits.", ephemeral: true });
    db.prepare("INSERT INTO kit_cart (discord_user_id,guild_id,kit_id,quantity,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(discord_user_id,guild_id,kit_id) DO UPDATE SET quantity=quantity+1,updated_at=excluded.updated_at").run(interaction.user.id, interaction.guildId, kit.kit_id, Math.min(current + 1, 3 - total), timestamp());
    return interaction.reply({ content: `🛒 **${kit.kit_name}** added to your basket. Use **/kit basket** to checkout (up to 3 kits).`, ephemeral: true });
  }
  if (action === "checkout") return openCheckoutModal(interaction, db);
  if (!isStaff(interaction)) return interaction.reply({ content: "Only configured kit staff or administrators can process kit requests.", ephemeral: true });
  const requestId = Number(requestIdText);
  const request = db.prepare("SELECT * FROM kit_requests WHERE id=?").get(requestId);
  if (!request) return interaction.reply({ content: "Kit request not found.", ephemeral: true });
  if (action === "approve") {
    db.prepare("UPDATE kit_requests SET status='APPROVED',updated_at=? WHERE id=?").run(timestamp(), requestId);
    db.prepare("UPDATE kit_claims SET status='APPROVED',staff_id=?,approved_at=? WHERE request_id=?").run(interaction.user.id, timestamp(), requestId);
    return interaction.reply(`Request #${requestId} approved. Use **TPA Player** when ready.`);
  }
  if (action === "reject") {
    db.prepare("UPDATE kit_requests SET status='REJECTED',updated_at=? WHERE id=?").run(timestamp(), requestId);
    db.prepare("UPDATE kit_claims SET status='REJECTED',staff_id=?,notes=? WHERE request_id=?").run(interaction.user.id, "Rejected by staff", requestId);
    return interaction.reply(`Request #${requestId} rejected.`);
  }
  if (action === "tpa") {
    if (process.env.RCON_ENABLED !== "true" && process.env.MINECRAFT_INTEGRATION_ENABLED !== "true") return interaction.reply({ content: "⚠️ Minecraft integration is not configured. Staff must manually send the TPA in Minecraft.", ephemeral: true });
    db.prepare("UPDATE kit_claims SET status='TPA_SENT',staff_id=?,notes=? WHERE request_id=?").run(interaction.user.id, "Integration dispatch is configured but command transport must be implemented for the selected adapter.", requestId);
    return interaction.reply({ content: `TPA prepared for **${request.minecraft_ign}**. Verify the configured Minecraft adapter before delivery.`, ephemeral: true });
  }
  if (action === "deliver") {
    db.prepare("UPDATE kit_requests SET status='DELIVERED',updated_at=? WHERE id=?").run(timestamp(), requestId);
    db.prepare("UPDATE kit_claims SET status='DELIVERED',staff_id=?,delivered_at=? WHERE request_id=?").run(interaction.user.id, timestamp(), requestId);
    return interaction.reply(`🎁 Request #${requestId} marked as **KIT DELIVERED**.`);
  }
  if (action === "delete") return deleteKitRequest(interaction, db, request, "Deleted by staff");
  return interaction.reply({ content: "Unknown kit action.", ephemeral: true });
}

export async function deleteKitRequest(interaction, db, request, reason) {
  if (request.status === "DELETED" || request.status === "DELIVERED") return interaction.reply({ content: `Request #${request.id} is already ${request.status.toLowerCase()}.`, ephemeral: true });
  const deletedAt = timestamp();
  db.prepare("UPDATE kit_requests SET status='DELETED',deleted_at=?,delete_reason=?,updated_at=? WHERE id=?").run(deletedAt, reason, deletedAt, request.id);
  db.prepare("UPDATE kit_claims SET status='DELETED',notes=? WHERE request_id=?").run(reason, request.id);
  await interaction.reply(`⚠️ Ticket #${request.id} was deleted. The player can create another ticket after 24 hours.`).catch(() => {});
  if (interaction.channel?.deletable) await interaction.channel.delete(reason).catch(() => {});
}

export function markKitChannelDeleted(db, channelId) {
  const request = db.prepare("SELECT * FROM kit_requests WHERE ticket_channel_id=? AND status IN ('PENDING','APPROVED','TPA_SENT') ORDER BY id DESC LIMIT 1").get(channelId);
  if (!request) return null;
  const deletedAt = timestamp();
  db.prepare("UPDATE kit_requests SET status='DELETED',deleted_at=?,delete_reason='Channel deleted',updated_at=? WHERE id=?").run(deletedAt, deletedAt, request.id);
  db.prepare("UPDATE kit_claims SET status='DELETED',notes='Channel deleted' WHERE request_id=?").run(request.id);
  return { ...request, status: "DELETED", deleted_at: deletedAt };
}

export async function expireKitRequests(db, client) {
  const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const requests = db.prepare("SELECT * FROM kit_requests WHERE status IN ('PENDING','APPROVED','TPA_SENT')").all();
  for (const request of requests) {
    if (Date.parse(request.requested_at) > cutoff) continue;
    const deletedAt = timestamp();
    db.prepare("UPDATE kit_requests SET status='DELETED',deleted_at=?,delete_reason='Automatically deleted after 2 days',updated_at=? WHERE id=?").run(deletedAt, deletedAt, request.id);
    db.prepare("UPDATE kit_claims SET status='DELETED',notes='Automatically deleted after 2 days' WHERE request_id=?").run(request.id);
    const channel = request.ticket_channel_id ? await client.channels.fetch(request.ticket_channel_id).catch(() => null) : null;
    if (channel?.isTextBased()) await channel.send(`⚠️ This ticket was automatically deleted because it was not completed within 2 days. The player can create another ticket after 24 hours.`).catch(() => {});
    if (channel?.deletable) await channel.delete("Ticket incomplete for 2 days").catch(() => {});
    await client.users.fetch(request.discord_user_id).then((user) => user.send(`⚠️ Your ViperCryo ticket #${request.id} was automatically deleted because it was not completed within 2 days. You can create another ticket after 24 hours.`)).catch(() => {});
  }
}

export function kitProfile(interaction, db) {
  const user = db.prepare("SELECT * FROM users WHERE user_id=? AND guild_id=?").get(interaction.user.id, interaction.guildId) || { xp: 0, level: 1, messages: 0 };
  const invites = db.prepare("SELECT COUNT(*) n FROM invite_rewards WHERE guild_id=? AND inviter_id=? AND valid=1 AND (left_at IS NULL OR left_at='')").get(interaction.guildId, interaction.user.id).n;
  const boosts = db.prepare("SELECT COUNT(*) n FROM boost_rewards WHERE guild_id=? AND user_id=? AND active=1").get(interaction.guildId, interaction.user.id).n;
  const kits = db.prepare("SELECT COUNT(*) n FROM kit_claims WHERE discord_user_id=? AND status='DELIVERED'").get(interaction.user.id).n;
  return `Discord: <@${interaction.user.id}>\nXP: **${user.xp}** · Level: **${user.level}**\nMessages: **${user.messages}**\nValid invites: **${invites}** · Active boosts: **${boosts}**\nDelivered kits: **${kits}**\nActivity is measured from bot-observable XP/messages; historical Discord online time is not claimed.`;
}

export { isStaff };
