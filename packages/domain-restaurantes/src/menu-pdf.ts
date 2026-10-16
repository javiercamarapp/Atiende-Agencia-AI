// Menu en PDF por sucursal (decision de Javier: el menu por WhatsApp va como PDF ADJUNTO y es el de CADA sucursal publicado en internet).
//
// El sitio publico de PM (Wix) no publica PDF: cada sucursal tiene una pagina de menu con 3 imagenes de pagina completa (carta, 2550x3300). Los PDF se arman
// con esas mismas imagenes, sin recomprimir ni agregar contenido (ver `docs/restaurantes/menu-pdf-por-sucursal.md`) y se publican en una URL https publica.
// NO hay binarios en el repo: aqui solo vive el mapa sucursal -> archivo + pagina web oficial. La base de las URLs es configuracion del servidor
// (`PM_MENU_PDF_BASE_URL`, ver apps/api/src/production/deps.ts); sin ella el agente comparte el enlace de la pagina web oficial del menu de esa sucursal.

/** Menu publicado: archivo PDF (bajo la base configurada) y pagina web oficial del mismo menu (respaldo si el PDF no esta disponible). */
export interface MenuPdfSucursal {
  /** Nombre del archivo bajo `PM_MENU_PDF_BASE_URL` (tambien es el nombre que ve el cliente). */
  readonly archivo: string;
  /** Pagina publica oficial del menu de esa sucursal en https://www.lostaquitosdepm.com (leida el 15-oct-2026). */
  readonly paginaWeb: string;
  /** Texto corto para el pie del documento: a que sucursal(es) corresponde. */
  readonly etiqueta: string;
}

const SITIO = "https://www.lostaquitosdepm.com";

const MONTEJO_ALTABRISA_VICTORY: MenuPdfSucursal = {
  archivo: "menu-montejo-altabrisa-victory.pdf",
  paginaWeb: `${SITIO}/menu-altabrisa-montejo-victory`,
  etiqueta: "Prolongación Montejo, García Lavín (Victory Platz) y Altabrisa",
};

/**
 * `branch_slug` (seed de PM) -> menu publicado. El sitio publica UN menu compartido para Montejo, Altabrisa y Victory: la sucursal T7 (García Lavín, en Victory
 * Platz) usa ese. Pendiente de confirmar por el dueño que el titulo «Victory» del sitio es T7 (hoy es la lectura mas razonable, no una confirmacion).
 */
export const MENU_PDF_POR_SUCURSAL: Readonly<Record<string, MenuPdfSucursal>> = {
  "prol-montejo": MONTEJO_ALTABRISA_VICTORY,
  "garcia-lavin": MONTEJO_ALTABRISA_VICTORY,
  altabrisa: MONTEJO_ALTABRISA_VICTORY,
  "fco-montejo": { archivo: "menu-francisco-de-montejo.pdf", paginaWeb: `${SITIO}/menufranciscodemontejo`, etiqueta: "Francisco de Montejo" },
  pensiones: { archivo: "menu-pensiones.pdf", paginaWeb: `${SITIO}/menupensiones`, etiqueta: "Pensiones" },
  galerias: { archivo: "menu-galerias.pdf", paginaWeb: `${SITIO}/menupmgalerias`, etiqueta: "Galerías" },
  playa: { archivo: "menu-chicxulub.pdf", paginaWeb: `${SITIO}/menuchicxulub`, etiqueta: "Chicxulub (Playa)" },
};

export type ResultadoMenuPdf =
  | { readonly tipo: "pdf"; readonly url: string; readonly archivo: string; readonly paginaWeb: string; readonly etiqueta: string }
  | { readonly tipo: "enlace"; readonly paginaWeb: string; readonly etiqueta: string }
  | { readonly tipo: "sin_menu" };

/** `base` valida = https sin credenciales; se normaliza sin barras finales. Cualquier otra cosa = sin base (el agente cae al enlace de la pagina web). */
export function normalizarBaseMenuPdf(base: string | null | undefined): string | null {
  const v = base?.trim();
  if (!v || v.length > 300) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") return null;
    return v.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Que se le manda al cliente para `branchSlug`: el PDF (si hay base configurada), el enlace de la pagina oficial, o nada (sucursal sin menu publicado). */
export function resolverMenuPdf(branchSlug: string, baseUrl: string | null | undefined): ResultadoMenuPdf {
  const menu = Object.hasOwn(MENU_PDF_POR_SUCURSAL, branchSlug) ? MENU_PDF_POR_SUCURSAL[branchSlug]! : null;
  if (!menu) return { tipo: "sin_menu" };
  const base = normalizarBaseMenuPdf(baseUrl);
  if (!base) return { tipo: "enlace", paginaWeb: menu.paginaWeb, etiqueta: menu.etiqueta };
  return { tipo: "pdf", url: `${base}/${encodeURIComponent(menu.archivo)}`, archivo: menu.archivo, paginaWeb: menu.paginaWeb, etiqueta: menu.etiqueta };
}
