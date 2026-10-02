// Rn-29 -- cifrado en reposo de las instrucciones de acceso: ida y vuelta, rechazo con llave invalida, ligadura de la AAD,
// la base solo recibe sobres (nunca texto plano), bitacora de lecturas, liberacion al huesped con sobre y barrido idempotente.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import {
  AccesoDescifradoError,
  AccesoNoDisponibleError,
  InMemoryRentasAccesoRepository,
  PostgresRentasAccesoRepository,
  accesoAad,
  createAccesoCipher,
  ejecutarLiberacionAcceso,
  parseAccesoKey,
  resolverCipherAcceso,
} from "../../src/index.ts";
import type { WithLiberacionTx } from "../../src/index.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

const KEY = Buffer.alloc(32, 7);
const OTRA = Buffer.alloc(32, 9);
const SOBRE_RE = /^v[0-9]{1,3}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]*$/;
const U = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";
const CODIGO = "PIN-4821#";
const DIRECCION = "Calle 60 #123, Centro, Mérida";

describe("cifrador AES-256-GCM", () => {
  it("ida y vuelta (incluye acentos) y el sobre cumple el CHECK de la migracion 028", () => {
    const c = createAccesoCipher(KEY, 3);
    const aad = accesoAad(U, P, "direccion");
    const sobre = c.encrypt(DIRECCION, aad);
    expect(sobre).toMatch(SOBRE_RE);
    expect(sobre.startsWith("v3.")).toBe(true);
    expect(sobre).not.toContain("Mérida");
    expect(c.decrypt(sobre, aad)).toBe(DIRECCION);
    // dos cifrados del mismo texto no coinciden (iv aleatorio)
    expect(c.encrypt(DIRECCION, aad)).not.toBe(sobre);
  });

  it("valores cortos de 1 y 2 caracteres dan un sobre valido para el CHECK y hacen ida y vuelta (sin relleno, el texto cifrado mide lo mismo que el plano)", () => {
    const c = createAccesoCipher(KEY);
    for (const [campo, corto] of [["codigo", "7"], ["codigo", "12"], ["instrucciones", "ok"], ["direccion", "a"]] as const) {
      const aad = accesoAad(U, P, campo);
      const sobre = c.encrypt(corto, aad);
      expect(sobre).toMatch(SOBRE_RE);
      expect(sobre.split(".")[3]!.length).toBeLessThan(4);
      expect(c.decrypt(sobre, aad)).toBe(corto);
    }
  });

  it("rechaza una llave invalida y distingue 'sin llave' de 'llave mal formada'", () => {
    expect(parseAccesoKey(undefined)).toBeNull();
    expect(parseAccesoKey("  ")).toBeNull();
    expect(() => parseAccesoKey("corta")).toThrowError(AccesoNoDisponibleError);
    expect(() => parseAccesoKey("no es base64 !!")).toThrowError(AccesoNoDisponibleError);
    expect(() => parseAccesoKey(Buffer.alloc(16, 1).toString("base64"))).toThrowError(AccesoNoDisponibleError);
    expect(() => createAccesoCipher(Buffer.alloc(31))).toThrowError(AccesoNoDisponibleError);
    expect(() => createAccesoCipher(KEY, 0)).toThrowError(AccesoNoDisponibleError);
    expect(resolverCipherAcceso(KEY.toString("base64"), 1)?.keyVersion).toBe(1);
    expect(resolverCipherAcceso(null, 1)).toBeNull();
  });

  it("la AAD liga el sobre a unidad, property y campo; una llave distinta, un sobre alterado o una version ajena fallan", () => {
    const c = createAccesoCipher(KEY);
    const sobre = c.encrypt(CODIGO, accesoAad(U, P, "codigo"));
    expect(() => c.decrypt(sobre, accesoAad(U, P, "direccion"))).toThrowError(AccesoDescifradoError);
    expect(() => c.decrypt(sobre, accesoAad("33333333-3333-4333-8333-333333333333", P, "codigo"))).toThrowError(AccesoDescifradoError);
    expect(() => c.decrypt(sobre, accesoAad(U, "44444444-4444-4444-8444-444444444444", "codigo"))).toThrowError(AccesoDescifradoError);
    expect(() => createAccesoCipher(OTRA).decrypt(sobre, accesoAad(U, P, "codigo"))).toThrowError(AccesoDescifradoError);
    const partes = sobre.split(".");
    expect(() => c.decrypt(`${partes[0]}.${partes[1]}.${partes[2]}.${partes[3]!.slice(0, -2)}AA`, accesoAad(U, P, "codigo"))).toThrowError(AccesoDescifradoError);
    expect(() => c.decrypt("no-es-un-sobre", accesoAad(U, P, "codigo"))).toThrowError(AccesoDescifradoError);
    expect(() => createAccesoCipher(KEY, 2).decrypt(sobre, accesoAad(U, P, "codigo"))).toThrowError(AccesoNoDisponibleError);
  });
});

/** Sesion que registra SQL y parametros y responde por regex (sin semantica de transaccion abortada). */
function sesionGrabadora(respuestas: readonly { match: RegExp; rows: unknown[] }[]) {
  const llamadas: { sql: string; params: unknown[] }[] = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      llamadas.push({ sql, params });
      return { rows: respuestas.find((r) => r.match.test(sql))?.rows ?? [] };
    },
    async exec() {},
  } as unknown as TenantDbSession;
  return { db, llamadas };
}

describe("PostgresRentasAccesoRepository: la base solo recibe sobres", () => {
  it("guardarInstruccion cifra cada campo, anula el texto plano y registra la escritura; ningun parametro lleva el secreto", async () => {
    const { db, llamadas } = sesionGrabadora([{ match: /from rentas\.unidad/, rows: [{ "?column?": 1 }] }]);
    const repo = new PostgresRentasAccesoRepository(db, createAccesoCipher(KEY, 2));
    const r = await repo.guardarInstruccion("o1", P, U, { direccionExacta: DIRECCION, codigoAcceso: CODIGO, instrucciones: null }, "a1");
    expect(r).toEqual({ disponible: true, valor: { unidadId: U, direccionExacta: DIRECCION, codigoAcceso: CODIGO, instrucciones: null } });
    const insert = llamadas.find((l) => /insert into rentas\.acceso_instruccion/.test(l.sql))!;
    expect(insert.sql).toMatch(/direccion_exacta = null, codigo_acceso = null, instrucciones = null/);
    expect(insert.sql).not.toMatch(/insert into rentas\.acceso_instruccion \([^)]*direccion_exacta/);
    const [, , , dir, cod, ins, version] = insert.params as [string, string, string, string, string, string | null, number];
    expect(dir).toMatch(SOBRE_RE);
    expect(cod).toMatch(SOBRE_RE);
    expect(ins).toBeNull();
    expect(version).toBe(2);
    const todo = JSON.stringify(llamadas);
    expect(todo).not.toContain(CODIGO);
    expect(todo).not.toContain("Mérida");
    expect(llamadas.some((l) => /acceso_instruccion_registrar\(\$1::uuid, 'escritura_admin'\)/.test(l.sql))).toBe(true);
  });

  it("obtenerInstruccion descifra el sobre y registra la lectura en la bitacora", async () => {
    const c = createAccesoCipher(KEY);
    const fila = { unidad_id: U, property_id: P, direccion_exacta: null, codigo_acceso: null, instrucciones: null, direccion_cifrada: c.encrypt(DIRECCION, accesoAad(U, P, "direccion")), codigo_cifrado: c.encrypt(CODIGO, accesoAad(U, P, "codigo")), instrucciones_cifradas: null };
    const { db, llamadas } = sesionGrabadora([{ match: /from rentas\.acceso_instruccion/, rows: [fila] }]);
    const r = await new PostgresRentasAccesoRepository(db, c).obtenerInstruccion(P, U);
    expect(r).toEqual({ disponible: true, valor: { unidadId: U, direccionExacta: DIRECCION, codigoAcceso: CODIGO, instrucciones: null } });
    expect(llamadas.some((l) => /acceso_instruccion_registrar\(\$1::uuid, 'lectura_admin'\)/.test(l.sql))).toBe(true);
  });

  it("un sobre de otra unidad (copiado) no se entrega: AccesoDescifradoError", async () => {
    const c = createAccesoCipher(KEY);
    const ajena = c.encrypt(DIRECCION, accesoAad("33333333-3333-4333-8333-333333333333", P, "direccion"));
    const { db } = sesionGrabadora([{ match: /from rentas\.acceso_instruccion/, rows: [{ unidad_id: U, property_id: P, direccion_exacta: null, codigo_acceso: null, instrucciones: null, direccion_cifrada: ajena, codigo_cifrado: null, instrucciones_cifradas: null }] }]);
    await expect(new PostgresRentasAccesoRepository(db, c).obtenerInstruccion(P, U)).rejects.toBeInstanceOf(AccesoDescifradoError);
  });

  it("sin llave: leer, guardar y cifrar lanzan AccesoNoDisponibleError ANTES de tocar la base (nunca texto plano)", async () => {
    const { db, llamadas } = sesionGrabadora([]);
    const repo = new PostgresRentasAccesoRepository(db, null);
    await expect(async () => repo.obtenerInstruccion(P, U)).rejects.toMatchObject({ reason: "llave_no_configurada" });
    await expect(async () => repo.guardarInstruccion("o", P, U, { direccionExacta: "x", codigoAcceso: null, instrucciones: null }, "a")).rejects.toBeInstanceOf(AccesoNoDisponibleError);
    await expect(repo.cifrarPendientes(10)).rejects.toBeInstanceOf(AccesoNoDisponibleError);
    expect(llamadas).toHaveLength(0);
    const invalida = new PostgresRentasAccesoRepository(db, null, new AccesoNoDisponibleError("llave_invalida"));
    await expect(async () => invalida.obtenerInstruccion(P, U)).rejects.toMatchObject({ reason: "llave_invalida" });
  });

  it("base sin migrar: leer cae al texto heredado y guardar degrada, ambos bajo SAVEPOINT (la sesion sigue utilizable)", async () => {
    const pg = (code: string) => Object.assign(new Error(`pg ${code}`), { code });
    const db = new AbortAwareFakeSession([
      { match: /direccion_cifrada/, respond: () => pg("42703") },
      { match: /from rentas\.acceso_instruccion where property_id/, respond: () => [{ unidad_id: U, direccion_exacta: DIRECCION, codigo_acceso: CODIGO, instrucciones: null }] },
      { match: /from rentas\.unidad/, respond: () => [{ "?column?": 1 }] },
      { match: /insert into rentas\.acceso_instruccion/, respond: () => pg("42703") },
      { match: /select 1 as vivo/, respond: () => [{ vivo: 1 }] },
    ]);
    const repo = new PostgresRentasAccesoRepository(db, createAccesoCipher(KEY));
    expect(await repo.obtenerInstruccion(P, U)).toEqual({ disponible: true, valor: { unidadId: U, direccionExacta: DIRECCION, codigoAcceso: CODIGO, instrucciones: null } });
    expect(await repo.guardarInstruccion("o", P, U, { direccionExacta: "x", codigoAcceso: null, instrucciones: null }, "a")).toEqual({ disponible: false });
    await expect(db.query("select 1 as vivo")).resolves.toEqual({ rows: [{ vivo: 1 }] });
  });

  it("barrido: cifra, verifica el ida y vuelta y llama a aplicar_cifrado con sobres (el texto plano solo viaja de la base a la app)", async () => {
    const { db, llamadas } = sesionGrabadora([
      { match: /acceso_instruccion_pendientes_cifrar/, rows: [{ unidad_id: U, property_id: P, direccion_exacta: DIRECCION, codigo_acceso: CODIGO, instrucciones: null }] },
      { match: /acceso_instruccion_aplicar_cifrado/, rows: [{ aplicado: true }] },
    ]);
    const c = createAccesoCipher(KEY, 4);
    const r = await new PostgresRentasAccesoRepository(db, c).cifrarPendientes(25);
    expect(r).toEqual({ disponible: true, cifradas: 1, fallidas: 0 });
    const aplicar = llamadas.find((l) => /aplicar_cifrado/.test(l.sql))!;
    const [unidad, dir, cod, ins, version] = aplicar.params as [string, string, string, null, number];
    expect(unidad).toBe(U);
    expect(c.decrypt(dir, accesoAad(U, P, "direccion"))).toBe(DIRECCION);
    expect(c.decrypt(cod, accesoAad(U, P, "codigo"))).toBe(CODIGO);
    expect(ins).toBeNull();
    expect(version).toBe(4);
    expect(JSON.stringify(aplicar.params)).not.toContain(CODIGO);
  });

  it("barrido contra una base sin migrar: disponible:false y la sesion sigue utilizable", async () => {
    const db = new AbortAwareFakeSession([
      { match: /acceso_instruccion_pendientes_cifrar/, respond: () => Object.assign(new Error("function rentas.acceso_instruccion_pendientes_cifrar(integer) does not exist"), { code: "42883" }) },
      { match: /select 1 as vivo/, respond: () => [{ vivo: 1 }] },
    ]);
    expect(await new PostgresRentasAccesoRepository(db, createAccesoCipher(KEY)).cifrarPendientes(10)).toEqual({ disponible: false, cifradas: 0, fallidas: 0 });
    await expect(db.query("select 1 as vivo")).resolves.toBeDefined();
  });
});

describe("liberacion al huesped con sobre (siguienteLiberacion)", () => {
  const fila = (extra: Record<string, unknown>) => ({
    ocupacion_id: "o1", organization_id: "org", property_id: P, unidad_id: U, check_in: "2027-03-10", check_out: "2027-03-12", unidad_nombre: "Casa", tenant_nombre: "Gestora",
    huesped_nombre: "Ana", huesped_contacto: "a@example.com", tiene_instrucciones: true, direccion_exacta: null, codigo_acceso: null, instrucciones: null,
    direccion_cifrada: null, codigo_cifrado: null, instrucciones_cifradas: null, key_version: 1, ...extra,
  });

  it("descifra los sobres para armar el correo", async () => {
    const c = createAccesoCipher(KEY);
    const { db } = sesionGrabadora([{ match: /acceso_siguiente_liberacion_cifrada/, rows: [fila({ direccion_cifrada: c.encrypt(DIRECCION, accesoAad(U, P, "direccion")), codigo_cifrado: c.encrypt(CODIGO, accesoAad(U, P, "codigo")) })] }]);
    const l = await new PostgresRentasAccesoRepository(db, c).siguienteLiberacion([]);
    expect(l).toMatchObject({ direccionExacta: DIRECCION, codigoAcceso: CODIGO, instrucciones: null });
    expect(l?.errorAcceso).toBeUndefined();
  });

  it("sin llave (o con sobre no autenticable) devuelve errorAcceso y NINGUN contenido", async () => {
    const c = createAccesoCipher(KEY);
    const sobre = c.encrypt(DIRECCION, accesoAad(U, P, "direccion"));
    const { db } = sesionGrabadora([{ match: /acceso_siguiente_liberacion_cifrada/, rows: [fila({ direccion_cifrada: sobre })] }]);
    const sinLlave = await new PostgresRentasAccesoRepository(db, null).siguienteLiberacion([]);
    expect(sinLlave).toMatchObject({ errorAcceso: "llave_no_configurada", direccionExacta: null, codigoAcceso: null, instrucciones: null });
    const otra = await new PostgresRentasAccesoRepository(db, createAccesoCipher(OTRA)).siguienteLiberacion([]);
    expect(otra).toMatchObject({ errorAcceso: "no_descifrable", direccionExacta: null });
  });

  it("una fila heredada en texto plano (aun sin barrer) se sigue liberando sin llave", async () => {
    const { db } = sesionGrabadora([{ match: /acceso_siguiente_liberacion_cifrada/, rows: [fila({ direccion_exacta: DIRECCION, codigo_acceso: CODIGO })] }]);
    expect(await new PostgresRentasAccesoRepository(db, null).siguienteLiberacion([])).toMatchObject({ direccionExacta: DIRECCION, codigoAcceso: CODIGO });
  });

  it("contra una base sin la migracion 028 cae a la funcion de 025 bajo SAVEPOINT", async () => {
    const db = new AbortAwareFakeSession([
      { match: /acceso_siguiente_liberacion_cifrada/, respond: () => Object.assign(new Error("function rentas.acceso_siguiente_liberacion_cifrada(uuid[], timestamp with time zone) does not exist"), { code: "42883" }) },
      { match: /acceso_siguiente_liberacion\(/, respond: () => [{ ocupacion_id: "o1", organization_id: "org", property_id: P, check_in: "2027-03-10", check_out: "2027-03-12", unidad_nombre: "Casa", tenant_nombre: "G", huesped_nombre: null, huesped_contacto: null, tiene_instrucciones: true, direccion_exacta: DIRECCION, codigo_acceso: CODIGO, instrucciones: null }] },
    ]);
    expect(await new PostgresRentasAccesoRepository(db, null).siguienteLiberacion([])).toMatchObject({ ocupacionId: "o1", direccionExacta: DIRECCION, codigoAcceso: CODIGO });
    expect(db.calls.some((x) => x.startsWith("rollback to savepoint"))).toBe(true);
  });
});

describe("ejecutarLiberacionAcceso con errorAcceso", () => {
  it("no encola ni marca nada: registra error_envio (sin contenido) y cuenta el error; la reserva sigue pendiente", async () => {
    const acceso = new InMemoryRentasAccesoRepository(createAccesoCipher(KEY));
    acceso.pendientes.push({
      ocupacionId: "o1", organizationId: "org", propertyId: P, checkIn: "2027-03-10", checkOut: "2027-03-12", unidadNombre: "Casa", tenantNombre: "G", huespedNombre: "Ana",
      huespedContacto: "a@example.com", tieneInstrucciones: true, direccionExacta: null, codigoAcceso: null, instrucciones: null, errorAcceso: "llave_no_configurada",
    });
    const encolados: unknown[] = [];
    const rentas = { async enqueueMessagingOutbox(...a: unknown[]) { encolados.push(a); } };
    const withTx: WithLiberacionTx = (fn) => fn({ acceso, rentas });
    const r = await ejecutarLiberacionAcceso(withTx);
    expect(r).toMatchObject({ disponible: true, liberadas: 0, errores: 1 });
    expect(encolados).toHaveLength(0);
    expect(acceso.liberadas.size).toBe(0);
    expect(acceso.bitacora.map((b) => b.evento)).toEqual(["error_envio"]);
  });
});

describe("doble en memoria: espeja la base (solo sobres)", () => {
  it("guarda unicamente sobres, descifra al leer, registra la bitacora y el barrido cifra lo heredado", async () => {
    const repo = new InMemoryRentasAccesoRepository(createAccesoCipher(KEY));
    repo.unidadesPorProperty.set(P, new Set([U]));
    await repo.guardarInstruccion("o", P, U, { direccionExacta: DIRECCION, codigoAcceso: CODIGO, instrucciones: null });
    expect(JSON.stringify([...repo.instrucciones.values()])).not.toContain(CODIGO);
    expect(await repo.obtenerInstruccion(P, U)).toMatchObject({ valor: { direccionExacta: DIRECCION, codigoAcceso: CODIGO } });
    expect(repo.bitacoraInstrucciones.map((b) => b.evento)).toEqual(["escritura_admin", "lectura_admin"]);
    repo.instruccionesHeredadas.set("u-vieja", { unidadId: "u-vieja", propertyId: P, direccionExacta: "Vieja 1", codigoAcceso: null, instrucciones: null });
    expect(await repo.cifrarPendientes(10)).toEqual({ disponible: true, cifradas: 1, fallidas: 0 });
    expect(repo.instruccionesHeredadas.size).toBe(0);
    expect((await repo.cifrarPendientes(10)).cifradas).toBe(0);
  });
});
