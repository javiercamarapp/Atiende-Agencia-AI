// Vista previa al compartir (WhatsApp, Facebook, Instagram, X) y datos estructurados de las paginas publicas del
// storefront `/pedir/:org[/:sucursal]`. Los rastreadores de esas redes NO ejecutan JS, asi que las meta que ponga
// el cliente (React) no les llegan: aqui el servidor sirve el MISMO `index.html` del panel pero con title,
// description, og:*, twitter:*, canonical y un bloque JSON-LD `Restaurant` ya reemplazados con datos PUBLICOS de la
// organizacion y de la sucursal. Sin PII: nunca clientes, pedidos, ids ni coordenadas; sin precios en el JSON-LD.
//
// Compatibilidad: no usa ninguna tabla ni columna nueva (organizacion, sucursal y politica publicas de siempre;
// la politica degrada con SAVEPOINT en el repositorio). Cualquier fallo cae a meta genericas (sin cache) y la respuesta lleva la CSP de la SPA, no la restrictiva de la API.
import { Hono } from "hono";
import { consumeRateLimit, type RestaurantesRepository } from "@atiende/domain-restaurantes";
import type { HorarioSucursal } from "@atiende/domain-restaurantes";
import { requestActor } from "../../../http-security.ts";
import { CSP_SPA_REPORT_ONLY, PERMISSIONS_POLICY_STOREFRONT } from "../../../cabeceras-seguridad.ts";
import type { AppDeps } from "../../../deps.ts";

/** Sustituido por esbuild en `scripts/build-vercel-function.mjs` con el `index.html` ya construido del panel. */
declare const __ATIENDE_INDEX_HTML__: string | undefined;

export interface MetaStorefront {
  readonly titulo: string;
  readonly descripcion: string;
  readonly canonical: string;
  readonly noindex: boolean;
  /** Objeto JSON-LD (se serializa escapando `<`); null = sin datos estructurados. */
  readonly jsonLd: Record<string, unknown> | null;
}

const RESERVADOS = new Set(["sucursales", "privacidad", "pedido"]);
const DIAS_SCHEMA = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MAX_TITULO = 70;
const MAX_DESCRIPCION = 200;

/** Escapa texto para atributo/elemento HTML (el unico lugar donde entran datos de la organizacion). */
export function escaparHtml(valor: string): string {
  return valor.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function recortar(texto: string, max: number): string {
  const limpio = texto.replace(/\s+/g, " ").trim();
  return limpio.length <= max ? limpio : `${limpio.slice(0, max - 1).trimEnd()}…`;
}

/** JSON-LD seguro dentro de <script>: `<` y los separadores de linea unicode se escapan. */
export function serializarJsonLd(datos: Record<string, unknown>): string {
  return JSON.stringify(datos).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
}

/** Reemplaza title/description/og/twitter/canonical del `index.html` por los de `meta` y agrega el JSON-LD. */
export function inyectarMeta(html: string, meta: MetaStorefront): string {
  const titulo = escaparHtml(recortar(meta.titulo, MAX_TITULO));
  const descripcion = escaparHtml(recortar(meta.descripcion, MAX_DESCRIPCION));
  const url = escaparHtml(meta.canonical);
  let limpio = html
    .replace(/<title>[\s\S]*?<\/title>/i, "")
    .replace(/<meta\s+name="description"[^>]*>/gi, "")
    .replace(/<meta\s+name="robots"[^>]*>/gi, "")
    .replace(/<meta\s+property="og:[^"]*"[^>]*>/gi, "")
    .replace(/<meta\s+name="twitter:[^"]*"[^>]*>/gi, "")
    .replace(/<link\s+rel="canonical"[^>]*>/gi, "");
  const bloque = [
    `<title>${titulo}</title>`,
    `<meta name="description" content="${descripcion}" />`,
    `<meta name="robots" content="${meta.noindex ? "noindex,nofollow" : "index,follow"}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="restaurant.restaurant" />`,
    `<meta property="og:title" content="${titulo}" />`,
    `<meta property="og:description" content="${descripcion}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:locale" content="es_MX" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${titulo}" />`,
    `<meta name="twitter:description" content="${descripcion}" />`,
    ...(meta.jsonLd ? [`<script type="application/ld+json">${serializarJsonLd(meta.jsonLd)}</script>`] : []),
  ].join("\n    ");
  if (!/<\/head>/i.test(limpio)) return limpio;
  limpio = limpio.replace(/<\/head>/i, `    ${bloque}\n  </head>`);
  return limpio;
}

/** Meta genericas (organizacion o sucursal inexistente, error o limite): nada de datos privados ni inventados. */
export function metaGenerica(baseUrl: string, ruta: string): MetaStorefront {
  return {
    titulo: "Pedir en línea",
    descripcion: "Haga su pedido en línea: elija sucursal, arme su pedido y pague en la sucursal.",
    canonical: `${baseUrl}${ruta}`,
    noindex: true,
    jsonLd: null,
  };
}

/** Turnos del negocio a `openingHoursSpecification` (un turno por dia). Sin horario: lista vacia. */
export function horarioSchemaOrg(horario: HorarioSucursal | null): Array<Record<string, unknown>> {
  if (!horario) return [];
  const lista: Array<Record<string, unknown>> = [];
  for (const turno of horario) {
    for (const dia of turno.dias) {
      lista.push({ "@type": "OpeningHoursSpecification", dayOfWeek: `https://schema.org/${DIAS_SCHEMA[dia]}`, opens: turno.abre, closes: turno.cierra });
    }
  }
  return lista;
}

interface DatosSucursalMeta {
  readonly nombre: string;
  readonly direccion: string | null;
  readonly telefono: string | null;
  readonly horario: HorarioSucursal | null;
  readonly urlMenu: string;
}

/** Bloque JSON-LD `Restaurant` de una sucursal: nombre, direccion, telefono, horario y enlace al menu. Sin precios. */
export function jsonLdRestaurante(organizacion: string, s: DatosSucursalMeta): Record<string, unknown> {
  const horario = horarioSchemaOrg(s.horario);
  return {
    "@context": "https://schema.org",
    "@type": "Restaurant",
    name: s.nombre === organizacion ? s.nombre : `${organizacion} ${s.nombre}`,
    url: s.urlMenu,
    hasMenu: s.urlMenu,
    ...(s.direccion ? { address: { "@type": "PostalAddress", streetAddress: s.direccion } } : {}),
    ...(s.telefono ? { telephone: s.telefono } : {}),
    ...(horario.length > 0 ? { openingHoursSpecification: horario } : {}),
  };
}

/** Construye las meta de la ruta publica; cualquier dato faltante cae a genericas, nunca inventa. */
export async function construirMetaStorefront(
  repo: RestaurantesRepository,
  args: { readonly baseUrl: string; readonly orgSlug: string; readonly branchSlug: string | null },
): Promise<MetaStorefront> {
  const ruta = args.branchSlug ? `/pedir/${encodeURIComponent(args.orgSlug)}/${encodeURIComponent(args.branchSlug)}` : `/pedir/${encodeURIComponent(args.orgSlug)}`;
  const org = await repo.findOrganizationBySlug(args.orgSlug);
  if (!org) return metaGenerica(args.baseUrl, ruta);
  const orgBase = `${args.baseUrl}/pedir/${encodeURIComponent(org.slug)}`;

  if (args.branchSlug === "privacidad" || args.branchSlug === "pedido") return { ...metaGenerica(args.baseUrl, ruta), titulo: `${org.name} · ${args.branchSlug === "privacidad" ? "Aviso de privacidad" : "Seguimiento de pedido"}` };

  if (args.branchSlug === "sucursales") {
    return {
      titulo: `Sucursales de ${org.name}`,
      descripcion: `Direcciones, teléfonos y horarios de las sucursales de ${org.name}.`,
      canonical: `${orgBase}/sucursales`,
      noindex: false,
      jsonLd: null,
    };
  }

  if (args.branchSlug && !RESERVADOS.has(args.branchSlug)) {
    const branch = await repo.findBranch(org.id, { slug: args.branchSlug });
    if (!branch || branch.status !== "active") return { ...metaGenerica(args.baseUrl, ruta), titulo: `${org.name} · Pedir en línea` };
    const policy = await repo.findBranchPolicy(branch.propertyId);
    const urlMenu = `${orgBase}/${encodeURIComponent(branch.slug)}`;
    return {
      titulo: `${org.name} ${branch.name} · Pedir en línea`,
      descripcion: `Menú y pedidos en línea de ${org.name}, sucursal ${branch.name}${branch.address ? `, ${branch.address}` : ""}. Pida a domicilio o para recoger y pague en la sucursal.`,
      canonical: urlMenu,
      noindex: false,
      jsonLd: jsonLdRestaurante(org.name, { nombre: branch.name, direccion: branch.address, telefono: branch.phone, horario: policy.horario, urlMenu }),
    };
  }

  return {
    titulo: `${org.name} · Pedir en línea`,
    descripcion: `Haga su pedido en línea en ${org.name}: elija sucursal, arme su pedido y pague en la sucursal.`,
    canonical: orgBase,
    noindex: false,
    jsonLd: null,
  };
}

let plantillaEnMemoria: { readonly html: string; readonly expira: number } | null = null;
const TTL_PLANTILLA_MS = 5 * 60_000;

/** `index.html` del panel: el embebido en el build; si falta, el que sirve el CDN en `appBaseUrl`. null = no hay. */
async function obtenerPlantilla(deps: AppDeps): Promise<string | null> {
  if (deps.storefrontIndexHtml) return deps.storefrontIndexHtml();
  if (typeof __ATIENDE_INDEX_HTML__ === "string" && __ATIENDE_INDEX_HTML__.length > 0) return __ATIENDE_INDEX_HTML__;
  const ahora = Date.now();
  if (plantillaEnMemoria && plantillaEnMemoria.expira > ahora) return plantillaEnMemoria.html;
  try {
    const res = await fetch(`${deps.env.appBaseUrl}/index.html`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const html = await res.text();
    if (!/<div id="root">/.test(html)) return null;
    plantillaEnMemoria = { html, expira: ahora + TTL_PLANTILLA_MS };
    return html;
  } catch {
    return null;
  }
}

export function restaurantesStorefrontMetaRoutes(deps: AppDeps) {
  const app = new Hono();

  async function servir(c: import("hono").Context, branchSlug: string | null) {
    const plantilla = await obtenerPlantilla(deps);
    if (!plantilla) return c.text("Página no disponible por ahora.", 503);
    const orgSlug = c.req.param("orgSlug") ?? "";
    const ruta = branchSlug ? `/pedir/${encodeURIComponent(orgSlug)}/${encodeURIComponent(branchSlug)}` : `/pedir/${encodeURIComponent(orgSlug)}`;
    let meta: MetaStorefront;
    let degradada = false;
    try {
      meta = await deps.engine.withAppSession({ userId: null }, async (db) => {
        const repo = deps.restaurantesRepo(db);
        const limite = await consumeRateLimit(repo, "storefront-meta", requestActor(c.req.raw), 120, 60);
        if (!limite.allowed) {
          degradada = true;
          return metaGenerica(deps.env.appBaseUrl, ruta);
        }
        return construirMetaStorefront(repo, { baseUrl: deps.env.appBaseUrl, orgSlug, branchSlug });
      });
    } catch {
      degradada = true;
      meta = metaGenerica(deps.env.appBaseUrl, ruta);
    }
    // Cache corto y compartido: la respuesta solo depende de la URL y de datos publicos (sin cookies ni PII).
    // Si cayo a meta genericas por limite de tasa o falla de la base NO se cachea: el CDN no debe fijar una tarjeta generica con noindex en una URL real.
    c.header("Cache-Control", degradada ? "no-store" : "public, max-age=0, s-maxage=300, stale-while-revalidate=600");
    // Esta respuesta es el index.html de la SPA: la CSP restrictiva de la API (default-src 'none') la dejaria en blanco, asi que lleva la CSP de la SPA.
    c.header("Content-Security-Policy-Report-Only", CSP_SPA_REPORT_ONLY);
    c.header("Permissions-Policy", PERMISSIONS_POLICY_STOREFRONT);
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(inyectarMeta(plantilla, meta));
  }

  app.get("/pedir/:orgSlug", (c) => servir(c, null));
  app.get("/pedir/:orgSlug/:branchSlug", (c) => servir(c, c.req.param("branchSlug") ?? null));
  return app;
}
