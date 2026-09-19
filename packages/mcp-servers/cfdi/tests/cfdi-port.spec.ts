// Pruebas de contrato de CfdiPort: el mismo comportamiento (idempotencia por folio,
// conflicto ante datos distintos, conmutación dual-PAC, verificación de webhook) se
// exige de CUALQUIER implementación real o simulada — mismo espíritu que
// packages/domain-despachos/tests/reglas-fiscales-avanzadas.spec.ts para el motor
// fiscal. Corre enteramente contra los adaptadores Fake: nunca requiere una API key
// real de Finkok/SW Sapien.
import { describe, expect, it } from "vitest";
import {
  CfdiFolioConflictError,
  CfdiFolioStampingInProgressError,
  DualPacCfdiPort,
  FakeFinkokAdapter,
  FakeSwSapienAdapter,
  FinkokAdapter,
  InMemoryFolioReservationStore,
  SwSapienAdapter,
  PortUnavailableError,
  type CancelarInput,
  type CfdiCancelacion,
  type CfdiPort,
  type CfdiTimbrado,
  type CfdiWebhookEvent,
  type DomainCfdiStatus,
  type TimbrarInput,
} from "../src/index.ts";

/** Envuelve un `CfdiPort` real contando cuántas veces se llamó `timbrar()` de
 *  verdad, con un retraso artificial para ensanchar la ventana de la carrera
 *  (aunque, como se explica en `dual-pac-cfdi-port.ts`, el `await` real de CUALQUIER
 *  llamada -- incluso instantánea -- ya basta para reproducir el TOCTOU original). */
class CountingCfdiPort implements CfdiPort {
  callCount = 0;
  constructor(
    private readonly inner: CfdiPort,
    private readonly delayMs = 10,
  ) {}
  status() {
    return this.inner.status();
  }
  async timbrar(input: TimbrarInput): Promise<CfdiTimbrado> {
    this.callCount += 1;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.inner.timbrar(input);
  }
  async cancelar(input: CancelarInput): Promise<CfdiCancelacion> {
    return this.inner.cancelar(input);
  }
  async consultarEstado(uuid: string): Promise<DomainCfdiStatus> {
    return this.inner.consultarEstado(uuid);
  }
  async verifyAndNormalizeWebhook(rawBody: string, signatureHeader: string | undefined): Promise<CfdiWebhookEvent> {
    return this.inner.verifyAndNormalizeWebhook(rawBody, signatureHeader);
  }
}

function timbrarInput(overrides: Partial<TimbrarInput> = {}): TimbrarInput {
  return {
    folio: "folio-test-1:hospedaje",
    rfcEmisor: "HTP850101AB1",
    rfcReceptor: "XAXX010101000",
    subtotal: 1000,
    iva: 160,
    impuestosLocales: { ishTasa: 0.03, ishMonto: 30 },
    total: 1190,
    moneda: "MXN",
    usoCfdi: "S01",
    metodoPago: "PUE",
    ...overrides,
  };
}

describe("FakeFinkokAdapter / FakeSwSapienAdapter — contrato de CfdiPort", () => {
  it("timbrar es idempotente por folio: la misma entrada devuelve el mismo UUID", async () => {
    const pac = new FakeFinkokAdapter();
    const first = await pac.timbrar(timbrarInput());
    const second = await pac.timbrar(timbrarInput());
    expect(second.uuid).toBe(first.uuid);
    expect(second.status).toBe("timbrado");
  });

  it("timbrar el mismo folio con datos DISTINTOS lanza CfdiFolioConflictError", async () => {
    const pac = new FakeFinkokAdapter();
    await pac.timbrar(timbrarInput());
    await expect(pac.timbrar(timbrarInput({ total: 2000 }))).rejects.toBeInstanceOf(CfdiFolioConflictError);
  });

  it("cancelar es idempotente por idempotencyKey", async () => {
    const pac = new FakeFinkokAdapter();
    const timbrado = await pac.timbrar(timbrarInput());
    const first = await pac.cancelar({ uuid: timbrado.uuid, motivo: "02", idempotencyKey: "cancel-1" });
    const second = await pac.cancelar({ uuid: timbrado.uuid, motivo: "02", idempotencyKey: "cancel-1" });
    expect(second).toEqual(first);
    expect(await pac.consultarEstado(timbrado.uuid)).toBe("cancelado");
  });

  it("verifyAndNormalizeWebhook rechaza una firma inválida y detecta un replay", async () => {
    const pac = new FakeFinkokAdapter();
    const timbrado = await pac.timbrar(timbrarInput());
    const { rawBody, signature } = pac.signWebhookFixture({
      event_id: "evt-1",
      type: "cfdi.timbrado_confirmado",
      uuid: timbrado.uuid,
      status: "timbrado",
      occurred_at: new Date().toISOString(),
    });

    await expect(pac.verifyAndNormalizeWebhook(rawBody, "sha256=firma-invalida")).rejects.toThrow();

    const normalized = await pac.verifyAndNormalizeWebhook(rawBody, signature);
    expect(normalized.eventId).toBe("evt-1");

    await expect(pac.verifyAndNormalizeWebhook(rawBody, signature)).rejects.toThrow(/replay/);
  });
});

describe("DualPacCfdiPort — conmutación primario/secundario", () => {
  it("timbra con el primario cuando está disponible", async () => {
    const primary = new FakeFinkokAdapter();
    const secondary = new FakeSwSapienAdapter();
    const dual = new DualPacCfdiPort(primary, secondary);
    const timbrado = await dual.timbrar(timbrarInput());
    expect(timbrado.pac).toBe("finkok");
    expect(await dual.usedSecondaryFor(timbrarInput().folio)).toBe(false);
  });

  it("conmuta al secundario si el primario falla, sin timbrar dos veces", async () => {
    const primary = new FakeFinkokAdapter();
    primary.down = true;
    const secondary = new FakeSwSapienAdapter();
    const dual = new DualPacCfdiPort(primary, secondary);
    const timbrado = await dual.timbrar(timbrarInput());
    expect(timbrado.pac).toBe("sw-sapien");
    expect(await dual.usedSecondaryFor(timbrarInput().folio)).toBe(true);

    // Reintentar el mismo folio no vuelve a llamar a ningún PAC -- responde desde la reserva ya completada del wrapper.
    const second = await dual.timbrar(timbrarInput());
    expect(second.uuid).toBe(timbrado.uuid);
  });

  it("lanza AggregateError si AMBOS PAC fallan", async () => {
    const primary = new FakeFinkokAdapter();
    primary.down = true;
    const secondary = new FakeSwSapienAdapter();
    secondary.down = true;
    const dual = new DualPacCfdiPort(primary, secondary);
    await expect(dual.timbrar(timbrarInput())).rejects.toBeInstanceOf(AggregateError);
  });

  // Fix hallazgo auditoría (rubro 6, ALTA) — antes del fix, `DualPacCfdiPort.timbrar`
  // hacía `get()` (cache miss) y solo escribía el `Map` DESPUÉS de que el PAC
  // respondiera: dos llamadas concurrentes al mismo folio pasaban el `get()` antes
  // de que cualquiera llegara a escribir, y AMBAS llamaban al PAC de verdad (doble
  // timbrado fiscal real). Este test falla contra esa implementación (callCount
  // sería 2) y pasa contra la reserva atómica actual (callCount siempre 1).
  it("dos llamadas concurrentes a timbrar() con el mismo folio resultan en UNA sola llamada real al PAC", async () => {
    const primary = new CountingCfdiPort(new FakeFinkokAdapter());
    const secondary = new FakeSwSapienAdapter();
    const dual = new DualPacCfdiPort(primary, secondary);
    const input = timbrarInput({ folio: "folio-race-concurrente:hospedaje" });

    const [first, second] = await Promise.allSettled([dual.timbrar(input), dual.timbrar(input)]);

    expect(primary.callCount).toBe(1);
    // Exactamente una de las dos gana la reserva y timbra de verdad; la otra falla
    // rápido (política elegida: fail-fast, no esperar/reintentar) en vez de
    // disparar una segunda llamada al PAC.
    const outcomes = [first, second];
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (fulfilled[0]?.status === "fulfilled") expect(fulfilled[0].value.pac).toBe("finkok");
    if (rejected[0]?.status === "rejected") expect(rejected[0].reason).toBeInstanceOf(CfdiFolioStampingInProgressError);
  });

  it("libera la reserva del folio si AMBOS PAC fallan, permitiendo un reintento real posterior", async () => {
    const primary = new FakeFinkokAdapter();
    primary.down = true;
    const secondary = new FakeSwSapienAdapter();
    secondary.down = true;
    const dual = new DualPacCfdiPort(primary, secondary);
    const input = timbrarInput({ folio: "folio-reintento-tras-fallo:hospedaje" });

    await expect(dual.timbrar(input)).rejects.toBeInstanceOf(AggregateError);

    // El folio NO debe quedar bloqueado para siempre por el fallo transitorio --
    // en cuanto el PAC primario "se recupera", un reintento del mismo folio debe
    // poder timbrar de verdad.
    primary.down = false;
    const timbrado = await dual.timbrar(input);
    expect(timbrado.pac).toBe("finkok");
  });

  it("status() reporta el primario cuando está disponible, y explica la conmutación cuando no", () => {
    const primary = new FakeFinkokAdapter();
    const secondary = new FakeSwSapienAdapter();
    const dual = new DualPacCfdiPort(primary, secondary);
    expect(dual.status().provider).toBe("finkok");

    primary.down = true;
    const status = dual.status();
    expect(status.provider).toBe("sw-sapien");
    expect(status.reason).toMatch(/PAC primario no disponible/);
  });
});

describe("FinkokAdapter / SwSapienAdapter — adaptadores reales, esqueleto honesto", () => {
  it("sin variables de entorno de credenciales, status() reporta unavailable y CUALQUIER llamada falla explícito (nunca inventa un timbrado)", async () => {
    const finkok = new FinkokAdapter();
    expect(finkok.status().available).toBe(false);
    expect(finkok.status().simulated).toBe(false);
    await expect(finkok.timbrar(timbrarInput())).rejects.toBeInstanceOf(PortUnavailableError);
    await expect(finkok.consultarEstado("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(PortUnavailableError);

    const sw = new SwSapienAdapter();
    expect(sw.status().available).toBe(false);
    await expect(sw.timbrar(timbrarInput())).rejects.toBeInstanceOf(PortUnavailableError);
  });
});

describe("InMemoryFolioReservationStore — semántica de referencia de FolioReservationStore", () => {
  it("reserve() es reserved la primera vez, in_progress mientras esté pending, y completed tras complete()", async () => {
    const store = new InMemoryFolioReservationStore<{ marca: string }>();
    expect(await store.reserve("folio-a")).toEqual({ kind: "reserved" });
    expect(await store.reserve("folio-a")).toEqual({ kind: "in_progress" });

    await store.complete("folio-a", { marca: "listo" });
    expect(await store.reserve("folio-a")).toEqual({ kind: "completed", value: { marca: "listo" } });
    expect(await store.peek("folio-a")).toEqual({ marca: "listo" });
  });

  it("fail() libera la reserva -- reserve() posterior vuelve a ver reserved", async () => {
    const store = new InMemoryFolioReservationStore<{ marca: string }>();
    expect(await store.reserve("folio-b")).toEqual({ kind: "reserved" });
    await store.fail("folio-b");
    expect(await store.reserve("folio-b")).toEqual({ kind: "reserved" });
    expect(await store.peek("folio-b")).toBeUndefined();
  });

  it("una reserva pending abandonada más allá de staleAfterMs se puede reclamar como si fuera nueva", async () => {
    const store = new InMemoryFolioReservationStore<{ marca: string }>({ staleAfterMs: 10 });
    expect(await store.reserve("folio-c")).toEqual({ kind: "reserved" });
    // Nadie llamó complete()/fail() -- simula un proceso que murió a medio timbrar.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await store.reserve("folio-c")).toEqual({ kind: "reserved" });
  });
});
