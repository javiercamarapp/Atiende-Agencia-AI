import type { PromocionDef } from "./tipos.ts";

// Cinco promociones ficticias (todas se aplican solas al cotizar): un 2x1 en jueves (NO lunes), un combo del dia (miercoles) con cortesia, una cortesia por
// monto de pedido, una promo solo para recoger (martes) y una promo con alcance por sucursal (domingo, solo Monterrey).
export const PROMOCIONES: readonly PromocionDef[] = [
  {
    codigo: "JUEVES2X1CARBON",
    nombre: "Jueves 2x1 en tacos de arrachera al carbón",
    tipo: "bogo",
    dias: [4],
    canales: ["domicilio", "recoger"],
    productos: ["Taco de Arrachera Marinada al Carbón (individual)"],
    descripcion: "Los jueves, en todas las sucursales y en cualquier canal, 2x1 en el taco individual de arrachera al carbón (por cada dos, uno va de cortesía).",
  },
  {
    codigo: "MIERCOLESBURRITOAGUA",
    nombre: "Combo del miércoles: burrito grande con agua fresca de cortesía",
    tipo: "cortesia",
    dias: [3],
    canales: ["domicilio", "recoger"],
    productos: ["Burrito Grande de Arrachera", "Burrito Grande de Machaca con Huevo"],
    cortesiaProductos: ["Agua de Limón con Chía (vaso 500 ml)", "Agua de Sandía (vaso 500 ml)", "Agua de Melón (vaso 500 ml)"],
    cortesiaCantidad: 1,
    descripcion: "Los miércoles, por cada burrito grande de arrachera o de machaca con huevo, un vaso de agua fresca de cortesía a elegir entre limón con chía, sandía y melón.",
  },
  {
    codigo: "POSTRECORTESIA700",
    nombre: "Postre de cortesía en pedidos grandes",
    tipo: "cortesia",
    dias: [],
    canales: ["domicilio", "recoger"],
    productos: ["Charola Norteña para 2", "Charola Norteña para 4", "Charola Norteña para 6", "Paquete Carne Asada de 3 kg"],
    cortesiaProductos: ["Empanada de Cajeta (orden de 2)", "Pan de Elote"],
    cortesiaCantidad: 1,
    montoMinimo: 700,
    descripcion: "En pedidos de 700 pesos o más que incluyan una charola o el paquete de carne asada, un postre de cortesía a elegir entre la empanada de cajeta y el pan de elote.",
  },
  {
    codigo: "MARTESRECOGE10",
    nombre: "Martes de recoger: 10% de descuento",
    tipo: "percentage",
    dias: [2],
    canales: ["recoger"],
    porcentaje: 10,
    montoMinimo: 350,
    descripcion: "Los martes, solo para recoger en sucursal, 10% de descuento en pedidos de 350 pesos o más. No aplica a domicilio.",
  },
  {
    codigo: "DOMINGOREGIO15",
    nombre: "Domingo regio: 15% en pedidos grandes (solo Monterrey)",
    tipo: "percentage",
    dias: [0],
    canales: ["domicilio", "recoger"],
    porcentaje: 15,
    montoMinimo: 900,
    sucursales: ["MTY1", "MTY2"],
    descripcion: "Los domingos, solo en las dos sucursales de Monterrey, 15% de descuento en pedidos de 900 pesos o más.",
  },
];
