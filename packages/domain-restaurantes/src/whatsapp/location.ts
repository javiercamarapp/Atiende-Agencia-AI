// Ubicacion compartida por WhatsApp (mensaje `type: "location"` de Meta Cloud API). Hasta ahora el
// webhook solo leia mensajes de texto, asi que la ubicacion "actual" que el cliente manda con el
// clip de WhatsApp se perdia en silencio y la asignacion de sucursal por km (branch-assignment.ts)
// nunca recibia coordenadas.
//
// Diseno: la ubicacion NO se guarda en una columna nueva -- se escribe en el historial de la
// conversacion como un marcador de texto estable (el mensaje del cliente, ya persistido por el flujo
// existente) y se vuelve a leer de ahi en cada turno. Asi no hay SQL nuevo y funciona contra la
// base sin migrar. Minimizacion de datos: el marcador solo transporta coordenadas; el nombre y la
// direccion que Meta puede adjuntar al mensaje NO se persisten en el historial.

export interface SharedLocation {
  readonly lat: number;
  readonly lng: number;
}

export interface MetaLocationMessage {
  readonly id: string;
  readonly from: string;
  readonly type: "location";
  readonly location: { readonly latitude: number; readonly longitude: number };
}

const MARKER = "[Ubicación compartida por WhatsApp]";
const MARKER_RE = /^\[Ubicación compartida por WhatsApp\] lat=(-?\d{1,2}(?:\.\d{1,8})?) lng=(-?\d{1,3}(?:\.\d{1,8})?)/;

export function isValidCoordinate(lat: unknown, lng: unknown): boolean {
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/** Texto que se guarda como mensaje del cliente (y que ve el modelo) para una ubicacion compartida. */
export function formatLocationMessage(location: MetaLocationMessage["location"]): string {
  const lat = location.latitude.toFixed(6);
  const lng = location.longitude.toFixed(6);
  return `${MARKER} lat=${lat} lng=${lng}`;
}

/** Coordenadas de un mensaje con el marcador de ubicacion; `null` si no lo es o son invalidas. */
export function parseSharedLocation(content: string): SharedLocation | null {
  const match = MARKER_RE.exec(content);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return isValidCoordinate(lat, lng) ? { lat, lng } : null;
}

/** Ubicacion MAS RECIENTE que el cliente compartio en la conversacion (solo mensajes del cliente). */
export function latestSharedLocation(messages: readonly { readonly role: string; readonly content: string }[]): SharedLocation | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    const found = parseSharedLocation(message.content);
    if (found) return found;
  }
  return null;
}

// ── Pin para el repartidor (chats reales de T7) ──────────────────────────────────────────────────────────
// El cliente comparte el pin de WhatsApp o pega un link de Google Maps. En ambos casos el destino viaja con el pedido
// (nota estructurada, sin columna nueva) y el repartidor lo abre en Maps en vez de adivinar por la direccion escrita.
// Un link corto (maps.app.goo.gl) NO trae coordenadas y NO se sigue por la red: se guarda tal cual como enlace.

export type UbicacionEntrega =
  | { readonly fuente: "pin" | "link"; readonly lat: number; readonly lng: number }
  | { readonly fuente: "link_corto"; readonly url: string };

const MAPS_HOSTS = new Set(["maps.app.goo.gl", "goo.gl", "google.com", "www.google.com", "maps.google.com", "www.google.com.mx", "google.com.mx", "maps.google.com.mx"]);
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const COORD = "(-?\\d{1,2}(?:\\.\\d{1,10})?)\\s*,\\s*(-?\\d{1,3}(?:\\.\\d{1,10})?)";
const COORD_PATRONES: readonly RegExp[] = [
  new RegExp(`@${COORD}`),
  new RegExp(`[?&](?:q|query|ll|daddr|destination)=${COORD}`),
  /!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/,
];

/** Quita la puntuacion que el cliente pego al final del enlace (sin regex con backtracking). */
function sinPuntuacionFinal(texto: string): string {
  let fin = texto.length;
  while (fin > 0 && ".,;:!?".includes(texto[fin - 1]!)) fin -= 1;
  return texto.slice(0, fin);
}

function esLinkDeMaps(url: URL): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (!MAPS_HOSTS.has(url.hostname.toLowerCase())) return false;
  const host = url.hostname.toLowerCase();
  if (host === "maps.app.goo.gl" || host === "maps.google.com" || host === "maps.google.com.mx") return true;
  // goo.gl solo es de Maps con /maps; google.com solo con /maps
  return url.pathname.toLowerCase().startsWith("/maps");
}

/** Ubicacion de un link de Google Maps dentro de un texto: coordenadas si el link las trae; el enlace corto tal cual si no; `null` si no hay link de Maps. */
export function parseMapsLink(texto: string): UbicacionEntrega | null {
  for (const candidato of texto.match(URL_RE) ?? []) {
    let url: URL;
    try {
      url = new URL(sinPuntuacionFinal(candidato));
    } catch {
      continue;
    }
    if (!esLinkDeMaps(url)) continue;
    const decodificado = decodeURIComponent(`${url.pathname}${url.search}`.replace(/%(?![0-9a-f]{2})/gi, "%25"));
    for (const patron of COORD_PATRONES) {
      const m = patron.exec(decodificado);
      if (!m) continue;
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (isValidCoordinate(lat, lng)) return { fuente: "link", lat, lng };
    }
    if (url.hostname.toLowerCase() === "maps.app.goo.gl" || url.hostname.toLowerCase() === "goo.gl") {
      const corto = `https://${url.hostname.toLowerCase()}${url.pathname}`;
      if (corto.length <= 120 && url.pathname.length > 1) return { fuente: "link_corto", url: corto };
    }
  }
  return null;
}

/** Destino de entrega MAS RECIENTE que dio el cliente (pin de WhatsApp o link de Maps), leyendo solo sus mensajes y solo los del pedido EN CURSO:
 * la fila de la conversacion es una por telefono y acumula todos los pedidos del cliente, asi que la busqueda se detiene en el mensaje del asistente
 * marcado `pedidoCreado` (el pin de un pedido anterior, por ejemplo el de la oficina de ayer, NO viaja al pedido nuevo con otra direccion). */
export function latestDeliveryPin(messages: readonly { readonly role: string; readonly content: string; readonly pedidoCreado?: boolean }[]): UbicacionEntrega | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "assistant" && message.pedidoCreado === true) return null;
    if (message.role !== "user") continue;
    const pin = parseSharedLocation(message.content);
    if (pin) return { fuente: "pin", lat: pin.lat, lng: pin.lng };
    const link = parseMapsLink(message.content);
    if (link) return link;
  }
  return null;
}

const NOTA_PIN_RE = /^Ubicación de entrega \(pin de WhatsApp\): lat=(-?\d{1,2}(?:\.\d+)?) lng=(-?\d{1,3}(?:\.\d+)?)\.$/m;
const NOTA_LINK_RE = /^Ubicación de entrega \(enlace de Maps\): lat=(-?\d{1,2}(?:\.\d+)?) lng=(-?\d{1,3}(?:\.\d+)?)\.$/m;
const NOTA_CORTO_RE = /^Ubicación de entrega \(enlace corto de Maps\): (https:\/\/(?:maps\.app\.goo\.gl\/|goo\.gl\/maps)\S*)/m;

/** Linea de la comanda/notas del pedido que lleva el destino al repartidor. */
export function formatUbicacionEntregaNota(u: UbicacionEntrega): string {
  if (u.fuente === "link_corto") return `Ubicación de entrega (enlace corto de Maps): ${u.url}`;
  const etiqueta = u.fuente === "pin" ? "pin de WhatsApp" : "enlace de Maps";
  return `Ubicación de entrega (${etiqueta}): lat=${u.lat.toFixed(6)} lng=${u.lng.toFixed(6)}.`;
}

/** Inverso de `formatUbicacionEntregaNota` sobre las notas de un pedido (la vista del repartidor usa la misma lectura, duplicada en apps/web). */
export function parseUbicacionEntregaNota(notes: string | null | undefined): UbicacionEntrega | null {
  if (!notes) return null;
  const pin = NOTA_PIN_RE.exec(notes);
  if (pin && isValidCoordinate(Number(pin[1]), Number(pin[2]))) return { fuente: "pin", lat: Number(pin[1]), lng: Number(pin[2]) };
  const link = NOTA_LINK_RE.exec(notes);
  if (link && isValidCoordinate(Number(link[1]), Number(link[2]))) return { fuente: "link", lat: Number(link[1]), lng: Number(link[2]) };
  const corto = NOTA_CORTO_RE.exec(notes);
  if (corto) return { fuente: "link_corto", url: sinPuntuacionFinal(corto[1]!) };
  return null;
}
