import type { ModificadorDef } from "./tipos.ts";

// Modificadores del menu. El esquema de restaurantes todavia NO tiene una tabla de modificadores: lo que cuesta dinero (extras, tortillas, salsas) vive
// como productos de «Extras del Asador»; lo que no cuesta (sin cebolla, termino de la carne, tortilla a elegir) viaja en las notas del pedido y en la
// descripcion/conocimiento que lee el agente. Esta lista es la FUENTE de esas reglas y la validan las pruebas (opciones, minimos y maximos).
export const MODIFICADORES: readonly ModificadorDef[] = [
  { id: "termino-carne", nombre: "Término de la carne", aplicaA: ["Parrilla y Cortes", "Tampiqueña Norteña"], tipo: "termino", opciones: ["medio", "tres cuartos", "bien cocido"], min: 1, max: 1, nota: "Tres cuartos si el cliente no elige; pollo y chuleta siempre bien cocidos." },
  { id: "tortilla", nombre: "Tortilla", aplicaA: ["Tacos al Carbón"], tipo: "tortilla", opciones: ["maíz", "harina", "mixta"], min: 1, max: 1, nota: "Se pregunta antes de cotizar; los kilos de carne van con tortillas de harina salvo que pidan maíz." },
  { id: "sin-cebolla", nombre: "Sin cebolla ni cilantro", aplicaA: ["Tacos al Carbón", "Burritos de Harina", "Quesadillas y Sincronizadas de Harina"], tipo: "sin", opciones: ["sin cebolla", "sin cilantro", "sin ambos"], min: 0, max: 2, nota: "No tiene costo; se anota en el pedido." },
  { id: "sin-picante", nombre: "Sin picante", aplicaA: ["Tacos al Carbón", "Burritos de Harina", "Botanas y Entradas", "Desayunos Norteños"], tipo: "sin", opciones: ["sin chile", "salsa aparte"], min: 0, max: 1, nota: "La salsa va aparte por omisión en domicilio." },
  { id: "sin-lacteos", nombre: "Sin queso", aplicaA: ["Quesadillas y Sincronizadas de Harina", "Burritos de Harina", "Papas Asadas y Guarniciones"], tipo: "sin", opciones: ["sin queso"], min: 0, max: 1, nota: "Las quesadillas sin queso no se preparan; se ofrece un burrito." },
  { id: "extra-queso", nombre: "Extra queso Chihuahua", aplicaA: ["Burritos de Harina", "Papas Asadas y Guarniciones", "Botanas y Entradas"], tipo: "extra", opciones: ["una porción", "dos porciones"], min: 0, max: 2, nota: "Se vende como producto de Extras del Asador." },
  { id: "extra-carne", nombre: "Porción extra de carne", aplicaA: ["Burritos de Harina", "Papas Asadas y Guarniciones"], tipo: "extra", opciones: ["machaca", "arrachera"], min: 0, max: 3, nota: "Hasta tres porciones por platillo; se vende como producto." },
  { id: "tamano-burrito", nombre: "Tamaño del burrito", aplicaA: ["Burritos de Harina"], tipo: "tamano", opciones: ["chico", "grande"], min: 1, max: 1, nota: "El chico trae una tortilla de 20 cm; el grande una de 30 cm." },
  { id: "tamano-quesadilla", nombre: "Tamaño de la quesadilla", aplicaA: ["Quesadillas y Sincronizadas de Harina"], tipo: "tamano", opciones: ["chica", "gigante"], min: 1, max: 1, nota: "La gigante es de 30 cm y alcanza para dos." },
  { id: "peso-kilo", nombre: "Peso de la carne por kilo", aplicaA: ["Charolas y Kilos"], tipo: "tamano", opciones: ["250 g", "500 g", "1 kg", "1.5 kg", "2 kg"], min: 1, max: 1, nota: "Cada fracción vale el precio del kilo de la sucursal por el peso." },
];
