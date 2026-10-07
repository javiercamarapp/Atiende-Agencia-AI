// L-P3-03/04 (REQ-141/142/109/145) -- perfil de empresa completo por HTTP (app.request, repositorio en memoria con las mismas reglas que la
// migracion 040; el Postgres real lo cubre scripts/verify-licitaciones-perfil-empresa): perfil general + MIPyME, productos y servicios,
// ubicaciones, restricciones, socios/representantes, firmantes con vigencia, procedencia en la misma transaccion, aprobacion con autor distinto,
// cross-tenant, roles y la base sin migrar ("no disponible aun").
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

function send(method: string, token: string, body?: unknown): RequestInit {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  return { method, body: raw, headers: { authorization: `Bearer ${token}`, ...(raw ? { "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) } : {}) } };
}

const ORG_B = "00000000-0000-0000-0000-00000000bb01";

async function setup() {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const { deps, emisiones } = conEmisiones(ctx.deps);
  const app = buildApp(deps);
  const base = `/licitaciones/${ctx.propertyId}/company`;
  const t = ctx.staff;
  const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await res).json() as Promise<T>;
  return { ctx, app, base, t, emisiones, json };
}

const perfil = { legalName: "Acme Servicios SA de CV", taxId: "acm010101ab1", sector: "servicios", employeeCount: 12, annualSalesCents: 150_000_000, foundedYear: 2010, website: "https://acme.example.mx" };

describe("perfil general (REQ-141) y estratificacion MIPyME (REQ-109)", () => {
  it("el writer lo crea pendiente con el RFC normalizado; GET trae la procedencia (quien y cuando) y la estratificacion pendiente de verificacion legal", async () => {
    const s = await setup();
    const res = await s.app.request(`${s.base}/profile`, send("PUT", s.t.writer.token, perfil));
    expect(res.status).toBe(201);
    const creado = await s.json<{ id: string; taxId: string; approvalStatus: string; proposedBy: string }>(res);
    expect(creado).toMatchObject({ taxId: "ACM010101AB1", approvalStatus: "pendiente_aprobacion", proposedBy: s.t.writer.id });

    const get = await s.json<{ disponible: boolean; profile: { id: string }; mipyme: { status: string; verificacion: string; validarConAbogado: boolean; estrato?: string }; norma: { estadoVerificacion: string }; provenance: Record<string, { by: string; source: string; at: string }>; people: Record<string, string> }>(
      s.app.request(`${s.base}/profile`, authedJson(s.t.viewer.token)),
    );
    expect(get.disponible).toBe(true);
    expect(get.mipyme).toMatchObject({ status: "calculado", verificacion: "sin_verificar", validarConAbogado: true });
    expect(get.norma.estadoVerificacion).toBe("sin_verificar");
    expect(get.provenance[creado.id]).toMatchObject({ by: s.t.writer.id, source: "manual" });
    expect(get.provenance[creado.id]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(get.people[s.t.writer.id]).toBeTruthy();
  });

  it("sin sector, trabajadores o ventas: la estratificacion es no_evaluable con el motivo (nunca un estrato inventado)", async () => {
    const s = await setup();
    await s.app.request(`${s.base}/profile`, send("PUT", s.t.writer.token, { legalName: "Acme", taxId: "ACM010101AB1" }));
    const get = await s.json<{ mipyme: { status: string; faltan: string[]; estrato?: string } }>(s.app.request(`${s.base}/profile`, authedJson(s.t.viewer.token)));
    expect(get.mipyme.status).toBe("no_evaluable");
    expect(get.mipyme.faltan).toEqual(["sector", "numero de trabajadores", "ventas anuales"]);
    expect(get.mipyme.estrato).toBeUndefined();
  });

  it("validaciones: RFC mal formado o generico, sector fuera de catalogo, cifras negativas y sitio no http -> 400; approvalStatus en el cuerpo -> 422", async () => {
    const s = await setup();
    const put = (body: unknown) => s.app.request(`${s.base}/profile`, send("PUT", s.t.writer.token, body));
    expect((await put({ ...perfil, taxId: "no-es-rfc" })).status).toBe(400);
    expect((await put({ ...perfil, taxId: "XAXX010101000" })).status).toBe(400);
    expect((await put({ ...perfil, taxId: "" })).status).toBe(400);
    expect((await put({ ...perfil, sector: "agro" })).status).toBe(400);
    expect((await put({ ...perfil, employeeCount: -1 })).status).toBe(400);
    expect((await put({ ...perfil, annualSalesCents: 1.5 })).status).toBe(400);
    expect((await put({ ...perfil, website: "javascript:alert(1)" })).status).toBe(400);
    expect((await put({ ...perfil, legalName: "  " })).status).toBe(400);
    expect((await put({ ...perfil, approvalStatus: "aprobado" })).status).toBe(422);
  });

  it("roles: el viewer no escribe (403); aprobar: el autor no (403), el writer no (403), el analyst si (200), la segunda decision 409; editar lo regresa a pendiente", async () => {
    const s = await setup();
    expect((await s.app.request(`${s.base}/profile`, send("PUT", s.t.viewer.token, perfil))).status).toBe(403);
    const { id } = await s.json<{ id: string }>(s.app.request(`${s.base}/profile`, send("PUT", s.t.analyst.token, perfil)));
    expect((await s.app.request(`${s.base}/profile/${id}/approve`, send("POST", s.t.analyst.token))).status).toBe(403); // autor
    expect((await s.app.request(`${s.base}/profile/${id}/approve`, send("POST", s.t.writer.token))).status).toBe(403); // sin rol de decision
    expect((await s.app.request(`${s.base}/profile/${id}/approve`, send("POST", s.t.owner.token))).status).toBe(200);
    expect((await s.app.request(`${s.base}/profile/${id}/approve`, send("POST", s.t.owner.token))).status).toBe(409);
    expect((await s.app.request(`${s.base}/profile/no-es-uuid/approve`, send("POST", s.t.owner.token))).status).toBe(404);
    const aprobado = await s.json<{ profile: { approvalStatus: string } }>(s.app.request(`${s.base}/profile`, authedJson(s.t.viewer.token)));
    expect(aprobado.profile.approvalStatus).toBe("aprobado");
    const editado = await s.json<{ approvalStatus: string }>(s.app.request(`${s.base}/profile`, send("PUT", s.t.writer.token, { ...perfil, employeeCount: 13 })));
    expect(editado.approvalStatus).toBe("pendiente_aprobacion");
  });
});

describe("colecciones: productos y servicios, ubicaciones, restricciones, socios y representantes", () => {
  it("productos y servicios: alta, edicion, lista con procedencia, baja por el writer; viewer 403", async () => {
    const s = await setup();
    expect((await s.app.request(`${s.base}/products-services`, send("POST", s.t.viewer.token, { kind: "servicio", name: "Consultoría" }))).status).toBe(403);
    expect((await s.app.request(`${s.base}/products-services`, send("POST", s.t.writer.token, { kind: "otro", name: "x" }))).status).toBe(400);
    const res = await s.app.request(`${s.base}/products-services`, send("POST", s.t.writer.token, { kind: "servicio", name: "Consultoría", description: "Asesoría", classifierCode: "73" }));
    expect(res.status).toBe(201);
    const { id } = await s.json<{ id: string }>(res);
    const patch = await s.json<{ name: string; approvalStatus: string }>(s.app.request(`${s.base}/products-services/${id}`, send("PATCH", s.t.writer.token, { name: "Consultoría TI" })));
    expect(patch.name).toBe("Consultoría TI");
    const lista = await s.json<{ productsServices: { id: string }[]; provenance: Record<string, { by: string }>; disponible: boolean }>(s.app.request(`${s.base}/products-services`, authedJson(s.t.viewer.token)));
    expect(lista.productsServices).toHaveLength(1);
    expect(lista.provenance[id]!.by).toBe(s.t.writer.id);
    expect((await s.app.request(`${s.base}/products-services/${id}`, send("DELETE", s.t.writer.token))).status).toBe(200);
    expect((await s.app.request(`${s.base}/products-services/${id}`, send("DELETE", s.t.writer.token))).status).toBe(404);
  });

  it("ubicaciones: estado obligatorio; alta y edicion", async () => {
    const s = await setup();
    expect((await s.app.request(`${s.base}/locations`, send("POST", s.t.writer.token, { kind: "matriz", name: "Matriz" }))).status).toBe(400);
    const { id } = await s.json<{ id: string }>(s.app.request(`${s.base}/locations`, send("POST", s.t.writer.token, { kind: "matriz", name: "Matriz", state: "Yucatán", municipality: "Mérida" })));
    const upd = await s.json<{ state: string }>(s.app.request(`${s.base}/locations/${id}`, send("PATCH", s.t.writer.token, { state: "Jalisco" })));
    expect(upd.state).toBe("Jalisco");
  });

  it("restricciones: fechas validas y en orden; baja SOLO con rol de decision (writer 403, analyst 200)", async () => {
    const s = await setup();
    const post = (body: unknown) => s.app.request(`${s.base}/restrictions`, send("POST", s.t.writer.token, body));
    expect((await post({ kind: "sancion", description: "x" })).status).toBe(400);
    expect((await post({ kind: "sancion", description: "x", validFrom: "2026-02-30" })).status).toBe(400);
    expect((await post({ kind: "sancion", description: "x", validFrom: "2026-06-01", validUntil: "2026-01-01" })).status).toBe(400);
    const { id } = await s.json<{ id: string }>(post({ kind: "sancion", description: "Sanción de prueba", validFrom: "2026-01-01" }));
    const mal = await s.app.request(`${s.base}/restrictions/${id}`, send("PATCH", s.t.writer.token, { validUntil: "2025-01-01" }));
    expect(mal.status).toBe(400);
    expect((await s.app.request(`${s.base}/restrictions/${id}`, send("DELETE", s.t.writer.token))).status).toBe(403);
    expect((await s.app.request(`${s.base}/restrictions/${id}`, send("DELETE", s.t.analyst.token))).status).toBe(200);
  });

  it("socios: RFC normalizado, porcentaje a dos decimales, la suma no pasa de 100 y un representante no tiene porcentaje", async () => {
    const s = await setup();
    const post = (body: unknown) => s.app.request(`${s.base}/stakeholders`, send("POST", s.t.writer.token, body));
    const ana = await s.json<{ id: string; rfc: string; participationPct: string }>(post({ kind: "socio", fullName: "Ana Pérez", rfc: " pepa800101ab1 ", participationPct: "60" }));
    expect(ana).toMatchObject({ rfc: "PEPA800101AB1", participationPct: "60.00" });
    expect((await post({ kind: "socio", fullName: "Beto", participationPct: "40.01" })).status).toBe(400); // 100.01 en total
    expect((await post({ kind: "socio", fullName: "Beto", participationPct: "33.333" })).status).toBe(400);
    expect((await post({ kind: "socio", fullName: "Beto" })).status).toBe(400); // un socio declara su porcentaje
    expect((await post({ kind: "socio", fullName: "Beto", rfc: "invalido", participationPct: "10" })).status).toBe(400);
    expect((await post({ kind: "representante", fullName: "Rep", participationPct: "5" })).status).toBe(400);
    expect((await post({ kind: "socio", fullName: "Beto", participationPct: "40" })).status).toBe(201);
    expect((await post({ kind: "representante", fullName: "Carla Rep", rfc: "RECA850505CD2" })).status).toBe(201);
    // editar a Ana por encima de lo que cabe, y quitarle el porcentaje a un socio -> 400
    expect((await s.app.request(`${s.base}/stakeholders/${ana.id}`, send("PATCH", s.t.writer.token, { participationPct: "61" }))).status).toBe(400);
    expect((await s.app.request(`${s.base}/stakeholders/${ana.id}`, send("PATCH", s.t.writer.token, { participationPct: null }))).status).toBe(400);
    expect((await s.app.request(`${s.base}/stakeholders/${ana.id}`, send("PATCH", s.t.writer.token, { participationPct: "50.5" }))).status).toBe(200);
    expect((await s.app.request(`${s.base}/stakeholders/${ana.id}`, send("DELETE", s.t.writer.token))).status).toBe(403);
  });

  it("cada alta o edicion nueva avisa a la campana que algo espera aprobacion (sin PII) y queda en la bitacora de escrituras", async () => {
    const s = await setup();
    const { id } = await s.json<{ id: string }>(s.app.request(`${s.base}/stakeholders`, send("POST", s.t.writer.token, { kind: "socio", fullName: "Nombre Secreto", rfc: "PEPA800101AB1", participationPct: "10" })));
    const aviso = s.emisiones.filter((e) => e.evento === "licitaciones.datos_empresa.aprobacion_pendiente");
    expect(aviso).toHaveLength(1);
    expect(aviso[0]!.dedupeKey).toContain(`stakeholder:${id}`);
    expect(JSON.stringify(aviso)).not.toMatch(/Secreto|PEPA800101/);
    const bitacora = await s.ctx.repo.listAuditoria(s.ctx.organizationId, { entity: "socio_empresa" }, { orden: "asc", limit: 100 });
    const fila = bitacora.items.find((e) => e.entityId === id);
    expect(fila).toMatchObject({ action: "socio_empresa.creado", actorId: s.t.writer.id });
    expect(JSON.stringify(fila)).not.toContain("PEPA800101"); // el RFC no se duplica en la bitacora
  });
});

describe("procedencia (REQ-142)", () => {
  it("si la procedencia falla, la escritura falla Y NO queda el dato (misma transaccion)", async () => {
    const s = await setup();
    s.ctx.repo.companyProfile.provenanceFailure = new Error("procedencia caida");
    const res = await s.app.request(`${s.base}/locations`, send("POST", s.t.writer.token, { kind: "matriz", name: "Matriz", state: "Yucatán" }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("procedencia caida"); // sin filtrar el error interno
    expect((await s.app.request(`${s.base}/profile`, send("PUT", s.t.writer.token, perfil))).status).toBe(500);
    expect((await s.app.request(`${s.base}/signers`, send("POST", s.t.writer.token, { name: "Ana", role: "rep", validFrom: "2026-01-01" }))).status).toBe(500);
    s.ctx.repo.companyProfile.provenanceFailure = null;
    expect((await s.json<{ locations: unknown[] }>(s.app.request(`${s.base}/locations`, authedJson(s.t.viewer.token)))).locations).toHaveLength(0);
    expect((await s.json<{ profile: unknown }>(s.app.request(`${s.base}/profile`, authedJson(s.t.viewer.token)))).profile).toBeNull();
    expect((await s.json<{ signers: unknown[] }>(s.app.request(`${s.base}/signers`, authedJson(s.t.viewer.token)))).signers).toHaveLength(0);
  });

  it("un dato insertado fuera de la API (sin procedencia) se lista SIN procedencia y bloquea: la elegibilidad queda no_evaluable y el requisito del expediente queda bloqueado", async () => {
    const s = await setup();
    s.ctx.repo.companyProfile.seedWithoutProvenance("restriction", s.ctx.organizationId, { id: "r-sql", kind: "sancion", description: "x", validFrom: "2020-01-01", validUntil: null, approvalStatus: "aprobado", proposedBy: null, approvedBy: s.t.owner.id, approvedAt: "2026-01-01T00:00:00Z" });
    s.ctx.repo.companyProfile.seedWithoutProvenance("stakeholder", s.ctx.organizationId, { id: "k-sql", kind: "socio", fullName: "Socio SQL", rfc: null, participationPct: "100.00", approvalStatus: "aprobado", proposedBy: null, approvedBy: s.t.owner.id, approvedAt: "2026-01-01T00:00:00Z" });

    const lista = await s.json<{ restrictions: { id: string }[]; provenance: Record<string, unknown> }>(s.app.request(`${s.base}/restrictions`, authedJson(s.t.viewer.token)));
    expect(lista.restrictions.map((r) => r.id)).toEqual(["r-sql"]);
    expect(lista.provenance["r-sql"]).toBeUndefined();

    // Matching: la sancion aprobada pero SIN procedencia no decide -> no_evaluable con el motivo.
    const matching = await s.json<{ eligibility: { status: string; criteria: { requirement: string; status: string; explanation: string }[] } }>(
      s.app.request(`/licitaciones/${s.ctx.propertyId}/tenders/${s.ctx.tenderId}/matching`, authedJson(s.t.viewer.token)),
    );
    const criterio = matching.eligibility.criteria.find((c) => c.requirement === "restrictions")!;
    expect(criterio.status).toBe("no_evaluable");
    expect(criterio.explanation).toMatch(/procedencia/);

    // Expediente: un requisito mapeado a los socios queda bloqueado (blockers = 1) mientras el dato no tenga procedencia.
    await s.app.request(`/licitaciones/${s.ctx.propertyId}/tenders/${s.ctx.tenderId}/proposal`, authedJson(s.t.writer.token));
    const extract = await s.json<{ items: { topicKey?: string }[] }>(
      s.app.request(`/licitaciones/${s.ctx.propertyId}/tenders/${s.ctx.tenderId}/requirements/extract`, authedJson(s.t.writer.token, { documents: [{ documentId: "bases", documentLabel: "Bases", publishedAt: "2026-01-01T00:00:00-06:00", pages: [{ page: 1, text: "El licitante deberá presentar acta constitutiva original." }] }] }, { "idempotency-key": "extract-socios" })),
    );
    const topicKey = extract.items.find((i) => i.topicKey === "acta_constitutiva")!.topicKey!;
    const map = await s.app.request(`/licitaciones/${s.ctx.propertyId}/requirement-mappings/${topicKey}`, send("PUT", s.t.owner.token, { kind: "stakeholders", refKey: "socios", statementTemplate: "Socios: {value}." }));
    expect(map.status).toBe(200);
    const gen1 = await s.json<{ blockers: number }>(s.app.request(`/licitaciones/${s.ctx.propertyId}/tenders/${s.ctx.tenderId}/proposal/technical/generate`, authedJson(s.t.writer.token, {}, { "idempotency-key": "gen-socios-1" })));
    expect(gen1.blockers).toBe(1);

    // Mismo dato capturado POR LA API (con procedencia) y aprobado por otra persona: el requisito se redacta sin bloqueos.
    s.ctx.repo.companyProfile.remove("stakeholder", s.ctx.organizationId, "k-sql");
    const { id } = await s.json<{ id: string }>(s.app.request(`${s.base}/stakeholders`, send("POST", s.t.writer.token, { kind: "socio", fullName: "Socio Real", participationPct: "100" })));
    expect((await s.app.request(`${s.base}/stakeholders/${id}/approve`, send("POST", s.t.owner.token))).status).toBe(200);
    const gen2 = await s.json<{ blockers: number }>(s.app.request(`/licitaciones/${s.ctx.propertyId}/tenders/${s.ctx.tenderId}/proposal/technical/generate`, authedJson(s.t.writer.token, {}, { "idempotency-key": "gen-socios-2" })));
    expect(gen2.blockers).toBe(0);
    const prop = await s.json<{ generationReport: { technical?: { usedCompanyDocumentIds?: string[] } } }>(s.app.request(`/licitaciones/${s.ctx.propertyId}/tenders/${s.ctx.tenderId}/proposal`, authedJson(s.t.viewer.token)));
    expect(prop.generationReport.technical?.usedCompanyDocumentIds).toEqual([id]);
  });
});

describe("firmantes con vigencia del poder (REQ-145)", () => {
  it("varios del mismo cargo, vigencia, documento de identidad propio y limites; el semaforo se calcula en la pantalla con estas fechas", async () => {
    const s = await setup();
    const doc = await s.json<{ id: string }>(s.app.request(`${s.base}/documents`, send("POST", s.t.writer.token, { type: "poder_notarial", label: "Poder 123", expiresAt: null })));
    const a = await s.app.request(`${s.base}/signers`, send("POST", s.t.writer.token, { name: "Ana López", role: "representante_legal", authorized: true, validFrom: "2026-01-01", validUntil: "2026-12-31", identityDocId: doc.id, actionLimits: "hasta 5 mdp" }));
    expect(a.status).toBe(201);
    expect(await a.json()).toMatchObject({ validFrom: "2026-01-01", validUntil: "2026-12-31", identityDocId: doc.id, actionLimits: "hasta 5 mdp", approvalStatus: "pendiente_aprobacion" });
    const b = await s.app.request(`${s.base}/signers`, send("POST", s.t.writer.token, { name: "Beto Ruiz", role: "representante_legal", validFrom: "2027-01-01" }));
    expect(b.status).toBe(201);
    const lista = await s.json<{ signers: { name: string; role: string }[]; vigenciaDisponible: boolean }>(s.app.request(`${s.base}/signers`, authedJson(s.t.viewer.token)));
    expect(lista.signers.map((x) => x.role)).toEqual(["representante_legal", "representante_legal"]);
    expect(lista.vigenciaDisponible).toBe(true);
  });

  it("validaciones: validFrom obligatorio, fechas reales y en orden, documento de la propia organizacion, limites acotados", async () => {
    const s = await setup();
    const post = (body: unknown) => s.app.request(`${s.base}/signers`, send("POST", s.t.writer.token, body));
    expect((await post({ name: "Ana", role: "rep" })).status).toBe(400); // sin validFrom
    expect((await post({ name: "Ana", role: "rep", validFrom: "01/01/2026" })).status).toBe(400);
    expect((await post({ name: "Ana", role: "rep", validFrom: "2026-02-31" })).status).toBe(400);
    expect((await post({ name: "Ana", role: "rep", validFrom: "2026-06-01", validUntil: "2026-01-01" })).status).toBe(400);
    expect((await post({ name: "Ana", role: "rep", validFrom: "2026-01-01", identityDocId: "00000000-0000-0000-0000-000000000099" })).status).toBe(400);
    expect((await post({ name: "Ana", role: "rep", validFrom: "2026-01-01", identityDocId: "no-uuid" })).status).toBe(400);
    expect((await post({ name: "Ana", role: "rep", validFrom: "2026-01-01", actionLimits: "x".repeat(1001) })).status).toBe(400);
    const { id } = await s.json<{ id: string }>(post({ name: "Ana", role: "rep", validFrom: "2026-01-01", validUntil: "2026-12-31" }));
    const patch = (body: unknown) => s.app.request(`${s.base}/signers/${id}`, send("PATCH", s.t.writer.token, body));
    expect((await patch({ validFrom: null })).status).toBe(400); // un poder siempre declara desde cuando rige
    expect((await patch({ validUntil: "2025-01-01" })).status).toBe(400); // antes del inicio
    const ok = await s.json<{ validUntil: string | null; approvalStatus: string }>(patch({ validUntil: null }));
    expect(ok.validUntil).toBeNull();
    expect(ok.approvalStatus).toBe("pendiente_aprobacion");
  });

  it("el firmante vigente se elige a la fecha del acto (fecha limite de la convocatoria), no a la de hoy", async () => {
    const s = await setup();
    // La fecha limite de la convocatoria de prueba es 2026-12-15. Un poder que vence el 2026-06-30 YA no cubre el acto aunque hoy lo cubra.
    const viejo = await s.json<{ id: string }>(s.app.request(`${s.base}/signers`, send("POST", s.t.writer.token, { name: "Poder Vencido", role: "representante_legal", authorized: true, validFrom: "2020-01-01", validUntil: "2026-06-30" })));
    await s.app.request(`${s.base}/signers/${viejo.id}/approve`, send("POST", s.t.owner.token));
    await s.app.request(`/licitaciones/${s.ctx.propertyId}/tenders/${s.ctx.tenderId}/proposal`, authedJson(s.t.writer.token));
    const extract = await s.json<{ items: { topicKey?: string }[] }>(
      s.app.request(`/licitaciones/${s.ctx.propertyId}/tenders/${s.ctx.tenderId}/requirements/extract`, authedJson(s.t.writer.token, { documents: [{ documentId: "bases", documentLabel: "Bases", publishedAt: "2026-01-01T00:00:00-06:00", pages: [{ page: 1, text: "El licitante deberá presentar acta constitutiva original." }] }] }, { "idempotency-key": "extract-poder" })),
    );
    const topicKey = extract.items.find((i) => i.topicKey === "acta_constitutiva")!.topicKey!;
    await s.app.request(`/licitaciones/${s.ctx.propertyId}/requirement-mappings/${topicKey}`, send("PUT", s.t.owner.token, { kind: "signer", refKey: "representante_legal", statementTemplate: "Firma: {value}." }));
    const gen = (key: string) => s.json<{ blockers: number }>(s.app.request(`/licitaciones/${s.ctx.propertyId}/tenders/${s.ctx.tenderId}/proposal/technical/generate`, authedJson(s.t.writer.token, {}, { "idempotency-key": key })));
    expect((await gen("poder-1")).blockers).toBe(1); // vencido el dia del acto: queda pendiente, nunca se rellena

    const nuevo = await s.json<{ id: string }>(s.app.request(`${s.base}/signers`, send("POST", s.t.writer.token, { name: "Poder Vigente", role: "representante_legal", authorized: true, validFrom: "2026-07-01" })));
    await s.app.request(`${s.base}/signers/${nuevo.id}/approve`, send("POST", s.t.owner.token));
    expect((await gen("poder-2")).blockers).toBe(0); // dos del mismo cargo: se elige el vigente a la fecha del acto
  });
});

describe("cross-tenant y base sin migrar", () => {
  it("un dato de OTRA organizacion no se lista ni se puede editar, borrar o decidir (404)", async () => {
    const s = await setup();
    s.ctx.repo.companyProfile.seedWithoutProvenance("location", ORG_B, { id: "11111111-1111-4111-8111-111111111111", kind: "matriz", name: "Ajena", state: "Sonora", municipality: null, address: null, approvalStatus: "pendiente_aprobacion", proposedBy: null, approvedBy: null, approvedAt: null });
    const lista = await s.json<{ locations: unknown[] }>(s.app.request(`${s.base}/locations`, authedJson(s.t.owner.token)));
    expect(lista.locations).toHaveLength(0);
    const ajena = "11111111-1111-4111-8111-111111111111";
    expect((await s.app.request(`${s.base}/locations/${ajena}`, send("PATCH", s.t.owner.token, { name: "Robada" }))).status).toBe(404);
    expect((await s.app.request(`${s.base}/locations/${ajena}`, send("DELETE", s.t.owner.token))).status).toBe(404);
    expect((await s.app.request(`${s.base}/locations/${ajena}/approve`, send("POST", s.t.owner.token))).status).toBe(404);
    expect(s.ctx.repo.companyProfile.list("location", ORG_B)).toHaveLength(1);
  });

  it("sin la migracion 040: lecturas vacias con disponible=false, escrituras 409 'no disponible aun', firmantes y mapeos siguen como antes", async () => {
    const s = await setup();
    s.ctx.repo.companyProfileAvailable = false;
    const profile = await s.json<{ disponible: boolean; profile: unknown; mipyme: unknown }>(s.app.request(`${s.base}/profile`, authedJson(s.t.viewer.token)));
    expect(profile).toMatchObject({ disponible: false, profile: null, mipyme: null });
    for (const seg of ["products-services", "locations", "restrictions", "stakeholders"]) {
      const lista = await s.json<{ disponible: boolean }>(s.app.request(`${s.base}/${seg}`, authedJson(s.t.viewer.token)));
      expect(lista.disponible, seg).toBe(false);
    }
    const put = await s.app.request(`${s.base}/profile`, send("PUT", s.t.writer.token, perfil));
    expect(put.status).toBe(409);
    expect(await put.text()).toMatch(/No disponible aún/);
    expect((await s.app.request(`${s.base}/locations`, send("POST", s.t.writer.token, { kind: "matriz", name: "M", state: "Y" }))).status).toBe(409);

    // El flujo que hoy funciona no se rompe: un firmante sin vigencia se crea como antes...
    const legado = await s.app.request(`${s.base}/signers`, send("POST", s.t.writer.token, { name: "Ana", role: "rep", authorized: true }));
    expect(legado.status).toBe(201);
    // ... y pedir vigencia (que no se puede guardar) es 409, no se descarta en silencio.
    expect((await s.app.request(`${s.base}/signers`, send("POST", s.t.writer.token, { name: "Beto", role: "rep", validFrom: "2026-01-01" }))).status).toBe(409);
    expect((await s.json<{ vigenciaDisponible: boolean }>(s.app.request(`${s.base}/signers`, authedJson(s.t.viewer.token)))).vigenciaDisponible).toBe(false);
    // Los mapeos hacia el perfil completo no se pueden guardar (el CHECK de la base aun no los admite); los de siempre si.
    const map = (kind: string) => s.app.request(`/licitaciones/${s.ctx.propertyId}/requirement-mappings/acta_constitutiva`, send("PUT", s.t.owner.token, { kind, refKey: "x", statementTemplate: "{value}" }));
    expect((await map("stakeholders")).status).toBe(409);
    expect((await map("document")).status).toBe(200);
  });
});
