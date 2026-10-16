// Menu en PDF por sucursal (decision de Javier: el menu por WhatsApp va como PDF ADJUNTO y es el de CADA sucursal publicado en internet).
//
// Los PDF los aloja la propia app web (apps/web/public/menu-pdf/*.pdf, mismo dominio, GET directo 200 application/pdf sin redireccion: Meta los descarga asi).
// Se arman con las fotos oficiales del sitio de PM (8 o 9 imagenes de pagina completa por sucursal), reescaladas para telefono (ver `docs/restaurantes/menu-pdf-por-sucursal.md`).
// La base por omision es `MENU_PDF_BASE_POR_OMISION`; `PM_MENU_PDF_BASE_URL` (ver apps/api/src/production/deps.ts) solo la sobre-escribe, NO hace falta definirla.
// PENSIONES NO tiene PDF a proposito (su menu publica precios 2025 que contradicen lo que cotiza el agente): comparte el enlace de la pagina oficial.
// Los menus en ingles del sitio quedan fuera de alcance.

/** Base https donde la app web sirve los PDF (carpeta `apps/web/public/menu-pdf`). Sobre-escribible con `PM_MENU_PDF_BASE_URL`. */
export const MENU_PDF_BASE_POR_OMISION = "https://app.useatiende.ai/menu-pdf";

/** Menu publicado: archivo PDF (bajo la base) y pagina web oficial del mismo menu (respaldo si el PDF no esta disponible). */
export interface MenuPdfSucursal {
  /** Nombre del archivo bajo la base (tambien es el nombre que ve el cliente). `null` = esa sucursal NO tiene PDF (se comparte el enlace de la pagina oficial). */
  readonly archivo: string | null;
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
 * Platz) usa ese. En la cuenta real (fixtures/cuenta-real-pm-estado.json) NO existe un slug `victory-platz`: «Victory Platz» es el NOMBRE de `garcia-lavin` y «Victory Altabrisa» el de `altabrisa`, asi que el menu «Victory» del sitio sirve a ambos.
 */
export const MENU_PDF_POR_SUCURSAL: Readonly<Record<string, MenuPdfSucursal>> = {
  "prol-montejo": MONTEJO_ALTABRISA_VICTORY,
  "garcia-lavin": MONTEJO_ALTABRISA_VICTORY,
  altabrisa: MONTEJO_ALTABRISA_VICTORY,
  "fco-montejo": { archivo: "menu-fco-montejo.pdf", paginaWeb: `${SITIO}/menufranciscodemontejo`, etiqueta: "Francisco de Montejo" },
  // Sin PDF: el sitio publica la lista de precios 2025 (el agente cotiza 2026). Se vuelve a habilitar cuando Javier consiga la imagen actualizada.
  pensiones: { archivo: null, paginaWeb: `${SITIO}/menupensiones`, etiqueta: "Pensiones" },
  galerias: { archivo: "menu-galerias.pdf", paginaWeb: `${SITIO}/menupmgalerias`, etiqueta: "Galerías" },
  playa: { archivo: "menu-playa.pdf", paginaWeb: `${SITIO}/menuchicxulub`, etiqueta: "Chicxulub (Playa)" },
};

export type ResultadoMenuPdf =
  | { readonly tipo: "pdf"; readonly url: string; readonly archivo: string; readonly paginaWeb: string; readonly etiqueta: string }
  | { readonly tipo: "enlace"; readonly paginaWeb: string; readonly etiqueta: string }
  | { readonly tipo: "sin_menu" };

/** `base` valida = https sin credenciales; se normaliza sin barras finales. Cualquier otra cosa = null (`resolverMenuPdf` usa entonces la base por omision). */
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

/** Que se le manda al cliente para `branchSlug`: el PDF (base por omision o la de `PM_MENU_PDF_BASE_URL`), el enlace de la pagina oficial (sucursal sin PDF, como Pensiones), o nada (sucursal sin menu publicado). */
export function resolverMenuPdf(branchSlug: string, baseUrl: string | null | undefined): ResultadoMenuPdf {
  const menu = Object.hasOwn(MENU_PDF_POR_SUCURSAL, branchSlug) ? MENU_PDF_POR_SUCURSAL[branchSlug]! : null;
  if (!menu) return { tipo: "sin_menu" };
  if (menu.archivo === null) return { tipo: "enlace", paginaWeb: menu.paginaWeb, etiqueta: menu.etiqueta };
  // Base invalida o ausente = la por omision (nunca se manda una URL no https ni con credenciales).
  const base = normalizarBaseMenuPdf(baseUrl) ?? MENU_PDF_BASE_POR_OMISION;
  return { tipo: "pdf", url: `${base}/${encodeURIComponent(menu.archivo)}`, archivo: menu.archivo, paginaWeb: menu.paginaWeb, etiqueta: menu.etiqueta };
}
