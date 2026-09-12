/**
 * `FakeGenericPacAdapter` — base común de los PAC simulados (`FakeFinkokAdapter`/
 * `FakeSwSapienAdapter`, construidos con un nombre de proveedor, `simulated: true`).
 * Puerto ~literal de `hoteles/packages/mcp-servers/cfdi/src/adapters/fake-pac-adapter.ts`
 * — necesario para probar la mitigación "2 PAC intercambiables" (dual-pac-cfdi-port.ts)
 * y para que TODA la suite de CFDI de hospedaje corra en verde sin credenciales de un
 * PAC real (nunca se llama a un proveedor real en tests).
 */
import { randomUUID, createHash } from "node:crypto";
import { InMemoryIdempotencyStore, InMemoryReplayGuard, signHmac, verifyHmacSignature, WebhookReplayError, WebhookSignatureError, type AdapterStatus } from "../shared.ts";
import { CfdiFolioConflictError, type CancelarInput, type CfdiCancelacion, type CfdiPort, type CfdiTimbrado, type CfdiWebhookEvent, type DomainCfdiStatus, type TimbrarInput } from "../port.ts";

interface StampedRecord {
  readonly timbrado: CfdiTimbrado;
  readonly inputHash: string;
}

function hashInput(input: TimbrarInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export class FakeGenericPacAdapter implements CfdiPort {
  readonly simulated = true as const;
  private readonly byFolio = new Map<string, StampedRecord>();
  private readonly byUuid = new Map<string, CfdiTimbrado>();
  private readonly cancelIdempotency = new InMemoryIdempotencyStore<CfdiCancelacion>();
  private readonly replayGuard = new InMemoryReplayGuard();

  /** Si `true`, simula que este PAC está caído (para probar la conmutación al secundario). */
  public down = false;

  private readonly providerName: string;
  private readonly webhookSecret: string;

  constructor(providerName: string, webhookSecret: string) {
    this.providerName = providerName;
    this.webhookSecret = webhookSecret;
  }

  status(): AdapterStatus {
    return {
      provider: this.providerName,
      available: !this.down,
      simulated: true,
      reason: this.down ? "simulación de caída para prueba de conmutación" : undefined,
    };
  }

  async timbrar(input: TimbrarInput): Promise<CfdiTimbrado> {
    if (this.down) throw new Error(`${this.providerName}: PAC no disponible (simulado)`);
    const existing = this.byFolio.get(input.folio);
    const inputHash = hashInput(input);
    if (existing) {
      if (existing.inputHash !== inputHash) throw new CfdiFolioConflictError(input.folio);
      return existing.timbrado;
    }
    const timbrado: CfdiTimbrado = {
      uuid: randomUUID(),
      folio: input.folio,
      status: "timbrado",
      selloDigital: createHash("sha256").update(`${this.providerName}:${input.folio}`).digest("base64"),
      fechaTimbrado: new Date().toISOString(),
      pac: this.providerName,
    };
    this.byFolio.set(input.folio, { timbrado, inputHash });
    this.byUuid.set(timbrado.uuid, timbrado);
    return timbrado;
  }

  async cancelar(input: CancelarInput): Promise<CfdiCancelacion> {
    const existing = this.cancelIdempotency.get(input.idempotencyKey);
    if (existing) return existing;
    const timbrado = this.byUuid.get(input.uuid);
    if (!timbrado) throw new Error(`${this.providerName}: UUID desconocido ${input.uuid}`);
    this.byUuid.set(input.uuid, { ...timbrado, status: "cancelado" });
    const cancelacion: CfdiCancelacion = { uuid: input.uuid, status: "cancelado", fechaSolicitud: new Date().toISOString() };
    this.cancelIdempotency.set(input.idempotencyKey, cancelacion);
    return cancelacion;
  }

  async consultarEstado(uuid: string): Promise<DomainCfdiStatus> {
    const timbrado = this.byUuid.get(uuid);
    if (!timbrado) throw new Error(`${this.providerName}: UUID desconocido ${uuid}`);
    return timbrado.status;
  }

  async verifyAndNormalizeWebhook(rawBody: string, signatureHeader: string | undefined): Promise<CfdiWebhookEvent> {
    if (!verifyHmacSignature(rawBody, signatureHeader, this.webhookSecret)) {
      throw new WebhookSignatureError(this.providerName);
    }
    const payload = JSON.parse(rawBody) as {
      event_id: string;
      type: CfdiWebhookEvent["type"];
      uuid: string;
      status: DomainCfdiStatus;
      occurred_at: string;
    };
    if (this.replayGuard.seenBefore(payload.event_id)) {
      throw new WebhookReplayError(this.providerName, payload.event_id);
    }
    return {
      eventId: payload.event_id,
      type: payload.type,
      uuid: payload.uuid,
      status: payload.status,
      occurredAt: payload.occurred_at,
      raw: payload,
    };
  }

  /** Solo para pruebas: firma un payload de webhook con el secreto de este PAC simulado. */
  signWebhookFixture(payload: Record<string, unknown>): { rawBody: string; signature: string } {
    const rawBody = JSON.stringify(payload);
    return { rawBody, signature: signHmac(rawBody, this.webhookSecret) };
  }
}

export const FAKE_FINKOK_WEBHOOK_SECRET = "test-secret-finkok-simulado";
export const FAKE_SW_WEBHOOK_SECRET = "test-secret-sw-simulado";

export class FakeFinkokAdapter extends FakeGenericPacAdapter {
  constructor(webhookSecret: string = FAKE_FINKOK_WEBHOOK_SECRET) {
    super("finkok", webhookSecret);
  }
}

export class FakeSwSapienAdapter extends FakeGenericPacAdapter {
  constructor(webhookSecret: string = FAKE_SW_WEBHOOK_SECRET) {
    super("sw-sapien", webhookSecret);
  }
}
