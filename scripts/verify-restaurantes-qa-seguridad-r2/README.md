# verify-restaurantes-qa-seguridad-r2

Prueba contra Postgres real (RLS, GRANT y `auth.uid()` reales) de la migracion
`packages/domain-restaurantes/migrations/075_seguridad_r2_alcance_y_compensaciones.sql` (QA restaurantes ronda 2, lote seguridad).

Cubre, por hallazgo:

- **R2-seguridad-02** (promociones): un owner de otra organizacion o vertical no lee los codigos `GRACIAS-*`; `anon` no tiene SELECT;
  la sesion de sistema (sin usuario) resuelve solo promociones activas; el owner de la organizacion sigue viendo las suyas.
- **R2-seguridad-03** (compensaciones): un staff no crea ni aprueba una reposicion sin costo o un codigo de descuento; el sistema y el
  owner si; una sola reposicion y un solo codigo por pedido original; tope de 20 unidades; cross-tenant y `anon` rechazados.
- **R2-seguridad-04** (`core.emit_notification`): una sesion de usuario de restaurantes no emite avisos criticos, de otro vertical ni con
  clave de dedupe ajena; el repartidor solo emite la incidencia; el relleno de un usuario queda en 30 por hora y el aviso del sistema llega.
  Otras verticales no cambian.
- **R2-seguridad-05** (pedido falso): alcance por sucursal de la membresia, repartidor y cross-tenant rechazados.
- **R2-seguridad-06** (ARCO acceso): el export incluye WhatsApp, solicitudes de contacto, llamadas de voz con turnos, pedidos completos
  (direccion, transcripcion, consentimiento) y solicitudes ARCO, sin mezclar datos de otras personas; declara `no_incluido`.
- **R2-seguridad-08**: `storefront_marca_sello` sin EXECUTE para `anon`/`PUBLIC`.

Manual: `scripts/verify-restaurantes-qa-seguridad-r2/run.sh` (necesita `initdb`/`pg_ctl`/`psql`).
En CI lo corre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (auto-descubrimiento por los tres archivos).
