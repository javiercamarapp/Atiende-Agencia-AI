// Vista previa al compartir (meta en servidor) de /pedir/:org[/:sucursal]: inyector (escapado, sin datos privados),
// meta genericas para organizacion/sucursal inexistente, JSON-LD Restaurant sin precios y la ruta HTTP real que
// sirve el index.html con las meta de la organizacion (lo que ve un rastreador sin JS).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { construirMetaStorefront, escaparHtml, horarioSchemaOrg, inyectarMeta, jsonLdRestaurante, metaGenerica, serializarJsonLd } from "../src/routes/verticals/restaurantes/storefront-meta.ts";
import { CSP_SPA_REPORT_ONLY, PERMISSIONS_POLICY_STOREFRONT } from "../src/cabeceras-seguridad.ts";
import { buildTestDeps } from "./fixtures.ts";

const PLANTILLA = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <title>Atiende</title>
    <meta name="description" content="Atiende, agencia de AI" />
    <meta property="og:title" content="Atiende, agencia de AI" />
    <meta property="og:image" content="/atiende-wordmark.svg" />
    <meta name="twitter:title" content="Atiende, agencia de AI" />
  </head>
  <body><div id="root"></div></body>
</html>`;
const BASE = "https://app.atiende.ai";

describe("inyectarMeta", () => {
  it("reemplaza title, description, og, twitter y canonical; quita las genericas de Atiende", () => {
    const html = inyectarMeta(PLANTILLA, { titulo: "Taquería X", descripcion: "Pida en línea", canonical: `${BASE}/pedir/x`, noindex: false, jsonLd: null });
    expect(html).toContain("<title>Taquería X</title>");
    expect(html).toContain('<meta property="og:title" content="Taquería X" />');
    expect(html).toContain('<meta name="twitter:title" content="Taquería X" />');
    expect(html).toContain(`<link rel="canonical" href="${BASE}/pedir/x" />`);
    expect(html).toContain('<meta name="robots" content="index,follow" />');
    expect(html).not.toContain("Atiende, agencia de AI");
    expect(html).not.toContain("atiende-wordmark");
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain('<div id="root">');
  });

  it("escapa HTML en titulo y descripcion: un nombre malicioso no rompe el documento", () => {
    const html = inyectarMeta(PLANTILLA, { titulo: 'Tacos "<script>alert(1)</script>" & más', descripcion: "a'b\"c<d>", canonical: `${BASE}/pedir/x`, noindex: false, jsonLd: null });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;");
    expect(html).toContain("&amp;");
    expect(html).toContain("a&#39;b&quot;c&lt;d&gt;");
  });

  it("el JSON-LD escapa '<' para que no pueda cerrar el <script>", () => {
    const html = inyectarMeta(PLANTILLA, { titulo: "T", descripcion: "D", canonical: BASE, noindex: false, jsonLd: { name: "</script><script>x()</script>" } });
    expect(html.match(/<script type="application\/ld\+json">/g)).toHaveLength(1);
    expect(html).not.toContain("</script><script>x()");
    expect(serializarJsonLd({ a: "<b>" })).toBe('{"a":"\\u003cb>"}');
  });

  it("recorta titulos y descripciones largos", () => {
    const html = inyectarMeta(PLANTILLA, { titulo: "T".repeat(300), descripcion: "D".repeat(900), canonical: BASE, noindex: true, jsonLd: null });
    expect(html.match(/<title>(.*)<\/title>/)![1]!.length).toBeLessThanOrEqual(70);
    expect(html).toContain('content="noindex,nofollow"');
  });

  it("escapaHtml cubre los cinco caracteres", () => {
    expect(escaparHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("JSON-LD Restaurant", () => {
  it("lleva nombre, direccion, telefono, horario y hasMenu; sin precios ni ids", () => {
    const ld = jsonLdRestaurante("Los Taquitos de PM", { nombre: "Pensiones", direccion: "Calle 7 #1", telefono: "+529991234567", horario: [{ dias: [5, 6], abre: "12:00", cierra: "01:00" }], urlMenu: `${BASE}/pedir/pm/pensiones` });
    expect(ld).toMatchObject({ "@type": "Restaurant", name: "Los Taquitos de PM Pensiones", hasMenu: `${BASE}/pedir/pm/pensiones`, telephone: "+529991234567", address: { streetAddress: "Calle 7 #1" } });
    expect(ld.openingHoursSpecification).toEqual([
      { "@type": "OpeningHoursSpecification", dayOfWeek: "https://schema.org/Friday", opens: "12:00", closes: "01:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: "https://schema.org/Saturday", opens: "12:00", closes: "01:00" },
    ]);
    expect(JSON.stringify(ld)).not.toMatch(/price|\$|priceRange|offers/i);
  });

  it("sin direccion, telefono ni horario no inventa nada", () => {
    const ld = jsonLdRestaurante("X", { nombre: "X", direccion: null, telefono: null, horario: null, urlMenu: BASE });
    expect(Object.keys(ld).sort()).toEqual(["@context", "@type", "hasMenu", "name", "url"]);
    expect(horarioSchemaOrg(null)).toEqual([]);
  });
});

describe("construirMetaStorefront (repositorio en memoria)", () => {
  it("organizacion: titulo y descripcion de la organizacion, indexable", async () => {
    const t = await buildTestDeps();
    const m = await construirMetaStorefront(t.restaurantesRepo, { baseUrl: BASE, orgSlug: "los-taquitos-de-pm", branchSlug: null });
    expect(m).toMatchObject({ titulo: "Los Taquitos de PM · Pedir en línea", canonical: `${BASE}/pedir/los-taquitos-de-pm`, noindex: false, jsonLd: null });
  });

  it("sucursal activa: JSON-LD Restaurant con su direccion y su menu", async () => {
    const t = await buildTestDeps();
    const m = await construirMetaStorefront(t.restaurantesRepo, { baseUrl: BASE, orgSlug: "los-taquitos-de-pm", branchSlug: "fco-montejo" });
    expect(m.titulo).toBe("Los Taquitos de PM Francisco de Montejo · Pedir en línea");
    expect(m.canonical).toBe(`${BASE}/pedir/los-taquitos-de-pm/fco-montejo`);
    expect(m.jsonLd).toMatchObject({ "@type": "Restaurant", hasMenu: `${BASE}/pedir/los-taquitos-de-pm/fco-montejo` });
  });

  it("organizacion inexistente: meta genericas y noindex, sin ningun dato", async () => {
    const t = await buildTestDeps();
    const m = await construirMetaStorefront(t.restaurantesRepo, { baseUrl: BASE, orgSlug: "no-existe", branchSlug: null });
    expect(m).toEqual(metaGenerica(BASE, "/pedir/no-existe"));
    expect(m.noindex).toBe(true);
    expect(m.jsonLd).toBeNull();
  });

  it("sucursal inexistente o inactiva: meta de la organizacion sin datos de sucursal, noindex", async () => {
    const t = await buildTestDeps();
    const m = await construirMetaStorefront(t.restaurantesRepo, { baseUrl: BASE, orgSlug: "los-taquitos-de-pm", branchSlug: "fantasma" });
    expect(m.noindex).toBe(true);
    expect(m.jsonLd).toBeNull();
    expect(m.titulo).toBe("Los Taquitos de PM · Pedir en línea");
  });

  it("no filtra datos privados: ni ids, ni coordenadas, ni minimos de la sucursal", async () => {
    const t = await buildTestDeps();
    t.restaurantesRepo.seedBranchPolicy(t.propertyId, { pedidoMinimoDomicilio: 987.65 });
    const m = await construirMetaStorefront(t.restaurantesRepo, { baseUrl: BASE, orgSlug: "los-taquitos-de-pm", branchSlug: "fco-montejo" });
    const texto = JSON.stringify(m);
    expect(texto).not.toContain(t.propertyId);
    expect(texto).not.toContain(t.organizationId);
    expect(texto).not.toContain("987");
    expect(texto).not.toContain("21.0186");
  });
});

describe("GET /pedir/:org[/:sucursal] (lo que ve un rastreador sin JS)", () => {
  async function app() {
    const t = await buildTestDeps();
    return { t, app: buildApp({ ...t.deps, storefrontIndexHtml: async () => PLANTILLA }) };
  }

  it("devuelve el index.html con og:title de la organizacion y cache corto compartido", async () => {
    const { app: a } = await app();
    const res = await a.request("/pedir/los-taquitos-de-pm");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toContain("s-maxage=300");
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="Los Taquitos de PM · Pedir en línea" />');
    expect(html).toContain('<div id="root">');
    expect(html).not.toContain("Atiende, agencia de AI");
  });

  it("las paginas de entrada llevan la CSP de la SPA y NO default-src 'none' (si no, el storefront queda en blanco)", async () => {
    const { app: a } = await app();
    for (const ruta of ["/pedir/los-taquitos-de-pm", "/pedir/los-taquitos-de-pm/fco-montejo", "/pedir/no-existe"]) {
      const res = await a.request(ruta);
      expect(res.status, ruta).toBe(200);
      expect(res.headers.get("content-security-policy"), ruta).toBeNull();
      expect(res.headers.get("content-security-policy-report-only"), ruta).toBe(CSP_SPA_REPORT_ONLY);
      expect(res.headers.get("content-security-policy-report-only")).not.toContain("default-src 'none'");
      expect(res.headers.get("content-security-policy-report-only")).toContain("script-src 'self'");
      expect(res.headers.get("permissions-policy"), ruta).toContain("geolocation=(self)");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("la CSP de la SPA del codigo coincide con la de vercel.json y /pedir permite geolocation a la propia pagina", async () => {
    const { readFileSync } = await import("node:fs");
    const config = JSON.parse(readFileSync(new URL("../../../vercel.json", import.meta.url), "utf8")) as { headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> };
    const csp = config.headers.flatMap((h) => h.headers).find((h) => h.key === "Content-Security-Policy-Report-Only");
    expect(csp?.value).toBe(CSP_SPA_REPORT_ONLY);
    const pedir = config.headers.find((h) => h.source === "/pedir/(.*)");
    expect(pedir?.headers.find((h) => h.key === "Permissions-Policy")?.value).toBe(PERMISSIONS_POLICY_STOREFRONT);
    // Las respuestas JSON de la API siguen con la CSP restrictiva.
    const { app: a } = await app();
    expect((await a.request("/health")).headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("si la base falla cae a meta genericas con noindex pero sin cache compartido", async () => {
    const t = await buildTestDeps();
    const degradado = { ...t.deps, restaurantesRepo: () => { throw new Error("db caida"); } } as typeof t.deps;
    const a = buildApp({ ...degradado, storefrontIndexHtml: async () => PLANTILLA });
    const res = await a.request("/pedir/los-taquitos-de-pm");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain('content="noindex,nofollow"');
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("sucursal: og:title y JSON-LD de esa sucursal", async () => {
    const { app: a } = await app();
    const html = await (await a.request("/pedir/los-taquitos-de-pm/fco-montejo")).text();
    expect(html).toContain("Francisco de Montejo");
    expect(html).toContain('"@type":"Restaurant"');
  });

  it("organizacion inexistente: 200 con meta genericas (la SPA muestra su error) y sin datos", async () => {
    const { app: a } = await app();
    const res = await a.request("/pedir/no-existe");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('content="noindex,nofollow"');
    expect(html).toContain("Pedir en línea");
    expect(html).not.toContain("application/ld+json");
  });

  it("sin plantilla disponible responde 503 honesto, no una pagina rota", async () => {
    const t = await buildTestDeps();
    const a = buildApp({ ...t.deps, storefrontIndexHtml: async () => null });
    expect((await a.request("/pedir/los-taquitos-de-pm")).status).toBe(503);
  });

  it("la ruta de rastreo de 3 segmentos no la sirve el servidor (sigue siendo el SPA estatico)", async () => {
    const { app: a } = await app();
    expect((await a.request("/pedir/los-taquitos-de-pm/pedido/abc")).status).toBe(404);
  });
});

describe("despliegue: vercel.json y robots.txt", () => {
  it("vercel.json reescribe /pedir/:org y /pedir/:org/:slug a la funcion, antes del comodin del SPA", async () => {
    const { readFileSync } = await import("node:fs");
    const config = JSON.parse(readFileSync(new URL("../../../vercel.json", import.meta.url), "utf8")) as { rewrites: Array<{ source: string; destination: string }> };
    const fuentes = config.rewrites.map((r) => r.source);
    const comodin = fuentes.indexOf("/(.*)");
    for (const origen of ["/pedir/:orgSlug", "/pedir/:orgSlug/:branchSlug"]) {
      const idx = fuentes.indexOf(origen);
      expect(idx, origen).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(comodin);
      expect(config.rewrites[idx]!.destination).toBe("/api");
    }
    // El seguimiento de un pedido (3 segmentos, lleva token) sigue siendo estatico.
    expect(fuentes).not.toContain("/pedir/:orgSlug/pedido/:token");
  });

  it("robots.txt permite /pedir/ y bloquea el seguimiento, la API y los paneles", async () => {
    const { readFileSync } = await import("node:fs");
    const robots = readFileSync(new URL("../../web/public/robots.txt", import.meta.url), "utf8");
    expect(robots).toMatch(/^Allow: \/pedir\/$/m);
    for (const regla of ["/pedir/*/pedido/", "/v1/", "/auth/", "/internal/", "/restaurantes/", "/superadmin/"]) expect(robots).toContain(`Disallow: ${regla}`);
  });
});
