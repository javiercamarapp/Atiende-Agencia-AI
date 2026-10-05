// L-26 (REQ-044) -- doble aprobacion del expediente por HTTP real (app.request, repositorio en memoria
// con la misma maquina de dominio que Postgres): tecnico-legal (1/2) y economica (2/2) por DOS personas
// distintas, cada una con step-up TOTP cuando la base tiene 2FA; assemble 409 sin el 2/2; cualquier cambio
// de insumos invalida ambas etapas; avisos in-app; y compatibilidad con la base sin migrar.
import { describe, expect, it } from "vitest";
import { computeTotp } from "@atiende/core-auth";
import { InMemoryStaffSecurityRepository } from "@atiende/db";
import type { InMemoryCoreRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";
import type { LicitacionesTestContext } from "./licitaciones-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const GREEN_CHECKLIST_BODY = {
  files: [{ filename: "carta.pdf", extension: "pdf", sizeBytes: 1000 }],
  formatLimits: { allowedExtensions: ["pdf"], maxFileSizeBytes: 10_000_000, maxUploadSlots: 20 },
  requiredSignatures: [],
  presentAnnexRefs: [],
};

const RATE = (price: string) => [{ id: "r1", concept: "consultoria_hora", unitPrice: price, currency: "MXN" as const, approvalStatus: "aprobado" as const, validFrom: "2026-01-01T00:00:00-06:00", validUntil: null }];

async function setup() {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const { deps, emisiones } = conEmisiones(ctx.deps);
  const app = buildApp(deps);
  const url = (suffix: string) => `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/${suffix}`;
  // La propuesta (expediente) existe antes de cualquier aprobacion.
  expect((await app.request(url("proposal"), authedJson(ctx.staff.writer.token))).status).toBeLessThan(300);
  return { ctx, app, url, emisiones, deps };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** Deja listo todo menos la aprobacion: tarifa, propuesta economica (la redacta el writer) y checklist verde. */
async function prepararExpediente({ ctx, app, url }: Setup) {
  ctx.repo.seedApprovedRates(ctx.organizationId, RATE("500.00"));
  const eco = await app.request(url("proposal/economic/generate"), authedJson(ctx.staff.writer.token, { lineItems: [{ concept: "consultoria_hora", quantity: 10 }] }, { "idempotency-key": "econ-1" }));
  expect(eco.status).toBe(200);
  const chk = await app.request(url("checklist/run"), authedJson(ctx.staff.writer.token, GREEN_CHECKLIST_BODY, { "idempotency-key": "checklist-1" }));
  expect(chk.status).toBe(200);
}

const approve = (s: Setup, token: string, stage?: string, headers: Record<string, string> = {}) =>
  s.app.request(s.url("expediente/approval"), authedJson(token, stage === undefined ? {} : { stage }, headers));
const assemble = (s: Setup, key: string) => s.app.request(s.url("package/assemble"), authedJson(s.ctx.staff.writer.token, {}, { "idempotency-key": key }));
const estado = async (s: Setup, token: string) => (await (await s.app.request(s.url("expediente/approvals"), authedJson(token))).json()) as { mode: string; complete: boolean; missing: string[]; stages: { stage: string; approval: { approvedByRole: string; byYou: boolean; id: string } | null }[] };

describe("POST .../expediente/approval con etapa (L-26)", () => {
  it("exige la etapa: sin ella 400; con una etapa desconocida 400", async () => {
    const s = await setup();
    expect((await approve(s, s.ctx.staff.analyst.token)).status).toBe(400);
    expect((await approve(s, s.ctx.staff.analyst.token, "final")).status).toBe(400);
  });

  it("la economica sin la tecnico-legal -> 409 (conflicto de estado, no permiso)", async () => {
    const s = await setup();
    const res = await approve(s, s.ctx.staff.owner.token, "economica");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("técnico-legal (1/2)");
  });

  it("la MISMA persona no puede dar las dos etapas -> 403, en ningun orden", async () => {
    const s = await setup();
    expect((await approve(s, s.ctx.staff.analyst.token, "tecnica_legal")).status).toBe(201);
    const mismo = await approve(s, s.ctx.staff.analyst.token, "economica");
    expect(mismo.status).toBe(403);
    expect(((await mismo.json()) as { message: string }).message).toContain("dos personas distintas");
    // otra persona da la economica; el analyst ya no puede re-dar la tecnico-legal
    expect((await approve(s, s.ctx.staff.owner.token, "economica")).status).toBe(201);
    expect((await approve(s, s.ctx.staff.owner.token, "tecnica_legal")).status).toBe(403);
    expect((await estado(s, s.ctx.staff.viewer.token)).complete).toBe(true);
  });

  it("solo DECISION_ROLES aprueban: writer/reviewer/viewer -> 403 antes de cualquier regla de etapa", async () => {
    const s = await setup();
    for (const t of [s.ctx.staff.writer.token, s.ctx.staff.reviewer.token, s.ctx.staff.viewer.token]) {
      expect((await approve(s, t, "tecnica_legal")).status).toBe(403);
    }
  });

  it("AE-11 sigue vigente: quien redacto contenido (el writer es autor; un analyst que redacta) no aprueba ninguna etapa", async () => {
    const s = await setup();
    s.ctx.repo.seedApprovedRates(s.ctx.organizationId, RATE("500.00"));
    await s.app.request(s.url("proposal/economic/generate"), authedJson(s.ctx.staff.analyst.token, { lineItems: [{ concept: "consultoria_hora", quantity: 10 }] }, { "idempotency-key": "econ-a" }));
    expect((await approve(s, s.ctx.staff.analyst.token, "tecnica_legal")).status).toBe(403);
    expect((await approve(s, s.ctx.staff.owner.token, "tecnica_legal")).status).toBe(201);
  });

  it("la respuesta no acepta un hash propuesto por el cliente: se aprueba el hash VIVO", async () => {
    const s = await setup();
    const res = await s.app.request(s.url("expediente/approval"), authedJson(s.ctx.staff.owner.token, { stage: "tecnica_legal", inputsHash: "0".repeat(64) }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { inputsHash: string; stage: string };
    expect(body.stage).toBe("tecnica_legal");
    expect(body.inputsHash).not.toBe("0".repeat(64));
  });
});

describe("GET .../expediente/approvals (L-26)", () => {
  it("estado inicial: ambas etapas pendientes; cualquier miembro (viewer) puede leer", async () => {
    const s = await setup();
    const e = await estado(s, s.ctx.staff.viewer.token);
    expect(e).toMatchObject({ mode: "doble", complete: false, missing: ["tecnica_legal", "economica"] });
    expect(e.stages.map((x) => x.approval)).toEqual([null, null]);
  });

  it("muestra quien (rol y 'tu') y no filtra ids ni correos de otras personas", async () => {
    const s = await setup();
    await approve(s, s.ctx.staff.analyst.token, "tecnica_legal");
    const visto = await estado(s, s.ctx.staff.owner.token);
    const tl = visto.stages.find((x) => x.stage === "tecnica_legal")!.approval!;
    expect(tl.approvedByRole).toBe("analyst");
    expect(tl.byYou).toBe(false);
    expect((await estado(s, s.ctx.staff.analyst.token)).stages[0]!.approval!.byYou).toBe(true);
    const crudo = JSON.stringify(visto);
    expect(crudo).not.toContain(s.ctx.staff.analyst.id);
    expect(crudo).not.toContain(s.ctx.staff.analyst.email);
  });

  it("requiere sesion (401) y es de la organizacion del token (otra organizacion no ve nada)", async () => {
    const s = await setup();
    expect((await s.app.request(s.url("expediente/approvals"))).status).toBe(401);
    const otra = await setup();
    const res = await s.app.request(s.url("expediente/approvals"), authedJson(otra.ctx.staff.owner.token));
    expect([403, 404]).toContain(res.status);
  });
});

describe("assemble exige el 2/2 y un cambio de insumos lo invalida (L-26)", () => {
  it("con solo la 1/2 -> 409 que nombra la economica; con el 2/2 -> 'ready'", async () => {
    const s = await setup();
    await prepararExpediente(s);
    await approve(s, s.ctx.staff.analyst.token, "tecnica_legal");
    const parcial = await assemble(s, "a-1");
    expect(parcial.status).toBe(409);
    expect(((await parcial.json()) as { message: string }).message).toContain("económica (2/2)");
    expect((await approve(s, s.ctx.staff.owner.token, "economica")).status).toBe(201);
    const ok = await assemble(s, "a-2");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: string }).status).toBe("ready");
  });

  it("L-P3-17: la traza con X-Correlation-Id une las dos aprobaciones y el manifiesto (el manifiesto guarda esa misma correlacion)", async () => {
    const s = await setup();
    await prepararExpediente(s);
    const corr = { "x-correlation-id": "traza-cierre-1" };
    expect((await approve(s, s.ctx.staff.analyst.token, "tecnica_legal", corr)).status).toBe(201);
    expect((await approve(s, s.ctx.staff.owner.token, "economica", corr)).status).toBe(201);
    const ok = await s.app.request(s.url("package/assemble"), authedJson(s.ctx.staff.writer.token, {}, { "idempotency-key": "t-1", ...corr }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-correlation-id")).toBe("traza-cierre-1");
    const traza = (await s.ctx.repo.listAuditoria(s.ctx.organizationId, { correlationId: "traza-cierre-1" }, { orden: "asc" })).items;
    expect(traza.map((f) => f.action)).toEqual(["expediente.etapa_aprobada", "expediente.etapa_aprobada", "paquete.manifiesto_generado"]);
    expect(traza.map((f) => f.actorId)).toEqual([s.ctx.staff.analyst.id, s.ctx.staff.owner.id, s.ctx.staff.writer.id]);
    expect(traza.every((f) => f.entityId === s.ctx.tenderId)).toBe(true);
    expect(traza[0]!.after).toMatchObject({ stage: "tecnica_legal" });
    expect(traza[2]!.after).toMatchObject({ status: "ready" });
    // sin header, la aprobacion hereda la correlacion de origen de la convocatoria (aqui no hay: usa la de la peticion, valida)
    const sinHeader = await s.app.request(s.url("package/assemble"), authedJson(s.ctx.staff.writer.token, {}, { "idempotency-key": "t-2" }));
    expect(sinHeader.headers.get("x-correlation-id")).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
  });

  it("cambiar un insumo (tarifa usada) invalida AMBAS etapas: el paquete ready deja de serlo, el estado vuelve a 'pendiente' y assemble da 409", async () => {
    const s = await setup();
    await prepararExpediente(s);
    await approve(s, s.ctx.staff.analyst.token, "tecnica_legal");
    await approve(s, s.ctx.staff.owner.token, "economica");
    expect(((await (await assemble(s, "b-1")).json()) as { status: string }).status).toBe("ready");

    s.ctx.repo.seedApprovedRates(s.ctx.organizationId, RATE("999.00"));
    const e = await estado(s, s.ctx.staff.viewer.token);
    expect(e).toMatchObject({ complete: false, missing: ["tecnica_legal", "economica"] });
    expect((await assemble(s, "b-2")).status).toBe(409);
    const latest = await s.app.request(s.url("package/latest"), authedJson(s.ctx.staff.viewer.token));
    expect(((await latest.json()) as { status: string }).status).toBe("draft");
    expect((await s.app.request(s.url("package/download"), authedJson(s.ctx.staff.viewer.token))).status).toBe(409);
  });
});

describe("avisos in-app del cierre (L-26/L-28)", () => {
  it("1/2 avisa 'aprobacion pendiente' y 2/2 avisa 'expediente aprobado', sin PII y con enlace a una ruta real", async () => {
    const s = await setup();
    await approve(s, s.ctx.staff.analyst.token, "tecnica_legal");
    await approve(s, s.ctx.staff.owner.token, "economica");
    const eventos = s.emisiones.map((e) => e.evento);
    expect(eventos).toEqual(["licitaciones.expediente.aprobacion_pendiente", "licitaciones.expediente.aprobado"]);
    expect(s.emisiones[0]).toMatchObject({ categoria: "aprobaciones", severidad: "atencion", enlace: "/licitaciones/{orgSlug}/convocatorias" });
    for (const e of s.emisiones) {
      expect(e.dedupeKey).toMatch(new RegExp(`^${e.evento}:[0-9a-f-]{36}:[0-9a-f]{12}$`));
      expect(JSON.stringify(e)).not.toContain("@");
    }
  });

  it("una aprobacion rechazada no avisa nada", async () => {
    const s = await setup();
    expect((await approve(s, s.ctx.staff.owner.token, "economica")).status).toBe(409);
    expect(s.emisiones).toEqual([]);
  });

  it("declarar la presentacion avisa una sola vez por propuesta; reintentar con la misma clave no vuelve a avisar", async () => {
    const s = await setup();
    const declarar = (key: string) => s.app.request(s.url("submission/declare"), authedJson(s.ctx.staff.writer.token, { submittedAt: "2026-10-01T10:00:00-06:00", notes: "Presentada en el portal" }, { "idempotency-key": key }));
    expect((await declarar("sub-1")).status).toBe(201);
    expect((await declarar("sub-1")).status).toBe(201);
    expect(s.emisiones.filter((e) => e.evento === "licitaciones.presentacion.declarada")).toHaveLength(1);
  });
});

describe("step-up TOTP en cada aprobacion (L-26)", () => {
  async function conDosFactores() {
    const s = await setup();
    const security = new InMemoryStaffSecurityRepository(s.ctx.deps.coreRepo as InMemoryCoreRepository);
    const app = buildApp({ ...s.deps, staffSecurityRepo: security });
    const con2fa: Setup = { ...s, app };
    const tokenDe = async (bearer: string): Promise<string> => {
      const setupRes = await app.request("/auth/2fa/setup", authedJson(bearer, {}));
      const { secret } = (await setupRes.json()) as { secret: string };
      expect((await app.request("/auth/2fa/confirm", authedJson(bearer, { code: computeTotp(secret, Date.now()) }))).status).toBe(200);
      const res = await app.request("/auth/step-up", authedJson(bearer, { scope: "expediente_approval", code: computeTotp(secret, Date.now() + 30_000) }));
      expect(res.status).toBe(200);
      return ((await res.json()) as { stepUpToken: string }).stepUpToken;
    };
    return { s: con2fa, security, tokenDe };
  }

  it("sin 2FA activo -> 403 step_up_enrollment_required y NO se aprueba nada", async () => {
    const { s } = await conDosFactores();
    const res = await approve(s, s.ctx.staff.analyst.token, "tecnica_legal");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("step_up_enrollment_required");
    expect((await estado(s, s.ctx.staff.viewer.token)).missing).toEqual(["tecnica_legal", "economica"]);
  });

  it("con 2FA pero sin token -> 403 step_up_required; con token valido -> 201; el token de otro usuario NO sirve", async () => {
    const { s, tokenDe } = await conDosFactores();
    const tokenAnalyst = await tokenDe(s.ctx.staff.analyst.token);
    const tokenOwner = await tokenDe(s.ctx.staff.owner.token);

    const sin = await approve(s, s.ctx.staff.analyst.token, "tecnica_legal");
    expect(sin.status).toBe(403);
    expect(((await sin.json()) as { code: string }).code).toBe("step_up_required");

    const ajeno = await approve(s, s.ctx.staff.analyst.token, "tecnica_legal", { "x-step-up-token": tokenOwner });
    expect(ajeno.status).toBe(403);
    expect(((await ajeno.json()) as { code: string }).code).toBe("step_up_required");

    expect((await approve(s, s.ctx.staff.analyst.token, "tecnica_legal", { "x-step-up-token": tokenAnalyst })).status).toBe(201);
    // UN SOLO USO: el mismo token ya no sirve para otra aprobacion, aunque sea del mismo usuario y alcance.
    const reuso = await approve(s, s.ctx.staff.analyst.token, "economica", { "x-step-up-token": tokenAnalyst });
    expect(reuso.status).toBe(403);
    expect(((await reuso.json()) as { code: string }).code).toBe("step_up_required");
    // la 2/2 exige SU propio step-up (el del analyst no vale para el owner)
    expect((await approve(s, s.ctx.staff.owner.token, "economica", { "x-step-up-token": tokenAnalyst })).status).toBe(403);
    expect((await approve(s, s.ctx.staff.owner.token, "economica", { "x-step-up-token": tokenOwner })).status).toBe(201);
    expect((await estado(s, s.ctx.staff.viewer.token)).complete).toBe(true);
  });

  it("un token de step-up del contrato NO sirve para aprobar el expediente (alcance distinto)", async () => {
    const { s, security } = await conDosFactores();
    void security;
    const setupRes = await s.app.request("/auth/2fa/setup", authedJson(s.ctx.staff.analyst.token, {}));
    const { secret } = (await setupRes.json()) as { secret: string };
    await s.app.request("/auth/2fa/confirm", authedJson(s.ctx.staff.analyst.token, { code: computeTotp(secret, Date.now()) }));
    const res = await s.app.request("/auth/step-up", authedJson(s.ctx.staff.analyst.token, { scope: "contract_sensitive", code: computeTotp(secret, Date.now() + 30_000) }));
    const token = ((await res.json()) as { stepUpToken: string }).stepUpToken;
    const aprobar = await approve(s, s.ctx.staff.analyst.token, "tecnica_legal", { "x-step-up-token": token });
    expect(aprobar.status).toBe(403);
    expect(((await aprobar.json()) as { code: string }).code).toBe("step_up_required");
  });

  it("COMPATIBILIDAD: 2FA con migracion pendiente -> las etapas siguen funcionando solo con el rol (nunca 500)", async () => {
    const { s, security } = await conDosFactores();
    security.available = false;
    expect((await approve(s, s.ctx.staff.analyst.token, "tecnica_legal")).status).toBe(201);
  });
});

describe("COMPATIBILIDAD con la base sin la migracion 033 (modo legacy)", () => {
  it("la aprobacion unica de siempre (cuerpo vacio) sigue aprobando; pedir una etapa -> 409 honesto; el estado lo declara", async () => {
    const s = await setup();
    s.ctx.repo.setExpedienteStageMode("legacy");
    const conEtapa = await approve(s, s.ctx.staff.owner.token, "tecnica_legal");
    expect(conEtapa.status).toBe(409);
    expect(((await conEtapa.json()) as { message: string }).message).toContain("migración 033");
    expect((await approve(s, s.ctx.staff.owner.token)).status).toBe(201);
    const e = await s.app.request(s.url("expediente/approvals"), authedJson(s.ctx.staff.viewer.token));
    const body = (await e.json()) as { mode: string; complete: boolean; singleApproval: { byYou: boolean } | null };
    expect(body).toMatchObject({ mode: "legacy", complete: true });
    expect(body.singleApproval!.byYou).toBe(false);
  });
});

describe("LicitacionesTestContext", () => {
  it("el fixture expone al analyst y al owner como personas distintas", async () => {
    const ctx: LicitacionesTestContext = await buildLicitacionesTestContext(buildApp);
    expect(ctx.staff.analyst.id).not.toBe(ctx.staff.owner.id);
  });
});
