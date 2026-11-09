// Importador de menu (alta autoservicio) -- apps/api/src/routes/verticals/restaurantes/admin-menu-importar.ts.
import { sendJson } from "./admin-client.ts";

export type DudaImportacion = "sin_precio" | "precio_inusual" | "duplicado" | "sin_categoria";

export interface BorradorProducto {
  readonly nombre: string;
  readonly categoria: string;
  readonly descripcion: string | null;
  readonly precio: number | null;
  readonly esPaquete: boolean;
  readonly incluye: readonly string[];
  readonly dudas: readonly DudaImportacion[];
}

export interface BorradorMenu {
  readonly categorias: readonly string[];
  readonly productos: readonly BorradorProducto[];
  readonly ilegibles: number;
  readonly recortado: boolean;
}

export interface ResultadoImportacionMenu {
  readonly creados: number;
  readonly omitidos: number;
  readonly categoriasCreadas: number;
}

export const ETIQUETA_DUDA: Readonly<Record<DudaImportacion, string>> = {
  sin_precio: "Sin precio",
  precio_inusual: "Precio fuera de lo común",
  duplicado: "Repetido",
  sin_categoria: "Sin categoría",
};

export const ARCHIVO_MENU_MAX_BYTES = 3 * 1024 * 1024;

function base(apiBaseUrl: string, propertyId: string): string {
  return `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/menu/importar`;
}

/** Bytes -> base64 en trozos (un menu de 3 MB revienta `String.fromCharCode(...bytes)` de un jalon). */
export function aBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function extraerMenu(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  entrada: { readonly csv: string } | { readonly archivo: { readonly nombre: string; readonly base64: string } },
): Promise<{ readonly fuente: "csv" | "vision"; readonly borrador: BorradorMenu }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/extraer`, token, "POST", entrada);
}

export async function guardarMenu(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  productos: ReadonlyArray<{ readonly nombre: string; readonly categoria: string; readonly descripcion: string | null; readonly precio: number }>,
): Promise<ResultadoImportacionMenu> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/guardar`, token, "POST", { productos });
}
