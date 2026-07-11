#!/usr/bin/env node
/**
 * FunTime Proxy — кэширующая прослойка между FunTime API и Minecraft-модом.
 *
 * - Опрашивает FunTime API (шахты, ивенты, список серверов) с заданной частотой
 * - Отдаёт данные моду из кэша: /api/mines, /api/events, /api/servers, /api/status
 * - Токен FunTime и настройки задаются через админ-панель: /admin
 * - API открыто для всех (авторизация по HWID будет добавлена позже), есть лимит запросов по IP
 *
 * Запуск: node server.js   (нужен Node.js 18+, зависимостей нет)
 */
​
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const querystring = require("querystring");
​
const APP_PORT = Number(process.env.PORT || 8080);
const FUNTIME_API = "https://api.funtime.su";
const CONFIG_PATH = path.join(__dirname, "config.json");
​
/* ===================== КОНФИГ ===================== */
​
const DEFAULT_CONFIG = {
  apiToken: "a44f618.4de5dca28833d7d90fefba654930022a", // токен FunTime API (можно сменить через админку)
  adminPassword: "Lipajopa228$", // пароль админки (можно сменить через админку)
  requestsPerMinute: 100,       // частота опроса FunTime API
  eventType: "all",             // all / system / user
  serverType: "anarchy",        // тип серверов для servers-info / mines-info (anarchy, creative, ...)
  clientRateLimitPerMinute: 120 // лимит запросов к /api/* с одного IP в минуту (0 = без лимита)
};
​
let config = { ...DEFAULT_CONFIG };
try {
  config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
} catch (_) {
  /* config.json появится после первого сохранения в админке */
}
​
function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
​
/* ===================== КЭШ ===================== */
​
const cache = {
  servers: { data: null, updatedAt: 0 },
  mines: { data: null, updatedAt: 0 },
  events: { data: {}, updatedAt: 0 }, // ключ — имя сервера
  lastError: null,
  rateLimitedUntil: 0
};
​
/* ===================== ЗАПРОСЫ К FUNTIME ===================== */
​
async function funtimeGet(endpoint, params = {}) {
  if (!config.apiToken) throw new Error("Токен не задан (зайдите в /admin)");
  if (Date.now() < cache.rateLimitedUntil) throw new Error("Пауза после 402 (rate limit)");
​
  const url = new URL(FUNTIME_API + endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
​
  const res = await fetch(url, {
    headers: { "Authorization-Token": config.apiToken },
    signal: AbortSignal.timeout(10_000)
  });
​
  if (res.status === 401) throw new Error("401 Unauthorized — проверьте токен");
  if (res.status === 402) {
    // Лимит запросов по токену — притормозим на 10 секунд
    cache.rateLimitedUntil = Date.now() + 10_000;
    throw new Error("402 Limitation requests by token");
  }
  if (!res.ok) throw new Error(`FunTime API: HTTP ${res.status}`);
  return res.json();
}
​
/* ===================== ЗАДАЧИ ОПРОСА ===================== */
// Крутим по кругу: servers -> mines -> events(чанк 1) -> events(чанк 2) -> ...
​
let eventChunks = []; // сервера, разбитые по 30 штук (лимит events-info)
let taskQueue = ["servers", "mines"];
let taskIndex = 0;
let pollTimer = null;
​
function rebuildQueue() {
  taskQueue = ["servers", "mines", ...eventChunks.map((_, i) => `events:${i}`)];
}
​
async function runTask(task) {
  if (task === "servers") {
    // ВАЖНО: реальные методы FunTime API живут под префиксом /method/*
    const json = await funtimeGet("/method/servers-info", { "server-type": config.serverType || "anarchy" });
    const servers = json.response || [];
    cache.servers = { data: servers, updatedAt: Date.now() };
    // Разбиваем на чанки по 30 (ограничение events-info)
    eventChunks = [];
    for (let i = 0; i < servers.length; i += 30) {
      eventChunks.push(servers.slice(i, i + 30));
    }
    rebuildQueue();
  } else if (task === "mines") {
    const json = await funtimeGet("/method/mines-info", { "server-types": config.serverType || "anarchy" });
    cache.mines = { data: json.servers || {}, updatedAt: Date.now() };
  } else if (task.startsWith("events:")) {
    const chunk = eventChunks[Number(task.split(":")[1])];
    if (!chunk || !chunk.length) return;
    const json = await funtimeGet("/method/events-info", {
      "event-type": config.eventType,
      "server-type": chunk.join(",")
    });
    for (const entry of json.response || []) {
      cache.events.data[entry.server] = entry.events;
    }
    cache.events.updatedAt = Date.now();
  }
}
​
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const rpm = Math.min(Math.max(Number(config.requestsPerMinute) || 100, 1), 600);
  const interval = Math.max(Math.floor(60_000 / rpm), 100); // 100 р/мин = каждые 600 мс
  rebuildQueue();
  pollTimer = setInterval(async () => {
    const task = taskQueue[taskIndex % taskQueue.length];
    taskIndex++;
    try {
      await runTask(task);
      cache.lastError = null;
    } catch (e) {
      cache.lastError = `${new Date().toISOString()} [${task}] ${e.message}`;
    }
  }, interval);
}
​
/* ===================== ЛИМИТ ЗАПРОСОВ ПО IP ===================== */
​
const ipHits = new Map(); // ip -> { count, windowStart }
​
function checkIpRateLimit(ip) {
  const limit = Number(config.clientRateLimitPerMinute) || 0;
  if (limit <= 0) return true;
  const now = Date.now();
  let rec = ipHits.get(ip);
  if (!rec || now - rec.windowStart >= 60_000) {
    rec = { count: 0, windowStart: now };
    ipHits.set(ip, rec);
  }
  rec.count++;
  return rec.count <= limit;
}
​
// Чистим старые записи, чтобы Map не рос бесконечно
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of ipHits) {
    if (now - rec.windowStart >= 120_000) ipHits.delete(ip);
  }
}, 60_000).unref();
​
/* ===================== HTTP УТИЛИТЫ ===================== */
​
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}
​
function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}
​
function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
​
function getClientIp(req) {
  // Если стоите за nginx/cloudflare — берём первый IP из X-Forwarded-For
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}
​
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
​
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}
​
/* ===================== АДМИН-ПАНЕЛЬ ===================== */
​
function adminPage(msg = "", isError = false) {
  const tokenPlaceholder = config.apiToken
    ? "токен задан — введите новый, чтобы сменить"
    : "вставьте токен FunTime";
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FunTime Proxy — Админка</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;background:#111;color:#eee}
  h2{color:#7ec97e}
  input{width:100%;box-sizing:border-box;padding:8px;margin:4px 0 12px;background:#1d1d1d;color:#eee;border:1px solid #444;border-radius:6px}
  button{padding:10px 18px;background:#2e7d32;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:15px}
  button.gen{background:#444;padding:6px 10px;font-size:13px;margin-bottom:12px}
  .msg{padding:10px;border-radius:6px;margin-bottom:16px}
  .ok{background:#1b3a1b;color:#8f8}
  .err{background:#3a1b1b;color:#f88}
  a{color:#7ec97e}
  label{font-size:14px;color:#aaa}
</style></head><body>
<h2>⛏ FunTime Proxy — настройки</h2>
${msg ? `<div class="msg ${isError ? "err" : "ok"}">${escapeHtml(msg)}</div>` : ""}
<form method="POST" action="/admin/save">
  <label>Пароль админки</label>
  <input type="password" name="password" required autocomplete="current-password">
​
  <label>Токен FunTime API (заголовок Authorization-Token)</label>
  <input type="text" name="apiToken" placeholder="${escapeHtml(tokenPlaceholder)}" autocomplete="off">
​
  <label>Запросов к FunTime в минуту (1–600)</label>
  <input type="number" name="requestsPerMinute" value="${config.requestsPerMinute}" min="1" max="600">
​
  <label>Тип ивентов (all / system / user)</label>
  <input type="text" name="eventType" value="${escapeHtml(config.eventType)}">
​
  <label>Тип серверов (anarchy / creative / ...)</label>
  <input type="text" name="serverType" value="${escapeHtml(config.serverType || "anarchy")}">
​
  <label>Лимит запросов к /api/* с одного IP в минуту (0 = без лимита)</label>
  <input type="number" name="clientRateLimitPerMinute" value="${config.clientRateLimitPerMinute}" min="0" max="100000">
​
  <label>Новый пароль админки (не обязательно)</label>
  <input type="password" name="newPassword" placeholder="оставьте пустым, чтобы не менять" autocomplete="new-password">
​
  <button type="submit">Сохранить</button>
</form>
<p><a href="/api/status">Статус сервера</a></p>
</body></html>`;
}
​
/* ===================== РОУТИНГ ===================== */
​
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = `${req.method} ${url.pathname}`;
​
  try {
    /* ---------- API для мода ---------- */
    if (url.pathname.startsWith("/api/")) {
      if (!checkIpRateLimit(getClientIp(req))) {
        return sendJson(res, 429, { success: false, error: "Too many requests" });
      }
      // TODO: здесь позже будет проверка HWID пользователя
​
      if (route === "GET /api/mines") {
        let data = cache.mines.data || {};
        const s = url.searchParams.get("server");
        if (s) data = { [s]: data[s] || [] };
        return sendJson(res, 200, { success: true, updatedAt: cache.mines.updatedAt, servers: data });
      }
​
      if (route === "GET /api/events") {
        let data = cache.events.data;
        const s = url.searchParams.get("server");
        if (s) data = { [s]: data[s] || [] };
        return sendJson(res, 200, { success: true, updatedAt: cache.events.updatedAt, servers: data });
      }
​
      if (route === "GET /api/servers") {
        return sendJson(res, 200, { success: true, updatedAt: cache.servers.updatedAt, servers: cache.servers.data || [] });
      }
​
      if (route === "GET /api/status") {
        return sendJson(res, 200, {
          success: true,
          tokenSet: Boolean(config.apiToken),
          requestsPerMinute: config.requestsPerMinute,
          minesUpdatedAt: cache.mines.updatedAt,
          eventsUpdatedAt: cache.events.updatedAt,
          serversUpdatedAt: cache.servers.updatedAt,
          lastError: cache.lastError
        });
      }
​
      return sendJson(res, 404, { success: false, error: "Not found" });
    }
​
    /* ---------- Админка ---------- */
    if (route === "GET /admin") {
      return sendHtml(res, 200, adminPage());
    }
​
    if (route === "POST /admin/save") {
      const body = querystring.parse(await readBody(req));
      if (!safeEqual(body.password || "", config.adminPassword)) {
        return sendHtml(res, 403, adminPage("Неверный пароль", true));
      }
      if (body.apiToken) config.apiToken = String(body.apiToken).trim();
      if (body.requestsPerMinute) {
        config.requestsPerMinute = Math.min(Math.max(Number(body.requestsPerMinute) || 100, 1), 600);
      }
      if (body.eventType && ["all", "system", "user"].includes(String(body.eventType).trim())) {
        config.eventType = String(body.eventType).trim();
      }
      if (body.serverType) {
        config.serverType = String(body.serverType).trim();
      }
      if (body.clientRateLimitPerMinute !== undefined && body.clientRateLimitPerMinute !== "") {
        config.clientRateLimitPerMinute = Math.max(Number(body.clientRateLimitPerMinute) || 0, 0);
      }
      if (body.newPassword) config.adminPassword = String(body.newPassword);
      saveConfig();
      startPolling(); // перезапускаем опрос с новыми настройками
      return sendHtml(res, 200, adminPage("Сохранено ✔ Опрос перезапущен с новыми настройками."));
    }
​
    if (route === "GET /") {
      res.writeHead(302, { Location: "/admin" });
      return res.end();
    }
​
    return sendJson(res, 404, { success: false, error: "Not found" });
  } catch (e) {
    return sendJson(res, 500, { success: false, error: e.message });
  }
});
​
/* ===================== СТАРТ ===================== */
​
server.listen(APP_PORT, () => {
  console.log(`FunTime Proxy запущен: http://localhost:${APP_PORT}`);
  console.log(`Админка:               http://localhost:${APP_PORT}/admin`);
  if (!config.apiToken) {
    console.warn("Токен FunTime не задан — задайте его в админке, иначе данные не будут обновляться.");
  }
  startPolling();
});
​
