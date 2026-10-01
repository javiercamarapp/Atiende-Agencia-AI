// H-03 -- gobierno del agente de WhatsApp de hoteles: kill switch por property + presupuesto mensual propio + registro del
// costo de cada turno (migracion 035). Se arma por sesion de sistema (una transaccion por mensaje entrante) en
// production/deps.ts. Pausado o sin presupuesto: NO corre el LLM; el mensaje se deriva a una persona (contacto no
// operativo + acuse de recibo), nunca se pierde. Base sin la 035: la compuerta devuelve null y el agente corre como siempre.
import type { LlmGateway } from "@atiende/agent-core";
import {
  acknowledgeOnlyTurnHandler,
  createLlmHotelesWhatsAppTurnHandler,
  meterGateway,
  runGovernedAgent,
  type AgentesRepository,
  type HotelesRepository,
  type HotelesWhatsAppTurnHandler,
  type ReservasAgenteRepository,
} from "@atiende/domain-hoteles";

export interface GovernedHotelesTurnOptions {
  readonly hoteles: HotelesRepository;
  readonly agentes: AgentesRepository;
  readonly gateway: Pick<LlmGateway, "complete">;
  readonly defaultRole: string;
  readonly escalatedRole: string;
  /** H-25: agente de reservas (solo se expone si el hotel habilito los holds en su politica; base sin migrar = sin herramientas). */
  readonly reservas?: ReservasAgenteRepository;
  readonly now?: () => Date;
  readonly onError?: (err: unknown) => void;
}

export function buildGovernedHotelesTurnHandler(opts: GovernedHotelesTurnOptions): HotelesWhatsAppTurnHandler {
  const clock = opts.now ?? (() => new Date());
  return {
    handleInboundMessage: (args) =>
      runGovernedAgent({
        repo: opts.agentes,
        propertyId: args.propertyId,
        agentKey: "recepcion_whatsapp",
        now: clock(),
        run: (meter) =>
          createLlmHotelesWhatsAppTurnHandler(opts.hoteles, meterGateway(opts.gateway, meter), {
            defaultRole: opts.defaultRole,
            escalatedRole: opts.escalatedRole,
            ...(opts.reservas ? { reservas: opts.reservas } : {}),
          }).handleInboundMessage(args),
        blocked: () => acknowledgeOnlyTurnHandler(opts.hoteles).handleInboundMessage(args),
        ...(opts.onError ? { onError: opts.onError } : {}),
      }),
  };
}
