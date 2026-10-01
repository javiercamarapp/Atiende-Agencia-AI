// Rn-18 / Rn-19 -- compatibilidad con la base SIN migrar y reglas de negocio de las funciones SQL de la migracion
// 027, con AbortAwareFakeSession (reproduce el estado ABORTADO de una transaccion de Postgres: una sesion falsa plana
// NO sirve). Cada escritura debe: (1) devolver `no_disponible` si la funcion no existe, (2) devolver `rechazado` con el
// mensaje de la funcion si Postgres rechaza por una regla de negocio, y (3) dejar la sesion UTILIZABLE (ROLLBACK TO
// SAVEPOINT) para que el resto de la transaccion del request y su COMMIT sigan siendo validos.
import { describe, expect, it } from "vitest";
import { PostgresRentasCatalogoRepository } from "../../src/catalogo/postgres-repository.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function pgError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

function funcionNoExiste(nombre: string): Error {
  return pgError("42883", `function rentas.${nombre}(uuid, text, text, text) does not exist`);
}

interface Escritura {
  readonly nombre: string;
  readonly llamar: (repo: PostgresRentasCatalogoRepository) => Promise<{ estado: string }>;
}

const ESCRITURAS: readonly Escritura[] = [
  { nombre: "crear_regla_comision_canal", llamar: (r) => r.crearReglaComision(UUID_A, UUID_B, { alcance: "organizacion", canalCodigo: "booking", yaNetoDeComision: false, comisionBasisPoints: 1500, fuente: "contrato" }) },
  { nombre: "actualizar_regla_comision_canal", llamar: (r) => r.actualizarReglaComision(UUID_A, { yaNetoDeComision: false, comisionBasisPoints: 1500, fuente: "contrato" }) },
  { nombre: "sembrar_reglas_comision_por_defecto", llamar: (r) => r.sembrarReglasComisionPorDefecto(UUID_A) },
  { nombre: "crear_propiedad", llamar: (r) => r.crearPropiedad(UUID_A, { nombre: "Casa", zonaHoraria: "America/Cancun", moneda: "MXN" }) },
  { nombre: "actualizar_propiedad", llamar: (r) => r.actualizarPropiedad(UUID_A, { nombre: "Casa 2" }) },
  { nombre: "crear_propietario", llamar: (r) => r.crearPropietario(UUID_A, { nombre: "Ana", email: null }) },
  { nombre: "actualizar_propietario", llamar: (r) => r.actualizarPropietario(UUID_A, UUID_B, { email: null }) },
  { nombre: "crear_unidad", llamar: (r) => r.crearUnidad(UUID_A, { nombre: "Suite", propietarioId: null, duracionMinimaNoches: 1 }) },
  { nombre: "actualizar_unidad", llamar: (r) => r.actualizarUnidad(UUID_A, { propietarioId: null }) },
];

describe("PostgresRentasCatalogoRepository: base sin la migracion 027", () => {
  for (const { nombre, llamar } of ESCRITURAS) {
    it(`${nombre}: funcion inexistente -> no_disponible y la sesion sigue utilizable (sin SAVEPOINT quedaria abortada, 25P02)`, async () => {
      const session = new AbortAwareFakeSession([
        { match: new RegExp(`rentas\\.${nombre}\\(`), respond: () => funcionNoExiste(nombre) },
        { match: /select 1 as sigue_viva/, respond: () => [{ sigue_viva: 1 }] },
      ]);
      const repo = new PostgresRentasCatalogoRepository(session);

      expect(await llamar(repo)).toEqual({ estado: "no_disponible" });

      // La consulta siguiente de la MISMA transaccion (el resto del request) funciona.
      const { rows } = await session.query<{ sigue_viva: number }>("select 1 as sigue_viva");
      expect(rows).toEqual([{ sigue_viva: 1 }]);
      expect(session.calls.some((c) => c.startsWith("savepoint"))).toBe(true);
      expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    });
  }

  it("una tabla o columna inexistente tambien cuenta como migracion pendiente", async () => {
    for (const code of ["42P01", "42703"]) {
      const session = new AbortAwareFakeSession([{ match: /crear_unidad/, respond: () => pgError(code, "relation does not exist") }]);
      expect(await new PostgresRentasCatalogoRepository(session).crearUnidad(UUID_A, { nombre: "S", propietarioId: null, duracionMinimaNoches: 1 })).toEqual({ estado: "no_disponible" });
    }
  });

  it("una funcion INTERNA distinta que falta (otro nombre) NO se confunde con 'migracion pendiente': el error sube", async () => {
    const session = new AbortAwareFakeSession([{ match: /crear_unidad/, respond: () => pgError("42883", "function rentas.otra_funcion_interna(uuid) does not exist") }]);
    await expect(new PostgresRentasCatalogoRepository(session).crearUnidad(UUID_A, { nombre: "S", propietarioId: null, duracionMinimaNoches: 1 })).rejects.toMatchObject({ code: "42883" });
    // ...y aun asi la sesion quedo utilizable para que un catch exterior no la encuentre abortada.
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });
});

describe("PostgresRentasCatalogoRepository: reglas de negocio de las funciones SQL", () => {
  const casos: readonly { code: string; motivo: string; mensajeSql: string; esperado: string }[] = [
    { code: "42501", motivo: "sin_permiso", mensajeSql: "rentas.crear_unidad: tu rol no puede crear unidades en esta propiedad.", esperado: "tu rol no puede crear unidades en esta propiedad." },
    { code: "22023", motivo: "invalido", mensajeSql: "rentas.crear_unidad: la estancia minima debe estar entre 1 y 365 noches.", esperado: "la estancia minima debe estar entre 1 y 365 noches." },
    { code: "23505", motivo: "duplicado", mensajeSql: "rentas.crear_unidad: ya existe una unidad con ese nombre en esta propiedad.", esperado: "ya existe una unidad con ese nombre en esta propiedad." },
    { code: "55000", motivo: "regla_integridad", mensajeSql: "rentas.crear_unidad: regla de integridad.", esperado: "regla de integridad." },
    { code: "P0002", motivo: "no_encontrado", mensajeSql: "rentas.crear_unidad: unidad no encontrada.", esperado: "unidad no encontrada." },
  ];
  for (const c of casos) {
    it(`SQLSTATE ${c.code} -> rechazado/${c.motivo} con el mensaje de la funcion, y la sesion sigue utilizable`, async () => {
      const session = new AbortAwareFakeSession([
        { match: /rentas\.crear_unidad\(/, respond: () => pgError(c.code, c.mensajeSql) },
        { match: /select 1 as sigue_viva/, respond: () => [{ sigue_viva: 1 }] },
      ]);
      const res = await new PostgresRentasCatalogoRepository(session).crearUnidad(UUID_A, { nombre: "S", propietarioId: null, duracionMinimaNoches: 1 });
      expect(res).toEqual({ estado: "rechazado", motivo: c.motivo, mensaje: c.esperado });
      await expect(session.query("select 1 as sigue_viva")).resolves.toEqual({ rows: [{ sigue_viva: 1 }] });
    });
  }

  it("un 42501 del motor (permission denied for table ...) no filtra el detalle: mensaje generico", async () => {
    const session = new AbortAwareFakeSession([{ match: /crear_unidad/, respond: () => pgError("42501", 'permission denied for table "unidad"') }]);
    const res = await new PostgresRentasCatalogoRepository(session).crearUnidad(UUID_A, { nombre: "S", propietarioId: null, duracionMinimaNoches: 1 });
    expect(res).toEqual({ estado: "rechazado", motivo: "sin_permiso", mensaje: "No tienes permiso para esta acción." });
  });

  it("un error inesperado (p. ej. conexion caida) se propaga: nunca se disfraza de rechazo", async () => {
    const session = new AbortAwareFakeSession([{ match: /crear_unidad/, respond: () => pgError("08006", "connection failure") }]);
    await expect(new PostgresRentasCatalogoRepository(session).crearUnidad(UUID_A, { nombre: "S", propietarioId: null, duracionMinimaNoches: 1 })).rejects.toMatchObject({ code: "08006" });
  });

  it("camino feliz: devuelve el id que regreso la funcion y libera el SAVEPOINT", async () => {
    const session = new AbortAwareFakeSession([{ match: /rentas\.crear_unidad\(/, respond: () => [{ id: UUID_B }] }]);
    const res = await new PostgresRentasCatalogoRepository(session).crearUnidad(UUID_A, { nombre: "S", propietarioId: null, duracionMinimaNoches: 2 });
    expect(res).toEqual({ estado: "ok", valor: { id: UUID_B } });
    expect(session.calls.some((c) => c.startsWith("release savepoint"))).toBe(true);
  });

  it("sembrar devuelve la cantidad creada como numero", async () => {
    const session = new AbortAwareFakeSession([{ match: /sembrar_reglas_comision_por_defecto/, respond: () => [{ creadas: "3" }] }]);
    expect(await new PostgresRentasCatalogoRepository(session).sembrarReglasComisionPorDefecto(UUID_A)).toEqual({ estado: "ok", valor: { creadas: 3 } });
  });

  it("quitar el propietario o el correo se envia como bandera explicita (null no es lo mismo que ausente)", async () => {
    const parametros: unknown[][] = [];
    const session = {
      async query(_sql: string, params?: unknown[]) {
        parametros.push(params ?? []);
        return { rows: [{ id: UUID_B }] };
      },
      async exec() {},
    };
    const repo = new PostgresRentasCatalogoRepository(session as never);
    await repo.actualizarUnidad(UUID_A, { propietarioId: null });
    await repo.actualizarUnidad(UUID_A, { nombre: "Solo nombre" });
    await repo.actualizarPropietario(UUID_A, UUID_B, { email: null });
    await repo.actualizarPropietario(UUID_A, UUID_B, { nombre: "Solo nombre" });
    expect(parametros).toEqual([
      [UUID_A, null, null, true, null],
      [UUID_A, "Solo nombre", null, false, null],
      [UUID_A, UUID_B, null, null, true],
      [UUID_A, UUID_B, "Solo nombre", null, false],
    ]);
  });
});
