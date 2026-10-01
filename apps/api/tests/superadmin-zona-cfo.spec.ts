// Zona CFO segura (SA-41): rol `finanzas` de solo lectura, step-up obligatorio, bitacora de cada consulta
// financiera y cierre en falso, de punta a punta contra los repos en memoria (la autorizacion real en SQL
// se verifica en scripts/verify-superadmin-zona-cfo/ contra Postgres real).
import { afterEach, describe, expect, it, vi } from "vitest";
import { signAccessToken, totpAt } from "@atiende/core-auth";
import { InMemoryCfoRepository, InMemoryCfoZoneRepository, InMemoryPylRepository } from "@atiende/db";
import type { CfoOrgRow } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { SENSITIVE_ROUTES, isSensitiveRoute } from "../src/superadmin-seguridad/step-up.ts";
import { RUTAS_FINANCIERAS } from "../src/superadmin-seguridad/zona-cfo.ts";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

afterEach(() => vi.useRealTimers());

const T0 = new Date("2026-09-30T12:00:00.000Z").getTime();
const MOTIVO = "Rol de solo lectura para la contadora externa del trimestre.";

function fakeTime(ms: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
}

const FILA: CfoOrgRow = {
  organizationId: "org-a", organizationName: "Org A", organizationSlug: "org-a", vertical: "restaurantes", orgStatus: "active",
  planId: "restaurantes-estandar", planNombre: "Restaurantes", precioBaseCentavos: 0, precioAsientoCentavos: 79900, asientosIncluidos: 1,
  billingStatus: null, billingSeats: null, sucursalesActivas: 3,
  llmMicroUsd: 4_000_000, vozMicroUsd: 0, whatsappMicroUsd: 0, telefoniaMicroUsd: 0, otrosMicroUsd: 0,
  eventosTotal: 0, eventosEstimados: 0, minutosVoz: 0, mensajes: 0, llmCapMicroUsd: 900_000_000, llmAlertPct: 80,
  billingPeriodEndMs: null, limites: [], mxnPorUsd: 20, fxFecha: "2026-09-01", fxFuente: "Banxico FIX",
};

async function setup(opciones: { zona?: InMemoryCfoZoneRepository | null } = {}) {
  const s = await seguridadSetup();
  const zona = opciones.zona === undefined ? new InMemoryCfoZoneRepository() : opciones.zona;
  const cfo = new InMemoryCfoRepository();
  cfo.seedRows([FILA]);
  const pyl = new InMemoryPylRepository({ now: () => T0 });
  const deps = { ...s.deps, cfoRepo: () => cfo, pylRepo: () => pyl, ...(zona ? { cfoZoneRepo: () => zona } : {}) };
  const app = buildApp(deps);
  const dashboard = vi.spyOn(cfo, "getDashboardRows");
  return {
    s, zona, cfo, pyl, app, dashboard, deps,
    async superadmin() {
      const sa = await s.superadmin();
      cfo.seedSuperadmin(sa.id);
      pyl.seedSuperadmin(sa.id);
      zona?.seedSuperadmin(sa.id, sa.email);
      return sa;
    },
    /** Superadmin restringido a `finanzas` (rol sembrado como lo dejaria `cfo_zone_set_role`). */
    async finanzas() {
      const sa = await s.superadmin();
      cfo.seedSuperadmin(sa.id);
      pyl.seedSuperadmin(sa.id);
      zona?.seedSuperadmin(sa.id, sa.email);
      zona?.seedRole(sa.id);
      return sa;
    },
    /** Enrola y activa el factor del usuario; devuelve su step-up. */
    async activarMfa(sa: { token: string }) {
      const enr = await app.request("/superadmin/mfa/enrolar", jsonRequestInit({}, bearer(sa.token)));
      expect(enr.status).toBe(201);
      const { secreto } = (await enr.json()) as { secreto: string };
      const ver = await app.request("/superadmin/mfa/verificar", jsonRequestInit({ codigo: totpAt(secreto, Date.now()) }, bearer(sa.token)));
      expect(ver.status).toBe(200);
      return ((await ver.json()) as { stepUpToken: string }).stepUpToken;
    },
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const get = (ctx: Ctx, path: string, token: string, stepUp?: string) => ctx.app.request(path, { headers: bearer(token, stepUp ? { "x-stepup-token": stepUp } : {}) });
const send = (ctx: Ctx, method: string, path: string, body: unknown, token: string, stepUp?: string) =>
  ctx.app.request(path, { ...jsonRequestInit(body, bearer(token, stepUp ? { "x-stepup-token": stepUp } : {})), method });

describe("zona CFO -- bitacora de cada consulta financiera", () => {
  it("un superadmin sin MFA lee el dashboard (comportamiento anterior) y la consulta queda registrada con quien, rol, recurso y filtros", async () => {
    fakeTime(T0);
    const ctx = await setup();
    const sa = await ctx.superadmin();
    const res = await get(ctx, "/superadmin/cfo/dashboard?mes=2026-09&umbralMargenPct=30", sa.token);
    expect(res.status).toBe(200);
    const [e, ...resto] = ctx.zona!.entries();
    expect(resto).toHaveLength(0);
    expect(e).toMatchObject({ actorUserId: sa.id, actorRol: "superadmin", accion: "consulta", recurso: "cfo/dashboard", occurredAtMs: T0 });
    expect(e!.filtros).toMatchObject({ mes: "2026-09", umbralMargenPct: "30", _ruta: "/superadmin/cfo/dashboard" });
  });

  it("los filtros guardan solo parametros de consulta saneados: nada con forma de secreto, claves invalidas ni valores largos", async () => {
    const ctx = await setup();
    const sa = await ctx.superadmin();
    const largo = "x".repeat(500);
    await get(ctx, `/superadmin/cfo/dashboard?mes=2026-09&token=abc&api_key=zzz&Authorization=q&${encodeURIComponent("a b")}=1&largo=${largo}`, sa.token);
    const f = ctx.zona!.entries()[0]!.filtros;
    expect(Object.keys(f).sort()).toEqual(["_ruta", "largo", "mes"]);
    expect(String(f.largo)).toHaveLength(120);
  });

  it("cada lectura financiera de la lista deja su huella y un recurso fuera de la lista (organizaciones) no", async () => {
    const ctx = await setup();
    const sa = await ctx.superadmin();
    for (const p of ["/superadmin/pyl?mes=2026-09", "/superadmin/costos/resumen", "/superadmin/planes", "/superadmin/gasto-api/resumen", "/superadmin/facturacion/resumen"]) {
      await get(ctx, p, sa.token);
    }
    expect(ctx.zona!.entries().map((e) => e.recurso)).toEqual(["pyl", "costos/resumen", "planes", "gasto-api", "facturacion"]);
    await get(ctx, "/superadmin/organizations", sa.token);
    expect(ctx.zona!.entries()).toHaveLength(5);
  });

  it("CIERRE EN FALSO: si el registro falla la consulta NO se ejecuta (503) y no hay lectura sin huella", async () => {
    const ctx = await setup();
    const sa = await ctx.superadmin();
    ctx.zona!.fallarAlRegistrar = true;
    const res = await get(ctx, "/superadmin/cfo/dashboard", sa.token);
    expect(res.status).toBe(503);
    expect(ctx.dashboard).not.toHaveBeenCalled();
  });

  it("si no se puede resolver el rol (error que no es de migracion) la consulta NO se ejecuta", async () => {
    const ctx = await setup();
    const sa = await ctx.superadmin();
    ctx.zona!.fallarAlResolver = true;
    const res = await get(ctx, "/superadmin/cfo/dashboard", sa.token);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(ctx.dashboard).not.toHaveBeenCalled();
  });

  it("un staff normal sigue en 403 por el gateo de superadmin y no deja huella en la bitacora de la zona", async () => {
    const ctx = await setup();
    const st = await ctx.s.staff();
    expect((await get(ctx, "/superadmin/cfo/dashboard", st.token)).status).toBe(403);
    expect(ctx.zona!.entries()).toHaveLength(0);
  });
});

describe("zona CFO -- step-up en las lecturas financieras", () => {
  it("superadmin CON factor activo: sin step-up 403 stepup_required (y queda 'denegado'); con step-up 200", async () => {
    fakeTime(T0);
    const ctx = await setup();
    const sa = await ctx.superadmin();
    const stepUp = await ctx.activarMfa(sa);
    const sin = await get(ctx, "/superadmin/cfo/dashboard", sa.token);
    expect(sin.status).toBe(403);
    expect(await sin.json()).toMatchObject({ code: "stepup_required" });
    expect(ctx.zona!.entries().map((e) => e.accion)).toEqual(["denegado"]);
    expect(ctx.dashboard).not.toHaveBeenCalled();
    expect((await get(ctx, "/superadmin/cfo/dashboard", sa.token, stepUp)).status).toBe(200);
    expect(ctx.zona!.entries().map((e) => e.accion)).toEqual(["denegado", "consulta"]);
  });

  it("EXPORTAR el P&L exige step-up: sin el, 403 y 'denegado'; con el, 200 y queda como 'exportacion'", async () => {
    fakeTime(T0);
    const ctx = await setup();
    const sa = await ctx.superadmin();
    const stepUp = await ctx.activarMfa(sa);
    const sin = await get(ctx, "/superadmin/pyl/export.csv?mes=2026-09&nivel=vertical", sa.token);
    expect(sin.status).toBe(403);
    const con = await get(ctx, "/superadmin/pyl/export.csv?mes=2026-09&nivel=vertical", sa.token, stepUp);
    expect(con.status).toBe(200);
    expect(con.headers.get("content-type")).toContain("text/csv");
    expect(ctx.zona!.entries().map((e) => `${e.accion}:${e.recurso}`)).toEqual(["denegado:GET pyl/export.csv (sin step-up)", "exportacion:pyl/export.csv"]);
    expect(isSensitiveRoute("GET", "/superadmin/pyl/export.csv")).toBe(true);
  });

  it("REPLAY: el step-up de OTRO usuario, el de otra sesion (otro access token) y uno vencido no sirven", async () => {
    fakeTime(T0);
    const ctx = await setup();
    const ana = await ctx.superadmin();
    const beto = await ctx.finanzas();
    const deAna = await ctx.activarMfa(ana);
    const deBeto = await ctx.activarMfa(beto);

    // 1) el token de Ana presentado por Beto (finanzas)
    const ajeno = await get(ctx, "/superadmin/cfo/dashboard", beto.token, deAna);
    expect(ajeno.status).toBe(403);
    expect(await ajeno.json()).toMatchObject({ code: "stepup_required" });

    // 2) el token de Beto con OTRO access token de Beto (sesion distinta)
    const otraSesion = await signAccessToken({ sub: beto.id, org_id: "", vertical: "restaurantes", property_ids: null, email: beto.email }, ctx.deps.env.jwtSecret, 901);
    expect((await get(ctx, "/superadmin/cfo/dashboard", otraSesion, deBeto)).status).toBe(403);

    // 3) token manipulado
    expect((await get(ctx, "/superadmin/cfo/dashboard", beto.token, "no.es.un-jwt")).status).toBe(403);

    // 4) vencido (> 5 min) con el access token todavia vigente
    expect((await get(ctx, "/superadmin/cfo/dashboard", beto.token, deBeto)).status).toBe(200);
    fakeTime(T0 + 6 * 60_000);
    const vencido = await get(ctx, "/superadmin/cfo/dashboard", beto.token, deBeto);
    expect(vencido.status).toBe(403);
    expect(await vencido.json()).toMatchObject({ code: "stepup_required" });

    // ningun intento fallido ejecuto el handler: solo la lectura valida
    expect(ctx.dashboard).toHaveBeenCalledTimes(1);
    expect(ctx.zona!.entries().filter((e) => e.accion === "consulta")).toHaveLength(1);
  });
});

describe("zona CFO -- rol finanzas de solo lectura", () => {
  it("MFA OBLIGATORIA: sin factor activo el rol finanzas no entra (403 mfa_enrollment_required) aunque la MFA global no sea obligatoria", async () => {
    const ctx = await setup();
    const fin = await ctx.finanzas();
    const res = await get(ctx, "/superadmin/cfo/dashboard", fin.token);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "mfa_enrollment_required" });
    expect(ctx.dashboard).not.toHaveBeenCalled();
    expect(ctx.zona!.entries().map((e) => e.accion)).toEqual(["denegado"]);
  });

  it("MFA obligatoria y SIN repositorio MFA (o migracion 0025 sin aplicar): falla cerrado con 503, no se degrada a 'sin MFA'", async () => {
    const ctx = await setup();
    const fin = await ctx.finanzas();
    const app = buildApp({ ...ctx.deps, mfaRepo: undefined });
    const res = await app.request("/superadmin/cfo/dashboard", { headers: bearer(fin.token) });
    expect(res.status).toBe(503);
    expect(ctx.dashboard).not.toHaveBeenCalled();
  });

  it("con step-up valido lee las pantallas financieras permitidas y cada consulta queda con rol finanzas", async () => {
    fakeTime(T0);
    const ctx = await setup();
    const fin = await ctx.finanzas();
    const stepUp = await ctx.activarMfa(fin);
    for (const p of ["/superadmin/cfo/dashboard?mes=2026-09", "/superadmin/pyl?mes=2026-09", "/superadmin/costos/resumen", "/superadmin/planes", "/superadmin/gasto-api/resumen"]) {
      const res = await get(ctx, p, fin.token, stepUp);
      expect(res.status, p).toBe(200);
    }
    const e = ctx.zona!.entries();
    expect(e).toHaveLength(5);
    expect(e.every((x) => x.actorUserId === fin.id && x.actorRol === "finanzas" && x.accion === "consulta")).toBe(true);
  });

  it("es de SOLO LECTURA: ninguna escritura ni ruta ajena a lo financiero, ni siquiera con step-up valido (403 rol_finanzas_solo_lectura + 'denegado')", async () => {
    fakeTime(T0);
    const ctx = await setup();
    const fin = await ctx.finanzas();
    const stepUp = await ctx.activarMfa(fin);
    const intentos: Array<[string, string, unknown]> = [
      ["PUT", "/superadmin/planes/restaurantes-estandar", { nombre: "x" }],
      ["PUT", "/superadmin/pyl/infra", { mes: "2026-09", concepto: "Vercel", montoMxn: 100 }],
      ["PUT", "/superadmin/costos/tipo-cambio", { mxnPorUsd: 20 }],
      ["PUT", "/superadmin/gasto-api/plataforma/tope", { topeMicroUsd: 1 }],
      ["POST", "/superadmin/impersonacion/sesiones", {}],
      ["POST", "/superadmin/break-glass/sesiones", {}],
      ["PUT", "/superadmin/interruptores", {}],
      ["POST", "/superadmin/prospectos", { empresa: "x", vertical: "hoteles" }],
      ["PUT", "/superadmin/zona-cfo/roles/00000000-0000-4000-8000-000000000001", { rol: null, motivo: MOTIVO }],
    ];
    for (const [m, p, b] of intentos) {
      const res = await send(ctx, m, p, b, fin.token, stepUp);
      expect(res.status, `${m} ${p}`).toBe(403);
      expect(await res.json(), `${m} ${p}`).toMatchObject({ code: "rol_finanzas_solo_lectura" });
    }
    for (const p of ["/superadmin/organizations", "/superadmin/prospectos", "/superadmin/zona-cfo/bitacora", "/superadmin/zona-cfo/roles", "/superadmin/facturacion/webhooks-recientes", "/superadmin/seguridad/bitacora"]) {
      const res = await get(ctx, p, fin.token, stepUp);
      expect(res.status, p).toBe(403);
      expect(await res.json(), p).toMatchObject({ code: "rol_finanzas_solo_lectura" });
    }
    expect(ctx.zona!.entries().filter((e) => e.accion !== "denegado")).toHaveLength(0);
    expect(ctx.zona!.entries()).toHaveLength(intentos.length + 6);
    expect(ctx.dashboard).not.toHaveBeenCalled();
  });

  it("la lista blanca no se esquiva con variantes de ruta (barra final, mayusculas, percent-encoding)", async () => {
    fakeTime(T0);
    const ctx = await setup();
    const fin = await ctx.finanzas();
    const stepUp = await ctx.activarMfa(fin);
    for (const p of ["/superadmin/prospectos/", "/SUPERADMIN/prospectos", "/superadmin/%70rospectos", "/superadmin/./prospectos"]) {
      const res = await get(ctx, p, fin.token, stepUp);
      expect([403, 404], p).toContain(res.status);
      expect(res.status === 403 || res.status === 404).toBe(true);
    }
    expect(ctx.zona!.entries().filter((e) => e.accion === "consulta")).toHaveLength(0);
  });

  it("autoservicio: puede ver su estado, enrolar y verificar su MFA para poder entrar; el estado dice que es solo lectura", async () => {
    fakeTime(T0);
    const ctx = await setup();
    const fin = await ctx.finanzas();
    const antes = await (await get(ctx, "/superadmin/zona-cfo/estado", fin.token)).json();
    expect(antes).toEqual({ disponible: true, rol: "finanzas", soloLectura: true, mfaObligatoria: true });
    expect((await get(ctx, "/superadmin/mfa/estado", fin.token)).status).toBe(200);
    const stepUp = await ctx.activarMfa(fin);
    expect(stepUp.split(".")).toHaveLength(3);
    expect(ctx.zona!.entries()).toHaveLength(0);
  });
});

describe("zona CFO -- asignar y retirar el rol finanzas", () => {
  const UUID_X = "00000000-0000-4000-8000-0000000000aa";

  it("un superadmin completo asigna el rol: el destino pasa a solo lectura y queda en la bitacora; retirarlo lo devuelve a completo", async () => {
    const ctx = await setup();
    const jefe = await ctx.superadmin();
    const otro = await ctx.superadmin();
    const res = await send(ctx, "PUT", `/superadmin/zona-cfo/roles/${otro.id}`, { rol: "finanzas", motivo: MOTIVO }, jefe.token);
    expect(res.status).toBe(200);
    expect(await (await get(ctx, "/superadmin/zona-cfo/estado", otro.token)).json()).toMatchObject({ rol: "finanzas", soloLectura: true });
    const roles = (await (await get(ctx, "/superadmin/zona-cfo/roles", jefe.token)).json()) as { roles: Array<{ usuarioId: string; rol: string }> };
    expect(roles.roles).toMatchObject([{ usuarioId: otro.id, rol: "finanzas" }]);
    const bit = (await (await get(ctx, "/superadmin/zona-cfo/bitacora", jefe.token)).json()) as { entradas: Array<{ accion: string; actorUserId: string }> };
    expect(bit.entradas.map((e) => e.accion)).toContain("rol_asignado");

    expect((await send(ctx, "PUT", `/superadmin/zona-cfo/roles/${otro.id}`, { rol: null, motivo: MOTIVO }, jefe.token)).status).toBe(200);
    expect(await (await get(ctx, "/superadmin/zona-cfo/estado", otro.token)).json()).toMatchObject({ rol: "superadmin", soloLectura: false });
  });

  it("validaciones: rol invalido, motivo corto, uuid malo, uno mismo y destino que no es superadmin", async () => {
    const ctx = await setup();
    const jefe = await ctx.superadmin();
    const otro = await ctx.superadmin();
    const put = (id: string, body: unknown) => send(ctx, "PUT", `/superadmin/zona-cfo/roles/${id}`, body, jefe.token);
    expect((await put(otro.id, { rol: "dios", motivo: MOTIVO })).status).toBe(400);
    expect((await put(otro.id, { motivo: MOTIVO })).status).toBe(400);
    expect((await put(otro.id, { rol: "finanzas", motivo: "corto" })).status).toBe(400);
    expect((await put("no-es-uuid", { rol: "finanzas", motivo: MOTIVO })).status).toBe(400);
    expect((await put(jefe.id, { rol: "finanzas", motivo: MOTIVO })).status).toBe(400);
    expect((await put(UUID_X, { rol: "finanzas", motivo: MOTIVO })).status).toBe(400);
  });

  it("staff normal 403; quien ya es finanzas no puede asignar roles (ni quitarse el suyo)", async () => {
    const ctx = await setup();
    const fin = await ctx.finanzas();
    const otro = await ctx.superadmin();
    const st = await ctx.s.staff();
    expect((await send(ctx, "PUT", `/superadmin/zona-cfo/roles/${otro.id}`, { rol: "finanzas", motivo: MOTIVO }, st.token)).status).toBe(403);
    expect((await send(ctx, "PUT", `/superadmin/zona-cfo/roles/${otro.id}`, { rol: "finanzas", motivo: MOTIVO }, fin.token)).status).toBe(403);
    expect((await send(ctx, "PUT", `/superadmin/zona-cfo/roles/${fin.id}`, { rol: null, motivo: MOTIVO }, fin.token)).status).toBe(403);
    expect(await (await get(ctx, "/superadmin/zona-cfo/estado", fin.token)).json()).toMatchObject({ rol: "finanzas" });
  });

  it("con MFA activa, asignar el rol exige step-up", async () => {
    fakeTime(T0);
    const ctx = await setup();
    const jefe = await ctx.superadmin();
    const otro = await ctx.superadmin();
    const stepUp = await ctx.activarMfa(jefe);
    const sin = await send(ctx, "PUT", `/superadmin/zona-cfo/roles/${otro.id}`, { rol: "finanzas", motivo: MOTIVO }, jefe.token);
    expect(sin.status).toBe(403);
    expect((await send(ctx, "PUT", `/superadmin/zona-cfo/roles/${otro.id}`, { rol: "finanzas", motivo: MOTIVO }, jefe.token, stepUp)).status).toBe(200);
  });

  it("la bitacora pagina con limite y antesDeSeq y valida sus parametros", async () => {
    const ctx = await setup();
    const sa = await ctx.superadmin();
    for (let i = 0; i < 4; i++) await get(ctx, `/superadmin/cfo/dashboard?mes=2026-0${i + 1}`, sa.token);
    const p1 = (await (await get(ctx, "/superadmin/zona-cfo/bitacora?limite=2", sa.token)).json()) as { entradas: Array<{ seq: number }>; siguienteAntesDeSeq: number | null };
    expect(p1.entradas).toHaveLength(2);
    expect(p1.siguienteAntesDeSeq).toBe(p1.entradas[1]!.seq);
    const p2 = (await (await get(ctx, `/superadmin/zona-cfo/bitacora?limite=2&antesDeSeq=${p1.siguienteAntesDeSeq}`, sa.token)).json()) as { entradas: Array<{ seq: number }> };
    expect(p2.entradas.every((e) => e.seq < p1.entradas[1]!.seq)).toBe(true);
    expect((await get(ctx, "/superadmin/zona-cfo/bitacora?limite=0", sa.token)).status).toBe(400);
    expect((await get(ctx, "/superadmin/zona-cfo/bitacora?limite=1e2", sa.token)).status).toBe(400);
    expect((await get(ctx, "/superadmin/zona-cfo/bitacora?antesDeSeq=-1", sa.token)).status).toBe(400);
  });
});

describe("zona CFO -- compatibilidad con la base sin migrar", () => {
  it("0034 sin aplicar: el dashboard responde como antes (200), sin bitacora; estado/bitacora/roles dicen 'no disponible' y asignar es 503 (nunca 500)", async () => {
    const ctx = await setup({ zona: new InMemoryCfoZoneRepository({ migrado: false }) });
    const sa = await ctx.superadmin();
    const dash = await get(ctx, "/superadmin/cfo/dashboard", sa.token);
    expect(dash.status).toBe(200);
    expect(await dash.json()).toMatchObject({ disponible: true });
    expect(ctx.zona!.entries()).toHaveLength(0);
    expect(await (await get(ctx, "/superadmin/zona-cfo/estado", sa.token)).json()).toMatchObject({ disponible: false, rol: null });
    expect(await (await get(ctx, "/superadmin/zona-cfo/bitacora", sa.token)).json()).toMatchObject({ disponible: false, entradas: [] });
    expect(await (await get(ctx, "/superadmin/zona-cfo/roles", sa.token)).json()).toMatchObject({ disponible: false, roles: [] });
    expect((await send(ctx, "PUT", "/superadmin/zona-cfo/roles/00000000-0000-4000-8000-0000000000bb", { rol: "finanzas", motivo: MOTIVO }, sa.token)).status).toBe(503);
  });

  it("sin cfoZoneRepo en el despliegue pasa lo mismo", async () => {
    const ctx = await setup({ zona: null });
    const sa = await ctx.superadmin();
    expect((await get(ctx, "/superadmin/cfo/dashboard", sa.token)).status).toBe(200);
    expect(await (await get(ctx, "/superadmin/zona-cfo/estado", sa.token)).json()).toMatchObject({ disponible: false });
    expect((await send(ctx, "PUT", "/superadmin/zona-cfo/roles/00000000-0000-4000-8000-0000000000bb", { rol: "finanzas", motivo: MOTIVO }, sa.token)).status).toBe(503);
  });
});

describe("zona CFO -- listas de rutas", () => {
  it("las rutas sensibles nuevas estan en SENSITIVE_ROUTES y cada ruta financiera marcada finanzas es de lectura (GET) con patron anclado", () => {
    expect(SENSITIVE_ROUTES.filter((r) => r.pattern.source.includes("zona-cfo")).length).toBeGreaterThanOrEqual(3);
    for (const r of RUTAS_FINANCIERAS) {
      expect(r.pattern.source.startsWith("^")).toBe(true);
      expect(r.pattern.source.endsWith("$")).toBe(true);
    }
    expect(isSensitiveRoute("PUT", "/superadmin/zona-cfo/roles/abc")).toBe(true);
    expect(isSensitiveRoute("GET", "/superadmin/zona-cfo/bitacora")).toBe(true);
  });
});
