require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");

const app = express();
const IS_VERCEL = process.env.VERCEL === "1";
const ROOT_DIR = IS_VERCEL ? process.cwd() : __dirname;
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const USE_DATABASE = DATABASE_URL.length > 0;
const ADMIN_KEY = String(process.env.ADMIN_KEY || "").trim();
const ADMIN_ALLOW_REMOTE = String(process.env.ADMIN_ALLOW_REMOTE || (IS_VERCEL ? "true" : "false")).toLowerCase() === "true";
const ADMIN_MAX_ATTEMPTS = Number(process.env.ADMIN_MAX_ATTEMPTS || 5);
const ADMIN_LOCK_MINUTES = Number(process.env.ADMIN_LOCK_MINUTES || 10);
const STATIC_DATA_DIR = path.join(ROOT_DIR, "data");
const DATA_DIR = IS_VERCEL ? path.join("/tmp", "vitalia-data") : STATIC_DATA_DIR;
const APPOINTMENTS_FILE = path.join(DATA_DIR, "appointments.json");
const OFF_BASE_URL = "https://world.openfoodfacts.org/cgi/search.pl";
const adminAttemptTracker = new Map();
const SHOULD_USE_SSL = USE_DATABASE && !/localhost|127\.0\.0\.1/i.test(DATABASE_URL);
const STATIC_ROOT_CANDIDATES = Array.from(
  new Set([
    ROOT_DIR,
    __dirname,
    process.cwd(),
    path.resolve(process.cwd(), "..")
  ])
);

const dbPool = USE_DATABASE
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: SHOULD_USE_SSL ? { rejectUnauthorized: false } : false
    })
  : null;

app.use(express.json({ limit: "200kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(ROOT_DIR));

function resolvePublicFile(relativePath) {
  const cleaned = String(relativePath || "")
    .replace(/^\/+/, "")
    .replace(/\\/g, "/");

  if (!cleaned || cleaned.includes("..")) {
    return null;
  }

  for (const base of STATIC_ROOT_CANDIDATES) {
    const candidate = path.join(base, cleaned);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getTransporterConfig() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || "true").toLowerCase() === "true";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return {
    host,
    port,
    secure,
    auth: { user, pass }
  };
}

function getMailSettings() {
  const transporterConfig = getTransporterConfig();
  if (!transporterConfig) {
    return null;
  }

  return {
    transporter: nodemailer.createTransport(transporterConfig),
    to: process.env.CONTACT_TO || "abraham26mlg@gmail.com",
    from: process.env.CONTACT_FROM || process.env.SMTP_USER
  };
}

async function ensureAppointmentsStore() {
  if (USE_DATABASE) {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        email TEXT NOT NULL,
        telefono TEXT NOT NULL,
        fecha TEXT NOT NULL,
        hora TEXT NOT NULL,
        mensaje TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await dbPool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS appointments_fecha_hora_idx ON appointments (fecha, hora)`
    );
    return;
  }

  await fs.promises.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.promises.access(APPOINTMENTS_FILE, fs.constants.F_OK);
  } catch {
    // Bootstrap with bundled data when available; fallback to empty array.
    const bundledAppointmentsFile = path.join(STATIC_DATA_DIR, "appointments.json");
    try {
      const bundledRaw = await fs.promises.readFile(bundledAppointmentsFile, "utf8");
      await fs.promises.writeFile(APPOINTMENTS_FILE, bundledRaw, "utf8");
    } catch {
      await fs.promises.writeFile(APPOINTMENTS_FILE, "[]", "utf8");
    }
  }
}

function mapDbAppointment(row) {
  return {
    id: row.id,
    nombre: row.nombre,
    email: row.email,
    telefono: row.telefono,
    fecha: row.fecha,
    hora: row.hora,
    mensaje: row.mensaje,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString()
  };
}

async function loadLocalFoodsDatabase() {
  const FOODS_DB_FILE = path.join(STATIC_DATA_DIR, "foods-database.json");
  try {
    const raw = await fs.promises.readFile(FOODS_DB_FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.foods) ? data.foods : [];
  } catch (e) {
    console.warn("No se pudo cargar BD local de alimentos:", e.message);
    return [];
  }
}

async function readAppointments() {
  await ensureAppointmentsStore();

  if (USE_DATABASE) {
    const result = await dbPool.query(
      `SELECT id, nombre, email, telefono, fecha, hora, mensaje, created_at
       FROM appointments
       ORDER BY fecha ASC, hora ASC, created_at ASC`
    );

    return result.rows.map(mapDbAppointment);
  }

  const raw = await fs.promises.readFile(APPOINTMENTS_FILE, "utf8");

  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writeAppointments(appointments) {
  if (USE_DATABASE) {
    throw new Error("writeAppointments no se usa en modo base de datos.");
  }

  await ensureAppointmentsStore();
  await fs.promises.writeFile(APPOINTMENTS_FILE, JSON.stringify(appointments, null, 2), "utf8");
}

async function createAppointment(booking) {
  await ensureAppointmentsStore();

  if (USE_DATABASE) {
    const result = await dbPool.query(
      `INSERT INTO appointments (id, nombre, email, telefono, fecha, hora, mensaje, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, nombre, email, telefono, fecha, hora, mensaje, created_at`,
      [
        booking.id,
        booking.nombre,
        booking.email,
        booking.telefono,
        booking.fecha,
        booking.hora,
        booking.mensaje,
        booking.createdAt
      ]
    );

    return mapDbAppointment(result.rows[0]);
  }

  const appointments = await readAppointments();
  appointments.push(booking);
  await writeAppointments(appointments);
  return booking;
}

async function removeAppointmentById(id) {
  await ensureAppointmentsStore();

  if (USE_DATABASE) {
    const result = await dbPool.query(
      `DELETE FROM appointments
       WHERE id = $1
       RETURNING id, nombre, email, telefono, fecha, hora, mensaje, created_at`,
      [id]
    );

    if (!result.rows[0]) {
      return null;
    }

    return mapDbAppointment(result.rows[0]);
  }

  const appointments = await readAppointments();
  const index = appointments.findIndex((item) => item.id === id);

  if (index === -1) {
    return null;
  }

  const [removed] = appointments.splice(index, 1);
  await writeAppointments(appointments);
  return removed;
}

function isValidDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function isValidTime(time) {
  return /^\d{2}:\d{2}$/.test(time);
}

function normalizeFoodText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array(n + 1).fill(0).map(() => Array(m + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[0][i] = i;
  for (let j = 0; j <= n; j++) dp[j][0] = j;

  for (let j = 1; j <= n; j++) {
    for (let i = 1; i <= m; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j][i] = Math.min(
        dp[j][i - 1] + 1,
        dp[j - 1][i] + 1,
        dp[j - 1][i - 1] + cost
      );
    }
  }

  return dp[n][m];
}

function fuzzyMatchScore(query, target) {
  const q = normalizeFoodText(query);
  const t = normalizeFoodText(target);
  
  if (q === t) return 100;
  
  const qWords = q.split(/\s+/).filter(Boolean);
  const tWords = t.split(/\s+/).filter(Boolean);
  
  let maxWordSimilarity = 0;
  for (const qWord of qWords) {
    for (const tWord of tWords) {
      const dist = levenshteinDistance(qWord, tWord);
      const maxLen = Math.max(qWord.length, tWord.length);
      const similarity = Math.max(0, 100 - (dist / maxLen) * 100);
      maxWordSimilarity = Math.max(maxWordSimilarity, similarity);
      
      if (tWord.includes(qWord) || qWord.includes(tWord)) {
        return Math.max(maxWordSimilarity, similarity + 25);
      }
    }
  }
  
  if (t.includes(q)) return maxWordSimilarity + 40;
  if (q.includes(t)) return maxWordSimilarity + 30;
  
  const dist = levenshteinDistance(q, t);
  const maxLen = Math.max(q.length, t.length);
  const fullSimilarity = Math.max(0, 100 - (dist / maxLen) * 100);
  
  return Math.max(maxWordSimilarity, fullSimilarity);
}

function hasTokenContainment(query, target) {
  const q = normalizeFoodText(query);
  const t = normalizeFoodText(target);
  if (!q || !t) {
    return false;
  }

  const qWords = q.split(/\s+/).filter(Boolean);
  const tWords = t.split(/\s+/).filter(Boolean);

  return qWords.some((qWord) =>
    tWords.some((tWord) => tWord.includes(qWord) || qWord.includes(tWord))
  );
}

function isAcceptableFuzzyMatch(query, target, score) {
  const q = normalizeFoodText(query);
  const t = normalizeFoodText(target);
  if (!q || !t) {
    return false;
  }

  const minBaseScore = 70;
  if (score < minBaseScore) {
    return false;
  }

  if (hasTokenContainment(q, t)) {
    return true;
  }

  // For short single-word queries, be stricter to avoid absurd matches.
  const isShortSingleWord = q.length <= 5 && !q.includes(" ");
  if (isShortSingleWord) {
    const firstLetterMatches = q[0] === t[0];
    return firstLetterMatches && score >= 82;
  }

  return score >= 76;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function extractFoodMacros(product) {
  const nutriments = product?.nutriments || {};
  const kcal = toNumber(nutriments["energy-kcal_100g"] || nutriments.energy_kcal_100g || nutriments["energy-kcal"]);
  const p = toNumber(nutriments.proteins_100g || nutriments.proteins);
  const c = toNumber(nutriments.carbohydrates_100g || nutriments.carbohydrates);
  const f = toNumber(nutriments.fat_100g || nutriments.fat);

  if (kcal <= 0 && p <= 0 && c <= 0 && f <= 0) {
    return null;
  }

  const name = String(product.product_name || product.generic_name || "").trim();
  if (!name) {
    return null;
  }

  return {
    id: String(product.code || `${name}-${Math.random()}`).trim(),
    name,
    kcal,
    p,
    c,
    f
  };
}

async function searchOpenFoodFacts(query, pageSize) {
  const q = String(query || "").trim();
  if (!q) {
    return [];
  }

  const size = Math.max(1, Math.min(50, Number(pageSize || 24)));
  const url = `${OFF_BASE_URL}?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=${size}&fields=code,product_name,generic_name,nutriments`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("No se pudo conectar con la base global de alimentos.");
  }

  const data = await response.json();
  const products = Array.isArray(data?.products) ? data.products : [];

  return products
    .map(extractFoodMacros)
    .filter(Boolean);
}

function macrosForGrams(food, grams) {
  const factor = grams / 100;
  return {
    kcal: food.kcal * factor,
    p: food.p * factor,
    c: food.c * factor,
    f: food.f * factor
  };
}

function equivalentGrams(sourceFood, grams, targetFood) {
  const source = macrosForGrams(sourceFood, grams);
  const sourceVector = [source.kcal, source.p, source.c, source.f];
  const targetVector = [targetFood.kcal, targetFood.p, targetFood.c, targetFood.f];
  const dot = sourceVector.reduce((acc, item, idx) => acc + item * targetVector[idx], 0);
  const norm = targetVector.reduce((acc, item) => acc + item * item, 0);
  if (norm <= 0) {
    return 0;
  }

  return Math.max(1, (dot / norm) * 100);
}

function similarityScore(sourceMacros, targetMacros) {
  const keys = ["kcal", "p", "c", "f"];
  const penalty = keys.reduce((acc, key) => {
    const base = Math.max(1, sourceMacros[key]);
    return acc + Math.abs(sourceMacros[key] - targetMacros[key]) / base;
  }, 0);

  return Math.max(0, Math.round(100 - penalty * 25));
}

function getDominantMacro(food) {
  const pairs = [
    { key: "p", value: toNumber(food?.p) },
    { key: "c", value: toNumber(food?.c) },
    { key: "f", value: toNumber(food?.f) }
  ].sort((a, b) => b.value - a.value);

  return pairs[0]?.key || "c";
}

function getFoodFamilyByName(name) {
  const n = normalizeFoodText(name);
  if (!n) {
    return "";
  }

  if (/(arroz|pasta|patata|pan|avena|cereal|muesli|quinoa|trigo)/.test(n)) {
    return "carbo";
  }

  if (/(pollo|pavo|atun|huevo|salmon|ternera|cerdo|tofu|queso|yogur|lomo|jamon)/.test(n)) {
    return "proteina";
  }

  if (/(aceite|aguacate|nuez|fruto seco|cacahuete|mantequilla|almendra|avellana)/.test(n)) {
    return "grasa";
  }

  if (/(kale|col rizada|berza|espinaca|acelga|canonigo|canonik|repollo|coliflor|brocoli|lechuga|escarola|rukula|rucula)/.test(n)) {
    return "verdura";
  }

  return "";
}

function guessCategoryTerms(sourceFood) {
  const byMacro = [
    { key: "p", value: sourceFood.p },
    { key: "c", value: sourceFood.c },
    { key: "f", value: sourceFood.f }
  ].sort((a, b) => b.value - a.value)[0]?.key;

  if (byMacro === "p") {
    return ["pollo", "pavo", "atun", "huevo", "tofu"];
  }
  if (byMacro === "c") {
    return ["arroz", "pasta", "patata", "pan", "avena"];
  }

  return ["aguacate", "aceite", "frutos secos", "queso", "cacahuete"];
}

function isFutureDateTime(date, time) {
  const dateTime = new Date(`${date}T${time}:00`);
  return Number.isFinite(dateTime.getTime()) && dateTime.getTime() > Date.now();
}

function isWithinBookableHours(date, time) {
  const day = new Date(`${date}T00:00:00`).getDay();
  if (day === 0 || day === 6) {
    return false;
  }

  const allowed = new Set([
    "09:00",
    "10:00",
    "11:00",
    "12:00",
    "13:00",
    "16:00",
    "17:00",
    "18:00",
    "19:00"
  ]);

  return allowed.has(time);
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (forwarded) {
    return forwarded;
  }

  return String(req.ip || req.socket?.remoteAddress || "").trim();
}

function isLocalIp(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function isAdminLocked(ip) {
  const state = adminAttemptTracker.get(ip);
  if (!state || !state.lockedUntil) {
    return false;
  }

  if (Date.now() > state.lockedUntil) {
    adminAttemptTracker.delete(ip);
    return false;
  }

  return true;
}

function registerAdminFailure(ip) {
  const current = adminAttemptTracker.get(ip) || { attempts: 0, lockedUntil: 0 };
  current.attempts += 1;

  if (current.attempts >= ADMIN_MAX_ATTEMPTS) {
    current.lockedUntil = Date.now() + ADMIN_LOCK_MINUTES * 60 * 1000;
    current.attempts = 0;
  }

  adminAttemptTracker.set(ip, current);
}

function clearAdminFailures(ip) {
  adminAttemptTracker.delete(ip);
}

function isAuthorizedAdmin(req, res) {
  if (!ADMIN_KEY) {
    res.status(500).json({ message: "Admin no configurado en servidor." });
    return false;
  }

  const clientIp = getClientIp(req);
  if (!ADMIN_ALLOW_REMOTE && !isLocalIp(clientIp)) {
    res.status(403).json({ message: "Acceso admin permitido solo desde IP local." });
    return false;
  }

  if (isAdminLocked(clientIp)) {
    res.status(429).json({ message: "Demasiados intentos fallidos. Espera unos minutos." });
    return false;
  }

  const candidate = String(req.headers["x-admin-key"] || "").trim();
  if (candidate.length > 0 && candidate === ADMIN_KEY) {
    clearAdminFailures(clientIp);
    return true;
  }

  registerAdminFailure(clientIp);
  res.status(401).json({ message: "No autorizado." });
  return false;
}

app.post("/api/contact", async (req, res) => {
  const nombre = String(req.body?.nombre || "").trim();
  const email = String(req.body?.email || "").trim();
  const telefono = String(req.body?.telefono || "").trim();
  const objetivo = String(req.body?.objetivo || "").trim();
  const mensaje = String(req.body?.mensaje || "").trim();
  const website = String(req.body?.website || "").trim();

  // Honeypot anti-spam: if filled, pretend success without processing.
  if (website) {
    return res.status(200).json({ message: "Gracias. Hemos recibido tu solicitud." });
  }

  if (!nombre || !email || !objetivo || !mensaje) {
    return res.status(400).json({ message: "Faltan campos obligatorios." });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ message: "El email no es valido." });
  }

  const mailSettings = getMailSettings();
  if (!mailSettings) {
    return res.status(500).json({
      message: "El servidor no tiene configurado SMTP todavia."
    });
  }

  const { transporter, to, from } = mailSettings;

  const safeNombre = escapeHtml(nombre);
  const safeEmail = escapeHtml(email);
  const safeTelefono = escapeHtml(telefono || "No indicado");
  const safeObjetivo = escapeHtml(objetivo);
  const safeMensaje = escapeHtml(mensaje).replace(/\n/g, "<br>");

  const mailOptions = {
    from,
    to,
    replyTo: email,
    subject: `Nuevo contacto web - ${safeNombre}`,
    text:
      `Nuevo formulario de contacto\n\n` +
      `Nombre: ${nombre}\n` +
      `Email: ${email}\n` +
      `Telefono: ${telefono || "No indicado"}\n` +
      `Objetivo: ${objetivo}\n\n` +
      `Mensaje:\n${mensaje}`,
    html:
      `<h2>Nuevo formulario de contacto</h2>` +
      `<p><strong>Nombre:</strong> ${safeNombre}</p>` +
      `<p><strong>Email:</strong> ${safeEmail}</p>` +
      `<p><strong>Telefono:</strong> ${safeTelefono}</p>` +
      `<p><strong>Objetivo:</strong> ${safeObjetivo}</p>` +
      `<p><strong>Mensaje:</strong><br>${safeMensaje}</p>`
  };

  try {
    await transporter.sendMail(mailOptions);
    return res.status(200).json({ message: "Formulario enviado. Te responderemos pronto." });
  } catch (error) {
    console.error("Error enviando correo:", error);
    return res.status(500).json({ message: "No se pudo enviar el formulario en este momento." });
  }
});

app.get("/api/foods/swap", async (req, res) => {
  const foodName = String(req.query?.food || "").trim();
  const grams = Number(req.query?.grams || 0);

  if (!foodName || !Number.isFinite(grams) || grams <= 0) {
    return res.status(400).json({ message: "Indica alimento y cantidad validos." });
  }

  try {
    const allFoods = await loadLocalFoodsDatabase();
    if (allFoods.length === 0) {
      return res.status(500).json({ message: "Base de datos de alimentos no disponible." });
    }

    // FASE 1: Buscar coincidencias exactas (normalizadas)
    const normalizedInput = normalizeFoodText(foodName);
    const exactMatches = allFoods.filter((item) => 
      normalizeFoodText(item.name) === normalizedInput
    );

    let source = null;

    // Si encontramos coincidencias exactas, usar la primera
    if (exactMatches.length > 0) {
      source = exactMatches[0];
    } else {
      // FASE 2: Si no hay exactas, buscar por similitud fuzzy (como antes)
      const matches = allFoods.map((item) => ({
        food: item,
        score: fuzzyMatchScore(foodName, item.name)
      })).sort((a, b) => b.score - a.score);

      const bestMatch = matches[0];

      if (bestMatch && isAcceptableFuzzyMatch(foodName, bestMatch.food.name, bestMatch.score)) {
        source = matches[0].food;
      } else {
        // Score too low: friendly rejection message
        return res.status(404).json({ 
          message: "Lo sentimos, no hemos añadido ese alimento todavía a la base de datos, pero nos ponemos en marcha.",
          suggestedSearch: `Intenta con otro nombre o busca un alimento similar a "${foodName}".`
        });
      }
    }
    
    if (!source) {
      return res.status(404).json({ message: `No encontramos alimentos similares a "${foodName}". Intenta con otro nombre.` });
    }

    const candidates = allFoods.filter((item) => {
      const sameId = item.id === source.id;
      const sameName = normalizeFoodText(item.name) === normalizeFoodText(source.name);
      return !sameId && !sameName;
    });

    if (candidates.length === 0) {
      return res.status(404).json({ message: "No hay alternativas disponibles en la base de datos." });
    }

    const sourceMacros = macrosForGrams(source, grams);
    const sourceMacro = getDominantMacro(source);
    const sourceFamily = getFoodFamilyByName(source.name) || getFoodFamilyByName(foodName);

    let filteredCandidates = candidates.filter((item) => {
      const targetFamily = getFoodFamilyByName(item.name);
      if (sourceFamily && targetFamily) {
        return sourceFamily === targetFamily;
      }
      return getDominantMacro(item) === sourceMacro;
    });

    if (filteredCandidates.length === 0) {
      filteredCandidates = candidates.filter((item) => getDominantMacro(item) === sourceMacro);
    }

    if (filteredCandidates.length === 0) {
      filteredCandidates = candidates;
    }

    let alternatives = [];

    // Rango de gramajes aceptables: entre 0.4x y 2.5x del original
    const minGrams = grams * 0.4;
    const maxGrams = grams * 2.5;

    filteredCandidates.forEach((item) => {
      const eq = equivalentGrams(source, grams, item);
      if (!Number.isFinite(eq) || eq <= 0) {
        return;
      }

      // Filtro: rechazar si está fuera del rango de gramajes razonable
      if (eq < minGrams || eq > maxGrams) {
        return;
      }

      const targetMacros = macrosForGrams(item, eq);
      const score = similarityScore(sourceMacros, targetMacros);

      alternatives.push({
        food: item,
        grams: Math.round(eq),
        score,
        macros: targetMacros
      });
    });

    if (alternatives.length === 0) {
      return res.status(404).json({ message: "No encontramos una equivalencia util." });
    }

    alternatives.sort((a, b) => b.score - a.score);
    const top3 = alternatives.slice(0, 3);
    const recommended = top3.filter((item) => item.score >= 80);

    if (recommended.length === 0) {
      return res.status(404).json({
        message: "No encontramos sustituciones recomendadas con similitud nutricional suficiente."
      });
    }

    return res.status(200).json({
      substitutions: recommended.map((item) => ({
        food: item.food.name,
        grams: item.grams,
        nutritionalSimilarityApprox: item.score
      }))
    });
  } catch (error) {
    console.error("Error buscando alimentos globales:", error);
    return res.status(500).json({ message: "No se pudo consultar la base global de alimentos." });
  }
});

app.get("/api/appointments", async (req, res) => {
  const from = String(req.query?.from || "").trim();
  const to = String(req.query?.to || "").trim();

  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ message: "Rango de fechas no valido." });
  }

  try {
    const appointments = await readAppointments();
    const filtered = appointments.filter((item) => item.fecha >= from && item.fecha <= to);
    return res.status(200).json({ appointments: filtered });
  } catch (error) {
    console.error("Error leyendo citas:", error);
    return res.status(500).json({ message: "No se pudo consultar el calendario." });
  }
});

app.post("/api/appointments", async (req, res) => {
  const nombre = String(req.body?.nombre || "").trim();
  const email = String(req.body?.email || "").trim();
  const telefono = String(req.body?.telefono || "").trim();
  const fecha = String(req.body?.fecha || "").trim();
  const hora = String(req.body?.hora || "").trim();
  const mensaje = String(req.body?.mensaje || "").trim();
  const website = String(req.body?.website || "").trim();

  if (website) {
    return res.status(200).json({ message: "Solicitud recibida." });
  }

  if (!nombre || !email || !fecha || !hora) {
    return res.status(400).json({ message: "Faltan campos obligatorios para reservar." });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ message: "El email no es valido." });
  }

  if (!isValidDate(fecha) || !isValidTime(hora)) {
    return res.status(400).json({ message: "Fecha u hora no validas." });
  }

  if (!isWithinBookableHours(fecha, hora)) {
    return res.status(400).json({ message: "Ese horario no esta disponible para reserva." });
  }

  if (!isFutureDateTime(fecha, hora)) {
    return res.status(400).json({ message: "Solo puedes reservar citas futuras." });
  }

  try {
    const mailSettings = getMailSettings();

    let exists = false;
    if (USE_DATABASE) {
      await ensureAppointmentsStore();
      const checkResult = await dbPool.query(
        `SELECT 1 FROM appointments WHERE fecha = $1 AND hora = $2 LIMIT 1`,
        [fecha, hora]
      );
      exists = checkResult.rowCount > 0;
    } else {
      const appointments = await readAppointments();
      exists = appointments.some((item) => item.fecha === fecha && item.hora === hora);
    }

    if (exists) {
      return res.status(409).json({ message: "Ese horario ya ha sido reservado." });
    }

    const booking = {
      id: `${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      nombre,
      email,
      telefono,
      fecha,
      hora,
      mensaje,
      createdAt: new Date().toISOString()
    };

    const storedBooking = await createAppointment(booking);

    const safeNombre = escapeHtml(nombre);
    const safeEmail = escapeHtml(email);
    const safeTelefono = escapeHtml(telefono || "No indicado");
    const safeFecha = escapeHtml(fecha);
    const safeHora = escapeHtml(hora);
    const safeMensaje = escapeHtml(mensaje || "Sin mensaje adicional").replace(/\n/g, "<br>");

    if (mailSettings) {
      await mailSettings.transporter.sendMail({
        from: mailSettings.from,
        to: mailSettings.to,
        replyTo: email,
        subject: `Nueva cita reservada - ${safeNombre} (${safeFecha} ${safeHora})`,
        text:
          `Nueva cita reservada\n\n` +
          `Nombre: ${nombre}\n` +
          `Email: ${email}\n` +
          `Telefono: ${telefono || "No indicado"}\n` +
          `Fecha: ${fecha}\n` +
          `Hora: ${hora}\n\n` +
          `Mensaje:\n${mensaje || "Sin mensaje adicional"}`,
        html:
          `<h2>Nueva cita reservada</h2>` +
          `<p><strong>Nombre:</strong> ${safeNombre}</p>` +
          `<p><strong>Email:</strong> ${safeEmail}</p>` +
          `<p><strong>Telefono:</strong> ${safeTelefono}</p>` +
          `<p><strong>Fecha:</strong> ${safeFecha}</p>` +
          `<p><strong>Hora:</strong> ${safeHora}</p>` +
          `<p><strong>Mensaje:</strong><br>${safeMensaje}</p>`
      });
      return res.status(201).json({ message: "Cita reservada correctamente.", booking: storedBooking });
    }

    return res.status(201).json({
      message: "Cita reservada correctamente (sin notificacion por email).",
      booking: storedBooking
    });
  } catch (error) {
    console.error("Error guardando cita:", error);
    return res.status(500).json({ message: "No se pudo guardar la cita en este momento." });
  }
});

app.get("/api/admin/appointments", async (req, res) => {
  if (!isAuthorizedAdmin(req, res)) {
    return;
  }

  try {
    const appointments = await readAppointments();
    const sorted = [...appointments].sort((a, b) => {
      const ak = `${a.fecha} ${a.hora}`;
      const bk = `${b.fecha} ${b.hora}`;
      return ak.localeCompare(bk);
    });
    return res.status(200).json({ appointments: sorted });
  } catch (error) {
    console.error("Error listando citas admin:", error);
    return res.status(500).json({ message: "No se pudo listar las citas." });
  }
});

app.delete("/api/admin/appointments/:id", async (req, res) => {
  if (!isAuthorizedAdmin(req, res)) {
    return;
  }

  const id = String(req.params?.id || "").trim();
  if (!id) {
    return res.status(400).json({ message: "Id de cita no valido." });
  }

  try {
    const removed = await removeAppointmentById(id);

    if (!removed) {
      return res.status(404).json({ message: "La cita no existe o ya fue cancelada." });
    }

    return res.status(200).json({
      message: "Cita cancelada correctamente.",
      cancelled: removed
    });
  } catch (error) {
    console.error("Error cancelando cita admin:", error);
    return res.status(500).json({ message: "No se pudo cancelar la cita." });
  }
});

app.get("/", (req, res) => {
  const indexFile = resolvePublicFile("paginadesalud.html");
  if (!indexFile) {
    return res.status(404).send("No se encontro la portada.");
  }
  res.sendFile(indexFile);
});

app.get(/^\/.*\.html$/, (req, res) => {
  const file = resolvePublicFile(req.path);
  if (!file) {
    return res.status(404).send("Pagina no encontrada.");
  }
  res.sendFile(file);
});

if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => {
    console.log(`Servidor activo en http://localhost:${PORT}`);
  });
}

module.exports = app;
