// R-11 -- tiempo real del panel de pedidos por SONDEO (polling) sin spamear al servidor. Funciones puras
// (testeables sin DOM) + preferencia de sonido. El hook que las usa vive en use-sondeo-pedidos.ts.
//
// Reglas: intervalo base de 20 s; cada fallo seguido DUPLICA la espera hasta un tope de 2 min (backoff) y un
// exito la restablece; con la pestana oculta no se consulta (al volver se consulta de inmediato); nunca hay dos
// consultas simultaneas; se encadena un setTimeout despues de cada consulta (no un setInterval que se acumula).

export const SONDEO_BASE_MS = 20_000;
export const SONDEO_MAX_MS = 120_000;

/** Espera antes de la siguiente consulta: `base` sin fallos; se duplica por cada fallo seguido hasta `max`. */
export function siguienteIntervaloMs(fallosSeguidos: number, base: number = SONDEO_BASE_MS, max: number = SONDEO_MAX_MS): number {
  const fallos = Math.max(0, Math.floor(fallosSeguidos));
  // 2 ** 30 ya excede cualquier tope razonable: se acota el exponente para no llegar a Infinity.
  return Math.min(max, base * 2 ** Math.min(fallos, 30));
}

/** Ids de `actuales` que no estaban en `vistos`. `vistos === null` (primera consulta) NO cuenta nada como nuevo. */
export function idsNuevos(vistos: ReadonlySet<string> | null, actuales: readonly string[]): readonly string[] {
  if (vistos === null) return [];
  return actuales.filter((id) => !vistos.has(id));
}

/** "hace 8 s" / "hace 3 min"; `null` = aun no hay una consulta exitosa. */
export function etiquetaActualizado(ultimaMs: number | null, ahoraMs: number): string {
  if (ultimaMs === null) return "Sin actualizar todavía";
  const s = Math.max(0, Math.round((ahoraMs - ultimaMs) / 1000));
  if (s < 5) return "Actualizado ahora";
  if (s < 60) return `Actualizado hace ${s} s`;
  return `Actualizado hace ${Math.floor(s / 60)} min`;
}

/** "en 2 h 15 min" / "en 40 min" / "ya es la hora" para la cuenta regresiva de un pedido programado. */
export function faltaPara(programadoPara: string | null | undefined, ahoraMs: number): string | null {
  if (!programadoPara) return null;
  const objetivo = Date.parse(programadoPara);
  if (Number.isNaN(objetivo)) return null;
  const min = Math.ceil((objetivo - ahoraMs) / 60_000);
  if (min <= 0) return "ya es la hora";
  if (min < 60) return `en ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h >= 24) return `en ${Math.floor(h / 24)} d ${h % 24} h`;
  return m === 0 ? `en ${h} h` : `en ${h} h ${m} min`;
}

// ---- Preferencia de sonido (por organizacion + sucursal, en este navegador) ----

function claveSonido(orgSlug: string, propertyId: string): string {
  return `restaurantes:sonido-pedidos:${orgSlug}:${propertyId}`;
}

export function leerSonido(storage: Pick<Storage, "getItem"> | null, orgSlug: string, propertyId: string): boolean {
  try {
    return storage?.getItem(claveSonido(orgSlug, propertyId)) === "1";
  } catch {
    return false;
  }
}

export function guardarSonido(storage: Pick<Storage, "setItem"> | null, orgSlug: string, propertyId: string, activo: boolean): void {
  try {
    storage?.setItem(claveSonido(orgSlug, propertyId), activo ? "1" : "0");
  } catch {
    // Almacenamiento no disponible (modo privado, cuota): la preferencia solo dura la sesion.
  }
}

/** Aviso sonoro corto (dos tonos). Best-effort: sin audio disponible o bloqueado por el navegador, no hace nada. */
export function reproducirAviso(): void {
  try {
    const Ctx = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const tono = (frecuencia: number, inicio: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = frecuencia;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + inicio);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + inicio + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + inicio + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + inicio);
      osc.stop(ctx.currentTime + inicio + 0.3);
    };
    tono(880, 0);
    tono(1175, 0.3);
    window.setTimeout(() => void ctx.close().catch(() => undefined), 900);
  } catch {
    // Sin audio: el indicador visual sigue avisando.
  }
}
