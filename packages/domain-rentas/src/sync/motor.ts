// Motor de sincronización iCal — port ~literal de
// rentas/packages/adapters/src/sync/motor.ts (repo origen, H-029 a H-034), sobre el
// mismo principio que domain-citas/calendar-sync.ts para Google Calendar: "el
// software (rentas) es SIEMPRE la fuente de verdad; la sincronización es
// best-effort, nunca bloqueante". Orquesta:
//   fetch (CalendarSyncPort, SSRF-safe) -> parseo con límites (../ical/parser.ts) ->
//   anti-eco 3 capas (./anti-eco.ts) -> resolución de versión UID->SEQUENCE->DTSTAMP
//   (./resolucion-version.ts) -> aplicación transaccional REUTILIZANDO LITERAL
//   crearReservaConfirmada/modificarFechasReserva/cancelarOcupacion de
//   ../aplicacion/reservas.ts (Fase 4, ya construidas — nunca se reimplementa el
//   EXCLUDE/conflicto de calendario aquí) -> cuarentena (./cuarentena.ts) ->
//   reconciliación completa/drift (./reconciliacion.ts), todo persistido vía
//   `RentasCalendarSyncRepository` (./repository.ts).
//
// Decisión de diseño explícita (difiere de una lectura superficial del encargo, que
// sugería "usar crearBloqueo"): un evento importado de un feed de canal (Airbnb/
// Booking/VRBO/...) es una RESERVA de ese canal, no un bloqueo de
// propietario/mantenimiento/buffer — el propio motor de origen (motor.ts) los trata
// así (capa='reserva', razón=RESERVA_CANAL, vía `crearReservaConfirmada`), porque solo
// esa capa participa del EXCLUDE de base de datos que previene doble-reserva entre
// canales (ver calendar-store.ts / migrations/001_rentas_schema.sql,
// `ocupacion_sin_solape`). `crearBloqueo` (capa='bloqueo') existe para
// BLOQUEO_PROPIETARIO/MANTENIMIENTO/BUFFER_LIMPIEZA — un concepto de negocio distinto,
// nunca alcanzable por un feed iCal de canal. Sí se cumple el mandato de "no
// duplicar" reutilizando el motor transaccional COMPLETO ya construido en Fase 4
// (crearReservaConfirmada/modificarFechasReserva/cancelarOcupacion), en vez de
// reimplementar el EXCLUDE/conflicto de calendario aquí.
import { cancelarOcupacion, crearReservaConfirmada, modificarFechasReserva } from "../aplicacion/reservas.ts";
import type { EjecutorTransaccional } from "../ejecutor.ts";
import { esRangoValido } from "../fechas.ts";
import type { RangoFechas } from "../tipos.ts";
import { calcularHashContenidoBloqueo, construirUidExportado, exportarFeedIcs, type BloqueoExportable, type FeedExportado } from "../ical/exportador.ts";
import { IcsParseError, parsearIcs, type LimitesParserIcs, type VEventNormalizado } from "../ical/parser.ts";
import { resolverFechaLocal } from "../ical/resolver-fecha.ts";
import { detectarEco } from "./anti-eco.ts";
import type { CalendarSyncPort } from "./calendar-sync-port.ts";
import { aplicarResultadoCiclo, type AlertaCuarentena, type ResultadoCicloFetch } from "./cuarentena.ts";
import { reconciliarCompleto } from "./reconciliacion.ts";
import { resolverVersionEvento, type VersionEvento } from "./resolucion-version.ts";
import type { FeedExternoRecord, RentasCalendarSyncRepository } from "./repository.ts";

export interface ContextoSincronizacion {
  db: EjecutorTransaccional;
  syncRepo: RentasCalendarSyncRepository;
  port: CalendarSyncPort;
  feed: FeedExternoRecord;
  zonaHorariaPropiedad: string;
  limites?: LimitesParserIcs;
}

export interface RevisionUidReciclado {
  uid: string;
  motivo: string;
}

export interface EventoDescartadoPorError {
  uid: string;
  error: string;
}

export interface ResultadoImportarCiclo {
  resultado: ResultadoCicloFetch;
  eventosEnFeed: number;
  eventosAplicados: number;
  ecosDescartados: number;
  conflictosDetectados: number;
  alertaCuarentena: AlertaCuarentena | null;
  revisionesUidReciclado: RevisionUidReciclado[];
  /** Eventos individuales del feed descartados por ser semánticamente inválidos
   * (rango invertido/vacío, típicamente una `DURATION` negativa o cero — RFC 5545
   * §3.3.6 la acepta sintácticamente) o por cualquier otro error inesperado al
   * procesarlos. Nunca abortan el resto del ciclo. */
  eventosDescartadosPorError: EventoDescartadoPorError[];
  /** Drift de la reconciliación completa, computado en ESTE ciclo — cuántos UIDs que
   * el sistema creía activos ya no aparecen en el feed actual, sin `CANCEL`
   * explícito. `undefined` cuando el ciclo no llegó a tener un feed completo que
   * reconciliar (fallo de red/parseo, no_modificado, feed vacío). */
  driftReconciliacionCompleta?: number;
  candidatosACancelarPorAusencia: { ocupacionId: string; uidCanal: string }[];
}

function extraerRango(evento: VEventNormalizado, zonaHoraria: string): RangoFechas {
  return { inicio: resolverFechaLocal(evento.dtstart, zonaHoraria), fin: resolverFechaLocal(evento.dtend, zonaHoraria) };
}

async function procesarEventoDelCiclo(ctx: ContextoSincronizacion, evento: VEventNormalizado, hashesRecientes: readonly string[], resumen: ResultadoImportarCiclo): Promise<void> {
  const rango = extraerRango(evento, ctx.zonaHorariaPropiedad);

  // Validar el rango ANTES de cualquier consulta SQL que lo use — un `daterange()`
  // crudo con un rango invertido lo rechazaría Postgres con `22000` antes de que el
  // dominio pueda intervenir. Un evento sintácticamente válido según el parser (p.
  // ej. `DURATION:-P1D` o `PT0S`, aceptadas por el ABNF de RFC 5545 §3.3.6 pero
  // semánticamente inválidas) se descarta aquí mismo, individualmente.
  if (!esRangoValido(rango)) {
    throw new Error(`evento con rango inválido (dtstart >= dtend): [${rango.inicio}, ${rango.fin})`);
  }

  const hash = calcularHashContenidoBloqueo({ unidadId: ctx.feed.unidadId, dtstart: rango.inicio, dtend: rango.fin, razon: "RESERVA_CANAL" });

  const canalesExportados = await ctx.syncRepo.listCanalesExportadosDeRango(ctx.feed.unidadId, rango);
  const eco = detectarEco({
    uidEntrante: evento.uid,
    hashContenidoEntrante: hash,
    hashesExportadosRecientes: hashesRecientes,
    canalesExportadosDeRangoCoincidente: canalesExportados,
  });

  // Hash de VERSIÓN (para `resolverVersionEvento`/idempotencia), distinto del hash de
  // anti-eco de arriba: un CANCEL sobre el mismo rango de fechas ya importado es un
  // cambio de contenido real (la reserva deja de reclamar esas noches) aunque
  // `(unidad, dtstart, dtend)` no cambien — sin este distintivo, `resolverVersionEvento`
  // lo trataría como "hash idéntico al almacenado" (sin_cambio) y el CANCEL nunca se
  // aplicaría. El hash de anti-eco de arriba NO lleva este distintivo a propósito: lo
  // que nosotros exportamos siempre lleva STATUS:CONFIRMED (ver ../ical/exportador.ts),
  // así que un eco genuino de nuestro propio export sigue coincidiendo exactamente.
  const hashVersion = calcularHashContenidoBloqueo({ unidadId: ctx.feed.unidadId, dtstart: rango.inicio, dtend: rango.fin, razon: evento.status === "CANCELLED" ? "RESERVA_CANAL:CANCELLED" : "RESERVA_CANAL" });
  const entrante: VersionEvento = { uid: evento.uid, sequence: evento.sequence, dtstamp: evento.dtstamp, hash: hashVersion, rango };

  if (eco.esEco) {
    resumen.ecosDescartados++;
    await ctx.syncRepo.upsertEventoImportado(ctx.feed.unidadId, ctx.feed.canalId, { uid: entrante.uid, sequence: entrante.sequence, dtstamp: entrante.dtstamp, hashContenido: entrante.hash, ocupacionId: null, ultimaAccion: "eco", sobrescribirVersion: true });
    return;
  }

  const previa = await ctx.syncRepo.findVersionPrevia(ctx.feed.unidadId, ctx.feed.canalId, evento.uid);
  const versionPrevia: VersionEvento | null = previa ? { uid: evento.uid, sequence: previa.sequence, dtstamp: previa.dtstamp, hash: previa.hashContenido, rango: previa.rango ?? undefined } : null;
  const resolucion = resolverVersionEvento(versionPrevia, entrante);

  if (resolucion.accion === "sin_cambio" || resolucion.accion === "descartar") {
    await ctx.syncRepo.upsertEventoImportado(ctx.feed.unidadId, ctx.feed.canalId, {
      uid: entrante.uid,
      sequence: entrante.sequence,
      dtstamp: entrante.dtstamp,
      hashContenido: entrante.hash,
      ocupacionId: previa?.ocupacionId ?? null,
      ultimaAccion: resolucion.accion,
      sobrescribirVersion: false,
    });
    return;
  }

  if (resolucion.accion === "revisar_uid_reciclado") {
    resumen.revisionesUidReciclado.push({ uid: evento.uid, motivo: resolucion.motivo });
    await ctx.syncRepo.upsertEventoImportado(ctx.feed.unidadId, ctx.feed.canalId, {
      uid: entrante.uid,
      sequence: entrante.sequence,
      dtstamp: entrante.dtstamp,
      hashContenido: entrante.hash,
      ocupacionId: previa?.ocupacionId ?? null,
      ultimaAccion: "revisar_uid_reciclado",
      sobrescribirVersion: false,
    });
    return;
  }

  // accion === 'aplicar'
  if (evento.status === "CANCELLED") {
    if (previa?.ocupacionId) {
      await cancelarOcupacion(ctx.db, previa.ocupacionId);
    }
    await ctx.syncRepo.upsertEventoImportado(ctx.feed.unidadId, ctx.feed.canalId, { uid: entrante.uid, sequence: entrante.sequence, dtstamp: entrante.dtstamp, hashContenido: entrante.hash, ocupacionId: previa?.ocupacionId ?? null, ultimaAccion: "aplicar", sobrescribirVersion: true });
    resumen.eventosAplicados++;
    return;
  }

  if (previa?.ocupacionId) {
    const modificado = await modificarFechasReserva(ctx.db, previa.ocupacionId, rango);
    if (modificado.conflicto) resumen.conflictosDetectados++;
    await ctx.syncRepo.upsertEventoImportado(ctx.feed.unidadId, ctx.feed.canalId, { uid: entrante.uid, sequence: entrante.sequence, dtstamp: entrante.dtstamp, hashContenido: entrante.hash, ocupacionId: previa.ocupacionId, ultimaAccion: "aplicar", sobrescribirVersion: true });
  } else {
    // Recuperación de bookkeeping perdido: `crearReservaConfirmada` (efecto de
    // dominio, su propio COMMIT) y `upsertEventoImportado` (bookkeeping, escritura
    // SEPARADA y posterior) no son atómicos entre sí. Si el proceso muere entre
    // ambos COMMIT, el reproceso del mismo ciclo ve `previa === null` para un UID
    // cuyo efecto YA se aplicó — sin esta verificación, se llamaría de nuevo
    // `crearReservaConfirmada` con el mismo rango, generando una segunda fila
    // `conflicto_pendiente` y una alerta de overbooking FALSA contra la reserva
    // consigo misma.
    const ocupacionRecuperada = await ctx.syncRepo.buscarOcupacionActivaParaRecuperarBookkeeping(ctx.feed.unidadId, ctx.feed.canalId, evento.uid, rango);
    if (ocupacionRecuperada) {
      await ctx.syncRepo.upsertEventoImportado(ctx.feed.unidadId, ctx.feed.canalId, { uid: entrante.uid, sequence: entrante.sequence, dtstamp: entrante.dtstamp, hashContenido: entrante.hash, ocupacionId: ocupacionRecuperada, ultimaAccion: "aplicar", sobrescribirVersion: true });
    } else {
      const estadoOcupacion = evento.status === "TENTATIVE" ? "provisional" : "confirmado";
      const creado = await crearReservaConfirmada(ctx.db, {
        organizationId: ctx.feed.organizationId,
        propertyId: ctx.feed.propertyId,
        unidadId: ctx.feed.unidadId,
        rango,
        estado: estadoOcupacion,
        bloqueante: true,
        canalOrigenId: ctx.feed.canalId,
        externalId: evento.uid,
      });
      if (creado.conflicto) resumen.conflictosDetectados++;
      await ctx.syncRepo.upsertEventoImportado(ctx.feed.unidadId, ctx.feed.canalId, { uid: entrante.uid, sequence: entrante.sequence, dtstamp: entrante.dtstamp, hashContenido: entrante.hash, ocupacionId: creado.ocupacionId, ultimaAccion: "aplicar", sobrescribirVersion: true });
    }
  }
  resumen.eventosAplicados++;
}

/** Ejecuta un ciclo completo de import para un feed conectado: fetch -> cuarentena en
 * caso de fallo -> parseo -> anti-eco -> resolución de versión -> aplicación
 * transaccional. Nunca libera disponibilidad ante fallo ni crea un segundo bloqueo a
 * partir de un eco. Best-effort: nunca lanza por un fallo del canal remoto, salvo un
 * fallo real de la base de datos (que sí debe propagarse). */
export async function ejecutarCicloImportacion(ctx: ContextoSincronizacion): Promise<ResultadoImportarCiclo> {
  const ahoraIso = new Date().toISOString();
  const estadoPrevio = ctx.feed.estadoSync;

  let resultadoCiclo: ResultadoCicloFetch;
  let eventos: VEventNormalizado[] = [];
  let nuevoEtag = ctx.feed.etagImport;
  let nuevoLastModified = ctx.feed.ultimaModificacionHttpImport;

  try {
    const respuesta = await ctx.port.fetchFeed({ url: ctx.feed.urlImportacion, etag: ctx.feed.etagImport, ultimaModificacionHttp: ctx.feed.ultimaModificacionHttpImport });
    if (respuesta.noModificado) {
      resultadoCiclo = "no_modificado";
    } else if (respuesta.status < 200 || respuesta.status >= 300) {
      // Cualquier estado HTTP fuera de 2xx/304 se trata como fallo de red, nunca como
      // "sin eventos" — un 4xx/5xx no es sintácticamente un feed vacío válido.
      resultadoCiclo = "fallo_red";
    } else {
      nuevoEtag = respuesta.etag ?? ctx.feed.etagImport;
      nuevoLastModified = respuesta.ultimaModificacionHttp ?? ctx.feed.ultimaModificacionHttpImport;
      try {
        const calendario = parsearIcs(respuesta.cuerpo ?? "", ctx.limites);
        eventos = calendario.eventos;
        resultadoCiclo = eventos.length === 0 ? "exito_vacio" : "exito_con_eventos";
      } catch (error) {
        if (error instanceof IcsParseError) {
          resultadoCiclo = "fallo_parseo";
        } else {
          throw error;
        }
      }
    }
  } catch {
    // Cualquier fallo de red/DNS/SSRF/timeout se trata uniformemente como
    // "fallo_red" para efectos de cuarentena.
    resultadoCiclo = "fallo_red";
  }

  const huboEventosActivosPreviamente = (await ctx.syncRepo.contarOcupacionesActivasDelCanal(ctx.feed.unidadId, ctx.feed.canalId)) > 0;

  const { estado: nuevoEstado, alerta } = aplicarResultadoCiclo(estadoPrevio, resultadoCiclo, ahoraIso, { umbralIntentosFallidos: 3, huboEventosActivosPreviamente });

  const resumen: ResultadoImportarCiclo = {
    resultado: resultadoCiclo,
    eventosEnFeed: eventos.length,
    eventosAplicados: 0,
    ecosDescartados: 0,
    conflictosDetectados: 0,
    alertaCuarentena: alerta,
    revisionesUidReciclado: [],
    eventosDescartadosPorError: [],
    candidatosACancelarPorAusencia: [],
  };

  if (resultadoCiclo !== "exito_con_eventos") {
    await ctx.syncRepo.persistFeedSyncState(ctx.feed.id, nuevoEstado, nuevoEtag, nuevoLastModified, undefined, resumen);
    return resumen;
  }

  const hashesRecientes = await ctx.syncRepo.listHashesExportadosRecientes(ctx.feed.unidadId);

  for (const evento of eventos) {
    try {
      await procesarEventoDelCiclo(ctx, evento, hashesRecientes, resumen);
    } catch (error) {
      // Un evento individual del feed (rango invertido/vacío por una DURATION
      // negativa/cero, u otro error inesperado al procesarlo) NUNCA aborta el resto
      // del ciclo — se descarta y se reporta para revisión humana, dejando que los
      // demás eventos válidos del mismo feed se apliquen con normalidad.
      resumen.eventosDescartadosPorError.push({ uid: evento.uid, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Reconciliación completa: se computa en CADA ciclo con eventos, no en un job
  // aparte — ya se tiene el feed completo recién parseado en memoria, así que
  // comparar contra el conjunto de UIDs que el sistema cree activos internamente no
  // cuesta ninguna llamada de red adicional.
  const activosInternos = await ctx.syncRepo.listUidsActivosInternos(ctx.feed.unidadId, ctx.feed.canalId);
  const uidsPresentesEnFeed = new Set(eventos.map((e) => e.uid));
  const reconciliacion = reconciliarCompleto(activosInternos, uidsPresentesEnFeed);
  resumen.driftReconciliacionCompleta = reconciliacion.drift;
  // Los candidatos a cancelación implícita NUNCA se cancelan automáticamente — se
  // reportan para revisión humana (ver GET .../sync-status), mismo criterio que
  // 'revisar_uid_reciclado'/'eventosDescartadosPorError'.
  resumen.candidatosACancelarPorAusencia = reconciliacion.candidatosACancelarPorAusencia.map((c) => ({ ocupacionId: c.ocupacionId, uidCanal: c.uidCanal }));

  await ctx.syncRepo.persistFeedSyncState(ctx.feed.id, nuevoEstado, nuevoEtag, nuevoLastModified, reconciliacion.drift, resumen);

  return resumen;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ContextoExportacion {
  syncRepo: RentasCalendarSyncRepository;
  organizationId: string;
  propertyId: string;
  unidadId: string;
  canalId: string;
}

/** Genera el feed `.ics` exportable de una unidad para un canal (o para el endpoint
 * público, que exporta un único feed agregado de la unidad sin filtrar por canal
 * destino — ver apps/api/.../ical-feed-publico.ts): recorre las ocupaciones activas
 * bloqueantes de la unidad, calcula `sequence`/hash para detectar cambios reales
 * (nunca incrementa `sequence` en un re-export sin cambios), y persiste el
 * bookkeeping de `rentas.bloqueo_exportado` que la capa 2/3 del anti-eco necesita. */
export async function exportarFeedParaUnidad(ctx: ContextoExportacion, nombreCalendario: string): Promise<FeedExportado> {
  const activas = await ctx.syncRepo.listOcupacionesActivasBloqueantes(ctx.unidadId);

  // Hallazgo de auditoría (rubro 10, "performance y escalabilidad", severidad MEDIA):
  // "feed iCal público de rentas... ejecuta 3+2N queries por request" -- antes, este
  // bucle llamaba a `findBloqueoExportadoPrevio` UNA VEZ POR OCUPACIÓN. Ahora resuelve
  // el bookkeeping previo de TODAS las ocupaciones activas en una sola consulta
  // agregada (ver ./repository.ts::findBloqueosExportadosPrevios).
  const previos = await ctx.syncRepo.findBloqueosExportadosPrevios(
    activas.map((fila) => fila.id),
    ctx.canalId,
  );

  const bloqueos: BloqueoExportable[] = [];
  for (const fila of activas) {
    const previo = previos.get(fila.id) ?? null;
    const hashNuevo = calcularHashContenidoBloqueo({ unidadId: ctx.unidadId, dtstart: fila.inicio, dtend: fila.fin, razon: fila.razon as BloqueoExportable["razon"] });
    const sequenceAnterior = previo?.sequence ?? -1;
    const sequence = previo?.hashContenido === hashNuevo ? Math.max(sequenceAnterior, 0) : sequenceAnterior + 1;

    bloqueos.push({ ocupacionId: fila.id, unidadId: ctx.unidadId, rango: { inicio: fila.inicio, fin: fila.fin }, razon: fila.razon as BloqueoExportable["razon"], sequence });
  }

  const feed = exportarFeedIcs(nombreCalendario, bloqueos);

  // Mismo hallazgo que arriba: un solo upsert multi-fila para TODOS los bloqueos del
  // ciclo, en vez de un upsert por bloqueo dentro de un bucle.
  await ctx.syncRepo.upsertBloqueosExportadosBatch(
    ctx.organizationId,
    ctx.propertyId,
    ctx.canalId,
    bloqueos.map((bloqueo) => ({
      ocupacionId: bloqueo.ocupacionId,
      uidExportado: construirUidExportado(bloqueo.ocupacionId),
      hashContenido: feed.hashesPorOcupacion.get(bloqueo.ocupacionId)!,
      sequence: bloqueo.sequence,
    })),
  );

  return feed;
}

export type { EstadoFeedCanal } from "./cuarentena.ts";
