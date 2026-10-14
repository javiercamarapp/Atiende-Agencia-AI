/**
 * Interruptor del bloque «Entrega en curso» (MapaEntrega / MapaLeaflet) de Pedidos. APAGADO por decision del dueno: hoy el cliente y el repartidor
 * del mapa son SIMULADOS (el repo suelto tambien los simulaba) y la regla «nada de maquetas» (CLAUDE.md) pide ocultarlo.
 * Se enciende cuando existan coordenadas reales de cliente y repartidor. Es una constante (sin variable de entorno ni migracion); las pruebas
 * la encienden con vi.mock de este modulo.
 */
export const MAPA_ENTREGA_HABILITADO = false;
