// runCfdiEstatusSatSweep -- D-27 + paridad3 D-P3-19: barrido DIARIO del estatus de los CFDI ante el SAT (consulta PUBLICA, sin credenciales).
//
// Orden y tope: por prioridad (nunca consultados, cancelacion «En proceso», recientes y vigentes dentro de la ventana de ejercicios; fuera
// de la ventana no se reconsultan), con tope por cliente (`porProperty`: un cliente con miles de CFDI no acapara la cuota de la plataforma),
// maximo `limite` por corrida y un presupuesto de tiempo (`presupuestoMs`) para no pasarse del limite de la funcion serverless; lo que no alcance se atiende
// en la siguiente corrida. La consulta al SAT va FUERA de la transaccion de base (no se retiene una conexion durante la red) y el
// registro de cada resultado corre en su PROPIA transaccion.
//
// Fail-safe: si el SAT no responde (timeout, red, HTTP, XML ilegible) el CFDI queda 'pendiente' (o conserva su estado verificado)
// y solo se anota el intento: jamas pasa a 'vigente' por error. Un CFDI que pasa a 'cancelado' emite `despachos.cfdi.cancelado`
// UNA vez (la transicion es terminal y la clave de dedupe es el id del CFDI).
import { CronSatNoDisponibleError } from "@atiende/domain-despachos";
import type { ConsultaCfdiSatPort } from "@atiende/domain-despachos";
import { mensajeDeError } from "./cron-comun.ts";
import type { WithUnidadCronSat } from "./cron-comun.ts";

export const CFDI_ESTATUS_SAT_LIMITE_DEFECTO = 60;
export const CFDI_ESTATUS_SAT_REINTENTO_DIAS = 6;
/** Ejercicios en que un CFDI vigente aun puede cancelarse: el en curso y el anterior. */
export const CFDI_ESTATUS_SAT_VENTANA_EJERCICIOS = 2;
export const CFDI_ESTATUS_SAT_POR_PROPERTY = 15;
export const CFDI_ESTATUS_SAT_PRESUPUESTO_MS = 22_000;
const CONCURRENCIA_SAT = 3;

export interface RunCfdiEstatusSatOpciones {
  readonly limite?: number;
  readonly reintentoDias?: number;
  readonly ventanaEjercicios?: number;
  readonly porProperty?: number;
  readonly presupuestoMs?: number;
  /** Reloj inyectable (pruebas del presupuesto de tiempo). */
  readonly ahora?: () => number;
}

export interface CfdiEstatusSatResultado {
  readonly estado: "ok" | "no_disponible";
  readonly revisados: number;
  readonly vigentes: number;
  readonly cancelados: number;
  readonly noEncontrados: number;
  /** Consultas que no concluyeron (SAT caido/timeout/respuesta ilegible): quedan en su estado y se reintentan en otra corrida. */
  readonly sinConcluir: number;
  /** CFDI que pasaron a cancelado en ESTA corrida (cada uno notificado una vez). */
  readonly nuevosCancelados: number;
  /** CFDI cuya cancelacion «En proceso» aparecio por primera vez en ESTA corrida (cada uno notificado una vez). */
  readonly cancelacionesEnProceso: number;
  /** true si el presupuesto de tiempo corto el barrido antes de terminar el lote. */
  readonly cortadoPorTiempo: boolean;
  readonly fallidos: readonly { readonly invoiceId: string; readonly error: string }[];
}

export async function runCfdiEstatusSatSweep(withUnidad: WithUnidadCronSat, sat: ConsultaCfdiSatPort, opciones: RunCfdiEstatusSatOpciones = {}): Promise<CfdiEstatusSatResultado> {
  const limite = opciones.limite ?? CFDI_ESTATUS_SAT_LIMITE_DEFECTO;
  const reintentoDias = opciones.reintentoDias ?? CFDI_ESTATUS_SAT_REINTENTO_DIAS;
  const ventanaEjercicios = opciones.ventanaEjercicios ?? CFDI_ESTATUS_SAT_VENTANA_EJERCICIOS;
  const porProperty = opciones.porProperty ?? CFDI_ESTATUS_SAT_POR_PROPERTY;
  const presupuestoMs = opciones.presupuestoMs ?? CFDI_ESTATUS_SAT_PRESUPUESTO_MS;
  const ahora = opciones.ahora ?? Date.now;
  const inicio = ahora();

  const pendientes = await withUnidad((u) => u.repo.listarCfdiPendientesEstatusSat(limite, reintentoDias, ventanaEjercicios, porProperty));
  if (pendientes === null) return { estado: "no_disponible", revisados: 0, vigentes: 0, cancelados: 0, noEncontrados: 0, sinConcluir: 0, nuevosCancelados: 0, cancelacionesEnProceso: 0, cortadoPorTiempo: false, fallidos: [] };

  let revisados = 0;
  let vigentes = 0;
  let cancelados = 0;
  let noEncontrados = 0;
  let sinConcluir = 0;
  let nuevosCancelados = 0;
  let cancelacionesEnProceso = 0;
  let cortadoPorTiempo = false;
  const fallidos: { invoiceId: string; error: string }[] = [];
  let siguiente = 0;

  const trabajador = async (): Promise<void> => {
    for (;;) {
      if (ahora() - inicio > presupuestoMs) {
        cortadoPorTiempo = true;
        return;
      }
      const idx = siguiente++;
      const cfdi = pendientes[idx];
      if (!cfdi) return;
      const consulta = await sat.consultar({ rfcEmisor: cfdi.rfcEmisor, rfcReceptor: cfdi.rfcReceptor, total: cfdi.total, folioFiscal: cfdi.folioFiscal });
      try {
        await withUnidad(async ({ repo, notificar }) => {
          const reg = await repo.registrarEstatusSatSistema(
            cfdi.invoiceId,
            consulta.consultado ? consulta.estado : "pendiente",
            consulta.consultado ? { esCancelable: consulta.esCancelable, estatusCancelacion: consulta.estatusCancelacion, codigoEstatus: consulta.codigoEstatus, validacionEfos: consulta.validacionEfos } : undefined,
          );
          if (reg.cambioACancelado) {
            await notificar({ evento: "despachos.cfdi.cancelado", organizationId: reg.organizationId, propertyId: reg.propertyId, clave: cfdi.invoiceId, entidadTipo: "invoice", entidadId: cfdi.invoiceId });
            nuevosCancelados += 1;
          } else if (reg.cancelacionEnProcesoNueva) {
            // El receptor tiene 72 h para aceptar o rechazar: el despacho debe enterarse (una vez por CFDI, sin PII en el texto).
            await notificar({ evento: "despachos.cfdi.cancelacion_en_proceso", organizationId: reg.organizationId, propertyId: reg.propertyId, clave: cfdi.invoiceId, entidadTipo: "invoice", entidadId: cfdi.invoiceId });
            cancelacionesEnProceso += 1;
          }
        });
        revisados += 1;
        if (!consulta.consultado) sinConcluir += 1;
        else if (consulta.estado === "vigente") vigentes += 1;
        else if (consulta.estado === "cancelado") cancelados += 1;
        else if (consulta.estado === "no_encontrado") noEncontrados += 1;
      } catch (err) {
        if (err instanceof CronSatNoDisponibleError) throw err;
        fallidos.push({ invoiceId: cfdi.invoiceId, error: mensajeDeError(err) });
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCIA_SAT, Math.max(1, pendientes.length)) }, trabajador));
  } catch (err) {
    if (err instanceof CronSatNoDisponibleError) return { estado: "no_disponible", revisados, vigentes, cancelados, noEncontrados, sinConcluir, nuevosCancelados, cancelacionesEnProceso, cortadoPorTiempo, fallidos };
    throw err;
  }
  return { estado: "ok", revisados, vigentes, cancelados, noEncontrados, sinConcluir, nuevosCancelados, cancelacionesEnProceso, cortadoPorTiempo, fallidos };
}
