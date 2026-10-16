// PDF del menu alojados por nosotros (apps/web/public/menu-pdf): existen, son PDF validos, pesan lo esperado, coinciden con el manifiesto y
// su ruta NO la traga un rewrite de la SPA de vercel.json. Deterministas: solo leen archivos del repo (sin red, sin Meta, sin base real). El content-type application/pdf lo pone Vercel por la extension del archivo estatico (vercel-headers.spec.ts prohibe cabeceras por ruta); se verifica con curl tras el despliegue.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MENU_PDF_BASE_POR_OMISION, MENU_PDF_POR_SUCURSAL, resolverMenuPdf } from "../src/menu-pdf.ts";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DIR_PDF = path.join(RAIZ, "apps/web/public/menu-pdf");
const LIMITE_BYTES = 3 * 1_000_000; // objetivo: <= 3 MB por PDF (telefonos)
const MINIMO_BYTES = 500_000; // un PDF mas chico seria sospechoso (paginas perdidas o imagen vacia)
const PAGINAS: Readonly<Record<string, number>> = {
  "menu-montejo-altabrisa-victory.pdf": 9,
  "menu-fco-montejo.pdf": 9,
  "menu-galerias.pdf": 9,
  "menu-playa.pdf": 8,
};

interface EntradaManifiesto { archivo: string; sucursales: string[]; paginas: number; bytes: number; sha256: string; url_publica: string }
const manifiesto = JSON.parse(readFileSync(path.join(RAIZ, "docs/restaurantes/menu-pdf-manifiesto.json"), "utf8")) as { menus: EntradaManifiesto[]; excluidos: Array<{ sucursal?: string }> };

const archivosDelMapa = [...new Set(Object.values(MENU_PDF_POR_SUCURSAL).flatMap((m) => (m.archivo ? [m.archivo] : [])))].sort();

describe("PDF del menu alojados en apps/web/public/menu-pdf", () => {
  it("la carpeta tiene EXACTAMENTE los PDF del mapa (ni de mas: Pensiones y los menus en ingles no se publican)", () => {
    expect(archivosDelMapa).toEqual(Object.keys(PAGINAS).sort());
    expect(readdirSync(DIR_PDF).sort()).toEqual(archivosDelMapa);
    expect(existsSync(path.join(DIR_PDF, "menu-pensiones.pdf"))).toBe(false);
  });

  for (const archivo of Object.keys(PAGINAS)) {
    it(`${archivo}: es un PDF valido, de ${PAGINAS[archivo]} paginas, entre 0.5 y 3 MB`, () => {
      const ruta = path.join(DIR_PDF, archivo);
      expect(existsSync(ruta)).toBe(true);
      const bytes = readFileSync(ruta);
      expect(statSync(ruta).size).toBe(bytes.length);
      expect(bytes.length).toBeGreaterThan(MINIMO_BYTES);
      expect(bytes.length).toBeLessThanOrEqual(LIMITE_BYTES);
      const texto = bytes.toString("latin1");
      expect(texto.startsWith("%PDF-1.")).toBe(true);
      expect(texto.trimEnd().endsWith("%%EOF")).toBe(true);
      // Cada pagina es UN objeto /Type /Page (no /Pages) con su imagen JPEG; el arbol declara el mismo total.
      expect((texto.match(/\/Type \/Page /g) ?? []).length).toBe(PAGINAS[archivo]);
      expect(texto).toContain(`/Count ${PAGINAS[archivo]} `);
      expect((texto.match(/\/Filter \/DCTDecode/g) ?? []).length).toBe(PAGINAS[archivo]);
      // xref: el offset de startxref apunta a la tabla (un PDF truncado o mal armado falla aqui).
      const inicio = Number(/startxref\n(\d+)\n%%EOF\s*$/.exec(texto)?.[1]);
      expect(texto.slice(inicio, inicio + 4)).toBe("xref");
    });

    it(`${archivo}: coincide con el manifiesto (paginas, bytes, SHA-256, URL publica bajo la base por omision)`, () => {
      const entrada = manifiesto.menus.find((m) => m.archivo === archivo);
      expect(entrada, archivo).toBeDefined();
      const bytes = readFileSync(path.join(DIR_PDF, archivo));
      expect(entrada!.bytes).toBe(bytes.length);
      expect(entrada!.paginas).toBe(PAGINAS[archivo]);
      expect(entrada!.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(entrada!.url_publica).toBe(`${MENU_PDF_BASE_POR_OMISION}/${archivo}`);
    });
  }

  it("el manifiesto asigna a cada sucursal el mismo archivo que el mapa del codigo y deja constancia de la exclusion de Pensiones", () => {
    for (const entrada of manifiesto.menus) {
      for (const slug of entrada.sucursales) expect(MENU_PDF_POR_SUCURSAL[slug]?.archivo, slug).toBe(entrada.archivo);
    }
    expect(manifiesto.menus.flatMap((m) => m.sucursales).sort()).toEqual(["altabrisa", "fco-montejo", "galerias", "garcia-lavin", "playa", "prol-montejo"]);
    expect(manifiesto.excluidos.some((e) => e.sucursal === "pensiones")).toBe(true);
  });

  it("la URL que se manda a Meta apunta al archivo alojado: https, mismo dominio de la app, sin redireccion ni query", () => {
    for (const slug of Object.keys(MENU_PDF_POR_SUCURSAL)) {
      const r = resolverMenuPdf(slug, null);
      if (slug === "pensiones") {
        expect(r.tipo).toBe("enlace");
        continue;
      }
      expect(r.tipo).toBe("pdf");
      if (r.tipo !== "pdf") continue;
      const u = new URL(r.url);
      expect(u.protocol).toBe("https:");
      expect(u.hostname).toBe("app.useatiende.ai");
      expect(u.search).toBe("");
      expect(u.pathname).toBe(`/menu-pdf/${r.archivo}`);
      expect(existsSync(path.join(DIR_PDF, r.archivo)), r.url).toBe(true);
    }
  });
});

interface ReglaVercel { source: string; destination?: string; has?: unknown[] }
const vercel = JSON.parse(readFileSync(path.join(RAIZ, "vercel.json"), "utf8")) as { rewrites: ReglaVercel[]; redirects: ReglaVercel[] };

/** Convierte el subconjunto de patrones de Vercel que usa este repo (`:p*`, `:p`, `(.*)`) en RegExp. */
function patronARegExp(source: string): RegExp {
  let re = "";
  for (let i = 0; i < source.length; ) {
    const resto = source.slice(i);
    const m = /^:[A-Za-z]+\*/.exec(resto) ?? /^:[A-Za-z]+/.exec(resto);
    if (m) {
      re += m[0].endsWith("*") ? ".*" : "[^/]+";
      i += m[0].length;
    } else if (resto.startsWith("(.*)")) {
      re += ".*";
      i += 4;
    } else {
      re += source[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

describe("vercel.json: la ruta /menu-pdf/*.pdf no cae en un rewrite ni en un redirect", () => {
  const rutas = Object.keys(PAGINAS).map((a) => `/menu-pdf/${a}`);

  it("ningun redirect ni rewrite ANTES del comodin de la SPA coincide con las rutas de los PDF", () => {
    const ultimo = vercel.rewrites.at(-1)!;
    expect(ultimo).toMatchObject({ source: "/(.*)", destination: "/index.html" }); // el comodin de la SPA va al final: Vercel sirve primero el archivo estatico del disco
    for (const regla of [...vercel.redirects, ...vercel.rewrites.slice(0, -1)]) {
      for (const ruta of rutas) expect(patronARegExp(regla.source).test(ruta), `${regla.source} se traga ${ruta}`).toBe(false);
    }
  });

  it("el comodin SI coincidiria (por eso el PDF debe existir como archivo estatico de la app: public/ -> dist/)", () => {
    expect(patronARegExp(vercel.rewrites.at(-1)!.source).test(rutas[0]!)).toBe(true);
    expect(existsSync(path.join(RAIZ, "apps/web/public/menu-pdf", Object.keys(PAGINAS)[0]!))).toBe(true);
  });
});
