// R-33 -- checklist de onboarding del restaurante: que falta para operar de verdad. Cada punto se CALCULA con datos reales de la
// organizacion (sucursales, menu, horarios, coordenadas, cobertura, numeros de WhatsApp, agente, pedidos): nunca un estado
// guardado a mano ni un "hecho" por defecto. Lo que depende de un tercero (distribuidor del POS) o del dueño y no se puede
// comprobar desde aqui se marca `externo`/`pendiente` con quien lo cierra, para que la demo muestre honestamente lo que NO se inventa.
//
// Todas las lecturas pasan por el repositorio, que contra la base sin migrar degrada con SAVEPOINT a "sin configurar": un punto
// nunca se da por hecho por falta de tabla.
import type { RestaurantesRepository } from "./repository.ts";
import type { PrivacidadRepository } from "./privacidad/repository.ts";
import type { VozRepository } from "./voz/repository.ts";

export type OnboardingEstado = "hecho" | "parcial" | "pendiente" | "externo";
export type OnboardingResponsable = "plataforma" | "dueno" | "meta" | "distribuidor_pos";
export type OnboardingPantalla = "sucursales" | "productos" | "configuracion" | "pedidos" | "conversaciones" | "agente-voz" | "privacidad";

export interface OnboardingItem {
  readonly id: string;
  readonly titulo: string;
  readonly estado: OnboardingEstado;
  /** Un punto obligatorio pendiente bloquea `listoParaOperar` (el gate). */
  readonly obligatorio: boolean;
  readonly detalle: string;
  /** Nombres de las sucursales (u objetos) a los que todavia les falta. */
  readonly faltantes: readonly string[];
  readonly responsable: OnboardingResponsable;
  readonly pantalla: OnboardingPantalla;
}

export interface OnboardingChecklist {
  readonly items: readonly OnboardingItem[];
  readonly resumen: { readonly hechos: number; readonly total: number; readonly obligatoriosPendientes: number };
  /** Todos los puntos obligatorios estan hechos. */
  readonly listoParaOperar: boolean;
  /** Gate de entrada al panel (ver `evaluarGateOnboarding`). */
  readonly gate: OnboardingGate;
}

/** Gate de onboarding: lo que otras piezas (shell, banner, endpoint) consultan para decidir si el owner/admin debe aterrizar en "Primeros pasos".
 * REGLA: bloquea solo si faltan puntos obligatorios Y la organizacion aun no tiene pedidos registrados. Una organizacion que ya opera con
 * pedidos reales nunca se desvia: sus pendientes se muestran como banner informativo, no como bloqueo. */
export interface OnboardingGate {
  readonly bloquea: boolean;
  readonly obligatoriosPendientes: number;
  readonly operaConPedidos: boolean;
}

export function evaluarGateOnboarding(obligatoriosPendientes: number, pedidos: number): OnboardingGate {
  const operaConPedidos = pedidos > 0;
  return { bloquea: obligatoriosPendientes > 0 && !operaConPedidos, obligatoriosPendientes, operaConPedidos };
}

export interface OnboardingBranchSnapshot {
  readonly nombre: string;
  readonly activa: boolean;
  readonly conCoordenadas: boolean;
  readonly productosDisponibles: number;
  readonly conHorario: boolean;
  /** Mas de un turno el mismo dia (la hora del cambio de turno esta modelada). */
  readonly dobleTurno: boolean;
  readonly conPedidoMinimo: boolean;
  readonly zonasDeEntrega: number;
  readonly conWhatsappPropio: boolean;
  /** Voz de la sucursal: `habilitada`, `deshabilitada` (el dueño la apago EXPLICITAMENTE: hay fila de configuracion) o `sin_configurar`
   * (sin fila, o base sin la migracion 025). */
  readonly voz: "habilitada" | "deshabilitada" | "sin_configurar";
}

export interface OnboardingSnapshot {
  readonly sucursales: readonly OnboardingBranchSnapshot[];
  readonly whatsappGeneral: boolean;
  readonly agenteConfigurado: boolean;
  readonly nombreDelAsistente: boolean;
  readonly pedidos: number;
  /** El proveedor de voz del despliegue tiene credenciales y responde (salud ok). `false` = credenciales ausentes. */
  readonly vozProveedorListo: boolean;
  /** `false` = la base no tiene la migracion 030 (el aviso no se puede publicar todavia). */
  readonly privacidadDisponible: boolean;
  /** La organizacion publico la URL de su aviso de privacidad integral (migracion 030). */
  readonly avisoPublicado: boolean;
}

const lista = (nombres: readonly string[]) => (nombres.length > 0 ? nombres.join(", ") : "");

function estadoPorSucursal(activas: readonly OnboardingBranchSnapshot[], cumple: (b: OnboardingBranchSnapshot) => boolean): { estado: OnboardingEstado; faltantes: string[] } {
  const faltantes = activas.filter((b) => !cumple(b)).map((b) => b.nombre);
  if (activas.length === 0) return { estado: "pendiente", faltantes: [] };
  if (faltantes.length === 0) return { estado: "hecho", faltantes: [] };
  return { estado: faltantes.length === activas.length ? "pendiente" : "parcial", faltantes };
}

/** Funcion pura: del estado real de la organizacion al checklist. */
export function buildOnboardingChecklist(snapshot: OnboardingSnapshot): OnboardingChecklist {
  const activas = snapshot.sucursales.filter((b) => b.activa);
  const items: OnboardingItem[] = [];
  const add = (item: OnboardingItem) => items.push(item);

  add({
    id: "sucursales",
    titulo: "Sucursales activas",
    estado: activas.length > 0 ? "hecho" : "pendiente",
    obligatorio: true,
    // QA-restaurantes-R1-viaje-13: con el punto en "hecho" las inactivas se mencionan en el detalle (la pantalla
    // no las pinta como "Falta en:", ver PrimerosPasos.tsx); `faltantes` sigue listandolas para quien las consuma.
    detalle:
      activas.length > 0
        ? `${activas.length} sucursal(es) activa(s) de ${snapshot.sucursales.length} registrada(s)${snapshot.sucursales.length > activas.length ? ` (inactivas: ${lista(snapshot.sucursales.filter((b) => !b.activa).map((b) => b.nombre))})` : ""}.`
        : "No hay ninguna sucursal activa: el agente no tiene a donde mandar pedidos.",
    faltantes: snapshot.sucursales.filter((b) => !b.activa).map((b) => b.nombre),
    responsable: "dueno",
    pantalla: "sucursales",
  });

  const menu = estadoPorSucursal(activas, (b) => b.productosDisponibles > 0);
  add({
    id: "menu",
    titulo: "Menú por sucursal",
    ...menu,
    obligatorio: true,
    detalle: menu.estado === "hecho" ? "Todas las sucursales activas tienen menú con precios." : `Sin menú disponible en: ${lista(menu.faltantes)}.`,
    responsable: "plataforma",
    pantalla: "productos",
  });

  const horarios = estadoPorSucursal(activas, (b) => b.conHorario);
  add({
    id: "horarios",
    titulo: "Horario de cada sucursal",
    ...horarios,
    obligatorio: true,
    detalle: horarios.estado === "hecho" ? "Todas tienen horario: el agente sabe cuando esta abierto y rechaza pedidos fuera de horario." : `Sin horario en: ${lista(horarios.faltantes)}; sin horario el agente no puede decir si esta abierto.`,
    responsable: "dueno",
    pantalla: "sucursales",
  });

  const turnos = estadoPorSucursal(activas, (b) => b.dobleTurno);
  add({
    id: "cambio_de_turno",
    titulo: "Hora del cambio de turno",
    estado: turnos.estado,
    obligatorio: false,
    detalle:
      turnos.estado === "hecho"
        ? "El horario modela los dos turnos de personal."
        : "El horario tiene una sola franja por dia: si el negocio opera en doble turno, el dueño debe dar la hora del cambio (no se inventa).",
    faltantes: turnos.faltantes,
    responsable: "dueno",
    pantalla: "sucursales",
  });

  const minimo = estadoPorSucursal(activas, (b) => b.conPedidoMinimo);
  add({
    id: "pedido_minimo",
    titulo: "Pedido mínimo a domicilio",
    ...minimo,
    obligatorio: false,
    detalle: minimo.estado === "hecho" ? "Todas las sucursales tienen pedido mínimo a domicilio." : `Sin pedido mínimo en: ${lista(minimo.faltantes)}.`,
    responsable: "dueno",
    pantalla: "sucursales",
  });

  const coordenadas = estadoPorSucursal(activas, (b) => b.conCoordenadas);
  add({
    id: "coordenadas",
    titulo: "Coordenadas de cada sucursal",
    ...coordenadas,
    obligatorio: false,
    detalle: coordenadas.estado === "hecho" ? "Todas tienen coordenadas: la asignación de sucursal por distancia las considera." : `Sin coordenadas: ${lista(coordenadas.faltantes)}. No entran en la asignación de sucursal por distancia hasta que se confirmen.`,
    responsable: "dueno",
    pantalla: "sucursales",
  });

  const cobertura = estadoPorSucursal(activas, (b) => b.zonasDeEntrega > 0);
  add({
    id: "zonas_de_entrega",
    titulo: "Cobertura de entrega (mapa de colonias)",
    ...cobertura,
    obligatorio: false,
    detalle:
      cobertura.estado === "hecho"
        ? "Cada sucursal tiene sus colonias de reparto."
        : "Sin cobertura configurada no se restringe ninguna entrega ni se rechaza 'fuera de zona'. El dueño debe entregar el mapa de colonias por sucursal (no se inventa).",
    responsable: "dueno",
    pantalla: "configuracion",
  });

  const whatsapp = estadoPorSucursal(activas, (b) => b.conWhatsappPropio);
  add({
    id: "whatsapp",
    titulo: "Número de WhatsApp por sucursal",
    estado: whatsapp.estado === "hecho" ? "hecho" : snapshot.whatsappGeneral ? "parcial" : whatsapp.estado,
    obligatorio: false,
    detalle:
      whatsapp.estado === "hecho"
        ? "Cada sucursal recibe mensajes por su propio número."
        : whatsapp.faltantes.length < activas.length
          ? `${activas.length - whatsapp.faltantes.length} de ${activas.length} sucursal(es) con número propio; sin número propio: ${lista(whatsapp.faltantes)}${snapshot.whatsappGeneral ? " (atendidas por el número general)" : ""}.`
          : snapshot.whatsappGeneral
            ? `Solo hay un número general; sin número propio: ${lista(whatsapp.faltantes)}.`
            : "Ningún número de WhatsApp conectado: el agente por WhatsApp real no recibe mensajes (la demo del widget no lo necesita). Requiere el número de cada sucursal y las credenciales de Meta.",
    faltantes: whatsapp.faltantes,
    responsable: "meta",
    pantalla: "configuracion",
  });

  add({
    id: "agente_whatsapp",
    titulo: "Agente de WhatsApp configurado",
    estado: snapshot.agenteConfigurado ? "hecho" : "pendiente",
    obligatorio: true,
    detalle: snapshot.agenteConfigurado ? "El perfil del agente está configurado para esta organización." : "Sin configuración propia: el agente responde con el perfil genérico (tutea, solo domicilio).",
    faltantes: [],
    responsable: "plataforma",
    pantalla: "configuracion",
  });

  // Voz por sucursal: hecho = habilitada con proveedor listo, o deshabilitada EXPLICITAMENTE por el dueño. Habilitada pero sin credenciales
  // del proveedor depende de la plataforma (externo). No es obligatoria: un restaurante sin voz opera por WhatsApp.
  const vozPend = activas.filter((b) => b.voz === "sin_configurar").map((b) => b.nombre);
  const vozSinCredenciales = activas.filter((b) => b.voz === "habilitada").map((b) => b.nombre);
  const vozEstado: OnboardingEstado =
    activas.length === 0 || vozPend.length === activas.length
      ? "pendiente"
      : vozPend.length > 0
        ? "parcial"
        : vozSinCredenciales.length > 0 && !snapshot.vozProveedorListo
          ? "externo"
          : "hecho";
  add({
    id: "voz",
    titulo: "Agente de voz por sucursal",
    estado: vozEstado,
    obligatorio: false,
    detalle:
      vozEstado === "hecho"
        ? "Cada sucursal tiene su decisión de voz: habilitada o deshabilitada a propósito."
        : vozEstado === "externo"
          ? "La voz está habilitada pero el proveedor no tiene credenciales en este despliegue: las llamadas no se atienden hasta que la plataforma las cargue."
          : `Sin decisión de voz en: ${lista(vozPend)}. Habilítela o deshabilítela a propósito en el agente de voz.`,
    faltantes: vozPend,
    responsable: vozEstado === "externo" ? "plataforma" : "dueno",
    pantalla: "agente-voz",
  });

  // Aviso de privacidad: obligatorio (LFPDPPP) en cuanto la base lo soporta. Sin la migracion 030 el dueño no puede cerrarlo: se muestra
  // como externo (plataforma) y NO bloquea, para no encerrar a nadie detras de algo que no puede hacer.
  add({
    id: "aviso_privacidad",
    titulo: "Aviso de privacidad publicado",
    estado: !snapshot.privacidadDisponible ? "externo" : snapshot.avisoPublicado ? "hecho" : "pendiente",
    obligatorio: snapshot.privacidadDisponible,
    detalle: !snapshot.privacidadDisponible
      ? "La configuración de privacidad aún no está disponible en este despliegue (requiere la migración 030)."
      : snapshot.avisoPublicado
        ? "El aviso de privacidad integral está publicado y se antepone a los clientes."
        : "Sin aviso de privacidad publicado: capture la URL https de su aviso integral en Privacidad. Es obligatorio antes de atender clientes.",
    faltantes: [],
    responsable: !snapshot.privacidadDisponible ? "plataforma" : "dueno",
    pantalla: "privacidad",
  });

  add({
    id: "nombre_del_asistente",
    titulo: "Nombre del asistente virtual",
    estado: snapshot.nombreDelAsistente ? "hecho" : "pendiente",
    obligatorio: false,
    detalle: snapshot.nombreDelAsistente ? "El asistente tiene nombre." : "El dueño aún no lo define: el agente se presenta como 'el asistente virtual'.",
    faltantes: [],
    responsable: "dueno",
    pantalla: "configuracion",
  });

  add({
    id: "catalogo_pos",
    titulo: "Catálogo de SoftRestaurant (códigos de producto)",
    estado: "externo",
    obligatorio: false,
    detalle: "Depende del distribuidor del POS (export del catálogo y API). Mientras tanto las comandas quedan en captura manual; no se inventan códigos.",
    faltantes: [],
    responsable: "distribuidor_pos",
    pantalla: "configuracion",
  });

  add({
    id: "pedido_de_prueba",
    titulo: "Pedido de prueba",
    estado: snapshot.pedidos > 0 ? "hecho" : "pendiente",
    obligatorio: false,
    detalle: snapshot.pedidos > 0 ? "Ya hay pedidos registrados." : "Aún no hay pedidos: haga uno de prueba (WhatsApp o widget demo) y confirme que llega a cocina.",
    faltantes: [],
    responsable: "plataforma",
    pantalla: "pedidos",
  });

  const hechos = items.filter((i) => i.estado === "hecho").length;
  const obligatoriosPendientes = items.filter((i) => i.obligatorio && i.estado !== "hecho").length;
  return { items, resumen: { hechos, total: items.length, obligatoriosPendientes }, listoParaOperar: obligatoriosPendientes === 0, gate: evaluarGateOnboarding(obligatoriosPendientes, snapshot.pedidos) };
}

/** Lee el estado real de la organizacion con las consultas del repositorio. */
export interface OnboardingExtras {
  /** Repositorio de voz (migracion 025). Ausente o base sin migrar = voz "sin configurar". */
  readonly voz?: VozRepository;
  /** Salud del proveedor de voz del despliegue; ausente = sin credenciales. */
  readonly vozProveedorListo?: () => Promise<boolean>;
  /** Repositorio de privacidad (migracion 030). Ausente o base sin migrar = aviso no disponible. */
  readonly privacidad?: PrivacidadRepository;
}

export async function cargarOnboarding(repo: RestaurantesRepository, organizationId: string, extras: OnboardingExtras = {}): Promise<OnboardingChecklist> {
  const branches = await repo.listBranchesForOrganizationAdmin(organizationId);
  const numerosPropios = new Set((await repo.listWhatsappBranchChannels(organizationId)).map((c) => c.propertyId));
  const sucursales: OnboardingBranchSnapshot[] = [];
  for (const b of branches) {
    const activa = b.status === "active";
    if (!activa) {
      sucursales.push({ nombre: b.name, activa, conCoordenadas: b.lat !== null && b.lng !== null, productosDisponibles: 0, conHorario: false, dobleTurno: false, conPedidoMinimo: false, zonasDeEntrega: 0, conWhatsappPropio: numerosPropios.has(b.propertyId), voz: "sin_configurar" });
      continue;
    }
    // En SECUENCIA (no Promise.all): una sola sesion/transaccion por request, y cada lectura usa su propio SAVEPOINT.
    const productos = await repo.listAvailableProductsForBranch(b.propertyId);
    const politica = await repo.findBranchPolicy(b.propertyId);
    const zonas = await repo.listBranchDeliveryZoneIds(b.propertyId);
    const vozLectura = extras.voz ? await extras.voz.getConfig(b.propertyId) : null;
    const voz: OnboardingBranchSnapshot["voz"] = !vozLectura || !vozLectura.disponible || !vozLectura.valor.configurada ? "sin_configurar" : vozLectura.valor.habilitado ? "habilitada" : "deshabilitada";
    const porDia = new Map<number, number>();
    for (const t of politica.horario ?? []) for (const d of t.dias) porDia.set(d, (porDia.get(d) ?? 0) + 1);
    sucursales.push({
      nombre: b.name,
      activa,
      conCoordenadas: b.lat !== null && b.lng !== null,
      productosDisponibles: productos.length,
      conHorario: (politica.horario?.length ?? 0) > 0,
      dobleTurno: [...porDia.values()].some((n) => n > 1),
      conPedidoMinimo: politica.pedidoMinimoDomicilio !== null,
      zonasDeEntrega: zonas.length,
      conWhatsappPropio: numerosPropios.has(b.propertyId),
      voz,
    });
  }
  const general = await repo.getWhatsappChannelConfig(organizationId);
  const agente = await repo.findWhatsAppAgentConfigExacta(organizationId, null);
  const pedidos = await repo.listOrders(organizationId, { propertyIds: null, limit: 1 });
  const privacidad = extras.privacidad ? await extras.privacidad.getPrivacyConfig(organizationId) : null;
  const vozProveedorListo = extras.vozProveedorListo ? await extras.vozProveedorListo().catch(() => false) : false;
  return buildOnboardingChecklist({
    sucursales,
    vozProveedorListo,
    // El repositorio de privacidad degrada la base sin migrar a "sin configurar" (indistinguible de "sin fila"): ambos quedan pendientes, nunca hechos.
    // `privacidadDisponible` solo es `false` cuando el despliegue ni siquiera inyecta el repositorio.
    privacidadDisponible: privacidad !== null,
    avisoPublicado: privacidad !== null && privacidad.configurada && privacidad.noticeUrl !== null,
    whatsappGeneral: general.phoneNumberId !== null,
    agenteConfigurado: agente !== null,
    nombreDelAsistente: agente?.agentName != null && agente.agentName.trim().length > 0,
    pedidos: pedidos.orders.length,
  });
}
