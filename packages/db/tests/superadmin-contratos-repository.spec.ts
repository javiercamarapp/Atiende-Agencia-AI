// Adaptador Postgres del contrato por cliente (SA-43): base sin migrar (42883/42P01/42703) con una sesion que
// reproduce el estado ABORTADO real de una transaccion (AbortAwareFakeSession) -- una sesion falsa plana no
// distinguiria una implementacion sin SAVEPOINT --, traduccion de SQLSTATE de negocio a errores tipados, mapeo de
// filas (bigint llega como string del driver, fechas como YYYY-MM-DD) y las reglas del adaptador en memoria que
// usan los tests de rutas (vigencias traslapadas, enmiendas, solo-lectura del rol finanzas).
import { describe, expect, it } from "vitest";
import { InMemoryContratosRepository, PostgresContratosRepository, SuperadminSeguridadError } from "../src/index.ts";
import type { TerminosContratoInput } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const terminos = (parche: Partial<TerminosContratoInput> = {}): TerminosContratoInput => ({
  vigenteDesde: "2026-10-01",
  vigenteHasta: null,
  baseCentavos: 590_000,
  porSucursalCentavos: 400_000,
  sucursalesIncluidas: 1,
  bolsaMinutos: 10_000,
  excedenteCentavosMinuto: 300,
  instalacionCentavos: 4_500_000,
  descuentoBp: 0,
  descuentoFijoCentavos: 0,
  motivo: "Alta del contrato segun la propuesta firmada.",
  ...parche,
});

describe("PostgresContratosRepository -- base sin migrar", () => {
  const funciones = ["list_customer_contracts_for_superadmin", "superadmin_create_contract", "superadmin_amend_contract", "get_contract_billing_inputs_for_superadmin"];

  it("cada metodo sin migracion devuelve not_migrated con datos vacios Y deja la sesion utilizable (no 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      ...funciones.map((f) => ({ match: new RegExp(f), respond: () => pgError("42883", `function core.${f}(uuid) does not exist`) })),
      { match: /select 1 as sigue_viva/, respond: () => [{ sigue_viva: 1 }] },
    ]);
    const repo = new PostgresContratosRepository(session);
    await expect(repo.listVersions("u1", null)).resolves.toEqual({ availability: "not_migrated", versions: [] });
    await expect(repo.createContract("u1", "o1", terminos())).resolves.toEqual({ availability: "not_migrated", contractId: null });
    await expect(repo.amendContract("u1", "c1", terminos())).resolves.toEqual({ availability: "not_migrated", version: null });
    await expect(repo.getBillingInputs("u1", "o1", "2026-10")).resolves.toEqual({ availability: "not_migrated", inputs: null });
    // La prueba real: despues de 4 errores la sesion sigue viva (cada uno hizo ROLLBACK TO SAVEPOINT).
    await expect(session.query("select 1 as sigue_viva")).resolves.toEqual({ rows: [{ sigue_viva: 1 }] });
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint"))).toHaveLength(4);
  });

  it("tabla/columna ausente (42P01/42703) tambien degrada; un 42883 de tipos (bug real) NO se enmascara", async () => {
    const tabla = new AbortAwareFakeSession([{ match: /list_customer_contracts/, respond: () => pgError("42P01", 'relation "core.customer_contract_version" does not exist') }]);
    await expect(new PostgresContratosRepository(tabla).listVersions("u1", "o1")).resolves.toEqual({ availability: "not_migrated", versions: [] });
    const columna = new AbortAwareFakeSession([{ match: /get_contract_billing_inputs/, respond: () => pgError("42703", "column x does not exist") }]);
    await expect(new PostgresContratosRepository(columna).getBillingInputs("u1", "o1", "2026-10")).resolves.toEqual({ availability: "not_migrated", inputs: null });
    const tipos = new AbortAwareFakeSession([{ match: /list_customer_contracts/, respond: () => pgError("42883", "operator does not exist: uuid = text") }]);
    await expect(new PostgresContratosRepository(tipos).listVersions("u1", null)).rejects.toThrow(/operator does not exist/);
  });
});

describe("PostgresContratosRepository -- errores de negocio y mapeo", () => {
  const cases: Array<[string, "forbidden" | "invalid" | "not_found" | "conflict"]> = [
    ["42501", "forbidden"],
    ["22023", "invalid"],
    ["23514", "invalid"],
    ["P0002", "not_found"],
    ["23505", "conflict"],
    ["23P01", "conflict"],
  ];
  for (const [sqlstate, code] of cases) {
    it(`SQLSTATE ${sqlstate} -> ${code} (y la sesion queda usable)`, async () => {
      const session = new AbortAwareFakeSession([
        { match: /superadmin_create_contract/, respond: () => pgError(sqlstate, "falla de negocio") },
        { match: /select 1 as sigue_viva/, respond: () => [{ sigue_viva: 1 }] },
      ]);
      await expect(new PostgresContratosRepository(session).createContract("u1", "o1", terminos())).rejects.toMatchObject({ name: "SuperadminSeguridadError", code });
      await expect(session.query("select 1 as sigue_viva")).resolves.toBeDefined();
    });
  }

  it("un error desconocido se repropaga tal cual", async () => {
    const session = new AbortAwareFakeSession([{ match: /superadmin_amend_contract/, respond: () => pgError("XX000", "boom") }]);
    await expect(new PostgresContratosRepository(session).amendContract("u1", "c1", terminos())).rejects.toThrow("boom");
  });

  it("mapea el historial: bigint como string, fechas YYYY-MM-DD, autor y correo", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /list_customer_contracts/,
        respond: () => [
          {
            id: "v2", contract_id: "c1", organization_id: "o1", organization_name: "Org A", version: 2,
            vigente_desde: "2026-10-16", vigente_hasta: null, moneda: "MXN", base_centavos: "790000", por_sucursal_centavos: "400000",
            sucursales_incluidas: 1, bolsa_minutos: 10000, excedente_centavos_minuto: "300", instalacion_centavos: "4500000",
            descuento_bp: 1000, descuento_fijo_centavos: "5000", motivo: "Cambio de tarifa pactado en octubre.",
            created_by: "u1", created_by_email: "sa@example.com", created_at: "2026-10-01T10:00:00Z",
          },
        ],
      },
    ]);
    const { versions } = await new PostgresContratosRepository(session).listVersions("u1", "o1");
    expect(versions[0]).toEqual({
      id: "v2", contractId: "c1", organizationId: "o1", organizationName: "Org A", version: 2,
      vigenteDesde: "2026-10-16", vigenteHasta: null, moneda: "MXN", baseCentavos: 790_000, porSucursalCentavos: 400_000,
      sucursalesIncluidas: 1, bolsaMinutos: 10_000, excedenteCentavosMinuto: 300, instalacionCentavos: 4_500_000,
      descuentoBp: 1_000, descuentoFijoCentavos: 5_000, motivo: "Cambio de tarifa pactado en octubre.",
      creadoPor: "u1", creadoPorCorreo: "sa@example.com", creadoEnMs: Date.parse("2026-10-01T10:00:00Z"),
    });
  });

  it("mapea los insumos de facturacion (bigint como string) y devuelve null si no hay fila", async () => {
    const con = new AbortAwareFakeSession([{ match: /get_contract_billing_inputs/, respond: () => [{ sucursales_activas: 3, minutos_voz: "10500", eventos_voz: "12" }] }]);
    await expect(new PostgresContratosRepository(con).getBillingInputs("u1", "o1", "2026-10")).resolves.toEqual({ availability: "available", inputs: { sucursalesActivas: 3, minutosVoz: 10_500, eventosVoz: 12 } });
    const sin = new AbortAwareFakeSession([{ match: /get_contract_billing_inputs/, respond: () => [] }]);
    await expect(new PostgresContratosRepository(sin).getBillingInputs("u1", "o1", "2026-10")).resolves.toEqual({ availability: "available", inputs: null });
  });

  it("el mes se manda como primer dia del mes; el alta devuelve el contract_id", async () => {
    const params: unknown[][] = [];
    const session = {
      calls: [] as string[],
      async query<T>(sql: string, p?: unknown[]): Promise<{ rows: T[] }> {
        params.push(p ?? []);
        if (/superadmin_create_contract/.test(sql)) return { rows: [{ contract_id: "c-nuevo" }] as T[] };
        return { rows: [{ sucursales_activas: 1, minutos_voz: 0, eventos_voz: 0 }] as T[] };
      },
      async exec(): Promise<void> {},
    };
    const repo = new PostgresContratosRepository(session);
    await repo.getBillingInputs("u1", "o1", "2026-10");
    expect(params[params.length - 1]).toEqual(["u1", "o1", "2026-10-01"]);
    await expect(repo.createContract("u1", "o1", terminos())).resolves.toEqual({ availability: "available", contractId: "c-nuevo" });
    expect(params[params.length - 1]).toEqual(["u1", "o1", "2026-10-01", null, 590_000, 400_000, 1, 10_000, 300, 4_500_000, 0, 0, "Alta del contrato segun la propuesta firmada."]);
  });
});

describe("InMemoryContratosRepository", () => {
  const ahora = Date.parse("2026-10-20T18:00:00Z");
  function repo(): InMemoryContratosRepository {
    const r = new InMemoryContratosRepository({ now: () => ahora });
    r.seedSuperadmin("sa1", "sa1@example.com");
    r.seedSuperadmin("sa2", "sa2@example.com");
    r.seedFinanzas("fin1", "fin@example.com");
    r.seedOrganization("o1", "Org 1", 3);
    r.seedOrganization("o2", "Org 2", 0);
    return r;
  }

  it("el alta guarda version 1 con su autor; solo escribe un superadmin real (no finanzas, no otro usuario)", async () => {
    const r = repo();
    const { contractId } = await r.createContract("sa1", "o1", terminos());
    expect(contractId).toBeTruthy();
    const { versions } = await r.listVersions("sa1", "o1");
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, creadoPor: "sa1", creadoPorCorreo: "sa1@example.com", moneda: "MXN", organizationName: "Org 1" });
    await expect(r.createContract("fin1", "o1", terminos({ vigenteDesde: "2027-01-01" }))).rejects.toMatchObject({ code: "forbidden" });
    await expect(r.createContract("otro", "o2", terminos())).rejects.toMatchObject({ code: "forbidden" });
    await expect(r.createContract("sa1", "nope", terminos())).rejects.toMatchObject({ code: "not_found" });
  });

  it("vigencias traslapadas de la misma organizacion se rechazan; contiguas y de otra organizacion no", async () => {
    const r = repo();
    await r.createContract("sa1", "o1", terminos({ vigenteDesde: "2026-01-01", vigenteHasta: "2026-06-30" }));
    await expect(r.createContract("sa1", "o1", terminos({ vigenteDesde: "2026-06-30", vigenteHasta: null }))).rejects.toMatchObject({ code: "conflict" });
    await expect(r.createContract("sa1", "o1", terminos({ vigenteDesde: "2026-03-01", vigenteHasta: "2026-03-31" }))).rejects.toMatchObject({ code: "conflict" });
    await expect(r.createContract("sa1", "o1", terminos({ vigenteDesde: "2026-07-01", vigenteHasta: null }))).resolves.toMatchObject({ availability: "available" });
    await expect(r.createContract("sa1", "o2", terminos({ vigenteDesde: "2026-01-01", vigenteHasta: null }))).resolves.toMatchObject({ availability: "available" });
    // un contrato sin fin ya no admite otro posterior
    await expect(r.createContract("sa1", "o1", terminos({ vigenteDesde: "2030-01-01", vigenteHasta: null }))).rejects.toMatchObject({ code: "conflict" });
  });

  it("enmienda a mitad de mes: version 2 con otro autor, la 1 intacta, y el historial viene mas reciente primero", async () => {
    const r = repo();
    const { contractId } = await r.createContract("sa1", "o1", terminos({ vigenteDesde: "2026-07-01" }));
    await expect(r.amendContract("sa2", contractId as string, terminos({ vigenteDesde: "2026-10-16", baseCentavos: 790_000, motivo: "Sube la base por el alta de la sucursal 4." }))).resolves.toEqual({ availability: "available", version: 2 });
    const { versions } = await r.listVersions("sa1", "o1");
    expect(versions.map((v) => [v.version, v.baseCentavos, v.creadoPor])).toEqual([
      [2, 790_000, "sa2"],
      [1, 590_000, "sa1"],
    ]);
  });

  it("enmienda: sin cambios, en un mes ya pasado, no creciente, despues del fin o de un contrato inexistente, rechazada", async () => {
    const r = repo();
    const { contractId } = await r.createContract("sa1", "o1", terminos({ vigenteDesde: "2026-10-05", vigenteHasta: "2026-12-31" }));
    const id = contractId as string;
    await expect(r.amendContract("sa1", id, terminos({ vigenteDesde: "2026-10-16", vigenteHasta: "2026-12-31" }))).rejects.toMatchObject({ code: "invalid" }); // sin cambios
    await expect(r.amendContract("sa1", id, terminos({ vigenteDesde: "2026-09-30", vigenteHasta: "2026-12-31", baseCentavos: 1 }))).rejects.toMatchObject({ code: "invalid" }); // antes del mes en curso
    await expect(r.amendContract("sa1", id, terminos({ vigenteDesde: "2026-10-05", vigenteHasta: "2026-12-31", baseCentavos: 1 }))).rejects.toMatchObject({ code: "invalid" }); // no creciente
    await expect(r.amendContract("sa1", id, terminos({ vigenteDesde: "2027-01-02", vigenteHasta: "2027-06-30", baseCentavos: 1 }))).rejects.toMatchObject({ code: "invalid" }); // despues del fin
    await expect(r.amendContract("sa1", "nope", terminos({ baseCentavos: 1 }))).rejects.toMatchObject({ code: "not_found" });
    await expect(r.amendContract("fin1", id, terminos({ vigenteDesde: "2026-10-16", vigenteHasta: "2026-12-31", baseCentavos: 1 }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("una enmienda que extiende el fin sobre otro contrato se rechaza", async () => {
    const r = repo();
    const { contractId } = await r.createContract("sa1", "o1", terminos({ vigenteDesde: "2026-07-01", vigenteHasta: "2026-12-31" }));
    await r.createContract("sa1", "o1", terminos({ vigenteDesde: "2027-01-01", vigenteHasta: null }));
    await expect(r.amendContract("sa1", contractId as string, terminos({ vigenteDesde: "2026-10-16", vigenteHasta: "2027-02-01", baseCentavos: 1 }))).rejects.toMatchObject({ code: "conflict" });
  });

  it("valida terminos: flotantes, negativos, descuento > 100 %, fechas y motivo corto", async () => {
    const r = repo();
    const malos: Array<Partial<TerminosContratoInput>> = [
      { baseCentavos: 10.5 },
      { baseCentavos: -1 },
      { descuentoBp: 10_001 },
      { vigenteDesde: "2026-10-31", vigenteHasta: "2026-10-01" },
      { vigenteDesde: "31/10/2026" },
      { motivo: "corto" },
    ];
    for (const m of malos) await expect(r.createContract("sa1", "o1", terminos(m))).rejects.toBeInstanceOf(SuperadminSeguridadError);
  });

  it("lecturas: un usuario que no es superadmin recibe cero filas (nunca un error que confirme datos); finanzas lee", async () => {
    const r = repo();
    await r.createContract("sa1", "o1", terminos());
    r.seedVoz("o1", "2026-10", 10_500, 4);
    await expect(r.listVersions("otro", "o1")).resolves.toEqual({ availability: "available", versions: [] });
    expect((await r.listVersions("fin1", "o1")).versions).toHaveLength(1);
    await expect(r.getBillingInputs("otro", "o1", "2026-10")).resolves.toEqual({ availability: "available", inputs: null });
    await expect(r.getBillingInputs("sa1", "nope", "2026-10")).resolves.toEqual({ availability: "available", inputs: null });
    await expect(r.getBillingInputs("sa1", "o1", "2026-10")).resolves.toEqual({ availability: "available", inputs: { sucursalesActivas: 3, minutosVoz: 10_500, eventosVoz: 4 } });
    await expect(r.getBillingInputs("sa1", "o1", "2026-11")).resolves.toEqual({ availability: "available", inputs: { sucursalesActivas: 3, minutosVoz: 0, eventosVoz: 0 } });
  });
});
