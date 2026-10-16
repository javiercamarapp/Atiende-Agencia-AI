import type { AgenteDef, MarcaDef, OrganizacionDef, PoliticasDef } from "./tipos.ts";

// Marca ficticia: «El Tizón Norteño», cadena de taquerías de estilo NORTEÑO (Nuevo León, Chihuahua, Sonora y Baja California): carne asada al carbón,
// arrachera, cabrito, machaca con huevo, tripitas, burritos y quesadillas en tortilla de harina, charolas y kilos por peso.
// Por qué este estilo: Los Taquitos de PM es de Mérida (pastor, poc-chuc, cochinita, comida regional yucateca); el estilo norteño comparte el giro
// (taquería a domicilio con pedidos por kilo) pero casi ningún platillo, precio, salsa ni colonia con PM, y exige reglas propias (tortilla de harina,
// término de la carne, cabrito por cuarto, pedidos de fútbol por cientos de tacos). Nada de esto es real: nombre, teléfonos, direcciones y correos son inventados.

export const ORGANIZACION: OrganizacionDef = {
  slug: "demo-cadena",
  nombre: "El Tizón Norteño",
  version: "demo-cuenta-2026-10-14",
};

export const MARCA: MarcaDef = {
  nombre: "El Tizón Norteño",
  nombreCorto: "El Tizón",
  slogan: "Carne asada con sabor a patio",
  dominio: "eltizonnorteno.example",
  correos: {
    contacto: "contacto@eltizonnorteno.example",
    pedidos: "pedidos@eltizonnorteno.example",
    facturas: "facturacion@eltizonnorteno.example",
    eventos: "eventos@eltizonnorteno.example",
    privacidad: "privacidad@eltizonnorteno.example",
  },
  telefonoOficina: "81 5555 0100",
  colores: { primario: "#8c2f1b", secundario: "#2b2118", acento: "#f2a93b" },
  historia:
    "El Tizón Norteño nació en un patio de Monterrey donde los domingos se asaba carne al carbón para la familia. De ahí salió el primer puesto de tacos, luego el local de Obispado y, con los años, una cadena de seis sucursales entre Monterrey, Guadalajara, Ciudad de México, Puebla y Tijuana. Seguimos asando con mezquite y carbón, haciendo la tortilla de harina a diario y vendiendo la carne por kilo para las carnes asadas de los fines de semana.",
};

export const POLITICAS: PoliticasDef = {
  pago: ["efectivo (avise si necesita cambio de billete grande)", "terminal con tarjeta de débito o crédito (al recoger o con el repartidor)", "transferencia bancaria antes de la salida del pedido"],
  propina: "La política de propina depende de la sucursal: en algunas solo se acepta con tarjeta, en otras siempre y en otras nunca. El agente la consulta en la regla de la sucursal.",
  pedidoGrande: "Los pedidos de fútbol, fiestas y carnes asadas grandes (más de 80 tacos o más de 4 kg de carne) los confirma una persona de la sucursal con anticipo de un día.",
  tiemposPreparacion: "Tacos y burritos de 15 a 25 minutos; kilos y charolas de 35 a 50 minutos; cabrito por cuarto o más, con 90 minutos de anticipo.",
  cobertura: "Reparto en las colonias de cobertura de cada sucursal, dentro de su radio; el envío no tiene costo. Fuera de cobertura solo se puede recoger.",
  alcoholDomicilio: "No se envía alcohol a domicilio: cervezas, mezcales y cocteles solo para recoger en sucursal y con identificación de mayoría de edad.",
  privacidad: "El Tizón Norteño (nombre ficticio de demostración) trata los datos de sus clientes solo para atender pedidos. Derechos ARCO: privacidad@eltizonnorteno.example.",
  facturacion: "La facturación de demostración se solicita dentro del mismo mes a facturacion@eltizonnorteno.example con el ticket y la constancia fiscal. No es un servicio real.",
};

export const AGENTE: AgenteDef = {
  nombre: "Chema",
  tono: "calido_cercano",
  saludo: "¡Bienvenido a El Tizón Norteño! Le atiende Chema, su asistente virtual.",
  salsas: "brava de árbol, verde asada y pico de gallo van siempre en la mesa; salsa macha y chipotle ahumada solo si las pide, sin costo",
  promociones: "jueves 2x1 en tacos de arrachera al carbón, miércoles burrito grande con agua fresca de cortesía y martes 10% al recoger",
  tiempoEntrega: "tacos y burritos de 35 a 50 minutos a domicilio y de 15 a 25 para recoger; kilos y charolas, más",
  umbralPedidoGrande: "más de 80 tacos o más de 4 kg de carne: lo confirma la sucursal con un día de anticipo",
  esperaRafagasSegundos: 5,
  reglasDuras: [
    "Alcohol: nunca a domicilio (se marca por producto).",
    "La carne se pide con término: tres cuartos por omisión; el pollo y la chuleta siempre bien cocidos.",
    "Tacos al carbón: pregunte tortilla de maíz o de harina antes de cotizar.",
    "El cabrito por cuarto o más se pide con 90 minutos de anticipo.",
  ],
};
