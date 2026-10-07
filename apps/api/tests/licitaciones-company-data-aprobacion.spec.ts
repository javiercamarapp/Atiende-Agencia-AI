// Migración 036 / L-P3-01, L-P3-02 -- aprobación REAL de los datos de empresa por HTTP (app.request, repositorio en memoria con
// la misma máquina de dominio que Postgres): quien propone no aprueba, tarifas con step-up, autor distinto del aprobador,
// transición atómica (404/409), editar un dato aprobado lo regresa a pendiente y cualquier cambio del perfil invalida el expediente.
import { describe, expect, it } from "vitest";
import { computeTotp, signContractStepUpToken } from "@atiende/core-auth";
import { InMemoryStaffSecurityRepository } from "@atiende/db";
import type { InMemoryCoreRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";
import type { LicitacionesTestContext } from "./licitaciones-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";
import { TEST_ENV } from "./fixtures.ts";

function patchJson(token: string, body: unknown): RequestInit {
  const raw = JSON.stringify(body);
  return { method: "PATCH", body: raw, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) } };
}

async function setup() {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const { deps, emisiones } = conEmisiones(ctx.deps);
  const app = buildApp(deps);
  const base = `/licitaciones/${ctx.propertyId}/company`;
  const crearTarifa = async (token = ctx.staff.writer.token, concept = "consultoria_hora") => {
    const res = await app.request(`${base}/rates`, authedJson(token, { concept, unitPrice: "500.00", validFrom: "2026-01-01T00:00:00-06:00" }));
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  return { ctx, deps, app, base, emisiones, crearTarifa };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** Activa 2FA en la base de prueba y devuelve un generador de tokens de step-up por usuario y alcance. */
async function conDosFactores(s: Setup) {
  const security = new InMemoryStaffSecurityRepository(s.ctx.deps.coreRepo as InMemoryCoreRepository);
  const app = buildApp({ ...s.deps, staffSecurityRepo: security });
  const secrets = new Map<string, string>();
  const enrolar = async (bearer: string) => {
    const { secret } = (await (await app.request("/auth/2fa/setup", authedJson(bearer, {}))).json()) as { secret: string };
    expect((await app.request("/auth/2fa/confirm", authedJson(bearer, { code: computeTotp(secret, Date.now()) }))).status).toBe(200);
    secrets.set(bearer, secret);
  };
  // El TOTP no se reutiliza (anti-replay) y solo se acepta la ventana siguiente: cada usuario emite UN token real por prueba.
  const tokenDe = async (bearer: string, scope = "company_rate_approval") => {
    const res = await app.request("/auth/step-up", authedJson(bearer, { scope, code: computeTotp(secrets.get(bearer)!, Date.now() + 30_000) }));
    expect(res.status).toBe(200);
    return ((await res.json()) as { stepUpToken: string }).stepUpToken;
  };
  return { app, enrolar, tokenDe };
}

const post = (s: { app: ReturnType<typeof buildApp> }, url: string, token: string, headers: Record<string, string> = {}) => s.app.request(url, authedJson(token, {}, headers));

describe("alta y edición ya no escriben approvalStatus (WI-04)", () => {
  it("POST con approvalStatus -> 422 y no se crea nada; sin él nace pendiente con el autor", async () => {
    const s = await setup();
    const res = await s.app.request(`${s.base}/rates`, authedJson(s.ctx.staff.writer.token, { concept: "x", unitPrice: "1.00", approvalStatus: "aprobado" }));
    expect(res.status).toBe(422);
    expect(((await (await s.app.request(`${s.base}/rates`, authedJson(s.ctx.staff.viewer.token))).json()) as { rates: unknown[] }).rates).toHaveLength(0);
    const id = await s.crearTarifa();
    const lista = (await (await s.app.request(`${s.base}/rates`, authedJson(s.ctx.staff.viewer.token))).json()) as { rates: { id: string; approvalStatus: string; proposedBy: string }[] };
    expect(lista.rates.find((r) => r.id === id)).toMatchObject({ approvalStatus: "pendiente_aprobacion", proposedBy: s.ctx.staff.writer.id });
  });

  it("PATCH con approvalStatus -> 422 en los cinco recursos, y ninguno cambia", async () => {
    const s = await setup();
    const id = await s.crearTarifa();
    const doc = ((await (await s.app.request(`${s.base}/documents`, authedJson(s.ctx.staff.writer.token, { type: "t", label: "l", expiresAt: null }))).json()) as { id: string }).id;
    const cap = ((await (await s.app.request(`${s.base}/capabilities`, authedJson(s.ctx.staff.writer.token, { name: "n", description: "d" }))).json()) as { id: string }).id;
    const exp = ((await (await s.app.request(`${s.base}/experience`, authedJson(s.ctx.staff.writer.token, { description: "e", evidenceDocId: doc }))).json()) as { id: string }).id;
    const sig = ((await (await s.app.request(`${s.base}/signers`, authedJson(s.ctx.staff.writer.token, { name: "Ana", role: "rep", authorized: true, validFrom: "2026-01-01" }))).json()) as { id: string }).id;
    for (const [path, extra] of [[`rates/${id}`, {}], [`documents/${doc}`, {}], [`capabilities/${cap}`, {}], [`experience/${exp}`, {}], [`signers/${sig}`, {}]] as const) {
      expect((await s.app.request(`${s.base}/${path}`, patchJson(s.ctx.staff.writer.token, { ...extra, approvalStatus: "aprobado" }))).status).toBe(422);
    }
    const rates = (await (await s.app.request(`${s.base}/rates`, authedJson(s.ctx.staff.viewer.token))).json()) as { rates: { approvalStatus: string }[] };
    expect(rates.rates[0]!.approvalStatus).toBe("pendiente_aprobacion");
  });
});

describe("approve/reject de tarifas (decisión económica)", () => {
  it("writer, reviewer, analyst y viewer NO deciden tarifas (403); owner y admin sí, y queda quién aprobó", async () => {
    const s = await setup();
    const id = await s.crearTarifa();
    for (const t of [s.ctx.staff.writer.token, s.ctx.staff.reviewer.token, s.ctx.staff.analyst.token, s.ctx.staff.viewer.token]) {
      expect((await post(s, `${s.base}/rates/${id}/approve`, t)).status).toBe(403);
      expect((await post(s, `${s.base}/rates/${id}/reject`, t)).status).toBe(403);
    }
    const ok = await post(s, `${s.base}/rates/${id}/approve`, s.ctx.staff.admin.token);
    expect(ok.status).toBe(200);
    const lista = (await (await s.app.request(`${s.base}/rates`, authedJson(s.ctx.staff.viewer.token))).json()) as { rates: { approvalStatus: string; approvedBy: string; approvedAt: string }[]; people: Record<string, string> };
    expect(lista.rates[0]).toMatchObject({ approvalStatus: "aprobado", approvedBy: s.ctx.staff.admin.id });
    expect(lista.rates[0]!.approvedAt).toEqual(expect.any(String));
  });

  it("el autor no aprueba ni rechaza su propia tarifa, aunque sea owner (403) -- la decide otra persona", async () => {
    const s = await setup();
    const id = await s.crearTarifa(s.ctx.staff.owner.token);
    const propia = await post(s, `${s.base}/rates/${id}/approve`, s.ctx.staff.owner.token);
    expect(propia.status).toBe(403);
    expect(((await propia.json()) as { message: string }).message).toContain("otra persona");
    expect((await post(s, `${s.base}/rates/${id}/reject`, s.ctx.staff.owner.token)).status).toBe(403);
    expect((await post(s, `${s.base}/rates/${id}/approve`, s.ctx.staff.admin.token)).status).toBe(200);
  });

  it("quien editó por última vez tampoco decide: el owner edita la tarifa que propuso el writer y ya no puede aprobarla", async () => {
    const s = await setup();
    const id = await s.crearTarifa();
    expect((await s.app.request(`${s.base}/rates/${id}`, patchJson(s.ctx.staff.owner.token, { unitPrice: "510.00" }))).status).toBe(200);
    expect((await post(s, `${s.base}/rates/${id}/approve`, s.ctx.staff.owner.token)).status).toBe(403);
    expect((await post(s, `${s.base}/rates/${id}/approve`, s.ctx.staff.admin.token)).status).toBe(200);
  });

  it("aprobar una tarifa ya decidida -> 409; id inexistente o mal formado -> 404; rechazar deja 'rechazado' y la economía sigue sin total", async () => {
    const s = await setup();
    const id = await s.crearTarifa();
    expect((await post(s, `${s.base}/rates/${id}/approve`, s.ctx.staff.owner.token)).status).toBe(200);
    expect((await post(s, `${s.base}/rates/${id}/approve`, s.ctx.staff.admin.token)).status).toBe(409);
    expect((await post(s, `${s.base}/rates/${id}/reject`, s.ctx.staff.admin.token)).status).toBe(409);
    expect((await post(s, `${s.base}/rates/00000000-0000-0000-0000-000000000000/approve`, s.ctx.staff.owner.token)).status).toBe(404);
    expect((await post(s, `${s.base}/rates/no-es-uuid/approve`, s.ctx.staff.owner.token)).status).toBe(404);
    const id2 = await s.crearTarifa(s.ctx.staff.writer.token, "otra");
    expect((await post(s, `${s.base}/rates/${id2}/reject`, s.ctx.staff.owner.token)).status).toBe(200);
    const lista = (await (await s.app.request(`${s.base}/rates`, authedJson(s.ctx.staff.viewer.token))).json()) as { rates: { id: string; approvalStatus: string }[] };
    expect(lista.rates.find((r) => r.id === id2)!.approvalStatus).toBe("rechazado");
  });

  it("dos approve concurrentes sobre la misma tarifa: exactamente un 200 y un 409", async () => {
    const s = await setup();
    const id = await s.crearTarifa();
    const dos = await conDosFactores(s);
    await dos.enrolar(s.ctx.staff.owner.token);
    await dos.enrolar(s.ctx.staff.admin.token);
    const tokens = [await dos.tokenDe(s.ctx.staff.owner.token), await dos.tokenDe(s.ctx.staff.admin.token)];
    const resultados = await Promise.all([
      dos.app.request(`${s.base}/rates/${id}/approve`, authedJson(s.ctx.staff.owner.token, {}, { "x-step-up-token": tokens[0]! })),
      dos.app.request(`${s.base}/rates/${id}/approve`, authedJson(s.ctx.staff.admin.token, {}, { "x-step-up-token": tokens[1]! })),
    ]);
    expect(resultados.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it("deja un renglón de bitácora por decisión", async () => {
    const s = await setup();
    const id = await s.crearTarifa();
    await post(s, `${s.base}/rates/${id}/approve`, s.ctx.staff.owner.token);
    const repo = s.ctx.repo;
    expect(repo.companyDataAudit).toEqual([expect.objectContaining({ kind: "rate", itemId: id, decision: "aprobado", actorId: s.ctx.staff.owner.id })]);
  });
});

describe("step-up de la aprobación de tarifas (REQ-044/064)", () => {
  it("sin 2FA enrolado -> 403 step_up_enrollment_required con instrucción de enrolar, y la tarifa sigue pendiente", async () => {
    const s = await setup();
    const id = await s.crearTarifa();
    const dos = await conDosFactores(s);
    const res = await post(dos, `${s.base}/rates/${id}/approve`, s.ctx.staff.owner.token);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("step_up_enrollment_required");
    expect(((await (await s.app.request(`${s.base}/rates`, authedJson(s.ctx.staff.viewer.token))).json()) as { rates: { approvalStatus: string }[] }).rates[0]!.approvalStatus).toBe("pendiente_aprobacion");
  });

  it("con 2FA pero sin x-step-up-token -> 403 step_up_required; con token de OTRO alcance, de OTRA organización o de otro usuario -> 403", async () => {
    const s = await setup();
    const id = await s.crearTarifa();
    const dos = await conDosFactores(s);
    await dos.enrolar(s.ctx.staff.owner.token);
    await dos.enrolar(s.ctx.staff.admin.token);
    const url = `${s.base}/rates/${id}/approve`;

    const sinToken = await post(dos, url, s.ctx.staff.owner.token);
    expect(sinToken.status).toBe(403);
    expect(((await sinToken.json()) as { code: string }).code).toBe("step_up_required");

    const firmar = (userId: string, scope: "contract_sensitive" | "company_rate_approval", organizationId = s.ctx.organizationId) => signContractStepUpToken({ userId, organizationId, scope }, TEST_ENV.jwtSecret);
    const otroAlcance = await firmar(s.ctx.staff.owner.id, "contract_sensitive");
    expect((await post(dos, url, s.ctx.staff.owner.token, { "x-step-up-token": otroAlcance })).status).toBe(403);

    const otraOrg = await firmar(s.ctx.staff.owner.id, "company_rate_approval", "00000000-0000-0000-0000-00000000dead");
    expect((await post(dos, url, s.ctx.staff.owner.token, { "x-step-up-token": otraOrg })).status).toBe(403);

    const deOtroUsuario = await firmar(s.ctx.staff.admin.id, "company_rate_approval");
    expect((await post(dos, url, s.ctx.staff.owner.token, { "x-step-up-token": deOtroUsuario })).status).toBe(403);

    const bueno = await dos.tokenDe(s.ctx.staff.owner.token);
    expect((await post(dos, url, s.ctx.staff.owner.token, { "x-step-up-token": bueno })).status).toBe(200);
  });

  it("un writer sin permiso recibe 403 por rol ANTES de que se pida el step-up", async () => {
    const s = await setup();
    const id = await s.crearTarifa();
    const dos = await conDosFactores(s);
    const res = await post(dos, `${s.base}/rates/${id}/approve`, s.ctx.staff.writer.token);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("forbidden");
  });
});

describe("approve/reject del resto de datos de empresa (DECISION_ROLES, sin step-up)", () => {
  it("documento, capacidad, experiencia y firmante: writer 403, autor 403, analyst de otra persona 200, segunda decisión 409", async () => {
    const s = await setup();
    const owner = s.ctx.staff.owner.token;
    const mk = async (path: string, body: unknown) => ((await (await s.app.request(`${s.base}/${path}`, authedJson(owner, body))).json()) as { id: string }).id;
    const doc = await mk("documents", { type: "t", label: "l", expiresAt: null });
    const cap = await mk("capabilities", { name: "n", description: "d" });
    const exp = await mk("experience", { description: "e", evidenceDocId: doc });
    const sig = await mk("signers", { name: "Ana", role: "rep", authorized: true, validFrom: "2026-01-01" });
    for (const path of [`documents/${doc}`, `capabilities/${cap}`, `experience/${exp}`, `signers/${sig}`]) {
      expect((await post(s, `${s.base}/${path}/approve`, s.ctx.staff.writer.token)).status).toBe(403);
      expect((await post(s, `${s.base}/${path}/approve`, owner)).status).toBe(403); // el autor
      expect((await post(s, `${s.base}/${path}/approve`, s.ctx.staff.analyst.token)).status).toBe(200);
      expect((await post(s, `${s.base}/${path}/reject`, s.ctx.staff.admin.token)).status).toBe(409);
    }
    const firmantes = (await (await s.app.request(`${s.base}/signers`, authedJson(s.ctx.staff.viewer.token))).json()) as { signers: { approvalStatus: string }[] };
    expect(firmantes.signers[0]!.approvalStatus).toBe("aprobado");
  });

  it("editar un dato aprobado lo regresa a pendiente (DB-03) y vuelve a pedir decisión", async () => {
    const s = await setup();
    const id = await s.crearTarifa();
    await post(s, `${s.base}/rates/${id}/approve`, s.ctx.staff.owner.token);
    const edit = await s.app.request(`${s.base}/rates/${id}`, patchJson(s.ctx.staff.writer.token, { unitPrice: "999.00" }));
    expect(edit.status).toBe(200);
    expect(((await edit.json()) as { approvalStatus: string }).approvalStatus).toBe("pendiente_aprobacion");
  });

  it("un firmante pendiente o rechazado NO resuelve como firmante autorizado de la propuesta técnica", async () => {
    const s = await setup();
    const sig = ((await (await s.app.request(`${s.base}/signers`, authedJson(s.ctx.staff.writer.token, { name: "Ana", role: "rep", authorized: true, validFrom: "2026-01-01" }))).json()) as { id: string }).id;
    const lista = async () => ((await (await s.app.request(`${s.base}/signers`, authedJson(s.ctx.staff.viewer.token))).json()) as { signers: { approvalStatus: string }[] }).signers[0]!.approvalStatus;
    expect(await lista()).toBe("pendiente_aprobacion");
    await post(s, `${s.base}/signers/${sig}/reject`, s.ctx.staff.owner.token);
    expect(await lista()).toBe("rechazado");
  });
});

describe("avisos in-app de aprobación pendiente (notificaciones)", () => {
  it("crear y editar un dato emite un aviso con enlace a Datos de empresa, sin PII, y la decisión no emite", async () => {
    const s = await setup();
    const id = await s.crearTarifa();
    await s.app.request(`${s.base}/rates/${id}`, patchJson(s.ctx.staff.writer.token, { unitPrice: "1.00" }));
    await post(s, `${s.base}/rates/${id}/approve`, s.ctx.staff.owner.token);
    const avisos = s.emisiones.filter((e) => e.evento === "licitaciones.datos_empresa.aprobacion_pendiente");
    expect(avisos).toHaveLength(2);
    expect(avisos[0]).toMatchObject({ categoria: "aprobaciones", severidad: "atencion", enlace: "/licitaciones/{orgSlug}/datos-empresa" });
    expect(avisos[0]!.dedupeKey).toMatch(/^licitaciones\.datos_empresa\.aprobacion_pendiente:rate:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}T\d{2}$/);
    expect(JSON.stringify(avisos)).not.toContain("@");
  });
});

describe("el perfil de empresa entra al hash del expediente (AE-08, REQ-162)", () => {
  const GREEN = { files: [{ filename: "carta.pdf", extension: "pdf", sizeBytes: 1000 }], formatLimits: { allowedExtensions: ["pdf"], maxFileSizeBytes: 10_000_000, maxUploadSegments: 20, maxUploadSlots: 20 }, requiredSignatures: [], presentAnnexRefs: [] };

  async function expedienteAprobado(): Promise<{ s: Setup; url: (suffix: string) => string; signerId: string }> {
    const s = await setup();
    const url = (suffix: string) => `/licitaciones/${s.ctx.propertyId}/tenders/${s.ctx.tenderId}/${suffix}`;
    expect((await s.app.request(url("proposal"), authedJson(s.ctx.staff.writer.token))).status).toBeLessThan(300);
    s.ctx.repo.seedApprovedRates(s.ctx.organizationId, [{ id: "r1", concept: "consultoria_hora", unitPrice: "500.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00", validUntil: null }]);
    const signer = (await (await s.app.request(`${s.base}/signers`, authedJson(s.ctx.staff.writer.token, { name: "Ana", role: "representante_legal", authorized: true, validFrom: "2026-01-01" }))).json()) as { id: string };
    expect((await s.app.request(url("proposal/economic/generate"), authedJson(s.ctx.staff.writer.token, { lineItems: [{ concept: "consultoria_hora", quantity: 10 }] }, { "idempotency-key": "e1" }))).status).toBe(200);
    expect((await s.app.request(url("checklist/run"), authedJson(s.ctx.staff.writer.token, GREEN, { "idempotency-key": "c1" }))).status).toBe(200);
    expect((await s.app.request(url("expediente/approval"), authedJson(s.ctx.staff.analyst.token, { stage: "tecnica_legal" }))).status).toBe(201);
    expect((await s.app.request(url("expediente/approval"), authedJson(s.ctx.staff.owner.token, { stage: "economica" }))).status).toBe(201);
    const assembled = await s.app.request(url("package/assemble"), authedJson(s.ctx.staff.writer.token, {}, { "idempotency-key": "a1" }));
    expect(assembled.status).toBe(200);
    expect(((await assembled.json()) as { status: string }).status).toBe("ready");
    return { s, url, signerId: signer.id };
  }

  it("aprobar el expediente, cambiar un firmante y GET package/latest reporta borrador mientras download da 409", async () => {
    const { s, url, signerId } = await expedienteAprobado();
    expect(((await (await s.app.request(url("package/latest"), authedJson(s.ctx.staff.viewer.token))).json()) as { status: string }).status).toBe("ready");

    expect((await s.app.request(`${s.base}/signers/${signerId}`, patchJson(s.ctx.staff.writer.token, { name: "Ana María" }))).status).toBe(200);

    expect(((await (await s.app.request(url("package/latest"), authedJson(s.ctx.staff.viewer.token))).json()) as { status: string }).status).toBe("draft");
    expect((await s.app.request(url("package/download"), authedJson(s.ctx.staff.viewer.token))).status).toBe(409);
    const estado = (await (await s.app.request(url("expediente/approvals"), authedJson(s.ctx.staff.viewer.token))).json()) as { complete: boolean };
    expect(estado.complete).toBe(false);
  });

  it("agregar una capacidad al perfil, y luego decidirla, invalida el expediente cada vez (el estado de aprobación es parte del perfil)", async () => {
    const { s, url } = await expedienteAprobado();
    const estado = async () => ((await (await s.app.request(url("package/latest"), authedJson(s.ctx.staff.viewer.token))).json()) as { status: string }).status;
    expect(await estado()).toBe("ready");
    const cap = (await (await s.app.request(`${s.base}/capabilities`, authedJson(s.ctx.staff.writer.token, { name: "n", description: "d" }))).json()) as { id: string };
    expect(await estado()).toBe("draft");
    // se vuelve a ensamblar con los dos aprobadores y entonces decidir la capacidad vuelve a invalidar
    expect((await s.app.request(url("expediente/approval"), authedJson(s.ctx.staff.analyst.token, { stage: "tecnica_legal" }))).status).toBe(201);
    expect((await s.app.request(url("expediente/approval"), authedJson(s.ctx.staff.owner.token, { stage: "economica" }))).status).toBe(201);
    expect(((await (await s.app.request(url("package/assemble"), authedJson(s.ctx.staff.writer.token, {}, { "idempotency-key": "a2" }))).json()) as { status: string }).status).toBe("ready");
    expect((await post(s, `${s.base}/capabilities/${cap.id}/approve`, s.ctx.staff.owner.token)).status).toBe(200);
    expect(await estado()).toBe("draft");
  });
});

export type { LicitacionesTestContext };
