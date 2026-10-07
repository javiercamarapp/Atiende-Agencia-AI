// Coordenadas de sucursal (import-orig-13): lectura de lo que el dueño pega desde Google Maps, validación
// de rango y enlace para comprobar el punto. Lógica pura, sin red ni fechas.
//
// El rango es el de Yucatán a propósito: una coordenada capturada a mano fue la causa de bugs reales en el
// original (Altabrisa mal ruteada), y un número fuera de la región casi siempre es lat/lng al revés o un
// signo perdido. NO se siembra ninguna coordenada: el dato lo confirma el dueño con un pin.

export const LAT_MIN = 20;
export const LAT_MAX = 22;
export const LNG_MIN = -91;
export const LNG_MAX = -87;

export interface Coordenadas {
  readonly lat: number;
  readonly lng: number;
}

const NUM = "(-?\\d{1,3}(?:\\.\\d+)?)";
// "21.0280, -89.6100" (con o sin espacio, con o sin paréntesis alrededor)
const PAR_PLANO = new RegExp(`^\\(?\\s*${NUM}\\s*,\\s*${NUM}\\s*\\)?$`);
// Google Maps: ".../@21.0280,-89.6100,17z"
const PAR_ARROBA = new RegExp(`@${NUM},${NUM}(?:[,/?]|$)`);
// Google Maps (pin colocado): "...!3d21.0280!4d-89.6100"
const PAR_DATA = new RegExp(`!3d${NUM}!4d${NUM}`);
// "?q=21.0280,-89.6100" o "?ll=..." / "&query=..."
const PAR_QUERY = new RegExp(`[?&](?:q|ll|query|center)=${NUM}(?:,|%2C)${NUM}(?:[&#]|$)`, "i");

/** Interpreta el texto pegado. Devuelve null si no reconoce un par lat,lng (no valida el rango). */
export function interpretarCoordenadasPegadas(texto: string): Coordenadas | null {
  const t = texto.trim();
  if (t === "") return null;
  // El pin explícito (!3d!4d) es más fiable que el centro del mapa (@): va primero.
  for (const re of [PAR_PLANO, PAR_DATA, PAR_ARROBA, PAR_QUERY]) {
    const m = re.exec(t);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
  }
  return null;
}

export interface ResultadoCampo {
  readonly valor: number | null;
  readonly error: string | null;
}

/** Texto de un campo -> número (null si está vacío) o mensaje de error en español. */
export function leerCoordenada(texto: string, eje: "lat" | "lng"): ResultadoCampo {
  const t = texto.trim();
  if (t === "") return { valor: null, error: null };
  if (!/^-?\d{1,3}(?:\.\d+)?$/.test(t)) {
    return { valor: null, error: eje === "lat" ? "La latitud debe ser un número con punto decimal, por ejemplo 21.0280." : "La longitud debe ser un número con punto decimal, por ejemplo -89.6100." };
  }
  const n = Number(t);
  if (eje === "lat" && (n < LAT_MIN || n > LAT_MAX)) {
    return { valor: n, error: `La latitud debe estar entre ${LAT_MIN} y ${LAT_MAX} (Yucatán). ¿Invertiste latitud y longitud?` };
  }
  if (eje === "lng" && (n < LNG_MIN || n > LNG_MAX)) {
    return { valor: n, error: `La longitud debe estar entre ${LNG_MIN} y ${LNG_MAX} (Yucatán). ¿Falta el signo menos?` };
  }
  return { valor: n, error: null };
}

export interface ValidacionPar {
  readonly lat: number | null;
  readonly lng: number | null;
  readonly errorLat: string | null;
  readonly errorLng: string | null;
}

/** Valida el par: cada eje en su rango y los dos juntos o los dos vacíos (un solo eje no sirve para ubicar). */
export function validarPar(latTexto: string, lngTexto: string): ValidacionPar {
  const a = leerCoordenada(latTexto, "lat");
  const b = leerCoordenada(lngTexto, "lng");
  let errorLat = a.error;
  let errorLng = b.error;
  if (!errorLat && !errorLng) {
    if (a.valor !== null && b.valor === null) errorLng = "Falta la longitud: la ubicación necesita latitud y longitud.";
    if (a.valor === null && b.valor !== null) errorLat = "Falta la latitud: la ubicación necesita latitud y longitud.";
  }
  return { lat: a.valor, lng: b.valor, errorLat, errorLng };
}

/** Enlace para comprobar el punto en el mapa. Sin coordenadas, null. */
export function urlVerEnMapa(lat: number | null, lng: number | null): string | null {
  if (lat === null || lng === null) return null;
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

export function textoCoordenada(n: number | null): string {
  return n === null ? "" : String(n);
}
