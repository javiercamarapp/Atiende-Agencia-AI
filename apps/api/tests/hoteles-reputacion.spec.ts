// Fase 11/13 hoteles (REQ-CRM-002/003) — integración HTTP real del wiring de
// reputación/CRM: captura + clasificación real (sin LLM), listado/detalle,
// responder una reseña, resolver una acción reglada (creando el ticket de
// mantenimiento REAL para ticket_mantenimiento), y el índice agregado (métricas).
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildHotelesTestContext } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";

let ctx: HotelesTestContext;

beforeEach(async () => {
  ctx = await buildHotelesTestContext(buildApp);
});

interface ReviewSummary {
  id: string;
  sentiment: string;
  topics: { topic: string; esConocido: boolean }[];
  calificacion: number | null;
}

interface ActionSummary {
  id: string;
  actionType: string;
  status: string;
  ticketId: string | null;
  reviewId: string;
}

interface CreateReviewResponse {
  resena: ReviewSummary;
  acciones: ActionSummary[];
}

const MUY_NEGATIVA_AC_LIMPIEZA =
  "El aire acondicionado estaba descompuesto y el cuarto muy sucio, fue una experiencia terrible y horrible, pesimo servicio.";

const OTRA_PROPERTY_ID = "00000000-0000-0000-0000-000000000000";

describe("POST /hoteles/:propertyId/reputacion/resenas — captura + clasificación real", () => {
  it("rechaza a un rol fuera de REPUTACION_SUBMIT_ROLES (housekeeping)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/reputacion/resenas`,
      authedJson(ctx.staff.housekeeping.token, { texto: "Todo bien", source: "encuesta_propia" }),
    );
    expect(res.status).toBe(403);
  });

  it("rechaza texto vacío y source inválido", async () => {
    const app = buildApp(ctx.deps);
    const vacio = await app.request(`/hoteles/${ctx.propertyId}/reputacion/resenas`, authedJson(ctx.staff.owner.token, { texto: "", source: "encuesta_propia" }));
    expect(vacio.status).toBe(400);
    const sourceInvalida = await app.request(`/hoteles/${ctx.propertyId}/reputacion/resenas`, authedJson(ctx.staff.owner.token, { texto: "Todo bien", source: "yelp" }));
    expect(sourceInvalida.status).toBe(400);
  });

  it("clasifica una reseña muy negativa: detecta temas conocidos, sentimiento muy_negativo, y dispara ticket_mantenimiento + mensaje_proactivo + compensacion_reglada con huésped en estancia", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/reputacion/resenas`,
      authedJson(ctx.staff.frontdesk.token, {
        texto: MUY_NEGATIVA_AC_LIMPIEZA,
        calificacion: 1,
        source: "encuesta_propia",
        stayState: "en_estancia",
        guestId: ctx.guestId,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateReviewResponse;

    expect(body.resena.sentiment).toBe("muy_negativo");
    const topics = body.resena.topics.map((t) => t.topic).sort();
    expect(topics).toContain("aire_acondicionado");
    expect(topics).toContain("limpieza");

    const tipos = body.acciones.map((a) => a.actionType).sort();
    expect(tipos).toContain("ticket_mantenimiento");
    expect(tipos).toContain("mensaje_proactivo");
    expect(tipos).toContain("compensacion_reglada");
    expect(body.acciones.every((a) => a.status === "pendiente" && a.ticketId === null)).toBe(true);
  });

  it("una reseña neutra/positiva no dispara ninguna acción", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/reputacion/resenas`,
      authedJson(ctx.staff.owner.token, { texto: "Todo estuvo excelente, muy comodo y el personal amable.", calificacion: 5, source: "encuesta_propia" }),
    );
    const body = (await res.json()) as CreateReviewResponse;
    expect(body.acciones).toEqual([]);
  });
});

describe("GET /hoteles/:propertyId/reputacion/resenas[...] — listado y detalle", () => {
  it("rechaza a un rol fuera de REPUTACION_VIEW_ROLES (maintenance no está en REPUTACION_VIEW_ROLES)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/reputacion/resenas`, authedJson(ctx.staff.housekeeping.token));
    // housekeeping no está en REPUTACION_VIEW_ROLES (owner/gm/frontdesk/reservations/accountant).
    expect(res.status).toBe(403);
  });

  it("lista reseñas y filtra por sentiment; 403 cross-property", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`/hoteles/${ctx.propertyId}/reputacion/resenas`, authedJson(ctx.staff.owner.token, { texto: "Todo excelente", calificacion: 5, source: "encuesta_propia" }));
    await app.request(`/hoteles/${ctx.propertyId}/reputacion/resenas`, authedJson(ctx.staff.owner.token, { texto: MUY_NEGATIVA_AC_LIMPIEZA, calificacion: 1, source: "encuesta_propia" }));

    const todas = await app.request(`/hoteles/${ctx.propertyId}/reputacion/resenas`, authedJson(ctx.staff.accountant.token));
    expect(((await todas.json()) as ReviewSummary[]).length).toBe(2);

    const negativas = await app.request(`/hoteles/${ctx.propertyId}/reputacion/resenas?sentiment=muy_negativo`, authedJson(ctx.staff.accountant.token));
    expect(((await negativas.json()) as ReviewSummary[]).length).toBe(1);

    const cross = await app.request(`/hoteles/${OTRA_PROPERTY_ID}/reputacion/resenas`, authedJson(ctx.staff.owner.token));
    expect(cross.status).toBe(403);
  });

  it("404 en detalle de una reseña inexistente; 200 con acciones/respuestas en una que sí existe", async () => {
    const app = buildApp(ctx.deps);
    const creada = await app.request(
      `/hoteles/${ctx.propertyId}/reputacion/resenas`,
      authedJson(ctx.staff.owner.token, { texto: MUY_NEGATIVA_AC_LIMPIEZA, calificacion: 1, source: "encuesta_propia" }),
    );
    const { resena } = (await creada.json()) as CreateReviewResponse;

    const noExiste = await app.request(`/hoteles/${ctx.propertyId}/reputacion/resenas/00000000-0000-0000-0000-000000000099`, authedJson(ctx.staff.owner.token));
    expect(noExiste.status).toBe(404);

    const detalle = await app.request(`/hoteles/${ctx.propertyId}/reputacion/resenas/${resena.id}`, authedJson(ctx.staff.owner.token));
    expect(detalle.status).toBe(200);
    const body = (await detalle.json()) as { resena: ReviewSummary; acciones: ActionSummary[]; respuestas: unknown[] };
    expect(body.resena.id).toBe(resena.id);
    expect(body.acciones.length).toBeGreaterThan(0);
    expect(body.respuestas).toEqual([]);
  });
});

describe("POST /hoteles/:propertyId/reputacion/resenas/:reviewId/respuestas — responder", () => {
  it("rechaza a un rol fuera de REPUTACION_SUBMIT_ROLES y valida texto vacío", async () => {
    const app = buildApp(ctx.deps);
    const creada = await app.request(`/hoteles/${ctx.propertyId}/reputacion/resenas`, authedJson(ctx.staff.owner.token, { texto: "Bien", source: "encuesta_propia" }));
    const { resena } = (await creada.json()) as CreateReviewResponse;

    const rolInvalido = await app.request(
      `/hoteles/${ctx.propertyId}/reputacion/resenas/${resena.id}/respuestas`,
      authedJson(ctx.staff.housekeeping.token, { texto: "Gracias por tu comentario" }),
    );
    expect(rolInvalido.status).toBe(403);

    const vacio = await app.request(`/hoteles/${ctx.propertyId}/reputacion/resenas/${resena.id}/respuestas`, authedJson(ctx.staff.owner.token, { texto: "" }));
    expect(vacio.status).toBe(400);
  });

  it("404 si la reseña no existe; owner/gm/frontdesk/reservations SÍ pueden responder y la respuesta aparece en el detalle", async () => {
    const app = buildApp(ctx.deps);
    const noExiste = await app.request(
      `/hoteles/${ctx.propertyId}/reputacion/resenas/00000000-0000-0000-0000-000000000099/respuestas`,
      authedJson(ctx.staff.owner.token, { texto: "Gracias" }),
    );
    expect(noExiste.status).toBe(404);

    const creada = await app.request(`/hoteles/${ctx.propertyId}/reputacion/resenas`, authedJson(ctx.staff.owner.token, { texto: "Bien", source: "encuesta_propia" }));
    const { resena } = (await creada.json()) as CreateReviewResponse;

    const responder = await app.request(
      `/hoteles/${ctx.propertyId}/reputacion/resenas/${resena.id}/respuestas`,
      authedJson(ctx.staff.reservations.token, { texto: "Gracias por tu comentario, esperamos verte pronto de nuevo." }),
    );
    expect(responder.status).toBe(201);

    const detalle = await app.request(`/hoteles/${ctx.propertyId}/reputacion/resenas/${resena.id}`, authedJson(ctx.staff.owner.token));
    const body = (await detalle.json()) as { respuestas: { texto: string }[] };
    expect(body.respuestas).toHaveLength(1);
    expect(body.respuestas[0]!.texto).toContain("Gracias");
  });
});

describe("POST /hoteles/:propertyId/reputacion/acciones/:actionId/resolver", () => {
  async function crearResenaConAcciones(app: ReturnType<typeof buildApp>) {
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/reputacion/resenas`,
      authedJson(ctx.staff.owner.token, { texto: MUY_NEGATIVA_AC_LIMPIEZA, calificacion: 1, source: "encuesta_propia" }),
    );
    return (await res.json()) as CreateReviewResponse;
  }

  it("rechaza a un rol fuera de REPUTACION_ACTION_RESOLVE_ROLES (frontdesk no puede resolver)", async () => {
    const app = buildApp(ctx.deps);
    const { acciones } = await crearResenaConAcciones(app);
    const ticketAccion = acciones.find((a) => a.actionType === "ticket_mantenimiento")!;
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/reputacion/acciones/${ticketAccion.id}/resolver`,
      authedJson(ctx.staff.frontdesk.token, { status: "ejecutada" }),
    );
    expect(res.status).toBe(403);
  });

  it("resolver ticket_mantenimiento como 'ejecutada' crea el ticket REAL en hoteles.maintenance_ticket (cierra el gap de la migración 013)", async () => {
    const app = buildApp(ctx.deps);
    const { acciones } = await crearResenaConAcciones(app);
    const ticketAccion = acciones.find((a) => a.actionType === "ticket_mantenimiento")!;

    const antes = await ctx.hotelesRepo.listMaintenanceTickets(ctx.propertyId);

    const res = await app.request(
      `/hoteles/${ctx.propertyId}/reputacion/acciones/${ticketAccion.id}/resolver`,
      authedJson(ctx.staff.owner.token, { status: "ejecutada" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ActionSummary;
    expect(body.status).toBe("ejecutada");
    expect(body.ticketId).not.toBeNull();

    const despues = await ctx.hotelesRepo.listMaintenanceTickets(ctx.propertyId);
    expect(despues.length).toBe(antes.length + 1);
    expect(despues.some((t) => t.id === body.ticketId)).toBe(true);
  });

  it("resolver mensaje_proactivo como 'ejecutada' NUNCA crea un ticket (fuera de alcance, solo registra la decisión)", async () => {
    const app = buildApp(ctx.deps);
    const creada = await app.request(
      `/hoteles/${ctx.propertyId}/reputacion/resenas`,
      authedJson(ctx.staff.owner.token, { texto: MUY_NEGATIVA_AC_LIMPIEZA, calificacion: 1, source: "encuesta_propia", stayState: "en_estancia", guestId: ctx.guestId }),
    );
    const { acciones } = (await creada.json()) as CreateReviewResponse;
    const mensajeAccion = acciones.find((a) => a.actionType === "mensaje_proactivo")!;

    const antes = await ctx.hotelesRepo.listMaintenanceTickets(ctx.propertyId);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/reputacion/acciones/${mensajeAccion.id}/resolver`,
      authedJson(ctx.staff.owner.token, { status: "ejecutada" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ActionSummary;
    expect(body.ticketId).toBeNull();
    const despues = await ctx.hotelesRepo.listMaintenanceTickets(ctx.propertyId);
    expect(despues.length).toBe(antes.length);
  });

  it("resolver dos veces la misma acción devuelve 409", async () => {
    const app = buildApp(ctx.deps);
    const { acciones } = await crearResenaConAcciones(app);
    const ticketAccion = acciones.find((a) => a.actionType === "ticket_mantenimiento")!;

    await app.request(`/hoteles/${ctx.propertyId}/reputacion/acciones/${ticketAccion.id}/resolver`, authedJson(ctx.staff.owner.token, { status: "descartada" }));
    const segunda = await app.request(`/hoteles/${ctx.propertyId}/reputacion/acciones/${ticketAccion.id}/resolver`, authedJson(ctx.staff.owner.token, { status: "ejecutada" }));
    expect(segunda.status).toBe(409);
  });

  it("404 si la acción no existe", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/reputacion/acciones/00000000-0000-0000-0000-000000000099/resolver`,
      authedJson(ctx.staff.owner.token, { status: "descartada" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /hoteles/:propertyId/reputacion/indice — índice agregado (métricas)", () => {
  it("con cero reseñas, totalResenas=0 y promedios/puntajeIndice null (nunca un 0 falso)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/reputacion/indice`, authedJson(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalResenas: number; puntajeIndice: number | null; promedioSentimiento: number | null };
    expect(body.totalResenas).toBe(0);
    expect(body.puntajeIndice).toBeNull();
    expect(body.promedioSentimiento).toBeNull();
  });

  it("agrega reseñas ya persistidas en un índice real (distribución de sentimiento + temas críticos)", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`/hoteles/${ctx.propertyId}/reputacion/resenas`, authedJson(ctx.staff.owner.token, { texto: "Todo excelente y comodo", calificacion: 5, source: "encuesta_propia" }));
    await app.request(`/hoteles/${ctx.propertyId}/reputacion/resenas`, authedJson(ctx.staff.owner.token, { texto: MUY_NEGATIVA_AC_LIMPIEZA, calificacion: 1, source: "encuesta_propia" }));
    await app.request(`/hoteles/${ctx.propertyId}/reputacion/resenas`, authedJson(ctx.staff.owner.token, { texto: MUY_NEGATIVA_AC_LIMPIEZA, calificacion: 1, source: "encuesta_propia" }));

    const res = await app.request(`/hoteles/${ctx.propertyId}/reputacion/indice`, authedJson(ctx.staff.accountant.token));
    const body = (await res.json()) as { totalResenas: number; distribucionSentimiento: Record<string, number>; temasCriticos: { topic: string }[] };
    expect(body.totalResenas).toBe(3);
    expect(body.distribucionSentimiento.muy_negativo).toBe(2);
    expect(body.temasCriticos.map((t) => t.topic)).toContain("aire_acondicionado");
  });

  it("rechaza fechas mal formadas y rechaza a un rol fuera de REPUTACION_VIEW_ROLES", async () => {
    const app = buildApp(ctx.deps);
    const malFormada = await app.request(`/hoteles/${ctx.propertyId}/reputacion/indice?desde=01-01-2026`, authedJson(ctx.staff.owner.token));
    expect(malFormada.status).toBe(400);
    const rolInvalido = await app.request(`/hoteles/${ctx.propertyId}/reputacion/indice`, authedJson(ctx.staff.housekeeping.token));
    expect(rolInvalido.status).toBe(403);
  });
});
