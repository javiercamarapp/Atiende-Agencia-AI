// Escenarios del agente de WhatsApp y de lo que el personal hace con lo que el agente deja: pedidos de F&B, tickets de mantenimiento,
// contactos no operativos, pre-reservas (holds) con aprobacion humana y su confirmacion, y los tickets de huesped con su SLA.
// El webhook es el REAL (firma HMAC incluida); el LLM es el doble guionado de llm-guionado.ts; el despacho saliente va a un Graph falso.
import { createHmac } from "node:crypto";
import { sumarDias } from "./reloj.ts";
import type { Contexto, Reserva } from "./escenarios.ts";
import { P, cron } from "./escenarios.ts";

let consecutivoMensaje = 0;

/** Habilita el agente de reservas (holds) para la property: la politica la fija el gerente por la API, igual que en produccion. */
export async function configurarAgente(ctx: Contexto): Promise<void> {
  await ctx.sim.api(
    "gm",
    "PUT",
    `${P(ctx)}/reservas-agente/politica`,
    { habilitado: true, modo: "aprobacion_humana", vigenciaMinutos: 240, nochesMaximas: 14, huespedesMaximos: 4, diasMaximosDeAnticipacion: 120, holdsAbiertosMaximos: 40 },
    { tipo: "agente.politica_holds", detalle: { modo: "aprobacion_humana" } },
  );
}

/** Un mensaje de WhatsApp entrante por el webhook real. `from` solo digitos con lada de pais. */
export async function mensajeWhatsApp(ctx: Contexto, from: string, texto: string, etiqueta: string): Promise<number> {
  consecutivoMensaje += 1;
  const cuerpo = {
    object: "whatsapp_business_account",
    entry: [{ id: "sim", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: ctx.phoneNumberId }, messages: [{ from, id: `wamid.sim.${ctx.dia}.${consecutivoMensaje}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }] } }] }],
  };
  const raw = JSON.stringify(cuerpo);
  const firma = `sha256=${createHmac("sha256", ctx.secretoWhatsApp).update(raw).digest("hex")}`;
  const r = await ctx.sim.api(null, "POST", "/v1/hoteles/whatsapp/webhook", cuerpo, { headers: { "x-hub-signature-256": firma }, actor: "agente", tipo: `agente.whatsapp.${etiqueta}`, detalle: { chars: texto.length } });
  return r.status;
}

const PEDIDOS = ["Quiero una pizza y un refresco a la habitacion", "Me traen una hamburguesa y una cerveza, por favor", "Desayuno continental para dos a la habitacion", "Tengo alergia a los cacahuates, quiero una cena ligera por room service"];
const FALLAS = ["El aire acondicionado no enfria", "Hay una fuga de agua en el bano", "La television no funciona", "La cerradura de la puerta esta descompuesta"];
const OTROS = ["Buenas tardes, hasta que hora puedo usar la alberca?", "Quisiera saber si tienen servicio de lavanderia"];

/** Mensajes del dia de huespedes en casa y de prospectos que quieren reservar. */
export async function turnosDeAgente(ctx: Contexto): Promise<void> {
  const { rng } = ctx;
  const enCasa = [...ctx.reservas.values()].filter((r) => r.estado === "en_estancia");
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
  let n = 0;
  for (const r of enCasa) {
    const x = rng();
    if (x > 0.35) continue;
    const hab = ctx.mundo.tipos[r.tipo].habitaciones.find((h) => h.id === r.roomId)?.codigo ?? "000";
    const from = `52${r.telefono}`;
    if (x < 0.15) await mensajeWhatsApp(ctx, from, `${pick(PEDIDOS)}. Habitacion ${hab}.`, "fnb");
    else if (x < 0.25) await mensajeWhatsApp(ctx, from, `${pick(FALLAS)}. Habitacion ${hab}.`, "mantenimiento");
    else await mensajeWhatsApp(ctx, from, pick(OTROS), "consulta");
    ctx.reloj.avanzarMinutos(3);
    n += 1;
  }
  // prospectos: 1 a 3 por dia piden cotizacion y apartar por WhatsApp (pre-reserva con aprobacion humana)
  const prospectos = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < prospectos; i++) {
    const llegada = sumarDias(ctx.fecha, 6 + Math.floor(rng() * 20));
    const salida = sumarDias(llegada, 1 + Math.floor(rng() * 3));
    const from = `52998777${String(Math.floor(rng() * 10000)).padStart(4, "0")}`;
    await mensajeWhatsApp(ctx, from, `Hola, quiero reservar del ${llegada} al ${salida}, ¿me puede apartar una habitacion?`, "prospecto_reserva");
    ctx.reloj.avanzarMinutos(5);
  }
  ctx.sim.evento("agente.turnos_del_dia", "agente", true, 200, { huespedesEnCasaAtendidos: n, prospectos });
}

/** El personal atiende lo que dejo el agente: confirma cocina, cierra mantenimiento, decide y confirma las pre-reservas. */
export async function atenderLoDelAgente(ctx: Contexto): Promise<void> {
  const { sim, rng } = ctx;
  // F&B
  const pedidos = await sim.api("fnb", "GET", `${P(ctx)}/pedidos-fnb`, undefined, { silencioso: true });
  for (const o of (pedidos.json ?? []) as { id: string; alergiaDeclarada: boolean; cocineroConfirmoPor: string | null }[]) {
    if (o.alergiaDeclarada && !o.cocineroConfirmoPor) {
      await sim.api("fnb", "POST", `${P(ctx)}/pedidos-fnb/${o.id}/confirmar-cocina`, { nota: "revisado por cocina" }, { tipo: "fnb.confirmar_cocina", esperado: [200, 403, 409] });
    }
  }
  // mantenimiento
  const abiertos = await sim.api("maintenance", "GET", `${P(ctx)}/mantenimiento/tickets?estado=abierto`, undefined, { silencioso: true, esperado: [200, 403] });
  for (const t of (abiertos.json ?? []) as { id: string }[]) {
    if (rng() > 0.8) continue;
    await sim.api("maintenance", "POST", `${P(ctx)}/mantenimiento/tickets/${t.id}/cerrar`, { actualCost: Math.round(rng() * 40000) / 100, notaResolucion: "reparado" }, { tipo: "mantenimiento.cierre", esperado: [200, 403, 404] });
  }
  // pre-reservas del agente
  const holds = await sim.api("reservations", "GET", `${P(ctx)}/reservas-agente/holds?abiertas=1`, undefined, { silencioso: true, esperado: [200, 403, 503] });
  const lista = (holds.json?.holds ?? []) as { id: string; estado: string; llegada: string; salida: string; tipoHabitacionId: string; noches: number; nombreHuesped: string | null }[];
  for (const h of lista) {
    if (h.estado === "pendiente_aprobacion") {
      const aprobar = rng() < 0.65;
      const d = await sim.api("reservations", "POST", `${P(ctx)}/reservas-agente/holds/${h.id}/decidir`, { decision: aprobar ? "aprobar" : "rechazar", motivo: aprobar ? "disponible y cliente verificado" : "sin cupo para esas fechas" }, { tipo: aprobar ? "hold.aprobado" : "hold.rechazado", esperado: [200, 409] });
      if (aprobar && d.status === 200 && rng() < 0.7) {
        await sim.api("reservations", "POST", `${P(ctx)}/reservas-agente/holds/${h.id}/confirmar`, {}, { tipo: "hold.confirmado", esperado: [200, 409], detalle: { llegada: h.llegada } });
      }
    }
  }
}

/** Tickets de huesped (quejas) por la API de staff, con su ciclo y el barrido de SLA. */
export async function ticketsDeHuesped(ctx: Contexto): Promise<void> {
  const { sim, rng } = ctx;
  const mensajes = ["El minibar esta vacio y la toalla sucia", "Ruido excesivo en el pasillo, necesito otra habitacion", "La caja fuerte no abre", "Quiero que limpien de nuevo el bano"];
  const nuevos = rng() < 0.7 ? 1 + Math.floor(rng() * 2) : 0;
  for (let i = 0; i < nuevos; i++) {
    await sim.api("frontdesk", "POST", `${P(ctx)}/tickets`, { mensaje: mensajes[Math.floor(rng() * mensajes.length)], canal: "staff" }, { tipo: "ticket.alta", detalle: { canal: "staff" } });
  }
  const lista = await sim.api("frontdesk", "GET", `${P(ctx)}/tickets`, undefined, { silencioso: true });
  for (const t of (lista.json?.tickets ?? []) as { id: string; estado: string }[]) {
    if (t.estado === "abierto" && rng() < 0.5) {
      await sim.api("frontdesk", "POST", `${P(ctx)}/tickets/${t.id}/asignar`, { asignadoA: ctx.mundo.staff.frontdesk.id }, { tipo: "ticket.asignar", esperado: [200, 403] });
      await sim.api("frontdesk", "POST", `${P(ctx)}/tickets/${t.id}/iniciar`, {}, { tipo: "ticket.iniciar", esperado: [200, 403, 409] });
    } else if (t.estado === "en_progreso" && rng() < 0.7) {
      await sim.api("frontdesk", "POST", `${P(ctx)}/tickets/${t.id}/cerrar`, { nota: "atendido con el huesped" }, { tipo: "ticket.cerrar", esperado: [200, 403, 409] });
    }
  }
  const sweep = await cron(ctx, "/internal/hoteles/tickets-sla", "POST", "cron.tickets_sla");
  ctx.ultimoBarridoSlaMs = ctx.reloj.ahoraMs();
  if (process.env.SIM_DEBUG) console.log("tickets-sla:", sweep.status, JSON.stringify(sweep.json).slice(0, 300));
}

export type { Reserva };
