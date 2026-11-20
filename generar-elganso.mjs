import fs from "fs";

const ORIGEN = "https://revive.com.co/webhook/google-merchant-feed?store=kronotime-gc";
const MONEDA = "COP";
const MARCA = "El Ganso";
const ARCHIVO = "publicar/elganso.xml";

const esc = (t) => String(t ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const entidades = (t) => String(t || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();

const limpiar = (html) => entidades(String(html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const campo = (bloque, nombre) => {
  const m = bloque.match(new RegExp(`<g:${nombre}>([\\s\\S]*?)</g:${nombre}>`));
  return m ? entidades(m[1]) : "";
};
const numero = (t) => {
  const m = String(t || "").replace(/,/g, "").match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
};
const enStock = (t) => /in.?stock/i.test(t) && !/out/i.test(t);
const slug = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const capitalizar = (t) => t.split(" ").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");

async function traer(url) {
  for (let intento = 1; intento <= 3; intento++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
      console.log(`  Intento ${intento} fallo (codigo ${res.status})`);
    } catch (e) {
      console.log(`  Intento ${intento} fallo (${e.message})`);
    }
    await pausa(5000 * intento);
  }
  return null;
}

try {
  console.log("Leyendo feed de origen...");
  const original = await traer(ORIGEN);
  if (!original) throw new Error("No se pudo leer el feed de origen");

  const bloques = original.match(/<item>[\s\S]*?<\/item>/g) || [];
  console.log(`  ${bloques.length} items en el feed original`);

  const grupos = {};
  for (const b of bloques) {
    const v = {
      id: campo(b, "id"),
      grupo: campo(b, "item_group_id"),
      titulo: campo(b, "title"),
      descripcion: limpiar(campo(b, "description")),
      link: campo(b, "link").split("?")[0],
      imagen: campo(b, "image_link"),
      disponible: enStock(campo(b, "availability")),
      precio: numero(campo(b, "price")),
      oferta: numero(campo(b, "sale_price")),
      marca: campo(b, "brand"),
      tipo: campo(b, "product_type"),
      talle: campo(b, "size"),
    };
    const clave = v.grupo || v.link;
    if (!clave) continue;
    (grupos[clave] ||= []).push(v);
  }

  const lista = Object.values(grupos);
  if (lista.length === 0) throw new Error("El feed no tiene productos");

  let sinPrecio = 0, guardados = 0;
  const ejemplos = [];
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
  <channel>
    <title>Feed de productos ${esc(MARCA)}</title>
    <link>https://kronotime-gc.myshopify.com</link>
    <description>Catalogo completo de productos</description>\n`;

  for (const variantes of lista) {
    const conPrecio = variantes.filter((v) => v.precio > 0);
    const disponibles = conPrecio.filter((v) => v.disponible);
    const base = disponibles[0] || conPrecio[0];
    if (!base) { sinPrecio++; continue; }

    let tituloBase = base.titulo;
    if (base.talle && tituloBase.endsWith(` - ${base.talle}`)) {
      tituloBase = tituloBase.slice(0, -(` - ${base.talle}`).length).trim();
    }
    const handle = base.link.split("/products/")[1]?.replace(/\/$/, "") || "";
    const raiz = slug(tituloBase);
    const color = raiz && handle.startsWith(raiz + "-") ? capitalizar(handle.slice(raiz.length + 1).replace(/-/g, " ")) : "";
    const titulo = color ? `${tituloBase} - ${color}` : tituloBase;

    const talles = [...new Set(disponibles.map((v) => v.talle).filter(Boolean))];
    let descripcion = (variantes.find((v) => v.descripcion) || {}).descripcion
      || `${base.tipo || "Prenda"} ${MARCA}: ${titulo}.`;
    descripcion = descripcion.slice(0, 600);
    descripcion += talles.length ? ` Talles disponibles: ${talles.join(", ")}.` : " Sin talles disponibles por el momento.";

    const oferta = base.oferta > 0 && base.oferta < base.precio ? base.oferta : 0;

    xml += `    <item>
      <g:id>${esc(base.id)}</g:id>
      <g:title>${esc(titulo)}</g:title>
      <g:description>${esc(descripcion)}</g:description>
      <g:link>${esc(base.link)}</g:link>
      <g:image_link>${esc(base.imagen)}</g:image_link>
      <g:availability>${disponibles.length ? "in_stock" : "out_of_stock"}</g:availability>
      <g:price>${base.precio.toFixed(2)} ${MONEDA}</g:price>\n`;
    if (oferta) xml += `      <g:sale_price>${oferta.toFixed(2)} ${MONEDA}</g:sale_price>\n`;
    xml += `      <g:brand>${esc(base.marca || MARCA)}</g:brand>
      <g:product_type>${esc(base.tipo)}</g:product_type>
      <g:condition>new</g:condition>
      <g:identifier_exists>no</g:identifier_exists>
    </item>\n`;
    guardados++;
    if (ejemplos.length < 3) ejemplos.push(`${titulo} | $${base.precio} | talles: ${talles.join(", ") || "ninguno"}`);
  }
  xml += `  </channel>\n</rss>\n`;

  console.log(`  Productos sin ningun precio valido (no se publican): ${sinPrecio}`);
  console.log("  Ejemplos para revisar:");
  ejemplos.forEach((e) => console.log(`    ${e}`));

  fs.mkdirSync("publicar", { recursive: true });
  fs.writeFileSync(ARCHIVO, xml);
  console.log(`elganso.xml: ${guardados} productos guardados (${(Buffer.byteLength(xml) / 1024).toFixed(0)} KB)`);
} catch (e) {
  console.log(`elganso.xml: NO se genero (${e.message}). El link mantiene la version anterior.`);
  process.exitCode = 1;
}
