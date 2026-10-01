// D-08 (migracion 016): el repositorio del portal corre en la transaccion compartida del request.
// REGLA DURA de compatibilidad: contra la base SIN migrar, 42883/42P01/42703 degradan a
// `{ disponible: false }` SIN dejar la transaccion abortada (25P02); AbortAwareFakeSession reproduce
// ese estado (una sesion falsa plana no). Tambien fija la traduccion de SQLSTATE a errores de dominio
// y que ninguna consulta de listado toca `token_hash` ni `contenido`.
import { describe, expect, it } from "vitest";
import {
  InMemoryPortalClienteRepository,
  PortalCuotaExcedidaError,
  PortalEnlaceInvalidoError,
  PortalEntradaInvalidaError,
  PortalSinAccesoError,
  PostgresPortalClienteRepository,
} from "../src/portal-cliente/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

const HASH = "a".repeat(64);
const RESUMEN_RE = /despachos\.portal_cliente_resumen/i;
const SIGUIENTE = /select 1/;

describe("PostgresPortalClienteRepository -- base SIN migrar (REGLA DURA)", () => {
  const casos: [string, () => Error][] = [
    ["42883 funcion inexistente", () => pgError("42883", "function despachos.portal_cliente_resumen(text) does not exist")],
    ["42P01 tabla inexistente", () => pgError("42P01", 'relation "despachos.portal_cliente_enlace" does not exist')],
    ["42703 columna inexistente", () => pgError("42703", 'column "x" does not exist')],
  ];

  for (const [nombre, error] of casos) {
    it(`${nombre}: resumen degrada a no disponible y la transaccion sigue utilizable`, async () => {
      const session = new AbortAwareFakeSession([{ match: RESUMEN_RE, respond: error }, { match: SIGUIENTE, respond: () => [{ ok: 1 }] }]);
      const repo = new PostgresPortalClienteRepository(session);
      expect(await repo.resumen(HASH)).toEqual({ disponible: false });
      // La consulta POSTERIOR del mismo request no falla con 25P02 (sin SAVEPOINT fallaria).
      expect(await session.query("select 1")).toEqual({ rows: [{ ok: 1 }] });
      expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    });
  }

  it("las 11 operaciones degradan a no disponible contra la base sin migrar", async () => {
    const todo = [{ match: /despachos\.portal_|portal_cliente_/i, respond: () => pgError("42P01", 'relation "despachos.portal_cliente_enlace" does not exist') }, { match: SIGUIENTE, respond: () => [{ ok: 1 }] }];
    const session = new AbortAwareFakeSession(todo);
    const repo = new PostgresPortalClienteRepository(session);
    const buf = new Uint8Array([1]);
    const resultados = [
      await repo.resumen(HASH),
      await repo.recibirDocumento(HASH, { tipo: "pdf", nombreArchivo: "a.pdf", mimeType: "application/pdf", contenido: buf, resumen: {} }),
      await repo.enviarMensajeCliente(HASH, "hola"),
      await repo.crearEnlace("p", HASH, "x", 30),
      await repo.revocarEnlace("p", "e"),
      await repo.listarEnlaces("p"),
      await repo.listarDocumentos("p"),
      await repo.listarMensajes("p"),
      await repo.contenidoDocumento("p", "d"),
      await repo.resolverDocumento("p", "d", "aceptado", null, null),
      await repo.enviarMensajeStaff("p", "hola"),
    ];
    for (const r of resultados) expect(r).toEqual({ disponible: false });
    expect(await session.query("select 1")).toEqual({ rows: [{ ok: 1 }] });
  });
});

describe("PostgresPortalClienteRepository -- traduccion de errores", () => {
  const con = (error: Error) => new PostgresPortalClienteRepository(new AbortAwareFakeSession([{ match: RESUMEN_RE, respond: () => error }]));

  it("P0002 (enlace no valido) -> PortalEnlaceInvalidoError, sin filtrar el mensaje de Postgres", async () => {
    await expect(con(pgError("P0002", "enlace_no_valido")).resumen(HASH)).rejects.toBeInstanceOf(PortalEnlaceInvalidoError);
  });
  it("54000 (cuota) -> PortalCuotaExcedidaError; 22023/23514 -> entrada invalida; 42501 -> sin acceso", async () => {
    await expect(con(pgError("54000", "x: bandeja llena")).resumen(HASH)).rejects.toBeInstanceOf(PortalCuotaExcedidaError);
    await expect(con(pgError("22023", "detalle interno")).resumen(HASH)).rejects.toBeInstanceOf(PortalEntradaInvalidaError);
    await expect(con(pgError("23514", "check")).resumen(HASH)).rejects.toBeInstanceOf(PortalEntradaInvalidaError);
    await expect(con(pgError("42501", "denegado")).resumen(HASH)).rejects.toBeInstanceOf(PortalSinAccesoError);
  });
  it("un 42883 de otra funcion (bug real) y cualquier otro error se repropagan, no se enmascaran como 'no disponible'", async () => {
    await expect(con(pgError("42883", "function core.has_property_access(uuid) does not exist")).resumen(HASH)).rejects.toMatchObject({ code: "42883" });
    await expect(con(pgError("XX000", "boom")).resumen(HASH)).rejects.toMatchObject({ code: "XX000" });
  });
  it("resumen sin fila -> enlace no valido", async () => {
    const repo = new PostgresPortalClienteRepository(new AbortAwareFakeSession([{ match: RESUMEN_RE, respond: () => [] }]));
    await expect(repo.resumen(HASH)).rejects.toBeInstanceOf(PortalEnlaceInvalidoError);
  });
});

describe("PostgresPortalClienteRepository -- consultas", () => {
  it("mapea el resumen jsonb y pasa SOLO el hash (nunca el token) como parametro", async () => {
    const llamadas: unknown[][] = [];
    const session = new AbortAwareFakeSession([
      {
        match: RESUMEN_RE,
        respond: () => [
          {
            r: {
              cliente: { nombre: "Cliente A" }, despacho: { nombre: "Despacho X" }, expira_en: "2026-12-01T00:00:00Z",
              obligaciones: [{ tipo: "ISR", periodo: "2026-07", fecha_limite: "2026-08-17", estado: "pendiente", fecha_presentacion: null }],
              cierres: [{ anio: 2026, mes: 6, estado: "open", tareas_total: "5", tareas_listas: "2" }],
              documentos: [{ id: "d1", tipo: "pdf", nombre_archivo: "a.pdf", estado: "recibido", motivo: null, creado_en: "2026-07-01T00:00:00Z" }],
              mensajes: [{ autor: "despacho", cuerpo: "hola", creado_en: "2026-07-02T00:00:00Z" }],
            },
          },
        ],
      },
    ]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      if (params) llamadas.push(params);
      return original(sql, params);
    }) as typeof session.query;
    const r = await new PostgresPortalClienteRepository(session).resumen(HASH);
    expect(r).toEqual({
      disponible: true,
      valor: {
        clienteNombre: "Cliente A", despachoNombre: "Despacho X", expiraEn: "2026-12-01T00:00:00Z",
        obligaciones: [{ tipo: "ISR", periodo: "2026-07", fechaLimite: "2026-08-17", estado: "pendiente", fechaPresentacion: null }],
        cierres: [{ anio: 2026, mes: 6, estado: "open", tareasTotal: 5, tareasListas: 2 }],
        documentos: [{ id: "d1", tipo: "pdf", nombreArchivo: "a.pdf", estado: "recibido", motivo: null, creadoEn: "2026-07-01T00:00:00Z" }],
        mensajes: [{ autor: "despacho", cuerpo: "hola", creadoEn: "2026-07-02T00:00:00Z" }],
      },
    });
    expect(llamadas).toEqual([[HASH]]);
  });

  it("los listados de staff NUNCA seleccionan token_hash ni contenido", async () => {
    const sqls: string[] = [];
    const session = new AbortAwareFakeSession([{ match: /portal_cliente_(enlace|documento|mensaje)/i, respond: () => [] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      sqls.push(sql);
      return original(sql, params);
    }) as typeof session.query;
    const repo = new PostgresPortalClienteRepository(session);
    await repo.listarEnlaces("p");
    await repo.listarDocumentos("p");
    await repo.listarMensajes("p");
    expect(sqls).toHaveLength(3);
    for (const sql of sqls) {
      expect(sql).not.toMatch(/token_hash|contenido|select\s+\*/i);
    }
  });
});

describe("InMemoryPortalClienteRepository (doble de rutas)", () => {
  const T0 = new Date("2026-07-01T00:00:00Z");

  it("un hash solo ve SU property; expirado y revocado fallan igual que el inexistente", async () => {
    let ahora = T0;
    const repo = new InMemoryPortalClienteRepository(() => ahora);
    repo.sembrarCliente({ propertyId: "pA", clienteNombre: "A", despachoNombre: "D" });
    repo.sembrarCliente({ propertyId: "pB", clienteNombre: "B", despachoNombre: "D" });
    await repo.crearEnlace("pA", "hA".padEnd(64, "0"), "a", 1);
    await repo.crearEnlace("pB", "hB".padEnd(64, "0"), "b", 30);
    await repo.enviarMensajeStaff("pA", "para A");
    const a = await repo.resumen("hA".padEnd(64, "0"));
    const b = await repo.resumen("hB".padEnd(64, "0"));
    expect(a.disponible && a.valor.clienteNombre).toBe("A");
    expect(b.disponible && b.valor.mensajes).toEqual([]);
    ahora = new Date(T0.getTime() + 2 * 86_400_000);
    await expect(repo.resumen("hA".padEnd(64, "0"))).rejects.toBeInstanceOf(PortalEnlaceInvalidoError);
    await expect(repo.resumen("zz".padEnd(64, "0"))).rejects.toBeInstanceOf(PortalEnlaceInvalidoError);
    const lista = await repo.listarEnlaces("pB");
    expect(lista.disponible && lista.valor[0]).not.toHaveProperty("tokenHash");
    if (lista.disponible) await repo.revocarEnlace("pB", lista.valor[0]!.id);
    await expect(repo.resumen("hB".padEnd(64, "0"))).rejects.toBeInstanceOf(PortalEnlaceInvalidoError);
  });
});
