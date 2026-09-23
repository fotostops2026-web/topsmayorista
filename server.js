require("dotenv").config();
const express  = require("express");
const cheerio  = require("cheerio");
const fs       = require("fs");
const path     = require("path");

const app = express();
app.set("etag", false);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Evita que cualquier proxy/CDN/navegador cachee las respuestas de la API:
// sin esto, una respuesta vieja (ej. catálogo vacío antes del primer sync)
// puede quedar servida indefinidamente sin volver a llegar al servidor.
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});

// ── CONFIGURACIÓN ──────────────────────────────────────────────────────────────
const STORE_URL    = process.env.STORE_URL    || "https://tops19.mitiendanube.com";
const TN_STORE_ID  = process.env.TN_STORE_ID  || "";
const TN_TOKEN     = process.env.TN_TOKEN     || "";
const ADMIN_PASS   = process.env.ADMIN_PASS   || "admin2026";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora
// Subir este número invalida los cachés guardados con un formato anterior
const CACHE_VERSION = 2;

// Si hay un volumen de Railway montado, los datos persisten ahí entre deploys.
// Sin volumen, se guardan junto al código y se pierden en cada redeploy.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;

const PRICES_FILE     = path.join(DATA_DIR, "prices.json");
const CONDITIONS_FILE = path.join(DATA_DIR, "conditions.json");
const CACHE_FILE      = path.join(DATA_DIR, "products-cache.json");
const HIDDEN_FILE     = path.join(DATA_DIR, "hidden-products.json");

// La primera vez que corre con un volumen vacío, lo sembramos con los
// valores por defecto del repo para no arrancar en blanco.
if (DATA_DIR !== __dirname) {
  for (const name of ["prices.json", "conditions.json"]) {
    const target = path.join(DATA_DIR, name);
    const source = path.join(__dirname, name);
    if (!fs.existsSync(target) && fs.existsSync(source)) {
      fs.copyFileSync(source, target);
    }
  }
}

console.log(`DATA_DIR: ${DATA_DIR} (${DATA_DIR === __dirname ? "sin volumen" : "volumen Railway"})`);
try {
  const probe = path.join(DATA_DIR, ".write-test");
  fs.writeFileSync(probe, "ok");
  fs.unlinkSync(probe);
  console.log("DATA_DIR: escritura OK");
} catch (e) {
  console.error(`DATA_DIR: NO se puede escribir (${e.code}): ${e.message}`);
}

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
  catch (e) {
    if (e.code !== "ENOENT") console.error(`loadFile: no se pudo leer ${file}: ${e.message}`);
    return fallback;
  }
}
function saveFile(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8"); }
  catch (e) { console.error(`saveFile: no se pudo escribir ${file}: ${e.message}`); }
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
      {
        headers: { Authentication: `bearer ${TN_TOKEN}`, "User-Agent": "Tops Mayorista App" },
        signal: AbortSignal.timeout(20000),
      }
    );
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    data.forEach((p) => {
      // Solo lo que está publicado en la tienda (lo despublicado no se ofrece)
      if (p.published === false) return;
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
        sku:   (p.variants?.[0]?.sku || "").replace(/\/(i|v)\d+.*$/i, "").replace(/\*.*$/, "").trim(),
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
// No depende de clases CSS del tema (Tiendanube las cambia): identifica los
// productos por el patrón de URL /productos/<slug>/ y lee cada ficha.
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function fetchPage(url) {
  const res  = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "es-AR,es;q=0.9" },
    signal: AbortSignal.timeout(20000),
  });
  const html = await res.text();
  if (!res.ok) {
    console.warn(`fetchPage: ${url} -> HTTP ${res.status} (${html.length} bytes)`);
  }
  return html;
}

function extractProductUrls(html, baseUrl) {
  const urls = new Set();
  const re = /(?:href|data-href|data-url)\s*=\s*["']([^"']*\/productos\/[^"'?#\s\/]+\/?)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const u = new URL(m[1].replace(/\\\//g, "/"), baseUrl);
      u.hash = ""; u.search = "";
      if (!u.pathname.endsWith("/")) u.pathname += "/";
      urls.add(u.toString());
    } catch { /* URL inválida */ }
  }
  return [...urls];
}

async function collectProductUrls() {
  const urls = new Set();

  for (let page = 1; page <= 40; page++) {
    const listUrl = `${STORE_URL}/productos/?page=${page}`;
    let html;
    try { html = await fetchPage(listUrl); } catch (e) { console.warn(`Scraping: ${listUrl} falló: ${e.message}`); break; }
    const found = extractProductUrls(html, STORE_URL);
    const before = urls.size;
    found.forEach((u) => urls.add(u));
    if (urls.size === before) break;
  }
  if (urls.size > 0) {
    console.log(`Scraping: ${urls.size} URLs de producto desde el listado`);
    return [...urls];
  }

  // Fallback: sitemap (puede ser un índice que apunta a otros sitemaps)
  const queue = [`${STORE_URL}/sitemap.xml`];
  const seen  = new Set();
  while (queue.length && seen.size < 20) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    let xml;
    try { xml = await fetchPage(sm); } catch { continue; }
    for (const [, loc] of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      if (/\.xml(\?|$)/i.test(loc)) queue.push(loc);
      else if (/\/productos\/[^\/?#]+\/?$/i.test(loc)) urls.add(loc.endsWith("/") ? loc : loc + "/");
    }
  }
  console.log(`Scraping: ${urls.size} URLs de producto desde el sitemap`);
  return [...urls];
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function scrapeProductDetail(url) {
  try {
    const html = await fetchPage(url);
    const $    = cheerio.load(html);
    const result = { colors: [], sizes: [], colorImages: {}, image: "", images: [], retailPrice: 0 };

    const idMatch =
      html.match(/"product_id"\s*:\s*"?(\d+)/) ||
      html.match(/data-product-id\s*=\s*["'](\d+)["']/) ||
      html.match(/LS\.product\s*=\s*\{[^}]*?"id"\s*:\s*(\d+)/);
    const slug = (url.match(/\/productos\/([^\/?#]+)/) || [])[1] || url;
    result.id = idMatch ? idMatch[1] : `slug:${slug}`;

    const rawName =
      $('meta[property="og:title"]').attr("content") ||
      $("h1").first().text() ||
      $("title").text();
    result.name = (rawName || slug).replace(/\s+/g, " ").replace(/\s*[-|–]\s*Tops\s*$/i, "").trim();

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
      const raw = varSkuMatch[1].replace(/\\\//g, "/");
      sku = raw.replace(/\/(i|v)\d+.*$/i, "").replace(/\*.*$/, "").trim();
    }
    result.sku = sku;

    result.colors = [...new Set(result.colors)];
    result.sizes  = [...new Set(result.sizes)].sort((a, b) => {
      const na = parseFloat(a), nb = parseFloat(b);
      return !isNaN(na) && !isNaN(nb) ? na - nb : a.localeCompare(b);
    });
    return result;
  } catch (e) {
    console.warn(`Scraping: no se pudo leer ${url}: ${e.message}`);
    return null;
  }
}

async function scrapeAllProducts({ limit } = {}) {
  let urls = await collectProductUrls();
  if (limit) urls = urls.slice(0, limit);

  const details = await mapLimit(urls, 6, (url) => scrapeProductDetail(url));
  const products = [];
  const seenIds  = new Set();
  for (const d of details) {
    if (!d || !d.name || seenIds.has(d.id)) continue;
    seenIds.add(d.id);
    products.push({
      id:          d.id,
      name:        d.name,
      sku:         d.sku || "",
      image:       d.image,
      images:      d.images.length ? d.images : (d.image ? [d.image] : []),
      colorImages: d.colorImages || {},
      retailPrice: d.retailPrice,
      colors:      d.colors.length ? d.colors : ["Único"],
      sizes:       d.sizes.length  ? d.sizes  : ["Único"],
    });
  }
  return products;
}

// ── CACHE DE PRODUCTOS ─────────────────────────────────────────────────────────
let syncInFlight = null;

async function syncProducts() {
  let products = [];
  if (TN_STORE_ID && TN_TOKEN) {
    console.log("Sincronizando vía API de Tiendanube...");
    try { products = await fetchFromAPI(); }
    catch (e) { console.warn(`API de Tiendanube falló (${e.message}), probando scraping...`); }
  }
  if (products.length === 0) {
    console.log("Sincronizando vía scraping...");
    products = await scrapeAllProducts();
  }
  return products;
}

async function getProducts(forceRefresh = false) {
  const cache  = await loadData("products_cache", CACHE_FILE, { ts: 0, data: [] });
  const cached = cache.data || [];
  const fresh  = cache.v === CACHE_VERSION && Date.now() - (cache.ts || 0) < CACHE_TTL_MS;
  console.log(`getProducts: caché=${cached.length} productos, edad ${((Date.now() - (cache.ts || 0)) / 60000).toFixed(1)} min, forceRefresh=${forceRefresh}`);

  if (!forceRefresh && fresh && cached.length > 0) return cached;

  if (!syncInFlight) {
    syncInFlight = (async () => {
      const products = await syncProducts();
      if (products.length === 0 && cached.length > 0) {
        console.warn("Sync devolvió 0 productos: se mantiene el caché anterior");
        return cached;
      }
      await saveData("products_cache", CACHE_FILE, { v: CACHE_VERSION, ts: Date.now(), data: products });
      console.log(`✓ ${products.length} productos sincronizados`);
      return products;
    })().finally(() => { syncInFlight = null; });
  }
  return syncInFlight;
}

// ── RUTAS ──────────────────────────────────────────────────────────────────────
app.get("/admin",    (req, res) => res.redirect("/admin.html"));
app.get("/catalogo", (req, res) => res.redirect("/catalogo.html"));

app.post("/api/auth/admin", (req, res) => {
  if (req.body.password === ADMIN_PASS) return res.json({ ok: true });
  res.status(401).json({ error: "Contraseña incorrecta" });
});

app.get("/api/products", async (req, res) => {
  try {
    const includeHidden = req.query.includeHidden === "1";
    const [cache, prices, hidden] = await Promise.all([
      loadData("products_cache", CACHE_FILE, { ts: 0, data: [] }),
      loadData("prices", PRICES_FILE, {}),
      loadData("hidden_products", HIDDEN_FILE, []),
    ]);
    const hiddenSet = new Set(hidden);

    const withExtras = (list) =>
      list
        .filter((p) => includeHidden || !hiddenSet.has(p.id))
        .map((p) => ({ ...p, wholesalePrice: prices[p.id] ?? null, hidden: hiddenSet.has(p.id) }));

    const cached   = cache.data || [];
    const isStale  = cache.v !== CACHE_VERSION || Date.now() - (cache.ts || 0) >= CACHE_TTL_MS;
    const isEmpty  = cached.length === 0;
    console.log(`GET /api/products: caché=${cached.length} productos, isStale=${isStale}, isEmpty=${isEmpty}`);

    // Si hay datos en caché, los devolvemos INMEDIATAMENTE (aunque estén vencidos)
    if (!isEmpty) {
      res.json(withExtras(cached));
      // Si el caché está vencido, actualizamos en el fondo sin bloquear al cliente
      if (isStale) {
        getProducts(true).catch((e) => console.warn("Background sync failed:", e.message));
      }
      return;
    }

    // Solo si no hay nada en caché esperamos la sincronización (primer arranque)
    const products = await getProducts();
    res.json(withExtras(products));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener productos" });
  }
});

app.post("/api/hidden", async (req, res) => {
  const { password, hidden } = req.body;
  if (password !== ADMIN_PASS) return res.status(401).json({ error: "Sin autorización" });
  if (!Array.isArray(hidden)) return res.status(400).json({ error: "Datos inválidos" });
  await saveData("hidden_products", HIDDEN_FILE, hidden.map(String));
  res.json({ ok: true });
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

app.get("/api/health", async (req, res) => {
  const cache = await loadData("products_cache", CACHE_FILE, { ts: 0, data: [] });
  res.json({
    ok:         true,
    service:    process.env.RAILWAY_SERVICE_NAME || "local",
    project:    process.env.RAILWAY_PROJECT_NAME || "local",
    deployment: (process.env.RAILWAY_DEPLOYMENT_ID || "local").slice(0, 8),
    source:     TN_STORE_ID && TN_TOKEN ? "api" : "scraping",
    storage:    REDIS_URL ? "redis" : (DATA_DIR === __dirname ? "archivo" : "volumen"),
    products:   (cache.data || []).length,
    cacheAgeMin: cache.ts ? Math.round((Date.now() - cache.ts) / 60000) : null,
  });
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

  // Verifica de punta a punta que la URL pública sirve los productos
  const publicDomain = process.env.SELFCHECK_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN;
  if (publicDomain) {
    setTimeout(async () => {
      try {
        const r = await fetch(`https://${publicDomain}/api/products`, { signal: AbortSignal.timeout(20000) });
        const data = await r.json();
        console.log(`AUTOCHEQUEO https://${publicDomain}/api/products -> HTTP ${r.status}, ${Array.isArray(data) ? data.length : "?"} productos`);
      } catch (e) {
        console.warn(`AUTOCHEQUEO https://${publicDomain} falló: ${e.message}`);
      }
    }, 15000);
  }

  // Prueba el scraping contra la tienda real sin tocar el caché
  if (process.env.SCRAPE_SELFTEST) {
    const t0 = Date.now();
    scrapeAllProducts()
      .then((list) => {
        const sample = list[0] ? JSON.stringify({ ...list[0], images: list[0].images.length }).slice(0, 400) : "-";
        const conPrecio = list.filter((p) => p.retailPrice > 0).length;
        const conColores = list.filter((p) => p.colors[0] !== "Único").length;
        console.log(`SCRAPE_SELFTEST: ${list.length} productos en ${((Date.now() - t0) / 1000).toFixed(0)}s, con precio=${conPrecio}, con colores=${conColores}, ids numéricos=${list.filter((p) => /^\d+$/.test(p.id)).length}`);
        console.log(`SCRAPE_SELFTEST ejemplo: ${sample}`);
      })
      .catch((e) => console.warn(`SCRAPE_SELFTEST falló: ${e.message}`));
  }
});
