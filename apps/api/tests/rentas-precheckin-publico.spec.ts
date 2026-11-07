// Rn-P3-08 / Rn-P3-09 -- HTTP real (app.request) del pre-check-in publico del huesped y de la entrega manual de accesos omitidos:
// rutas publicas sin sesion (misma respuesta exista o no la reserva, tiempo minimo, rate limit, bloqueo, no-store, nada de PII en logs,
// base sin migrar -> 503) y rutas de staff (roles, enlace publico, reglamento, pendientes, mensaje para la OTA con bitacora, entrega manual).
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryRentasAccesoRepository, InMemoryRentasPrecheckinRepository, createAccesoCipher } from "@atiende/domain-rentas";
import type { LiberacionPendiente } from "@atiende/domain-rentas";
import { buildApp } from "../src/app.ts";
import { PISO_RESPUESTA_VERIFICAR_MS } from "../src/routes/verticals/rentas/precheckin-publico.ts";
import { TEST_ENV } from "./fixtures.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

const OCUPACION = "33333333-3333-4333-8333-333333333333";
const CODIGO = "HMAB12CD34";
const TELEFONO = "0123";
const CORREO = "huesped.privado@example.com";
const WHATSAPP = "9981234567";
const SECRETO = "9137-PRIVADO";
const CRON = { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } };
let ipSecuencia = 10;

afterEach(() => vi.restoreAllMocks());

function publico(method: "GET" | "POST", ip: string, body?: unknown): RequestInit {
  const headers: Record<string, string> = { "x-forwarded-for": ip };
  if (body === undefined) return { method, headers };
  const raw = JSON.stringify(body);
  headers["content-type"] = "application/json";
  headers["content-length"] = String(new TextEncoder().encode(raw).byteLength);
  return { method, body: raw, headers };
}

function enviar(method: "PUT", token: string, body: unknown): RequestInit {
  const raw = JSON.stringify(body);
  return { method, body: raw, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) } };
}

async function preparar(opciones: { conLlave?: boolean } = {}) {
  const ctx = await buildRentasTestContext(buildApp);
  const precheckin = new InMemoryRentasPrecheckinRepository();
  precheckin.sembrarPropiedad(ctx.propertyId, "Casa del Mar", "Gestora Sol");
  precheckin.sembrarReserva({ ocupacionId: OCUPACION, organizationId: ctx.organizationId, propertyId: ctx.propertyId, codigo: CODIGO, ultimos4: TELEFONO, checkIn: "2099-03-10", checkOut: "2099-03-12", unidadNombre: "Depa de Prueba" });
  const acceso = new InMemoryRentasAccesoRepository(opciones.conLlave === false ? null : createAccesoCipher(Buffer.alloc(32, 5)));
  acceso.unidadesPorProperty.set(ctx.propertyId, new Set([ctx.unidadId]));
  acceso.reservasConocidas.add(OCUPACION);
  const app = buildApp({ ...ctx.deps, rentasPrecheckinRepo: () => precheckin, rentasAccesoRepo: () => acceso });
  const ip = `203.0.113.${ipSecuencia++}`;
  const pub = `/rentas/precheckin/${ctx.propertyId}`;
  const verificar = (codigo: string, ultimos4: string, propertyId = ctx.propertyId) => app.request(`/rentas/precheckin/${propertyId}/verificar`, publico("POST", ip, { codigo, ultimos4 }));
  return { ctx, precheckin, acceso, app, ip, pub, verificar, base: `/rentas/${ctx.propertyId}` };
}

describe("GET /rentas/precheckin/:propertyId (publico)", () => {
  it("sin sesion devuelve el nombre de la propiedad, el reglamento y el aviso de privacidad; Cache-Control no-store", async () => {
    const { ctx, app, ip, pub, precheckin } = await preparar();
    await precheckin.guardarReglamento(ctx.organizationId, ctx.propertyId, "No fiestas.", "u");
    const r = await app.request(pub, publico("GET", ip));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const cuerpo = (await r.json()) as { propiedad: string; organizacion: string; reglamento: string; aviso: { version: string; parrafos: string[] } };
    expect(cuerpo).toMatchObject({ propiedad: "Casa del Mar", organizacion: "Gestora Sol", reglamento: "No fiestas." });
    expect(cuerpo.aviso.version).toMatch(/^2026-/);
    expect(cuerpo.aviso.parrafos.join(" ")).toContain("Gestora Sol");
    expect(JSON.stringify(cuerpo)).not.toContain(CODIGO);
  });

  it("una property desconocida y un id que no es UUID dan el mismo 404 generico", async () => {
    const { app, ip } = await preparar();
    const a = await app.request("/rentas/precheckin/44444444-4444-4444-8444-444444444444", publico("GET", ip));
    const b = await app.request("/rentas/precheckin/no-es-uuid", publico("GET", ip));
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await a.json()).toEqual(await b.json());
  });

  it("contra la base sin la migracion 036: 503 'aun no disponible', nunca 500", async () => {
    const { app, ip, pub, precheckin } = await preparar();
    precheckin.migracion036Disponible = false;
    const r = await app.request(pub, publico("GET", ip));
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).toContain("aún no está disponible");
  });
});

describe("POST /rentas/precheckin/:propertyId/verificar (publico)", () => {
  it("codigo + 4 digitos correctos: 200 con token, estancia y no-store", async () => {
    const { app, verificar } = await preparar();
    const r = await verificar(CODIGO, TELEFONO);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toMatchObject({ estado: "ok", propiedad: "Casa del Mar", unidad: "Depa de Prueba", check_in: "2099-03-10", check_out: "2099-03-12", ya_capturado: false });
    void app;
  });

  it("NO filtra existencia: telefono incorrecto, codigo inexistente, reserva de otra property y reserva pasada dan la MISMA respuesta (status y cuerpo)", async () => {
    const { ctx, precheckin, verificar } = await preparar();
    const otra = "55555555-5555-4555-8555-555555555555";
    precheckin.sembrarPropiedad(otra);
    precheckin.sembrarReserva({ ocupacionId: "66666666-6666-4666-8666-666666666666", organizationId: "77777777-7777-4777-8777-777777777777", propertyId: otra, codigo: "HMOTRA0001", ultimos4: "3333", checkIn: "2099-03-10", checkOut: "2099-03-12" });
    precheckin.sembrarReserva({ ocupacionId: "88888888-8888-4888-8888-888888888888", organizationId: ctx.organizationId, propertyId: ctx.propertyId, codigo: "HMPASADA01", ultimos4: "1111", checkIn: "2020-03-10", checkOut: "2020-03-12" });
    const respuestas = await Promise.all([verificar(CODIGO, "9999"), verificar("HMNOEXISTE1", TELEFONO), verificar("HMOTRA0001", "3333"), verificar("HMPASADA01", "1111")]);
    const cuerpos = await Promise.all(respuestas.map(async (r) => ({ status: r.status, body: await r.json() })));
    for (const c of cuerpos) expect(c).toEqual(cuerpos[0]);
    expect(cuerpos[0]).toMatchObject({ status: 200, body: { estado: "invalido" } });
    expect(JSON.stringify(cuerpos[0])).not.toContain("token");
  });

  it(`el tiempo de respuesta tiene un piso (${PISO_RESPUESTA_VERIFICAR_MS} ms) tanto si coincide como si no: no se distingue por tiempo`, async () => {
    const { verificar } = await preparar();
    for (const [codigo, tel] of [[CODIGO, TELEFONO], [CODIGO, "9999"], ["HMNOEXISTE1", "0000"]] as const) {
      const inicio = Date.now();
      await verificar(codigo, tel);
      expect(Date.now() - inicio, `${codigo}/${tel}`).toBeGreaterThanOrEqual(PISO_RESPUESTA_VERIFICAR_MS - 5);
    }
  });

  it("5 intentos fallidos con un codigo lo bloquean 1 h: 429 con Retry-After, tambien para el codigo correcto y para uno inexistente", async () => {
    const { verificar } = await preparar();
    for (let i = 0; i < 5; i++) expect((await verificar(CODIGO, "9999")).status).toBe(200);
    const bloqueado = await verificar(CODIGO, TELEFONO);
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.headers.get("retry-after")).toBeTruthy();
    for (let i = 0; i < 5; i++) await verificar("HMNOEXISTE1", "0000");
    const inexistente = await verificar("HMNOEXISTE1", "0000");
    expect(inexistente.status).toBe(429);
    expect(await inexistente.json()).toEqual(await bloqueado.clone().json());
  });

  it("rate limit por IP y property: la solicitud 13 desde la misma IP recibe 429 antes de tocar la base", async () => {
    const { verificar, precheckin } = await preparar();
    // Tope de 12 por IP y property en 10 min (cada intento fallido distinto, para no caer en el bloqueo por codigo).
    for (let i = 0; i < 12; i++) expect((await verificar(`HMCODIGO${String(i).padStart(2, "0")}`, "0000")).status).toBe(200);
    const antes = precheckin.llamadas.filter((l) => l === "verificar").length;
    const r = await verificar(CODIGO, TELEFONO);
    expect(r.status).toBe(429);
    expect(precheckin.llamadas.filter((l) => l === "verificar").length).toBe(antes);
  });

  it("cuerpo mal formado: 400 con mensaje fijo que no repite lo escrito", async () => {
    const { ctx, app, ip } = await preparar();
    const r = await app.request(`/rentas/precheckin/${ctx.propertyId}/verificar`, publico("POST", ip, { codigo: "secreto-<script>", ultimos4: "12" }));
    expect(r.status).toBe(400);
    const texto = await r.text();
    expect(texto).not.toContain("secreto");
    expect(texto).not.toContain("script");
  });

  it("contra la base sin la migracion 036: 503", async () => {
    const { verificar, precheckin } = await preparar();
    precheckin.migracion036Disponible = false;
    expect((await verificar(CODIGO, TELEFONO)).status).toBe(503);
  });
});

describe("POST /rentas/precheckin/:propertyId/capturar (publico)", () => {
  async function conToken() {
    const t = await preparar();
    const v = (await (await t.verificar(CODIGO, TELEFONO)).json()) as { token: string };
    const capturar = (cuerpo: Record<string, unknown>) => t.app.request(`${t.pub}/capturar`, publico("POST", t.ip, { token: v.token, aceptaPrivacidad: true, ...cuerpo }));
    return { ...t, token: v.token, capturar };
  }

  it("captura el correo y el WhatsApp con las aceptaciones; la reserva queda con contacto y el token no se reutiliza", async () => {
    const { capturar, precheckin, token, app, pub, ip } = await conToken();
    const r = await capturar({ correo: CORREO, whatsapp: "+52 998 123 4567" });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toMatchObject({ estado: "ok" });
    expect(precheckin.contactos.get(OCUPACION)).toBe(CORREO);
    expect(precheckin.capturas.get(OCUPACION)).toMatchObject({ whatsapp: "529981234567" });
    const reuso = await app.request(`${pub}/capturar`, publico("POST", ip, { token, correo: "otro@example.com", aceptaPrivacidad: true }));
    expect(reuso.status).toBe(400);
    expect(precheckin.contactos.get(OCUPACION)).toBe(CORREO);
  });

  it("exige aceptar el aviso de privacidad y, si la property lo tiene, el reglamento", async () => {
    const { capturar, ctx, precheckin } = await conToken();
    expect((await capturar({ correo: CORREO, aceptaPrivacidad: false })).status).toBe(400);
    await precheckin.guardarReglamento(ctx.organizationId, ctx.propertyId, "No fiestas.", "u");
    const sinReglamento = await capturar({ correo: CORREO });
    expect(sinReglamento.status).toBe(400);
    expect(JSON.stringify(await sinReglamento.json())).toContain("reglamento");
    expect(precheckin.capturas.has(OCUPACION)).toBe(false);
    expect((await capturar({ correo: CORREO, aceptaReglamento: true })).status).toBe(200);
    expect(precheckin.capturas.get(OCUPACION)?.reglamentoVersion).toBe(1);
  });

  it("valida el cuerpo: correo invalido, WhatsApp invalido y token mal formado dan 400", async () => {
    const { capturar, app, pub, ip } = await conToken();
    expect((await capturar({ correo: "sin-arroba" })).status).toBe(400);
    expect((await capturar({ correo: CORREO, whatsapp: "12" })).status).toBe(400);
    expect((await app.request(`${pub}/capturar`, publico("POST", ip, { token: "x", correo: CORREO, aceptaPrivacidad: true }))).status).toBe(400);
  });

  it("una reserva ya capturada no se sobrescribe: ya_capturado 200 y el correo original se conserva", async () => {
    const { capturar, precheckin, verificar, app, pub, ip } = await conToken();
    await capturar({ correo: CORREO });
    const v2 = (await (await verificar(CODIGO, TELEFONO)).json()) as { token: string; ya_capturado: boolean };
    expect(v2.ya_capturado).toBe(true);
    const r = await app.request(`${pub}/capturar`, publico("POST", ip, { token: v2.token, correo: "atacante@example.com", aceptaPrivacidad: true }));
    expect(await r.json()).toMatchObject({ estado: "ya_capturado" });
    expect(precheckin.contactos.get(OCUPACION)).toBe(CORREO);
  });

  it("contra la base sin la migracion 036: 503", async () => {
    const { capturar, precheckin } = await conToken();
    precheckin.migracion036Disponible = false;
    expect((await capturar({ correo: CORREO })).status).toBe(503);
  });
});

describe("nada de PII en logs", () => {
  it("el codigo, el telefono, el correo, el WhatsApp y el token nunca llegan a un log (solo el resultado)", async () => {
    const espias = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")].map((s) => s.mockImplementation(() => undefined));
    const { app, pub, ip, verificar } = await preparar();
    await verificar(CODIGO, "9999");
    const v = (await (await verificar(CODIGO, TELEFONO)).json()) as { token: string };
    await app.request(`${pub}/capturar`, publico("POST", ip, { token: v.token, correo: CORREO, whatsapp: WHATSAPP, aceptaPrivacidad: true }));
    await verificar("HMNOEXISTE1", "5555");
    const todo = espias.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" "))).join("\n");
    expect(todo).toContain("rentas.precheckin.verificar");
    expect(todo).toContain("rentas.precheckin.capturar");
    for (const secreto of [CODIGO, "HMNOEXISTE1", TELEFONO, "9999", "5555", CORREO, WHATSAPP, v.token]) expect(todo, secreto).not.toContain(secreto);
  });
});

describe("staff: enlace publico, reglamento, pendientes, mensaje para la OTA y entrega manual", () => {
  it("GET/PUT acceso-huesped/precheckin: enlace fijo por property con texto sugerido; el reglamento sube de version solo si cambia; roles", async () => {
    const { ctx, app, base } = await preparar();
    const t = ctx.staff.adminGestora.token;
    const inicial = (await (await app.request(`${base}/acceso-huesped/precheckin`, authedJson(t, undefined, {}, "GET"))).json()) as Record<string, unknown>;
    expect(inicial).toMatchObject({ disponible: true, enlace_publico: `${TEST_ENV.appBaseUrl}/rentas/precheckin/${ctx.propertyId}`, reglamento: null, reglamento_version: 1 });
    expect(String(inicial.texto_sugerido)).toContain(`/rentas/precheckin/${ctx.propertyId}`);
    const a = (await (await app.request(`${base}/acceso-huesped/precheckin`, enviar("PUT", t, { reglamento: "  No fiestas.  " }))).json()) as { reglamento: string; reglamento_version: number };
    expect(a).toMatchObject({ reglamento: "No fiestas.", reglamento_version: 1 });
    const igual = (await (await app.request(`${base}/acceso-huesped/precheckin`, enviar("PUT", t, { reglamento: "No fiestas." }))).json()) as { reglamento_version: number };
    expect(igual.reglamento_version).toBe(1);
    const b = (await (await app.request(`${base}/acceso-huesped/precheckin`, enviar("PUT", t, { reglamento: "No fiestas ni mascotas." }))).json()) as { reglamento_version: number };
    expect(b.reglamento_version).toBe(2);
    expect((await app.request(`${base}/acceso-huesped/precheckin`, enviar("PUT", t, { reglamento: 5 }))).status).toBe(400);
    expect((await app.request(`${base}/acceso-huesped/precheckin`, authedJson(ctx.staff.operadorAccesoTotal.token, undefined, {}, "GET"))).status).toBe(200);
    for (const otro of [ctx.staff.contador.token, ctx.staff.limpieza.token, ctx.staff.operadorSoloCalendario.token]) {
      expect((await app.request(`${base}/acceso-huesped/precheckin`, authedJson(otro, undefined, {}, "GET"))).status).toBe(403);
      expect((await app.request(`${base}/acceso-huesped/precheckin`, enviar("PUT", otro, { reglamento: "x" }))).status).toBe(403);
    }
    expect((await app.request(`${base}/acceso-huesped/precheckin`, { method: "GET" })).status).toBe(401);
  });

  it("base sin migrar: GET disponible:false (sin enlace) y PUT 409", async () => {
    const { ctx, app, base, precheckin } = await preparar();
    precheckin.migracion036Disponible = false;
    const t = ctx.staff.adminGestora.token;
    expect(await (await app.request(`${base}/acceso-huesped/precheckin`, authedJson(t, undefined, {}, "GET"))).json()).toMatchObject({ disponible: false, enlace_publico: null });
    expect((await app.request(`${base}/acceso-huesped/precheckin`, enviar("PUT", t, { reglamento: "x" }))).status).toBe(409);
  });

  it("entre tenants: un id de property ajeno no abre ni la configuracion ni la entrega manual", async () => {
    const { ctx, app } = await preparar();
    const ajena = "99999999-9999-4999-8999-999999999999";
    const t = ctx.staff.adminGestora.token;
    for (const r of [await app.request(`/rentas/${ajena}/acceso-huesped/precheckin`, authedJson(t, undefined, {}, "GET")), await app.request(`/rentas/${ajena}/acceso-huesped/pendientes`, authedJson(t, undefined, {}, "GET")), await app.request(`/rentas/${ajena}/reservas/${OCUPACION}/entrega-manual`, authedJson(t, {}))]) {
      expect([403, 404]).toContain(r.status);
    }
  });

  it("GET pendientes lista las reservas omitidas; GET acceso-mensaje arma el texto con las instrucciones DESCIFRADAS, con bitacora lectura_admin y no-store", async () => {
    const { ctx, app, acceso, base } = await preparar();
    const t = ctx.staff.adminGestora.token;
    await app.request(`${base}/unidades/${ctx.unidadId}/acceso-instrucciones`, enviar("PUT", t, { direccion_exacta: "Calle 60 #123", codigo_acceso: SECRETO, instrucciones: "Caja junto a la puerta" }));
    acceso.reservasProximas.push({ ocupacionId: OCUPACION, unidadId: ctx.unidadId, unidadNombre: "Depa de Prueba", canal: "airbnb", checkIn: "2099-03-10", checkOut: "2099-03-12", huespedNombre: "Ana" });
    acceso.reservasParaMensaje.set(OCUPACION, { ocupacionId: OCUPACION, unidadId: ctx.unidadId, unidadNombre: "Depa de Prueba", checkIn: "2099-03-10", checkOut: "2099-03-12", huespedNombre: "Ana", propertyId: ctx.propertyId });
    acceso.bitacora.push({ id: "b0", propertyId: ctx.propertyId, ocupacionId: OCUPACION, evento: "omitida_sin_contacto", canal: null, creadoEn: "2099-03-09T10:00:00Z" });

    const lista = (await (await app.request(`${base}/acceso-huesped/pendientes`, authedJson(t, undefined, {}, "GET"))).json()) as { disponible: boolean; pendientes: Record<string, unknown>[] };
    expect(lista.pendientes).toEqual([expect.objectContaining({ reserva_id: OCUPACION, canal: "airbnb", unidad_nombre: "Depa de Prueba", huesped_nombre: "Ana", check_in: "2099-03-10" })]);

    acceso.bitacoraInstrucciones.length = 0;
    const r = await app.request(`${base}/reservas/${OCUPACION}/acceso-mensaje`, authedJson(t, undefined, {}, "GET"));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const { mensaje } = (await r.json()) as { mensaje: string };
    expect(mensaje).toContain("Calle 60 #123");
    expect(mensaje).toContain(SECRETO);
    expect(mensaje).toContain("Caja junto a la puerta");
    expect(acceso.bitacoraInstrucciones.map((b) => b.evento)).toEqual(["lectura_admin"]);
    // roles sin acceso a las instrucciones nunca ven el secreto
    for (const otro of [ctx.staff.contador.token, ctx.staff.limpieza.token, ctx.staff.operadorSoloCalendario.token]) {
      const x = await app.request(`${base}/reservas/${OCUPACION}/acceso-mensaje`, authedJson(otro, undefined, {}, "GET"));
      expect(x.status).toBe(403);
      expect(await x.text()).not.toContain(SECRETO);
    }
  });

  it("acceso-mensaje: reserva desconocida 404, unidad sin instrucciones 409, sin llave 503, id invalido 400", async () => {
    const { ctx, app, acceso, base } = await preparar();
    const t = ctx.staff.adminGestora.token;
    expect((await app.request(`${base}/reservas/${OCUPACION}/acceso-mensaje`, authedJson(t, undefined, {}, "GET"))).status).toBe(404);
    acceso.reservasParaMensaje.set(OCUPACION, { ocupacionId: OCUPACION, unidadId: ctx.unidadId, unidadNombre: "Depa de Prueba", checkIn: "2099-03-10", checkOut: "2099-03-12", huespedNombre: null, propertyId: ctx.propertyId });
    expect((await app.request(`${base}/reservas/${OCUPACION}/acceso-mensaje`, authedJson(t, undefined, {}, "GET"))).status).toBe(409);
    expect((await app.request(`${base}/reservas/no-es-uuid/acceso-mensaje`, authedJson(t, undefined, {}, "GET"))).status).toBe(400);
    const sinLlave = await preparar({ conLlave: false });
    sinLlave.acceso.reservasParaMensaje.set(OCUPACION, { ocupacionId: OCUPACION, unidadId: sinLlave.ctx.unidadId, unidadNombre: "Depa", checkIn: "2099-03-10", checkOut: "2099-03-12", huespedNombre: null, propertyId: sinLlave.ctx.propertyId });
    const r = await sinLlave.app.request(`${sinLlave.base}/reservas/${OCUPACION}/acceso-mensaje`, authedJson(sinLlave.ctx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("RENTAS_ACCESS_KEY");
  });

  it("POST entrega-manual registra entregada_manual (idempotente), 404 si no existe, 403 por rol, 409 sin migrar; la reserva sale de pendientes", async () => {
    const { ctx, app, acceso, base } = await preparar();
    const t = ctx.staff.adminGestora.token;
    acceso.reservasProximas.push({ ocupacionId: OCUPACION, unidadId: ctx.unidadId, unidadNombre: "Depa de Prueba", canal: "airbnb", checkIn: "2099-03-10", checkOut: "2099-03-12", huespedNombre: null });
    acceso.bitacora.push({ id: "b0", propertyId: ctx.propertyId, ocupacionId: OCUPACION, evento: "omitida_sin_contacto", canal: null, creadoEn: "2099-03-09T10:00:00Z" });
    const url = `${base}/reservas/${OCUPACION}/entrega-manual`;
    const primera = await app.request(url, authedJson(t, {}));
    expect(await primera.json()).toEqual({ reserva_id: OCUPACION, entregada: true, nueva: true });
    expect(await (await app.request(url, authedJson(t, {}))).json()).toEqual({ reserva_id: OCUPACION, entregada: true, nueva: false });
    expect(acceso.bitacora.filter((b) => b.evento === "entregada_manual")).toHaveLength(1);
    expect(((await (await app.request(`${base}/acceso-huesped/pendientes`, authedJson(t, undefined, {}, "GET"))).json()) as { pendientes: unknown[] }).pendientes).toEqual([]);
    expect((await app.request(`${base}/reservas/55555555-5555-4555-8555-555555555555/entrega-manual`, authedJson(t, {}))).status).toBe(404);
    expect((await app.request(url, authedJson(ctx.staff.limpieza.token, {}))).status).toBe(403);
    expect((await app.request(url, authedJson(ctx.staff.contador.token, {}))).status).toBe(403);
    acceso.migracion025Disponible = false;
    expect((await app.request(url, authedJson(t, {}))).status).toBe(409);
  });
});

describe("cron /internal/rentas/acceso-huesped -- aviso de acceso omitido", () => {
  function pendienteSinContacto(ctx: { organizationId: string; propertyId: string }): LiberacionPendiente {
    return { ocupacionId: OCUPACION, organizationId: ctx.organizationId, propertyId: ctx.propertyId, checkIn: "2099-03-10", checkOut: "2099-03-12", unidadNombre: "Depa", tenantNombre: "Gestora", huespedNombre: "Ana", huespedContacto: null, tieneInstrucciones: true, direccionExacta: "Calle 60", codigoAcceso: SECRETO, instrucciones: null };
  }

  it("el evento se emite UNA vez por reserva aunque el cron corra cada hora; la respuesta del cron no lleva PII", async () => {
    const { ctx, app, acceso } = await preparar();
    acceso.pendientes.push(pendienteSinContacto(ctx));
    const primera = await app.request("/internal/rentas/acceso-huesped", CRON);
    const texto = await primera.text();
    expect(JSON.parse(texto)).toMatchObject({ ok: true, omitidas_sin_contacto: 1, liberadas: 0 });
    expect(texto).not.toContain(SECRETO);
    for (let i = 0; i < 3; i++) await app.request("/internal/rentas/acceso-huesped", CRON);
    expect(acceso.avisosOmitidaSinContacto).toEqual([{ ocupacionId: OCUPACION, organizationId: ctx.organizationId, propertyId: ctx.propertyId }]);
  });

  it("cuando el pre-check-in captura el correo, la siguiente corrida entrega el acceso por correo sin intervencion", async () => {
    const { ctx, app, acceso } = await preparar();
    acceso.pendientes.push(pendienteSinContacto(ctx));
    await app.request("/internal/rentas/acceso-huesped", CRON);
    expect(ctx.rentasRepo.getMessagingOutbox().filter((o) => o.eventType === "reserva.acceso_huesped")).toHaveLength(0);
    acceso.pendientes[0] = { ...pendienteSinContacto(ctx), huespedContacto: CORREO };
    const r = await app.request("/internal/rentas/acceso-huesped", CRON);
    expect(await r.json()).toMatchObject({ liberadas: 1, omitidas_sin_contacto: 0 });
    expect(ctx.rentasRepo.getMessagingOutbox().filter((o) => o.eventType === "reserva.acceso_huesped")).toHaveLength(1);
  });
});
