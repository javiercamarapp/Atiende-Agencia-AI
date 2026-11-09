// Cerebro v2, plan de conexión paso 6 (SUELTO-VS-718-V2.md «B3 texto veraz tras rechazo», suelto whatsapp-agent-core.ts ~8320-8360 y ~7736-7752):
// el texto final se decide por la CLASE del ÚLTIMO rechazo de crear_pedido del turno (interno, nada, alergia, cotizar, aparte, existente, otro), no solo
// «interno». La clase sale igual que en el suelto:
//   clase = interno ? "interno" : claseRechazo (alergia / guarda del pedido en la sesión) ?? (razonDelRechazo(error) ? "nada" : "otro"),
// con `interno` pegajoso en el turno, lo que pedía la llamada (`pide`), la pregunta del pedido aparte, la sucursal de la alergia y, tras el rechazo, la
// cotización o la zona que lo resuelven (R85-1). Paridad: el texto es el de `guardiaTextoFinal` con ese CrearPedidoFallido.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nuevoViaje, pedidosDe, TEL_CLIENTE, type Viaje } from "./qa-viaje/arnes-viaje.ts";
import { executeAgentToolSafely } from "../src/agent-tools/registry.ts";
import { hiloDelSuelto } from "../src/whatsapp/cerebro-v2/hilo-herramientas.ts";
import {
  crearFallidoTrasHerramienta,
  guardiaTextoFinal,
  pideDelCrear,
  razonDelRechazo,
  siguienteCrearFallido,
  textoDelServidorTrasRechazo,
} from "../src/whatsapp/cerebro-v2/texto-final.ts";
import { claseDelRechazoOtroPedido, RECHAZO_COTIZA_OTRO_PEDIDO } from "../src/whatsapp/cerebro-v2/pedido-aparte.ts";

const T0 = new Date("2026-10-13T19:00:00-06:00");
const INPUT = { branch_slug: "garcia-lavin", items: [{ product_name: "Coca-Cola", requested_quantity: 4 }, { product_name: "Taco de pastor", requested_quantity: 2 }] };

describe("cerebro v2: clase del último rechazo de crear_pedido (puro, paridad con el suelto)", () => {
  it("error del sistema -> interno; y el interno se queda en el turno aunque el último rechazo sea otro", () => {
    const a = siguienteCrearFallido(null, { error: "Error interno al ejecutar la herramienta", interno: true, input: INPUT });
    expect(a).toMatchObject({ interno: true, clase: "interno", pide: "4 × Coca-Cola, 2 × Taco de pastor" });
    const b = siguienteCrearFallido(a, { error: "Algo que no se reconoce", interno: false, input: INPUT });
    expect(b).toMatchObject({ interno: true, clase: "otro" });
    // Monorrepo: el reintento tras el error del sistema choca con el reclamo de esa misma llamada (pedido_en_proceso): sigue siendo «interno».
    expect(siguienteCrearFallido(a, { error: "El pedido se está registrando en este momento; espera un momento antes de reintentar.", codigo: "pedido_en_proceso", interno: false, input: INPUT })).toBe(a);
  });

  it("la clase que trae el rechazo (alergia, guarda del pedido en la sesión) manda; sin ella, razonDelRechazo decide nada/otro", () => {
    const sucursal = { name: "García Lavín", phone: "9991234567" };
    expect(siguienteCrearFallido(null, { error: "x", interno: false, clase: "alergia", sucursal, input: INPUT })).toMatchObject({ clase: "alergia", sucursal });
    const c = claseDelRechazoOtroPedido(RECHAZO_COTIZA_OTRO_PEDIDO);
    expect(siguienteCrearFallido(null, { error: RECHAZO_COTIZA_OTRO_PEDIDO, interno: false, clase: c.clase, input: INPUT })).toMatchObject({ clase: "cotizar", resuelveCon: "cotizar_pedido" });
    expect(siguienteCrearFallido(null, { error: "Aún no se ha ubicado la zona de entrega", interno: false, input: INPUT })).toMatchObject({ clase: "nada", resuelveCon: "buscar_sucursal_cercana" });
    expect(siguienteCrearFallido(null, { error: "Producto inexistente", interno: false, input: INPUT })).toMatchObject({ clase: "otro", resuelveCon: null });
  });

  it("los rechazos del monorrepo que el suelto reconoce como «no se creó nada»: sucursal cerrada (abre hoy más tarde) y pedido mínimo", () => {
    const cerrada = "La sucursal García Lavín está cerrada en este momento; abre hoy a las 1:00 pm.";
    const f = siguienteCrearFallido(null, { error: cerrada, interno: false, input: INPUT });
    expect(f).toMatchObject({ clase: "nada", abreMasTardeHoy: true });
    expect(textoDelServidorTrasRechazo(f)).toMatch(/cerrada en este momento.*¿Desea dejarlo programado para más tarde\?/);
    const manana = siguienteCrearFallido(null, { error: "La sucursal García Lavín está cerrada en este momento; abre el sábado a las 1:00 pm.", interno: false, input: INPUT });
    expect(manana.abreMasTardeHoy).toBe(false);
    expect(textoDelServidorTrasRechazo(manana)).toMatch(/hoy ya no abre/);
    const minimo = "El pedido mínimo a domicilio en García Lavín es de $200. El pedido suma $120; faltan $80 para alcanzarlo. No se puede registrar por debajo del mínimo: ofrezca agregar productos o pasar a recoger.";
    expect(razonDelRechazo(minimo, undefined, false)?.motivo).toBe("el pedido mínimo a domicilio es de $200 y el suyo suma $120");
    expect(siguienteCrearFallido(null, { error: minimo, interno: false, input: INPUT }).clase).toBe("nada");
  });

  it("tras el rechazo, la cotización (o la zona) que lo resuelve deja el texto del modelo con el total (R85-1)", () => {
    const f = siguienteCrearFallido(null, { error: RECHAZO_COTIZA_OTRO_PEDIDO, interno: false, clase: "cotizar", input: INPUT });
    const g = crearFallidoTrasHerramienta(f, "cotizar_pedido", { quote: { total: 212 } });
    expect(g).toMatchObject({ resuelto: true, totalCotizado: 212 });
    expect(crearFallidoTrasHerramienta(f, "cotizar_pedido", { error: "x" })).toBe(f);
    expect(crearFallidoTrasHerramienta(null, "cotizar_pedido", { quote: { total: 212 } })).toBeNull();
    const z = siguienteCrearFallido(null, { error: "Aún no se ha ubicado la zona de entrega", interno: false, input: INPUT });
    expect(crearFallidoTrasHerramienta(z, "buscar_sucursal_cercana", { encontrada: true })).toMatchObject({ resuelto: true });
    expect(crearFallidoTrasHerramienta(z, "buscar_sucursal_cercana", { fuera_de_zona: true })).toMatchObject({ resuelto: false });
    // Con el total dicho, el texto del modelo se queda; sin él, lo arma el servidor con el total.
    expect(guardiaTextoFinal("Son $212.00, ¿se lo registro?", { pedidoCreadoEnTurno: false, pedidoPorAprobar: false, productosDevueltosPorHerramientas: [], crearFallido: g }).reemplazado).toBe(false);
    expect(guardiaTextoFinal("Con gusto, ¿se lo registro?", { pedidoCreadoEnTurno: false, pedidoPorAprobar: false, productosDevueltosPorHerramientas: [], crearFallido: g }).texto).toContain("212");
  });

  it("pideDelCrear: los renglones legibles de la llamada (renglonesLegibles del suelto sin pedido)", () => {
    expect(pideDelCrear(INPUT)).toBe("4 × Coca-Cola, 2 × Taco de pastor");
    expect(pideDelCrear({ items: [{ product_name: "  " }, { product_name: "Agua" }] })).toBe("1 × Agua");
    expect(pideDelCrear({})).toBe("");
  });
});

describe("cerebro v2: la clase del rechazo llega al turno", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  async function conAlergiaYResumen(v: Viaje) {
    await v.escribe("Hola, soy alérgica al cacahuate");
    const items = [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 4 }];
    v.guion([
      { tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "domicilio", colonia_entrega: "Temozón Norte", customer_address: "Calle 60 #123 entre 21 y 23", customer_name: "Gabriela Poot", payment_method: "tarjeta", items } }] },
      { texto: "Permítame repetirle su pedido: 4 Coca-Cola a domicilio, pago con tarjeta. Total $212.00. ¿Es correcto?" },
    ]);
    await v.escribe("cuatro cocas a domicilio, Calle 60 #123 entre 21 y 23, Temozón Norte, Gabriela Poot, pago con tarjeta");
  }

  it("alergia sin confirmar: el texto lo arma el servidor con la clase «alergia» (no el «quedó registrado» del modelo)", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    await conAlergiaYResumen(v);
    v.guion([{ texto: "¡Listo! Su pedido quedó registrado." }]);
    const r = await v.escribe("Sí, así está bien");
    expect(await pedidosDe(v)).toHaveLength(0);
    // El texto del suelto dice «Perdón, su pedido todavía no quedó registrado: …»; nunca el «¡Listo! …» del modelo.
    expect(r.reply).not.toMatch(/¡Listo!|^Su pedido qued[oó] registrado/i);
    expect(r.reply).toMatch(/^Perdón, su pedido todavía no quedó registrado: por su seguridad, el pedido espera a que una persona de la sucursal le confirme lo de la alergia/i);
    expect(r.reply).toMatch(/Por su seguridad, el pedido espera a que una persona de la sucursal le confirme lo de la alergia/i);
    expect(r.reply).toContain("La sucursal ya tiene su aviso; en cuanto le confirme, tomamos su pedido.");
  });

  it("la guarda del pedido en la sesión devuelve su clase en el resultado de la herramienta (existente/cotizar/aparte)", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    const items = [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 4 }];
    v.guion([
      { tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "domicilio", colonia_entrega: "Temozón Norte", customer_address: "Calle 60 #123 entre 21 y 23", customer_name: "Gabriela Poot", payment_method: "tarjeta", items } }] },
      { texto: "Permítame repetirle su pedido: 4 Coca-Cola a domicilio, pago con tarjeta. Total $212.00. ¿Es correcto?" },
    ]);
    await v.escribe("cuatro cocas a domicilio, Calle 60 #123 entre 21 y 23, Temozón Norte, Gabriela Poot, pago con tarjeta");
    v.guion([{ texto: "¡Listo! Su pedido quedó registrado." }]);
    await v.escribe("Sí, así está bien");
    vi.setSystemTime(new Date(T0.getTime() + 10 * 60_000));
    const guardado = await v.world.repo.whatsappAppendTurn(v.world.organizationId, TEL_CLIENTE, [], null, null, null);
    const hilo = hiloDelSuelto(guardado);
    const conversacionReciente = guardado.map((m) => ({ role: m.role, content: m.content }));
    const input = { branch_slug: "garcia-lavin", canal: "domicilio", colonia_entrega: "Temozón Norte", customer_address: "Calle 60 #123 entre 21 y 23", customer_name: "Gabriela Poot", payment_method: "tarjeta", items: [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 6 }] };
    const r = await executeAgentToolSafely(v.world.repo, { organizationId: v.world.organizationId, channel: "whatsapp", phone: TEL_CLIENTE, entryPropertyId: v.t7, cerebroV2: true, hiloV2: hilo, conversacionReciente }, "crear_pedido", input);
    const error = (r.result as { error?: string }).error ?? "";
    expect(r.rechazoClase?.clase).toBe(claseDelRechazoOtroPedido(error).clase);
  });
});
