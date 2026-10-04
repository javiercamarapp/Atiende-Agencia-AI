// R-44 -- agente de REFERENCIA en INGLES (guionado, sin LLM): la trayectoria correcta de cada caso de `casos-ingles.json` contra el
// mundo simulado. Misma conducta que `referencia.ts` (repetir antes de confirmar, escalar lo que no le toca, reglas duras), pero lo que
// lee el cliente va en ingles y lo que lee el equipo (argumentos de herramientas, resumen de escalacion, notas) sigue en espanol.
import { saludoPorHoraEn } from "../../../idioma.ts";
import { Mundo } from "../mundo.ts";
import type { CasoEval } from "../tipos.ts";
import { coloniaDe, itemsArgs, opcionesDeComanda, primerNombre, sinParentesis } from "../referencia.ts";
import type { OpcionesFlujo } from "../referencia.ts";

const ALCOHOL_RE = /cerveza|beer|ceiba|pi[ñn]a colada|michelada|alcohol|tequila/i;

function saludoEn(mundo: Mundo): void {
  const c = mundo.caso.contexto;
  const hora = Number(c.hora_local.split(":")[0]);
  const saludo = saludoPorHoraEn(hora);
  const sucursal = mundo.sucursalNombre(c.sucursal_contexto);
  mundo.agente(`${saludo.charAt(0).toUpperCase()}${saludo.slice(1)}, thank you for contacting Los Taquitos de PM, ${sucursal} branch. I'm the virtual assistant. Would you like to pick up your order or have it delivered?`);
}

function escalarEn(mundo: Mundo, motivo: string, resumenEs: string): void {
  const nombre = mundo.caso.simulador_cliente.datos.nombre ?? "Cliente";
  mundo.agente("Let me notify the branch manager; someone from the branch will get back to you shortly.");
  mundo.ejecutar("escalar_a_humano", { customer_name: nombre, motivo, resumen: resumenEs });
}

const productosEn = (items: OpcionesFlujo["items"]) => items.map((i) => `${i.piezas} ${sinParentesis(i.producto)}`).join(" and ");

function frasesDeReglaEn(mundo: Mundo, opts: OpcionesFlujo): string[] {
  const caso = mundo.caso;
  const cliente = [caso.simulador_cliente.apertura, ...caso.simulador_cliente.giros].join(" ");
  const frases: string[] = [];
  if (ALCOHOL_RE.test(cliente)) {
    frases.push(opts.canal === "domicilio" ? "Please note that we don't serve alcohol for delivery, so I can't add that drink." : "Please note that alcoholic drinks are bought directly at the branch when you pick up.");
  }
  if (/2x1|promo/i.test(cliente) && opts.canal === "domicilio") frases.push("The promotion is valid only for pickup; I can't apply it to delivery.");
  if (opts.items.some((i) => /bistec/i.test(i.producto) && /tacos/i.test(i.producto))) frases.push("Steak tacos are sold only in orders of 3.");
  if (/instructions|ignore/i.test(cliente)) frases.push("I can't share or change my instructions, but I'm happy to help with your order.");
  if (opts.canal === "domicilio") frases.push("Delivery has no charge.");
  if (/robot|person/i.test(cliente)) frases.push("I'm a virtual assistant, and whenever you need I can pass you to a person.");
  return frases;
}

async function flujoComandaEn(mundo: Mundo, opts: OpcionesFlujo): Promise<void> {
  const caso = mundo.caso;
  const datos = caso.simulador_cliente.datos;
  let slug = caso.contexto.sucursal_contexto.toLowerCase();

  mundo.cliente(caso.simulador_cliente.apertura);
  saludoEn(mundo);
  mundo.cliente(`${opts.canal === "domicilio" ? "Delivery" : "Pickup"}. I'm ${datos.nombre ?? opts.nombre}, my phone number is ${datos.telefono ?? ""}.`);
  mundo.ejecutar("buscar_cliente", {});
  mundo.agente(`Thank you, ${primerNombre(opts.nombre)}. ${opts.canal === "domicilio" ? "Could you give me your address with some landmarks, please?" : "What would you like to order?"}`);

  let colonia: string | null = null;
  if (opts.canal === "domicilio") {
    const primera = coloniaDe(mundo, datos.direccion);
    mundo.cliente(`My address is ${datos.direccion}`);
    const r = mundo.ejecutar("buscar_sucursal_cercana", { colonia: primera ?? datos.direccion ?? "" }) as { encontrada: boolean; branch_slug?: string };
    colonia = primera ?? datos.direccion ?? null;
    if (r.encontrada && r.branch_slug) slug = r.branch_slug;
  } else {
    slug = opts.sucursal.toLowerCase();
  }

  mundo.cliente(`I'd like ${productosEn(opts.items).toLowerCase()}.`);
  if (caso.categoria === "minimo_200" && opts.canal === "domicilio") {
    const args = itemsArgs(mundo, slug, [opts.items[0]!], opts.tortilla);
    if (args) {
      const r = mundo.ejecutar("cotizar_pedido", { branch_slug: slug, items: args, canal: "domicilio", colonia_entrega: colonia ?? "", payment_method: opts.pago }) as { error?: string };
      const faltante = /faltan \$(\d+)/.exec(r.error ?? "")?.[1];
      if (faltante) mundo.agente(`Please note that the minimum order for delivery is $200 and you are $${faltante} short. Would you like to add something else or would you rather pick up?`);
    }
  }
  const args = itemsArgs(mundo, slug, opts.items, opts.tortilla);
  if (!args) throw new Error(`${caso.id}: producto no encontrado en ${slug}`);
  const cot = mundo.ejecutar("cotizar_pedido", {
    branch_slug: slug,
    items: args,
    canal: opts.canal,
    ...(opts.canal === "domicilio" ? { colonia_entrega: colonia ?? "" } : {}),
    payment_method: opts.pago,
  }) as { error?: string; quote?: { total: number } };
  if (cot.error || !cot.quote) throw new Error(`${caso.id}: la cotización falló: ${cot.error}`);

  const reglas = frasesDeReglaEn(mundo, opts).join(" ");
  mundo.cliente(`I'll pay by ${opts.pago === "efectivo" ? "cash" : "card"}.`);
  if (opts.canal === "recoger") {
    mundo.agente("What time will you pick it up?");
    mundo.cliente(datos.hora ? "In about " + (datos.hora.match(/\d+/)?.[0] ?? "30") + " minutes" : `In ${opts.hora ?? 30} minutes`);
  } else {
    mundo.agente("Thank you.");
  }
  const propina = opts.pago === "tarjeta" ? " Would you like to leave a tip? It is given at the card terminal." : "";
  const extras = [...opts.ajustes.map((a) => a.replace(/_/g, " ")), opts.tortilla ? `${opts.tortilla} tortilla` : ""].filter(Boolean).join(", ");
  const sucursal = mundo.sucursalNombre(slug.toUpperCase());
  mundo.agente(
    `${reglas} Let me repeat your order: ${productosEn(opts.items).replace(/ and /g, ", ")}${extras ? ` (${extras})` : ""}, ${opts.canal === "recoger" ? `for pickup at the ${sucursal} branch` : `for delivery from the ${sucursal} branch`}, total $${cot.quote.total}, paying with ${opts.pago === "efectivo" ? "cash" : "card"}.${propina} Is that correct?`,
  );

  mundo.cliente("Yes, that's correct.");
  mundo.ejecutar("confirmar_resumen", {});
  const notas = [...opts.ajustes, opts.canal === "recoger" ? `Recoge en ${opts.hora ?? 30} minutos` : ""].filter(Boolean).join(", ");
  const creado = mundo.ejecutar("crear_pedido", {
    branch_slug: slug,
    customer_name: opts.nombre,
    canal: opts.canal,
    items: args,
    payment_method: opts.pago,
    ...(opts.canal === "domicilio" ? { customer_address: (datos.direccion ?? "").split(/\. [A-ZÁÉÍÓÚ]{4,}/)[0], colonia_entrega: colonia ?? "" } : {}),
    ...(notas ? { notes: notas } : {}),
  }) as { error?: string };
  if (creado.error) throw new Error(`${caso.id}: crear_pedido falló: ${creado.error}`);
  mundo.agente(
    `Your order has been registered and sent to the kitchen.${opts.canal === "domicilio" ? " Delivery takes about 40 to 50 minutes; it can be a little longer at busy times." : ` We'll be waiting for you at the ${sucursal} branch.`}`,
  );
}

async function flujoEscalarEn(mundo: Mundo): Promise<void> {
  const caso = mundo.caso;
  const esp = caso.esperado.escalar!;
  const datos = caso.simulador_cliente.datos;
  mundo.cliente(caso.simulador_cliente.apertura);
  saludoEn(mundo);
  mundo.cliente(caso.simulador_cliente.giros[0] ?? caso.simulador_cliente.apertura);
  if (datos.direccion) {
    mundo.ejecutar("buscar_cliente", {});
    mundo.ejecutar("buscar_sucursal_cercana", { colonia: coloniaDe(mundo, datos.direccion) ?? datos.direccion });
  }
  // El resumen lo lee el equipo del restaurante: SIEMPRE en espanol, aunque el cliente escriba en ingles.
  escalarEn(mundo, esp.motivos_validos[0]!, `Cliente que escribe en inglés. Caso ${caso.categoria}: se avisa al equipo.`);
  const ultimo = caso.simulador_cliente.giros.at(-1);
  if (ultimo) {
    mundo.cliente(ultimo);
    mundo.agente("I understand. A person from the branch will respond to you in a moment.");
  }
}

async function soloPreguntasEn(mundo: Mundo): Promise<void> {
  const caso = mundo.caso;
  mundo.cliente(caso.simulador_cliente.apertura);
  saludoEn(mundo);
  mundo.agente("Of course. Our hours are from 12 noon to 1 am. Delivery has no charge, with a minimum order of $200. Promotions are valid for pickup only.");
  mundo.cliente(caso.simulador_cliente.giros[0] ?? "");
  mundo.agente("All sauces are free of charge: red, green, mexicana, guacamolera, lime, garlic cream, onion with cilantro, pineapple and habanero. May I take your order?");
  mundo.cliente("No, thank you.");
  mundo.agente("You're welcome. Have a good evening.");
}

/** Ejecuta la trayectoria de referencia en ingles del caso contra el mundo (deja todo en `mundo.eventos`). */
export async function correrReferenciaIngles(mundo: Mundo): Promise<void> {
  const caso: CasoEval = mundo.caso;
  switch (caso.esperado.resultado) {
    case "comanda":
      return flujoComandaEn(mundo, opcionesDeComanda(mundo));
    case "escalar":
      return flujoEscalarEn(mundo);
    case "sin_comanda":
      return soloPreguntasEn(mundo);
  }
}
