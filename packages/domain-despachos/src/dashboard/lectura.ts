// Lectura de las fuentes del dashboard gerencial (D-01) a través del puerto
// `DespachosRepository` y cálculo de los KPIs de un cliente. Es la ÚNICA capa de este
// módulo con I/O; el cálculo vive en `kpis.ts` (puro).
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR (regla dura del repo): mergear despliega el código
// al instante y la base real puede ir varias migraciones atrás (p. ej. sin las tablas de
// cobranza o de cierre mensual). Cada fuente se lee dentro de SU PROPIO SAVEPOINT
// (`repo.runWithRowSavepoint`): si Postgres responde "tabla/columna/función inexistente"
// (SQLSTATE 42P01/42703/42883, `isMigrationPendingError`) el savepoint se revierte —la
// transacción del request sigue utilizable para las demás fuentes y para el COMMIT— y esa
// fuente queda `null` ("no disponible aún", nunca un 500 ni un cero engañoso). Cualquier
// OTRO error de Postgres se repropaga tal cual: nunca se enmascara un fallo real.
import { isMigrationPendingError } from "@atiende/db";
import type { DespachosRepository } from "../repository.ts";
import type { HistorialCobranzaEntry } from "../cobranza/engine.ts";
import { calcularKpisCliente } from "./kpis.ts";
import type { CierreEntrada, KpisCliente } from "./kpis.ts";

/** Tope de períodos de cierre sin cerrar cuyas tareas se leen por cliente (los más recientes). */
export const MAX_PERIODOS_CIERRE_ABIERTOS = 36;

/** Lee una fuente opcional: `null` si la base todavía no tiene lo que necesita. */
export async function leerFuenteOpcional<T>(repo: Pick<DespachosRepository, "runWithRowSavepoint">, leer: () => Promise<T>): Promise<T | null> {
  try {
    return await repo.runWithRowSavepoint(leer);
  } catch (err) {
    if (isMigrationPendingError(err)) return null;
    throw err;
  }
}

export interface ClienteDashboardRef {
  readonly propertyId: string;
  readonly nombre: string;
  /** Fecha de negocio "YYYY-MM-DD" ya resuelta en la zona horaria del cliente. */
  readonly hoy: string;
}

export async function leerKpisCliente(repo: DespachosRepository, cliente: ClienteDashboardRef): Promise<KpisCliente> {
  const { propertyId, hoy } = cliente;

  const cartera = await leerFuenteOpcional(repo, async () => {
    const cuentas = await repo.listReceivables(propertyId);
    if (cuentas.length === 0) return { cuentas, totalPorInvoiceId: new Map<string, number>(), historialPorCuenta: new Map<string, readonly HistorialCobranzaEntry[]>() };
    const invoiceIds = [...new Set(cuentas.map((c) => c.invoiceId))];
    // Solo la cartera pendiente necesita historial de cobranza (alimenta el score); evita leer eventos de cuentas pagadas.
    const pendientes = cuentas.filter((c) => c.pagadoEn === null).map((c) => c.id);
    const [invoices, eventos] = await Promise.all([repo.findInvoicesByIds(propertyId, invoiceIds), pendientes.length > 0 ? repo.listCollectionEventsForReceivables(propertyId, pendientes) : Promise.resolve([])]);
    const historial = new Map<string, HistorialCobranzaEntry[]>();
    for (const e of eventos) {
      const lista = historial.get(e.receivableId) ?? [];
      lista.push({ tipoRecordatorio: e.etapa, respuesta: e.respuesta });
      historial.set(e.receivableId, lista);
    }
    return { cuentas, totalPorInvoiceId: new Map(invoices.map((i) => [i.id, i.total] as const)), historialPorCuenta: historial };
  });

  const revisionesPendientes = await leerFuenteOpcional(repo, () => repo.listPendingReviews(propertyId));
  const vencimientos = await leerFuenteOpcional(repo, () => repo.listDeadlines(propertyId));

  const cierres = await leerFuenteOpcional<readonly CierreEntrada[]>(repo, async () => {
    const periodos = await repo.listPeriodosCierre(propertyId); // anio desc, mes desc
    const sinCerrar = periodos.filter((p) => p.status !== "closed").slice(0, MAX_PERIODOS_CIERRE_ABIERTOS);
    const aLeer = new Set(sinCerrar.map((p) => p.id));
    // El período más reciente se lee siempre (aunque esté cerrado) para mostrar su avance real.
    if (periodos[0]) aLeer.add(periodos[0].id);
    const entradas: CierreEntrada[] = [];
    for (const periodo of periodos) {
      if (periodo.status === "closed" && !aLeer.has(periodo.id)) {
        entradas.push({ periodo, tareas: [] });
      } else if (aLeer.has(periodo.id)) {
        entradas.push({ periodo, tareas: await repo.listTareasCierre(periodo.id) });
      }
    }
    return entradas;
  });

  const cfdiMes = await leerFuenteOpcional(repo, () => repo.listInvoices(propertyId, { periodo: hoy.slice(0, 7) }));

  return calcularKpisCliente({ propertyId, nombre: cliente.nombre, hoy, cartera, revisionesPendientes, vencimientos, cierres, cfdiMes });
}
