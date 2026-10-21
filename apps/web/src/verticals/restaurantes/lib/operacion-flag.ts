// Interruptor del panel movil del operador (PLAN-PANEL-OPERADOR). Mientras sea `false`, las rutas /operacion/* existen (muestran el estado
// honesto «no disponible aun») pero NO aparecen en el menu del shell: el personal de PM no ve pantallas a medias. El paquete B lo pone en
// `true` en el commit que conecta la Cola de verdad (backend A1 fusionado), asi ninguna pantalla se anuncia antes de funcionar.
export const OPERACION_PANEL_ACTIVO = false;
