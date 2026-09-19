/**
 * `DualPacCfdiPort` — envuelve dos `CfdiPort` (primario/secundario) e implementa la
 * mitigación de riesgo de "CFDI de hospedaje mal timbrado": validador fiscal previo
 * (`@atiende/domain-hoteles::validarCfdiHospedaje`) + dos PAC intercambiables. Si el
 * PAC primario falla al timbrar, conmuta al secundario SIN duplicar el timbrado
 * (idempotencia por `folio` a nivel de este wrapper, independiente de cada PAC
 * individual). Puerto ~literal de
 * `hoteles/packages/mcp-servers/cfdi/src/adapters/dual-pac-cfdi-port.ts`.
 *
 * No es un `CfdiPort` "real" por sí mismo — compone dos adaptadores (reales o
 * simulados) ya construidos.
 *
 * Fix hallazgo auditoría (rubro 6, ALTA) — la idempotencia por folio ANTES vivía en
 * un `InMemoryIdempotencyStore` (un `Map` de proceso): un TOCTOU real, ver el
 * comentario de cabecera de `FolioReservationStore` en `../shared.ts` para el
 * detalle completo del riesgo (doble timbrado fiscal real ante el SAT). Ahora
 * `timbrar()` PRIMERO reserva el folio atómicamente (`reservations.reserve`, por
 * default un `InMemoryFolioReservationStore` -- correcto para tests/adaptadores
 * Fake, pero en producción `apps/api/src/production/deps.ts` inyecta un
 * `FolioReservationStore` respaldado por Postgres) y SOLO SI la reserva la ganó
 * este llamador invoca al PAC.
 *
 * Política elegida ante una carrera real (decisión de diseño, no obvia): FALLAR
 * RÁPIDO (`CfdiFolioStampingInProgressError`) cuando otro proceso tiene una reserva
 * viva del mismo folio, en vez de esperar/hacer polling a que termine. Se prefiere
 * así porque (a) timbrar un CFDI de hospedaje es una operación de escritura de
 * dinero/fiscal disparada por una acción explícita de staff (nunca un poller de
 * fondo), así que un 409 que el cliente reintenta en unos segundos es aceptable y
 * mucho más simple/seguro que mantener una conexión HTTP abierta esperando a un
 * proceso ajeno; y (b) esperar indefinidamente a una reserva de un proceso que
 * pudo haber muerto a medio timbrar (crash de la instancia serverless, sin
 * `finally`) dejaría al cliente colgado sin límite -- el `staleAfterMs` de la
 * reserva (ver `FolioReservationStore`) ya cubre ese caso dejando que un
 * REINTENTO posterior (no la misma request) reclame la reserva abandonada.
 */
import { InMemoryFolioReservationStore, type AdapterStatus, type FolioReservationStore } from "../shared.ts";
import { CfdiFolioStampingInProgressError, type CancelarInput, type CfdiCancelacion, type CfdiPort, type CfdiTimbrado, type CfdiWebhookEvent, type DomainCfdiStatus, type TimbrarInput } from "../port.ts";

interface StampedFolio {
  readonly timbrado: CfdiTimbrado;
  readonly usedSecondary: boolean;
}

export interface DualPacCfdiPortOptions {
  /** Store de reserva atómica por folio -- default: `InMemoryFolioReservationStore`
   *  (correcto para tests y para los adaptadores Fake; en producción real inyecta
   *  aquí un store respaldado por Postgres, ver
   *  `apps/api/src/production/cfdi-folio-reservation-store.ts`). */
  readonly reservationStore?: FolioReservationStore<StampedFolio>;
}

export class DualPacCfdiPort implements CfdiPort {
  private readonly reservations: FolioReservationStore<StampedFolio>;
  private readonly primary: CfdiPort;
  private readonly secondary: CfdiPort;

  constructor(primary: CfdiPort, secondary: CfdiPort, options: DualPacCfdiPortOptions = {}) {
    this.primary = primary;
    this.secondary = secondary;
    this.reservations = options.reservationStore ?? new InMemoryFolioReservationStore<StampedFolio>();
  }

  status(): AdapterStatus {
    const primaryStatus = this.primary.status();
    if (primaryStatus.available) return primaryStatus;
    const secondaryStatus = this.secondary.status();
    return {
      ...secondaryStatus,
      reason: secondaryStatus.available ? `PAC primario no disponible (${primaryStatus.reason ?? "sin razón"}); usando secundario` : secondaryStatus.reason,
    };
  }

  async timbrar(input: TimbrarInput): Promise<CfdiTimbrado> {
    const outcome = await this.reservations.reserve(input.folio);
    if (outcome.kind === "completed") return outcome.value.timbrado;
    if (outcome.kind === "in_progress") throw new CfdiFolioStampingInProgressError(input.folio);

    // outcome.kind === "reserved" -- este llamador ganó la reserva atómica: es el
    // ÚNICO que puede invocar al PAC para este folio hasta que `complete`/`fail`
    // libere la reserva. Ningún otro llamador concurrente (mismo proceso, otra
    // instancia, o un reintento futuro mientras esta reserva siga viva) puede
    // llegar aquí para el mismo folio.
    try {
      const timbrado = await this.primary.timbrar(input);
      await this.reservations.complete(input.folio, { timbrado, usedSecondary: false });
      return timbrado;
    } catch (primaryError) {
      try {
        const timbrado = await this.secondary.timbrar(input);
        await this.reservations.complete(input.folio, { timbrado, usedSecondary: true });
        return timbrado;
      } catch (secondaryError) {
        // Ambos PAC fallaron: se libera la reserva (nunca se persiste un
        // timbrado que nunca ocurrió) para que un reintento posterior pueda
        // volver a intentarlo -- un folio nunca debe quedar bloqueado para
        // siempre por un error transitorio (timeout de red, PAC caído, etc.).
        await this.reservations.fail(input.folio);
        throw new AggregateError([primaryError, secondaryError], `no se pudo timbrar el folio ${input.folio} ni con el PAC primario ni con el secundario`);
      }
    }
  }

  /** Solo para pruebas: si el último timbrado exitoso de este folio usó el PAC secundario. */
  async usedSecondaryFor(folio: string): Promise<boolean | undefined> {
    const stamped = await this.reservations.peek(folio);
    return stamped?.usedSecondary;
  }

  async cancelar(input: CancelarInput): Promise<CfdiCancelacion> {
    // La cancelación se dirige siempre al PAC que timbró originalmente el UUID; en
    // este wrapper simplificado se intenta primero el primario (mismo criterio de
    // fallback).
    try {
      return await this.primary.cancelar(input);
    } catch {
      return this.secondary.cancelar(input);
    }
  }

  async consultarEstado(uuid: string): Promise<DomainCfdiStatus> {
    try {
      return await this.primary.consultarEstado(uuid);
    } catch {
      return this.secondary.consultarEstado(uuid);
    }
  }

  async verifyAndNormalizeWebhook(rawBody: string, signatureHeader: string | undefined): Promise<CfdiWebhookEvent> {
    try {
      return await this.primary.verifyAndNormalizeWebhook(rawBody, signatureHeader);
    } catch {
      return this.secondary.verifyAndNormalizeWebhook(rawBody, signatureHeader);
    }
  }
}
