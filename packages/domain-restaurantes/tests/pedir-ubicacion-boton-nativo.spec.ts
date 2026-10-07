// rescate-orig-restaurantes-1 §5: el pin se pide ademas con el boton nativo de WhatsApp (`location_request_message`), UNA sola vez por pedido,
// solo en domicilio y solo si el cliente aun no compartio su ubicacion. Pruebas de punta a punta: guion del modelo -> inbound -> outbox en memoria
// -> despachador real con el cliente de Graph FALSO (sin credenciales de Meta).
import { describe, expect, it } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionResult } from "@atiende/agent-core";
import { FakeWhatsAppGraphClient, WhatsAppOutboundDispatcher } from "@atiende/whatsapp-gateway";
import { createRestaurantesMessagingOutboxPort } from "../src/whatsapp/outbox-adapter.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import { formatLocationMessage } from "../src/whatsapp/location.ts";
import { PM_COPY } from "../src/whatsapp/perfil-pm.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import { seedConfirmedOrderFlow } from "./support/order-flow-seed.ts";

const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const llamada = (id: string, name: string, args: object): LlmCompletionResult => ({ text: "", toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const PM = { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null } as const;
const PHONE = "+5219990003333";

/** Cada turno del cliente: el modelo corre `herramientas` (tool calls, una por llamada al modelo) y luego contesta `respuesta`. */
function armar() {
  const f = buildRestaurantFixture();
  f.repo.seedKnownZone({ organizationId: f.organizationId, name: "Vista Alegre", lat: 21.0152, lng: -89.5995 });
  let cola: LlmCompletionResult[] = [];
  const provider = new FakeLlmProvider({ id: "guion", script: () => cola.shift() ?? texto("Con gusto.") });
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [provider]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "sin-uso" })]);
  const turnHandler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  let n = 0;
  const entrar = async (body: string, guion: LlmCompletionResult[]) => {
    cola = [...guion];
    n += 1;
    return handleInboundWhatsAppMessage(f.repo, turnHandler, { organizationId: f.organizationId, messageId: `wamid.U${n}`, phone: PHONE, body, phoneNumberId: "pn-t7" });
  };
  const solicitudes = () => f.repo.getOutbox().filter((o) => (o.payload as { solicitar_ubicacion?: boolean }).solicitar_ubicacion === true);
  return { f, entrar, solicitudes, preparar: () => f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM as never) };
}

const domicilio = [llamada("a", "buscar_sucursal_cercana", { colonia: "Vista Alegre" }), texto("Perfecto, ¿me da su dirección completa?")];

describe("pedir_ubicacion: boton nativo de WhatsApp para compartir el pin", () => {
  it("domicilio sin pin: se encola 1 solicitud interactiva con el texto fijo, ademas de la respuesta de texto", async () => {
    const { f, entrar, solicitudes, preparar } = armar();
    await preparar();
    const r = await entrar("quiero a domicilio, vivo en Vista Alegre", domicilio);
    expect(r.ok).toBe(true);
    const sol = solicitudes();
    expect(sol).toHaveLength(1);
    expect(sol[0]!.payload).toMatchObject({ to: PHONE, phone_number_id: "pn-t7", body: PM_COPY.pedirUbicacion, solicitar_ubicacion: true, transaccional: true });
    expect(sol[0]!.dedupeKey).toBe("inbound-ubicacion:wamid.U1");
    // la respuesta de texto sigue encolada aparte
    expect(f.repo.getOutbox().filter((o) => !(o.payload as { solicitar_ubicacion?: boolean }).solicitar_ubicacion)).toHaveLength(1);
  });

  it("segundo turno de domicilio: NO se repite (una sola vez por pedido)", async () => {
    const { entrar, solicitudes, preparar } = armar();
    await preparar();
    await entrar("a domicilio, Vista Alegre", domicilio);
    await entrar("sigo en la misma colonia", domicilio);
    expect(solicitudes()).toHaveLength(1);
  });

  it("con el pin ya compartido: no se encola nada", async () => {
    const { entrar, solicitudes, preparar } = armar();
    await preparar();
    await entrar(formatLocationMessage({ latitude: 21.0152, longitude: -89.5995 }), domicilio);
    expect(solicitudes()).toHaveLength(0);
  });

  it("para recoger (el modelo nunca busca sucursal por zona ni cotiza a domicilio): no se pide ubicacion", async () => {
    const { entrar, solicitudes, preparar } = armar();
    await preparar();
    await entrar("quiero recoger dos tacos", [llamada("a", "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: [{ product_name: "Coca-Cola", requested_quantity: 1 }] }), texto("Listo, ¿es correcto?")]);
    expect(solicitudes()).toHaveLength(0);
  });

  it("el perfil generico (sin PM) no manda el boton", async () => {
    const { entrar, solicitudes } = armar();
    await entrar("a domicilio, Vista Alegre", domicilio);
    expect(solicitudes()).toHaveLength(0);
  });

  it("si el turno termina en una escalacion no se manda el boton", async () => {
    const { entrar, solicitudes, preparar } = armar();
    await preparar();
    await entrar("quiero hablar con una persona", domicilio);
    expect(solicitudes()).toHaveLength(0);
  });

  it("al CREAR el pedido el contador se reinicia: el siguiente pedido a domicilio vuelve a pedir el pin una vez", async () => {
    const { f, entrar, solicitudes, preparar } = armar();
    await preparar();
    await entrar("a domicilio, Vista Alegre", domicilio);
    expect(solicitudes()).toHaveLength(1);
    // el cliente confirma y el modelo crea el pedido (recoger, para no depender de la zona en este turno)
    await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "fco-montejo", canal: "recoger", items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }] });
    const creado = await entrar("si, confirmo", [
      llamada("c1", "crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Luis Canul", payment_method: "efectivo", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] }),
      texto("Su pedido ya quedó registrado."),
    ]);
    expect(creado.ok).toBe(true);
    expect(f.repo.getOutbox().some((o) => (o.payload as { body?: string }).body === "Su pedido ya quedó registrado.")).toBe(true);
    await entrar("ahora otro a domicilio, Vista Alegre", domicilio);
    expect(solicitudes()).toHaveLength(2);
  });

  it("el despachador real la envia como mensaje interactivo de ubicacion con el cliente de Graph falso", async () => {
    const { f, entrar, preparar } = armar();
    await preparar();
    await entrar("a domicilio, Vista Alegre", domicilio);
    const graph = new FakeWhatsAppGraphClient();
    const resumen = await new WhatsAppOutboundDispatcher({ graphClient: graph }).dispatchPending(createRestaurantesMessagingOutboxPort(f.repo));
    expect(resumen.sent).toBe(2);
    expect(graph.sent.filter((m) => m.solicitarUbicacion === true)).toEqual([expect.objectContaining({ to: PHONE, phoneNumberId: "pn-t7", body: PM_COPY.pedirUbicacion, solicitarUbicacion: true })]);
  });

  it("el reintento del mismo mensaje de Meta no duplica la solicitud (misma llave de idempotencia)", async () => {
    const { f, preparar } = armar();
    await preparar();
    await f.repo.enqueueMessagingOutbox(f.organizationId, "whatsapp", "whatsapp.inbound_reply", "inbound-ubicacion:wamid.U1", { to: PHONE, phone_number_id: "pn-t7", body: PM_COPY.pedirUbicacion, solicitar_ubicacion: true });
    await f.repo.enqueueMessagingOutbox(f.organizationId, "whatsapp", "whatsapp.inbound_reply", "inbound-ubicacion:wamid.U1", { to: PHONE, phone_number_id: "pn-t7", body: PM_COPY.pedirUbicacion, solicitar_ubicacion: true });
    expect(f.repo.getOutbox()).toHaveLength(1);
  });
});
