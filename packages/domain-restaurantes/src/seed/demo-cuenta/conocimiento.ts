import type { ConocimientoDef } from "./tipos.ts";
import { MARCA, POLITICAS } from "./marca.ts";

// Conocimiento publicado del negocio (restaurantes.conocimiento_negocio): preguntas frecuentes, politicas y avisos del agente. Por regla del sistema
// NUNCA lleva precios ni nombres exactos de productos (el agente los toma del menu real con las herramientas); lo valida el propio plan.
export const CONOCIMIENTO: readonly ConocimientoDef[] = [
  { titulo: "Historia de la marca", tipo: "faq", prioridad: 40, texto: MARCA.historia },
  { titulo: "Quiénes somos y slogan", tipo: "faq", prioridad: 40, texto: `${MARCA.nombre} es una cadena de taquerías de estilo norteño con seis sucursales (Monterrey, Guadalajara, Ciudad de México, Puebla y Tijuana). Nuestro lema es «${MARCA.slogan}». Es una marca ficticia de demostración.` },
  { titulo: "Formas de pago", tipo: "politica", prioridad: 70, texto: `Aceptamos: ${POLITICAS.pago.join("; ")}.` },
  { titulo: "Propina", tipo: "politica", prioridad: 60, texto: POLITICAS.propina },
  { titulo: "Pedidos grandes y fiestas", tipo: "politica", prioridad: 80, texto: POLITICAS.pedidoGrande },
  { titulo: "Tiempos de preparación", tipo: "politica", prioridad: 70, texto: POLITICAS.tiemposPreparacion },
  { titulo: "Cobertura y envío", tipo: "politica", prioridad: 75, texto: POLITICAS.cobertura },
  { titulo: "Alcohol y entregas a domicilio", tipo: "politica", prioridad: 95, texto: POLITICAS.alcoholDomicilio },
  { titulo: "Horarios por sucursal", tipo: "faq", prioridad: 85, texto: "Monterrey Obispado abre todos los días desde temprano; Monterrey Cumbres cierra los lunes; Guadalajara cierra más tarde viernes y sábado; Ciudad de México tiene dos turnos entre semana; Puebla abre todos los días hasta las diez de la noche; Tijuana abre de corrido del viernes al mediodía hasta el domingo por la noche. Para el horario exacto de hoy el agente consulta la sucursal." },
  { titulo: "Desayunos y menudo", tipo: "faq", prioridad: 50, texto: "Los desayunos norteños se sirven solo en Monterrey Obispado y en Ciudad de México Narvarte, que abren por la mañana. El menudo y la pancita se sirven en Monterrey, Guadalajara y Ciudad de México." },
  { titulo: "Cabrito: anticipo y disponibilidad", tipo: "faq", prioridad: 65, texto: "El cabrito por cuarto o más se pide con noventa minutos de anticipo; el cabrito entero, con un día. No se surte en Tijuana." },
  { titulo: "Cómo se piden los kilos de carne", tipo: "faq", prioridad: 60, texto: "La carne por peso se vende en fracciones de kilo (un cuarto, medio kilo, un kilo, kilo y medio y dos kilos, según la carne). Cada fracción cuesta el precio del kilo de esa sucursal por el peso. Va con tortillas de harina, cebollitas y salsas sin costo." },
  { titulo: "Término de la carne", tipo: "faq", prioridad: 55, texto: "Los cortes de res se pueden pedir en término medio, tres cuartos o bien cocido; si el cliente no elige, se sirve tres cuartos. El pollo y la chuleta de cerdo siempre van bien cocidos." },
  { titulo: "Tortillas y alergias al gluten", tipo: "faq", prioridad: 75, texto: "Los tacos se piden en tortilla de maíz, de harina o mixta. La tortilla de harina contiene gluten. Las parrillas comparten superficie de cocción, por lo que no podemos garantizar ausencia de trazas de gluten, lácteos, soya ni cacahuate." },
  { titulo: "Alérgenos del menú", tipo: "politica", prioridad: 90, texto: "Cada platillo del menú trae su lista de ingredientes y alérgenos. El agente solo informa lo que dice el menú: si un dato no aparece, lo consulta con la sucursal y nunca lo inventa. Los alérgenos que informamos son gluten, lácteos, huevo, soya, frutos secos, cacahuate, sulfitos, mostaza, ajonjolí, pescado, mariscos y apio." },
  { titulo: "Opciones vegetarianas", tipo: "faq", prioridad: 40, texto: "Hay tacos, burritos, quesadillas y papas asadas sin carne (frijoles, nopal, rajas, flor de calabaza y hongos). Se cocinan en la misma parrilla que la carne." },
  { titulo: "Menú chiquito", tipo: "faq", prioridad: 30, texto: "Hay un menú para niños con porciones chicas de tacos, burrito, quesadilla y sincronizada, sin picante." },
  { titulo: "Facturación", tipo: "faq", prioridad: 50, texto: POLITICAS.facturacion },
  { titulo: "Aviso de privacidad y derechos ARCO", tipo: "politica", prioridad: 60, texto: `${POLITICAS.privacidad} Contacto de privacidad: ${MARCA.correos.privacidad}.` },
  { titulo: "Pedido incorrecto o con un problema", tipo: "faq", prioridad: 85, texto: `Si el pedido llegó incompleto, frío o equivocado, se avisa a la sucursal que lo preparó y su gerente se comunica con el cliente. También se puede escribir a ${MARCA.correos.contacto}.` },
  { titulo: "Eventos y carnes asadas", tipo: "faq", prioridad: 45, texto: `Para eventos, servicio de parrilla en sitio o pedidos corporativos: ${MARCA.correos.eventos} o la línea de oficina ${MARCA.telefonoOficina}.` },
  { titulo: "Aviso de la temporada de futbol", tipo: "aviso_temporal", prioridad: 70, texto: "En días de partido grande los paquetes de tacos se agotan temprano: se recomienda pedirlos con un día de anticipo." },
];
