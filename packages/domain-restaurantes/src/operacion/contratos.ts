// Contratos del panel movil del operador (encargado + chofer), seccion 2 del plan `PLAN-PANEL-OPERADOR.md`.
//
// ESTE ARCHIVO ES LA UNICA FUENTE DE VERDAD de las formas de entrada y salida de las rutas nuevas. Lo consumen tres lados sin tocarse:
//  - la API (`apps/api/.../restaurantes`): valida cuerpos con `.validar` y responde con estos tipos;
//  - la SPA (`@atiende/domain-restaurantes/operacion`): importa los TIPOS (y, si quiere, los validadores) para sus clientes HTTP;
//  - la API simulada de e2e (`apps/web/e2e/mock-api/fixtures/operacion-*.ts`): sus respuestas se validan contra estos esquemas en una prueba.
//
// Sin comportamiento: aqui no hay SQL, red ni reglas de negocio, solo formas. Hasta que el backend real exista (paquete A1) las rutas
// responden 501 `no_implementado` (honesto, nunca un exito falso). Convenciones de la API real (verificadas en el codigo): las rutas
// cuelgan de `/v1/restaurantes/:propertyId/...` y los errores salen como `{ code, message }`.
import { arreglo, booleano, enumerado, fechaIso, numero, nulable, objeto, opcional, registro, texto, uuid } from "./esquema.ts";
import type { Inferir } from "./esquema.ts";

// ---------------------------------------------------------------------------
// Vocabulario cerrado
// ---------------------------------------------------------------------------

export const CANALES_CAPTURA = ["llamada", "mostrador", "whatsapp_manual"] as const;
export type CanalCaptura = (typeof CANALES_CAPTURA)[number];

export const CANALES_PEDIDO_OPERACION = ["domicilio", "recoger"] as const;
export type CanalPedidoOperacion = (typeof CANALES_PEDIDO_OPERACION)[number];

export const FORMAS_PAGO_OPERACION = ["efectivo", "tarjeta"] as const;
export type FormaPagoOperacion = (typeof FORMAS_PAGO_OPERACION)[number];

/** Como se obtuvo el consentimiento de avisos por WhatsApp (se registra con quien y cuando; nunca se asume). */
export const VIAS_CONSENTIMIENTO = ["verbal_llamada", "mostrador", "mensaje_cliente"] as const;
export type ViaConsentimiento = (typeof VIAS_CONSENTIMIENTO)[number];

/** Por que un pedido quedo SIN aviso al cliente (el panel muestra «Sin aviso: avisar por llamada»). */
export const MOTIVOS_AVISO_OMITIDO = [
  "sin_consentimiento",
  "sin_telefono",
  "sin_canal_whatsapp",
  "plantilla_no_aprobada",
  "consentimiento_no_disponible",
  "baja_whatsapp",
] as const;
export type MotivoAvisoOmitido = (typeof MOTIVOS_AVISO_OMITIDO)[number];

export const PLANTILLAS_AVISO_OPERACION = ["pedido_recibido", "pedido_confirmado", "pedido_en_camino", "pedido_listo_para_recoger", "pedido_entregado"] as const;
export type PlantillaAvisoOperacion = (typeof PLANTILLAS_AVISO_OPERACION)[number];

export const SEMAFOROS = ["verde", "amarillo", "rojo"] as const;
export type Semaforo = (typeof SEMAFOROS)[number];

/** Estados de pedido que el panel pinta (subconjunto de `OrderStatus`; los demas se tratan como «otro»). */
export const ESTADOS_PANEL = ["pending", "preparando", "listo_para_recoger", "en_camino", "entregado", "cancelado", "problema"] as const;
export type EstadoPanel = (typeof ESTADOS_PANEL)[number];

/** Acciones que el SERVIDOR declara disponibles por pedido: la web no duplica la maquina de estados, solo pinta botones. */
export const ACCIONES_DISPONIBLES = ["aceptar", "listo", "salio", "entregar", "cancelar", "deshacer_entrega", "marcar_problema"] as const;
export type AccionDisponible = (typeof ACCIONES_DISPONIBLES)[number];

export const MOTIVOS_PROBLEMA_CHOFER = ["no_contesto", "direccion", "rechazo", "otro"] as const;
export type MotivoProblemaChofer = (typeof MOTIVOS_PROBLEMA_CHOFER)[number];

/** Umbrales oficiales de «a tiempo» (decision de Javier): minutos prometidos por canal. */
export const MINUTOS_A_TIEMPO = { domicilio: 65, recoger: 35 } as const;
/** Semaforo: verde hasta el 70 % del tiempo prometido, amarillo hasta el 100 %, rojo despues. «En camino» pasa a rojo a los 90 min. */
export const SEMAFORO_FRACCION_AMARILLO = 0.7;
export const SEMAFORO_EN_CAMINO_ROJO_MIN = 90;
/** Ventana para deshacer una entrega (segundos) y maximo de pedidos por viaje. */
export const VENTANA_DESHACER_ENTREGA_SEG = 60;
export const MAX_PEDIDOS_POR_VIAJE = 6;
export const MAX_ENTREGAS_ACTIVAS_CHOFER = 30;

/** Cabecera de idempotencia: el cliente la genera UNA vez por intento de accion y la reutiliza al reintentar. */
export const CABECERA_IDEMPOTENCIA = "Idempotency-Key";

// ---------------------------------------------------------------------------
// Errores comunes
// ---------------------------------------------------------------------------

/** Codigos de error de negocio de estas rutas (ademas de 400 validation_error, 401, 403, 404 not_found). */
export const CODIGOS_ERROR_OPERACION = [
  "no_implementado",
  "no_disponible",
  "pedido_duplicado_reciente",
  "idempotency_conflict",
  "fuera_de_cobertura",
  "producto_no_disponible",
  "sucursal_cerrada",
  "estado_cambio",
  "usar_despacho",
  "no_despachable",
  "repartidor_no_encontrado",
  "repartidor_no_disponible",
  "no_activo",
  "fuera_de_ventana",
] as const;
export type CodigoErrorOperacion = (typeof CODIGOS_ERROR_OPERACION)[number];

export const esquemaErrorOperacion = objeto({
  code: texto({ min: 1, max: 80 }),
  message: texto({ min: 1, max: 600 }),
  details: opcional(registro(texto({ max: 400 }))),
});
export type ErrorOperacion = Inferir<typeof esquemaErrorOperacion>;

/** Cuerpo de las rutas aun sin backend (HTTP 501). */
export const MENSAJE_NO_IMPLEMENTADO = "No disponible aún: esta función del panel del operador todavía no está activa en el servidor.";

// ---------------------------------------------------------------------------
// 2.1 Captura de pedido por personal  (POST admin/orders, POST admin/orders/cotizar, GET admin/customers/por-telefono)
// ---------------------------------------------------------------------------

const telefonoE164 = texto({ patron: /^\+[1-9]\d{9,14}$/, descripcion: "se esperaba un telefono en formato internacional (+52...)." });

const esquemaClienteCaptura = objeto({
  telefono: telefonoE164,
  nombre: texto({ min: 1, max: 120 }),
  customerId: opcional(nulable(uuid())),
});

const esquemaDireccionCaptura = objeto({
  texto: texto({ min: 3, max: 240 }),
  colonia: opcional(nulable(texto({ max: 120 }))),
  domicilioId: opcional(nulable(uuid())),
  lat: opcional(nulable(numero({ min: -90, max: 90 }))),
  lng: opcional(nulable(numero({ min: -180, max: 180 }))),
});

const esquemaItemCaptura = objeto({
  productId: uuid(),
  cantidad: numero({ min: 1, max: 99, entero: true }),
  modificadores: opcional(arreglo(texto({ min: 1, max: 80 }), { max: 20 })),
  nota: opcional(nulable(texto({ max: 240 }))),
});

const esquemaPagoCaptura = objeto({
  forma: enumerado(FORMAS_PAGO_OPERACION),
  /** Billete con el que paga el cliente (efectivo); debe ser >= total. */
  pagaCon: opcional(nulable(numero({ min: 0, max: 100000 }))),
});

/** El consentimiento es OBLIGATORIO y explicito (`otorgado` true o false): nunca hay valor por omision. */
const esquemaConsentimientoCaptura = objeto({
  otorgado: booleano(),
  via: enumerado(VIAS_CONSENTIMIENTO),
});

const camposCotizacion = {
  propertyId: uuid(),
  canalCaptura: enumerado(CANALES_CAPTURA),
  canal: enumerado(CANALES_PEDIDO_OPERACION),
  cliente: esquemaClienteCaptura,
  direccion: opcional(nulable(esquemaDireccionCaptura)),
  indicacionesEntrega: opcional(nulable(texto({ max: 240 }))),
  items: arreglo(esquemaItemCaptura, { min: 1, max: 60 }),
  programadoPara: opcional(nulable(fechaIso())),
};

/** `POST admin/orders` (roles con `pedidos.capturar`; header `Idempotency-Key` obligatorio). */
export const esquemaCrearPedidoOperador = objeto({
  ...camposCotizacion,
  /** Default `true` en llamadas: un solo mensaje («pedido_confirmado») en vez de recibido + confirmado. */
  confirmarYa: opcional(booleano()),
  pago: esquemaPagoCaptura,
  consentimientoWhatsapp: esquemaConsentimientoCaptura,
  /** Reenviar con `true` tras un 409 `pedido_duplicado_reciente` (mismo telefono + mismos productos < 10 min). */
  forzarDuplicado: opcional(booleano()),
});
export type CrearPedidoOperadorEntrada = Inferir<typeof esquemaCrearPedidoOperador>;

/** `POST admin/orders/cotizar`: el mismo cuerpo SIN consentimiento ni pago. */
export const esquemaCotizarPedidoOperador = objeto(camposCotizacion);
export type CotizarPedidoOperadorEntrada = Inferir<typeof esquemaCotizarPedidoOperador>;

const esquemaCotizacion = objeto({
  subtotal: numero({ min: 0 }),
  envio: numero({ min: 0 }),
  total: numero({ min: 0 }),
  /** `[minimo, maximo]` en minutos. */
  tiempoEstimadoMin: arreglo(numero({ min: 0, entero: true }), { min: 2, max: 2 }),
});
export type CotizacionOperador = Inferir<typeof esquemaCotizacion>;

export const esquemaAvisoCaptura = objeto({
  estado: enumerado(["encolado", "omitido"] as const),
  plantilla: nulable(enumerado(PLANTILLAS_AVISO_OPERACION)),
  motivo: nulable(enumerado(MOTIVOS_AVISO_OMITIDO)),
});
export type AvisoCaptura = Inferir<typeof esquemaAvisoCaptura>;

/** Respuesta 201 (200 + `yaAplicado: true` si es una repeticion idempotente). */
export const esquemaRespuestaCrearPedido = objeto({
  pedido: objeto({
    id: uuid(),
    numero: numero({ min: 0, entero: true }),
    estado: enumerado(ESTADOS_PANEL),
    total: numero({ min: 0 }),
    source: texto({ min: 1, max: 40 }),
    canalCaptura: nulable(enumerado(CANALES_CAPTURA)),
    capturadoPor: nulable(uuid()),
  }),
  cotizacion: esquemaCotizacion,
  aviso: esquemaAvisoCaptura,
  yaAplicado: opcional(booleano()),
});
export type RespuestaCrearPedido = Inferir<typeof esquemaRespuestaCrearPedido>;

export const esquemaRespuestaCotizar = objeto({
  cotizacion: esquemaCotizacion,
  cobertura: objeto({
    dentro: booleano(),
    sucursalAlterna: opcional(nulable(objeto({ nombre: texto({ min: 1, max: 120 }), telefono: texto({ min: 1, max: 40 }) }))),
  }),
});
export type RespuestaCotizar = Inferir<typeof esquemaRespuestaCotizar>;

/** `GET admin/customers/por-telefono?telefono=` — 404 si el cliente no existe. */
export const esquemaRespuestaClientePorTelefono = objeto({
  cliente: objeto({
    id: uuid(),
    nombre: texto({ max: 120 }),
    domicilios: arreglo(objeto({ id: uuid(), texto: texto({ max: 240 }), colonia: nulable(texto({ max: 120 })) }), { max: 10 }),
    ultimoPedido: nulable(objeto({ numero: numero({ entero: true }), creadoEn: fechaIso(), total: numero({ min: 0 }) })),
    gustos: arreglo(texto({ max: 80 }), { max: 10 }),
  }),
});
export type RespuestaClientePorTelefono = Inferir<typeof esquemaRespuestaClientePorTelefono>;

// ---------------------------------------------------------------------------
// 2.2 Despacho atomico («Salio») y acciones del encargado
// ---------------------------------------------------------------------------

/** `POST admin/orders/dispatch` (roles con `viajes.despachar`; `Idempotency-Key`). Lote <= 6 en UNA transaccion. */
export const esquemaDespachoEntrada = objeto({
  pedidos: arreglo(uuid(), { min: 1, max: MAX_PEDIDOS_POR_VIAJE }),
  repartidorId: uuid(),
  desdeEstado: opcional(enumerado(["preparando"] as const)),
  etaMin: numero({ min: 5, max: 240, entero: true }),
  /** Salta la advertencia `repartidor_no_disponible` (chofer marcado fuera de turno). */
  forzar: opcional(booleano()),
});
export type DespachoEntrada = Inferir<typeof esquemaDespachoEntrada>;

export const esquemaDespachoResultado = objeto({
  pedidoId: uuid(),
  resultado: enumerado(["despachado", "ya_aplicado", "reasignado"] as const),
  estado: enumerado(ESTADOS_PANEL),
  /** `null` contra una base sin migrar (090 ausente). */
  salioAt: nulable(fechaIso()),
  repartidorId: uuid(),
  /** `encolado`, `ya_enviado` u `omitido:<motivo>` (motivo de `MOTIVOS_AVISO_OMITIDO`). */
  aviso: texto({ patron: /^(encolado|ya_enviado|omitido:[a-z_]+)$/, descripcion: "se esperaba encolado, ya_enviado u omitido:<motivo>." }),
});
export const esquemaDespachoSalida = objeto({ resultados: arreglo(esquemaDespachoResultado, { min: 1, max: MAX_PEDIDOS_POR_VIAJE }) });
export type DespachoSalida = Inferir<typeof esquemaDespachoSalida>;

/** `POST admin/orders/:id/listo` — domicilio: solo marca `listo_at`; recoger: pasa a `listo_para_recoger` + aviso. */
export const esquemaListoSalida = objeto({ yaAplicado: booleano(), listoAt: nulable(fechaIso()) });
export type ListoSalida = Inferir<typeof esquemaListoSalida>;

const esquemaTarjetaPedido = objeto({
  id: uuid(),
  numero: numero({ min: 0, entero: true }),
  estado: enumerado(ESTADOS_PANEL),
  canal: enumerado(CANALES_PEDIDO_OPERACION),
  /** `canal_captura` si lo capturo personal; si no, el `source` (whatsapp | voice | web). */
  origen: texto({ min: 1, max: 40 }),
  clienteNombre: texto({ max: 120 }),
  resumenItems: texto({ max: 240 }),
  total: numero({ min: 0 }),
  creadoEn: fechaIso(),
  aceptadoEn: nulable(fechaIso()),
  listoAt: nulable(fechaIso()),
  salioAt: nulable(fechaIso()),
  minutos: numero({ min: 0 }),
  semaforo: enumerado(SEMAFOROS),
  repartidorId: nulable(uuid()),
  /** `true` si el cliente quedo sin aviso (el panel muestra «Sin aviso: llamar»). */
  sinAviso: booleano(),
  /** Cobro (todos opcionales: una base sin migrar los omite o los manda en null). `paga_con` solo aplica a efectivo; `cobrado` = el chofer ya marco «cobrado». */
  pago: opcional(objeto({
    forma: nulable(enumerado(FORMAS_PAGO_OPERACION)),
    pagaCon: opcional(nulable(numero({ min: 0 }))),
    totalACobrar: numero({ min: 0 }),
    cobrado: booleano(),
    cobradoMonto: opcional(nulable(numero({ min: 0 }))),
  })),
  accionesDisponibles: arreglo(enumerado(ACCIONES_DISPONIBLES), { max: 10 }),
});
export type TarjetaPedido = Inferir<typeof esquemaTarjetaPedido>;

/** `GET admin/operacion/cola?propertyId=&desde=` — la cola de la pantalla inicial (pedidos activos del dia). Sin `notes` ni telefonos. */
export const esquemaColaSalida = objeto({
  pedidos: arreglo(esquemaTarjetaPedido, { max: 200 }),
  conteos: registro(numero({ min: 0, entero: true })),
  actualizadoEn: fechaIso(),
});
export type ColaSalida = Inferir<typeof esquemaColaSalida>;

/** `GET admin/operacion/viajes?propertyId=&desde=`. */
export const esquemaViajesSalida = objeto({
  porSalir: arreglo(esquemaTarjetaPedido, { max: 100 }),
  enCamino: arreglo(esquemaTarjetaPedido, { max: 100 }),
  recientes: arreglo(esquemaTarjetaPedido, { max: 20 }),
  repartidores: arreglo(
    objeto({
      id: uuid(),
      nombre: texto({ max: 120 }),
      activos: numero({ min: 0, entero: true }),
      disponible: booleano(),
      sugerido: booleano(),
    }),
    { max: 50 },
  ),
  actualizadoEn: fechaIso(),
});
export type ViajesSalida = Inferir<typeof esquemaViajesSalida>;

/** El `PATCH admin/orders/:id/status` existente se endurece: rechaza `en_camino` con 422 `usar_despacho`; sigue devolviendo `{ order }` y suma `yaAplicado`. */
export const esquemaEstadoPatchExtra = objeto({ yaAplicado: opcional(booleano()) });

// ---------------------------------------------------------------------------
// 2.3 Chofer
// ---------------------------------------------------------------------------

/** Una entrega ACTIVA del chofer. Sin telefono y sin `notes` libres (las indicaciones son un campo estructurado). */
export const esquemaEntregaChofer = objeto({
  id: uuid(),
  numero: numero({ min: 0, entero: true }),
  estado: enumerado(["en_camino", "entregado", "problema"] as const),
  clienteNombre: texto({ max: 120 }),
  direccion: objeto({ texto: texto({ max: 240 }), colonia: nulable(texto({ max: 120 })) }),
  indicaciones: nulable(texto({ max: 240 })),
  total: numero({ min: 0 }),
  pago: objeto({ forma: nulable(enumerado(FORMAS_PAGO_OPERACION)), pagaCon: nulable(numero({ min: 0 })) }),
  /** «N piezas» + lista para verificar que va completo. */
  resumenItems: texto({ max: 240 }),
  totalPiezas: numero({ min: 0, entero: true }),
  salioAt: nulable(fechaIso()),
  etaAt: nulable(fechaIso()),
  minutos: numero({ min: 0 }),
  semaforo: enumerado(SEMAFOROS),
  /** Solo en un pedido recien entregado: hasta cuando puede deshacerse (60 s). */
  puedeDeshacerHasta: opcional(nulable(fechaIso())),
});
export type EntregaChofer = Inferir<typeof esquemaEntregaChofer>;

/** `GET repartidor/entregas` — ruta nueva (no `repartidor/orders/...`, donde `:orderId` taparia el nombre) para no cambiar la forma del `GET repartidor/orders` vigente que usa la UI vieja. Solo activas, max 30. */
export const esquemaEntregasChoferSalida = objeto({
  entregas: arreglo(esquemaEntregaChofer, { max: MAX_ENTREGAS_ACTIVAS_CHOFER }),
  actualizadoEn: fechaIso(),
});
export type EntregasChoferSalida = Inferir<typeof esquemaEntregasChoferSalida>;

/** `POST repartidor/orders/:id/entregar`. `cobradoMonto` es opcional (efectivo cobrado). */
export const esquemaEntregarEntrada = objeto({
  cobradoMonto: opcional(nulable(numero({ min: 0, max: 100000 }))),
  desdeEstado: opcional(enumerado(["en_camino"] as const)),
});
export type EntregarEntrada = Inferir<typeof esquemaEntregarEntrada>;

export const esquemaEntregarSalida = objeto({
  resultado: enumerado(["entregado", "ya_aplicado"] as const),
  entregadoAt: fechaIso(),
  puedeDeshacerHasta: fechaIso(),
});
export type EntregarSalida = Inferir<typeof esquemaEntregarSalida>;

/** `POST repartidor/orders/:id/deshacer-entrega` — sin cuerpo; 409 `fuera_de_ventana` pasados los 60 s. */
export const esquemaDeshacerEntregaSalida = objeto({
  resultado: enumerado(["deshecho", "ya_aplicado"] as const),
  estado: enumerado(["en_camino"] as const),
  /** `true` si el aviso de «entregado» ya habia salido: se permite deshacer pero NO se reenvia nada. */
  avisoYaEnviado: booleano(),
});
export type DeshacerEntregaSalida = Inferir<typeof esquemaDeshacerEntregaSalida>;

/** `POST repartidor/orders/:id/problema`. */
export const esquemaProblemaEntrada = objeto({
  motivo: enumerado(MOTIVOS_PROBLEMA_CHOFER),
  nota: opcional(nulable(texto({ max: 500 }))),
});
export type ProblemaEntrada = Inferir<typeof esquemaProblemaEntrada>;
export const esquemaProblemaSalida = objeto({ resultado: enumerado(["problema", "ya_aplicado"] as const), estado: enumerado(["problema"] as const) });
export type ProblemaSalida = Inferir<typeof esquemaProblemaSalida>;

/** `POST repartidor/orders/:id/llamar` — pide el telefono (auditado como evento `chofer_llamo`, max 5 por pedido). */
export const esquemaLlamarSalida = objeto({ telefono: telefonoE164 });
export type LlamarSalida = Inferir<typeof esquemaLlamarSalida>;

/** `GET repartidor/hoy` — solo lo suyo. */
export const esquemaHoyChoferSalida = objeto({
  entregasHoy: numero({ min: 0, entero: true }),
  enCamino: numero({ min: 0, entero: true }),
  /** `null` si la base aun no guarda forma de pago / cobrado (090 ausente). */
  efectivoPorEntregar: nulable(numero({ min: 0 })),
});
export type HoyChoferSalida = Inferir<typeof esquemaHoyChoferSalida>;

// ---------------------------------------------------------------------------
// 2.5 Panel «Hoy» (turno)
// ---------------------------------------------------------------------------

export const TURNOS_HOY = ["actual", "dia"] as const;
export type TurnoHoy = (typeof TURNOS_HOY)[number];

/** Campos de tiempo en `null` cuando la base no esta migrada: la UI dice «disponible tras actualizar». */
export const esquemaOperacionHoy = objeto({
  corte: objeto({ desde: fechaIso(), hasta: fechaIso() }),
  pedidos: objeto({ total: numero({ min: 0, entero: true }), porEstado: registro(numero({ min: 0, entero: true })) }),
  ventas: numero({ min: 0 }),
  ticketPromedio: numero({ min: 0 }),
  puntuales: objeto({
    pct: nulable(numero({ min: 0, max: 100 })),
    evaluados: numero({ min: 0, entero: true }),
    umbralMin: objeto({ domicilio: numero({ min: 1 }), recoger: numero({ min: 1 }) }),
  }),
  tiempos: objeto({
    preparacionMinProm: nulable(numero({ min: 0 })),
    entregaMinProm: nulable(numero({ min: 0 })),
    entregaMinP90: nulable(numero({ min: 0 })),
    sinDato: opcional(numero({ min: 0, entero: true })),
  }),
  cancelados: objeto({ total: numero({ min: 0, entero: true }), porMotivo: registro(numero({ min: 0, entero: true })) }),
  porCanal: registro(numero({ min: 0, entero: true })),
  alertas: objeto({
    sinAceptar: arreglo(objeto({ pedidoId: uuid(), numero: numero({ entero: true }), minutos: numero({ min: 0 }) }), { max: 100 }),
    enCaminoMas90: arreglo(objeto({ pedidoId: uuid(), numero: numero({ entero: true }), minutos: numero({ min: 0 }) }), { max: 100 }),
  }),
  efectivoPorChofer: objeto({
    disponible: booleano(),
    choferes: arreglo(objeto({ repartidorId: uuid(), nombre: texto({ max: 120 }), entregas: numero({ min: 0, entero: true }), efectivoPorEntregar: numero({ min: 0 }) }), { max: 50 }),
  }),
  actualizadoEn: fechaIso(),
});
export type OperacionHoy = Inferir<typeof esquemaOperacionHoy>;

// ---------------------------------------------------------------------------
// Rutas (un solo lugar para que API, SPA y mock no escriban cadenas a mano)
// ---------------------------------------------------------------------------

const BASE = "/v1/restaurantes/:propertyId";
export const RUTAS_OPERACION = {
  capturarPedido: { metodo: "POST", patron: `${BASE}/admin/orders` },
  cotizarPedido: { metodo: "POST", patron: `${BASE}/admin/orders/cotizar` },
  clientePorTelefono: { metodo: "GET", patron: `${BASE}/admin/customers/por-telefono` },
  cola: { metodo: "GET", patron: `${BASE}/admin/operacion/cola` },
  despachar: { metodo: "POST", patron: `${BASE}/admin/orders/dispatch` },
  marcarListo: { metodo: "POST", patron: `${BASE}/admin/orders/:orderId/listo` },
  viajes: { metodo: "GET", patron: `${BASE}/admin/operacion/viajes` },
  hoy: { metodo: "GET", patron: `${BASE}/admin/operacion/hoy` },
  entregasChofer: { metodo: "GET", patron: `${BASE}/repartidor/entregas` },
  entregar: { metodo: "POST", patron: `${BASE}/repartidor/orders/:orderId/entregar` },
  deshacerEntrega: { metodo: "POST", patron: `${BASE}/repartidor/orders/:orderId/deshacer-entrega` },
  problema: { metodo: "POST", patron: `${BASE}/repartidor/orders/:orderId/problema` },
  llamar: { metodo: "POST", patron: `${BASE}/repartidor/orders/:orderId/llamar` },
  hoyChofer: { metodo: "GET", patron: `${BASE}/repartidor/hoy` },
} as const;
export type NombreRutaOperacion = keyof typeof RUTAS_OPERACION;
