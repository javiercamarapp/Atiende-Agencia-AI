// "HORARIO PARA TOMAR PEDIDOS" del prompt de PM generado del horario REAL de cada sucursal activa (`branch_policy.horario` mas los
// puentes vigentes), no de una constante en codigo (CR10). El dueño dijo "de 12 pm a 1 am, sí es doble turno" para todas; lo que
// guarda la base es lo que dice el agente. El valor por omision del codigo (`PM_HORARIO_PRUDENTE`) solo cubre a la sucursal que no
// tiene horario cargado.
//
// Las lecturas van por `repo.findBranchPolicy` / `repo.listBranchHoursExceptions`, que degradan con SAVEPOINT contra la base sin
// migrar (ver PostgresRestaurantesRepository): este modulo no captura SQLSTATE por su cuenta porque corre dentro de la
// transaccion unica del turno.
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { describirExcepcionHorario, describirHorarioSemanal, fechaLocal, type HorarioSucursal } from "../horarios.ts";
import type { RestaurantesRepository } from "../repository.ts";
import type { BranchHoursException, BranchSummary } from "../types.ts";
import { PM_HORARIO_PRUDENTE } from "./perfil-pm.ts";

/** Dias hacia adelante en que se listan los puentes en el prompt (el cliente no pide pedidos mas alla). */
export const DIAS_PUENTES_EN_PROMPT = 14;

/** Valor por omision (texto del codigo) de una sucursal sin horario cargado, por slug. Solo las que el codigo conoce. */
const OMISION_POR_SLUG: Readonly<Record<string, string>> = {
  "fco-montejo": PM_HORARIO_PRUDENTE[0],
  "prol-montejo": PM_HORARIO_PRUDENTE[1],
  pensiones: PM_HORARIO_PRUDENTE[2],
};

export interface SucursalHorarioPrompt {
  readonly nombre: string;
  readonly slug: string;
  readonly horario: HorarioSucursal | null;
  readonly puentes: readonly { readonly fechaDesde: string; readonly fechaHasta: string; readonly horario: HorarioSucursal }[];
}

function sumarDias(fecha: string, dias: number): string {
  return new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);
}

/** Texto del horario para el prompt. `null` = ninguna sucursal tiene horario cargado: el prompt usa su valor por omision. */
export function componerHorarioPedidosTexto(sucursales: readonly SucursalHorarioPrompt[]): string | null {
  if (!sucursales.some((s) => s.horario && s.horario.length > 0)) return null;
  const partes = sucursales.map((s) => {
    const base = s.horario && s.horario.length > 0 ? describirHorarioSemanal(s.horario) : null;
    let linea: string;
    if (base) linea = `${s.nombre}: ${base}`;
    else linea = OMISION_POR_SLUG[s.slug] ?? `${s.nombre}: sin horario cargado, consulte consultar_sucursal`;
    const puentes = s.puentes.map((p) => describirExcepcionHorario(p));
    return puentes.length > 0 ? `${linea} (excepciones por fecha, mandan sobre el horario normal: ${puentes.join(" | ")})` : linea;
  });
  // Galerias (sin pedidos) y Playa (temporada) conservan su texto propio mientras no esten entre las sucursales activas.
  if (!sucursales.some((s) => s.slug === "galerias")) partes.push(PM_HORARIO_PRUDENTE[4]);
  if (!sucursales.some((s) => s.slug === "playa")) partes.push(PM_HORARIO_PRUDENTE[5]);
  return partes.join("; ");
}

/** Lee el horario y los puentes proximos de cada sucursal activa y compone el texto (o `null`). */
export async function textoHorarioPedidosPm(repo: RestaurantesRepository, branches: readonly BranchSummary[], now: Date): Promise<string | null> {
  const sucursales: SucursalHorarioPrompt[] = [];
  for (const b of branches) {
    const policy = await repo.findBranchPolicy(b.propertyId);
    const zona = resolverZonaHorariaNegocio((await repo.findBranchZonaHoraria(b.propertyId)).zonaHoraria);
    const hoy = fechaLocal(now, zona);
    const excepciones: readonly BranchHoursException[] = await repo.listBranchHoursExceptions(b.propertyId, hoy, sumarDias(hoy, DIAS_PUENTES_EN_PROMPT));
    sucursales.push({ nombre: b.name, slug: b.slug, horario: policy.horario, puentes: excepciones });
  }
  return componerHorarioPedidosTexto(sucursales);
}
