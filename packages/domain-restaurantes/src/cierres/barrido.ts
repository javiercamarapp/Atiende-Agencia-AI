// Barrido de cierres (R-42): para UNA sucursal asegura el cierre de los ultimos dias cerrados y de las semanas que terminaron, y
// avisa en la campana (`restaurantes.cierre.dia_listo` / `semana_lista`) SOLO cuando el cierre se creo en esta llamada. Todo es
// idempotente por fecha de negocio (llave unica de la tabla + `generar_cierre`): correrlo dos veces, o dos instancias a la vez, deja
// UN cierre y UN aviso por periodo (el aviso ademas tiene clave de dedupe propia).
//
// Quien lo llama abre una transaccion POR sucursal (`withAppSession({ userId: null })`): un fallo en una sucursal no revierte ni
// frena a las demas (ver apps/api .../cierres-interno.ts).
import { emitirNotificacion } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { diaLocalSucursal } from "../voz/kpi.ts";
import { pesosEnteros, periodosACerrar } from "./cierre.ts";
import type { CierreReporte, CierreRepository, CierreSucursal } from "./cierre.ts";

export interface BarridoSucursalResultado {
  readonly propertyId: string;
  readonly hoyLocal: string;
  readonly creados: number;
  readonly existentes: number;
  readonly sinActividad: number;
  readonly noDisponible: boolean;
  readonly avisos: number;
}

/** Aviso in-app de un cierre recien creado. Sin PII (solo fecha, conteo y pesos). Devuelve true si se emitio al menos a un destinatario. */
export async function notificarCierreCreado(db: TenantDbSession, organizationId: string, propertyId: string, reporte: CierreReporte): Promise<boolean> {
  const r = await emitirNotificacion(db, {
    evento: reporte.tipo === "dia" ? "restaurantes.cierre.dia_listo" : "restaurantes.cierre.semana_lista",
    organizationId,
    propertyId,
    clave: `${propertyId}-${reporte.fechaInicio}`,
    parametros: { fecha: reporte.fechaInicio, pedidos: reporte.datos.pedidos, ventas: pesosEnteros(reporte.datos.ventasCentavos) },
    entidadTipo: "cierre_reporte",
    entidadId: reporte.id,
  });
  return r.estado === "emitida";
}

export async function barrerCierresSucursal(input: {
  readonly db: TenantDbSession;
  readonly repo: CierreRepository;
  readonly sucursal: CierreSucursal;
  readonly ahora: Date;
  readonly dias: number;
}): Promise<BarridoSucursalResultado> {
  const { db, repo, sucursal } = input;
  const { fecha: hoyLocal } = diaLocalSucursal(input.ahora, sucursal.zonaHoraria);
  let creados = 0;
  let existentes = 0;
  let sinActividad = 0;
  let avisos = 0;
  let noDisponible = false;
  for (const p of periodosACerrar(hoyLocal, input.dias)) {
    const g = await repo.generar(sucursal.organizationId, sucursal.propertyId, p.tipo, p.fechaInicio, { omitirSinActividad: true });
    if (g.estado === "no_disponible") {
      noDisponible = true;
      break;
    }
    // El dia de negocio todavia no termina (turno que cruza la medianoche): se asegura en la siguiente corrida, sin error.
    if (g.estado === "periodo_abierto") continue;
    if (g.estado === "sin_actividad") sinActividad++;
    else if (g.estado === "existente") existentes++;
    else {
      creados++;
      if (await notificarCierreCreado(db, sucursal.organizationId, sucursal.propertyId, g.reporte)) avisos++;
    }
  }
  return { propertyId: sucursal.propertyId, hoyLocal, creados, existentes, sinActividad, noDisponible, avisos };
}
