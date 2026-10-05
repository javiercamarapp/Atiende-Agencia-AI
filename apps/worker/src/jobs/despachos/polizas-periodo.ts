// runPolizasPeriodoSistema -- D-P3-14: cron DIARIO que arma y registra la poliza de cada CFDI del periodo que YA se puede contabilizar sin manos:
// clasificado con confianza suficiente (o corregido por una persona), sin revision pendiente, no cancelado ni excluido, con sentido emitido/recibido, de un
// periodo no cerrado y sin poliza vigente (la funcion de sistema `system_polizas_periodo_candidatos` decide todo eso en la base). La poliza sale de
// `construirPolizaDesdeCfdi` con la clasificacion vigente (la MISMA del boton por CFDI). Lo que no se puede armar sin inventar queda para el staff.
//
// Ventana: el mes en curso y los dos anteriores (los periodos cerrados los descarta la base). Tope de 200 CFDI por corrida, mas antiguos primero, y 22 s
// de presupuesto: lo que no alcance se contabiliza al dia siguiente (idempotente: un CFDI con poliza vigente ya no es candidato).
// UNA transaccion de sistema por CFDI (un error real en uno no aborta ni revierte los demas) y UNA por cliente para su aviso in-app
// (`despachos.libro.polizas_generadas`, dedupe por cliente y dia, sin PII).
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import { PolizasPeriodoNoDisponibleError, catalogoBaseParaSistema, decidirPolizaDeCandidato } from "@atiende/domain-despachos";
import type { PolizasPeriodoRepository } from "@atiende/domain-despachos";
import { mensajeDeError } from "./cron-comun.ts";
import type { NotificarCron } from "./cron-comun.ts";

export interface UnidadPolizasPeriodo {
  readonly repo: PolizasPeriodoRepository;
  /** Emite en la MISMA transaccion de la unidad (best-effort: emitirNotificacion nunca lanza ni aborta la transaccion). */
  readonly notificar: NotificarCron;
}
/** Abre una transaccion de sistema propia para `fn` (en las pruebas, reutiliza el doble en memoria). */
export type WithUnidadPolizasPeriodo = <T>(fn: (u: UnidadPolizasPeriodo) => Promise<T>) => Promise<T>;

export interface RunPolizasPeriodoOpciones {
  /** Inyectable SOLO para pruebas deterministas (fecha de negocio "hoy"). */
  readonly hoy?: string;
  readonly presupuestoMs?: number;
  readonly ahora?: () => number;
  readonly tope?: number;
}

export interface PolizasPeriodoResultado {
  readonly estado: "ok" | "no_disponible";
  readonly candidatos: number;
  readonly generadas: number;
  /** Ya tenian poliza o la base las dejo para el staff (periodo cerrado, cancelado, excluido, revision pendiente). */
  readonly omitidas: number;
  /** La base los dio por candidatos pero no se pueden armar sin inventar (sin cuenta, categoria sin mapeo...): quedan para el staff. */
  readonly noArmables: number;
  readonly clientesAvisados: number;
  readonly cortadoPorTiempo: boolean;
  readonly fallidos: readonly { readonly invoiceId: string; readonly propertyId: string; readonly error: string }[];
}

const TOPE_POR_CORRIDA = 200;
const PRESUPUESTO_MS = 22_000;

/** Primer dia del mes de `hoy` menos `meses` (YYYY-MM-DD). */
export function inicioDeVentana(hoy: string, meses: number): string {
  const anio = Number(hoy.slice(0, 4));
  const mes = Number(hoy.slice(5, 7)) - 1 - meses;
  const d = new Date(Date.UTC(anio, mes, 1));
  return d.toISOString().slice(0, 10);
}

export async function runPolizasPeriodoSistema(withUnidad: WithUnidadPolizasPeriodo, opciones: RunPolizasPeriodoOpciones = {}): Promise<PolizasPeriodoResultado> {
  const ahora = opciones.ahora ?? Date.now;
  const inicio = ahora();
  const presupuesto = opciones.presupuestoMs ?? PRESUPUESTO_MS;
  const hoy = opciones.hoy ?? hoyFechaNegocio();
  const desde = inicioDeVentana(hoy, 2);
  const candidatos = await withUnidad((u) => u.repo.listarCandidatos(desde, hoy, opciones.tope ?? TOPE_POR_CORRIDA));
  if (candidatos === null) return { estado: "no_disponible", candidatos: 0, generadas: 0, omitidas: 0, noArmables: 0, clientesAvisados: 0, cortadoPorTiempo: false, fallidos: [] };

  const catalogo = catalogoBaseParaSistema();
  let generadas = 0;
  let omitidas = 0;
  let noArmables = 0;
  let cortadoPorTiempo = false;
  const fallidos: { invoiceId: string; propertyId: string; error: string }[] = [];
  const generadasPorCliente = new Map<string, { organizationId: string; cantidad: number }>();

  for (const c of candidatos) {
    if (ahora() - inicio > presupuesto) {
      cortadoPorTiempo = true;
      break;
    }
    const decision = decidirPolizaDeCandidato(c);
    if (!decision.ok) {
      noArmables += 1;
      continue;
    }
    try {
      const r = await withUnidad((u) => u.repo.registrarPolizaSistema(c.propertyId, c.invoiceId, decision.poliza, catalogo));
      if (r.estado === "creada") {
        generadas += 1;
        const previo = generadasPorCliente.get(c.propertyId);
        generadasPorCliente.set(c.propertyId, { organizationId: c.organizationId, cantidad: (previo?.cantidad ?? 0) + 1 });
      } else {
        omitidas += 1;
      }
    } catch (err) {
      if (err instanceof PolizasPeriodoNoDisponibleError) return { estado: "no_disponible", candidatos: candidatos.length, generadas, omitidas, noArmables, clientesAvisados: 0, cortadoPorTiempo, fallidos };
      fallidos.push({ invoiceId: c.invoiceId, propertyId: c.propertyId, error: mensajeDeError(err) });
    }
  }

  let clientesAvisados = 0;
  for (const [propertyId, { organizationId, cantidad }] of generadasPorCliente) {
    try {
      await withUnidad((u) =>
        u.notificar({ evento: "despachos.libro.polizas_generadas", organizationId, propertyId, clave: `${propertyId}:${hoy}`, parametros: { cantidad }, entidadTipo: "property", entidadId: propertyId }),
      );
      clientesAvisados += 1;
    } catch (err) {
      fallidos.push({ invoiceId: "-", propertyId, error: `aviso: ${mensajeDeError(err)}` });
    }
  }
  return { estado: "ok", candidatos: candidatos.length, generadas, omitidas, noArmables, clientesAvisados, cortadoPorTiempo, fallidos };
}
