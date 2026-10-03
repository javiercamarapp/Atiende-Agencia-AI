// Tipos del simulador local de llamadas y de la "prueba ciega es-MX" de RESTAURANTES. La forma generica (guion, turnos, pasos, llamada
// simulada) es de @atiende/voice-core; aqui se fijan los resultados de restaurantes, la memoria del agente guionado (productos,
// quote_hash) y lo que un guion espera ademas del resultado (el pedido guardado y los callbacks).
import type { EsperadoBase, GuionLlamada as GuionCore, LlamadaSimulada as LlamadaCore, MemoriaObservable, PasoAgente as PasoCore, TurnoGuion as TurnoCore } from "@atiende/voice-core/simulador";
import type { MundoVoz } from "./mundo-voz.ts";

export type { ResultadoGrader } from "@atiende/voice-core/simulador";

/** Lo que el agente ya sabe por herramientas anteriores de ESTA llamada (para armar los argumentos del siguiente paso). */
export interface MemoriaTools extends MemoriaObservable {
  /** Producto devuelto por `buscar_producto` cuyo nombre contiene el fragmento (sin importar mayusculas ni acentos). */
  producto(fragmento: string): { readonly id: string; readonly name: string; readonly price: number; readonly pack_size: number };
  quoteHash(): string | undefined;
}

export type PasoAgente = PasoCore<MemoriaTools>;
export type TurnoGuion = TurnoCore<MemoriaTools>;

export interface PedidoEsperado {
  readonly sucursal: string;
  readonly canal: "domicilio" | "recoger";
  readonly pago: "efectivo" | "tarjeta";
  readonly total: number;
  /** `cantidad` = ordenes (paquetes) cobradas, como las guarda el pedido. */
  readonly items: readonly { readonly nombre: string; readonly cantidad: number }[];
  /** Fragmentos que deben aparecer en la direccion guardada (domicilio). */
  readonly direccionIncluye?: readonly string[];
}

export interface EsperadoPm {
  readonly pedido?: PedidoEsperado;
  readonly sinPedido?: boolean;
  /** Motivos de callback en orden (`escalada:queja`, ...). */
  readonly callbacks?: readonly string[];
}

export type Esperado = EsperadoBase<"pedido_creado"> & EsperadoPm;
export type GuionLlamada = GuionCore<"pedido_creado", EsperadoPm, MemoriaTools>;
export type LlamadaSimulada = LlamadaCore<"pedido_creado", EsperadoPm, MemoriaTools, MundoVoz>;
