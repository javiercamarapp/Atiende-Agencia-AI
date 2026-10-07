// Utilidades comunes de los scripts de activacion de voz (Twilio, LiveKit): lectura de banderas, salida sin secretos y un reporte de pasos.
// Los scripts son IDEMPOTENTES y arrancan en ENSAYO: sin `--ejecutar` solo LEEN (si hay credenciales) y cuentan lo que harian.

export type EstadoPaso = "ya_existia" | "se_haria" | "hecho" | "bloqueado" | "error";

export interface Paso {
  readonly paso: string;
  readonly estado: EstadoPaso;
  readonly detalle: string;
}

export interface BanderasComunes {
  /** `true` salvo que se pase `--ejecutar`. */
  readonly dryRun: boolean;
  readonly valores: ReadonlyMap<string, string>;
  readonly interruptores: ReadonlySet<string>;
}

/** `--ejecutar`, `--dry-run` y `--clave=valor` / `--interruptor`. Una bandera desconocida lanza (un error de dedo no debe gastar dinero). */
export function leerBanderas(args: readonly string[], conocidas: { readonly valores: readonly string[]; readonly interruptores: readonly string[] }): BanderasComunes {
  const valores = new Map<string, string>();
  const interruptores = new Set<string>();
  let dryRun = true;
  for (const arg of args) {
    if (arg === "--ejecutar") {
      dryRun = false;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error(`Argumento no valido: ${arg}`);
    const nombre = m[1] as string;
    if (m[2] !== undefined && conocidas.valores.includes(nombre)) valores.set(nombre, m[2]);
    else if (m[2] === undefined && conocidas.interruptores.includes(nombre)) interruptores.add(nombre);
    else throw new Error(`Bandera desconocida o mal usada: --${nombre}`);
  }
  return { dryRun, valores, interruptores };
}

const lleno = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "";

/** Variables de entorno obligatorias: devuelve las que faltan (solo nombres). */
export function faltantes(env: Readonly<Record<string, string | undefined>>, nombres: readonly string[]): string[] {
  return nombres.filter((n) => !lleno(env[n]));
}

/** Quita de un texto cualquier valor secreto conocido (por si una respuesta de la API lo repite). */
export function sinSecretos(texto: string, secretos: readonly (string | undefined)[]): string {
  let limpio = texto;
  for (const s of secretos) if (lleno(s) && s.length >= 4) limpio = limpio.split(s).join("***");
  return limpio;
}

export function imprimirPasos(titulo: string, pasos: readonly Paso[], dryRun: boolean): string {
  const marca: Record<EstadoPaso, string> = { ya_existia: "[ya existe]", se_haria: "[se haria]", hecho: "[hecho]", bloqueado: "[BLOQUEADO]", error: "[ERROR]" };
  const lineas = [`${titulo} (${dryRun ? "ENSAYO: no se cambio nada" : "EJECUTADO"})`, ...pasos.map((p) => `  ${marca[p.estado]} ${p.paso}: ${p.detalle}`)];
  return lineas.join("\n");
}

export function hayError(pasos: readonly Paso[]): boolean {
  return pasos.some((p) => p.estado === "error" || p.estado === "bloqueado");
}
