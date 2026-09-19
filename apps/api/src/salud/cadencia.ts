// Deriva la cadencia esperada (minutos) de cada cron desde `vercel.json`
// (raíz del repo) -- NUNCA hardcodeada a mano en un segundo sitio: agregar
// un cron nuevo a `vercel.json` es lo único que hace falta para que
// `/superadmin/salud` sepa su cadencia esperada (hasta que corra una vez,
// aparece como `sin_latido`, ver `./motor.ts::juzgarLatido`).
//
// `vercel.json` se importa como módulo JSON (`resolveJsonModule`, ver
// `packages/config/tsconfig.base.json`) -- esbuild (`scripts/build-vercel-
// function.mjs`) lo inlinea como objeto literal en el bundle de producción
// en BUILD time, así que en runtime (la función serverless real) no hay
// ninguna lectura de archivo -- import estático común y corriente, resuelto
// por el bundler igual que cualquier otro import del árbol.
import vercelConfig from "../../../../vercel.json" with { type: "json" };

interface VercelCronEntry {
  readonly path: string;
  readonly schedule: string;
}

interface VercelConfigShape {
  readonly crons?: readonly VercelCronEntry[];
}

type CampoCron = "wildcard" | "unsupported" | { readonly step: number } | { readonly fixed: number };

function parseCampo(campo: string, max: number): CampoCron {
  if (campo === "*") return "wildcard";
  const step = /^\*\/(\d+)$/.exec(campo);
  if (step) {
    const valor = Number(step[1]);
    return valor > 0 ? { step: valor } : "unsupported";
  }
  const fijo = Number(campo);
  if (Number.isInteger(fijo) && fijo >= 0 && fijo <= max) return { fixed: fijo };
  // Listas ("1,2,3") y rangos ("1-5") -- fuera del alcance soportado hoy (los
  // 17 crons reales de vercel.json son todos "M H * * *", un minuto y una
  // hora fijos). Deliberadamente NUNCA se trata como comodín (`*`): una
  // lista/rango es una restricción real, no "cualquier valor", así que
  // confundirla con comodín podría INFLAR la cadencia derivada (p. ej. "5-7"
  // no es "cada hora"). `"unsupported"` fuerza el `return 0` de abajo --
  // cadencia no determinable, nunca un número inventado.
  return "unsupported";
}

function esFijo(campo: CampoCron): campo is { readonly fixed: number } {
  return typeof campo === "object" && "fixed" in campo;
}
function esStep(campo: CampoCron): campo is { readonly step: number } {
  return typeof campo === "object" && "step" in campo;
}

/**
 * Minutos esperados entre corridas de una expresión cron de 5 campos
 * (`minuto hora día-mes mes día-semana`, sintaxis estándar de Vercel Cron).
 * `0` = cadencia NO determinable con las reglas de abajo -- el cron nunca se
 * declara `vencido` en ese caso (ver `./motor.ts::juzgarLatido`), nunca se
 * inventa un número.
 *
 * Cobertura deliberada (suficiente para los 17 crons reales de
 * `vercel.json`, todos diarios con minuto/hora fijos): día-mes/mes/
 * día-semana deben ser `*` (soporte de granularidad semanal/mensual fuera de
 * alcance hoy); minuto/hora pueden ser fijo, comodín, o un step (asterisco
 * seguido de barra y N, p. ej. cada 15 minutos).
 */
export function minutosEsperadosDeCron(expresion: string): number {
  const partes = expresion.trim().split(/\s+/);
  if (partes.length !== 5) return 0;
  const [minuto, hora, diaMes, mes, diaSemana] = partes as [string, string, string, string, string];
  if (diaMes !== "*" || mes !== "*" || diaSemana !== "*") return 0;

  const minutoP = parseCampo(minuto, 59);
  const horaP = parseCampo(hora, 23);

  if (esFijo(horaP) && esFijo(minutoP)) return 24 * 60; // diario a una hora:minuto fijos
  if (horaP === "wildcard" && esFijo(minutoP)) return 60; // cada hora, en un minuto fijo
  if (esStep(horaP) && esFijo(minutoP)) return horaP.step * 60; // cada N horas
  if (horaP === "wildcard" && esStep(minutoP)) return minutoP.step; // cada N minutos
  if (esFijo(horaP) && esStep(minutoP)) return minutoP.step; // dentro de una hora fija, cada N minutos (caso raro, cubierto por completitud)
  return 0;
}

/** Mapa `path -> minutos esperados`, derivado de `vercel.json::crons`. Llave
 *  = el `path` EXACTO (mismo valor que `cronName` en `core.cron_heartbeat`,
 *  ver `./with-heartbeat.ts`). */
export function cadenciaMinutosPorRuta(): Readonly<Record<string, number>> {
  const crons = (vercelConfig as VercelConfigShape).crons ?? [];
  const mapa: Record<string, number> = {};
  for (const cron of crons) mapa[cron.path] = minutosEsperadosDeCron(cron.schedule);
  return mapa;
}

/** Lista de paths de cron declarados en `vercel.json` -- usada por el
 *  resumen de `/superadmin/salud` para saber cuántos crons DEBERÍAN existir
 *  (incluidos los que todavía no registraron ni un latido). */
export function rutasDeCronDeclaradas(): readonly string[] {
  const crons = (vercelConfig as VercelConfigShape).crons ?? [];
  return crons.map((c) => c.path);
}
