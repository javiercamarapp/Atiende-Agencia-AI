# verify-restaurantes-marketing-campanas

Prueba contra Postgres REAL (RLS, GRANT y `auth.uid()` reales) la migracion `packages/domain-restaurantes/migrations/052_marketing_consentimiento_y_campanas.sql`
(consentimiento de mensajes promocionales, campanas de reactivacion con aprobacion de un clic, grupo de control y atribucion).

Escenarios (ver `assertions.sql`):

- **A. Consentimiento**: otorgar/revocar con version del aviso decidida por la base, idempotencia, historial; rechazos (usuario logueado, cliente de otra organizacion, anon, canal invalido).
- **B. BAJA por telefono**: revoca el consentimiento y mata los mensajes de campana aun pendientes; rechazos (usuario logueado, telefono invalido).
- **C. Borradores**: sin configuracion activa o sin promocion vigente no hay borrador; sin consentimiento nadie entra al segmento; minimo de segmento; idempotencia por dia; expiracion.
- **D. Aprobacion**: con la campana sin aprobar no se encola NADA; aprobar encola solo a quien tiene consentimiento VIGENTE, respeta el grupo de control y el tope de 14 dias; segundo clic idempotente; rechazar no envia;
  requisitos honestos (tarifa, plantilla aprobada, WhatsApp conectado, tope mensual); owner de otra organizacion, staff de piso y anon rechazados.
- **E. RLS de lectura** de las 5 tablas y ausencia de escritura directa.
- **F. Atribucion**: pedidos de tratados y de control en los 7 dias siguientes.
- **G. Alertas al dueño**: candidatos de «WhatsApp silencioso» (historico de 4 semanas, umbrales configurables, organizacion demo y sin canal excluidas), guardar/leer umbrales (owner/admin con alcance a toda la organizacion, cross-tenant, anon, rangos) y `es_organizacion_restaurantes` (solo sistema).

Uso manual: `scripts/verify-restaurantes-marketing-campanas/run.sh` (Postgres local con `initdb`). En CI lo descubre solo `scripts/verify-real-postgres-ci/run-gate.mjs`.
Concurrencia de dos conexiones: la unicidad `(organizacion, segmento, dia)` del borrador y `(campana, cliente)` del envio y el `for update` de la campana garantizan una sola campana y un solo envio por cliente; no hay un script de carrera separado en este PR.
