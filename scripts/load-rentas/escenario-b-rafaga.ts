// Escenario B (Rn-P3-14): rafaga de N reservas directas simultaneas sobre la MISMA unidad y fechas, por la funcion REAL
// crearReservaConfirmada (advisory lock por unidad + SAVEPOINT + EXCLUDE), cada una en su conexion y transaccion. Invariante: exactamente
// 1 confirmada bloqueante, N-1 conflicto_pendiente con su fila de conflicto, 0 errores y 0 deadlocks (40P01). Varias rondas, una unidad cada una.
import { crearReservaConfirmada } from "@atiende/domain-rentas";
import { conLimite, invariante, resumenLatencias, type ResultadoEscenario } from "./comun.ts";
import { crearTenant, crearUnidades, enTransaccion, nuevaConexion } from "./entorno.ts";

export async function escenarioB(concurrentes: number, rondas: number): Promise<ResultadoEscenario> {
  const semilla = await nuevaConexion();
  let tenant: Awaited<ReturnType<typeof crearTenant>>;
  let unidadIds: string[];
  try {
    tenant = await crearTenant(semilla.db, "b");
    unidadIds = await crearUnidades(semilla.db, tenant, rondas, "Unidad carga B");
  } finally {
    await semilla.cliente.end();
  }

  const latencias: number[] = [];
  let confirmadas = 0;
  let conflictos = 0;
  let errores = 0;
  let deadlocks = 0;
  const t0 = Date.now();
  for (const unidadId of unidadIds) {
    const resultados = await conLimite(
      concurrentes,
      Array.from({ length: concurrentes }, (_, k) => async () => {
        const inicio = performance.now();
        try {
          const r = await enTransaccion((db) =>
            crearReservaConfirmada(db, { organizationId: tenant.organizationId, propertyId: tenant.propertyId, unidadId, rango: { inicio: "2030-06-01", fin: "2030-06-05" }, estado: "confirmado", bloqueante: true, externalId: `rafaga-${k}` }),
          );
          return { ms: performance.now() - inicio, conflicto: r.conflicto !== null, codigo: null as string | null };
        } catch (e) {
          return { ms: performance.now() - inicio, conflicto: false, codigo: (e as { code?: string }).code ?? "desconocido" };
        }
      }),
    );
    for (const r of resultados) {
      latencias.push(r.ms);
      if (r.codigo === null) {
        if (r.conflicto) conflictos++;
        else confirmadas++;
      } else {
        errores++;
        if (r.codigo === "40P01") deadlocks++;
      }
    }
  }
  const duracionTotalMs = Date.now() - t0;

  const verif = await nuevaConexion();
  let bloqueantes = 0;
  let filasConflicto = 0;
  try {
    bloqueantes = Number((await verif.db.query<{ n: string }>(`select count(*)::text as n from rentas.ocupacion where organization_id = $1 and estado = 'confirmado' and bloqueante`, [tenant.organizationId])).rows[0]!.n);
    filasConflicto = Number((await verif.db.query<{ n: string }>(`select count(*)::text as n from rentas.conflicto_calendario where organization_id = $1 and tipo = 'overbooking_confirmado'`, [tenant.organizationId])).rows[0]!.n);
  } finally {
    await verif.cliente.end();
  }

  return {
    escenario: "B-rafaga-de-reservas",
    parametros: { concurrentes, rondas },
    duracionTotalMs,
    latencias: { porReserva: resumenLatencias(latencias) },
    invariantes: [
      invariante("0 errores y 0 deadlocks (40P01)", errores === 0 && deadlocks === 0, `${errores} errores, ${deadlocks} deadlocks`),
      invariante("exactamente 1 confirmada por ronda", confirmadas === rondas, `${confirmadas}/${rondas}`),
      invariante("el resto queda como conflicto, nunca se pierde una reserva", conflictos === rondas * (concurrentes - 1), `${conflictos}/${rondas * (concurrentes - 1)}`),
      invariante("1 sola ocupacion bloqueante confirmada por unidad", bloqueantes === rondas, `${bloqueantes}/${rondas}`),
      invariante("una fila de conflicto por cada perdedora", filasConflicto === rondas * (concurrentes - 1), `${filasConflicto}/${rondas * (concurrentes - 1)}`),
    ],
    datos: { confirmadas, conflictos },
  };
}
