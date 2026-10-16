// Corpus de la guardia de honestidad del cierre (QA-PM-R3 T7-040): 22 + 18 frases del revisor independiente de #508 (incluidas) y frases propias en espanol de Mexico.
// `afirmaPedidoRegistrado` debe detectar TODA afirmacion de que el pedido ya existe (sujeto pedido/orden/comanda) y no tocar lo que es verdad de otra cosa
// (direccion, nombre, cambio, pago, sucursal...), preguntas, condicionales ni negaciones.
import { describe, expect, it } from "vitest";
import { afirmaPedidoRegistrado, quitarAfirmacionDePedidoRegistrado } from "../src/whatsapp/guards.ts";

const AFIRMAN: string[] = ["Listo, su pedido va en camino.","Ya lo mandé a cocina.","Le confirmo que su pedido quedó registrado.","Su pedido ya está en preparación.","¡Listo! Su orden quedó lista y en cocina.","Ya quedó su pedido.","Su pedido ya fue enviado a la sucursal.","Pedido confirmado ✅","Ya tomé su pedido.","Su pedido quedó registrado con el folio 1234.","Ya está su pedido, lo esperamos en 20 minutos.","Ya pasé su pedido a cocina.","Perfecto, ya registré su orden.","Su pedido está confirmado.","Listo, ya quedó confirmado su pedido.","Ya se generó su pedido.","Su orden ya está en camino.","Le aviso que su pedido ya se está preparando.","Ya quedó apartado su pedido.","Su pedido ya quedó levantado.","Con gusto, ya lo dejé registrado.","Ya mandé su comanda.","El pedido ya quedó confirmado.","Su pedido quedó registrado","Ya registré su pedido.","Ya lo confirmamos.","Su pedido ya está en cocina.","Listo, su pedido fue registrado.","Sí, su pedido ya quedó registrado.","Su orden de tacos ya está en cocina.","Quedó confirmado su pedido, Nora.","Ya recibimos y registramos su pedido.","Su comanda ya está en preparación.","Pedido registrado.","Gracias, su pedido quedó anotado y va a cocina.","Ya lo tenemos registrado y en preparación."];
const NO_AFIRMAN: string[] = ["¿Me confirma para registrar su pedido?","En cuanto me diga que sí, lo registro.","Su pedido todavía no está registrado.","Para que quede registrado, necesito su nombre.","El total es de $254.00.","¿Es correcto o desea agregar algo más?","Si confirma, lo mando a cocina.","Una vez confirmado, el tiempo es de 20 minutos.","Le confirmo el total: $254.","No he registrado su pedido todavía.","Aún falta su nombre para registrar el pedido.","La cocina abre a las 12.","Antes de registrarlo, ¿me confirma la dirección?","La sucursal está confirmada: Francisco de Montejo.","Su dirección quedó registrada.","Su nombre quedó anotado.","El cambio quedó anotado.","Su pago con tarjeta quedó anotado.","Para su pedido, su dirección quedó registrada.","Su teléfono quedó anotado, Nora.","Los datos de su pedido: 3 tacos y 1 coca.","Su pedido incluye 2 órdenes de tacos.","El pedido mínimo a domicilio es de $150.","Tenemos orden de nachos individual.","La sucursal Montejo ya está abierta.","Anoté su nombre, Luis.","Su pedido saldría en 20 minutos.","Cuando quede registrado le aviso.","El pedido queda confirmado cuando me diga que sí.","Todavía no tomo su pedido; ¿qué desea?","Voy a registrar su pedido ahora.","Le paso el resumen de su pedido: 3 tacos, $120.","¿Su pedido es para recoger?","Su orden de bistec cuesta $90.","Quedó anotada su referencia: portón negro.","Su factura quedó solicitada, la recibirá por correo."];

describe("afirmaPedidoRegistrado: corpus", () => {
  it.each(AFIRMAN)("afirma: %s", (t) => {
    expect(afirmaPedidoRegistrado(t)).toBe(true);
  });
  it.each(NO_AFIRMAN)("no afirma: %s", (t) => {
    expect(afirmaPedidoRegistrado(t)).toBe(false);
  });
  it("una frase verdadera de otra cosa sobrevive a quitarAfirmacionDePedidoRegistrado junto a la mentira", () => {
    expect(quitarAfirmacionDePedidoRegistrado("Su dirección quedó registrada. Su pedido ya quedó confirmado. ¿Algo más?")).toBe("Su dirección quedó registrada. ¿Algo más?");
    expect(quitarAfirmacionDePedidoRegistrado("Ya mandé su comanda.", "TEXTO")).toBe("TEXTO");
  });
});
