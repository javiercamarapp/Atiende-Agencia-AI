// Rn-P3-21 -- el borrador guarda `necesita_escalamiento` y `senales` y el listado los devuelve; contra la base SIN migrar
// (columnas de la migración 034 inexistentes, SQLSTATE 42703) el repositorio degrada a `false` y `[]` sin 500 y SIN dejar la
// transacción del request abortada (AbortAwareFakeSession reproduce el 25P02 de Postgres real: una sesión falsa plana no sirve).
import { describe, expect, it } from "vitest";
import { InMemoryRentasMensajeriaRepository, PostgresRentasMensajeriaRepository } from "../../src/index.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

const PROP = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const falta = (code: string) => Object.assign(new Error(`column does not exist (${code})`), { code });

const FILA_BASE = {
  id: "b1", conversacion_id: CONV, mensaje_entrante_id: null, canal_codigo: "airbnb", texto: "Hola", estado: "pendiente_aprobacion", generado_por: "motor_borrador", redactado: false,
  aprobado_por: null, aprobado_en: null, rechazado_por: null, rechazado_en: null, motivo_rechazo: null, mensaje_enviado_id: null, creado_en: "2026-10-01T10:00:00Z", actualizado_en: "2026-10-01T10:00:00Z",
};

describe("InMemoryRentasMensajeriaRepository -- escalamiento persistido", () => {
  it("guarda necesitaEscalamiento y senales y los devuelve en find y list; sin señales queda false y []", async () => {
    const repo = new InMemoryRentasMensajeriaRepository();
    const conv = await repo.insertConversacion({ organizationId: "o1", propertyId: PROP, unidadId: "u1", canal: "airbnb", propiedadNombre: "Casa" });
    const urgente = await repo.insertBorrador({ conversacionId: conv.id, canal: "airbnb", texto: "x", generadoPor: "motor_borrador", necesitaEscalamiento: true, senales: ["emergencia", "queja"] });
    const rutina = await repo.insertBorrador({ conversacionId: conv.id, canal: "airbnb", texto: "y", generadoPor: "motor_borrador" });
    expect(urgente).toMatchObject({ necesitaEscalamiento: true, senales: ["emergencia", "queja"] });
    expect(rutina).toMatchObject({ necesitaEscalamiento: false, senales: [] });
    expect((await repo.findBorrador(PROP, urgente.id))?.senales).toEqual(["emergencia", "queja"]);
    const lista = await repo.listBorradores(PROP, conv.id);
    expect(lista.find((b) => b.id === urgente.id)?.necesitaEscalamiento).toBe(true);
    expect(lista.find((b) => b.id === rutina.id)?.necesitaEscalamiento).toBe(false);
  });

  it("una señal implica escalamiento aunque el llamador no lo marque (mismo CHECK que la base)", async () => {
    const repo = new InMemoryRentasMensajeriaRepository();
    const conv = await repo.insertConversacion({ organizationId: "o1", propertyId: PROP, unidadId: "u1", canal: "vrbo", propiedadNombre: "Casa" });
    const b = await repo.insertBorrador({ conversacionId: conv.id, canal: "vrbo", texto: "x", generadoPor: "agente_llm", senales: ["vip"] });
    expect(b.necesitaEscalamiento).toBe(true);
  });
});

describe("PostgresRentasMensajeriaRepository -- escalamiento contra la base migrada", () => {
  it("insertBorrador manda las dos columnas y mapea la fila devuelta", async () => {
    const consultas: { sql: string; params?: unknown[] }[] = [];
    const sesion = {
      query: async (sql: string, params?: unknown[]) => {
        consultas.push({ sql, params });
        return { rows: [{ ...FILA_BASE, necesita_escalamiento: true, senales: ["reembolso"] }] };
      },
      exec: async () => undefined,
    };
    const repo = new PostgresRentasMensajeriaRepository(sesion as never);
    const b = await repo.insertBorrador({ conversacionId: CONV, canal: "airbnb", texto: "Hola", generadoPor: "motor_borrador", senales: ["reembolso"] });
    expect(b).toMatchObject({ necesitaEscalamiento: true, senales: ["reembolso"] });
    const insert = consultas.find((c) => /insert into rentas\.borrador_mensaje/.test(c.sql))!;
    expect(insert.sql).toContain("necesita_escalamiento, senales");
    expect(insert.params?.slice(5)).toEqual([true, ["reembolso"]]);
  });
});

describe("PostgresRentasMensajeriaRepository -- base sin migrar (42703) con transacción abortable", () => {
  it("listBorradores degrada a false y [] y la sesión sigue utilizable (SAVEPOINT)", async () => {
    const sesion = new AbortAwareFakeSession([
      { match: /necesita_escalamiento/, respond: () => falta("42703") },
      { match: /from rentas\.borrador_mensaje b/, respond: () => [FILA_BASE] },
      { match: /from rentas\.conversacion/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresRentasMensajeriaRepository(sesion);
    const lista = await repo.listBorradores(PROP, CONV);
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ necesitaEscalamiento: false, senales: [] });
    expect(sesion.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    // Sin SAVEPOINT esta consulta posterior fallaría con 25P02 (transacción abortada).
    await expect(sesion.query("select 1 from rentas.conversacion")).resolves.toBeDefined();
  });

  it("insertBorrador cae al INSERT anterior a la migración y devuelve false y [] sin abortar la transacción", async () => {
    const sesion = new AbortAwareFakeSession([
      { match: /insert into rentas\.borrador_mensaje[\s\S]*necesita_escalamiento/, respond: () => falta("42703") },
      { match: /insert into rentas\.borrador_mensaje/, respond: () => [FILA_BASE] },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresRentasMensajeriaRepository(sesion);
    const b = await repo.insertBorrador({ conversacionId: CONV, canal: "airbnb", texto: "Hola", generadoPor: "motor_borrador", necesitaEscalamiento: true, senales: ["emergencia"] });
    expect(b).toMatchObject({ id: "b1", necesitaEscalamiento: false, senales: [] });
    await expect(sesion.query("select 1")).resolves.toBeDefined();
  });

  it("aprobar y rechazar también caen a la proyección anterior; un error que no es de migración pendiente se repropaga", async () => {
    const sesion = new AbortAwareFakeSession([
      { match: /necesita_escalamiento/, respond: () => falta("42703") },
      { match: /update rentas\.borrador_mensaje/, respond: () => [{ ...FILA_BASE, estado: "enviado" }] },
    ]);
    const repo = new PostgresRentasMensajeriaRepository(sesion);
    const aprobado = await repo.marcarBorradorAprobadoYEnviado({ id: "b1", aprobadoPor: "u1", textoFinal: "Hola", redactado: false, mensajeEnviadoId: "m1" });
    expect(aprobado.estado).toBe("enviado");
    const rechazado = await repo.marcarBorradorRechazado({ id: "b1", rechazadoPor: "u1", motivo: "no" });
    expect(rechazado.necesitaEscalamiento).toBe(false);

    const otro = new PostgresRentasMensajeriaRepository(new AbortAwareFakeSession([{ match: /borrador_mensaje/, respond: () => Object.assign(new Error("timeout"), { code: "57014" }) }]));
    await expect(otro.listBorradores(PROP, CONV)).rejects.toMatchObject({ code: "57014" });
  });
});
