// Rn-P3-07 -- aviso in-app "Hay reservas sin movimiento financiero". Barrido diario que corre dentro del cron de
// `/internal/rentas/checkin-recordatorio` (cuando exista el cron de liquidacion mensual, rn31-32, el aviso se muda ahi). Ningun GET emite.
//
// Cuenta, por organizacion, las reservas CONFIRMADAS cuyo check-in ya ocurrio (estrictamente antes de hoy) en el mes en curso y en el
// anterior y que no tienen `reserva_financiero`. Emite un aviso por organizacion y periodo (clave = organizacion + periodo) con solo
// conteos y el periodo: sin PII. Kill switch: RENTAS_AVISO_SIN_MOVIMIENTO_OFF=1 apaga el barrido sin desplegar.
// El conteo corre en su propia sesion de sistema y cada emision en la suya; todo es best-effort: nunca cambia la respuesta ni el latido
// del cron. La consulta usa rentas.system_reservas_sin_movimiento (migracion 035); sin ella el barrido simplemente no emite.
import { emitirNotificacion } from "@atiende/db";
import type { AppDeps } from "../../../deps.ts";

export interface ResumenAvisoSinMovimiento {
  readonly apagado: boolean;
  readonly organizaciones: number;
  readonly emitidos: number;
}

function periodoDe(fechaIso: string): string {
  return fechaIso.slice(0, 7);
}

function primerDiaMesAnterior(hoy: string): string {
  const anio = Number(hoy.slice(0, 4));
  const mes = Number(hoy.slice(5, 7));
  return mes === 1 ? `${anio - 1}-12-01` : `${anio}-${String(mes - 1).padStart(2, "0")}-01`;
}

function primerDiaMesSiguiente(primerDia: string): string {
  const anio = Number(primerDia.slice(0, 4));
  const mes = Number(primerDia.slice(5, 7));
  return mes === 12 ? `${anio + 1}-01-01` : `${anio}-${String(mes + 1).padStart(2, "0")}-01`;
}

export async function emitirAvisoReservasSinMovimiento(deps: AppDeps, ahora: Date = new Date()): Promise<ResumenAvisoSinMovimiento> {
  if (process.env.RENTAS_AVISO_SIN_MOVIMIENTO_OFF === "1") return { apagado: true, organizaciones: 0, emitidos: 0 };
  const hoy = ahora.toISOString().slice(0, 10);
  const inicioMesActual = `${hoy.slice(0, 7)}-01`;
  const periodos = [primerDiaMesAnterior(hoy), inicioMesActual];
  let organizaciones = 0;
  let emitidos = 0;
  for (const desde of periodos) {
    const hasta = primerDiaMesSiguiente(desde) < hoy ? primerDiaMesSiguiente(desde) : hoy;
    if (hasta <= desde) continue;
    let filas: readonly { organizationId: string; cantidad: number }[] = [];
    try {
      filas = await deps.engine.withAppSession({ userId: null }, (db) => deps.rentasRepo(db).listOrganizacionesConReservasSinMovimiento(desde, hasta));
    } catch {
      continue; // base sin migrar u otro fallo: el barrido no emite, el cron no se entera
    }
    for (const f of filas) {
      organizaciones += 1;
      try {
        const r = await deps.engine.withAppSession({ userId: null }, (db) =>
          emitirNotificacion(db, { evento: "rentas.finanzas.reservas_sin_movimiento", organizationId: f.organizationId, clave: `${f.organizationId}:${periodoDe(desde)}`, parametros: { periodo: periodoDe(desde), cantidad: f.cantidad } }),
        );
        if (r.estado === "emitida") emitidos += 1;
      } catch {
        // best-effort
      }
    }
  }
  return { apagado: false, organizaciones, emitidos };
}
