# verify-restaurantes-encuesta-entrega

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/061_encuesta_post_entrega.sql`
(espejo: `supabase/migrations/20240101000314_061_encuesta_post_entrega.sql`): encuesta post-entrega (R-41).

Cubre: configuracion por sucursal (apagada por defecto, validacion de la liga de resenas https, rangos, bitacora solo si algo cambia),
barrido (`encuesta_candidatas`: sucursal activa, espera, ventana de 48 h, trafico demo, pedido no entregado, otro tenant, limite) y
registro de envio idempotente con foto del repartidor, lado publico (`encuesta_publica` sin PII y con liga de resenas solo desde el umbral;
`encuesta_responder` first-write-wins, comentario en blanco como nulo, rangos), resumen de satisfaccion (global, por sucursal y por
repartidor, zona horaria de la sucursal, promedio nulo sin respuestas, alcance del admin acotado), staff de piso / repartidor / admin
acotado / otro tenant / anon / sesion de sistema vs staff rechazados (SQLSTATE exacto), tablas cerradas (sin GRANT, RLS, CHECK, UNIQUE) y
base sin migrar (42883 recuperable con subtransaccion).

- Manual: `scripts/verify-restaurantes-encuesta-entrega/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
