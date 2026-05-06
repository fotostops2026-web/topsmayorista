require("dotenv").config();
const express  = require("express");
const cheerio  = require("cheerio");
const fs       = require("fs");
const path     = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── CONFIGURACIÓN ──────────────────────────────────────────────────────────────
const STORE_URL    = process.env.STORE_URL    || "https://tops19.mitiendanube.com";
const TN_STORE_ID  = process.env.TN_STORE_ID  || "";
const TN_TOKEN     = process.env.TN_TOKEN     || "";
const ADMIN_PASS   = process.env.ADMIN_PASS   || "admin2026";
const CATALOG_PASS = process.env.CATALOG_PASS || "tops2026";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

const PRICES_FILE     = path.join(__dirname, "prices.json");
const CONDITIONS_FILE = path.join(__dirname, "conditions.json");
const CACHE_FILE      = path.join(__dirname, "products-cache.json");

// ── UPSTASH REDIS (persistencia en producción) ─────────────────────────────────
// Usa Redis si hay credenciales, sino usa archivos locales
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

async function redisGet(key) {
  if (!REDIS_URL) return null;
  try {
    const res  = await fetch(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const data = await res.json();
    if (data.result === null || data.result === undefined) return null;
    const parsed = JSON.parse(data.result);
    // Si era un string (datos viejos con doble encode), parsear de nuevo
    if (typeof parsed === "string") {
      try { return JSON.parse(parsed); } catch { return parsed; }
    }
    return parsed;
  } catch { return null; }
}

async function redisSet(key, value) {
  if (!REDIS_URL) return;
  try {
    await fetch(`${REDIS_URL}/set/${key}`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body:    JSON.stringify(value),
    });
  } catch { /* silencioso */ }
}

// ── HELPERS ARCHIVO/REDIS ──────────────────────────────────────────────────────
function loadFile(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function saveFile(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8"); }
  catch { /* en producción el FS puede ser de solo lectura */ }
}

async function loadData(redisKey, file, fallback = {}) {
  if (REDIS_URL) {
    const val = await redisGet(redisKey);
    if (val !== null) return val;
  }
  return loadFile(file, fallback);
}

async function saveData(redisKey, file, data) {
  saveFile(file, data);           // siempre guarda localmente
  await redisSet(redisKey, data); // y en Redis si está disponible
}

function parsePriceARS(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[.$]/g, "").replace(",", ".")) || 0;
}

// ── TIENDANUBE API ─────────────────────────────────────────────────────────────
async function fetchFromAPI() {
  const all = [];
  let page  = 1;
  while (true) {
    const res = await fetch(
      `https://api.tiendanube.com/v1/${TN_STORE_ID}/products?per_page=200&page=${page}`,
      { headers: { Authentication: `bearer ${TN_TOKEN}`, "User-Agent": "Tops Mayorista App" } }
    );
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    data.forEach((p) => {
      const attributes = p.attributes || [];
      const colorIdx   = attributes.findIndex((a) => (a.es || "").toLowerCase().includes("color"));
      const sizeIdx    = attributes.findIndex((a) => {
        const n = (a.es || "").toLowerCase();
        return n.includes("talle") || n.includes("talla") || n.includes("size");
      });
      const colors = [...new Set((p.variants || []).map((v) => colorIdx >= 0 ? v.values?.[colorIdx]?.es : null).filter(Boolean))];
      const sizes  = [...new Set((p.variants || []).map((v) => sizeIdx  >= 0 ? v.values?.[sizeIdx]?.es  : null).filter(Boolean))]
        .sort((a, b) => { const na = parseFloat(a), nb = parseFloat(b); return !isNaN(na) && !isNaN(nb) ? na - nb : a.localeCompare(b); });

      const images = (p.images || []).map(img => img.src).filter(Boolean);
      // Mapa color → imagen desde variantes de la API
      const colorImages = {};
      (p.variants || []).forEach(v => {
        const color = colorIdx >= 0 ? v.values?.[colorIdx]?.es : null;
        const imgSrc = v.image?.src || images[0] || "";
        if (color && imgSrc && !colorImages[color]) colorImages[color] = imgSrc;
      });
      all.push({
        id:    String(p.id),
        name:  p.name?.es || p.name?.[Object.keys(p.name || {})[0]] || "Producto",
        image:  images[0] || "",
        images: images,
        colorImages,
        retailPrice: parseFloat(p.variants?.[0]?.price || p.price || 0),
        colors: colors.length ? colors : ["Único"],
        sizes:  sizes.length  ? sizes  : ["Único"],
      });
    });
    if (data.length < 200) break;
    page++;
  }
  return all;
}

// ── SCRAPING ──────────────────────────────────────────────────────────────────
async function fetchPage(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; TopsBot/1.0)" } });
  return res.text();
}

async function scrapeProductDetail(url) {
  try {
    const html = await fetchPage(url);
    const $    = cheerio.load(html);
    const result = { colors: [], sizes: [], colorImages: {}, image: "", images: [], retailPrice: 0 };

    // Extraer colores, talles e imágenes por color directo de LS.variants
    // Cada variante tiene: option0 (color), option1 (talle), image_url (foto del color)
    const variantRegex = /"option0"\s*:\s*"([^"]+)"[^}]*?"option1"\s*:\s*"?([^",}]+)"?[^}]*?"image_url"\s*:\s*"([^"]+)"/g;
    let match;
    while ((match = variantRegex.exec(html)) !== null) {
      const color    = match[1];
      const size     = match[2];
      const imageUrl = "https:" + match[3].replace(/\\/g, "");
      if (color) {
        result.colors.push(color);
        if (!result.colorImages[color]) result.colorImages[color] = imageUrl;
      }
      if (size && !isNaN(parseFloat(size))) result.sizes.push(size);
    }

    // Fallback: og:image como imagen principal
    const ogImage = $('meta[property="og:image"]').attr("content") || "";
    if (ogImage && !ogImage.startsWith("data:")) result.image = ogImage;

    // Imagen principal = primera del colorImages o og:image
    const firstColorImg = Object.values(result.colorImages)[0];
    result.image  = firstColorImg || result.image;
    result.images = Object.values(result.colorImages);

    // Precio
    const priceContent = $("[itemprop='price']").first().attr("content");
    const priceText    = $(".product-price, .js-price-display, .price").first().text().trim();
    result.retailPrice = parseFloat(priceContent) || parsePriceARS(priceText);

    // SKU
    let sku = "";
    const varSkuMatch = html.match(/LS\.variants\s*=\s*\[[\s\S]*?"sku"\s*:\s*"([^"]+)"/);
    if (varSkuMatch) {
      const raw = varSkuMatch[1];
      sku = raw.replace(/\/(i|v)\d+.*$/i, "").replace(/\*.*$/, "").trim();
    }
    result.sku = sku;

    result.colors = [...new Set(result.colors)];
    result.sizes  = [...new Set(result.sizes)].sort((a, b) => {
      const na = parseFloat(a), nb = parseFloat(b);
      return !isNaN(na) && !isNaN(nb) ? na - nb : a.localeCompare(b);
    });
    return result;
  } catch {
    return { colors: [], sizes: [], image: "", retailPrice: 0 };
  }
}

async function scrapeAllProducts() {
  const products = [];
  let page = 1;
  while (page <= 10) {
    const url  = `${STORE_URL}/productos/?page=${page}`;
    const html = await fetchPage(url);
    const $    = cheerio.load(html);
    const items = [];

    $("[data-product-id], .js-item-product, .item-list .item").each((_, el) => {
      const $el  = $(el);
      const id   = $el.attr("data-product-id") || $el.find("[data-product-id]").attr("data-product-id");
      const name = $el.find(".item-name, .js-item-name, h2, h3").first().text().trim();
      const href = $el.find("a").first().attr("href");
      if (!name || !id) return;
      items.push({ id: String(id), name, href: href?.startsWith("http") ? href : `${STORE_URL}${href}` });
    });

    if (items.length === 0) break;

    for (const item of items) {
      const detail = await scrapeProductDetail(item.href);
      products.push({
        id:          item.id,
        name:        item.name,
        sku:         detail.sku || "",
        image:       detail.image,
        images:      detail.images.length ? detail.images : (detail.image ? [detail.image] : []),
        colorImages: detail.colorImages || {},
        retailPrice: detail.retailPrice,
        colors:      detail.colors.length ? detail.colors : ["Único"],
        sizes:       detail.sizes.length  ? detail.sizes  : ["Único"],
      });
    }

    const hasNext = $(".next, .pagination-next, [rel='next']").length > 0;
    if (!hasNext) break;
    page++;
  }
  return products;
}

// ── CACHE DE PRODUCTOS ─────────────────────────────────────────────────────────
async function getProducts(forceRefresh = false) {
  const cache = await loadData("products_cache", CACHE_FILE, { ts: 0, data: [] });

  if (!forceRefresh && Date.now() - (cache.ts || 0) < CACHE_TTL_MS && (cache.data || []).length > 0) {
    return cache.data;
  }

  let products;
  if (TN_STORE_ID && TN_TOKEN) {
    console.log("Sincronizando vía API de Tiendanube...");
    products = await fetchFromAPI();
  } else {
    console.log("Sincronizando vía scraping...");
    products = await scrapeAllProducts();
  }

  await saveData("products_cache", CACHE_FILE, { ts: Date.now(), data: products });
  console.log(`✓ ${products.length} productos sincronizados`);
  return products;
}

// ── RUTAS ──────────────────────────────────────────────────────────────────────
app.get("/admin",    (req, res) => res.redirect("/admin.html"));
app.get("/catalogo", (req, res) => res.redirect("/catalogo.html"));

app.post("/api/auth/catalog", (req, res) => {
  if (req.body.password === CATALOG_PASS) return res.json({ ok: true });
  res.status(401).json({ error: "Contraseña incorrecta" });
});

app.post("/api/auth/admin", (req, res) => {
  if (req.body.password === ADMIN_PASS) return res.json({ ok: true });
  res.status(401).json({ error: "Contraseña incorrecta" });
});

app.get("/api/products", async (req, res) => {
  try {
    const [cache, prices] = await Promise.all([
      loadData("products_cache", CACHE_FILE, { ts: 0, data: [] }),
      loadData("prices", PRICES_FILE, {}),
    ]);

    const cached   = cache.data || [];
    const isStale  = Date.now() - (cache.ts || 0) >= CACHE_TTL_MS;
    const isEmpty  = cached.length === 0;

    // Si hay datos en caché, los devolvemos INMEDIATAMENTE (aunque estén vencidos)
    if (!isEmpty) {
      res.json(cached.map((p) => ({ ...p, wholesalePrice: prices[p.id] ?? null })));
      // Si el caché está vencido, actualizamos en el fondo sin bloquear al cliente
      if (isStale) {
        getProducts(true).catch((e) => console.warn("Background sync failed:", e.message));
      }
      return;
    }

    // Solo si no hay nada en caché esperamos la sincronización (primer arranque)
    const products = await getProducts();
    res.json(products.map((p) => ({ ...p, wholesalePrice: prices[p.id] ?? null })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener productos" });
  }
});

app.get("/api/prices", async (req, res) => {
  res.json(await loadData("prices", PRICES_FILE, {}));
});

app.post("/api/prices", async (req, res) => {
  const { password, prices } = req.body;
  if (password !== ADMIN_PASS) return res.status(401).json({ error: "Sin autorización" });
  if (!prices || typeof prices !== "object") return res.status(400).json({ error: "Datos inválidos" });
  await saveData("prices", PRICES_FILE, prices);
  res.json({ ok: true });
});

app.get("/api/conditions", async (req, res) => {
  res.json(await loadData("conditions", CONDITIONS_FILE, {}));
});

app.post("/api/conditions", async (req, res) => {
  const { password, conditions } = req.body;
  if (password !== ADMIN_PASS) return res.status(401).json({ error: "Sin autorización" });
  await saveData("conditions", CONDITIONS_FILE, conditions);
  res.json({ ok: true });
});

// Proxy de imágenes para html2canvas (evita CORS con CDN de Tiendanube)
app.get("/api/img", async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith("http")) return res.status(400).end();
  try {
    const r = await fetch(url);
    const buf = await r.arrayBuffer();
    res.setHeader("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(buf));
  } catch { res.status(500).end(); }
});

app.post("/api/sync", async (req, res) => {
  if (req.body.password !== ADMIN_PASS) return res.status(401).json({ error: "Sin autorización" });
  try {
    const products = await getProducts(true);
    res.json({ ok: true, count: products.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ARRANQUE ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n✅ Tops Mayorista corriendo en http://localhost:${PORT}`);
  console.log(`   Catálogo: http://localhost:${PORT}/`);
  console.log(`   Admin:    http://localhost:${PORT}/admin.html`);
  console.log(`   Redis:    ${REDIS_URL ? "✓ conectado" : "✗ usando archivos locales"}\n`);
  try { await getProducts(); } catch (e) { console.warn("No se pudo pre-cargar productos:", e.message); }
});
