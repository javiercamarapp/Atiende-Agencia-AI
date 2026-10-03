// H-30 -- privacidad PUBLICA del huesped de hoteles (aviso, ARCO sin login con verificacion por codigo, exportacion y "mis datos").
// Integracion HTTP real (app.request) sobre el espejo en memoria. RLS/GRANT/funciones SQL las cubre
// scripts/verify-hoteles-privacidad-publica contra Postgres real.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson, type HotelesTestContext } from "./hoteles-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const ORG = "hotel-de-prueba";
const BASE = `/v1/hoteles/${ORG}/privacidad`;
const ORIGIN = "http://localhost:5173";

afterEach(() => vi.useRealTimers());

async function setup() {
  const ctx = await buildHotelesTestContext(buildApp);
  const { deps, emisiones } = conEmisiones(ctx.deps);
  return { ctx, app: buildApp(deps), repo: ctx.privacidadPublicaRepo, emisiones };
}
type App = ReturnType<typeof buildApp>;

let ipSeq = 0;
function publicPost(path: string, body: unknown, headers: Record<string, string> = {}): [string, RequestInit] {
  const raw = JSON.stringify(body);
  ipSeq += 1;
  return [path, { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength), origin: ORIGIN, "x-forwarded-for": `203.0.113.${ipSeq % 250}`, ...headers } }];
}
const FORM = { derecho: "acceso", nombre: "Ana Torres", correo: "ana.torres@example.com", descripcion: "Quiero conocer mis datos" };

async function alta(app: App, body: Record<string, unknown> = FORM, headers: Record<string, string> = {}) {
  return app.request(...publicPost(`${BASE}/solicitud`, body, headers));
}
function codeFromOutbox(repo: HotelesTestContext["privacidadPublicaRepo"], to: string): string {
  const mail = [...repo.outbox].reverse().find((m) => m.to === to);
  const m = mail?.text.match(/codigo de verificacion: (\d{6})/i);
  if (!m) throw new Error("no hay correo con codigo en la cola");
  return m[1]!;
}

describe("GET /v1/hoteles/:orgSlug/privacidad (aviso publico, sin login)", () => {
  it("responde sin token con el aviso vigente: solo texto publico, sin datos personales ni quien lo publico", async () => {
    const { app } = await setup();
    const res = await app.request(BASE, { headers: { "x-forwarded-for": "198.51.100.1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { disponible: boolean; hotel: { nombre: string }; propiedades: Array<{ propiedad: { slug: string }; aviso: Record<string, unknown> }> };
    expect(body.disponible).toBe(true);
    expect(body.hotel.nombre).toBe("Hotel de Prueba");
    expect(body.propiedades).toHaveLength(1);
    expect(body.propiedades[0]!.propiedad.slug).toBe("hotel-de-prueba-matriz");
    expect(Object.keys(body.propiedades[0]!.aviso).sort()).toEqual(["finalidadesObligatorias", "finalidadesOpcionales", "publicadoEn", "textoSimplificado", "urlIntegral", "version"]);
    expect(JSON.stringify(body)).not.toMatch(/publicadoPor|published_by|sha256/i);
  });
  it("?property= filtra por slug; slug desconocido y hotel inexistente = 404; una propiedad sin aviso se dice honestamente (aviso: null)", async () => {
    const { app, repo } = await setup();
    expect((await app.request(`${BASE}?property=hotel-de-prueba-matriz`)).status).toBe(200);
    expect((await app.request(`${BASE}?property=no-existe`)).status).toBe(404);
    expect((await app.request(`/v1/hoteles/otro-hotel/privacidad`)).status).toBe(404);
    repo.properties = repo.properties.map((p) => ({ ...p, notice: null }));
    const body = (await (await app.request(BASE)).json()) as { propiedades: Array<{ aviso: unknown }> };
    expect(body.propiedades[0]!.aviso).toBeNull();
  });
  it("base sin la migracion 042: disponible false con el motivo, nunca 500", async () => {
    const { app, repo } = await setup();
    repo.available = false;
    const res = await app.request(BASE);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false });
  });
});

describe("POST /privacidad/solicitud (ARCO sin login)", () => {
  it("guarda la solicitud pendiente_verificacion, encola el correo con el codigo y NO devuelve el codigo ni el hash", async () => {
    const { app, repo } = await setup();
    const res = await alta(app);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; referencia: string; venceEnMinutos: number; envioDeCorreo: string };
    expect(body).toMatchObject({ ok: true, venceEnMinutos: 15, envioDeCorreo: "pendiente_de_configuracion" });
    const row = repo.requests.get(body.referencia)!;
    expect(row).toMatchObject({ status: "pendiente_verificacion", rightType: "acceso", contact: "ana.torres@example.com" });
    expect(repo.outbox).toHaveLength(1);
    const code = codeFromOutbox(repo, "ana.torres@example.com");
    expect(JSON.stringify(body)).not.toContain(code);
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.codeHash).not.toContain(code);
  });
  it("sin enumeracion: la respuesta es identica exista o no el titular, con honeypot y con el contacto ya topado", async () => {
    const { app, repo } = await setup();
    const forma = async (r: Response) => {
      const j = (await r.json()) as Record<string, unknown>;
      return { status: r.status, claves: Object.keys(j).sort(), mensaje: j.mensaje, venceEnMinutos: j.venceEnMinutos, envio: j.envioDeCorreo, refUuid: /^[0-9a-f-]{36}$/.test(String(j.referencia)) };
    };
    const existente = await forma(await alta(app, { ...FORM, correo: "ana.torres@example.com" }));
    const desconocido = await forma(await alta(app, { ...FORM, correo: "nadie@example.com" }));
    const robot = await forma(await alta(app, { ...FORM, correo: "robot@example.com", sitioWeb: "http://spam.example" }));
    expect(desconocido).toEqual(existente);
    expect(robot).toEqual(existente);
    expect(repo.requests.size).toBe(2); // el honeypot no guarda nada
    // Tope por contacto: 3 por hora por correo; los siguientes responden igual y no guardan.
    for (let i = 0; i < 4; i += 1) expect(await forma(await alta(app, { ...FORM, correo: "tope@example.com" }))).toEqual(existente);
    expect([...repo.requests.values()].filter((r) => r.contact === "tope@example.com")).toHaveLength(3);
  });
  it("valida la entrada (derecho, correo, telefono no sirve como contacto, cuerpo gigante) y rechaza origenes no permitidos", async () => {
    const { app } = await setup();
    expect((await alta(app, { ...FORM, derecho: "borrado" })).status).toBe(400);
    expect((await alta(app, { ...FORM, correo: "no-es-correo" })).status).toBe(400);
    expect((await alta(app, { ...FORM, correo: "+52 999 123 4567" })).status).toBe(400);
    expect((await alta(app, { ...FORM, descripcion: "x".repeat(9000) })).status).toBe(413);
    expect((await alta(app, FORM, { origin: "https://evil.example" })).status).toBe(403);
  });
  it("con varias propiedades exige indicar cual; con slug valido la acepta", async () => {
    const { app, repo } = await setup();
    repo.properties = [...repo.properties, { propertyId: "00000000-0000-4000-8000-0000000000b2", propertyName: "Hotel de Prueba Playa", notice: null }];
    expect((await alta(app)).status).toBe(400);
    expect((await alta(app, { ...FORM, propiedad: "hotel-de-prueba-playa" })).status).toBe(202);
  });
  it("rate limit por IP: la sexta alta en un minuto desde la misma IP responde 429 y no guarda", async () => {
    const { app, repo } = await setup();
    for (let i = 0; i < 5; i += 1) expect((await alta(app, { ...FORM, correo: `p${i}@example.com` }, { "x-forwarded-for": "192.0.2.77" })).status).toBe(202);
    const sexta = await alta(app, { ...FORM, correo: "p6@example.com" }, { "x-forwarded-for": "192.0.2.77" });
    expect(sexta.status).toBe(429);
    expect(repo.requests.size).toBe(5);
  });
  it("base sin migrar: 503 honesto (nunca 500) y hotel inexistente 404", async () => {
    const { app, repo } = await setup();
    expect((await app.request(...publicPost(`/v1/hoteles/otro-hotel/privacidad/solicitud`, FORM))).status).toBe(404);
    repo.available = false;
    expect((await alta(app)).status).toBe(503);
  });
});

describe("POST /privacidad/solicitud/verificar", () => {
  async function pendiente(app: App, repo: HotelesTestContext["privacidadPublicaRepo"], correo = "ana.torres@example.com") {
    const body = (await (await alta(app, { ...FORM, correo })).json()) as { referencia: string };
    return { referencia: body.referencia, codigo: codeFromOutbox(repo, correo) };
  }
  const verificar = (app: App, referencia: string, codigo: string) => app.request(...publicPost(`${BASE}/solicitud/verificar`, { referencia, codigo }));

  it("el codigo correcto pasa a recibida con plazo de 20 dias, avisa al staff (sin PII) y no se puede reutilizar", async () => {
    const { app, repo, emisiones } = await setup();
    const { referencia, codigo } = await pendiente(app, repo);
    const ok = await verificar(app, referencia, codigo);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, folio: expect.stringMatching(/^ARCO-/) });
    const row = repo.requests.get(referencia)!;
    expect(row.status).toBe("recibida");
    const dias = (Date.parse(`${row.responseDueOn}T00:00:00Z`) - Date.parse(`${row.receivedOn}T00:00:00Z`)) / 86_400_000;
    expect(dias).toBe(20);
    expect(emisiones).toHaveLength(1);
    expect(emisiones[0]).toMatchObject({
      evento: "hoteles.arco.solicitud_publica",
      categoria: "operacion",
      severidad: "atencion",
      enlace: "/hoteles/{orgSlug}/identidad",
      dedupeKey: `hoteles.arco.solicitud_publica:${referencia}`,
    });
    expect(JSON.stringify(emisiones[0])).not.toMatch(/ana|torres|example\.com/i);
    expect((await verificar(app, referencia, codigo)).status).toBe(422);
  });
  it("invalido, expirado, reutilizado, agotado y referencia inexistente responden EXACTAMENTE lo mismo", async () => {
    const { app, repo } = await setup();
    const a = await pendiente(app, repo, "a@example.com");
    const malo = a.codigo === "000000" ? "111111" : "000000";
    const invalido = await verificar(app, a.referencia, malo);
    const inexistente = await verificar(app, "00000000-0000-4000-8000-00000000dead", "123456");
    // agotado: 5 fallos y luego el correcto
    const b = await pendiente(app, repo, "b@example.com");
    for (let i = 0; i < 5; i += 1) await verificar(app, b.referencia, b.codigo === "000000" ? "111111" : "000000");
    const agotado = await verificar(app, b.referencia, b.codigo);
    // reutilizado
    const c = await pendiente(app, repo, "c@example.com");
    await verificar(app, c.referencia, c.codigo);
    const reutilizado = await verificar(app, c.referencia, c.codigo);
    // expirado
    vi.useFakeTimers({ toFake: ["Date"] });
    const d = await pendiente(app, repo, "d@example.com");
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const expirado = await verificar(app, d.referencia, d.codigo);
    const textos = await Promise.all([invalido, inexistente, agotado, reutilizado, expirado].map(async (r) => ({ status: r.status, body: await r.json() })));
    for (const t of textos) expect(t).toEqual(textos[0]);
    expect(textos[0]!.status).toBe(422);
    expect(repo.requests.get(b.referencia)!.status).toBe("pendiente_verificacion");
  });
  it("valida el formato (referencia UUID, codigo de 6 digitos) y aplica rate limit por IP", async () => {
    const { app } = await setup();
    expect((await app.request(...publicPost(`${BASE}/solicitud/verificar`, { referencia: "x", codigo: "123456" }))).status).toBe(400);
    expect((await app.request(...publicPost(`${BASE}/solicitud/verificar`, { referencia: "00000000-0000-4000-8000-00000000dead", codigo: "12" }))).status).toBe(400);
    let ultimo = 0;
    for (let i = 0; i < 11; i += 1) ultimo = (await app.request(...publicPost(`${BASE}/solicitud/verificar`, { referencia: `00000000-0000-4000-8000-0000000000${(10 + i).toString()}`, codigo: "123456" }, { "x-forwarded-for": "192.0.2.99" }))).status;
    expect(ultimo).toBe(429);
  });
});

describe("mis datos: enlace firmado (staff lo emite, el titular lo consulta)", () => {
  async function accesoProcedente(ctx: HotelesTestContext, app: App) {
    const crear = await app.request(`/hoteles/${ctx.propertyId}/privacidad/arco`, authedJson(ctx.staff.owner.token, { derecho: "acceso", solicitante: "Ana Torres", contacto: "ana.torres@example.com", canal: "mostrador" }));
    expect(crear.status).toBe(201);
    const { solicitudId: id } = (await crear.json()) as { solicitudId: string };
    const avanzar = await app.request(`/hoteles/${ctx.propertyId}/privacidad/arco/${id}/avanzar`, authedJson(ctx.staff.owner.token, { estado: "procedente", nota: "Identidad verificada en mostrador" }));
    expect(avanzar.status).toBe(200);
    ctx.privacidadPublicaRepo.seedRequest({ id, propertyId: ctx.propertyId, rightType: "acceso", status: "procedente", contact: "ana.torres@example.com" });
    return id;
  }
  const emitir = (ctx: HotelesTestContext, app: App, token: string, id: string, body: unknown = { huespedId: ctx.guestId }) =>
    app.request(`/hoteles/${ctx.propertyId}/privacidad/arco/${id}/enlace-mis-datos`, authedJson(token, body));
  const tokenDe = (enlace: string) => decodeURIComponent(enlace.split("#token=")[1]!);
  const consultar = (app: App, token: unknown, org = ORG) => app.request(...publicPost(`/v1/hoteles/${org}/privacidad/mis-datos`, { token }));

  it("el enlace solo lo emite owner/gm sobre un acceso procedente; el titular ve SOLO perfil, estancias, consentimientos e identidad (estado)", async () => {
    const { ctx, app } = await setup();
    const id = await accesoProcedente(ctx, app);
    expect((await emitir(ctx, app, ctx.staff.frontdesk.token, id)).status).toBe(403);
    const res = await emitir(ctx, app, ctx.staff.gm.token, id);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { enlace: string; venceEn: string; correo: string };
    expect(out.enlace).toMatch(/\/hoteles\/hotel-de-prueba\/mis-datos#token=m1\./);
    expect(out.correo).toBe("encolado");
    const correo = ctx.hotelesRepo.getOutbox().find((o) => o.eventType === "arco.mis_datos");
    expect((correo?.payload as { to: string; subject: string }).to).toBe("ana.torres@example.com");
    expect((correo?.payload as { subject: string }).subject).toContain("ARCO-");
    const data = await consultar(app, tokenDe(out.enlace));
    expect(data.status).toBe(200);
    const body = (await data.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(expect.arrayContaining(["perfil", "estancias", "consentimientos", "identidad", "folio"]));
    expect(body).not.toHaveProperty("notas");
    expect(body).not.toHaveProperty("conversaciones");
    expect(JSON.stringify(body)).not.toMatch(/payload|document_last4|HYPERLINK/i);
  });
  it("token falso, manipulado, vencido (24 h), de otro hotel o de una solicitud que dejo de ser procedente = 404 identico", async () => {
    const { ctx, app, repo } = await setup();
    const id = await accesoProcedente(ctx, app);
    const out = (await (await emitir(ctx, app, ctx.staff.owner.token, id)).json()) as { enlace: string };
    const token = tokenDe(out.enlace);
    const partes = token.split(".");
    const manipulado = `${partes[0]}.${Buffer.from(JSON.stringify({ org: ctx.organizationId, req: id, iat: 1, exp: 99_999_999_999 })).toString("base64url")}.${partes[2]}`;
    const malos = [undefined, "", "m1.x.y", manipulado, `${token}x`];
    const resp = await Promise.all(malos.map(async (t) => consultar(app, t)));
    for (const r of resp) expect(r.status).toBe(404);
    expect((await consultar(app, token, "otro-hotel")).status).toBe(404);
    // vencido
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    expect((await consultar(app, token)).status).toBe(404);
    vi.useRealTimers();
    // la solicitud deja de ser procedente: el enlace se revoca solo
    expect((await consultar(app, token)).status).toBe(200);
    repo.requests.get(id)!.status = "improcedente";
    expect((await consultar(app, token)).status).toBe(404);
  });
  it("no se emite para una solicitud que no es de acceso procedente (400) ni para una inexistente (404); sin token 401", async () => {
    const { ctx, app, repo } = await setup();
    const rect = await app.request(`/hoteles/${ctx.propertyId}/privacidad/arco`, authedJson(ctx.staff.owner.token, { derecho: "rectificacion", solicitante: "Ana Torres", canal: "mostrador" }));
    const { solicitudId: id } = (await rect.json()) as { solicitudId: string };
    repo.seedRequest({ id, propertyId: ctx.propertyId, rightType: "rectificacion", status: "procedente" });
    expect((await emitir(ctx, app, ctx.staff.owner.token, id)).status).toBe(400);
    expect((await emitir(ctx, app, ctx.staff.owner.token, "00000000-0000-4000-8000-00000000dead")).status).toBe(404);
    expect((await app.request(`/hoteles/${ctx.propertyId}/privacidad/arco/${id}/enlace-mis-datos`, { method: "POST" })).status).toBe(401);
  });
});

describe("GET /hoteles/:propertyId/huespedes/:guestId/exportar-datos", () => {
  const url = (ctx: HotelesTestContext, fmt = "json", guest = ctx.guestId) => `/hoteles/${ctx.propertyId}/huespedes/${guest}/exportar-datos?formato=${fmt}`;

  it("owner y gm exportan JSON con perfil, estancias, notas, consentimientos y la identidad solo como estado; deja registro", async () => {
    const { ctx, app, repo } = await setup();
    for (const t of [ctx.staff.owner.token, ctx.staff.gm.token]) {
      const res = await app.request(url(ctx), authedJson(t));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("content-disposition")).toContain("attachment");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as Record<string, unknown> & { identidad: Array<Record<string, unknown>> };
      expect(Object.keys(body)).toEqual(expect.arrayContaining(["perfil", "estancias", "notas", "consentimientos", "identidad"]));
      expect(body.identidad[0]).toMatchObject({ tipoDocumento: "pasaporte", estado: "activo" });
      expect(JSON.stringify(body)).not.toMatch(/payload|last4|v1\.AAAA/i);
    }
    expect(repo.exportLog).toHaveLength(2);
    expect(repo.exportLog[0]).toMatchObject({ propertyId: ctx.propertyId, guestId: ctx.guestId, format: "json" });
  });
  it("CSV: texto UTF-8 con BOM, una fila por campo y las formulas de hoja de calculo neutralizadas", async () => {
    const { ctx, app, repo } = await setup();
    const res = await app.request(url(ctx, "csv"), authedJson(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(text).toContain("seccion,indice,campo,valor");
    expect(text).toContain("perfil,,nombre,Ana Torres");
    expect(text).toContain("'=HYPERLINK");
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
    expect(repo.exportLog.at(-1)?.format).toBe("csv");
  });
  it("frontdesk/reservations 403, sin token 401, formato invalido 400, huesped inexistente o de otra property 404; sin registro cuando falla", async () => {
    const { ctx, app, repo } = await setup();
    for (const t of [ctx.staff.frontdesk.token, ctx.staff.reservations.token, ctx.staff.accountant.token]) expect((await app.request(url(ctx), authedJson(t))).status).toBe(403);
    expect((await app.request(url(ctx))).status).toBe(401);
    expect((await app.request(url(ctx, "xml"), authedJson(ctx.staff.owner.token))).status).toBe(400);
    expect((await app.request(url(ctx, "json", "00000000-0000-4000-8000-00000000dead"), authedJson(ctx.staff.owner.token))).status).toBe(404);
    expect(repo.exportLog).toHaveLength(0);
  });
  it("base sin migrar: 503 honesto; nunca exporta sin poder registrar", async () => {
    const { ctx, app, repo } = await setup();
    repo.available = false;
    expect((await app.request(url(ctx), authedJson(ctx.staff.owner.token))).status).toBe(503);
  });
});
