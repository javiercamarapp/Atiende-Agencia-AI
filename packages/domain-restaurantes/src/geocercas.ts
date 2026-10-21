// Paquete B: cobertura geografica. Punto en poligono (ray casting) sobre las geocercas de reparto de cada sucursal. Funciones puras.
// Convencion: los vertices vienen como [lng, lat] (orden KML) y los puntos se pasan como (lat, lng).

export interface Geocerca {
  /** Slug de la sucursal que reparte dentro del poligono. */
  readonly slug: string;
  readonly poligono: readonly (readonly [number, number])[];
}

export const GEOCERCA_SIN_ZONA_MENSAJE =
  "La ubicación del cliente no cae en ninguna zona de reparto conocida. Dígalo con honestidad y sin prometer el envío; ofrezca recoger en sucursal y pase con una persona UNA sola vez " +
  "(escalar_a_humano, motivo zona_no_reconocida) para que confirme. No adivine la sucursal ni invente un teléfono.";

/** `true` si (lat, lng) esta dentro del poligono. Entradas no finitas o poligono con menos de 3 vertices distintos: `false`. */
export function puntoEnPoligono(lat: number, lng: number, poligono: readonly (readonly [number, number])[]): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || poligono.length < 4) return false;
  let dentro = false;
  for (let i = 0, j = poligono.length - 1; i < poligono.length; j = i, i += 1) {
    const [xi, yi] = poligono[i] as readonly [number, number];
    const [xj, yj] = poligono[j] as readonly [number, number];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

/** Slugs (orden estable por slug) de las geocercas que contienen el punto. */
export function geocercasQueContienen(lat: number, lng: number, geocercas: readonly Geocerca[]): readonly string[] {
  return geocercas
    .filter((g) => puntoEnPoligono(lat, lng, g.poligono))
    .map((g) => g.slug)
    .sort((a, b) => a.localeCompare(b));
}

/** Holgura (m) para puntos que caen en una rendija entre dos zonas dibujadas a mano o en su borde: se asignan a la zona mas cercana en vez de decir "ninguna zona". */
export const GEOCERCA_TOLERANCIA_M = 60;

export const GEOCERCA_COLONIA_SIN_PIN_MENSAJE =
  "No tengo ubicada esa colonia con certeza: no afirme ni niegue el reparto ni diga qué sucursal la atiende. Pídale UNA sola vez su ubicación de WhatsApp (pin) y vuelva a llamar esta herramienta; " +
  "si no puede compartirla, dígale que la sucursal le confirma la cobertura, ofrezca recoger en sucursal y pase con una persona UNA vez (escalar_a_humano, motivo zona_no_reconocida).";

const M_POR_GRADO_LAT = 111_320;

/** Distancia minima (m) de (lat, lng) al poligono; 0 si esta dentro o en el borde. Aproximacion plana local: suficiente a escala de ciudad. */
export function distanciaAPoligonoM(lat: number, lng: number, poligono: readonly (readonly [number, number])[]): number {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || poligono.length < 4) return Number.POSITIVE_INFINITY;
  if (puntoEnPoligono(lat, lng, poligono)) return 0;
  const kx = M_POR_GRADO_LAT * Math.cos((lat * Math.PI) / 180);
  let mejor = Number.POSITIVE_INFINITY;
  for (let i = 0; i < poligono.length - 1; i += 1) {
    const [x1, y1] = poligono[i] as readonly [number, number];
    const [x2, y2] = poligono[i + 1] as readonly [number, number];
    const ax = (x1 - lng) * kx;
    const ay = (y1 - lat) * M_POR_GRADO_LAT;
    const bx = (x2 - lng) * kx;
    const by = (y2 - lat) * M_POR_GRADO_LAT;
    const dx = bx - ax;
    const dy = by - ay;
    const largo2 = dx * dx + dy * dy;
    const t = largo2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / largo2));
    mejor = Math.min(mejor, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return mejor;
}

export interface GeocercaCercana {
  readonly slug: string;
  /** 0 = dentro (o en el borde); > 0 = en la rendija, a esa distancia del borde. */
  readonly distanciaM: number;
}

/** Geocercas que contienen el punto o lo tienen a `toleranciaM` o menos, de la mas cercana a la mas lejana (empate por slug). */
export function geocercasCercanas(lat: number, lng: number, geocercas: readonly Geocerca[], toleranciaM: number = GEOCERCA_TOLERANCIA_M): readonly GeocercaCercana[] {
  return geocercas
    .map((g) => ({ slug: g.slug, distanciaM: distanciaAPoligonoM(lat, lng, g.poligono) }))
    .filter((g) => g.distanciaM <= toleranciaM)
    .sort((a, b) => a.distanciaM - b.distanciaM || a.slug.localeCompare(b.slug));
}

/** Mensaje cuando el pin cae en la zona de una sucursal que NO esta disponible para domicilio en el sistema (inactiva, sin domicilio o no cargada). */
export function mensajeGeocercaSucursalNoDisponible(nombre: string, telefono: string | null): string {
  const tel = telefono ? ` Su teléfono de la configuración: ${telefono}.` : " No hay teléfono cargado: no lo invente; la sucursal se lo confirma.";
  return (
    `La ubicación del cliente cae en la zona de ${nombre}, pero esa sucursal no está disponible para domicilio por este medio.${tel} ` +
    `No prometa el envío ni diga que está fuera de nuestras zonas: ofrezca recoger en sucursal y pase con una persona UNA vez (escalar_a_humano, motivo zona_no_reconocida).`
  );
}

/** Aviso al derivar a otra sucursal: desde aquí no se puede verificar su horario ni si tiene asistente; nunca mandar al cliente a una sucursal cerrada sin avisar. */
export const GEOCERCA_AVISO_DERIVAR =
  " Al derivarlo, dígale que confirme con esa sucursal si ya está abierta y su horario de reparto (no se puede verificar desde aquí si está abierta ahora ni si esa sucursal tiene asistente): no lo mande sin ese aviso.";

/** Bandera de las geocercas (APAGADA por omision, como los pines propuestos): `RESTAURANTES_GEOCERCAS=1` las enciende SOLO en el perfil `taqueria_pm`. Activarla es decision de Javier:
 * el poligono pasa a mandar sobre el radio de 8 km y sobre la cobertura por colonia cuando el cliente comparte su pin. */
export const BANDERA_GEOCERCAS = "RESTAURANTES_GEOCERCAS";

export function geocercasActivas(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[BANDERA_GEOCERCAS] === "1";
}
