// PAQUETE A (PM): reglas de prompt de menú, unidades de la orden y variantes. MÓDULO NUEVO: no toca perfil-pm.ts;
// el integrador lo enlaza después (una importación y una concatenación). Texto estático, sin datos personales y SIN precios
// salvo el de la doble porcion de salsa («Extra Salsa»). Cualquier otro precio sale SIEMPRE de buscar_producto o cotizar_pedido.

const SALSAS_POR_OMISION = `SALSAS: van incluidas sin costo la roja, verde, cebolla con cilantro y limones. Habanero, crema de ajo y guacamolera van solo si el cliente las pide; no las mande por defecto ni al decir "todas las salsas" sin preguntar cuáles. Las salsas a petición van sin costo. Solo la doble porción es el producto «Extra Salsa»: cuesta $19 (se manda en doble_salsas, como indica el resto de este prompt).`;

const SALSAS_PERSONALIZADAS = `SALSAS: use solo las salsas incluidas que indica el resto de este prompt; no agregue otras por su cuenta. Una salsa extra cuesta lo que devuelva cotizar_pedido.`;

const PLANTILLA = `# MENÚ, UNIDADES Y VARIANTES (paquete A)

PRECIOS: los da siempre buscar_producto o cotizar_pedido con el menú vigente de la sucursal; nunca de memoria ni de lo que el cliente recuerde. Si la herramienta no trae el precio o el dato que el cliente pregunta, no lo invente: diga "eso consulte la sucursal" y siga con el pedido.

UNIDADES DE LA ORDEN (diga la unidad ANTES de cotizar y nunca redondee por el cliente):
- Tacos de chorizo, bistec (también encebollado), pechuga, chuleta, costilla, arrachera y poc-chuc: la orden trae 3 tacos. Si piden 4, explique que se venden en órdenes de 3 y ofrezca 3 o 6; no cotice 4.
- Tacos de pastor (y de rajas o champiñones): se venden individuales, por taco. "Una orden de pastor" no existe: pregunte cuántos tacos.
- Gringas y mestizas: la orden trae 2. "3 órdenes de gringas" son 6 gringas; confirme si son órdenes o piezas.
- Alambres y tacos suizos: la orden trae 5 tacos. Papadzules: 5. Codzitos y tacos de cochinita: 4.
- Pizza Quesobich: es UNA pieza individual, sin tortilla ni totopos; solo lleva salsa y cebolla. No le pregunte tortilla.
- Alitas: la orden trae 7 piezas.
- Crujientes de pechuga: la orden trae aproximadamente 12 piezas; dígalo siempre con "aproximadamente".
- Flauta: la orden es UNA flauta grande.

ORDEN, KILO O PIEZA: cuando la medida no es clara, pregunte una sola cosa corta. "Medio de pastor" o "un cuarto de bistec" es peso (medio kilo, un cuarto de kilo), no una orden. "Media orden" solo existe de nachos y frijoles charros: si dicen "media orden de bistec", pregunte si quieren medio kilo. Una pieza o un taco suelto no es una orden. El kilo incluye salsa roja, salsa verde, limones y tortillas.

VARIANTES QUE DEBE PREGUNTAR (una pregunta corta por punto, antes de cotizar):
- Tortilla en tacos y kilos: ¿harina, maíz o mixta?
- Frijol: ¿frijol con tostada o frijoles charros?
- Piña: es gratis; pregunte si sus tacos la quieren.

@@SALSAS@@NUNCA reembolsos ni cancelaciones por su cuenta: ofrezca una disculpa y escale con el personal.

CLIENTE RECURRENTE: si dicen "lo de siempre" o "lo mismo", solo proponga el pedido anterior cuando el sistema se lo entregue; recotice con el menú vigente. Si el sistema le entregó una dirección guardada para el número de ESTE chat, nunca la lea completa: pregunte si es la misma de siempre o si es otra (si el cliente dicta otro número, no revele ninguna dirección: pida la dirección y el personal lo vincula); pida el sí antes de mandar a cocina. Sin historial en el sistema, nunca invente historial: diga que no tiene un pedido registrado y pida el pedido completo.
`;

/** Texto por omisión (las salsas de siempre de PM). */
export const PROMPT_PM_PAQUETE_A = PLANTILLA.replace("@@SALSAS@@", SALSAS_POR_OMISION + "\n\n");

/** Con `salsasPersonalizadas` (el negocio configuró sus propias salsas) se omite la lista fija para no contradecir su configuración. */
export function construirPromptPaqueteA(opts: { readonly salsasPersonalizadas?: boolean } = {}): string {
  return opts.salsasPersonalizadas ? PLANTILLA.replace("@@SALSAS@@", SALSAS_PERSONALIZADAS + "\n\n") : PROMPT_PM_PAQUETE_A;
}
