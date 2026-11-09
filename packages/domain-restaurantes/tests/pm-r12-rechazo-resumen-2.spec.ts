// QA-PM R12 (revision independiente de #588): con la maquina de cierre APAGADA (RESTAURANTES_CIERRE_MAQUINA_ESTADOS, apagada por omision) `crear_pedido` seguia creando el pedido tras
// rechazos que `rechazaElResumen` no cubria (hueco de DINERO), y retrasaba un turno a clientes legitimos que aceptan a regañadientes, dan un dato o hacen una pregunta (retraso, no dinero).
// Familias, no frases sueltas: cada lista agrupa variantes de una misma familia.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAgentToolSafely, invokeAgentTool } from "../src/agent-tools/registry.ts";
import { asistentePidioDatoPendiente, rechazaElResumen, resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

type Msg = { role: "user" | "assistant"; content: string };
beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T13:00:00-06:00"));
});
afterEach(() => vi.useRealTimers());

function setup() {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  let turn = 0;
  const hist: Msg[] = [];
  const ctx = () => ({ organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567", flow: { key: "k:wa", turn: String(turn), now: () => Date.now() }, conversacionReciente: hist.slice(-30) });
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 3 }];
  const base = { branch_slug: "fco-montejo", items, canal: "recoger" };
  const call = (tool: string, extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), tool, { ...base, ...extra });
  return {
    quote: () => call("cotizar_pedido", { payment_method: "efectivo", efectivo_con: 500 }),
    confirm: () => call("confirmar_resumen"),
    createSafe: () => executeAgentToolSafely(f.repo, ctx(), "crear_pedido", { ...base, customer_name: "Carlos", payment_method: "efectivo", efectivo_con: 500 }),
    total: async () => (await f.repo.readOrderFlow(f.organizationId, "k:wa"))?.context?.quotedTotal as number,
    cliente: (t: string) => {
      turn += 1;
      hist.push({ role: "user", content: t });
    },
    asistente: (t: string) => void hist.push({ role: "assistant", content: t }),
  };
}

// --- Rechazos que antes dejaban crear el pedido (cada bloque es una familia) ---------------------------------------------------------------------------------------------------------------
const RECHAZOS_2: Record<string, string[]> = {
  "precio con vocativo": ["no wey, a $100", "no wey a 100 pesos", "no guey, a $50", "no bro, por $80", "no, wey, en $100", "no we a $20", "no amigo, a 100 pesos", "no joven, a $90", "no oiga, a $10", "no jefe, por 90 pesos"],
  "la promo/anuncio dice": [
    "la promo dice $10",
    "en el anuncio dice $10",
    "ahí dice 3x$100, cóbrame así",
    "la promoción es a $10",
    "en la publicación dice 3 por $100",
    "el menú dice $40 el taco",
    "en facebook decía $10",
    "la oferta es a $90",
    "en la página dice 10 pesos",
    "el flyer dice $10 cada uno",
    "en el cartel dice 3x100",
    "no, la promo dice $10, cóbrame eso",
  ],
  "cobrar eso/así/de más": [
    "cóbrame eso",
    "cobrame asi",
    "cóbramelo así",
    "cobrame lo que dice la promo",
    "me estás cobrando de más",
    "me cobraste de más",
    "no, estás cobrando de más",
    "no, cobras de más",
    "me cobran de más",
    "me cobraron de mas",
    "me estas cobrando mal",
    "cobraste mal",
  ],
  "el total/pedido no es": ["el total no es ese", "el total no es", "no, el total es otro", "no, mi pedido era otro", "el precio no es ese", "el monto no es ese", "ese no es el total", "la cuenta no es esa", "mi pedido era otro", "el precio es otro", "el total era diferente"],
  "tu cuenta esta mal": ["no, estas mal", "no, estás mal", "te equivocas", "te equivocaste con el total", "estás equivocado", "hay un error en el total"],
  "muy caro": ["no, muy caro", "muy caro", "demasiado caro", "está carísimo", "me parece caro", "me parece mucho", "qué caro", "es un robo", "me estás robando", "no, es carísimo"],
  cancelar: [
    "cancela",
    "cancelalo",
    "cancélalo",
    "cancela el pedido",
    "mejor cancela",
    "mejor cancélalo",
    "cancela todo",
    "cancela mi pedido porfa",
    "mejor ya cancela",
    "cancelen el pedido",
    "quiero cancelar",
    "quiero cancelar el pedido",
    "ya no lo quiero",
    "ya no quiero el pedido",
    "olvídalo",
    "no, cancela",
  ],
  "no lo acepto / confirmo": ["no lo acepto", "no lo quiero", "no lo confirmo", "no, no lo confirmo", "no confirmo", "no acepto", "no confirmes", "no lo confirmes", "no lo mandes", "no lo registres", "no lo hagas", "no me lo cobres así"],
  "espera/mejor no (rechazo)": ["espera, no es correcto", "espera, no me cuadra", "alto, no lo confirmes", "un momento, no es ese el total", "espera, no quiero así", "momento, no", "mejor no lo hagas", "mejor no lo confirmes", "mejor no pido nada", "pues mejor no", "ya mejor no", "mejor no, déjalo"],
  "no, son N (cantidad/dinero del pedido)": ["no, son 4", "no, son 2 ordenes", "no, es 1 taco", "no, son $100", "no, son 100 pesos", "no, son 5 refrescos", "no, es $10"],
  "no, quiero (monto/pedido)": ["no, quiero que cobres $10", "no, quiero que sea más barato", "no, quiero que me lo dejes a $10", "no, quiero que sean 4", "no, quiero otro", "no, quiero cambiar el pedido"],
};

// --- Legitimos que NO deben retrasar el cierre ------------------------------------------------------------------------------------------------------------------------------------------------
const LEGITIMOS_2: Record<string, string[]> = {
  "aceptacion a regañadientes": [
    "está caro pero va",
    "es mucho pero va",
    "es mucho pero ya qué",
    "sale caro pero va",
    "está caro pero lo quiero",
    "está caro pero está bien",
    "queda caro pero órale",
    "está caro pero lo llevo",
    "está caro, pero ni modo, va",
    "está muy caro pero sí",
    "demasiado caro pero dale",
    "sale mucho pero ok",
    "es mucho pero lo quiero",
    "está carísimo pero va",
    "es mucho, pero ya qué",
    "está caro pero pues está bien",
  ],
  "espera + dato propio": [
    "espera, no tengo cambio, pago con 500",
    "espera, no encuentro mi cartera",
    "momento, no tengo billete chico",
    "un momento, no encuentro el efectivo",
    "espera, no me llegó el mensaje",
    "espera, no puedo abrir el link",
    "espera, no sé cuánto tengo",
    "espera, no traigo efectivo, pago con tarjeta",
    "espera no tengo cambio",
    "momento, no me carga la página",
    "espera, no recuerdo la dirección",
    "un momento, no estoy seguro de la hora",
  ],
  "mejor no + instruccion de un ingrediente": [
    "mejor no le pongas picante",
    "mejor no pongas hielo",
    "mejor no le pongas cebolla",
    "con tarjeta, mejor no le pongas picante",
    "tarjeta. mejor no le pongas salsa",
    "efectivo, mejor no agregues nada",
    "mejor no le echen limón",
    "mejor no le pongan queso",
    "mejor no lleve crema",
    "mejor no le agregues aguacate",
  ],
  "no, son N + unidad/billete": [
    "no, son 30 minutos",
    "no, son 500",
    "no, es 1 persona",
    "no, son 10 minutos",
    "no, son 2 personas",
    "no, es 1 solo",
    "no, son 3 para llevar",
    "no, es 500 el billete",
    "no, son 45 minutos",
    "no, son 20 min",
    "no, son 2 horas",
    "no, es 1 hora",
    "no, son 1000",
  ],
  "no, quiero + dato/instruccion de ingrediente": [
    "no quiero que le pongas cebolla",
    "no, quiero mi cambio de 500",
    "no, quiero mi cambio en billetes chicos",
    "no quiero que lleve picante",
    "no, quiero que sea para llevar",
    "no, quiero mi pedido para las 3",
    "no, quiero que me llamen al llegar",
    "no, quiero que me avisen cuando esté listo",
    "no quiero que le pongan salsa",
    "no, quiero mi pedido a las 3",
    "no quiero que traiga hielo",
  ],
  "corregir un dato de la orden (no el monto)": [
    "quiero cambiar mi nombre, es Carlos",
    "cámbiame la hora a las 4",
    "corrige mi nombre, es Carlos",
    "cámbiame la salsa a verde",
    "quiero cambiar mi nombre",
    "cambia mi nombre a Carlos",
    "corrige la hora: a las 4",
    "cámbiame el método de pago a tarjeta",
    "quiero cambiar la forma de pago",
    "corrígeme el nombre, es Carlos",
    "cambia la hora de recogida a las 5",
    "quiero modificar la hora",
    "quiero cambiar a efectivo",
    "cámbiame la tortilla a harina",
  ],
  "pregunta sobre un platillo": ["¿ese no lleva cebolla?", "eso no pica, ¿verdad?", "ese no lleva queso, ¿cierto?", "¿esa no trae picante?", "¿eso no tiene gluten?", "ese no es picante, ¿verdad?", "¿ese no incluye bebida?", "esos no llevan cebolla, ¿cierto?", "¿esa no viene con arroz?"],
  "no pedi + cortesia": ["no pedí cubiertos, gracias, así está", "no pedí servilletas", "no pedí propina, gracias"],
};

const todos = (m: Record<string, string[]>) => Object.entries(m).flatMap(([familia, frases]) => frases.map((t) => [familia, t] as const));

describe("R12 revision #588: rechazaElResumen cubre los rechazos que dejaban crear el pedido", () => {
  it.each(todos(RECHAZOS_2))("[%s] rechaza: %s", (_f, t) => expect(rechazaElResumen(t)).toBe(true));
  it.each(todos(RECHAZOS_2))("[%s] rechaza con cortesia final: %s", (_f, t) => expect(rechazaElResumen(`${t} porfa`)).toBe(true));
  it("hay al menos 60 frases de rechazo y 60 legitimas", () => {
    expect(todos(RECHAZOS_2).length).toBeGreaterThanOrEqual(60);
    expect(todos(LEGITIMOS_2).length).toBeGreaterThanOrEqual(60);
  });
});

describe("R12 revision #588: lo legitimo no se retrasa", () => {
  it.each(todos(LEGITIMOS_2))("[%s] NO rechaza: %s", (_f, t) => expect(rechazaElResumen(t)).toBe(false));
});

describe("R12 revision #588: lo que ya se frenaba se sigue frenando (no se debilita nada)", () => {
  it.each([
    "No, quiero a $10, así dice la promo. Cobrámelos a ese precio porfa.",
    "No, quiero a $10",
    "no, mejor por $100",
    "no ese no",
    "cámbialo",
    "quiero cambiar el total",
    "No gracias, está muy caro",
    "espera, no",
    "Espera, no así",
    "mejor no",
    "no, son 4 tacos",
    "no, a $10",
    "cóbramelos a $10",
    "no me convence el precio",
    "no es lo que pedí",
    "No, corrígelo",
    "no, quiero que sea con tarjeta",
    "eso no, quiero a $10",
    "así no",
    "no, corrige la hora",
    "No lo quiero así",
    "No, mejor sin cebolla",
    "no, quita la coca",
    "no es correcto el nombre, es Ana",
    "me estás cobrando de más, no, cámbialo",
    "cancela, no lo quiero",
    "la promo dice $10 pero cóbrame mi cambio",
    "espera, no, a $10",
    "mejor no, está muy caro",
    "no, son 100 pesos",
  ])("sigue rechazando: %s", (t) => expect(rechazaElResumen(t)).toBe(true));
  it.each([
    "cancela el refresco y confirmo",
    "cancela la coca, ok",
    "sí, está caro pero va",
    "sí, mejor cancélalo todo... no mentira, sí confirmo",
    "ok, dale",
    "No, gracias",
    "no tengo cambio",
    "no quiero propina",
    "No hay problema",
    "perfecto, no cambia nada",
  ])("sigue sin rechazar: %s", (t) => expect(rechazaElResumen(t)).toBe(false));
});

describe("R12 revision #588: asistentePidioDatoPendiente no retrasa una CONFIRMACION que menciona tortilla/propina", () => {
  it.each([
    "¿Le parece bien el total con tortilla de maíz?",
    "¿Quedamos así, a nombre de Carlos?",
    "¿Todo bien con la propina y la tortilla?",
    "¿Lo dejamos así, con tortilla de harina?",
    "¿Le parece bien así, a nombre de Carlos?",
    "¿Todo bien con el total y el pago en efectivo?",
    "¿Está conforme con el total y la propina?",
    "¿Así lo dejamos, a nombre de Carlos?",
    "¿Le late así, con la tortilla de maíz?",
    "¿Todo en orden con la tortilla y la propina?",
  ])("confirmacion %j => NO es dato pendiente", (q) => expect(asistentePidioDatoPendiente(`Tres suman $126. ${q}`)).toBe(false));
  it.each([
    "¿Qué tortilla prefiere?",
    "¿Con cuánto pagará?",
    "¿Desea agregar propina?",
    "¿A nombre de quién registro el pedido?",
    "¿Le parece bien la tortilla de maíz o prefiere harina?",
    "¿Quedamos con tortilla de maíz o de harina?",
    "¿Lo dejamos con tortilla de maíz o de harina?",
    "¿Cuánto tiempo tarda en pasar?",
    "¿Pagará en efectivo o tarjeta?",
  ])("dato pendiente %j => sigue siendo pendiente", (q) => expect(asistentePidioDatoPendiente(`Tres suman $126. ${q}`)).toBe(true));
});

// --- Ruta real (maquina de cierre apagada, como en el arnes): nada se crea tras un rechazo; lo legitimo no se retrasa; el retraso siempre se destraba con un «si» --------------------------------
describe("R12 revision #588: ruta real con la maquina de cierre apagada", () => {
  const frasesRuta = ["cancela el pedido", "no wey, a $100", "la promo dice $10", "me estás cobrando de más", "el total no es ese", "no lo confirmo", "no, muy caro", "mejor cancélalo"];
  it.each(frasesRuta)("tras el resumen, «%s» => crear_pedido NO crea", async (frase) => {
    const s = setup();
    s.cliente("Pásame 3 tacos para recoger, a nombre de Carlos, efectivo");
    await s.quote();
    s.asistente(`Su pedido: 3 Coca-Cola. Total $${await s.total()}. ¿Es correcto?`);
    s.cliente("sí");
    await s.confirm();
    s.asistente("Perfecto, ¿algo más?");
    s.cliente(frase);
    const r = await s.createSafe();
    expect(r.orderId).toBeNull();
    expect(r.rechazoDelFlujo).toBe("cliente_rechazo_resumen");
  });
  it.each(["está caro pero va", "es mucho pero ya qué", "espera, no tengo cambio, pago con 500", "mejor no le pongas picante", "no, son 30 minutos", "cámbiame la hora a las 4"])(
    "tras el resumen, «%s» => crear_pedido SI crea (sin retraso)",
    async (frase) => {
      const s = setup();
      s.cliente("Pásame 3 tacos para recoger, a nombre de Carlos, efectivo");
      await s.quote();
      s.asistente(`Su pedido: 3 Coca-Cola. Total $${await s.total()}. Paga con 500. ¿Es correcto?`);
      s.cliente(frase);
      await s.confirm();
      expect((await s.createSafe()).orderId).not.toBeNull();
    },
  );
  it("sin deadlock: tras 1 a 5 turnos de rechazo, el «sí» siguiente crea el pedido", async () => {
    for (const turnosDeRechazo of [1, 2, 3, 4, 5]) {
      const s = setup();
      s.cliente("Pásame 3 tacos para recoger, a nombre de Carlos, efectivo");
      await s.quote();
      s.asistente(`Su pedido: 3 Coca-Cola. Total $${await s.total()}. ¿Es correcto?`);
      s.cliente("sí");
      await s.confirm();
      for (let i = 0; i < turnosDeRechazo; i++) {
        s.asistente("Entiendo, ¿qué desea cambiar?");
        s.cliente("cancela el pedido");
        expect((await s.createSafe()).orderId).toBeNull();
      }
      s.asistente(`Su pedido: 3 Coca-Cola. Total $${await s.total()}. ¿Lo confirmo?`);
      s.cliente("sí, confírmalo");
      expect((await s.createSafe()).orderId).not.toBeNull();
    }
  });
});
