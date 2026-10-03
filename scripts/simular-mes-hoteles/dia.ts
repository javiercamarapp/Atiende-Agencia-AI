// Un dia completo del hotel sintetico: orquesta los escenarios de recepcion/ventas (escenarios.ts) y del agente (escenarios-agente.ts)
// en el orden en que ocurren (night audit de madrugada, limpieza, ventas, salidas, llegadas, cargos, mensajes, tickets, despacho).
import { cron, cancelaciones, cargosDeEstancia, limpiezaDelDia, llegadas, ponerHora, reservaDirecta, salidas, type Contexto } from "./escenarios.ts";
import { atenderLoDelAgente, ticketsDeHuesped, turnosDeAgente } from "./escenarios-agente.ts";

export async function simularDia(ctx: Contexto): Promise<void> {
  const { sim, reloj } = ctx;
  sim.olvidarTokens();
  ponerHora(ctx, "03:30");
  const na = await cron(ctx, "/internal/hoteles/night-audit", "POST", "cron.night_audit");
  if (process.env.SIM_DEBUG) console.log("night-audit:", na.status, JSON.stringify(na.json));
  const corrida = na.json?.corridas?.[0];
  if (corrida?.corrio && corrida.fecha) ctx.cerradas.add(corrida.fecha as string);
  ponerHora(ctx, "07:00");
  await limpiezaDelDia(ctx, "manana");
  ponerHora(ctx, "09:30");
  const nuevas = 9 + Math.floor(ctx.rng() * 6);
  for (let i = 0; i < nuevas; i++) {
    const offset = Math.floor(Math.pow(ctx.rng(), 1.6) * 10);
    await reservaDirecta(ctx, offset, 1 + Math.floor(ctx.rng() * 4));
    reloj.avanzarMinutos(7);
  }
  ponerHora(ctx, "11:00");
  await salidas(ctx);
  ponerHora(ctx, "13:00");
  await limpiezaDelDia(ctx, "tarde");
  ponerHora(ctx, "14:00");
  await cancelaciones(ctx);
  ponerHora(ctx, "15:00");
  await llegadas(ctx);
  ponerHora(ctx, "19:00");
  await cargosDeEstancia(ctx);
  ponerHora(ctx, "20:00");
  await turnosDeAgente(ctx);
  ponerHora(ctx, "21:00");
  await atenderLoDelAgente(ctx);
  ponerHora(ctx, "21:30");
  await ticketsDeHuesped(ctx);
  ponerHora(ctx, "22:00");
  await cron(ctx, "/internal/whatsapp/dispatch", "POST", "cron.whatsapp_dispatch");
  ponerHora(ctx, "23:00");
}
