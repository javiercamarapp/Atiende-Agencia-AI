// runPilotoCierreClienteSweep -- paridad3 D-31 + D-P3-15: cron DIARIO del piloto automatico de documentos y cierre.
//
//  1. SOLICITUDES: por cada cliente con ficha al que ya le toca (su dia configurado, por omision el 1) crea la solicitud de documentos del mes
//     anterior (idempotente por cliente y periodo) y, si tiene correo de contacto, le manda el aviso con su enlace al portal.
//  2. RECORDATORIOS: a los 3, 7 y 10 dias mientras falten documentos del cliente. Se detienen cuando la solicitud se completa. A los 10 dias tambien
//     avisa al despacho en la campana (`despachos.solicitud.sin_completar`, sin PII).
//  3. CIERRE: por cada periodo de cierre ABIERTO calcula en el servidor el estado de los modulos (nada viene del navegador), auto-completa las tareas
//     cuya senal persistida se cumple y avisa UNA vez (`despachos.cierre.listo_para_revisar`) cuando el periodo ya termino y todas las validaciones
//     pasan. NO cierra ningun periodo (cerrar es irreversible y exige a un admin con segundo factor) y NO presenta nada ante el SAT.
//
// Cada unidad (un cliente, una solicitud, un periodo) corre en su PROPIA transaccion de sistema: un error SQL real la deja abortada (25P02) y su
// COMMIT haria ROLLBACK; con una transaccion por unidad el fallo queda aislado. Compatible con la base sin migrar: sin la migracion 027 cada paso
// responde `no_disponible` (200, nada hecho), nunca un 500. Los avisos in-app salen de `emitirNotificacion` (catalogo, dedupe por clave, sin PII) a traves de la
// funcion `notificar` que inyecta cron-sat.ts. Sin correo de contacto no se envia nada (honesto: la solicitud queda en el portal).
import { autoCheckHastaPuntoFijo, autoCheckTareas, correoRecordatorioDocumentos, correoSolicitudDocumentos, evaluarValidacionesCierre, generarTokenPortal, hashTokenPortal, moduleStateDesdeEstado, validacionesFallidas } from "@atiende/domain-despachos";
import type { PilotoRepository } from "@atiende/domain-despachos";
import { mensajeDeError } from "./cron-comun.ts";
import type { NotificarCron } from "./cron-comun.ts";

export interface UnidadPiloto {
  readonly piloto: PilotoRepository;
  /** Encola un correo en el outbox de la organizacion (idempotente por `dedupeKey`). */
  readonly encolarCorreo: (organizationId: string, eventType: string, dedupeKey: string, payload: { readonly to: string; readonly subject: string; readonly html: string; readonly text: string }) => Promise<void>;
  readonly notificar: NotificarCron;
}
/** Abre una transaccion de sistema propia para `fn` (en las pruebas, reutiliza el doble en memoria). */
export type WithUnidadPiloto = <T>(fn: (u: UnidadPiloto) => Promise<T>) => Promise<T>;

export interface RunPilotoCierreClienteOpciones {
  /** Fecha de negocio de hoy (AAAA-MM-DD). */
  readonly hoy: string;
  /** Base publica de la app para armar el enlace del portal (`<base>/portal/cliente#t=<token>`). */
  readonly appBaseUrl: string;
  readonly limite?: number;
  /** Vigencia del enlace del aviso, en dias. */
  readonly vigenciaEnlaceDias?: number;
  /** Generador de token inyectable (pruebas). */
  readonly generarToken?: () => string;
}

export interface PilotoPaso {
  readonly estado: "ok" | "no_disponible";
  readonly fallidos: readonly { readonly id: string; readonly error: string }[];
}
export interface PilotoCierreClienteResultado {
  readonly solicitudes: PilotoPaso & { readonly creadas: number; readonly yaExistian: number; readonly correosEncolados: number; readonly sinContacto: number };
  readonly recordatorios: PilotoPaso & { readonly enviados: number; readonly sinContacto: number; readonly avisosAlDespacho: number };
  readonly cierre: PilotoPaso & { readonly periodos: number; readonly tareasCompletadas: number; readonly listosParaRevisar: number };
  readonly fallidos: number;
}

const TOPE_DEFECTO = 500;
const mm = (n: number): string => String(n).padStart(2, "0");

export async function runPilotoCierreClienteSweep(withUnidad: WithUnidadPiloto, opciones: RunPilotoCierreClienteOpciones): Promise<PilotoCierreClienteResultado> {
  const limite = opciones.limite ?? TOPE_DEFECTO;
  const vigencia = opciones.vigenciaEnlaceDias ?? 35;
  const nuevoToken = opciones.generarToken ?? generarTokenPortal;
  let base = opciones.appBaseUrl;
  while (base.endsWith("/")) base = base.slice(0, -1);

  /** Enlace del portal para un aviso; si no se puede crear (tope, sin admin al que atribuirlo) el aviso sale sin enlace, honesto. */
  async function enlaceDelPortal(u: UnidadPiloto, propertyId: string, etiqueta: string): Promise<string | null> {
    const token = nuevoToken();
    try {
      await u.piloto.crearEnlaceSistema(propertyId, hashTokenPortal(token), etiqueta, vigencia);
      return `${base}/portal/cliente#t=${token}`;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ 1. solicitudes
  const sol = { creadas: 0, yaExistian: 0, correosEncolados: 0, sinContacto: 0 };
  const solFallidos: { id: string; error: string }[] = [];
  const porCrear = await withUnidad((u) => u.piloto.solicitudesPorCrear(opciones.hoy, limite));
  if (porCrear !== null) {
    for (const s of porCrear) {
      try {
        await withUnidad(async (u) => {
          const reg = await u.piloto.crearSolicitudSistema(s.propertyId, s.ejercicio, s.mes);
          if (!reg.creada) {
            sol.yaExistian += 1;
            return;
          }
          sol.creadas += 1;
          if (!reg.contactoCorreo) {
            sol.sinContacto += 1;
            return;
          }
          const enlace = await enlaceDelPortal(u, s.propertyId, `Solicitud ${s.ejercicio}-${mm(s.mes)}`);
          const correo = correoSolicitudDocumentos({ clienteNombre: reg.cliente, ejercicio: s.ejercicio, mes: s.mes, renglones: reg.etiquetas, enlace });
          await u.encolarCorreo(reg.organizationId, "despachos.solicitud.documentos", `solicitud:${reg.id}:inicial`, { to: reg.contactoCorreo, subject: correo.asunto, html: correo.html, text: correo.texto });
          sol.correosEncolados += 1;
        });
      } catch (err) {
        solFallidos.push({ id: s.propertyId, error: mensajeDeError(err) });
      }
    }
  }

  // ------------------------------------------------------------------ 2. recordatorios
  const rec = { enviados: 0, sinContacto: 0, avisosAlDespacho: 0 };
  const recFallidos: { id: string; error: string }[] = [];
  const paraRecordar = await withUnidad((u) => u.piloto.solicitudesParaRecordatorio(opciones.hoy, limite));
  if (paraRecordar !== null) {
    for (const r of paraRecordar) {
      try {
        await withUnidad(async (u) => {
          if (r.contactoCorreo) {
            const enlace = await enlaceDelPortal(u, r.propertyId, `Solicitud ${r.ejercicio}-${mm(r.mes)}`);
            const correo = correoRecordatorioDocumentos({ clienteNombre: r.cliente, ejercicio: r.ejercicio, mes: r.mes, pendientes: r.pendientes, dias: r.dias, enlace });
            await u.encolarCorreo(r.organizationId, "despachos.solicitud.recordatorio", `solicitud:${r.id}:recordatorio${r.nivel}`, { to: r.contactoCorreo, subject: correo.asunto, html: correo.html, text: correo.texto });
            rec.enviados += 1;
          } else {
            rec.sinContacto += 1;
          }
          if (r.nivel === 3) {
            await u.notificar({ evento: "despachos.solicitud.sin_completar", organizationId: r.organizationId, propertyId: r.propertyId, clave: r.id, parametros: { cantidad: r.pendientes }, entidadTipo: "solicitud_documentos", entidadId: r.id });
            rec.avisosAlDespacho += 1;
          }
          await u.piloto.marcarRecordatorio(r.id, r.nivel);
        });
      } catch (err) {
        recFallidos.push({ id: r.id, error: mensajeDeError(err) });
      }
    }
  }

  // ------------------------------------------------------------------ 3. cierre en piloto automatico
  const cie = { periodos: 0, tareasCompletadas: 0, listosParaRevisar: 0 };
  const cieFallidos: { id: string; error: string }[] = [];
  const abiertos = await withUnidad((u) => u.piloto.periodosCierreAbiertos(limite));
  const [anioHoy, mesHoy] = [Number(opciones.hoy.slice(0, 4)), Number(opciones.hoy.slice(5, 7))];
  if (abiertos !== null) {
    for (const p of abiertos) {
      try {
        await withUnidad(async (u) => {
          const est = await u.piloto.estadoModulosCierre(p.propertyId, p.anio, p.mes);
          if (!est.disponible) return;
          cie.periodos += 1;
          const tareas = await u.piloto.tareasCierreSistema(p.periodoId);
          const moduleState = moduleStateDesdeEstado(est.valor, p.mes);
          const ahora = new Date().toISOString();
          const { completadas } = autoCheckHastaPuntoFijo(tareas, (t) => autoCheckTareas(t, moduleState, "sistema", ahora));
          if (completadas.length > 0) {
            await u.piloto.autocompletarTareasSistema(p.periodoId, completadas.map((t) => t.id));
            cie.tareasCompletadas += completadas.length;
          }
          // Solo un periodo que ya termino puede estar «listo»: en el mes en curso aun entran movimientos.
          const yaTermino = p.anio < anioHoy || (p.anio === anioHoy && p.mes < mesHoy);
          if (yaTermino && validacionesFallidas(evaluarValidacionesCierre(est.valor, p.mes)).length === 0) {
            await u.notificar({ evento: "despachos.cierre.listo_para_revisar", organizationId: p.organizationId, propertyId: p.propertyId, clave: p.periodoId, entidadTipo: "periodo_cierre", entidadId: p.periodoId });
            cie.listosParaRevisar += 1;
          }
        });
      } catch (err) {
        cieFallidos.push({ id: p.periodoId, error: mensajeDeError(err) });
      }
    }
  }

  return {
    solicitudes: { estado: porCrear === null ? "no_disponible" : "ok", ...sol, fallidos: solFallidos },
    recordatorios: { estado: paraRecordar === null ? "no_disponible" : "ok", ...rec, fallidos: recFallidos },
    cierre: { estado: abiertos === null ? "no_disponible" : "ok", ...cie, fallidos: cieFallidos },
    fallidos: solFallidos.length + recFallidos.length + cieFallidos.length,
  };
}
