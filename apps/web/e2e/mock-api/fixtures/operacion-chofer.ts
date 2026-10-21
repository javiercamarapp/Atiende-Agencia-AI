// API simulada del chofer y del panel Turno. VACIA a proposito: es el archivo del paquete C (`PLAN-PANEL-OPERADOR §6`).
// Ya esta registrada en el indice; C agrega aqui las rutas de `RUTAS_OPERACION` que necesite (entregasChofer, entregar,
// deshacerEntrega, problema, llamar, hoyChofer y, para Turno, `hoy`) y responde SIEMPRE con `conContrato(esquema..., cuerpo)` de
// `./operacion-comun.ts`. Mientras no haya fixture, la ruta responde 404 `mock_sin_fixture`.
import type { Ruta } from "../tipos.ts";

export const rutasOperacionChofer: readonly Ruta[] = [];
