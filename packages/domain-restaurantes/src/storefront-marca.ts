// R-38 / R-43 -- lo que el storefront publico necesita a nivel de MARCA y de EVENTOS, sin tocar el flujo de pedido:
//   * `validarMarca`: valida y normaliza la marca que edita owner/admin (titular, eslogan, about, portada, logo, redes).
//   * `enlaceWhatsapp`: arma el wa.me del boton flotante a partir del telefono de la sucursal (sin PII mas que el texto prellenado).
//   * `buildStorefrontPromociones`: promociones que el motor aplica SOLAS (auto_apply, canal recoger) y estan vigentes hoy.
//   * `validarSolicitudEvento`: validacion estricta de la solicitud publica de evento/catering (R-43) y su mensaje.
// Todo lo que lee la base pasa por `repo.*`, que degrada con SAVEPOINT contra la base sin migrar.
import { canonicalizeMexicanPhone, toWhatsAppRecipient } from "./phone.ts";
import type { RestaurantesRepository } from "./repository.ts";
import type { Promotion, SolicitudEventoInput, StorefrontMarca, StorefrontMarcaInput } from "./types.ts";

/** Error de validacion de la marca o de la solicitud de evento: las rutas lo traducen a 400 con este mensaje. */
export class StorefrontValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorefrontValidationError";
  }
}

export const MARCA_LIMITES = { titular: 120, eslogan: 160, about: 1200, url: 500, red: 300 } as const;

export const MARCA_VACIA: StorefrontMarca = {
  titular: null,
  eslogan: null,
  about: null,
  portadaUrl: null,
  logoUrl: null,
  instagramUrl: null,
  facebookUrl: null,
  tiktokUrl: null,
  updatedAt: null,
};

// Mismos patrones que los CHECK de la migracion 062 (la base es la ultima defensa; esto da el mensaje claro).
const HTTPS_RE = /^https:\/\/[^\s<>"']+$/;
const RED_RE: Readonly<Record<"instagramUrl" | "facebookUrl" | "tiktokUrl", { readonly re: RegExp; readonly nombre: string }>> = {
  instagramUrl: { re: /^https:\/\/(www\.)?instagram\.com\/[^\s<>"']+$/, nombre: "Instagram" },
  facebookUrl: { re: /^https:\/\/(www\.|m\.)?facebook\.com\/[^\s<>"']+$/, nombre: "Facebook" },
  tiktokUrl: { re: /^https:\/\/(www\.)?tiktok\.com\/[^\s<>"']+$/, nombre: "TikTok" },
};

// Sin caracteres de control (salvo salto de linea y tabulacion en textos largos).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function texto(raw: unknown, campo: string, max: number, multilinea = false): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new StorefrontValidationError(`${campo}: se esperaba texto.`);
  let limpio = raw.replace(CONTROL_RE, "").trim();
  if (!multilinea) limpio = limpio.replace(/\s+/g, " ");
  if (limpio === "") return null;
  if (limpio.length > max) throw new StorefrontValidationError(`${campo}: máximo ${max} caracteres.`);
  return limpio;
}

function url(raw: unknown, campo: string, max: number, re: RegExp, ayuda: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new StorefrontValidationError(`${campo}: se esperaba un enlace.`);
  const limpio = raw.trim();
  if (limpio === "") return null;
  if (limpio.length > max || !re.test(limpio)) throw new StorefrontValidationError(`${campo}: ${ayuda}`);
  try {
    // Defensa extra: debe ser una URL https real (la expresion regular sola deja pasar "https://x").
    const u = new URL(limpio);
    if (u.protocol !== "https:" || !u.hostname.includes(".")) throw new Error("host");
  } catch {
    throw new StorefrontValidationError(`${campo}: ${ayuda}`);
  }
  return limpio;
}

/** Valida el cuerpo del panel. Todos los campos son opcionales; ausente o vacio = se borra el campo (null). */
export function validarMarca(raw: Readonly<Record<string, unknown>>): StorefrontMarcaInput {
  const red = (clave: "instagramUrl" | "facebookUrl" | "tiktokUrl"): string | null => {
    const { re, nombre } = RED_RE[clave];
    return url(raw[clave], nombre, MARCA_LIMITES.red, re, `escribe un enlace https del perfil de ${nombre} (por ejemplo https://${nombre.toLowerCase()}.com/tu_restaurante).`);
  };
  return {
    titular: texto(raw.titular, "titular", MARCA_LIMITES.titular),
    eslogan: texto(raw.eslogan, "eslogan", MARCA_LIMITES.eslogan),
    about: texto(raw.about, "descripción", MARCA_LIMITES.about, true),
    portadaUrl: url(raw.portadaUrl, "imagen de portada", MARCA_LIMITES.url, HTTPS_RE, "escribe un enlace https válido a la imagen."),
    logoUrl: url(raw.logoUrl, "logo", MARCA_LIMITES.url, HTTPS_RE, "escribe un enlace https válido a la imagen."),
    instagramUrl: red("instagramUrl"),
    facebookUrl: red("facebookUrl"),
    tiktokUrl: red("tiktokUrl"),
  };
}

/** wa.me del boton flotante: solo el numero de la sucursal y un texto prellenado (sin datos del cliente). null = no hay numero valido. */
export function enlaceWhatsapp(telefono: string | null, textoPrellenado: string): string | null {
  if (!telefono) return null;
  const destino = toWhatsAppRecipient(telefono);
  if (!destino) return null;
  return `https://wa.me/${destino.slice(1)}?text=${encodeURIComponent(textoPrellenado.slice(0, 300))}`;
}

// ---- Promociones visibles en el storefront --------------------------------------------------------------------------

export interface StorefrontPromocionView {
  readonly id: string;
  readonly nombre: string;
  readonly descripcion: string | null;
  /** Lo que el cliente recibe, en una frase corta: "2x1", "15% de descuento", "$50 de descuento", "Cortesía incluida". */
  readonly beneficio: string;
  /** Siempre `recoger`: el checkout web aplica promociones solo a pedidos para recoger (assertWebOrderRules). */
  readonly canal: "recoger";
  readonly pedidoMinimo: number | null;
  /** 0=domingo..6=sabado; null = todos los dias. */
  readonly dias: readonly number[] | null;
  readonly horaInicio: string | null;
  readonly horaFin: string | null;
  readonly vigenteHasta: string | null;
  /** Slugs de las sucursales donde vale; null = todas. */
  readonly sucursales: readonly string[] | null;
}

function beneficioDe(p: Promotion): string {
  switch (p.type) {
    case "bogo":
      return "2x1";
    case "percentage":
      return `${Number.isInteger(p.value) ? p.value : p.value.toFixed(2)}% de descuento`;
    case "fixed":
      return `$${Number.isInteger(p.value) ? p.value : p.value.toFixed(2)} de descuento`;
    case "cortesia":
      return "Cortesía incluida";
  }
}

/**
 * Promociones que el motor de pedidos aplica SOLAS a un pedido web para recoger, vigentes hoy. Solo `autoApply`: una promocion
 * por codigo no se anuncia (el codigo no es publico) y una con canal solo a domicilio no vale en el checkout web. Nunca promete
 * algo que `assertPromotionApplicable` no aplique: se filtra por activa, inicio/fin, usos agotados y canal recoger. Las
 * restricciones de dia/hora/sucursal NO la ocultan (el motor las evalua al cotizar): se muestran como parte de la oferta.
 */
export async function buildStorefrontPromociones(
  repo: RestaurantesRepository,
  organizationId: string,
  sucursales: ReadonlyArray<{ readonly slug: string; readonly propertyId: string }>,
  now: Date = new Date(),
): Promise<StorefrontPromocionView[]> {
  const promos = await repo.listPromotions(organizationId);
  const vistas: StorefrontPromocionView[] = [];
  for (const p of promos) {
    if (!p.isActive || !p.autoApply) continue;
    if (p.startsAt && now.getTime() < new Date(p.startsAt).getTime()) continue;
    if (p.endsAt && now.getTime() > new Date(p.endsAt).getTime()) continue;
    if (p.maxUses !== null && p.timesUsed >= p.maxUses) continue;
    if (p.channels && p.channels.length > 0 && !p.channels.includes("recoger")) continue;
    let slugs: string[] | null = null;
    if (p.propertyIds != null) {
      slugs = sucursales.filter((s) => p.propertyIds!.includes(s.propertyId)).map((s) => s.slug);
      if (slugs.length === 0) continue; // vale solo en sucursales que ya no estan activas
    }
    vistas.push({
      id: p.id,
      nombre: p.name,
      descripcion: p.description,
      beneficio: beneficioDe(p),
      canal: "recoger",
      pedidoMinimo: p.minOrderTotal,
      dias: p.daysOfWeek && p.daysOfWeek.length > 0 ? [...p.daysOfWeek].sort((a, b) => a - b) : null,
      horaInicio: p.startTime,
      horaFin: p.endTime,
      vigenteHasta: p.endsAt,
      sucursales: slugs,
    });
  }
  return vistas;
}

// ---- Solicitud publica de evento / catering (R-43) -------------------------------------------------------------------

export const EVENTO_LIMITES = { nombre: 120, comentario: 1000, personasMax: 2000, diasAdelanteMax: 730 } as const;

function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);
}

export interface SolicitudEventoValidada extends SolicitudEventoInput {
  /** Texto que se guarda en `callback_requests.message` (fecha, personas, sucursal, comentario, aviso aceptado). */
  readonly mensaje: string;
}

/**
 * Valida estrictamente el cuerpo publico. El honeypot (`sitio_web`) NO se valida aqui: la ruta lo revisa antes y responde como
 * si hubiera funcionado sin crear nada. `hoy` es la fecha local del negocio (YYYY-MM-DD).
 */
export function validarSolicitudEvento(raw: Readonly<Record<string, unknown>>, hoy: string): SolicitudEventoValidada {
  const nombre = texto(raw.nombre, "nombre", EVENTO_LIMITES.nombre);
  if (!nombre || nombre.length < 2) throw new StorefrontValidationError("Escribe tu nombre.");
  const telefono = typeof raw.telefono === "string" ? canonicalizeMexicanPhone(raw.telefono) : null;
  if (!telefono) throw new StorefrontValidationError("Escribe un teléfono de 10 dígitos para contactarte.");
  const fecha = typeof raw.fechaEvento === "string" ? raw.fechaEvento : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || Number.isNaN(Date.parse(`${fecha}T00:00:00Z`)) || new Date(`${fecha}T00:00:00Z`).toISOString().slice(0, 10) !== fecha) {
    throw new StorefrontValidationError("Elige la fecha del evento.");
  }
  const dias = diasEntre(hoy, fecha);
  if (dias < 0) throw new StorefrontValidationError("La fecha del evento ya pasó.");
  if (dias > EVENTO_LIMITES.diasAdelanteMax) throw new StorefrontValidationError("La fecha del evento está demasiado lejos.");
  const personas = raw.personas;
  if (typeof personas !== "number" || !Number.isInteger(personas) || personas < 1 || personas > EVENTO_LIMITES.personasMax) {
    throw new StorefrontValidationError(`Indica cuántas personas serán (de 1 a ${EVENTO_LIMITES.personasMax}).`);
  }
  const sucursalSlug = typeof raw.sucursal === "string" && /^[a-z0-9-]{1,80}$/.test(raw.sucursal) ? raw.sucursal : null;
  if (!sucursalSlug) throw new StorefrontValidationError("Elige la sucursal.");
  const comentario = texto(raw.comentario, "comentario", EVENTO_LIMITES.comentario, true);
  if (raw.aceptaAviso !== true) throw new StorefrontValidationError("Debes aceptar el aviso de privacidad para enviar la solicitud.");
  const mensaje = [`Fecha del evento: ${fecha}`, `Personas: ${personas}`, ...(comentario ? [`Comentario: ${comentario}`] : []), "Aviso de privacidad aceptado."].join("\n");
  return { nombre, telefono, fechaEvento: fecha, personas, sucursalSlug, comentario, mensaje };
}
