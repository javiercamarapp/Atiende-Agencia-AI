// runVencimientosBarridoSistema -- hueco de D-26: cron DIARIO que, por cada cliente con ficha, (1) genera las obligaciones del
// periodo en curso (misma logica que `POST .../vencimientos/calcular`) y rellena el periodo ANTERIOR si no corrio, (2) escala los
// vencimientos que vencen en 7, 3 o 1 dia(s) HABIL(ES), hoy, o ya vencieron (D-P3-33; antes por dias naturales, solo hoy o manana),
// emitiendo los avisos in-app de catalogo (`despachos.fiscal.vencimiento_proximo` / `_vencido`) con dedupe diario por property y (3)
// encola el CORREO de escalamiento al staff owner/admin (antes solo salia con el boton del panel) con dedupe diario por vencimiento,
// nivel y destinatario; la lista de supresion de plataforma la aplica el despacho del outbox.
//
// Periodo anterior (D-P3-33, "rellena periodos que no corrieron"): solo se genera si el cliente YA TENIA vencimientos de periodos
// anteriores y el periodo anterior no tiene ninguno (un hueco real del cron). Un cliente recien dado de alta (sin historial) NO recibe de
// golpe obligaciones pasadas ya presentadas fuera del sistema, que se escalarian como "vencidas" y dispararian avisos criticos falsos; el
// contador marca como completada la que no aplique.
//
// Idempotente: el upsert no duplica, el escalamiento no repite un nivel igual o mayor y los avisos y correos solo salen cuando se escala algo
// nuevo, asi que dos corridas el mismo dia no notifican dos veces. UNA transaccion por cliente (property).
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import { CronSatNoDisponibleError, REGIMEN_FISCAL_POR_DEFECTO, calcularVencimientosDelPeriodo, decidirEscalamientoHabil, diasHabilesHasta, encolarCorreoEscalamientoSistema, regimenSoportado } from "@atiende/domain-despachos";
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
  /** Obligaciones del periodo anterior que no habian corrido y se generaron (incluidas en `creados`). */
  readonly rellenados: number;
  /** Obligaciones que la base aun no admite (falta la migracion 019/024): no se crearon. */
  readonly omitidos: number;
  readonly escalados: number;
  readonly yaEscalados: number;
  readonly avisosPorVencer: number;
  readonly avisosVencidos: number;
  readonly correosEncolados: number;
}

export interface VencimientosBarridoResultado {
  readonly estado: "ok" | "no_disponible";
  readonly clientes: number;
  readonly creados: number;
  readonly rellenados: number;
  readonly omitidos: number;
  readonly escalados: number;
  readonly yaEscalados: number;
  readonly correosEncolados: number;
  readonly fallidos: readonly { readonly propertyId: string; readonly error: string }[];
}

function regimenDeLaFicha(regimenes: readonly string[]): string {
  return regimenes.find((r) => regimenSoportado(r)) ?? REGIMEN_FISCAL_POR_DEFECTO;
}

function periodoAnterior(anio: number, mes: number): { anio: number; mes: number } {
  return mes === 1 ? { anio: anio - 1, mes: 12 } : { anio, mes: mes - 1 };
}

export async function runVencimientosBarridoSistema(withUnidad: WithUnidadCronSat, opciones: RunVencimientosBarridoOpciones = {}): Promise<VencimientosBarridoResultado> {
  const clientes = await withUnidad((u) => u.repo.listarClientesFichaSistema(TOPE_CLIENTES));
  if (clientes === null) return { estado: "no_disponible", clientes: 0, creados: 0, rellenados: 0, omitidos: 0, escalados: 0, yaEscalados: 0, correosEncolados: 0, fallidos: [] };

  let creados = 0;
  let rellenados = 0;
  let omitidos = 0;
  let escalados = 0;
  let yaEscalados = 0;
  let correosEncolados = 0;
  const fallidos: { propertyId: string; error: string }[] = [];

  for (const cliente of clientes) {
    try {
      const r = await withUnidad(async ({ repo, notificar }): Promise<VencimientosBarridoClienteResultado> => {
        const hoy = opciones.hoy ?? hoyFechaNegocio(cliente.zonaHoraria ?? undefined);
        const [anio, mes] = hoy.split("-").map(Number) as [number, number];
        const regimenFiscal = regimenDeLaFicha(cliente.regimenes);

        // Periodo anterior solo si el cliente ya corria (tiene periodos previos) y ese periodo quedo sin generar.
        const periodosPrevios = (await repo.listarPeriodosVencimientosSistema(cliente.propertyId)) ?? [];
        const anterior = periodoAnterior(anio, mes);
        const periodoAnteriorTexto = `${anterior.anio}-${String(anterior.mes).padStart(2, "0")}`;
        const periodoEnCurso = `${anio}-${String(mes).padStart(2, "0")}`;
        const hayHistorial = periodosPrevios.some((p) => p < periodoEnCurso);
        const rellenar = hayHistorial && !periodosPrevios.includes(periodoAnteriorTexto);

        let creadosCliente = 0;
        let rellenadosCliente = 0;
        let omitidosCliente = 0;
        const periodos = rellenar ? [{ anio: anterior.anio, mes: anterior.mes, esRelleno: true }, { anio, mes, esRelleno: false }] : [{ anio, mes, esRelleno: false }];
        for (const p of periodos) {
          for (const n of calcularVencimientosDelPeriodo(p.anio, p.mes, hoy, { regimenFiscal })) {
            const u = await repo.upsertVencimientoSistema(cliente.propertyId, { tipo: n.tipo, periodo: n.periodo, fechaLimite: n.fechaLimite, prioridad: n.prioridad });
            if (u.omitido) omitidosCliente += 1;
            else if (u.creado) {
              creadosCliente += 1;
              if (p.esRelleno) rellenadosCliente += 1;
            }
          }
        }

        let escaladosCliente = 0;
        let yaCliente = 0;
        let porVencer = 0;
        let vencidos = 0;
        let correos = 0;
        for (const v of await repo.listarVencimientosPorEscalarSistema(cliente.propertyId, hoy)) {
          const dias = diasHabilesHasta(hoy, v.fechaLimite);
          const decision = decidirEscalamientoHabil(v.tipo as TipoVencimiento, v.fechaLimite, dias);
          if (decision === null) continue; // aun faltan mas de 7 dias habiles
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
          else porVencer += 1;
          correos += await encolarCorreoEscalamientoSistema(repo, { id: v.id, organizationId: cliente.organizationId, propertyId: cliente.propertyId, tipo: v.tipo as TipoVencimiento, periodo: v.periodo, fechaLimite: v.fechaLimite }, decision, dias, hoy);
        }
        if (porVencer > 0) await notificar({ evento: "despachos.fiscal.vencimiento_proximo", organizationId: cliente.organizationId, propertyId: cliente.propertyId, clave: `${cliente.propertyId}:${hoy}`, parametros: { cantidad: porVencer } });
        if (vencidos > 0) await notificar({ evento: "despachos.fiscal.vencimiento_vencido", organizationId: cliente.organizationId, propertyId: cliente.propertyId, clave: `${cliente.propertyId}:${hoy}`, parametros: { cantidad: vencidos } });
        return { propertyId: cliente.propertyId, creados: creadosCliente, rellenados: rellenadosCliente, omitidos: omitidosCliente, escalados: escaladosCliente, yaEscalados: yaCliente, avisosPorVencer: porVencer, avisosVencidos: vencidos, correosEncolados: correos };
      });
      creados += r.creados;
      rellenados += r.rellenados;
      omitidos += r.omitidos;
      escalados += r.escalados;
      yaEscalados += r.yaEscalados;
      correosEncolados += r.correosEncolados;
    } catch (err) {
      if (err instanceof CronSatNoDisponibleError) return { estado: "no_disponible", clientes: clientes.length, creados, rellenados, omitidos, escalados, yaEscalados, correosEncolados, fallidos };
      fallidos.push({ propertyId: cliente.propertyId, error: mensajeDeError(err) });
    }
  }
  return { estado: "ok", clientes: clientes.length, creados, rellenados, omitidos, escalados, yaEscalados, correosEncolados, fallidos };
}
