// Escenario A (Rn-P3-14): importacion concurrente de N unidades x C feeds iCal (por defecto 50 x 3 = 150 ciclos), cada ciclo en su propia
// conexion y transaccion contra Postgres real, por el motor REAL (ejecutarCicloImportacion + PostgresRentasCalendarSyncRepository +
// fetchIcsSeguro contra un http.Server en loopback autorizado como simulador). Mide la latencia INTERNA del ciclo (fetch + parseo +
// aplicacion), nunca la del canal externo. Invariantes: cada feed aplica 1 evento, 0 solapes, 0 conflictos, y una segunda pasada identica
// no cambia nada (idempotencia).
import * as http from "node:http";
import { ejecutarCicloImportacion, fetchIcsSeguro, PostgresRentasCalendarSyncRepository, type CalendarSyncPort, type FetchFeedInput, type FetchFeedResult } from "@atiende/domain-rentas";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { conLimite, invariante, resumenLatencias, type ResultadoEscenario } from "./comun.ts";
import { crearTenant, crearUnidades, enTransaccion, nuevaConexion, ZONA } from "./entorno.ts";

const CANALES = ["airbnb", "booking", "vrbo"] as const;

function feedPara(u: number, c: number): string {
  // Rangos disjuntos por (unidad, canal): bajo operacion correcta, 0 conflictos.
  const inicio = new Date(Date.UTC(2030, 0, 1) + (u * 20 + c * 3) * 86_400_000);
  const fin = new Date(inicio.getTime() + 2 * 86_400_000);
  const f = (d: Date): string => d.toISOString().slice(0, 10).replaceAll("-", "");
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//CargaRentas//EN\r\nBEGIN:VEVENT\r\nUID:carga-${u}-${c}@simulador.local\r\nDTSTAMP:20300101T000000Z\r\nDTSTART;VALUE=DATE:${f(inicio)}\r\nDTEND;VALUE=DATE:${f(fin)}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
}

export async function escenarioA(unidades: number, canalesPorUnidad: number, concurrencia: number): Promise<ResultadoEscenario> {
  const servidor = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://simulador.local");
    res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8" });
    res.end(feedPara(Number(url.searchParams.get("u")), Number(url.searchParams.get("c"))));
  });
  await new Promise<void>((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  const dir = servidor.address();
  if (!dir || typeof dir === "string") throw new Error("no se pudo levantar el simulador de feeds");
  const puerto = dir.port;

  const puerto_: CalendarSyncPort = {
    async fetchFeed(input: FetchFeedInput): Promise<FetchFeedResult> {
      const r = await fetchIcsSeguro({ url: input.url, etag: input.etag, ultimaModificacionHttp: input.ultimaModificacionHttp, permitirHttpSimuladorLocal: true, resolverPersonalizado: () => ["127.0.0.1"] });
      return { status: r.status, cuerpo: r.cuerpo, etag: r.etag, ultimaModificacionHttp: r.ultimaModificacionHttp, noModificado: r.noModificado };
    },
  };

  const semilla = await nuevaConexion();
  let tenant: Awaited<ReturnType<typeof crearTenant>>;
  let unidadIds: string[];
  const feedIds: Array<{ u: number; c: number; unidadId: string; canalId: string }> = [];
  try {
    tenant = await crearTenant(semilla.db, "a");
    unidadIds = await crearUnidades(semilla.db, tenant, unidades, "Unidad carga A");
    const repoSemilla = new PostgresRentasCalendarSyncRepository(semilla.db as TenantDbSession);
    for (let u = 0; u < unidades; u++) {
      for (let c = 0; c < canalesPorUnidad; c++) {
        const canalId = tenant.canalIds[CANALES[c % CANALES.length]!]!;
        await repoSemilla.connectFeed({ organizationId: tenant.organizationId, propertyId: tenant.propertyId, unidadId: unidadIds[u]!, canalId, urlImportacion: `http://simulador.local:${puerto}/feed.ics?u=${u}&c=${c}` });
        feedIds.push({ u, c, unidadId: unidadIds[u]!, canalId });
      }
    }
  } finally {
    await semilla.cliente.end();
  }

  async function pasada(): Promise<{ latencias: number[]; aplicados: number; conflictos: number; errores: number; duracionMs: number }> {
    const t0 = Date.now();
    const resultados = await conLimite(
      concurrencia,
      feedIds.map((f) => async () => {
        const inicio = performance.now();
        try {
          const aplicado = await enTransaccion(async (db) => {
            const repo = new PostgresRentasCalendarSyncRepository(db as TenantDbSession);
            const feed = await repo.findFeed(tenant.propertyId, f.unidadId, f.canalId);
            if (!feed) throw new Error("feed no encontrado");
            return ejecutarCicloImportacion({ db, syncRepo: repo, port: puerto_, feed, zonaHorariaPropiedad: ZONA });
          });
          return { ms: performance.now() - inicio, aplicados: aplicado.eventosAplicados, conflictos: aplicado.conflictosDetectados, error: false };
        } catch {
          return { ms: performance.now() - inicio, aplicados: 0, conflictos: 0, error: true };
        }
      }),
    );
    return {
      latencias: resultados.map((r) => r.ms),
      aplicados: resultados.reduce((s, r) => s + r.aplicados, 0),
      conflictos: resultados.reduce((s, r) => s + r.conflictos, 0),
      errores: resultados.filter((r) => r.error).length,
      duracionMs: Date.now() - t0,
    };
  }

  const primera = await pasada();
  const segunda = await pasada(); // mismo contenido: idempotencia (304 por ETag o sin_cambio)
  await new Promise<void>((resolve) => servidor.close(() => resolve()));

  const verif = await nuevaConexion();
  let solapes = 0;
  let totalOcupaciones = 0;
  let conflictosFila = 0;
  try {
    const s = await verif.db.query<{ n: string }>(
      `select count(*)::text as n from rentas.ocupacion a join rentas.ocupacion b on a.unidad_id = b.unidad_id and a.id < b.id
        where a.organization_id = $1 and a.capa = 'reserva' and b.capa = 'reserva' and a.estado <> 'cancelado' and b.estado <> 'cancelado' and a.bloqueante and b.bloqueante and a.rango && b.rango`,
      [tenant.organizationId],
    );
    solapes = Number(s.rows[0]!.n);
    totalOcupaciones = Number((await verif.db.query<{ n: string }>(`select count(*)::text as n from rentas.ocupacion where organization_id = $1`, [tenant.organizationId])).rows[0]!.n);
    conflictosFila = Number((await verif.db.query<{ n: string }>(`select count(*)::text as n from rentas.conflicto_calendario where organization_id = $1`, [tenant.organizationId])).rows[0]!.n);
  } finally {
    await verif.cliente.end();
  }

  const total = feedIds.length;
  return {
    escenario: "A-importacion-concurrente",
    parametros: { unidades, canalesPorUnidad, ciclos: total, concurrencia },
    duracionTotalMs: primera.duracionMs + segunda.duracionMs,
    latencias: { primeraPasada: resumenLatencias(primera.latencias), segundaPasadaIdempotente: resumenLatencias(segunda.latencias) },
    invariantes: [
      invariante("todos los ciclos terminan sin error", primera.errores === 0 && segunda.errores === 0, `errores: ${primera.errores} + ${segunda.errores}`),
      invariante("cada feed aplica exactamente 1 evento en la primera pasada", primera.aplicados === total, `${primera.aplicados}/${total}`),
      invariante("la segunda pasada no aplica nada (idempotencia)", segunda.aplicados === 0, `${segunda.aplicados} aplicados`),
      invariante("0 solapes de reservas bloqueantes en una misma unidad (cero overbooking)", solapes === 0, `${solapes} pares solapados`),
      invariante("0 conflictos de calendario (los rangos son disjuntos)", conflictosFila === 0 && primera.conflictos === 0, `${conflictosFila} filas, ${primera.conflictos} detectados en ciclo`),
      invariante("una ocupacion por feed, ni mas ni menos", totalOcupaciones === total, `${totalOcupaciones}/${total}`),
    ],
    datos: { ocupaciones: totalOcupaciones, ciclosPorSegundoPrimeraPasada: Math.round((total / (primera.duracionMs / 1000)) * 10) / 10 },
  };
}
