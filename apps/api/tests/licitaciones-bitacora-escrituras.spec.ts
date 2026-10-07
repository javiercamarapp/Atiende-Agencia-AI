// L-P3-17 -- bitacora de escrituras de licitaciones (REQ-083/084/171): cada escritura deja un renglon con antes/despues, actor y correlacion;
// `X-Correlation-Id` saneado; la correlacion de origen se hereda en la convocatoria y sus versiones; vista de la organizacion solo owner/admin
// con filtros y paginacion por llave; base sin la 038 -> "no disponible aun" (nunca 500). El UPDATE/DELETE directo como rol de app y la traza
// de la ingesta contra Postgres real viven en scripts/verify-licitaciones-stepup-y-bitacora.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";

const patch = (token: string, body: unknown, extra: Record<string, string> = {}): RequestInit => {
  const raw = JSON.stringify(body);
  return { method: "PATCH", body: raw, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength), ...extra } };
};
const put = (token: string, body: unknown): RequestInit => ({ ...patch(token, body), method: "PUT" });
const del = (token: string): RequestInit => ({ method: "DELETE", headers: { authorization: `Bearer ${token}` } });

async function setup() {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const app = buildApp(ctx.deps);
  const trail = (entity?: string) => ctx.repo.listAuditoria(ctx.organizationId, entity ? { entity } : {}, { orden: "asc", limit: 100 }).then((p) => p.items);
  return { ctx, app, trail, company: `/licitaciones/${ctx.propertyId}/company`, audit: `/licitaciones/${ctx.propertyId}/audit-trail` };
}

describe("cada escritura de datos de empresa deja un renglon con antes y despues", () => {
  it("tarifa: alta, edicion y decision", async () => {
    const { ctx, app, trail, company } = await setup();
    const alta = await app.request(`${company}/rates`, authedJson(ctx.staff.writer.token, { concept: "consultoria_hora", unitPrice: "500.00", validFrom: "2026-01-01T00:00:00-06:00" }, { "x-correlation-id": "corr-tarifa-1" }));
    expect(alta.status).toBe(201);
    expect(alta.headers.get("x-correlation-id")).toBe("corr-tarifa-1");
    const id = ((await alta.json()) as { id: string }).id;
    expect((await app.request(`${company}/rates/${id}`, patch(ctx.staff.writer.token, { unitPrice: "650.00" }))).status).toBe(200);
    expect((await app.request(`${company}/rates/${id}/approve`, authedJson(ctx.staff.owner.token, {}))).status).toBe(200);
    const filas = await trail("tarifa");
    expect(filas.map((f) => f.action)).toEqual(["tarifa.creado", "tarifa.editado", "tarifa.aprobado"]);
    expect(filas[0]).toMatchObject({ entityId: id, actorId: ctx.staff.writer.id, correlationId: "corr-tarifa-1", before: null, after: { concept: "consultoria_hora", unitPrice: "500.00" } });
    expect(filas[1]).toMatchObject({ before: { unitPrice: "500.00" }, after: { unitPrice: "650.00" }, actorId: ctx.staff.writer.id });
    expect(filas[2]).toMatchObject({ before: { approvalStatus: "pendiente_aprobacion" }, after: { approvalStatus: "aprobado" }, actorId: ctx.staff.owner.id });
  });

  it("documento, capacidad, experiencia y firmante: alta y edicion (el actor sale de la sesion, nunca del cuerpo)", async () => {
    const { ctx, app, trail, company } = await setup();
    const w = ctx.staff.writer.token;
    const doc = ((await (await app.request(`${company}/documents`, authedJson(w, { type: "acta", label: "Acta constitutiva", expiresAt: null }))).json()) as { id: string }).id;
    expect((await app.request(`${company}/documents/${doc}`, patch(w, { label: "Acta v2" }))).status).toBe(200);
    const cap = ((await (await app.request(`${company}/capabilities`, authedJson(w, { name: "Ingenieria", description: "d" }))).json()) as { id: string }).id;
    expect((await app.request(`${company}/capabilities/${cap}`, patch(w, { description: "d2" }))).status).toBe(200);
    const exp = ((await (await app.request(`${company}/experience`, authedJson(w, { description: "e", evidenceDocId: doc }))).json()) as { id: string }).id;
    expect((await app.request(`${company}/experience/${exp}`, patch(w, { description: "e2" }))).status).toBe(200);
    const sg = ((await (await app.request(`${company}/signers`, authedJson(w, { name: "Ana Perez", role: "Apoderada" }))).json()) as { id: string }).id;
    expect((await app.request(`${company}/signers/${sg}`, patch(w, { authorized: true }))).status).toBe(200);
    const todas = await trail();
    expect(todas.map((f) => f.action)).toEqual([
      "documento_empresa.creado", "documento_empresa.editado", "capacidad.creado", "capacidad.editado", "experiencia.creado", "experiencia.editado", "firmante.creado", "firmante.editado",
    ]);
    expect(todas[1]).toMatchObject({ before: { label: "Acta constitutiva" }, after: { label: "Acta v2" } });
    expect(todas[7]!.before).toMatchObject({ authorized: false });
    expect(todas.every((f) => f.actorId === ctx.staff.writer.id)).toBe(true);
  });

  it("una escritura rechazada (422/403) no deja renglon", async () => {
    const { ctx, app, trail, company } = await setup();
    expect((await app.request(`${company}/rates`, authedJson(ctx.staff.writer.token, { concept: "x", unitPrice: "1.00", approvalStatus: "aprobado" }))).status).toBe(422);
    expect((await app.request(`${company}/rates`, authedJson(ctx.staff.viewer.token, { concept: "x", unitPrice: "1.00" }))).status).toBe(403);
    expect(await trail()).toHaveLength(0);
  });

  it("antes/despues solo llevan la lista cerrada de campos de la entidad (ni ids de aprobacion ni nada fuera de la lista)", async () => {
    const { ctx, app, trail, company } = await setup();
    await app.request(`${company}/rates`, authedJson(ctx.staff.writer.token, { concept: "c", unitPrice: "5.00" }));
    const fila = (await trail("tarifa"))[0]!;
    expect(Object.keys(fila.after as object).sort()).toEqual(["approvalStatus", "concept", "currency", "unitPrice", "validFrom", "validUntil"].filter((k) => k in (fila.after as object)).sort());
    expect(JSON.stringify(fila)).not.toMatch(/proposedBy|approvedBy|token|secret|password/i);
  });
});

describe("configuracion, perfil de matching y staff", () => {
  it("configuracion (zona horaria), perfil de matching, invitacion, revocacion y cambio de rol", async () => {
    const { ctx, app, trail } = await setup();
    const o = ctx.staff.owner.token;
    expect((await app.request("/v1/licitaciones/empresa-de-prueba/admin/tenant-config", patch(o, { timezone: "America/Cancun" }))).status).toBe(200);
    expect((await app.request(`/licitaciones/${ctx.propertyId}/matching-profile`, put(o, { keywords: ["obra"], excludedKeywords: [], classifierCodes: [], entities: [], states: ["Yucatan"], budgetMin: 10, budgetMax: 20 }))).status).toBe(200);
    const inv = await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(o, { email: "nuevo@empresa-de-prueba.mx", verticalRole: "analyst" }));
    expect(inv.status).toBe(201);
    const inviteId = ((await inv.json()) as { id: string }).id;
    expect((await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/invitaciones/${inviteId}`, del(o))).status).toBe(200);
    expect((await app.request(`/v1/licitaciones/${ctx.propertyId}/admin/staff/miembros/${ctx.staff.viewer.id}`, patch(o, { verticalRole: "writer" }))).status).toBe(200);
    const todas = await trail();
    expect(todas.map((f) => f.action)).toEqual([
      "configuracion.editada", "perfil_matching.creado", "staff_invitacion.creada", "staff_invitacion.revocada", "staff_miembro.rol_cambiado",
    ]);
    expect(todas[0]).toMatchObject({ after: { timezone: "America/Cancun" }, actorId: ctx.staff.owner.id });
    expect(todas[1]!.after).toMatchObject({ keywords: ["obra"], states: ["Yucatan"], budgetMin: 10, budgetMax: 20 });
    expect(todas[2]!.after).toEqual({ verticalRole: "analyst", platformRole: "member", status: "pendiente" });
    expect(JSON.stringify(todas)).not.toContain("nuevo@empresa-de-prueba.mx");
    expect(todas[4]).toMatchObject({ entityId: ctx.staff.viewer.id, before: { verticalRole: "viewer" }, after: { verticalRole: "writer" } });
  });
});

describe("correlation_id: saneado, herencia en la convocatoria y sus versiones", () => {
  it("un X-Correlation-Id invalido se descarta (se genera otro); uno valido se conserva y se devuelve", async () => {
    const { ctx, app, trail, company } = await setup();
    const w = ctx.staff.writer.token;
    const mala = await app.request(`${company}/rates`, authedJson(w, { concept: "a", unitPrice: "1.00" }, { "x-correlation-id": "con espacios; <script>" }));
    const larga = await app.request(`${company}/rates`, authedJson(w, { concept: "b", unitPrice: "1.00" }, { "x-correlation-id": "x".repeat(65) }));
    const buena = await app.request(`${company}/rates`, authedJson(w, { concept: "c", unitPrice: "1.00" }, { "x-correlation-id": "ingesta.2026-10-04:abc_1" }));
    for (const r of [mala, larga]) {
      const h = r.headers.get("x-correlation-id")!;
      expect(h).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
      expect(h).not.toContain("script");
    }
    expect(buena.headers.get("x-correlation-id")).toBe("ingesta.2026-10-04:abc_1");
    const filas = await trail("tarifa");
    expect(filas.map((f) => f.correlationId)).toEqual([mala.headers.get("x-correlation-id"), larga.headers.get("x-correlation-id"), "ingesta.2026-10-04:abc_1"]);
  });

  it("el alta de una convocatoria nace con correlacion; su actualizacion y su version la HEREDAN; la traza las une", async () => {
    const { ctx, app, audit } = await setup();
    const w = ctx.staff.writer.token;
    const base = `/licitaciones/${ctx.propertyId}/tenders`;
    const alta = await app.request(base, authedJson(w, { title: "Obra de drenaje", externalId: "EXT-1", submissionDeadline: "2026-12-01T10:00:00-06:00" }, { "x-correlation-id": "ingesta-A1" }));
    expect(alta.status).toBe(201);
    const tender = (await alta.json()) as { id: string };
    // actualizacion SIN header: hereda la de origen y la version nueva tambien
    const cambio = await app.request(base, authedJson(w, { title: "Obra de drenaje (aclarada)", externalId: "EXT-1", submissionDeadline: "2026-12-05T10:00:00-06:00" }));
    expect(cambio.status).toBe(200);
    expect(cambio.headers.get("x-correlation-id")).toBe("ingesta-A1");
    const traza = await app.request(`${audit}/tenders/${tender.id}/trace`, authedJson(ctx.staff.owner.token));
    expect(traza.status).toBe(200);
    const body = (await traza.json()) as { items: { action: string; correlationId: string; entity: string }[]; available: boolean };
    expect(body.available).toBe(true);
    expect(body.items.map((i) => i.action)).toEqual(expect.arrayContaining(["convocatoria.creada", "convocatoria.actualizada"]));
    expect(body.items.every((i) => i.correlationId === "ingesta-A1")).toBe(true);
    // el filtro por correlacion devuelve el mismo conjunto
    const porCorr = await app.request(`${audit}?correlationId=ingesta-A1`, authedJson(ctx.staff.admin.token));
    expect(((await porCorr.json()) as { items: unknown[] }).items.length).toBe(body.items.length);
  });
});

describe("vista de la bitacora de la organizacion (owner/admin)", () => {
  async function conHistorial() {
    const s = await setup();
    for (let i = 0; i < 5; i += 1) await s.app.request(`${s.company}/rates`, authedJson(s.ctx.staff.writer.token, { concept: `c${i}`, unitPrice: "1.00" }));
    await s.app.request(`${s.company}/documents`, authedJson(s.ctx.staff.analyst.token, { type: "t", label: "l", expiresAt: null }));
    return s;
  }

  it("solo owner/admin leen; analyst, writer y viewer reciben 403; sin token 401", async () => {
    const { ctx, app, audit } = await conHistorial();
    for (const t of [ctx.staff.analyst.token, ctx.staff.writer.token, ctx.staff.reviewer.token, ctx.staff.viewer.token]) expect((await app.request(audit, authedJson(t))).status).toBe(403);
    expect((await app.request(audit)).status).toBe(401);
    expect((await app.request(audit, authedJson(ctx.staff.owner.token))).status).toBe(200);
    expect((await app.request(audit, authedJson(ctx.staff.admin.token))).status).toBe(200);
  });

  it("pagina por llave sin repetir ni saltar renglones, mas reciente primero", async () => {
    const { ctx, app, audit } = await conHistorial();
    const vistos: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const res = await app.request(`${audit}?limit=2${cursor ? `&cursor=${cursor}` : ""}`, authedJson(ctx.staff.owner.token));
      const page = (await res.json()) as { items: { id: string; seq: string }[]; nextCursor: string | null };
      vistos.push(...page.items.map((x) => x.seq));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(vistos).toHaveLength(6);
    expect(new Set(vistos).size).toBe(6);
    expect([...vistos].sort((a, b) => Number(b) - Number(a))).toEqual(vistos);
  });

  it("filtra por entidad, actor y fecha; rechaza filtros invalidos con 400", async () => {
    const { ctx, app, audit } = await conHistorial();
    const lee = async (qs: string) => (await (await app.request(`${audit}?${qs}`, authedJson(ctx.staff.owner.token))).json()) as { items: { entity: string; actorId: string }[]; people: Record<string, string> };
    expect((await lee("entity=tarifa")).items).toHaveLength(5);
    expect((await lee("entity=documento_empresa")).items).toHaveLength(1);
    const porActor = await lee(`actorId=${ctx.staff.analyst.id}`);
    expect(porActor.items).toHaveLength(1);
    expect(porActor.people[ctx.staff.analyst.id]).toBe("analyst");
    expect((await lee("desde=2999-01-01T00:00:00Z")).items).toHaveLength(0);
    expect((await lee("hasta=2000-01-01T00:00:00Z")).items).toHaveLength(0);
    for (const bad of ["entity=nada", "actorId=no-uuid", "correlationId=con%20espacio", "desde=ayer", "limit=0", "limit=101", "cursor=abc"]) {
      expect((await app.request(`${audit}?${bad}`, authedJson(ctx.staff.owner.token))).status, bad).toBe(400);
    }
  });

  it("COMPATIBILIDAD base sin la migracion 038: la vista dice 'no disponible aun' (available:false), las escrituras siguen y nada da 500", async () => {
    const { ctx, app, audit, company } = await setup();
    ctx.repo.auditTrailAvailable = false;
    const alta = await app.request(`${company}/rates`, authedJson(ctx.staff.writer.token, { concept: "x", unitPrice: "1.00" }));
    expect(alta.status).toBe(201);
    const res = await app.request(audit, authedJson(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: false, items: [], nextCursor: null });
  });

  it("la traza de una convocatoria ajena o inexistente da 404 (nunca renglones de otra organizacion)", async () => {
    const { ctx, app, audit } = await setup();
    expect((await app.request(`${audit}/tenders/00000000-0000-4000-8000-000000000000/trace`, authedJson(ctx.staff.owner.token))).status).toBe(404);
    expect((await app.request(`${audit}/tenders/no-es-uuid/trace`, authedJson(ctx.staff.owner.token))).status).toBe(404);
  });
});
