// Contrato (SOLO tipos y constantes, sin dependencias: lo importa la SPA con `import type`) de la pantalla «Agregados por validar» del panel del operador.
// Rutas bajo `/v1/restaurantes/:propertyId/admin/agregados`. El servidor es la autoridad: re-valida rol (`pedidos.agregados`), alcance por sucursal, estado y motivo.

export type EstadoAgregadoWire = "pendiente" | "aceptado" | "rechazado" | "vencido" | "cancelado_por_cliente" | "no_aplicable";
export type NivelSlaAgregadoWire = "en_tiempo" | "sin_respuesta" | "vencido";
export type MotivoRechazoAgregadoWire = "ya_salio_de_cocina" | "producto_agotado" | "pedido_en_reparto" | "fuera_de_horario" | "otro";

export const MOTIVOS_RECHAZO_AGREGADO_WIRE: readonly MotivoRechazoAgregadoWire[] = ["ya_salio_de_cocina", "producto_agotado", "pedido_en_reparto", "fuera_de_horario", "otro"];

export interface RenglonAgregadoWire {
  readonly nombre: string;
  readonly cantidad: number;
  readonly precio: number;
  readonly subtotal: number;
}

export interface TarjetaAgregado {
  readonly id: string;
  readonly propertyId: string;
  readonly sucursal: string | null;
  readonly canal: "whatsapp" | "llamada";
  /** Estado guardado en la base. */
  readonly estado: EstadoAgregadoWire;
  /** Estado EFECTIVO por el reloj: una pendiente con 20+ minutos aparece `vencido` aunque el tick de 5 min todavia no la haya cerrado. */
  readonly estadoEfectivo: EstadoAgregadoWire;
  readonly sla: { readonly segundosEspera: number; readonly nivel: NivelSlaAgregadoWire; readonly segundosParaSiguienteUmbral: number | null };
  readonly pedido: {
    readonly id: string;
    readonly numero: number | null;
    /** Estado interno del pedido (`preparando`, `listo_para_recoger`...). */
    readonly estado: string;
    /** `true` si el pedido ya esta en cocina o mas adelante: el agregado puede no alcanzar a salir junto con el. */
    readonly yaEnCocina: boolean;
    readonly creadoEn: string;
    readonly renglones: readonly { readonly nombre: string; readonly cantidad: number }[];
    readonly total: number;
  };
  readonly agregado: { readonly renglones: readonly RenglonAgregadoWire[]; readonly total: number; readonly nuevoTotal: number; readonly nota: string | null; readonly version: number };
  readonly cliente: { readonly nombre: string; /** Solo mientras la solicitud sigue abierta (permiso derivado); `null` despues. */ readonly telefono: string | null };
  readonly solicitadoEn: string;
  readonly vistoEn: string | null;
  readonly resueltoEn: string | null;
  readonly resueltoPor: string | null;
  readonly motivoRechazo: MotivoRechazoAgregadoWire | null;
  readonly notaRechazo: string | null;
  readonly escalamiento: 0 | 1 | 2;
}

export interface ListaAgregados {
  /** `false` = la base aun no tiene la migracion 097 (estado honesto, lista vacia). */
  readonly disponible: boolean;
  readonly agregados: readonly TarjetaAgregado[];
  /** Pendientes (conteo para el globo del menu y el banner). */
  readonly pendientes: number;
  readonly ahora: string;
}

export interface RechazarAgregadoEntrada {
  readonly motivo: MotivoRechazoAgregadoWire;
  readonly nota?: string;
}

export interface ResolverAgregadoSalida {
  /** `aplicado`: esta llamada resolvio la solicitud. `ya_resuelto`: otra persona (o el sistema) llego antes; no se repitio nada. `no_aplicable`: al aceptar, el pedido ya no admitia agregados. */
  readonly resultado: "aplicado" | "ya_resuelto" | "no_aplicable";
  readonly agregado: TarjetaAgregado;
}
