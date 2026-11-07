// Privacidad (LFPDPPP): captura de identidad en el mostrador (boveda cifrada), solicitudes ARCO con su ciclo, y purga con doble control
// (solicita gerencia, decide la duena) mas el cron de purga por vencimiento. Todo por la API real; la llave de cifrado es efimera.
import type { Contexto } from "./escenarios.ts";
import { P, cron } from "./escenarios.ts";

/** Captura de identidad al llegar (INE o pasaporte) para ~55% de los check-in de hoy. Se llama despues de `llegadas`. */
export async function capturaDeIdentidad(ctx: Contexto): Promise<void> {
  const { sim, rng } = ctx;
  const hoy = [...ctx.reservas.values()].filter((r) => r.estado === "en_estancia" && r.checkIn === ctx.fecha && !r.identidadId);
  for (const r of hoy) {
    if (rng() > 0.55) continue;
    const extranjero = rng() < 0.2;
    const res = await sim.api(
      "frontdesk",
      "POST",
      `${P(ctx)}/identidad`,
      { guestId: r.guestId, reservationId: r.id, documentType: extranjero ? "pasaporte" : "ine", fullName: `${r.apellido} Sintetico`, documentNumber: `SIM${Math.floor(rng() * 1e8)}`, ...(extranjero ? { nationality: "USA", issuingCountry: "USA" } : {}) },
      { tipo: "identidad.captura", detalle: { documento: extranjero ? "pasaporte" : "ine" }, esperado: [200, 201, 503] },
    );
    const id = res.json?.identidad?.id as string | undefined;
    if (id) r.identidadId = id;
  }
}

/** Purga con doble control: dias despues del check-out, gerencia solicita y la duena decide. Mas el cron diario de purga por vencimiento. */
export async function purgaDeIdentidad(ctx: Contexto): Promise<void> {
  const { sim, rng } = ctx;
  const candidatas = [...ctx.reservas.values()].filter((r) => r.identidadId && r.cerradaDia !== undefined && ctx.dia >= r.cerradaDia + 2 && !r.purgaSolicitada);
  for (const r of candidatas) {
    if (rng() > 0.25) continue;
    r.purgaSolicitada = true;
    const sol = await sim.api("gm", "POST", `${P(ctx)}/identidad/${r.identidadId}/solicitar-purga`, { motivo: "el huesped retiro su consentimiento" }, { tipo: "identidad.purga_solicitada", esperado: [200, 201, 409] });
    const solicitudId = sol.json?.solicitudId as string | undefined;
    if (solicitudId) await sim.api("owner", "POST", `${P(ctx)}/identidad-purgas/${solicitudId}/decidir`, { aprobar: true, nota: "aprobada por la direccion" }, { tipo: "identidad.purga_decidida", esperado: [200, 409] });
  }
  await cron(ctx, "/internal/hoteles/identidad-purga", "POST", "cron.identidad_purga");
}

/**
 * Solicitudes ARCO. LIMITE DECLARADO: `avanzar` exige que la fecha de negocio coincida con la del SERVIDOR de Postgres (ver el mensaje
 * "la fecha de negocio no coincide con la fecha del servidor"), y el reloj de la base es el real: el ciclo completo solo se puede recorrer
 * el dia 1 del mes simulado (que arranca hoy). Los demas dias solo se registra la solicitud (queda "recibida", dentro de plazo).
 */
export async function arcoDelDia(ctx: Contexto): Promise<void> {
  const { sim } = ctx;
  const completo = ctx.dia === 1;
  if (!completo && ![8, 15, 22].includes(ctx.dia)) return;
  const derechos = ["acceso", "rectificacion", "cancelacion", "oposicion"];
  for (let i = 0; i < (completo ? 2 : 1); i++) {
    const derecho = derechos[(ctx.dia + i) % derechos.length]!;
    const alta = await sim.api("owner", "POST", `${P(ctx)}/privacidad/arco`, { derecho, solicitante: `Titular Sintetico ${ctx.dia}-${i}`, contacto: `titular.${ctx.dia}.${i}@example.test`, canal: "correo", recibidaEn: ctx.hoyReal, descripcion: "Solicitud sintetica del simulador" }, { tipo: "privacidad.arco_alta", detalle: { derecho }, esperado: [201, 503] });
    const id = alta.json?.solicitudId as string | undefined;
    if (!id || !completo) continue;
    for (const [estado, nota] of [["en_revision", "revision de la solicitud por la direccion"], ["procedente", "procede conforme a la ley"], ["ejecutada", "se atendio el derecho solicitado"]] as const) {
      await sim.api("owner", "POST", `${P(ctx)}/privacidad/arco/${id}/avanzar`, { estado, nota }, { tipo: `privacidad.arco_${estado}`, esperado: [200, 409] });
      ctx.reloj.avanzarMinutos(10);
    }
  }
}
