// D-32 -- API de honorarios (igualas y prefacturas): roles, generacion idempotente, aprobacion, timbrado con PAC falso (una sola llamada concurrente,
// 503 honesto sin credencial, fallo con aviso), cancelacion con guardas, cross-tenant, base sin migrar y bitacora.
import { randomUUID } from "node:crypto";
import type { CfdiTimbrado, PacClient } from "@atiende/billing";
import { hashPassword } from "@atiende/db";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const FICHA = { rfc: "RRR010101RR1", tipoPersona: "moral" as const, razonSocial: "Receptor Uno SA de CV", regimenesFiscales: ["601"], cpFiscal: "64000", periodicidad: "mensual" as const, responsableId: null };
const U2 = "22222222-2222-4222-8222-222222222222";
const MSG_503 = "timbrado pendiente: falta credencial del PAC (D-20)";

class FakePacClient implements PacClient {
  timbrados = 0;
  cancelaciones: { id: string; motivo: string; folio?: string }[] = [];
  fallar: Error | null = null;
  retraso = 0;
  async timbrar(opts: Parameters<PacClient["timbrar"]>[0]): Promise<CfdiTimbrado> {
    this.timbrados += 1;
    if (this.retraso) await new Promise((r) => setTimeout(r, this.retraso));
    if (this.fallar) throw this.fallar;
    return { id: `pac-${this.timbrados}`, uuid: `aaaaaaaa-aaaa-4aaa-8aaa-${String(this.timbrados).padStart(12, "0")}`, urlPdf: "https://pac.example/f.pdf", urlXml: "https://pac.example/f.xml", urlVerificacion: null, total: opts.subtotal * 1.16 };
  }
  async cancelar(id: string, motivo: string, folio?: string): Promise<{ estado: string }> {
    this.cancelaciones.push({ id, motivo, folio });
    return { estado: "cancelado" };
  }
}

async function contexto(opciones: { pac?: PacClient | null; conFicha?: boolean } = {}) {
  const ctx = await buildDespachosTestContext(buildApp);
  if (opciones.conFicha !== false) await ctx.carteraRepo.guardarFicha(ctx.propertyId, FICHA);
  const { deps, emisiones } = conEmisiones({ ...ctx.deps, ...(opciones.pac === null ? {} : { pacClient: opciones.pac ?? new FakePacClient() }) });
  const app = buildApp(deps);
  const base = `/despachos/${ctx.propertyId}/honorarios`;
  const admin = ctx.staff.admin.token;
  const enviar = (token: string, metodo: string, ruta: string, cuerpo?: unknown) => {
    const init = authedJson(token, cuerpo ?? {});
    return app.request(`${base}${ruta}`, { ...init, method: metodo, ...(metodo === "GET" || metodo === "DELETE" ? { body: undefined } : {}) });
  };
  return { ctx, app, base, admin, enviar, emisiones, pac: deps.pacClient as FakePacClient | undefined };
}

const IGUALA = { concepto: "Iguala contable mensual", montoBaseCentavos: 100_000, diaEmision: 5 };
const mesActual = () => new Date().toISOString().slice(0, 7);

async function crearIguala(c: Awaited<ReturnType<typeof contexto>>, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await c.enviar(c.admin, "POST", "/igualas", { ...IGUALA, ...extra });
  expect(r.status).toBe(201);
  return ((await r.json()) as { igualaId: string }).igualaId;
}
async function generar(c: Awaited<ReturnType<typeof contexto>>, periodo = mesActual()) {
  const r = await c.enviar(c.admin, "POST", `/generar-prefacturas?periodo=${periodo}`);
  return { status: r.status, cuerpo: (await r.json()) as { generadas: number; yaExistian: number; omitidas: { motivo: string }[] } };
}
async function prefacturas(c: Awaited<ReturnType<typeof contexto>>, token = c.admin) {
  const r = await c.enviar(token, "GET", "/prefacturas");
  return (await r.json()) as { estado: string; pac: { configurado: boolean; mensaje: string | null }; prefacturas: { id: string; estado: string; uuid: string | null; totalCentavos: number; timbrable: { ok: boolean } }[] };
}
async function aprobada(c: Awaited<ReturnType<typeof contexto>>): Promise<string> {
  await crearIguala(c);
  await generar(c);
  const [p] = (await prefacturas(c)).prefacturas;
  expect((await c.enviar(c.admin, "POST", `/prefacturas/${p!.id}/aprobar`)).status).toBe(200);
  return p!.id;
}

describe("igualas: roles, validacion y CRUD", () => {
  it("solo admin escribe; contador, auditor y readonly ven y NO escriben", async () => {
    const c = await contexto();
    expect((await c.enviar(c.admin, "POST", "/igualas", IGUALA)).status).toBe(201);
    for (const rol of ["contador", "auditor", "readonly"] as const) {
      const t = c.ctx.staff[rol].token;
      expect((await c.enviar(t, "POST", "/igualas", IGUALA)).status, `${rol} crea`).toBe(403);
      expect((await c.enviar(t, "GET", "/igualas")).status, `${rol} ve`).toBe(200);
      expect((await c.enviar(t, "POST", "/generar-prefacturas")).status, `${rol} genera`).toBe(403);
    }
    const lista = (await (await c.enviar(c.ctx.staff.contador.token, "GET", "/igualas")).json()) as { estado: string; igualas: { concepto: string; claveSatEstado: string; tasaIvaBp: number }[] };
    expect(lista.estado).toBe("disponible");
    expect(lista.igualas).toMatchObject([{ concepto: "Iguala contable mensual", claveSatEstado: "por_verificar", tasaIvaBp: 1600 }]);
  });
  it("valida el cuerpo: un decimal de centavos, tasa fuera de catalogo o dia 29 se rechazan con un mensaje por campo", async () => {
    const c = await contexto();
    const r = await c.enviar(c.admin, "POST", "/igualas", { concepto: "ab", montoBaseCentavos: 10.5, tasaIvaBp: 1000, diaEmision: 29 });
    expect(r.status).toBe(400);
    const msg = ((await r.json()) as { message: string }).message;
    expect(msg).toMatch(/concepto/);
    expect(msg).toMatch(/montoBaseCentavos/);
    expect(msg).toMatch(/diaEmision/);
  });
  it("edita, desactiva y elimina; una iguala con prefacturas no se elimina (409)", async () => {
    const c = await contexto();
    const id = await crearIguala(c);
    expect((await c.enviar(c.admin, "PUT", `/igualas/${id}`, { ...IGUALA, montoBaseCentavos: 250_000, activa: false })).status).toBe(200);
    const [i] = ((await (await c.enviar(c.admin, "GET", "/igualas")).json()) as { igualas: { montoBaseCentavos: number; activa: boolean }[] }).igualas;
    expect(i).toMatchObject({ montoBaseCentavos: 250_000, activa: false });
    expect((await c.enviar(c.admin, "PUT", `/igualas/${randomUUID()}`, IGUALA)).status).toBe(404);
    expect((await c.enviar(c.admin, "PUT", "/igualas/no-es-uuid", IGUALA)).status).toBe(404);
    const otra = await crearIguala(c, { concepto: "Otra iguala" });
    await generar(c);
    expect((await c.enviar(c.admin, "DELETE", `/igualas/${otra}`)).status).toBe(409);
    expect((await c.enviar(c.admin, "DELETE", `/igualas/${id}`)).status).toBe(200);
  });
});

describe("generar prefacturas", () => {
  it("genera una por iguala activa, avisa UNA vez (sin PII) y generar dos veces no duplica ni repite el aviso", async () => {
    const c = await contexto();
    await crearIguala(c);
    await crearIguala(c, { concepto: "Iguala pausada", activa: false });
    const primera = await generar(c);
    expect(primera).toMatchObject({ status: 201, cuerpo: { generadas: 1, yaExistian: 0, omitidas: [] } });
    const segunda = await generar(c);
    expect(segunda).toMatchObject({ status: 200, cuerpo: { generadas: 0, yaExistian: 1 } });
    expect((await prefacturas(c)).prefacturas).toHaveLength(1);
    expect(c.emisiones).toHaveLength(1);
    expect(c.emisiones[0]).toMatchObject({
      evento: "despachos.honorarios.prefacturas_listas",
      organizationId: c.ctx.organizationId,
      propertyId: c.ctx.propertyId,
      categoria: "aprobaciones",
      severidad: "atencion",
      cuerpo: "Prefacturas nuevas del periodo: 1.",
      enlace: "/despachos/{orgSlug}/honorarios",
      dedupeKey: `despachos.honorarios.prefacturas_listas:${c.ctx.propertyId}:${mesActual()}`,
      roles: ["contador"],
    });
    expect(JSON.stringify(c.emisiones[0])).not.toMatch(/RRR010101RR1|Receptor Uno/);
  });
  it("cliente sin ficha fiscal: no genera, lo dice con su motivo y no avisa", async () => {
    const c = await contexto({ conFicha: false });
    await crearIguala(c);
    const r = await generar(c);
    expect(r.cuerpo.generadas).toBe(0);
    expect(r.cuerpo.omitidas[0]!.motivo).toMatch(/ficha fiscal/);
    expect(c.emisiones).toHaveLength(0);
  });
  it("periodo mal formado o futuro se rechaza", async () => {
    const c = await contexto();
    await crearIguala(c);
    expect((await c.enviar(c.admin, "POST", "/generar-prefacturas?periodo=2026-13")).status).toBe(400);
    expect((await c.enviar(c.admin, "POST", "/generar-prefacturas?periodo=2099-01")).status).toBe(400);
  });
  it("el estado del PAC en la lista es honesto: sin credencial dice que el timbrado esta pendiente", async () => {
    const c = await contexto({ pac: null });
    expect((await prefacturas(c)).pac).toEqual({ configurado: false, mensaje: MSG_503 });
    const con = await contexto();
    expect((await prefacturas(con)).pac).toEqual({ configurado: true, mensaje: null });
  });
});

describe("aprobar y timbrar", () => {
  it("aprobar pasa borrador -> aprobada una sola vez (la segunda es 409)", async () => {
    const c = await contexto();
    await crearIguala(c);
    await generar(c);
    const [p] = (await prefacturas(c)).prefacturas;
    expect(p).toMatchObject({ estado: "borrador", totalCentavos: 116_000 });
    expect((await c.enviar(c.admin, "POST", `/prefacturas/${p!.id}/aprobar`)).status).toBe(200);
    expect((await c.enviar(c.admin, "POST", `/prefacturas/${p!.id}/aprobar`)).status).toBe(409);
  });
  it("un borrador no se timbra", async () => {
    const c = await contexto();
    await crearIguala(c);
    await generar(c);
    const [p] = (await prefacturas(c)).prefacturas;
    expect((await c.enviar(c.admin, "POST", `/prefacturas/${p!.id}/timbrar`)).status).toBe(409);
    expect(c.pac!.timbrados).toBe(0);
  });
  it("SIN PAC configurado: 503 honesto, la prefactura sigue aprobada y NUNCA lleva UUID", async () => {
    const c = await contexto({ pac: null });
    const id = await aprobada(c);
    const r = await c.enviar(c.admin, "POST", `/prefacturas/${id}/timbrar`);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { message: string }).message).toBe(MSG_503);
    expect((await prefacturas(c)).prefacturas[0]).toMatchObject({ estado: "aprobada", uuid: null });
    expect(c.emisiones).toHaveLength(1); // solo el aviso de "prefacturas listas": un 503 sin credencial no es un fallo de timbrado
  });
  it("con PAC: timbra, guarda el UUID del PAC y deja bitacora; timbrar de nuevo es idempotente (no vuelve a llamar al PAC)", async () => {
    const c = await contexto();
    const id = await aprobada(c);
    const r = await c.enviar(c.admin, "POST", `/prefacturas/${id}/timbrar`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ yaTimbrada: false, advertencias: [], prefactura: { estado: "timbrada", uuid: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", urlPdf: "https://pac.example/f.pdf" } });
    expect(await (await c.enviar(c.admin, "POST", `/prefacturas/${id}/timbrar`)).json()).toMatchObject({ yaTimbrada: true });
    expect(c.pac!.timbrados).toBe(1);
    expect(c.ctx.auditSink.entries.map((e) => e.action)).toEqual(expect.arrayContaining(["despachos.honorarios.iguala:crear", "despachos.honorarios.prefacturas:generar", "despachos.honorarios.prefactura:aprobar", "despachos.honorarios.prefactura:timbrar"]));
  });
  it("dos 'timbrar' CONCURRENTES solo llaman una vez al PAC: una responde 200 y la otra 409", async () => {
    const c = await contexto();
    c.pac!.retraso = 25;
    const id = await aprobada(c);
    const [a, b] = await Promise.all([c.enviar(c.admin, "POST", `/prefacturas/${id}/timbrar`), c.enviar(c.admin, "POST", `/prefacturas/${id}/timbrar`)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(c.pac!.timbrados).toBe(1);
  });
  it("si el PAC falla: 502, la prefactura queda fallida con un codigo corto, se avisa SIN PII y se puede reintentar", async () => {
    const c = await contexto();
    c.pac!.fallar = new Error("RFC RRR010101RR1 invalido");
    const id = await aprobada(c);
    const r = await c.enviar(c.admin, "POST", `/prefacturas/${id}/timbrar`);
    expect(r.status).toBe(502);
    expect(JSON.stringify(await r.json())).not.toMatch(/RRR010101RR1/);
    expect((await prefacturas(c)).prefacturas[0]).toMatchObject({ estado: "fallida", uuid: null });
    const aviso = c.emisiones.find((e) => e.evento === "despachos.honorarios.timbrado_fallido")!;
    expect(aviso).toMatchObject({ severidad: "critica", categoria: "fiscal", enlace: "/despachos/{orgSlug}/honorarios", cuerpo: `Periodo ${mesActual()}; motivo: pac_error. La prefactura quedó fallida y puede reintentarse.`, roles: ["contador"] });
    expect(aviso.dedupeKey).toMatch(new RegExp(`^despachos\\.honorarios\\.timbrado_fallido:${id}:pac_error:\\d{4}-\\d{2}-\\d{2}$`));
    expect(JSON.stringify(aviso)).not.toMatch(/RRR010101RR1|Receptor/);
    c.pac!.fallar = null;
    expect((await c.enviar(c.admin, "POST", `/prefacturas/${id}/timbrar`)).status).toBe(200);
  });
  it("sin desglose que cuadre no se timbra: una prefactura con retenciones es 422 y sigue aprobada (NO VERIFICADO D-34)", async () => {
    const c = await contexto();
    await crearIguala(c, { retencionIsrBp: 1000, retieneIvaDosTercios: true });
    await generar(c);
    const [p] = (await prefacturas(c)).prefacturas;
    expect(p!.totalCentavos).toBe(95_333);
    expect(p!.timbrable.ok).toBe(false);
    await c.enviar(c.admin, "POST", `/prefacturas/${p!.id}/aprobar`);
    const r = await c.enviar(c.admin, "POST", `/prefacturas/${p!.id}/timbrar`);
    expect(r.status).toBe(422);
    expect(c.pac!.timbrados).toBe(0);
    expect((await prefacturas(c)).prefacturas[0]!.estado).toBe("aprobada");
  });
  it("contador y readonly NO timbran (403) y el PAC no se toca", async () => {
    const c = await contexto();
    const id = await aprobada(c);
    for (const rol of ["contador", "readonly", "auditor"] as const) expect((await c.enviar(c.ctx.staff[rol].token, "POST", `/prefacturas/${id}/timbrar`)).status).toBe(403);
    expect(c.pac!.timbrados).toBe(0);
  });
});

describe("cancelar", () => {
  it("valida el motivo SAT: 01 exige folio de sustitucion; 05, vacio o folio con otro motivo se rechazan", async () => {
    const c = await contexto();
    const id = await aprobada(c);
    for (const cuerpo of [{ motivo: "05" }, {}, { motivo: "01" }, { motivo: "01", folioSustitucion: "no-uuid" }, { motivo: "02", folioSustitucion: U2 }]) {
      expect((await c.enviar(c.admin, "POST", `/prefacturas/${id}/cancelar`, cuerpo)).status, JSON.stringify(cuerpo)).toBe(400);
    }
  });
  it("una aprobada se cancela sin PAC; no se cancela dos veces (409)", async () => {
    const c = await contexto({ pac: null });
    const id = await aprobada(c);
    const r = await c.enviar(c.admin, "POST", `/prefacturas/${id}/cancelar`, { motivo: "03" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ prefactura: { estado: "cancelada", motivoCancelacion: "03" } });
    expect((await c.enviar(c.admin, "POST", `/prefacturas/${id}/cancelar`, { motivo: "03" })).status).toBe(409);
  });
  it("una timbrada se cancela ante el PAC con el motivo y el folio de sustitucion; sin PAC es 503 y sigue timbrada", async () => {
    const c = await contexto();
    const id = await aprobada(c);
    await c.enviar(c.admin, "POST", `/prefacturas/${id}/timbrar`);
    const r = await c.enviar(c.admin, "POST", `/prefacturas/${id}/cancelar`, { motivo: "01", folioSustitucion: U2 });
    expect(r.status).toBe(200);
    expect(c.pac!.cancelaciones).toEqual([{ id: "pac-1", motivo: "01", folio: U2 }]);
    expect(await r.json()).toMatchObject({ prefactura: { estado: "cancelada", folioSustitucion: U2, uuid: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001" } });

    const sinPac = await contexto();
    const id2 = await aprobada(sinPac);
    await sinPac.enviar(sinPac.admin, "POST", `/prefacturas/${id2}/timbrar`);
    // se quita la credencial despues de timbrar: la cancelacion es 503 y la prefactura sigue timbrada
    const app = buildApp({ ...sinPac.ctx.deps, pacClient: undefined });
    const res = await app.request(`/despachos/${sinPac.ctx.propertyId}/honorarios/prefacturas/${id2}/cancelar`, authedJson(sinPac.admin, { motivo: "02" }));
    expect(res.status).toBe(503);
    expect((await prefacturas(sinPac)).prefacturas[0]!.estado).toBe("timbrada");
  });
  it("una prefactura con timbrado en curso no se cancela (409)", async () => {
    const c = await contexto();
    const id = await aprobada(c);
    await c.ctx.honorariosRepo.reservarTimbrado(c.ctx.propertyId, id, 900);
    expect((await c.enviar(c.admin, "POST", `/prefacturas/${id}/cancelar`, { motivo: "02" })).status).toBe(409);
  });
});

describe("cross-tenant, base sin migrar y compatibilidad", () => {
  async function adminDeOtroDespacho(c: Awaited<ReturnType<typeof contexto>>): Promise<string> {
    const organizationId = randomUUID();
    const id = randomUUID();
    const coreRepo = c.ctx.deps.coreRepo as unknown as { addOrganization(o: object): void; addStaff(s: object): void; addMembership(m: object): void };
    coreRepo.addOrganization({ id: organizationId, slug: "otro-despacho", name: "Otro Despacho", vertical: "despachos" });
    coreRepo.addStaff({ id, email: "admin@otro-despacho.mx", fullName: "Otro", passwordHash: await hashPassword("correcto-caballo-batería"), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    const m = { userId: id, organizationId, platformRole: "owner", verticalRole: "admin", propertyIds: null };
    coreRepo.addMembership(m);
    (c.ctx.deps.engine as unknown as { seedMembership(x: object): void }).seedMembership(m);
    const res = await c.app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@otro-despacho.mx", password: "correcto-caballo-batería" }) });
    return ((await res.json()) as { token: string }).token;
  }
  it("un admin de OTRO despacho no ve, genera, aprueba, timbra ni cancela los honorarios de este cliente (y el PAC no se toca)", async () => {
    const c = await contexto();
    const id = await aprobada(c);
    const ajeno = await adminDeOtroDespacho(c);
    for (const [m, r, b] of [["GET", "/igualas", undefined], ["GET", "/prefacturas", undefined], ["POST", "/igualas", IGUALA], ["POST", "/generar-prefacturas", {}], ["POST", `/prefacturas/${id}/aprobar`, {}], ["POST", `/prefacturas/${id}/timbrar`, {}], ["POST", `/prefacturas/${id}/cancelar`, { motivo: "02" }]] as const) {
      const res = await c.enviar(ajeno, m, r, b);
      expect(res.status, `${m} ${r}`).toBeGreaterThanOrEqual(400);
      expect(res.status, `${m} ${r}`).toBeLessThan(500);
    }
    expect(c.pac!.timbrados).toBe(0);
    expect((await prefacturas(c)).prefacturas[0]!.estado).toBe("aprobada");
  });
  it("sin token: 401", async () => {
    const c = await contexto();
    expect((await c.app.request(`${c.base}/igualas`)).status).toBe(401);
  });
  it("BASE SIN MIGRAR: las lecturas responden vacio 'no_disponible' (200) y las escrituras 503; nunca un 500", async () => {
    const c = await contexto();
    const id = await aprobada(c);
    c.ctx.honorariosRepo.disponible = false;
    expect(await (await c.enviar(c.admin, "GET", "/igualas")).json()).toEqual({ estado: "no_disponible", igualas: [] });
    expect(await prefacturas(c)).toMatchObject({ estado: "no_disponible", prefacturas: [] });
    for (const [m, r, b] of [["POST", "/igualas", IGUALA], ["POST", "/generar-prefacturas", {}], ["POST", `/prefacturas/${id}/aprobar`, {}], ["POST", `/prefacturas/${id}/timbrar`, {}], ["POST", `/prefacturas/${id}/cancelar`, { motivo: "02" }]] as const) {
      expect((await c.enviar(c.admin, m, r, b)).status, `${m} ${r}`).toBe(503);
    }
    expect(c.pac!.timbrados).toBe(0);
  });
});
