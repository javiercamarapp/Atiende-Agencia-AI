// "Mundo" simulado del arnes: implementa las herramientas del registro unico (`agent-tools/registry.ts`, mismos
// nombres y misma forma "wire") sobre los fixtures de los casos dorados (menu provisional de PM, zonas inventadas
// solo para el arnes, clientes conocidos, fallas inyectadas). Replica las reglas duras del servidor (minimo de
// $200, alcohol a domicilio, zona, regional, multiplos de "orden de N", tortilla, maquina de estados
// cotizado -> confirmado -> creado) para poder medir al agente sin LLM real ni base de datos.
//
// `capacidades` marca lo que el servidor REAL todavia no tiene (PR-3 tortilla mixta, PR-4 promociones
// automaticas): con `contratoObjetivo` el mundo se comporta como lo pide el set dorado; con `contratoActual`
// se comporta como el registro de hoy (rechaza "mixta", no aplica promociones).
import { readFileSync } from "node:fs";
import type { CasoEval, ClienteConocido, ComandaRegistrada, EventoTraza, FixturesExtra, ProductoMenu, SuiteEval } from "./tipos.ts";

export interface CapacidadesMundo {
  /** Tortilla "mixta" aceptada (hoy el registro solo admite maiz/harina: PR-3). */
  readonly tortillaMixta: boolean;
  /** Promociones (lunes 2x1 pastor, martes nachos + 2 aguas) aplicadas por la cotizacion solo en recoger (PR-4). */
  readonly promociones: boolean;
}
export const CONTRATO_OBJETIVO: CapacidadesMundo = { tortillaMixta: true, promociones: true };
export const CONTRATO_ACTUAL: CapacidadesMundo = { tortillaMixta: false, promociones: false };

export const MINIMO_DOMICILIO = 200;

/** Nombres de las herramientas del registro unico (nunca los del prompt del experto). */
export const HERRAMIENTAS_REGISTRO = [
  "buscar_cliente",
  "historial_pedidos",
  "repetir_pedido",
  "consultar_sucursal",
  "buscar_sucursal_cercana",
  "buscar_producto",
  "cotizar_pedido",
  "confirmar_resumen",
  "crear_pedido",
  "registrar_contacto",
  "escalar_a_humano",
] as const;

const AQUI = new URL("./", import.meta.url);
export function cargarSuite(): SuiteEval {
  return JSON.parse(readFileSync(new URL("casos.json", AQUI), "utf8")) as SuiteEval;
}
export function cargarMenu(): readonly ProductoMenu[] {
  return (JSON.parse(readFileSync(new URL("menu-pm.json", AQUI), "utf8")) as { productos: ProductoMenu[] }).productos;
}

export function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9$ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singular(w: string): string {
  return w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;
}

const SIN_VALOR = new Set(["de", "del", "la", "el", "los", "las", "al", "un", "una", "con", "y", "para", "por", "quiero", "orden", "ordenes"]);

function tokens(s: string): string[] {
  return normalizar(s)
    .split(" ")
    .filter((w) => w && !SIN_VALOR.has(w))
    .map(singular);
}

export const SUCURSAL_POR_SLUG = (slug: string): string => slug.toUpperCase();
const slugDe = (t: string): string => t.toLowerCase();

interface LineaCotizada {
  readonly producto: ProductoMenu;
  readonly productId: string;
  readonly piezas: number;
  readonly cantidad: number;
  readonly tortilla: string | null;
  readonly lineTotal: number;
}

interface CotizacionVigente {
  readonly hash: string;
  readonly turnoCliente: number;
  readonly sucursal: string;
  readonly canal: "domicilio" | "recoger";
  readonly lineas: readonly LineaCotizada[];
  readonly total: number;
  readonly promoId: string | null;
  readonly cortesias: readonly string[];
  readonly colonia: string | null;
}

export class Mundo {
  readonly eventos: EventoTraza[] = [];
  readonly comandas: ComandaRegistrada[] = [];
  readonly escalaciones: { readonly motivo: string; readonly resumen: string }[] = [];
  readonly herramientasInvalidas: string[] = [];
  turnoCliente = 0;
  private estado: "ninguno" | "cotizado" | "confirmado" | "creado" = "ninguno";
  private cotizacion: CotizacionVigente | null = null;
  private ordenCreada: ComandaRegistrada | null = null;
  readonly fixtures: FixturesExtra;
  readonly zonas: Readonly<Record<string, string>>;
  readonly telefono: string;
  readonly menu: readonly ProductoMenu[];
  private readonly sucursales: Readonly<Record<string, { nombre: string; menu: "grande" | "chico" }>>;

  constructor(
    readonly caso: CasoEval,
    suite: SuiteEval = cargarSuite(),
    menu: readonly ProductoMenu[] = cargarMenu(),
    readonly capacidades: CapacidadesMundo = CONTRATO_OBJETIVO,
  ) {
    this.fixtures = caso.contexto.fixtures_extra ?? {};
    this.zonas = { ...suite.fixtures.asignar_sucursal, ...(this.fixtures.asignar_sucursal ?? {}) };
    this.sucursales = suite.fixtures.sucursales;
    this.menu = menu;
    const datos = caso.simulador_cliente.datos;
    this.telefono = (datos.telefono_normalizado ?? datos.telefono ?? caso.contexto.cliente_conocido?.telefono ?? "").replace(/\D/g, "");
  }

  /** Direccion guardada (completa) del cliente conocido: el agente NUNCA debe leerla (G_REGLA_R11). */
  static direccionGuardada(cliente: ClienteConocido): string | null {
    return cliente.colonia_guardada ? `Calle 21 número 123, ${cliente.colonia_guardada}` : null;
  }

  sucursalNombre(t: string): string {
    return this.sucursales[t.toUpperCase()]?.nombre ?? t;
  }

  // ---- registro de la traza ----
  cliente(texto: string): void {
    this.turnoCliente += 1;
    this.eventos.push({ tipo: "cliente", texto });
  }
  agente(texto: string): void {
    this.eventos.push({ tipo: "agente", texto });
  }

  /** Ejecuta una herramienta del registro y la deja en la traza. Nunca lanza: los errores son `{error}` como en WhatsApp. */
  ejecutar(nombre: string, args: Readonly<Record<string, unknown>>): unknown {
    let resultado: unknown;
    if (!(HERRAMIENTAS_REGISTRO as readonly string[]).includes(nombre)) {
      this.herramientasInvalidas.push(nombre);
      resultado = { error: `Herramienta desconocida: ${nombre}` };
    } else {
      try {
        resultado = this.despachar(nombre, args);
      } catch (err) {
        resultado = { error: err instanceof ErrorNegocio ? err.message : "Error interno al ejecutar la herramienta" };
      }
    }
    this.eventos.push({ tipo: "herramienta", nombre, args, resultado, turnoCliente: this.turnoCliente });
    return resultado;
  }

  private despachar(nombre: string, args: Readonly<Record<string, unknown>>): unknown {
    switch (nombre) {
      case "buscar_cliente":
        return this.buscarCliente();
      case "historial_pedidos":
        return this.historialPedidos();
      case "repetir_pedido":
        return this.repetirPedido(args);
      case "consultar_sucursal":
        return this.consultarSucursal(String(args.branch_slug ?? ""));
      case "buscar_sucursal_cercana":
        return this.buscarSucursalCercana(String(args.colonia ?? ""));
      case "buscar_producto":
        return this.buscarProducto(String(args.query ?? ""), String(args.branch_slug ?? ""));
      case "cotizar_pedido":
        return this.cotizar(args);
      case "confirmar_resumen":
        return this.confirmar(args);
      case "crear_pedido":
        return this.crear(args);
      case "registrar_contacto":
        return { ok: true };
      case "escalar_a_humano":
        return this.escalar(args);
      default:
        throw new ErrorNegocio(`Herramienta desconocida: ${nombre}`);
    }
  }

  // ---- herramientas ----
  private buscarCliente(): unknown {
    const c = this.caso.contexto.cliente_conocido;
    if (!c || c.telefono.replace(/\D/g, "") !== this.telefono) return { isNew: true };
    const direccion = Mundo.direccionGuardada(c);
    return {
      isNew: false,
      name: c.nombre,
      orderCount: 3,
      tier: "regular",
      addresses: direccion ? [{ address: direccion, isDefault: true }] : [],
      frequentItems: c.ultimo_pedido.map((i) => ({ name: i.producto })),
      lastOrderItems: c.ultimo_pedido.map((i) => ({ name: i.producto, quantity: i.piezas })),
    };
  }

  /** Pedidos anteriores del cliente conocido (Cliente 360): en este arnes solo se conoce el ultimo pedido. */
  private historialPedidos(): unknown {
    const c = this.caso.contexto.cliente_conocido;
    if (!c || c.telefono.replace(/\D/g, "") !== this.telefono) return { pedidos: [], total_pedidos_anteriores: 0 };
    return {
      pedidos: [{ numero: 1, fecha: "la ultima vez", canal: null, sucursal: null, total: null, productos: c.ultimo_pedido.map((i) => ({ name: i.producto, quantity: i.piezas })) }],
      total_pedidos_anteriores: 1,
    };
  }

  /** "Lo mismo de la vez pasada": vuelve a cotizar el ultimo pedido con los precios y la disponibilidad de HOY. */
  private repetirPedido(args: Readonly<Record<string, unknown>>): unknown {
    const c = this.caso.contexto.cliente_conocido;
    if (!c || c.telefono.replace(/\D/g, "") !== this.telefono) throw new ErrorNegocio("Este cliente todavía no tiene pedidos anteriores que repetir.");
    const sucursal = SUCURSAL_POR_SLUG(String(args.branch_slug ?? ""));
    const cambios: { producto: string; motivo: "ya_no_disponible" }[] = [];
    const items: Record<string, unknown>[] = [];
    for (const previo of c.ultimo_pedido) {
      const producto = this.menu.find((p) => normalizar(p.nombre) === normalizar(previo.producto));
      if (!producto || !this.disponibleEn(producto, sucursal)) {
        cambios.push({ producto: previo.producto, motivo: "ya_no_disponible" });
        continue;
      }
      items.push({ product_id: this.idDe(producto), product_name: producto.nombre, requested_quantity: previo.piezas, ...(typeof args.tortilla === "string" ? { tortilla: args.tortilla } : {}) });
    }
    if (items.length === 0) throw new ErrorNegocio("Ninguno de los productos de ese pedido está disponible hoy en esa sucursal.");
    const cotizado = this.cotizar({ ...args, items }) as Record<string, unknown>;
    return { ...cotizado, repeticion: { pedido_numero: 1, cambios } };
  }

  private consultarSucursal(slug: string): unknown {
    const s = this.sucursales[SUCURSAL_POR_SLUG(slug)];
    if (!s) throw new ErrorNegocio(`Sucursal '${slug}' no encontrada o inactiva`);
    return { branch_slug: slug, branch_name: s.nombre, abierto_ahora: true, horario: "12:00-01:00", pedido_minimo_domicilio: MINIMO_DOMICILIO, pedido_minimo_recoger: null };
  }

  /** Estado de zona de una colonia segun los fixtures: sucursal asignada, "fuera_de_zona" o "no_reconocida". */
  estadoZona(colonia: string): string {
    const q = normalizar(colonia);
    if (!q) return "no_reconocida";
    let mejor: { clave: string; valor: string } | null = null;
    for (const [clave, valor] of Object.entries(this.zonas)) {
      const k = normalizar(clave);
      if (q.includes(k) || k.includes(q)) {
        if (!mejor || k.length > normalizar(mejor.clave).length) mejor = { clave, valor };
      }
    }
    return mejor ? mejor.valor : "no_reconocida";
  }

  private buscarSucursalCercana(colonia: string): unknown {
    const zona = this.estadoZona(colonia);
    if (zona === "no_reconocida") return { encontrada: false, mensaje: "No reconozco esa colonia; pida otra referencia." };
    // `fuera_de_zona`: existe una sucursal cercana, pero NO reparte ahi; lo rechaza cotizar_pedido (como el servidor real).
    const t = zona === "fuera_de_zona" ? this.caso.contexto.sucursal_contexto : zona;
    return { encontrada: true, branch_slug: slugDe(t), branch_name: this.sucursales[t]?.nombre ?? t, distancia_km: 3.2, colonia_reconocida: colonia };
  }

  private disponibleEn(p: ProductoMenu, sucursal: string): boolean {
    if (p.regional && this.sucursales[sucursal]?.menu !== "grande") return false;
    return !(this.fixtures.producto_agotado ?? []).some((x) => normalizar(x) === normalizar(`${p.nombre}@${sucursal}`));
  }

  private idDe(p: ProductoMenu): string {
    return `p_${this.menu.indexOf(p)}`;
  }

  private buscarProducto(query: string, slug: string): unknown {
    const sucursal = SUCURSAL_POR_SLUG(slug);
    if (!this.sucursales[sucursal]) throw new ErrorNegocio(`Sucursal '${slug}' no encontrada`);
    const q = tokens(query).map((t) => (t === "kilo" || t === "kg" ? "kg" : t));
    if (q.length === 0) return [];
    const resultados = this.menu.filter((p) => {
      if (!this.disponibleEn(p, sucursal)) return false;
      const hay = new Set(tokens(`${p.nombre} ${p.categoria}`).map((t) => (t === "kilo" ? "kg" : t)));
      return q.every((t) => hay.has(t));
    });
    return resultados.slice(0, 8).map((p) => ({ id: this.idDe(p), name: p.nombre, price: p.precio_mxn, pack_size: p.pack_size, requires_adult_confirmation: p.es_alcohol }));
  }

  private resolverItems(sucursal: string, canal: "domicilio" | "recoger", items: unknown, adultConfirmed: boolean): LineaCotizada[] {
    if (!Array.isArray(items) || items.length === 0) throw new ErrorNegocio("El pedido no tiene productos");
    return items.map((raw) => {
      const it = (raw ?? {}) as Record<string, unknown>;
      const producto = this.menu.find((p) => this.idDe(p) === it.product_id) ?? this.menu.find((p) => typeof it.product_name === "string" && normalizar(p.nombre) === normalizar(it.product_name));
      const piezas = typeof it.requested_quantity === "number" ? it.requested_quantity : Number(it.requested_quantity);
      if (!producto || !Number.isInteger(piezas) || piezas < 1) throw new ErrorNegocio("Productos o cantidades inválidos");
      if (!this.disponibleEn(producto, sucursal)) throw new ErrorNegocio(`Producto no disponible: ${String(it.product_id ?? it.product_name)}`);
      if (producto.es_alcohol && canal === "domicilio") {
        throw new ErrorNegocio(`${producto.nombre} no se vende a domicilio. Quítelo del pedido o cambie el pedido a recoger en sucursal.`);
      }
      if (producto.es_alcohol && !adultConfirmed) {
        throw new ErrorNegocio(`Antes de cotizar ${producto.nombre}, confirma de forma explícita que quien recibe el pedido es mayor de edad.`);
      }
      const tortillas = this.capacidades.tortillaMixta ? ["maiz", "harina", "mixta"] : ["maiz", "harina"];
      if (it.tortilla !== undefined && !tortillas.includes(String(it.tortilla))) {
        throw new ErrorNegocio(`Tortilla inválida para ${producto.nombre}: elige maíz o harina.`);
      }
      const llevaTortilla = /\btacos?\b/i.test(producto.nombre);
      if (llevaTortilla && !it.tortilla) throw new ErrorNegocio(`Antes de continuar, confirma si ${producto.nombre} va con tortilla de maíz o harina.`);
      if (producto.pack_size > 1 && piezas % producto.pack_size !== 0) {
        const bajo = Math.floor(piezas / producto.pack_size) * producto.pack_size;
        const alto = Math.ceil(piezas / producto.pack_size) * producto.pack_size;
        throw new ErrorNegocio(`${producto.nombre} solo se vende en órdenes de ${producto.pack_size} piezas. Pediste ${piezas}; puedes pedir ${bajo >= producto.pack_size ? `${bajo} o ${alto}` : alto}.`);
      }
      const cantidad = producto.pack_size > 1 ? piezas / producto.pack_size : piezas;
      return { producto, productId: this.idDe(producto), piezas, cantidad, tortilla: llevaTortilla ? String(it.tortilla) : null, lineTotal: producto.precio_mxn * cantidad };
    });
  }

  private promociones(canal: "domicilio" | "recoger", lineas: readonly LineaCotizada[], cortesiasPedidas: readonly string[]): { descuento: number; promoId: string | null; cortesias: readonly string[] } {
    if (!this.capacidades.promociones || canal !== "recoger") return { descuento: 0, promoId: null, cortesias: [] };
    const dia = normalizar(this.caso.contexto.dia);
    if (dia === "lunes") {
      const tacos = lineas.find((l) => l.producto.nombre === "Taco Al Pastor (individual)");
      if (tacos) return { descuento: tacos.lineTotal - Math.ceil(tacos.piezas / 2) * tacos.producto.precio_mxn, promoId: "PROMO-LUN", cortesias: [] };
    }
    if (dia === "martes" && lineas.some((l) => l.producto.nombre === "Nachos de Pastor")) {
      const aguas = this.menu.filter((p) => normalizar(p.categoria).includes("agua")).map((p) => p.nombre);
      const validas = cortesiasPedidas.filter((n) => aguas.some((a) => normalizar(a) === normalizar(n)));
      return { descuento: 0, promoId: "PROMO-MAR", cortesias: validas.slice(0, 2) };
    }
    return { descuento: 0, promoId: null, cortesias: [] };
  }

  private cotizar(args: Readonly<Record<string, unknown>>): unknown {
    const slug = String(args.branch_slug ?? "");
    const sucursal = SUCURSAL_POR_SLUG(slug);
    if (!this.sucursales[sucursal]) throw new ErrorNegocio(`Sucursal '${slug}' no encontrada`);
    if (args.canal !== undefined && args.canal !== "domicilio" && args.canal !== "recoger") throw new ErrorNegocio("El canal del pedido debe ser 'domicilio' o 'recoger'.");
    const canal: "domicilio" | "recoger" = args.canal === "recoger" ? "recoger" : "domicilio";
    const lineas = this.resolverItems(sucursal, canal, args.items, args.adult_confirmed === true);
    const subtotal = lineas.reduce((a, l) => a + l.lineTotal, 0);
    if (canal === "domicilio" && subtotal < MINIMO_DOMICILIO) {
      throw new ErrorNegocio(
        `El pedido mínimo a domicilio en ${this.sucursales[sucursal]!.nombre} es de $${MINIMO_DOMICILIO}. El pedido suma $${subtotal}; faltan $${MINIMO_DOMICILIO - subtotal} para alcanzarlo. No se puede registrar por debajo del mínimo: ofrezca agregar productos o pasar a recoger.`,
      );
    }
    const colonia = typeof args.colonia_entrega === "string" ? args.colonia_entrega.trim() : "";
    if (canal === "domicilio") {
      if (!colonia) throw new ErrorNegocio(`La sucursal ${this.sucursales[sucursal]!.nombre} solo entrega en zonas de cobertura: pida la colonia o zona del cliente para verificarla antes de continuar.`);
      const zona = this.estadoZona(colonia);
      if (zona === "fuera_de_zona") {
        throw new ErrorNegocio(`${colonia} está fuera de la zona de reparto de ${this.sucursales[sucursal]!.nombre}: no se puede enviar el pedido a domicilio desde esta sucursal. Ofrezca recoger en sucursal o, si corresponde, otra sucursal.`);
      }
      if (zona === "no_reconocida") throw new ErrorNegocio("No se pudo verificar esa colonia: pida otra referencia.");
      if (zona !== sucursal) throw new ErrorNegocio(`${colonia} corresponde a la sucursal ${this.sucursales[zona]?.nombre ?? zona}: no se puede enviar desde ${this.sucursales[sucursal]!.nombre}.`);
    }
    const cortesiasPedidas = Array.isArray(args.cortesias) ? (args.cortesias as unknown[]).map(String) : [];
    const promo = this.promociones(canal, lineas, cortesiasPedidas);
    const total = subtotal - promo.descuento;
    const hash = JSON.stringify({ sucursal, canal, items: lineas.map((l) => [l.productId, l.piezas, l.tortilla]), cortesias: promo.cortesias });
    this.cotizacion = { hash, turnoCliente: this.turnoCliente, sucursal, canal, lineas, total, promoId: promo.promoId, cortesias: promo.cortesias, colonia: colonia || null };
    this.estado = "cotizado";
    return {
      quote: {
        lines: lineas.map((l) => ({ product_id: l.productId, name: l.producto.nombre, price: l.producto.precio_mxn, requested_quantity: l.piezas, pack_size: l.producto.pack_size, quantity: l.cantidad, tortilla: l.tortilla, requires_adult_confirmation: l.producto.es_alcohol, line_total: l.lineTotal })),
        total,
        contains_alcohol: lineas.some((l) => l.producto.es_alcohol),
        canal,
        pedido_minimo: canal === "domicilio" ? MINIMO_DOMICILIO : null,
        propina_politica: "solo_tarjeta",
        preguntar_propina: args.payment_method === "tarjeta",
        abierto_ahora: true,
        ...(promo.promoId ? { promo_id: promo.promoId, descuento: promo.descuento, cortesias: promo.cortesias } : {}),
        ...(this.capacidades.promociones && canal === "recoger" && promo.promoId === "PROMO-MAR" && promo.cortesias.length < 2 ? { cortesias_pendientes: 2 - promo.cortesias.length } : {}),
      },
      quote_hash: hash.length > 24 ? `h${hash.length}-${hash.slice(2, 22)}` : hash,
    };
  }

  private confirmar(_args: Readonly<Record<string, unknown>>): unknown {
    if (this.estado === "creado") return { confirmado: true, aviso: "el pedido ya fue creado" };
    if (!this.cotizacion) throw new ErrorNegocio("Antes de confirmar hace falta cotizar el pedido (cotizar_pedido).");
    if (this.cotizacion.turnoCliente === this.turnoCliente) {
      throw new ErrorNegocio("El cliente todavía no confirmó: repítale el resumen y espere su sí en un mensaje posterior.");
    }
    this.estado = "confirmado";
    return { confirmado: true, quote_hash: this.cotizacion.hash };
  }

  private crear(args: Readonly<Record<string, unknown>>): unknown {
    if (this.estado === "creado" && this.ordenCreada) throw new ErrorNegocio("El pedido de esta conversación ya fue creado; no se vuelve a crear.");
    if (this.estado !== "confirmado" || !this.cotizacion) throw new ErrorNegocio("Antes de crear el pedido hace falta cotizar (cotizar_pedido) y confirmar con el cliente (confirmar_resumen).");
    const q = this.cotizacion;
    const slug = String(args.branch_slug ?? "");
    const canal: "domicilio" | "recoger" = args.canal === "recoger" ? "recoger" : "domicilio";
    const lineas = this.resolverItems(SUCURSAL_POR_SLUG(slug), canal, args.items, args.adult_confirmed === true);
    const hash = JSON.stringify({ sucursal: SUCURSAL_POR_SLUG(slug), canal, items: lineas.map((l) => [l.productId, l.piezas, l.tortilla]), cortesias: q.cortesias });
    if (hash !== q.hash) throw new ErrorNegocio("Los productos del pedido no coinciden con la última cotización confirmada: vuelva a cotizar y a pedir confirmación.");
    if (this.fixtures.crear_comanda === "error_500_siempre") throw new Error("500");
    if (this.fixtures.crear_comanda === "timeout_siempre") throw new ErrorNegocio("Tiempo de espera agotado al crear el pedido.");
    const pago = args.payment_method === "tarjeta" ? "tarjeta" : "efectivo";
    const notas = typeof args.notes === "string" ? args.notes : null;
    const comanda: ComandaRegistrada = {
      orderId: `ord_${this.comandas.length + 1}`,
      tipo: canal,
      sucursal: SUCURSAL_POR_SLUG(slug),
      pago,
      nombre: String(args.customer_name ?? ""),
      telefono: this.telefono,
      items: lineas.map((l) => ({ producto: l.producto.nombre, piezas: l.piezas })),
      ajustes: ajustesDeNotas(notas),
      tortilla: lineas.find((l) => l.tortilla)?.tortilla ?? null,
      promoId: q.promoId,
      cortesias: q.cortesias,
      propina: pago === "tarjeta" ? "en_terminal" : "no_aplica",
      horaRecogerMin: canal === "recoger" ? minutosDeRecogida(args, this.caso.contexto.hora_local) : null,
      totalMxn: q.total,
      colonia: typeof args.colonia_entrega === "string" ? args.colonia_entrega : null,
      direccion: typeof args.customer_address === "string" ? args.customer_address : null,
      notas,
    };
    this.comandas.push(comanda);
    this.ordenCreada = comanda;
    this.estado = "creado";
    return {
      order: { id: comanda.orderId, branch: this.sucursales[comanda.sucursal]?.nombre, total: q.total, status: "pending", payment_method: pago, items: comanda.items },
      comanda: { estado: "pendiente_de_confirmar", folio: null, mensaje: "Su pedido quedo registrado y la sucursal lo esta capturando; le llamamos si hay cualquier detalle." },
    };
  }

  private escalar(args: Readonly<Record<string, unknown>>): unknown {
    this.escalaciones.push({ motivo: typeof args.motivo === "string" ? args.motivo : "otro", resumen: typeof args.resumen === "string" ? args.resumen : "" });
    return { ok: true };
  }

  /** Total de la ultima cotizacion exitosa (para que el agente de referencia lo diga tal cual). */
  get totalCotizado(): number | null {
    return this.cotizacion?.total ?? null;
  }
}

class ErrorNegocio extends Error {}

/** Ajustes normales permitidos (lista cerrada del dueno), extraidos de las notas del pedido. */
export const AJUSTES_PERMITIDOS = ["sin_cebolla", "sin_cilantro", "con_todo", "aparte", "extra_salsa", "mucha_pina", "mucho_frijol"] as const;
const PATRONES_AJUSTE: readonly [string, RegExp][] = [
  ["sin_cebolla", /sin cebolla/],
  ["sin_cilantro", /sin cilantro/],
  ["con_todo", /con todo/],
  ["aparte", /\baparte\b/],
  ["extra_salsa", /(extra|mas) salsa/],
  ["mucha_pina", /mucha pina/],
  ["mucho_frijol", /mucho frijol/],
];
export function ajustesDeNotas(notas: string | null): string[] {
  if (!notas) return [];
  const n = normalizar(notas).replace(/_/g, " ");
  const encontrados = PATRONES_AJUSTE.filter(([, re]) => re.test(n)).map(([k]) => k);
  // Una nota con forma de clave ("mucha_pina") tambien cuenta.
  for (const k of AJUSTES_PERMITIDOS) if (notas.includes(k) && !encontrados.includes(k)) encontrados.push(k);
  return encontrados;
}

/** Minutos para recoger: `minutos_para_recoger` (el servidor real calcula la hora con su reloj, R3) o, si no viene, la diferencia con `hora_recogida`. */
export function minutosDeRecogida(args: Record<string, unknown>, horaLocal: string): number | null {
  const hora = minutosDesdeHoraRecogida(args.hora_recogida, horaLocal);
  if (hora !== null) return hora;
  const plazo = typeof args.minutos_para_recoger === "number" ? args.minutos_para_recoger : Number(args.minutos_para_recoger);
  return Number.isFinite(plazo) && plazo >= 1 && plazo <= 720 ? Math.round(plazo) : null;
}

/** Minutos entre la hora local del caso y `hora_recogida` (ISO 8601 con zona, el parametro real de crear_pedido). Solo cuenta ese
 * campo: el servidor real ignora la hora si va en `notes`, asi que el mundo tambien. Sin campo valido: null. */
export function minutosDesdeHoraRecogida(horaRecogida: unknown, horaLocal: string): number | null {
  if (typeof horaRecogida !== "string") return null;
  const iso = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/.exec(horaRecogida.trim());
  const base = /^(\d{1,2}):(\d{2})/.exec(horaLocal);
  if (!iso || !base) return null;
  const delta = Number(iso[1]) * 60 + Number(iso[2]) - (Number(base[1]) * 60 + Number(base[2]));
  return ((delta % 1440) + 1440) % 1440;
}
