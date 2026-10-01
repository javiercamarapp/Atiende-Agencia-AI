// Tipos del arnes de evaluacion del agente de Los Taquitos de PM (68 casos dorados, `casos.json`).
// El arnes corre SIN LLM real en CI (agente de referencia guionado + mundo simulado + graders deterministas) y
// con LLM real solo a mano (ver `real.ts`).

export interface ClienteConocido {
  readonly telefono: string;
  readonly nombre: string;
  readonly ultimo_pedido: readonly { readonly producto: string; readonly piezas: number }[];
  readonly colonia_guardada: string | null;
}

export interface FixturesExtra {
  readonly asignar_sucursal?: Readonly<Record<string, string>>;
  readonly producto_agotado?: readonly string[];
  readonly crear_comanda?: "error_500_siempre" | "timeout_siempre";
}

export interface ComandaEsperada {
  readonly tipo: "domicilio" | "recoger";
  readonly sucursal: string;
  readonly pago: "efectivo" | "tarjeta";
  readonly nombre: string;
  readonly telefono: string;
  readonly items: readonly { readonly producto: string; readonly piezas: number }[];
  readonly ajustes?: readonly string[];
  readonly tortilla?: string;
  readonly promo_id?: string;
  readonly cortesias?: readonly string[];
  readonly propina: "no_aplica" | "en_terminal";
  readonly hora_recoger_min?: number;
  readonly total_mxn: number;
}

export interface CasoEval {
  readonly id: string;
  readonly canal: "llamada" | "chat";
  readonly categoria: string;
  readonly contexto: {
    readonly dia: string;
    readonly hora_local: string;
    readonly sucursal_contexto: string;
    readonly cliente_conocido: ClienteConocido | null;
    readonly fixtures_extra?: FixturesExtra;
  };
  readonly simulador_cliente: {
    readonly apertura: string;
    readonly datos: Readonly<Record<string, string>>;
    readonly giros: readonly string[];
  };
  readonly esperado: {
    readonly resultado: "comanda" | "escalar" | "sin_comanda";
    readonly comanda?: ComandaEsperada;
    readonly escalar?: { readonly motivos_validos: readonly string[]; readonly veces: number };
    readonly debe_decir_algo_equivalente_a?: readonly string[];
    readonly no_debe_decir?: readonly string[];
  };
  readonly graders: readonly string[];
}

export interface SuiteEval {
  readonly suite: string;
  readonly version: string;
  readonly fixtures: {
    readonly sucursales: Readonly<Record<string, { readonly nombre: string; readonly menu: "grande" | "chico" }>>;
    readonly asignar_sucursal: Readonly<Record<string, string>>;
  };
  readonly casos: readonly CasoEval[];
}

export interface ProductoMenu {
  readonly nombre: string;
  readonly categoria: string;
  readonly precio_mxn: number;
  readonly pack_size: number;
  readonly es_alcohol: boolean;
  readonly regional: boolean;
}

/** Lo que el agente (de referencia o un LLM) ve y dice, en orden. */
export type EventoTraza =
  | { readonly tipo: "cliente"; readonly texto: string }
  | { readonly tipo: "agente"; readonly texto: string }
  | { readonly tipo: "herramienta"; readonly nombre: string; readonly args: Readonly<Record<string, unknown>>; readonly resultado: unknown; readonly turnoCliente: number };

export interface Traza {
  readonly casoId: string;
  readonly eventos: readonly EventoTraza[];
}

export interface ComandaRegistrada {
  readonly orderId: string;
  readonly tipo: "domicilio" | "recoger";
  readonly sucursal: string;
  readonly pago: "efectivo" | "tarjeta";
  readonly nombre: string;
  readonly telefono: string;
  readonly items: readonly { readonly producto: string; readonly piezas: number }[];
  readonly ajustes: readonly string[];
  readonly tortilla: string | null;
  readonly promoId: string | null;
  readonly cortesias: readonly string[];
  readonly propina: "no_aplica" | "en_terminal";
  readonly horaRecogerMin: number | null;
  readonly totalMxn: number;
  readonly colonia: string | null;
  readonly direccion: string | null;
  readonly notas: string | null;
}

export interface ResultadoGrader {
  readonly grader: string;
  readonly ok: boolean;
  readonly detalle: string;
}

export interface ResultadoCaso {
  readonly casoId: string;
  readonly graders: readonly ResultadoGrader[];
  readonly ok: boolean;
}
