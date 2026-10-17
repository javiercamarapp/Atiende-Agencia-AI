// Rn-P3-08 -- servicio de pre-check-in sobre el doble en memoria (que reproduce la maquina de estados de las funciones SQL de la migracion 036; la
// base real se prueba en scripts/verify-rentas-precheckin) y degradacion contra una base sin migrar con SAVEPOINT (AbortAwareFakeSession).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRentasPrecheckinRepository } from "../src/precheckin/in-memory-repository.ts";
import { PostgresRentasPrecheckinRepository } from "../src/precheckin/postgres-repository.ts";
import { capturarPrecheckin, verificarPrecheckin } from "../src/precheckin/servicio.ts";
import { hashToken } from "../src/precheckin/claves.ts";
import { AVISO_PRECHECKIN_VERSION, PRECHECKIN_MAX_FALLOS } from "../src/precheckin/tipos.ts";
import type { EntradaCaptura } from "../src/precheckin/validacion.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const AHORA = Date.parse("2026-09-14T12:00:00Z");

function fixture() {
  const repo = new InMemoryRentasPrecheckinRepository();
  repo.ahora = () => AHORA;
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  repo.sembrarPropiedad(propertyId, "Casa del Mar", "Gestora Sol");
  const reserva = (extra: Partial<Parameters<typeof repo.sembrarReserva>[0]> = {}) => {
    const ocupacionId = randomUUID();
    repo.sembrarReserva({ ocupacionId, organizationId, propertyId, codigo: "HMAB12CD34", ultimos4: "0123", checkIn: "2026-09-20", checkOut: "2026-09-23", unidadNombre: "Depa 1", ...extra });
    return ocupacionId;
  };
  const verificar = (codigo: string, ultimos4: string, pid = propertyId) => verificarPrecheckin(repo, pid, { codigo, ultimos4 });
  const captura = (token: string, extra: Partial<EntradaCaptura> = {}): EntradaCaptura => ({ token, correo: "huesped@example.com", whatsapp: null, aceptaPrivacidad: true, aceptaReglamento: false, ...extra });
  return { repo, organizationId, propertyId, reserva, verificar, captura };
}

describe("verificarPrecheckin", () => {
  it("codigo + 4 digitos correctos de una reserva confirmada y proxima: ok, con token y datos minimos de la estancia", async () => {
    const f = fixture();
    f.reserva();
    const r = await f.verificar("HMAB12CD34", "0123");
    expect(r).toMatchObject({ estado: "ok", propiedadNombre: "Casa del Mar", unidadNombre: "Depa 1", checkIn: "2026-09-20", checkOut: "2026-09-23", yaCapturado: false });
    if (r.estado === "ok") expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("telefono incorrecto, codigo inexistente, reserva pasada, cancelada u otra property: todos dan EXACTAMENTE el mismo resultado generico", async () => {
    const f = fixture();
    f.reserva();
    f.reserva({ codigo: "HMPAST0001", ultimos4: "1111", checkIn: "2026-09-01", checkOut: "2026-09-05" });
    f.reserva({ codigo: "HMCANC0001", ultimos4: "2222", estado: "cancelado" });
    const otra = randomUUID();
    f.repo.sembrarPropiedad(otra);
    f.repo.sembrarReserva({ ocupacionId: randomUUID(), organizationId: randomUUID(), propertyId: otra, codigo: "HMOTRA0001", ultimos4: "3333", checkIn: "2026-09-20", checkOut: "2026-09-22" });
    const resultados = await Promise.all([f.verificar("HMAB12CD34", "9999"), f.verificar("HMNOEXISTE1", "0123"), f.verificar("HMPAST0001", "1111"), f.verificar("HMCANC0001", "2222"), f.verificar("HMOTRA0001", "3333")]);
    for (const r of resultados) expect(r).toEqual({ estado: "invalido" });
  });

  it("el codigo se compara sin distinguir mayusculas y la property de la URL acota la busqueda", async () => {
    const f = fixture();
    f.reserva();
    expect((await verificarPrecheckin(f.repo, f.propertyId, { codigo: "hmab12cd34", ultimos4: "0123" })).estado).toBe("ok");
    const otra = randomUUID();
    f.repo.sembrarPropiedad(otra);
    expect(await f.verificar("HMAB12CD34", "0123", otra)).toEqual({ estado: "invalido" });
  });

  it(`${PRECHECKIN_MAX_FALLOS} fallos con el mismo codigo bloquean esa reserva: el siguiente intento, aun correcto, da bloqueado`, async () => {
    const f = fixture();
    f.reserva();
    for (let i = 0; i < PRECHECKIN_MAX_FALLOS - 1; i++) expect((await f.verificar("HMAB12CD34", "9999")).estado).toBe("invalido");
    // el 5to fallo ya bloquea (el resultado de ese intento sigue siendo el generico)...
    expect((await f.verificar("HMAB12CD34", "8888")).estado).toBe("invalido");
    // ...y el siguiente, con el telefono correcto, queda bloqueado.
    expect((await f.verificar("HMAB12CD34", "0123")).estado).toBe("bloqueado");
  });

  it("el bloqueo aplica igual a un codigo que NO existe (sin oraculo de existencia) y vence a la hora", async () => {
    const f = fixture();
    f.reserva();
    for (let i = 0; i < PRECHECKIN_MAX_FALLOS; i++) await f.verificar("HMNOEXISTE1", "0000");
    expect((await f.verificar("HMNOEXISTE1", "0000")).estado).toBe("bloqueado");
    // Reserva real bloqueada y luego el reloj avanza 61 minutos.
    for (let i = 0; i < PRECHECKIN_MAX_FALLOS; i++) await f.verificar("HMAB12CD34", "9999");
    expect((await f.verificar("HMAB12CD34", "0123")).estado).toBe("bloqueado");
    f.repo.ahora = () => AHORA + 61 * 60_000;
    expect((await f.verificar("HMAB12CD34", "0123")).estado).toBe("ok");
  });

  it("4 fallos no bloquean y un acierto reinicia el contador", async () => {
    const f = fixture();
    f.reserva();
    for (let i = 0; i < PRECHECKIN_MAX_FALLOS - 1; i++) await f.verificar("HMAB12CD34", "9999");
    expect((await f.verificar("HMAB12CD34", "0123")).estado).toBe("ok");
    for (let i = 0; i < PRECHECKIN_MAX_FALLOS - 1; i++) await f.verificar("HMAB12CD34", "9999");
    expect((await f.verificar("HMAB12CD34", "0123")).estado).toBe("ok");
  });

  it("la base solo recibe el HASH del token y de la clave: nunca el token ni el codigo en claro", async () => {
    const f = fixture();
    f.reserva();
    const r = await f.verificar("HMAB12CD34", "0123");
    if (r.estado !== "ok") throw new Error("se esperaba ok");
    expect([...f.repo.tokens.keys()]).toEqual([hashToken(r.token)]);
    expect([...f.repo.tokens.keys()][0]).not.toBe(r.token);
    f.reserva({ codigo: "HMZZ99YY88", ultimos4: "5555" });
    await f.verificar("HMZZ99YY88", "0000");
    for (const k of f.repo.intentos.keys()) expect(k).not.toContain("HMZZ99YY88");
  });

  it("contra la base sin la migracion 036: no_disponible (nunca lanza)", async () => {
    const f = fixture();
    f.reserva();
    f.repo.migracion036Disponible = false;
    expect(await f.verificar("HMAB12CD34", "0123")).toEqual({ estado: "no_disponible" });
  });
});

describe("capturarPrecheckin", () => {
  async function conToken(f: ReturnType<typeof fixture>, ocupacionId?: string) {
    const oc = ocupacionId ?? f.reserva();
    const v = await f.verificar("HMAB12CD34", "0123");
    if (v.estado !== "ok") throw new Error("se esperaba ok");
    return { token: v.token, oc };
  }

  it("guarda el correo como contacto del huesped, el WhatsApp y la evidencia de aceptacion con la version del aviso", async () => {
    const f = fixture();
    const { token, oc } = await conToken(f);
    const r = await capturarPrecheckin(f.repo, f.captura(token, { whatsapp: "9981234567" }));
    expect(r).toEqual({ estado: "ok" });
    expect(f.repo.contactos.get(oc)).toBe("huesped@example.com");
    expect(f.repo.capturas.get(oc)).toMatchObject({ whatsapp: "9981234567", avisoVersion: AVISO_PRECHECKIN_VERSION, reglamentoVersion: null });
  });

  it("el token es de UN SOLO USO", async () => {
    const f = fixture();
    const { token } = await conToken(f);
    expect(await capturarPrecheckin(f.repo, f.captura(token))).toEqual({ estado: "ok" });
    expect(await capturarPrecheckin(f.repo, f.captura(token, { correo: "otro@example.com" }))).toEqual({ estado: "token_invalido" });
  });

  it("un token inventado o vencido (15 min) no captura nada", async () => {
    const f = fixture();
    const { token, oc } = await conToken(f);
    expect(await capturarPrecheckin(f.repo, f.captura("B".repeat(43)))).toEqual({ estado: "token_invalido" });
    f.repo.ahora = () => AHORA + 16 * 60_000;
    expect(await capturarPrecheckin(f.repo, f.captura(token))).toEqual({ estado: "token_invalido" });
    expect(f.repo.capturas.has(oc)).toBe(false);
  });

  it("sin aceptar el aviso de privacidad no guarda y el token sigue sirviendo", async () => {
    const f = fixture();
    const { token, oc } = await conToken(f);
    expect(await capturarPrecheckin(f.repo, f.captura(token, { aceptaPrivacidad: false }))).toEqual({ estado: "privacidad_requerida" });
    expect(f.repo.capturas.has(oc)).toBe(false);
    expect(await capturarPrecheckin(f.repo, f.captura(token))).toEqual({ estado: "ok" });
  });

  it("si la property tiene reglamento, exige aceptarlo y guarda su version; sin reglamento no lo pide", async () => {
    const f = fixture();
    await f.repo.guardarReglamento(f.organizationId, f.propertyId, "No fiestas.", "u");
    await f.repo.guardarReglamento(f.organizationId, f.propertyId, "No fiestas ni mascotas.", "u");
    const { token, oc } = await conToken(f);
    expect(await capturarPrecheckin(f.repo, f.captura(token))).toEqual({ estado: "reglamento_requerido" });
    expect(f.repo.capturas.has(oc)).toBe(false);
    expect(await capturarPrecheckin(f.repo, f.captura(token, { aceptaReglamento: true }))).toEqual({ estado: "ok" });
    expect(f.repo.capturas.get(oc)?.reglamentoVersion).toBe(2);
  });

  it("no pisa un correo que el staff ya tenia (pero registra la captura) y no sobrescribe una captura previa", async () => {
    const f = fixture();
    const oc = f.reserva({ contacto: "staff@example.com" });
    const { token } = await conToken(f, oc);
    expect(await capturarPrecheckin(f.repo, f.captura(token, { correo: "nuevo@example.com" }))).toEqual({ estado: "ok" });
    expect(f.repo.contactos.get(oc)).toBe("staff@example.com");
    expect(f.repo.capturas.get(oc)?.correoGuardadoEnHuesped).toBe(false);

    const v2 = await f.verificar("HMAB12CD34", "0123");
    if (v2.estado !== "ok") throw new Error("se esperaba ok");
    expect(v2.yaCapturado).toBe(true);
    expect(await capturarPrecheckin(f.repo, f.captura(v2.token, { correo: "atacante@example.com" }))).toEqual({ estado: "ya_capturado" });
    expect(f.repo.capturas.get(oc)?.correo).toBe("nuevo@example.com");
  });

  it("una reserva cancelada despues de verificar ya no captura", async () => {
    const f = fixture();
    const { token, oc } = await conToken(f);
    f.repo.sembrarReserva({ ...f.repo.reservas.get(oc)!, estado: "cancelado" });
    expect(await capturarPrecheckin(f.repo, f.captura(token))).toEqual({ estado: "token_invalido" });
  });

  it("contra la base sin la migracion 036: no_disponible", async () => {
    const f = fixture();
    const { token } = await conToken(f);
    f.repo.migracion036Disponible = false;
    expect(await capturarPrecheckin(f.repo, f.captura(token))).toEqual({ estado: "no_disponible" });
  });
});

describe("reglamento (staff)", () => {
  it("la version solo sube cuando el texto cambia", async () => {
    const f = fixture();
    expect((await f.repo.guardarReglamento("o", f.propertyId, "A", "u")).disponible).toBe(true);
    const igual = await f.repo.guardarReglamento("o", f.propertyId, "A", "u");
    expect(igual.disponible && igual.valor.reglamentoVersion).toBe(1);
    const cambio = await f.repo.guardarReglamento("o", f.propertyId, "B", "u");
    expect(cambio.disponible && cambio.valor.reglamentoVersion).toBe(2);
    const quitar = await f.repo.guardarReglamento("o", f.propertyId, null, "u");
    expect(quitar.disponible && quitar.valor).toMatchObject({ reglamento: null, reglamentoVersion: 3 });
  });
});

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("PostgresRentasPrecheckinRepository -- base sin migrar (SAVEPOINT; AbortAwareFakeSession)", () => {
  const SIGUIENTE = { match: /select 1 as siguiente/i, respond: () => [{ ok: true }] };

  it.each([
    ["42883", /precheckin_verificar/i, (r: PostgresRentasPrecheckinRepository) => r.verificar("p", "HM1", "0123", "a".repeat(64), "b".repeat(64))],
    ["42883", /precheckin_info/i, (r: PostgresRentasPrecheckinRepository) => r.obtenerInfo("p")],
    ["42883", /precheckin_capturar/i, (r: PostgresRentasPrecheckinRepository) => r.capturar({ tokenHash: "a".repeat(64), correo: "a@b.co", whatsapp: null, aceptaPrivacidad: true, avisoVersion: "v1", aceptaReglamento: false })],
    ["42P01", /precheckin_config/i, (r: PostgresRentasPrecheckinRepository) => r.obtenerConfig("p")],
    ["42P01", /insert into rentas\.precheckin_config/i, (r: PostgresRentasPrecheckinRepository) => r.guardarReglamento("o", "p", "x", "u")],
  ])("%s en %s -> disponible:false y la transaccion sigue utilizable (ROLLBACK TO SAVEPOINT)", async (codigo, patron, operacion) => {
    const session = new AbortAwareFakeSession([{ match: patron, respond: () => pgError(codigo, codigo === "42883" ? "function rentas.precheckin_x(uuid, text) does not exist" : "relation does not exist") }, SIGUIENTE]);
    const repo = new PostgresRentasPrecheckinRepository(session);
    await expect(operacion(repo)).resolves.toEqual({ disponible: false });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1 as siguiente")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("un error que NO es de migracion (deadlock) se propaga", async () => {
    const session = new AbortAwareFakeSession([{ match: /precheckin_verificar/i, respond: () => pgError("40P01", "deadlock") }]);
    await expect(new PostgresRentasPrecheckinRepository(session).verificar("p", "HM1", "0123", "a".repeat(64), "b".repeat(64))).rejects.toThrow("deadlock");
  });

  it("mapea la fila de verificar y el resultado de capturar", async () => {
    const session = new AbortAwareFakeSession([
      { match: /precheckin_verificar/i, respond: () => [{ resultado: "ok", propiedad_nombre: "Casa", unidad_nombre: "U1", check_in: "2026-09-20", check_out: "2026-09-23", ya_capturado: true, token_expira_en: "2026-09-14 12:15:00+00" }] },
      { match: /precheckin_capturar/i, respond: () => [{ resultado: "reglamento_requerido" }] },
    ]);
    const repo = new PostgresRentasPrecheckinRepository(session);
    await expect(repo.verificar("p", "HM1", "0123", "a".repeat(64), "b".repeat(64))).resolves.toEqual({
      disponible: true,
      valor: { resultado: "ok", propiedadNombre: "Casa", unidadNombre: "U1", checkIn: "2026-09-20", checkOut: "2026-09-23", yaCapturado: true, tokenExpiraEn: "2026-09-14 12:15:00+00" },
    });
    await expect(repo.capturar({ tokenHash: "a".repeat(64), correo: "a@b.co", whatsapp: null, aceptaPrivacidad: true, avisoVersion: "v1", aceptaReglamento: false })).resolves.toEqual({ disponible: true, valor: { resultado: "reglamento_requerido" } });
  });
});
