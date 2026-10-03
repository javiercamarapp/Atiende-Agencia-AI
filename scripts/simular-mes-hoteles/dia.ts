// Un dia completo del hotel sintetico: orquesta los escenarios de recepcion/ventas (escenarios.ts) y del agente (escenarios-agente.ts)
// en el orden en que ocurren (night audit de madrugada, limpieza, ventas, salidas, llegadas, cargos, mensajes, tickets, despacho).
import { P, cron, cancelaciones, cargosDeEstancia, limpiezaDelDia, llegadas, ponerHora, reservaDirecta, salidas, type Contexto } from "./escenarios.ts";
import { sumarDias } from "./reloj.ts";
import { configurarRevenue, facturacionDelDia, gruposDelDia, gruposLiberacionCron, resenasDelDia, revenueDelDia, sondeoSinCredenciales } from "./escenarios-negocio.ts";
import { arcoDelDia, capturaDeIdentidad, purgaDeIdentidad } from "./escenarios-privacidad.ts";
import { atenderLoDelAgente, ticketsDeHuesped, turnosDeAgente } from "./escenarios-agente.ts";

/** Night audit de la noche anterior: primero el cron real (sesion de sistema); si falla, el camino manual de gerencia, y el fallo queda como hallazgo. */
async function nightAudit(ctx: Contexto): Promise<void> {
  const { sim } = ctx;
  const noche = sumarDias(ctx.fecha, -1);
  const na = await cron(ctx, "/internal/hoteles/night-audit", "POST", "cron.night_audit");
  const corrida = na.json?.corridas?.[0];
  if (corrida?.corrio) {
    ctx.cerradas.add(noche);
    return;
  }
  if (corrida?.error) {
    sim.hallazgo(
      {
        id: "H-NA-1",
        severidad: "alta",
        titulo: "El cron de night audit (sesion de sistema) nunca puede abrir su corrida: INSERT ... RETURNING sobre hoteles.night_audit_run viola RLS",
        evidencia: `POST /internal/hoteles/night-audit responde 200 con ok=false y error "${String(corrida.error).slice(0, 110)}" para la noche ${noche}. Reproducido en psql contra las migraciones reales: como rol authenticated con auth.uid() nulo, el INSERT de claimNightAuditRun pasa SIN RETURNING y falla CON RETURNING, porque la policy de SELECT de night_audit_run (008_night_audit.sql:58, hoteles.can_access_money) no tiene el escape de sistema que si tiene la de INSERT/UPDATE (008:70-72). Efecto: el cron no postea hospedaje ni procesa no-shows; solo funciona el disparo manual de gerencia.`,
        caminoAlterno: "POST /hoteles/:propertyId/night-audit como gerente (sesion de staff) para la misma noche",
      },
      ctx.dia,
    );
  }
  const manual = await sim.api("gm", "POST", `${P(ctx)}/night-audit`, { businessDate: noche }, { tipo: "night_audit.manual_gerencia", detalle: { noche } });
  if (manual.status === 200) sim.evento("night_audit.resultado", "sistema", true, 200, { noche, cargosPosteados: Number(manual.json?.cargosPosteados?.length ?? manual.json?.cargosPosteados ?? 0), noShows: Number(manual.json?.noShows?.length ?? 0) });
  if (manual.status === 200) ctx.cerradas.add(noche);
}

export async function simularDia(ctx: Contexto): Promise<void> {
  const { sim, reloj } = ctx;
  sim.olvidarTokens();
  ponerHora(ctx, "03:30");
  await nightAudit(ctx);
  ponerHora(ctx, "07:00");
  await limpiezaDelDia(ctx, "manana");
  ponerHora(ctx, "09:30");
  await gruposLiberacionCron(ctx);
  if (ctx.dia === 1) await configurarRevenue(ctx);
  await gruposDelDia(ctx);
  const nuevas = 9 + Math.floor(ctx.rng() * 6);
  for (let i = 0; i < nuevas; i++) {
    const offset = Math.floor(Math.pow(ctx.rng(), 1.6) * 10);
    await reservaDirecta(ctx, offset, 1 + Math.floor(ctx.rng() * 4));
    reloj.avanzarMinutos(7);
  }
  ponerHora(ctx, "11:00");
  await salidas(ctx);
  ponerHora(ctx, "12:00");
  await facturacionDelDia(ctx);
  ponerHora(ctx, "13:00");
  await limpiezaDelDia(ctx, "tarde");
  ponerHora(ctx, "14:00");
  await cancelaciones(ctx);
  ponerHora(ctx, "15:00");
  await llegadas(ctx);
  await capturaDeIdentidad(ctx);
  await revenueDelDia(ctx);
  ponerHora(ctx, "19:00");
  await cargosDeEstancia(ctx);
  ponerHora(ctx, "20:00");
  await turnosDeAgente(ctx);
  ponerHora(ctx, "21:00");
  await atenderLoDelAgente(ctx);
  ponerHora(ctx, "21:15");
  await resenasDelDia(ctx);
  ponerHora(ctx, "21:30");
  await ticketsDeHuesped(ctx);
  if (ctx.dia === 3) await sondeoSinCredenciales(ctx);
  await arcoDelDia(ctx);
  await purgaDeIdentidad(ctx);
  ponerHora(ctx, "22:00");
  await cron(ctx, "/internal/whatsapp/dispatch", "POST", "cron.whatsapp_dispatch");
  ponerHora(ctx, "23:00");
}
