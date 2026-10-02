// runVencimientosBarridoSistema -- hueco de D-26: cron DIARIO que, por cada cliente con ficha, (1) genera las obligaciones del
// periodo en curso (misma logica que `POST .../vencimientos/calcular`) y (2) escala los vencimientos que vencen hoy, manana o ya
// vencieron (misma decision que el barrido de staff, `decidirEscalamiento`), emitiendo los avisos in-app de catalogo
// (`despachos.fiscal.vencimiento_proximo` / `_vencido`) con dedupe diario por property.
//
// Solo se genera el periodo EN CURSO (no el mes anterior): un cliente recien dado de alta no debe recibir de golpe obligaciones
// pasadas ya presentadas fuera del sistema, que se escalarian como "vencidas" y dispararian avisos criticos falsos; el mes
// anterior lo cubre el calendario generado el mes pasado, o el boton de calcular del panel.
//
// Idempotente: el upsert no duplica, el escalamiento no repite un nivel igual o mayor y los avisos solo salen cuando se escala algo
// nuevo, asi que dos corridas el mismo dia no notifican dos veces. UNA transaccion por cliente (property).
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import { CronSatNoDisponibleError, REGIMEN_FISCAL_POR_DEFECTO, calcularVencimientosDelPeriodo, decidirEscalamiento, diasHasta, regimenSoportado } from "@atiende/domain-despachos";
import type { NivelEscalamiento, TipoVencimiento } from "@atiende/domain-despachos";
import { mensajeDeError } from "./cron-comun.ts";
import type { WithUnidadCronSat } from "./cron-comun.ts";

const RANGO: Readonly<Record<NivelEscalamiento, number>> = { nivel_1: 1, nivel_2: 2, nivel_3: 3, nivel_4: 4 };
const TOPE_CLIENTES = 1000;

export interface RunVencimientosBarridoOpciones {
  /** Inyectable SOLO para pruebas deterministas (fecha de negocio "hoy" para TODOS los clientes). */
  readonly hoy?: string;
}

export interface VencimientosBarridoClienteResultado {
  readonly propertyId: string;
  readonly creados: number;
  readonly escalados: number;
  readonly yaEscalados: number;
  readonly avisosPorVencer: number;
  readonly avisosVencidos: number;
}

export interface VencimientosBarridoResultado {
  readonly estado: "ok" | "no_disponible";
  readonly clientes: number;
  readonly creados: number;
  readonly escalados: number;
  readonly yaEscalados: number;
  readonly fallidos: readonly { readonly propertyId: string; readonly error: string }[];
}

function regimenDeLaFicha(regimenes: readonly string[]): string {
  return regimenes.find((r) => regimenSoportado(r)) ?? REGIMEN_FISCAL_POR_DEFECTO;
}

export async function runVencimientosBarridoSistema(withUnidad: WithUnidadCronSat, opciones: RunVencimientosBarridoOpciones = {}): Promise<VencimientosBarridoResultado> {
  const clientes = await withUnidad((u) => u.repo.listarClientesFichaSistema(TOPE_CLIENTES));
  if (clientes === null) return { estado: "no_disponible", clientes: 0, creados: 0, escalados: 0, yaEscalados: 0, fallidos: [] };

  let creados = 0;
  let escalados = 0;
  let yaEscalados = 0;
  const fallidos: { propertyId: string; error: string }[] = [];

  for (const cliente of clientes) {
    try {
      const r = await withUnidad(async ({ repo, notificar }): Promise<VencimientosBarridoClienteResultado> => {
        const hoy = opciones.hoy ?? hoyFechaNegocio(cliente.zonaHoraria ?? undefined);
        const [anio, mes] = hoy.split("-").map(Number) as [number, number];
        const nuevos = calcularVencimientosDelPeriodo(anio, mes, hoy, { regimenFiscal: regimenDeLaFicha(cliente.regimenes) });
        let creadosCliente = 0;
        for (const n of nuevos) {
          const u = await repo.upsertVencimientoSistema(cliente.propertyId, { tipo: n.tipo, periodo: n.periodo, fechaLimite: n.fechaLimite, prioridad: n.prioridad });
          if (u.creado) creadosCliente += 1;
        }

        let escaladosCliente = 0;
        let yaCliente = 0;
        let porVencer = 0;
        let vencidos = 0;
        for (const v of await repo.listarVencimientosPorEscalarSistema(cliente.propertyId, hoy)) {
          const dias = diasHasta(v.fechaLimite, hoy);
          const decision = decidirEscalamiento(v.tipo as TipoVencimiento, v.fechaLimite, dias);
          if (v.nivelMax !== null && RANGO[v.nivelMax] >= RANGO[decision.level]) {
            yaCliente += 1;
            continue;
          }
          if (!(await repo.escalarVencimientoSistema(v.id, decision.level, decision.notes))) {
            yaCliente += 1;
            continue;
          }
          escaladosCliente += 1;
          if (decision.level === "nivel_4") vencidos += 1;
          else if (decision.level === "nivel_2" || decision.level === "nivel_3") porVencer += 1;
        }
        if (porVencer > 0) await notificar({ evento: "despachos.fiscal.vencimiento_proximo", organizationId: cliente.organizationId, propertyId: cliente.propertyId, clave: `${cliente.propertyId}:${hoy}`, parametros: { cantidad: porVencer } });
        if (vencidos > 0) await notificar({ evento: "despachos.fiscal.vencimiento_vencido", organizationId: cliente.organizationId, propertyId: cliente.propertyId, clave: `${cliente.propertyId}:${hoy}`, parametros: { cantidad: vencidos } });
        return { propertyId: cliente.propertyId, creados: creadosCliente, escalados: escaladosCliente, yaEscalados: yaCliente, avisosPorVencer: porVencer, avisosVencidos: vencidos };
      });
      creados += r.creados;
      escalados += r.escalados;
      yaEscalados += r.yaEscalados;
    } catch (err) {
      if (err instanceof CronSatNoDisponibleError) return { estado: "no_disponible", clientes: clientes.length, creados, escalados, yaEscalados, fallidos };
      fallidos.push({ propertyId: cliente.propertyId, error: mensajeDeError(err) });
    }
  }
  return { estado: "ok", clientes: clientes.length, creados, escalados, yaEscalados, fallidos };
}
