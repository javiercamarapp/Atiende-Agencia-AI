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
