const OFFICIAL_SOURCES = [
  ["home", "https://www.6b6t.org/en", "static"],
  ["commands", "https://www.6b6t.org/en/commands", "static"],
  ["shop", "https://www.6b6t.org/en/shop", "shop"],
  ["vote", "https://www.6b6t.org/en/vote", "vote"],
  ["stats", "https://www.6b6t.org/en/stats", "stats"],
  ["history", "https://www.6b6t.org/en/history", "history"],
  ["updates", "https://www.6b6t.org/en/updates", "updates"],
  ["status", "https://www.6b6t.org/en/status", "status"],
  ["anarchymod", "https://github.com/6b6t/AnarchyMod", "anarchymod"],
  ["blog", "https://blog.6b6t.org/", "blog"]
];

const clean = (value) => value.replace(/\s+/g, " ").trim();
const stripHtml = (html) => clean(html
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
  .replace(/&#x27;/gi, "'").replace(/&#39;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">"));
const sectionText = (text, heading) => {
  const start = text.toLowerCase().indexOf(heading.toLowerCase());
  return start < 0 ? text : text.slice(start, start + 2500);
};
const sourceRecord = (db, key, url, kind, status, fetchedAt, error = null) => db.prepare(`
  INSERT INTO "6b6t_sources" (source_key, url, source_name, kind, last_fetched_at, status, error)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_key) DO UPDATE SET url=excluded.url, source_name=excluded.source_name,
  kind=excluded.kind, last_fetched_at=excluded.last_fetched_at, status=excluded.status, error=excluded.error
`).run(key, url, `Official 6b6t ${key}`, kind, fetchedAt, status, error);

function upsertKnowledge(db, item, fetchedAt) {
  const record = { ...item, keywords: JSON.stringify(item.keywords || []) };
  db.prepare(`INSERT INTO "6b6t_knowledge"
    (source_url, section_title, title, category, subcategory, content, keywords, verified, dynamic, historical, last_verified_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_url, section_title) DO UPDATE SET title=excluded.title, category=excluded.category,
    subcategory=excluded.subcategory, content=excluded.content, keywords=excluded.keywords, verified=excluded.verified,
    dynamic=excluded.dynamic, historical=excluded.historical, last_verified_at=excluded.last_verified_at, updated_at=excluded.updated_at`).run(
    item.source_url, item.section_title, record.title, record.category, record.subcategory || null,
    record.content, record.keywords, record.verified ? 1 : 0, record.dynamic ? 1 : 0, record.historical ? 1 : 0,
    fetchedAt, fetchedAt, fetchedAt);
}

function parseCommands(db, text, url, fetchedAt) {
  const matches = [...text.matchAll(/(\/[^\s]+(?:\s+[^\s]+)?)\s+(FREE|\[PRIME\]|\[PRIME ULTRA\]|\[ELITE\]|\[ELITE ULTRA\]|\[APEX\]|\[LEGEND\])\s+([^/]{8,220}?)(?=\/|$)/gi)];
  const insert = db.prepare(`INSERT INTO "6b6t_commands" (command, aliases, category, rank_requirement, description, syntax, example, source_url, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(command) DO UPDATE SET aliases=excluded.aliases, category=excluded.category,
    rank_requirement=excluded.rank_requirement, description=excluded.description, syntax=excluded.syntax, example=excluded.example,
    source_url=excluded.source_url, updated_at=excluded.updated_at`);
  const seen = new Set();
  for (const match of matches) {
    const command = match[1].split(/\s+/)[0].toLowerCase();
    if (seen.has(command) || command.length < 2) continue;
    seen.add(command);
    const rank = match[2].replace(/[\[\]]/g, "").toUpperCase();
    const description = clean(match[3]);
    insert.run(command, JSON.stringify([]), text.toLowerCase().includes("premium commands") && rank !== "FREE" ? "PREMIUM" : "SERVER", rank, description, match[1], `/${command.replace("/", "")}`, url, fetchedAt);
    upsertKnowledge(db, { source_url: url, section_title: `command:${command}`, title: `/${command.slice(1)}`, category: "6b6t", subcategory: "commands", content: `${match[1]} (${rank}): ${description}`, keywords: [command, rank, "command"], verified: true }, fetchedAt);
  }
  return seen.size;
}

function parseStructuredPage(db, key, url, text, fetchedAt) {
  const common = { source_url: url, category: "6b6t", verified: true, dynamic: false, historical: false };
  const facts = [];
  if (key === "home") facts.push(["identity", "6b6t identity", "6b6t is a survival Minecraft anarchy server with no rules, no punishments and no queue. It supports up to 2000 simultaneous players and provides commands such as /tpa and /home.", ["6b6t", "anarchy", "no rules"]], ["server-address", "Java server address", "The official Java server address is play.6b6t.org.", ["ip", "java", "play.6b6t.org"]]);
  if (key === "status") {
    const players = text.match(/(\d[\d,]*)\s+players online/i)?.[1];
    const limit = text.match(/(\d[\d,]*)\s+maximum capacity/i)?.[1];
    const version = text.match(/6b6t Proxy\s+([\w.]+)/i)?.[1];
    if (players) facts.push(["status-players", "Current online players", `${players} players are currently online according to the official status page.`, ["players", "online", "status"]]);
    if (limit) facts.push(["status-capacity", "Maximum player capacity", `The official status page reports a maximum capacity of ${limit} players.`, ["capacity", "players"]]);
    if (version) facts.push(["status-version", "Current Minecraft version", `The current version shown by the official status page is ${version}.`, ["version", "minecraft"]]);
    for (const fact of facts) fact[4] = true;
  }
  if (key === "history") {
    const timeline = [...text.matchAll(/(January|February|March|April|May|June|July|August|September|October|November|December|NOW)[^A-Za-z]{0,8}([^]{0,280}?)(?=(?:January|February|March|April|May|June|July|August|September|October|November|December|NOW)\s|$)/gi)];
    timeline.forEach((match, index) => facts.push([`history-${index}`, clean(match[2]).slice(0, 220), clean(match[0]), ["history", match[1]], false, true]));
  }
  if (key === "stats") {
    const names = [...text.matchAll(/###\s*([^#]+?)(?=\s+\d+\s+players ranked|$)/gi)].map((match) => clean(match[1]));
    for (const name of names) facts.push([`stat-${name.toLowerCase()}`, name, `The official stats page tracks the ${name} leaderboard.`, ["stats", "leaderboard", name], true, false]);
  }
  if (key === "vote") {
    const sites = [...text.matchAll(/(MinecraftServers\.org|Minecraft-Server-List\.com|Minecraft Buzz|Minecraft MP|MCLike|Top Minecraft Servers|Planet Minecraft)/gi)];
    for (const [index, site] of [...new Set(sites.map((m) => m[1]))].entries()) facts.push([`vote-${index}`, site, `${site} is listed by the official 6b6t vote page as a daily voting site.`, ["vote", "daily", site]]);
  }
  if (key === "anarchymod") facts.push(["anarchymod", "Official AnarchyMod", sectionText(text, "Features").slice(0, 1800), ["anarchymod", "fabric", "github", "blacklist"]]);
  for (const [section, title, content, keywords, dynamic = false, historical = false] of facts) upsertKnowledge(db, { ...common, section_title: section, title, content, keywords, dynamic, historical }, fetchedAt);
  return facts.length;
}

export async function sync6b6t(db, { force = false } = {}) {
  const fetchedAt = new Date().toISOString();
  const result = { fetched: 0, failed: [], knowledge: 0, commands: 0 };
  for (const [key, url, kind] of OFFICIAL_SOURCES) {
    const old = db.prepare("SELECT last_fetched_at FROM \"6b6t_sources\" WHERE source_key=?").get(key);
    if (!force && old?.status === "ok" && old.last_fetched_at && Date.now() - Date.parse(old.last_fetched_at) < 86400000 && kind === "static") continue;
    try {
      const response = await fetch(url, { headers: { "user-agent": "ViperCryo-6b6t-sync/1.0" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const text = stripHtml(html);
      sourceRecord(db, key, url, kind, "ok", fetchedAt);
      result.fetched += 1;
      result.knowledge += parseStructuredPage(db, key, url, text, fetchedAt);
      if (key === "commands") result.commands = parseCommands(db, text, url, fetchedAt);
      if (key === "updates") {
        upsertKnowledge(db, { source_url: url, section_title: "updates-page", title: "Official 6b6t updates", category: "6b6t", subcategory: "updates", content: text.slice(0, 12000), keywords: ["updates", "latest", "changelog"], verified: true, dynamic: true }, fetchedAt);
        result.knowledge += 1;
      }
    } catch (error) {
      sourceRecord(db, key, url, kind, "failed", fetchedAt, error.message);
      result.failed.push({ key, url, error: error.message });
    }
  }
  db.prepare(`INSERT INTO "6b6t_dynamic" (data_key, value, source_url, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(data_key) DO UPDATE SET value=excluded.value, source_url=excluded.source_url, fetched_at=excluded.fetched_at`).run("last_sync", JSON.stringify(result), "sync", fetchedAt);
  return result;
}

export function get6b6tStatus(db) {
  const count = (table, where = "") => db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get().count;
  const last = db.prepare("SELECT value, fetched_at FROM \"6b6t_dynamic\" WHERE data_key='last_sync'").get();
  return { lastSync: last?.fetched_at || null, sources: count("\"6b6t_sources\"", "WHERE status='ok'"), failedSources: count("\"6b6t_sources\"", "WHERE status='failed'"), knowledge: count("\"6b6t_knowledge\""), commands: count("\"6b6t_commands\""), historical: count("\"6b6t_knowledge\"", "WHERE historical=1"), dynamic: count("\"6b6t_knowledge\"", "WHERE dynamic=1"), lastResult: last ? JSON.parse(last.value) : null };
}

export function search6b6t(db, query) {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean).slice(0, 10);
  if (!terms.length) return [];
  return db.prepare("SELECT * FROM \"6b6t_knowledge\" ORDER BY verified DESC, updated_at DESC").all()
    .map((row) => ({ ...row, score: terms.reduce((score, term) => score + (`${row.title} ${row.content} ${row.keywords}`.toLowerCase().includes(term) ? 1 : 0), 0) }))
    .filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
}

export { OFFICIAL_SOURCES };
