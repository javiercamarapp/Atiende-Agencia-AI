// Rn-P3-08 -- cliente del pre-check-in PUBLICO del huesped (apps/api/src/routes/verticals/rentas/precheckin-publico.ts). Sin sesion: no usa
// tokens de staff ni authed-fetch. `fetchImpl` inyectado para probar la red sin jsdom. Nunca inventa un mensaje cuando el servidor ya mando uno.
import { readErrorMessage } from "../../../lib/authed-fetch.ts";

export class PrecheckinError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface InfoPrecheckin {
  readonly propiedad: string;
  readonly organizacion: string;
  readonly reglamento: string | null;
  readonly aviso: { readonly version: string; readonly titulo: string; readonly parrafos: readonly string[] };
}

export type ResultadoVerificacion =
  | { readonly estado: "invalido"; readonly mensaje: string }
  | { readonly estado: "ok"; readonly token: string; readonly propiedad: string; readonly unidad: string; readonly checkIn: string; readonly checkOut: string; readonly yaCapturado: boolean };

export interface EntradaCapturaWeb {
  readonly token: string;
  readonly correo: string;
  readonly whatsapp: string;
  readonly aceptaPrivacidad: boolean;
  readonly aceptaReglamento: boolean;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/rentas/precheckin/${encodeURIComponent(propertyId)}`;

async function leer<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) throw new PrecheckinError(await readErrorMessage(res, fallback), res.status);
  return (await res.json()) as T;
}

export async function fetchInfoPrecheckin(fetchImpl: typeof fetch, apiBaseUrl: string, propertyId: string): Promise<InfoPrecheckin> {
  return leer<InfoPrecheckin>(await fetchImpl(base(apiBaseUrl, propertyId)), "No pudimos cargar el pre-check-in.");
}

export async function verificarReserva(fetchImpl: typeof fetch, apiBaseUrl: string, propertyId: string, codigo: string, ultimos4: string): Promise<ResultadoVerificacion> {
  const res = await fetchImpl(`${base(apiBaseUrl, propertyId)}/verificar`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codigo, ultimos4 }) });
  const b = await leer<{ estado: "invalido"; mensaje: string } | { estado: "ok"; token: string; propiedad: string; unidad: string; check_in: string; check_out: string; ya_capturado: boolean }>(res, "No pudimos validar tus datos.");
  if (b.estado === "invalido") return { estado: "invalido", mensaje: b.mensaje };
  return { estado: "ok", token: b.token, propiedad: b.propiedad, unidad: b.unidad, checkIn: b.check_in, checkOut: b.check_out, yaCapturado: b.ya_capturado };
}

export async function capturarPrecheckin(fetchImpl: typeof fetch, apiBaseUrl: string, propertyId: string, e: EntradaCapturaWeb): Promise<{ readonly estado: "ok" | "ya_capturado"; readonly mensaje: string }> {
  const res = await fetchImpl(`${base(apiBaseUrl, propertyId)}/capturar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: e.token, correo: e.correo, whatsapp: e.whatsapp.trim() === "" ? null : e.whatsapp, aceptaPrivacidad: e.aceptaPrivacidad, aceptaReglamento: e.aceptaReglamento }),
  });
  return leer<{ estado: "ok" | "ya_capturado"; mensaje: string }>(res, "No pudimos guardar tus datos.");
}
