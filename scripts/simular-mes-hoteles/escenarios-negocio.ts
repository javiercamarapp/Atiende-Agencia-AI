// Escenarios de negocio del hotel que no son recepcion ni agente: facturacion CFDI (PAC falso), grupos (cotizacion, bloqueo, rooming, anticipo,
// liberacion por corte, vencimiento) y motor de revenue (reglas, eventos, competencia, cron de recomendaciones y decision humana).
import type { Contexto } from "./escenarios.ts";
import { P, cron } from "./escenarios.ts";
import { sumarDias } from "./reloj.ts";
import { TIPOS } from "./mundo.ts";

/** El huesped que lo pidio recibe su CFDI: contabilidad lo timbra por la API real (PAC doble), reintenta con la misma llave y algunos se cancelan. */
export async function facturacionDelDia(ctx: Contexto): Promise<void> {
  const { sim, rng } = ctx;
  const cerradasHoy = [...ctx.reservas.values()].filter((r) => r.cerradaDia === ctx.dia && r.folioId && !r.cfdiId);
  for (const r of cerradasHoy) {
    if (rng() > 0.45) continue;
    const llave = `sim-cfdi-${r.id}`;
    const cuerpo = { rfcReceptor: "EKU9003173C9", usoCfdi: "G03", metodoPago: "PUE" };
    const e = await sim.api("accountant", "POST", `${P(ctx)}/folios/${r.folioId}/cfdi`, cuerpo, { idem: llave, tipo: "cfdi.timbrado", detalle: { rfcReceptor: "EKU9003173C9" }, esperado: [200, 201] });
    const id = e.json?.id as string | undefined;
    if (!id) continue;
    r.cfdiId = id;
    if (rng() < 0.12) {
      // reintento del cliente con OTRA llave: debe devolver el MISMO comprobante, sin segundo timbre
      const otra = await sim.api("accountant", "POST", `${P(ctx)}/folios/${r.folioId}/cfdi`, cuerpo, { idem: `${llave}-reintento`, tipo: "cfdi.reintento_idempotente", esperado: [200, 201] });
      if (otra.json?.uuidFiscal !== e.json?.uuidFiscal) sim.evento("cfdi.reintento_distinto_uuid", "sistema", false, otra.status, { folio: r.folioId!.slice(0, 8) });
    }
    if (rng() < 0.08) {
      await sim.api("accountant", "POST", `${P(ctx)}/cfdi/${id}/cancelar`, { motivo: "02" }, { idem: `${llave}-cancelar`, tipo: "cfdi.cancelacion", esperado: [200, 201] });
    }
    ctx.reloj.avanzarMinutos(3);
  }
}

const REGLAS_PRECIO: Record<string, { floor: number; ceiling: number }> = {
  estandar: { floor: 900, ceiling: 2400 },
  superior: { floor: 1400, ceiling: 3200 },
  suite_junior: { floor: 2200, ceiling: 4800 },
  suite_master: { floor: 3600, ceiling: 7500 },
};

/** Dia 1: gate en shadow, reglas de precio por tipo, un evento local y tarifas de la competencia (insumos reales del motor). */
export async function configurarRevenue(ctx: Contexto): Promise<void> {
  const { sim } = ctx;
  await sim.api("owner", "POST", `${P(ctx)}/revenue/gate`, {}, { tipo: "revenue.gate_init", esperado: [200, 201] });
  for (const t of TIPOS) {
    const r = REGLAS_PRECIO[t.clave]!;
    await sim.api("gm", "PUT", `${P(ctx)}/revenue/pricing-rule/${ctx.mundo.tipos[t.clave].id}`, { floorPrice: r.floor, ceilingPrice: r.ceiling, dayOfWeekMultiplier: [1, 1, 1, 1, 1, 1.08, 1.12] }, { tipo: "revenue.regla_precio", detalle: { tipo: t.clave } });
  }
  await sim.api("gm", "POST", `${P(ctx)}/revenue/local-events`, { nombre: "Festival de jazz", fechaInicio: sumarDias(ctx.fecha, 9), fechaFin: sumarDias(ctx.fecha, 11), impacto: "alza_demanda", magnitudPct: 20 }, { tipo: "revenue.evento_local" });
}

export async function revenueDelDia(ctx: Contexto): Promise<void> {
  const { sim, rng } = ctx;
  for (let i = 0; i < 2; i++) {
    await sim.api("gm", "POST", `${P(ctx)}/revenue/competitor-rates`, { competidor: i === 0 ? "Hotel Vecino Uno" : "Hotel Vecino Dos", fecha: sumarDias(ctx.fecha, 5 + Math.floor(rng() * 10)), tarifa: 1500 + Math.floor(rng() * 900) }, { tipo: "revenue.tarifa_competencia", esperado: [200, 201] });
  }
  const c = await cron(ctx, "/internal/hoteles/revenue-recommendations", "POST", "cron.revenue_recomendaciones");
  if (process.env.SIM_DEBUG) console.log("revenue:", c.status, JSON.stringify(c.json).slice(0, 400));
  const corrida = c.json?.corridas?.[0];
  if (corrida?.omitida === "sin_gate_inicializado") {
    const { rows } = await sim.db.query<{ n: string }>(`select count(*)::text as n from hoteles.revenue_engine_gate where property_id = $1`, [ctx.mundo.propertyId]);
    if (Number(rows[0]!.n) > 0) {
      sim.hallazgo(
        {
          id: "H-REV-1",
          severidad: "alta",
          titulo: "El cron de recomendaciones de revenue no ve el gate de ninguna property (siempre 'sin_gate_inicializado')",
          evidencia: `La property tiene su fila en hoteles.revenue_engine_gate (creada por POST /revenue/gate), pero /internal/hoteles/revenue-recommendations la reporta omitida con skippedReason sin_gate_inicializado todos los dias: la sesion de sistema (auth.uid() es null) no pasa la unica policy de SELECT del gate (core.has_property_access, migrations/011_revenue_engine_gate.sql:330), a diferencia de rate_recommendation que si admite auth.uid() is null (029:446). Resultado: el motor de recomendaciones nunca propone nada en produccion.`,
          caminoAlterno: "ninguno: el simulador no puede generar recomendaciones; la decision humana (aprobar/descartar) queda sin ejercitar",
        },
        ctx.dia,
      );
    }
  }
  const lista = await sim.api("gm", "GET", `${P(ctx)}/revenue/recomendaciones?estado=pendiente`, undefined, { silencioso: true, esperado: [200, 503] });
  const recs = ((lista.json?.recomendaciones ?? lista.json ?? []) as { id: string }[]).slice(0, 3);
  for (const rec of recs) {
    const aprobar = rng() < 0.5;
    await sim.api("gm", "POST", `${P(ctx)}/revenue/recomendaciones/${rec.id}/${aprobar ? "aprobar" : "descartar"}`, {}, { tipo: aprobar ? "revenue.recomendacion_aprobada" : "revenue.recomendacion_descartada", esperado: [200, 409] });
  }
}

/** Grupos: dia 2 cotizacion aceptada con bloqueo, anticipo y rooming; dia 3 cotizacion que vence sin respuesta; dia 4 cotizacion rechazada. El cron de liberacion corre todos los dias. */
export async function gruposDelDia(ctx: Contexto): Promise<void> {
  const { sim } = ctx;
  const vigenteHasta = (h: number) => new Date(ctx.reloj.ahoraMs() + h * 3_600_000).toISOString();
  const crear = async (nombre: string, llegadaOffset: number, noches: number, corteOffset: number, horasVigencia: number) => {
    const llegada = sumarDias(ctx.fecha, llegadaOffset);
    return sim.api(
      "reservations",
      "POST",
      `${P(ctx)}/grupos/cotizaciones`,
      {
        nombreGrupo: nombre,
        contacto: "Coordinador del grupo",
        correoContacto: `${nombre.toLowerCase().replace(/\W+/g, ".")}@example.test`,
        llegada,
        salida: sumarDias(llegada, noches),
        fechaLiberacion: sumarDias(ctx.fecha, corteOffset),
        vigenteHasta: vigenteHasta(horasVigencia),
        anticipoRequeridoCentavos: 500_000,
        renglones: [
          { tipoHabitacionId: ctx.mundo.tipos.estandar.id, cuartos: 4, tarifaCentavos: 105_000 },
          { tipoHabitacionId: ctx.mundo.tipos.suite_junior.id, cuartos: 2, tarifaCentavos: 250_000 },
        ],
      },
      { tipo: "grupo.cotizacion", detalle: { grupo: nombre, noches }, esperado: [200, 201] },
    );
  };
  if (ctx.dia === 2) {
    const q = await crear("Congreso Medico Sintetico", 10, 3, 5, 72);
    const id = q.json?.id ?? q.json?.cotizacion?.id;
    if (id) {
      await sim.api("reservations", "POST", `${P(ctx)}/grupos/cotizaciones/${id}/enviar`, {}, { tipo: "grupo.cotizacion_enviada", esperado: [200, 201] });
      const acep = await sim.api("reservations", "POST", `${P(ctx)}/grupos/cotizaciones/${id}/aceptar`, {}, { tipo: "grupo.cotizacion_aceptada", esperado: [200, 201] });
      const bloqueoId = acep.json?.id ?? acep.json?.bloqueo?.id;
      if (bloqueoId) {
        await sim.api("accountant", "POST", `${P(ctx)}/grupos/cotizaciones/${id}/anticipos`, { montoCentavos: 500_000, referencia: `SPEI-GRUPO-${ctx.dia}` }, { tipo: "grupo.anticipo", esperado: [200, 201] });
        const llegada = sumarDias(ctx.fecha, 10);
        for (const nombre of ["Dra. Ana Lopez", "Dr. Luis Garcia"]) {
          const a = await sim.api("reservations", "POST", `${P(ctx)}/grupos/bloqueos/${bloqueoId}/huespedes`, { tipoHabitacionId: ctx.mundo.tipos.estandar.id, huesped: nombre, llegada, salida: sumarDias(llegada, 3) }, { tipo: "grupo.rooming_alta", esperado: [200, 201] });
          const entryId = a.json?.id ?? a.json?.entrada?.id;
          if (entryId) await sim.api("reservations", "POST", `${P(ctx)}/grupos/huespedes/${entryId}/confirmar`, {}, { tipo: "grupo.rooming_confirmado", esperado: [200, 201, 409] });
        }
      }
    }
  } else if (ctx.dia === 3) {
    const q = await crear("Boda Vencida Sintetica", 14, 2, 8, 20);
    const id = q.json?.id ?? q.json?.cotizacion?.id;
    if (id) await sim.api("reservations", "POST", `${P(ctx)}/grupos/cotizaciones/${id}/enviar`, {}, { tipo: "grupo.cotizacion_enviada", esperado: [200, 201] });
  } else if (ctx.dia === 4) {
    const q = await crear("Torneo Rechazado Sintetico", 16, 2, 9, 48);
    const id = q.json?.id ?? q.json?.cotizacion?.id;
    if (id) {
      await sim.api("reservations", "POST", `${P(ctx)}/grupos/cotizaciones/${id}/enviar`, {}, { tipo: "grupo.cotizacion_enviada", esperado: [200, 201] });
      await sim.api("reservations", "POST", `${P(ctx)}/grupos/cotizaciones/${id}/cerrar`, { resultado: "rechazada", motivo: "el cliente eligio otra sede" }, { tipo: "grupo.cotizacion_rechazada", esperado: [200, 201] });
    }
  }
}

export async function gruposLiberacionCron(ctx: Contexto): Promise<void> {
  const c = await cron(ctx, "/internal/hoteles/grupos-liberacion", "POST", "cron.grupos_liberacion");
  if (process.env.SIM_DEBUG) console.log("grupos-liberacion:", c.status, JSON.stringify(c.json).slice(0, 300));
}

/** Sondeo (dia 3): con la app de produccion SIN credenciales, un cobro con tarjeta y un timbrado deben responder 503 honesto ("no disponible aun"), nunca 500. */
export async function sondeoSinCredenciales(ctx: Contexto): Promise<void> {
  const { sim } = ctx;
  const r = [...ctx.reservas.values()].find((x) => x.estado === "en_estancia" && x.folioId);
  if (!r) return;
  const f = await sim.api("frontdesk", "GET", `${P(ctx)}/folios/${r.folioId}`, undefined, { silencioso: true });
  const saldo = Number(f.json?.saldo ?? 0);
  if (saldo > 0) {
    const pago = await sim.api("frontdesk", "POST", `${P(ctx)}/folios/${r.folioId}/pagos`, { monto: Math.min(saldo, 100), metodo: "tarjeta", tokenPago: "tok_sondeo_sin_credenciales" }, { sondeo: ctx.appSinCredenciales, idem: sim.nuevaClaveIdem("sondeo-pago"), silencioso: true, esperado: [503] });
    sim.evento("sondeo.pago_tarjeta_sin_credenciales", "sistema", pago.status === 503, pago.status, { esperado: 503 });
    if (pago.status >= 500 && pago.status !== 503) {
      sim.hallazgo(
        {
          id: "H-PAG-1",
          severidad: "media",
          titulo: "Cobro con tarjeta sin STRIPE_SECRET_KEY responde 500 en vez de un 503 'no disponible aun'",
          evidencia: `POST /hoteles/:propertyId/folios/:folioId/pagos con metodo tarjeta contra buildProductionDeps() sin credenciales respondio ${pago.status} (${pago.texto.slice(0, 120)}); lo esperable por la regla de compatibilidad es 503 honesto, como hace CFDI con PortUnavailableError.`,
          caminoAlterno: "el simulador usa InMemoryPaymentsPort en el borde de pagos; el sondeo no altera datos (la peticion falla antes de escribir)",
        },
        ctx.dia,
      );
    }
  }
}

const RESENAS_BUENAS = ["Excelente atencion y el cuarto muy limpio, volveremos", "Todo perfecto, el personal fue muy amable y el desayuno delicioso"];
const RESENAS_MALAS = ["El aire acondicionado no funciono y el servicio fue lento, muy decepcionante", "Cuarto sucio, mal olor y el personal grosero. No volveremos"];

/** Resena: el dia despues de su salida, ~30% de los huespedes responde la encuesta propia; las negativas se vuelven ticket y se atienden. */
export async function resenasDelDia(ctx: Contexto): Promise<void> {
  const { sim, rng } = ctx;
  const ayer = [...ctx.reservas.values()].filter((r) => r.cerradaDia === ctx.dia - 1 && r.folioId);
  for (const r of ayer) {
    if (rng() > 0.3) continue;
    const mala = rng() < 0.3;
    const texto = (mala ? RESENAS_MALAS : RESENAS_BUENAS)[Math.floor(rng() * 2)]!;
    await sim.api("gm", "POST", `${P(ctx)}/reputacion/resenas`, { texto, calificacion: mala ? 1 + Math.floor(rng() * 2) : 4 + Math.floor(rng() * 2), source: "encuesta_propia", stayState: "post_estancia", guestId: r.guestId, folioId: r.folioId, isPublic: false }, { tipo: mala ? "resena.negativa" : "resena.positiva", detalle: { calificacion: mala ? "baja" : "alta" }, esperado: [201] });
  }
  const pend = await sim.api("gm", "GET", `${P(ctx)}/tickets/resenas-pendientes`, undefined, { silencioso: true, esperado: [200, 503] });
  for (const rv of ((pend.json?.resenas ?? []) as { id: string }[]).slice(0, 3)) {
    const t = await sim.api("gm", "POST", `${P(ctx)}/tickets/desde-resena`, { resenaId: rv.id }, { tipo: "ticket.desde_resena", esperado: [201, 400] });
    const id = t.json?.id as string | undefined;
    if (id) {
      await sim.api("gm", "POST", `${P(ctx)}/tickets/${id}/cerrar`, { nota: "se contacto al huesped y se le ofrecio compensacion" }, { tipo: "ticket.cerrar_resena", esperado: [200, 409] });
    }
  }
}
