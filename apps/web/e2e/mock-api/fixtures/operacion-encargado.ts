// API simulada del encargado (Cola, Nuevo pedido, Viajes). VACIA a proposito: es el archivo del paquete B (`PLAN-PANEL-OPERADOR §6`).
// Ya esta registrada en el indice; B agrega aqui las rutas de `RUTAS_OPERACION` que necesite (capturarPedido, cotizarPedido,
// clientePorTelefono, cola, despachar, marcarListo, viajes) y responde SIEMPRE con `conContrato(esquema..., cuerpo)` de
// `./operacion-comun.ts` para que el mock no se desvie del contrato. Mientras no haya fixture, la ruta responde 404 `mock_sin_fixture`
// (honesto y visible en el registro de peticiones).
import type { Ruta } from "../tipos.ts";

export const rutasOperacionEncargado: readonly Ruta[] = [];
