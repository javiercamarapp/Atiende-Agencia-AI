// Alta autoservicio -- «primer valor en <30 min»: los pasos MINIMOS para que UNA sucursal recien creada atienda su primer pedido por
// WhatsApp, en orden y con el tiempo estimado de cada uno. Todo se deriva de datos reales (lo mismo que exige la activacion de la 0071:
// menu, horario y cobertura) mas dos hitos que no dejan fila de negocio (core.onboarding_evento): metodos de pago confirmados (0078) y
// la prueba del agente en la vista previa (0073). Puro: el llamador pasa las lecturas.

export type PasoPrimerValorId = "menu" | "horario" | "zonas" | "metodos_pago" | "probar_agente" | "activar";
export type EstadoPasoPrimerValor = "hecho" | "pendiente" | "no_disponible";

export interface PasoPrimerValor {
  readonly id: PasoPrimerValorId;
  readonly titulo: string;
  readonly detalle: string;
  readonly estado: EstadoPasoPrimerValor;
  /** Minutos que suele tomar (para el estimado restante). */
  readonly minutos: number;
  /** Pantalla del panel que lo cierra (relativa a /restaurantes/:orgSlug). null = se cierra en esta misma pantalla. */
  readonly pantalla: string | null;
}

export interface PrimerValor {
  readonly sucursal: { readonly propertyId: string; readonly nombre: string; readonly status: "active" | "inactive" };
  readonly pasos: readonly PasoPrimerValor[];
  readonly hechos: number;
  readonly minutosRestantes: number;
  /** Todo lo necesario para activar esta hecho (menu, horario, zonas). */
  readonly puedeActivar: boolean;
  readonly listo: boolean;
}

export interface LecturasPrimerValor {
  readonly sucursal: { readonly propertyId: string; readonly nombre: string; readonly status: "active" | "inactive" };
  readonly productosDisponibles: number;
  readonly tieneHorario: boolean;
  readonly aceptaDomicilio: boolean;
  readonly coloniasConCobertura: number;
  /** null = no se puede medir (base sin la 0078). */
  readonly metodosPagoConfirmados: boolean | null;
  /** null = no se puede medir (base sin la 0073). */
  readonly agenteProbado: boolean | null;
}

const est = (hecho: boolean | null): EstadoPasoPrimerValor => (hecho === null ? "no_disponible" : hecho ? "hecho" : "pendiente");

export function calcularPrimerValor(l: LecturasPrimerValor): PrimerValor {
  const zonasHechas = !l.aceptaDomicilio || l.coloniasConCobertura > 0;
  const pasos: PasoPrimerValor[] = [
    {
      id: "menu",
      titulo: "Sube tu menú",
      detalle: l.productosDisponibles > 0 ? `${l.productosDisponibles} productos a la venta en esta sucursal.` : "Importa tu menú en PDF, foto o CSV y revisa los precios.",
      estado: est(l.productosDisponibles > 0),
      minutos: 10,
      pantalla: "productos",
    },
    { id: "horario", titulo: "Pon tu horario", detalle: "Días y horas en que la sucursal recibe pedidos.", estado: est(l.tieneHorario), minutos: 3, pantalla: "sucursales" },
    {
      id: "zonas",
      titulo: "Define dónde entregas",
      detalle: !l.aceptaDomicilio ? "Solo para recoger: no necesita zonas." : l.coloniasConCobertura > 0 ? `${l.coloniasConCobertura} colonias con entrega.` : "Elige las colonias a las que entregas (o marca «solo para recoger»).",
      estado: est(zonasHechas),
      minutos: 5,
      pantalla: "sucursales",
    },
    {
      id: "metodos_pago",
      titulo: "Confirma cómo cobras",
      detalle: "Tu agente cobra en efectivo (pregunta con cuánto paga) o con tarjeta llevando terminal. Confírmalo para esta sucursal.",
      estado: est(l.metodosPagoConfirmados),
      minutos: 1,
      pantalla: null,
    },
    {
      id: "probar_agente",
      titulo: "Prueba tu agente",
      detalle: "Haz un pedido de prueba en la vista previa de WhatsApp: no llega a la cocina ni cobra.",
      estado: est(l.agenteProbado),
      minutos: 5,
      pantalla: "agente-whatsapp",
    },
    {
      id: "activar",
      titulo: "Activa la sucursal",
      detalle: l.sucursal.status === "active" ? "La sucursal ya recibe pedidos." : "Cuando esté lista, actívala para empezar a recibir pedidos.",
      estado: est(l.sucursal.status === "active"),
      minutos: 1,
      pantalla: null,
    },
  ];
  const hechos = pasos.filter((p) => p.estado === "hecho").length;
  const minutosRestantes = pasos.filter((p) => p.estado !== "hecho").reduce((n, p) => n + p.minutos, 0);
  const puedeActivar = l.productosDisponibles > 0 && l.tieneHorario && zonasHechas;
  return { sucursal: l.sucursal, pasos, hechos, minutosRestantes, puedeActivar, listo: l.sucursal.status === "active" && hechos === pasos.length };
}
