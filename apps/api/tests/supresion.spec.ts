// SA-L-46: lista de supresion de plataforma -- normalizacion y hash estables, guard FAIL-CLOSED (con la unica
// excepcion 42P01 documentada), despacho de WhatsApp y de correo suprimido, y BAJA idempotente. El estado de
// transaccion abortada de Postgres se reproduce con AbortAwareFakeSession (una sesion falsa plana no sirve).
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsAppOutboundDispatcher, FakeWhatsAppGraphClient } from "@atiende/whatsapp-gateway";
import type { MessagingOutboxItem, MessagingOutboxPort } from "@atiende/whatsapp-gateway";
import { dispatchPendingEmailJobs } from "@atiende/domain-citas";
import type { CitasRepository } from "@atiende/domain-citas";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";
import {
  BAJA_CONFIRMADA_TEXTO,
  PREFIJO_HASH_SUPRESION,
  crearGuardCorreo,
  crearGuardTelefono,
  esPalabraBaja,
  hashearContacto,
  normalizarCorreo,
  normalizarTelefono,
  procesarMensajeBaja,
  registrarSupresion,
} from "../src/supresion/index.ts";

function pgError(code: string, message = "error de postgres"): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/** Vector compartido con scripts/verify-plataforma-supresion/assertions.sql (escenario 5). */
const HASH_TELEFONO_VECTOR = "a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120";
const HASH_CORREO_VECTOR = "7e332a7fd228e7bc82f19ca61fbd151da629c35b1a54cb511486aabbe23b6399";

afterEach(() => vi.restoreAllMocks());

describe("normalizacion y hash", () => {
  it("el mismo telefono en formatos distintos (+52, espacios, 044, 521, guiones) da el mismo hash", () => {
    const formatos = ["+52 55 1234 5678", "5512345678", "044 55 1234 5678", "045 5512345678", "+52 1 55 1234 5678", "525512345678", "5215512345678", "(55) 1234-5678", "0052 55 1234 5678", "01 55 1234 5678", " +52-55-1234-5678 "];
    for (const f of formatos) expect(normalizarTelefono(f), f).toBe("+525512345678");
    const hashes = new Set(formatos.map((f) => hashearContacto("telefono", f)));
    expect(hashes.size).toBe(1);
    expect([...hashes][0]).toBe(HASH_TELEFONO_VECTOR);
  });

  it("el hash del vector coincide con la definicion publicada (SHA-256 de prefijo de dominio + tipo + valor normalizado)", () => {
    expect(PREFIJO_HASH_SUPRESION).toBe("atiende:supresion:v1:");
    expect(hashearContacto("correo", "ana@example.com")).toBe(HASH_CORREO_VECTOR);
  });

  it("el correo se normaliza a minusculas y sin espacios", () => {
    expect(normalizarCorreo("  Ana@Example.COM ")).toBe("ana@example.com");
    expect(hashearContacto("correo", " ANA@example.com")).toBe(HASH_CORREO_VECTOR);
  });

  it("telefonos y correos de otros paises o no interpretables", () => {
    expect(normalizarTelefono("+1 (305) 555-0100")).toBe("+13055550100");
    expect(normalizarTelefono("+34 612 345 678")).toBe("+34612345678");
    expect(normalizarTelefono("12345")).toBeNull();
    expect(normalizarTelefono("abc")).toBeNull();
    expect(normalizarTelefono("")).toBeNull();
    expect(normalizarCorreo("sin-arroba")).toBeNull();
    expect(normalizarCorreo("a@@b.com")).toBeNull();
    expect(hashearContacto("telefono", "xx")).toBeNull();
  });

  it("el hash es hex de 64 caracteres y el tipo separa el dominio", () => {
    const h = hashearContacto("telefono", "5512345678")!;
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashearContacto("correo", "5512345678@x.com")).not.toBe(h);
  });
});

describe("palabras de baja", () => {
  it("reconoce baja, stop, alto y ya no como mensaje COMPLETO (sin acentos ni signos)", () => {
    for (const t of ["BAJA", "baja", " Stop ", "STOP.", "alto", "Ya no", "ya  no!", "¡baja!", "Dar de baja", "darme de baja", "cancelar suscripción"]) expect(esPalabraBaja(t), t).toBe(true);
  });

  it("no reconoce una palabra suelta dentro de una frase", () => {
    for (const t of ["quiero una baja de mi cita", "no pares", "ya no quiero salsa", "hola", "", "stop por favor"]) expect(esPalabraBaja(t), t).toBe(false);
  });
});

describe("guard de supresion: FAIL-CLOSED y excepcion 42P01", () => {
  it("devuelve true para un contacto suprimido y consulta con el hash, nunca con el valor en claro", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.esta_suprimido/, respond: () => [{ suprimido: true }] }]);
    const spy = vi.spyOn(session, "query");
    await expect(crearGuardTelefono(session)("+52 55 1234 5678")).resolves.toBe(true);
    const [sql, params] = spy.mock.calls[0]!;
    expect(sql).toContain("core.esta_suprimido");
    expect(params).toEqual(["telefono", HASH_TELEFONO_VECTOR]);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("5512345678");
  });

  it("devuelve false para un contacto no suprimido", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.esta_suprimido/, respond: () => [{ suprimido: false }] }]);
    await expect(crearGuardCorreo(session)("ana@example.com")).resolves.toBe(false);
  });

  it("un destino no interpretable no consulta la base ni bloquea (lo rechaza el proveedor)", async () => {
    const session = new AbortAwareFakeSession([]);
    await expect(crearGuardTelefono(session)("xx")).resolves.toBe(false);
    expect(session.calls).toEqual([]);
  });

  it("FAIL-CLOSED: un error de lectura que NO es 42P01 se propaga (el despachador no envia) y deja la sesion utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /core\.esta_suprimido/, respond: () => pgError("40P01", "deadlock detected") },
      { match: /select 1/, respond: () => [] },
    ]);
    await expect(crearGuardTelefono(session)("5512345678")).rejects.toMatchObject({ code: "40P01" });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("42501 (sesion de usuario) tambien se propaga: nunca se asume 'no suprimido'", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.esta_suprimido/, respond: () => pgError("42501", "solo sistema") }]);
    await expect(crearGuardTelefono(session)("5512345678")).rejects.toMatchObject({ code: "42501" });
  });

  it.each(["42P01", "42883", "42703"])("%s (tabla o funcion aun no migrada) permite el envio con log 'supresion_no_migrada' y la transaccion sigue sana", async (code) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new AbortAwareFakeSession([
      { match: /core\.esta_suprimido/, respond: () => pgError(code, "relation does not exist") },
      { match: /select 1/, respond: () => [] },
    ]);
    await expect(crearGuardTelefono(session)("5512345678")).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const linea = String(warn.mock.calls[0]![0]);
    expect(JSON.parse(linea)).toMatchObject({ evento: "supresion_no_migrada", level: "warn" });
    expect(linea).not.toContain("5512345678");
    // SAVEPOINT / ROLLBACK TO SAVEPOINT: la consulta posterior no falla con 25P02.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });
});

/** Puerto en memoria minimo (mismo contrato que MessagingOutboxPort). */
function puertoEnMemoria(payloads: unknown[]) {
  const filas = payloads.map((payload, i) => ({ id: `m${i}`, attempts: 0, payload, status: "processing" as string, errorClass: null as string | null }));
  const port: MessagingOutboxPort = {
    label: "citas",
    claimBatch: async () => filas.map((f): MessagingOutboxItem => ({ id: f.id, attempts: f.attempts, payload: f.payload })),
    markSent: async (id) => {
      filas.find((f) => f.id === id)!.status = "sent";
    },
    markRetry: async (id) => {
      filas.find((f) => f.id === id)!.status = "pending";
    },
    markDead: async (id, _attempts, errorClass) => {
      const fila = filas.find((f) => f.id === id)!;
      fila.status = "dead";
      fila.errorClass = errorClass;
    },
  };
  return { port, filas };
}

describe("despacho de WhatsApp con la lista de supresion", () => {
  const aviso = { to: "+525512345678", phone_number_id: "pn1", body: "Recordatorio de tu cita" };

  it("un recordatorio a un telefono suprimido NO se envia: dead 'suprimido', sin reintento", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.esta_suprimido/, respond: () => [{ suprimido: true }] }]);
    const { port, filas } = puertoEnMemoria([aviso]);
    const graph = new FakeWhatsAppGraphClient();
    const resumen = await new WhatsAppOutboundDispatcher({ graphClient: graph }).dispatchPending(port, { suppression: crearGuardTelefono(session) });
    expect(graph.sent).toHaveLength(0);
    expect(resumen.suppressed).toBe(1);
    expect(filas[0]).toMatchObject({ status: "dead", errorClass: "suprimido" });
  });

  it("la misma lista suprime el telefono aunque el outbox lo traiga en otro formato (044 / sin lada)", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.esta_suprimido/, respond: () => [{ suprimido: true }] }]);
    const spy = vi.spyOn(session, "query");
    const { port } = puertoEnMemoria([{ ...aviso, to: "044 55 1234 5678" }]);
    await new WhatsAppOutboundDispatcher({ graphClient: new FakeWhatsAppGraphClient() }).dispatchPending(port, { suppression: crearGuardTelefono(session) });
    expect(spy.mock.calls[0]![1]).toEqual(["telefono", HASH_TELEFONO_VECTOR]);
  });

  it("la respuesta transaccional (confirmacion de pedido o de cita) SI se envia aunque el telefono este suprimido", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.esta_suprimido/, respond: () => [{ suprimido: true }] }]);
    const { port, filas } = puertoEnMemoria([{ ...aviso, body: "Tu pedido esta confirmado", transaccional: true }]);
    const graph = new FakeWhatsAppGraphClient();
    await new WhatsAppOutboundDispatcher({ graphClient: graph }).dispatchPending(port, { suppression: crearGuardTelefono(session) });
    expect(graph.sent).toHaveLength(1);
    expect(filas[0]!.status).toBe("sent");
    expect(session.calls.filter((c) => c.includes("esta_suprimido"))).toHaveLength(0);
  });

  it("FAIL-CLOSED: una lectura que falla (no 42P01) bloquea el envio y no quema el intento", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.esta_suprimido/, respond: () => pgError("57014", "statement timeout") }]);
    const { port, filas } = puertoEnMemoria([aviso]);
    const graph = new FakeWhatsAppGraphClient();
    const resumen = await new WhatsAppOutboundDispatcher({ graphClient: graph }).dispatchPending(port, { suppression: crearGuardTelefono(session) });
    expect(graph.sent).toHaveLength(0);
    expect(resumen.skipped).toBe(1);
    expect(filas[0]).toMatchObject({ status: "processing" });
  });

  it("42P01 permite el envio (los avisos no se detienen entre el deploy y el db push)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new AbortAwareFakeSession([{ match: /core\.esta_suprimido/, respond: () => pgError("42P01", "relation core.supresion_contacto does not exist") }]);
    const { port, filas } = puertoEnMemoria([aviso]);
    const graph = new FakeWhatsAppGraphClient();
    await new WhatsAppOutboundDispatcher({ graphClient: graph }).dispatchPending(port, { suppression: crearGuardTelefono(session) });
    expect(graph.sent).toHaveLength(1);
    expect(filas[0]!.status).toBe("sent");
  });
});

describe("despacho de correo con la lista de supresion", () => {
  function repoCorreo(payloads: Record<string, unknown>[]) {
    const completados: { id: string; status: string; error: string | null }[] = [];
    const jobs = payloads.map((payload, i) => ({ id: `e${i}`, attempts: 1, payload }));
    const repo = {
      claimEmailOutboxBatch: async () => jobs,
      completeEmailOutboxJob: async (id: string, status: string, error: string | null) => {
        completados.push({ id, status, error });
      },
    } as unknown as CitasRepository;
    return { repo, completados };
  }
  const resend = { apiKey: "re_test", from: "Atiende <avisos@example.com>" };
  const correo = { to: "ana@example.com", subject: "Aviso", html: "<p>hola</p>" };
  const fetchOk = vi.fn(async () => new Response("{}", { status: 200 }));

  it("un correo proactivo a un contacto suprimido NO se envia: dead 'suprimido'", async () => {
    fetchOk.mockClear();
    const session = new AbortAwareFakeSession([{ match: /core\.esta_suprimido/, respond: () => [{ suprimido: true }] }]);
    const { repo, completados } = repoCorreo([correo]);
    const resumen = await dispatchPendingEmailJobs(repo, resend, { fetchImpl: fetchOk as unknown as typeof fetch, suppression: crearGuardCorreo(session) });
    expect(fetchOk).not.toHaveBeenCalled();
    expect(resumen).toMatchObject({ processed: 1, sent: 0, suppressed: 1 });
    expect(completados).toEqual([{ id: "e0", status: "dead", error: "suprimido" }]);
  });

  it("el correo transaccional se envia aunque el contacto este suprimido", async () => {
    fetchOk.mockClear();
    const session = new AbortAwareFakeSession([{ match: /core\.esta_suprimido/, respond: () => [{ suprimido: true }] }]);
    const { repo, completados } = repoCorreo([{ ...correo, transaccional: true }]);
    const resumen = await dispatchPendingEmailJobs(repo, resend, { fetchImpl: fetchOk as unknown as typeof fetch, suppression: crearGuardCorreo(session) });
    expect(fetchOk).toHaveBeenCalledTimes(1);
    expect(resumen.sent).toBe(1);
    expect(completados).toEqual([{ id: "e0", status: "sent", error: null }]);
  });

  it("FAIL-CLOSED: una lectura que falla no envia y el job queda 'failed' para reintento", async () => {
    fetchOk.mockClear();
    const session = new AbortAwareFakeSession([{ match: /core\.esta_suprimido/, respond: () => pgError("08006", "connection failure") }]);
    const { repo, completados } = repoCorreo([correo]);
    const resumen = await dispatchPendingEmailJobs(repo, resend, { fetchImpl: fetchOk as unknown as typeof fetch, suppression: crearGuardCorreo(session) });
    expect(fetchOk).not.toHaveBeenCalled();
    expect(resumen).toMatchObject({ failed: 1, sent: 0 });
    expect(completados).toEqual([{ id: "e0", status: "failed", error: "supresion_no_verificable" }]);
  });

  it("42P01 permite el envio", async () => {
    fetchOk.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new AbortAwareFakeSession([{ match: /core\.esta_suprimido/, respond: () => pgError("42P01") }]);
    const { repo } = repoCorreo([correo]);
    const resumen = await dispatchPendingEmailJobs(repo, resend, { fetchImpl: fetchOk as unknown as typeof fetch, suppression: crearGuardCorreo(session) });
    expect(fetchOk).toHaveBeenCalledTimes(1);
    expect(resumen.sent).toBe(1);
  });

  it("sin guard el comportamiento es el anterior", async () => {
    fetchOk.mockClear();
    const { repo } = repoCorreo([correo]);
    const resumen = await dispatchPendingEmailJobs(repo, resend, { fetchImpl: fetchOk as unknown as typeof fetch });
    expect(resumen).toEqual({ processed: 1, sent: 1, failed: 0, dead: 0, errors: [], notConfigured: false });
  });
});

describe("BAJA / STOP entrante", () => {
  it("registra y confirma UNA sola vez: la repeticion es idempotente y no vuelve a confirmar", async () => {
    let existe = false;
    const session = new AbortAwareFakeSession([
      {
        match: /core\.registrar_supresion/,
        respond: () => {
          const nueva = !existe;
          existe = true;
          return [{ nueva }];
        },
      },
    ]);
    const confirmar = vi.fn(async () => undefined);
    const entrada = { telefono: "+52 55 1234 5678", texto: "BAJA", origen: "whatsapp.citas", organizationId: "00000000-0000-0000-0000-000000000001", confirmar };

    const primera = await procesarMensajeBaja(session, entrada);
    const segunda = await procesarMensajeBaja(session, { ...entrada, telefono: "5512345678", texto: "stop" });

    expect(primera).toEqual({ manejada: true, resultado: "registrada" });
    expect(segunda).toEqual({ manejada: true, resultado: "ya_existia" });
    expect(confirmar).toHaveBeenCalledTimes(1);
    expect(BAJA_CONFIRMADA_TEXTO).not.toMatch(/\d{10}/);
  });

  it("solo viaja el hash, el motivo 'baja' y el origen: nunca el telefono en claro", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.registrar_supresion/, respond: () => [{ nueva: true }] }]);
    const spy = vi.spyOn(session, "query");
    await procesarMensajeBaja(session, { telefono: "+525512345678", texto: "Baja", origen: "whatsapp.hoteles", organizationId: null, confirmar: async () => undefined });
    expect(spy.mock.calls[0]![1]).toEqual(["telefono", HASH_TELEFONO_VECTOR, "baja", "whatsapp.hoteles", null]);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("5512345678");
  });

  it("un mensaje que no es baja no se maneja ni toca la base", async () => {
    const session = new AbortAwareFakeSession([]);
    const confirmar = vi.fn(async () => undefined);
    const r = await procesarMensajeBaja(session, { telefono: "+525512345678", texto: "quiero una pizza", origen: "whatsapp.restaurantes", organizationId: null, confirmar });
    expect(r).toEqual({ manejada: false, resultado: null });
    expect(session.calls).toEqual([]);
    expect(confirmar).not.toHaveBeenCalled();
  });

  it("base sin la migracion 0042: NO se maneja (sigue el camino anterior del webhook), con log 'supresion_no_migrada' y sesion sana", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new AbortAwareFakeSession([
      { match: /core\.registrar_supresion/, respond: () => pgError("42883", "function core.registrar_supresion does not exist") },
      { match: /select 1/, respond: () => [] },
    ]);
    const confirmar = vi.fn(async () => undefined);
    const r = await procesarMensajeBaja(session, { telefono: "+525512345678", texto: "BAJA", origen: "whatsapp.citas", organizationId: null, confirmar });
    expect(r).toEqual({ manejada: false, resultado: "no_migrada" });
    expect(confirmar).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("registrarSupresion rechaza un valor no interpretable sin tocar la base, y otros errores se propagan", async () => {
    const vacia = new AbortAwareFakeSession([]);
    await expect(registrarSupresion(vacia, { tipo: "telefono", valor: "xx", motivo: "baja", origen: "x" })).resolves.toBe("valor_invalido");
    expect(vacia.calls).toEqual([]);
    const rota = new AbortAwareFakeSession([{ match: /core\.registrar_supresion/, respond: () => pgError("40001", "serialization failure") }]);
    await expect(registrarSupresion(rota, { tipo: "telefono", valor: "5512345678", motivo: "baja", origen: "x" })).rejects.toMatchObject({ code: "40001" });
  });
});
