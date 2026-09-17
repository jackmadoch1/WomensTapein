import { createHash } from "node:crypto";

const TZ = "America/Chicago";
const MAX_VISITS = 120;
const MAX_PHOTO = 350_000;
const STORE = "site:atr-tracker";
const KEY = "state";

function hashPassword(password) {
  return createHash("sha256").update(String(password)).digest("hex");
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function chicagoDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function weekStartMonday(d = new Date()) {
  const ymd = chicagoDate(d);
  const [y, m, day] = ymd.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, day, 12));
  const dow = utc.getUTCDay();
  utc.setUTCDate(utc.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return utc.toISOString().slice(0, 10);
}

function pruneBefore() {
  const start = weekStartMonday();
  const [y, m, d] = start.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d, 12));
  utc.setUTCDate(utc.getUTCDate() - 14);
  return utc.toISOString().slice(0, 10);
}

function hasPhoto(visit) {
  return Boolean(visit?.hasPhoto || (visit?.photo && String(visit.photo).startsWith("data:image/")));
}

function publicState(state) {
  const week = weekStartMonday();
  return {
    users: (state.users || []).map((u) => ({ id: u.id, name: u.name })),
    visits: (state.visits || [])
      .filter((v) => v.weekStart === week)
      .map((v) => ({
        id: v.id,
        userId: v.userId,
        name: v.name,
        note: v.note || "",
        hasPhoto: hasPhoto(v),
        photo: null,
        createdAt: v.createdAt,
        weekStart: v.weekStart,
        yes: Array.isArray(v.yes) ? v.yes : [],
        no: Array.isArray(v.no) ? v.no : [],
        status: v.status === "approved" ? "approved" : "pending",
      })),
  };
}

function blobsContext(event) {
  if (!event?.blobs) throw new Error("Missing blobs context");
  const data = JSON.parse(Buffer.from(event.blobs, "base64").toString("utf8"));
  const headers = event.headers || {};
  const siteID = headers["x-nf-site-id"] || headers["X-Nf-Site-Id"];
  const token = data.token;
  const edgeURL = data.url;
  if (!siteID || !token || !edgeURL) throw new Error("Incomplete blobs context");
  return { siteID, token, edgeURL };
}

function blobUrl(ctx, key) {
  const base = ctx.edgeURL.endsWith("/") ? ctx.edgeURL : `${ctx.edgeURL}/`;
  return new URL(`${ctx.siteID}/${STORE}/${key}`, base).toString();
}

async function readJson(ctx, key) {
  const res = await fetch(blobUrl(ctx, key), {
    headers: { authorization: `Bearer ${ctx.token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not read board (${res.status}).`);
  return res.json();
}

async function writeJson(ctx, key, value) {
  const res = await fetch(blobUrl(ctx, key), {
    method: "PUT",
    headers: {
      authorization: `Bearer ${ctx.token}`,
      "content-type": "application/json",
      "cache-control": "max-age=0, stale-while-revalidate=60",
    },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`Could not save board (${res.status}).`);
}

async function load(ctx) {
  const data = await readJson(ctx, KEY);
  if (!data || typeof data !== "object") return { users: [], visits: [] };
  return {
    users: Array.isArray(data.users) ? data.users : [],
    visits: Array.isArray(data.visits) ? data.visits : [],
  };
}

async function extractPhotos(ctx, state) {
  const cutoff = pruneBefore();
  const visits = [];
  for (const v of state.visits || []) {
    if (v.weekStart && v.weekStart < cutoff) continue;
    if (v.photo && String(v.photo).startsWith("data:image/")) {
      try {
        await writeJson(ctx, `photo-${v.id}`, { photo: v.photo });
        v.hasPhoto = true;
      } catch {
        v.hasPhoto = true;
      }
      v.photo = null;
    }
    visits.push(v);
  }
  state.visits = visits.slice(0, MAX_VISITS);
  return state;
}

async function save(ctx, state) {
  await writeJson(ctx, KEY, await extractPhotos(ctx, state));
}

function applyOp(state, body) {
  const op = body?.op;
  if (op === "signup") {
    const name = String(body.name || "").trim();
    const password = String(body.password || "");
    if (name.length < 2) return { error: "Enter your name." };
    if (password.length < 4) return { error: "Password must be at least 4 characters." };
    if (state.users.some((u) => u.name.toLowerCase() === name.toLowerCase())) {
      return { error: "That name is already taken. Sign in instead." };
    }
    const user = { id: uid(), name, passwordHash: hashPassword(password) };
    state.users.push(user);
    return { state, sessionId: user.id, mutated: true };
  }
  if (op === "signin") {
    const name = String(body.name || "").trim();
    const password = String(body.password || "");
    const user = state.users.find((u) => u.name.toLowerCase() === name.toLowerCase());
    if (!user || user.passwordHash !== hashPassword(password)) {
      return { error: "Name or password is wrong." };
    }
    return { state, sessionId: user.id, mutated: false };
  }
  if (op === "checkin") {
    const user = state.users.find((u) => u.id === body.userId);
    if (!user) return { error: "Sign in again." };
    const note = String(body.note || "").trim().slice(0, 280);
    const photo = body.photo ? String(body.photo) : "";
    if (photo && (photo.length > MAX_PHOTO || !photo.startsWith("data:image/"))) {
      return { error: "That photo is too large or not supported." };
    }
    const visit = {
      id: uid(),
      userId: user.id,
      name: user.name,
      note,
      photo: photo || null,
      hasPhoto: Boolean(photo),
      createdAt: new Date().toISOString(),
      weekStart: weekStartMonday(),
      yes: [],
      no: [],
      status: "pending",
    };
    state.visits.unshift(visit);
    return { state, sessionId: user.id, mutated: true };
  }
  if (op === "vote") {
    const user = state.users.find((u) => u.id === body.userId);
    const visit = state.visits.find((v) => v.id === body.visitId);
    const choice = body.choice === "no" ? "no" : body.choice === "yes" ? "yes" : null;
    if (!user) return { error: "Sign in again." };
    if (!visit) return { error: "Visit not found." };
    if (!choice) return { error: "Choose yes or no." };
    if (visit.userId === user.id) return { error: "You can't confirm your own visit." };
    if (visit.yes.includes(user.id) || visit.no.includes(user.id)) {
      return { error: "You already confirmed this visit." };
    }
    visit[choice].push(user.id);
    if (visit.yes.length >= 2) visit.status = "approved";
    return { state, sessionId: user.id, mutated: true, approved: visit.status === "approved", yesCount: visit.yes.length, choice };
  }
  return { error: "Unknown action." };
}

const cors = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(statusCode, body) {
  return { statusCode, headers: cors, body: JSON.stringify(body) };
}

function query(event) {
  return event.queryStringParameters || {};
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors };
  try {
    const ctx = blobsContext(event);
    const photoId = query(event).photo;
    if (event.httpMethod === "GET" && photoId) {
      const stored = await readJson(ctx, `photo-${photoId}`);
      if (stored?.photo) return json(200, { photo: stored.photo });
      const state = await load(ctx);
      const visit = state.visits.find((v) => v.id === photoId);
      return json(200, { photo: visit?.photo || null });
    }
    if (event.httpMethod === "GET") {
      const state = await load(ctx);
      return json(200, publicState(state));
    }
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "{}";
    const body = JSON.parse(raw);
    const state = await load(ctx);
    const result = applyOp(state, body);
    if (result.error) return json(400, { error: result.error });
    if (result.mutated) {
      try {
        await save(ctx, result.state);
      } catch (err) {
        if (body.op === "signup" || body.op === "checkin") throw err;
      }
    }
    return json(200, {
      ...publicState(result.state),
      sessionId: result.sessionId || null,
      approved: result.approved || false,
      yesCount: result.yesCount || 0,
      choice: result.choice || null,
    });
  } catch (err) {
    return json(500, {
      error: err instanceof Error ? err.message : "Could not update the board.",
    });
  }
}
