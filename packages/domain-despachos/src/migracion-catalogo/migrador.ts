// Puerto de `b2b_ai/features/migracion_catalogo/migrador.py` + las guardias de
// cardinalidad de `service.py` (REQ-MIG-007/008) — decisión humana sobre un mapeo
// (aprobar/rechazar/editar) y migración transaccional de una póliza por remapeo de
// cuentas. Funciones puras: reciben el estado relevante ya cargado (mapeos
// existentes, líneas ya migradas) y devuelven el nuevo estado — la persistencia real
// (INSERT/UPDATE, transacciones) vive en la capa de repositorio/rutas HTTP, igual
// que el resto de `domain-despachos`.
import type { LineaPolizaOrigen, MapeoMigracionCuenta, PolizaOrigen, ResultadoMigracionPoliza } from "./types.ts";
import { DecisionSinResponsableError, DivisionUnoANoAutomaticaError, EstrategiaConciliacionRequeridaError, PolizaDesbalanceadaError, TransicionEstadoInvalidaError } from "./types.ts";

const ESTADOS_ACTIVOS = new Set<MapeoMigracionCuenta["estado"]>(["aprobado", "editado"]);

function esActivo(m: MapeoMigracionCuenta): boolean {
  return ESTADOS_ACTIVOS.has(m.estado);
}

/**
 * REQ-MIG-008 — guardia de cardinalidad, corrida ANTES de confirmar un
 * aprobar/editar. `otrosMapeos` debe excluir ya al propio mapeo que se está
 * decidiendo (el llamador filtra por id).
 *   - 1:N: la cuenta origen ya tiene otro mapeo ACTIVO hacia un destino DISTINTO del
 *     propuesto → rechazo total, sin excepción.
 *   - N:1: el destino propuesto ya recibe otra cuenta origen ACTIVA distinta → exige
 *     `estrategiaConciliacionSaldos` no vacío (ya en el mapeo o provisto ahora).
 */
export function validarCardinalidadAntesDeConfirmar(origenCuentaId: string, destinoCuentaIdPropuesto: string, otrosMapeos: readonly MapeoMigracionCuenta[], estrategiaConciliacionSaldos: string | null): void {
  const otroDestinoActivo = otrosMapeos.find((m) => esActivo(m) && m.origenCuentaId === origenCuentaId && m.destinoCuentaId !== null && m.destinoCuentaId !== destinoCuentaIdPropuesto);
  if (otroDestinoActivo) {
    throw new DivisionUnoANoAutomaticaError(origenCuentaId, otroDestinoActivo.destinoCuentaId!, destinoCuentaIdPropuesto);
  }

  const otroOrigenActivo = otrosMapeos.find((m) => esActivo(m) && m.destinoCuentaId === destinoCuentaIdPropuesto && m.origenCuentaId !== origenCuentaId);
  if (otroOrigenActivo) {
    if (!estrategiaConciliacionSaldos || estrategiaConciliacionSaldos.trim().length === 0) {
      throw new EstrategiaConciliacionRequeridaError(destinoCuentaIdPropuesto);
    }
  }
}

function requerirDecididoPor(decididoPor: string): void {
  if (!decididoPor || decididoPor.trim().length === 0) throw new DecisionSinResponsableError();
}

function requerirPendiente(mapeo: MapeoMigracionCuenta): void {
  if (mapeo.estado !== "pendiente") throw new TransicionEstadoInvalidaError(mapeo.estado);
}

export interface DecisionMapeoOpciones {
  readonly nota?: string | null;
  readonly estrategiaConciliacionSaldos?: string | null;
}

/** `aprobar()` — el mapeo debe tener ya un `destinoCuentaId` (viene del
 * clasificador); si no lo tiene (ej. un `sin_match` sin destino) no hay nada que
 * aprobar como está — usar `editar()` para asignarle uno. */
export function aprobarMapeo(mapeo: MapeoMigracionCuenta, decididoPor: string, opciones: DecisionMapeoOpciones, otrosMapeos: readonly MapeoMigracionCuenta[], ahora: string = new Date().toISOString()): MapeoMigracionCuenta {
  requerirDecididoPor(decididoPor);
  requerirPendiente(mapeo);

  const estrategia = opciones.estrategiaConciliacionSaldos ?? mapeo.estrategiaConciliacionSaldos ?? null;
  if (mapeo.destinoCuentaId) {
    validarCardinalidadAntesDeConfirmar(mapeo.origenCuentaId, mapeo.destinoCuentaId, otrosMapeos, estrategia);
  }

  return {
    ...mapeo,
    estado: "aprobado",
    aprobadoPor: decididoPor,
    aprobadoEn: ahora,
    nota: opciones.nota ?? mapeo.nota,
    estrategiaConciliacionSaldos: estrategia,
    updatedAt: ahora,
  };
}

/** `rechazar()` — nota obligatoria no vacía (a diferencia de aprobar/editar, donde
 * es opcional). Nunca dispara guardias de cardinalidad: un mapeo rechazado no
 * cuenta para ninguna cardinalidad. */
export function rechazarMapeo(mapeo: MapeoMigracionCuenta, decididoPor: string, nota: string, ahora: string = new Date().toISOString()): MapeoMigracionCuenta {
  requerirDecididoPor(decididoPor);
  requerirPendiente(mapeo);
  if (!nota || nota.trim().length === 0) throw new Error("nota es obligatoria para rechazar un mapeo.");

  return {
    ...mapeo,
    estado: "rechazado",
    aprobadoPor: decididoPor,
    aprobadoEn: ahora,
    nota,
    updatedAt: ahora,
  };
}

/** `editar()` — permite corregir el `destinoCuentaId` propuesto (ej. un
 * sin_match/fuzzy incorrecto) con nota obligatoria; también corre la guardia de
 * cardinalidad contra el destino EDITADO (no el original). */
export function editarMapeo(mapeo: MapeoMigracionCuenta, decididoPor: string, destinoCuentaId: string, nota: string, otrosMapeos: readonly MapeoMigracionCuenta[], estrategiaConciliacionSaldos?: string | null, ahora: string = new Date().toISOString()): MapeoMigracionCuenta {
  requerirDecididoPor(decididoPor);
  requerirPendiente(mapeo);
  if (!destinoCuentaId || destinoCuentaId.trim().length === 0) throw new Error("destinoCuentaId es obligatorio para editar un mapeo.");
  if (!nota || nota.trim().length === 0) throw new Error("nota es obligatoria para editar un mapeo.");

  const estrategia = estrategiaConciliacionSaldos ?? mapeo.estrategiaConciliacionSaldos ?? null;
  validarCardinalidadAntesDeConfirmar(mapeo.origenCuentaId, destinoCuentaId, otrosMapeos, estrategia);

  return {
    ...mapeo,
    destinoCuentaId,
    estado: "editado",
    aprobadoPor: decididoPor,
    aprobadoEn: ahora,
    nota,
    estrategiaConciliacionSaldos: estrategia,
    updatedAt: ahora,
  };
}

/**
 * Gap real del origen (documentado en la auditoría de esta fase): ningún archivo
 * Python construye la selección "mapeo activo más reciente por origen_cuenta_id" —
 * el docstring de `migrador.py` la describe pero no existe implementación. Se
 * escribe aquí explícitamente: para cada `origenCuentaId`, el mapeo NO rechazado
 * con `updatedAt` más reciente (empate → el de `createdAt` más reciente, empate →
 * el último de la lista de entrada).
 */
export function seleccionarMapeosActivosPorOrigen(mapeos: readonly MapeoMigracionCuenta[]): Map<string, MapeoMigracionCuenta> {
  const resultado = new Map<string, MapeoMigracionCuenta>();
  for (const m of mapeos) {
    if (m.estado === "rechazado") continue;
    const actual = resultado.get(m.origenCuentaId);
    if (!actual || m.updatedAt >= actual.updatedAt) {
      resultado.set(m.origenCuentaId, m);
    }
  }
  return resultado;
}

function mapeoMigrable(mapeo: MapeoMigracionCuenta | undefined): mapeo is MapeoMigracionCuenta & { destinoCuentaId: string } {
  return mapeo !== undefined && (mapeo.estado === "aprobado" || mapeo.estado === "editado") && mapeo.destinoCuentaId !== null;
}

export interface LineaMigrada {
  readonly polizaOrigenId: string;
  readonly cuentaDestinoId: string;
  readonly debe: number;
  readonly haber: number;
}

export interface MigracionPolizaResultado {
  readonly resultado: ResultadoMigracionPoliza;
  /** Líneas listas para insertar en `lineas_poliza_migradas` — vacío si la póliza
   * ya estaba migrada (idempotencia) o si quedó bloqueada. */
  readonly lineasAInsertar: readonly LineaMigrada[];
}

/**
 * `migrar_poliza` — todo o nada: si UNA sola línea no tiene mapeo migrable
 * (aprobado/editado con destino asignado), la póliza ENTERA se bloquea, ninguna
 * línea se escribe. Idempotente: si `yaMigrada` es true, no repite ni recalcula
 * nada. Revalida `sum(debe)==sum(haber)` tras el remapeo como defensa en
 * profundidad (remapear cuenta no cambia montos, así que en teoría nunca dispara —
 * documentado igual que el origen).
 */
export function migrarPoliza(poliza: PolizaOrigen, mapeosPorOrigen: ReadonlyMap<string, MapeoMigracionCuenta>, yaMigrada: boolean): MigracionPolizaResultado {
  if (yaMigrada) {
    return {
      resultado: {
        polizaId: poliza.polizaId,
        migrada: true,
        lineasMigradas: 0,
        bloqueada: false,
        motivoBloqueo: null,
        cuentasSinMapeoAprobado: [],
        yaMigrada: true,
      },
      lineasAInsertar: [],
    };
  }

  const cuentasSinMapeo = new Set<string>();
  for (const linea of poliza.lineas) {
    const mapeo = mapeosPorOrigen.get(linea.cuentaOrigenId);
    if (!mapeoMigrable(mapeo)) cuentasSinMapeo.add(linea.cuentaOrigenId);
  }

  if (cuentasSinMapeo.size > 0) {
    return {
      resultado: {
        polizaId: poliza.polizaId,
        migrada: false,
        lineasMigradas: 0,
        bloqueada: true,
        motivoBloqueo: `${cuentasSinMapeo.size} cuenta(s) origen sin mapeo aprobado/editado con destino asignado.`,
        cuentasSinMapeoAprobado: [...cuentasSinMapeo],
        yaMigrada: false,
      },
      lineasAInsertar: [],
    };
  }

  const lineasAInsertar: LineaMigrada[] = poliza.lineas.map((linea: LineaPolizaOrigen) => {
    const mapeo = mapeosPorOrigen.get(linea.cuentaOrigenId)!;
    return {
      polizaOrigenId: poliza.polizaId,
      cuentaDestinoId: mapeo.destinoCuentaId!,
      debe: linea.debe,
      haber: linea.haber,
    };
  });

  const sumaDebe = lineasAInsertar.reduce((acc, l) => acc + l.debe, 0);
  const sumaHaber = lineasAInsertar.reduce((acc, l) => acc + l.haber, 0);
  if (Math.abs(sumaDebe - sumaHaber) > 0) {
    throw new PolizaDesbalanceadaError(poliza.polizaId, sumaDebe, sumaHaber);
  }

  return {
    resultado: {
      polizaId: poliza.polizaId,
      migrada: true,
      lineasMigradas: lineasAInsertar.length,
      bloqueada: false,
      motivoBloqueo: null,
      cuentasSinMapeoAprobado: [],
      yaMigrada: false,
    },
    lineasAInsertar,
  };
}

/** `migrar_lote_cross_db` sin el I/O — el llamador ya trae la lista de pólizas
 * elegibles (con su filtro de fecha, si aplica) y el set de ids ya migrados. */
export function migrarLote(polizas: readonly PolizaOrigen[], mapeosPorOrigen: ReadonlyMap<string, MapeoMigracionCuenta>, polizasYaMigradas: ReadonlySet<string>): Record<string, MigracionPolizaResultado> {
  const resultado: Record<string, MigracionPolizaResultado> = {};
  for (const poliza of polizas) {
    resultado[poliza.polizaId] = migrarPoliza(poliza, mapeosPorOrigen, polizasYaMigradas.has(poliza.polizaId));
  }
  return resultado;
}
