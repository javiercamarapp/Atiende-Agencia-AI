// Fase 6 pieza 3 (REQ-053) -- test de integración HTTP real del redactor de
// inconformidades: versionado, plazo calculado server-side (Art. 95 LAASSP),
// y la gate de INCONFORMIDAD_REVIEW_ROLES para "marcar como revisado".
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

describe("Fase 6 pieza 3 (REQ-053) -- redactor de inconformidades", () => {
  it("viewer no puede generar un borrador (403); writer sí, con fundamentos/plazo/viabilidad calculados server-side", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const forbidden = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/inconformidad`,
      authedJson(ctx.staff.viewer.token, { hechos: ["h"], agravios: ["a"], falloNotifiedOn: "2026-01-05", bajoTratados: false }),
    );
    expect(forbidden.status).toBe(403);

    const created = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/inconformidad`,
      authedJson(ctx.staff.writer.token, {
        hechos: ["El fallo desechó nuestra propuesta por un requisito no marcado como obligatorio en las bases."],
        agravios: ["El acto viola el principio de máxima concurrencia (Art. 49 LAASSP)."],
        pruebas: ["Copia del fallo publicado."],
        falloNotifiedOn: "2026-01-05",
        bajoTratados: false,
      }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { version: number; status: string; fundamentos: unknown[]; plazo: { fechaLimite: string }; disclaimer: string; viability: string };
    expect(body.version).toBe(1);
    expect(body.status).toBe("borrador");
    expect(body.fundamentos).toHaveLength(2);
    expect(body.disclaimer).toMatch(/BORRADOR/);
    expect(body.viability).toBe("alta"); // 1 prueba para 1 agravio.
  });

  it("cada generación crea una VERSIÓN nueva -- nunca edita una existente", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const payload = { hechos: ["h1"], agravios: ["a1"], falloNotifiedOn: "2026-01-05", bajoTratados: false };
    const first = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/inconformidad`, authedJson(ctx.staff.writer.token, payload));
    const second = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/inconformidad`, authedJson(ctx.staff.writer.token, payload));
    expect(((await first.json()) as { version: number }).version).toBe(1);
    expect(((await second.json()) as { version: number }).version).toBe(2);

    const list = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/inconformidad`, authedJson(ctx.staff.viewer.token));
    expect(((await list.json()) as { drafts: unknown[] }).drafts).toHaveLength(2);
  });

  it("hechos/agravios vacíos -> 400; falloNotifiedOn mal formado -> 400", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const emptyHechos = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/inconformidad`,
      authedJson(ctx.staff.writer.token, { hechos: [], agravios: ["a"], falloNotifiedOn: "2026-01-05", bajoTratados: false }),
    );
    expect(emptyHechos.status).toBe(400);

    const badDate = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/inconformidad`,
      authedJson(ctx.staff.writer.token, { hechos: ["h"], agravios: ["a"], falloNotifiedOn: "05-enero-2026", bajoTratados: false }),
    );
    expect(badDate.status).toBe(400);
  });

  it("bajoTratados=true otorga 10 días hábiles en vez de 6", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const normal = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/inconformidad`,
      authedJson(ctx.staff.writer.token, { hechos: ["h"], agravios: ["a"], falloNotifiedOn: "2026-01-05", bajoTratados: false }),
    );
    const tratados = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/inconformidad`,
      authedJson(ctx.staff.writer.token, { hechos: ["h"], agravios: ["a"], falloNotifiedOn: "2026-01-05", bajoTratados: true }),
    );
    const normalBody = (await normal.json()) as { plazo: { fechaLimite: string; diasHabiles: number } };
    const tratadosBody = (await tratados.json()) as { plazo: { fechaLimite: string; diasHabiles: number } };
    expect(normalBody.plazo.diasHabiles).toBe(6);
    expect(tratadosBody.plazo.diasHabiles).toBe(10);
    expect(tratadosBody.plazo.fechaLimite > normalBody.plazo.fechaLimite).toBe(true);
  });

  it("marcar como revisado: writer NO puede, reviewer SÍ; un segundo intento -> 409", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/inconformidad`,
      authedJson(ctx.staff.writer.token, { hechos: ["h"], agravios: ["a"], falloNotifiedOn: "2026-01-05", bajoTratados: false }),
    );
    const draftId = ((await created.json()) as { id: string }).id;

    const writerAttempt = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/inconformidad/${draftId}/mark-reviewed`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.writer.token}` },
    });
    expect(writerAttempt.status).toBe(403);

    const reviewed = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/inconformidad/${draftId}/mark-reviewed`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.reviewer.token}` },
    });
    expect(reviewed.status).toBe(200);
    expect(((await reviewed.json()) as { status: string }).status).toBe("revisado");

    const again = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/inconformidad/${draftId}/mark-reviewed`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.staff.reviewer.token}` },
    });
    expect(again.status).toBe(409);
  });
});
