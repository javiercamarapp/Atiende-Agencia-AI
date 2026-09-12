// Owner statement (Fase 2, Flujo 5) — port de rentas/packages/domain/src/finanzas/statement.ts.
// Función pura, sin IO: recibe las reservas YA resueltas (un `ReservaParaStatement` por
// cada `rentas.reserva_financiero` del periodo, ya calculado por
// `calcularMovimientoReserva` en su momento) y agrega un statement determinista.
//
// Ver diseño Fase 2 rentas §1.2/§4.3: la "agregación" es un `SELECT` + un `for` en
// memoria — trivial en volumen, sin necesidad de infraestructura de batch. La
// resolución de `tenant_id` vía `owner_empresa_gestora` que sí tenía el origen
// (ambigüedad "un owner con varias empresas gestoras") NO se porta: en atiende-fusion
// el `organizationId` siempre viene de la membership verificada por
// `requirePropertyMembership`, nunca del owner ni de un claim (ver diseño §4.3).
import { createHash } from "node:crypto";
import { sumarCentavos } from "./redondeo.ts";
import type { RangoFechas } from "../tipos.ts";

export type TipoLineaOwnerStatement = "ingreso" | "comision_canal" | "comision_gestor" | "gasto" | "impuesto";

/** Una reserva ya resuelta (su `rentas.reserva_financiero`) que cae dentro del periodo
 * del statement — todo el cálculo de dinero de ESTA reserva ya ocurrió en
 * `calcularMovimientoReserva` (flujo 3, Fase 1); este módulo solo agrega. */
export interface ReservaParaStatement {
  readonly ocupacionId: string;
  readonly moneda: string;
  readonly ingresoBrutoCentavos: number;
  readonly comisionCanalCentavos: number;
  readonly comisionGestorCentavos: number;
  readonly gastosCentavos: number;
  readonly impuestosCentavos: number;
  readonly netoCentavos: number;
}

export interface LineaOwnerStatement {
  readonly ocupacionId: string;
  readonly tipo: TipoLineaOwnerStatement;
  readonly descripcion: string;
  readonly montoCentavos: number;
}

export interface TotalesOwnerStatement {
  readonly ingresosBrutosCentavos: number;
  readonly comisionCanalCentavos: number;
  readonly comisionGestorCentavos: number;
  readonly gastosCentavos: number;
  readonly impuestosCentavos: number;
  readonly netoCentavos: number;
}

export interface ParametrosOwnerStatement {
  readonly ownerId: string;
  readonly propertyId: string;
  readonly periodo: RangoFechas;
  readonly moneda: string;
  readonly reservas: readonly ReservaParaStatement[];
}

export interface ResultadoOwnerStatement {
  readonly lineas: readonly LineaOwnerStatement[];
  readonly totales: TotalesOwnerStatement;
  readonly hashContenido: string;
}

/**
 * Agrega N `ReservaParaStatement` en un owner statement determinista. Ordena SIEMPRE
 * por `ocupacionId` antes de generar líneas — el orden de entrada (el que devolvió la
 * query SQL, no garantizado por ningún `ORDER BY` de por sí) nunca debe afectar el
 * contenido del statement ni su hash.
 *
 * Lanza si la lista de reservas viene vacía (la ruta HTTP decide el código de estado;
 * aquí solo se documenta que un statement sin ningún movimiento no tiene sentido) o si
 * alguna reserva trae una moneda distinta a `moneda` (el motor de finanzas nunca
 * convierte tipo de cambio — mismo criterio que `pricing/cotizacion.ts`).
 */
export function generarOwnerStatement(params: ParametrosOwnerStatement): ResultadoOwnerStatement {
  if (params.reservas.length === 0) {
    throw new Error("No hay movimientos financieros en el periodo para este propietario.");
  }

  const ordenadas = [...params.reservas].sort((a, b) => a.ocupacionId.localeCompare(b.ocupacionId));

  const lineas: LineaOwnerStatement[] = [];
  for (const reserva of ordenadas) {
    if (reserva.moneda !== params.moneda) {
      throw new Error(`Reserva ${reserva.ocupacionId} está en moneda "${reserva.moneda}", el statement es en "${params.moneda}" -- el motor nunca convierte tipo de cambio.`);
    }
    lineas.push({ ocupacionId: reserva.ocupacionId, tipo: "ingreso", descripcion: `Ingreso bruto — reserva ${reserva.ocupacionId}`, montoCentavos: reserva.ingresoBrutoCentavos });
    if (reserva.comisionCanalCentavos > 0) {
      lineas.push({ ocupacionId: reserva.ocupacionId, tipo: "comision_canal", descripcion: `Comisión de canal — reserva ${reserva.ocupacionId}`, montoCentavos: reserva.comisionCanalCentavos });
    }
    if (reserva.comisionGestorCentavos > 0) {
      lineas.push({ ocupacionId: reserva.ocupacionId, tipo: "comision_gestor", descripcion: `Comisión de gestor — reserva ${reserva.ocupacionId}`, montoCentavos: reserva.comisionGestorCentavos });
    }
    if (reserva.gastosCentavos > 0) {
      lineas.push({ ocupacionId: reserva.ocupacionId, tipo: "gasto", descripcion: `Gastos — reserva ${reserva.ocupacionId}`, montoCentavos: reserva.gastosCentavos });
    }
    if (reserva.impuestosCentavos > 0) {
      lineas.push({ ocupacionId: reserva.ocupacionId, tipo: "impuesto", descripcion: `Impuestos — reserva ${reserva.ocupacionId}`, montoCentavos: reserva.impuestosCentavos });
    }
  }

  const totales: TotalesOwnerStatement = {
    ingresosBrutosCentavos: sumarCentavos(...ordenadas.map((r) => r.ingresoBrutoCentavos)),
    comisionCanalCentavos: sumarCentavos(...ordenadas.map((r) => r.comisionCanalCentavos)),
    comisionGestorCentavos: sumarCentavos(...ordenadas.map((r) => r.comisionGestorCentavos)),
    gastosCentavos: sumarCentavos(...ordenadas.map((r) => r.gastosCentavos)),
    impuestosCentavos: sumarCentavos(...ordenadas.map((r) => r.impuestosCentavos)),
    netoCentavos: sumarCentavos(...ordenadas.map((r) => r.netoCentavos)),
  };

  const hashContenido = calcularHashStatement(params.ownerId, params.propertyId, params.periodo, params.moneda, lineas);

  return { lineas, totales, hashContenido };
}

/**
 * Hash estable del CONTENIDO de un statement (nunca de metadatos de auditoría como
 * `generadoEn`/`generadoPor`) — es la base de la idempotencia H-062 (ver diseño §4.2):
 * dos generaciones con exactamente el mismo contenido producen el mismo hash sin
 * importar el orden en que la query SQL haya devuelto las filas, porque las líneas se
 * reordenan canónicamente ANTES de hashear.
 */
export function calcularHashStatement(ownerId: string, propertyId: string, periodo: RangoFechas, moneda: string, lineas: readonly LineaOwnerStatement[]): string {
  const canonicas = [...lineas]
    .map((l) => ({ ocupacionId: l.ocupacionId, tipo: l.tipo, montoCentavos: l.montoCentavos }))
    .sort((a, b) => {
      const claveA = `${a.ocupacionId}:${a.tipo}`;
      const claveB = `${b.ocupacionId}:${b.tipo}`;
      return claveA < claveB ? -1 : claveA > claveB ? 1 : 0;
    });
  const payload = JSON.stringify({ ownerId, propertyId, periodo, moneda, lineas: canonicas });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * `true` si el contenido recién calculado es idéntico al de la última versión ya
 * persistida — la única condición que decide "reusar" (200, `creado: false`) en vez de
 * "crear versión nueva" (201, `creado: true`). `hashAnterior === null` significa "no
 * hay ninguna versión previa para este periodo": siempre crea.
 */
export function esMismoContenidoQueVersionAnterior(hashCalculado: string, hashAnterior: string | null): boolean {
  return hashAnterior !== null && hashAnterior === hashCalculado;
}
