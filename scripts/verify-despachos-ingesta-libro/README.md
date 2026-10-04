# verify-despachos-ingesta-libro

Prueba contra Postgres REAL de `packages/domain-despachos/migrations/026_despachos_clasificacion_ingesta_libro.sql`
(paridad3: clasificación contable al ingerir, correcciones por RFC, pólizas del periodo del cron, UUID por cliente, marca de rechazo de una
revisión, dirección al capturar la ficha, y el portal: CFDI del cliente y autoaceptado).

- `assertions.sql` (juzgado por `scripts/verify-real-postgres-ci/run-gate.mjs` en CI, 147 escenarios):
  - `invoice_clasificar` / `invoice_categoria_corregir`: fila nueva con método y razón, CHECK ampliado (categorías finas y métodos nuevos), roles
    (admin, contador acotado, readonly, otro despacho, sin membresía, sistema, anon), CFDI de otra property, INSERT directo cerrado, lectura por property;
  - `clasificacion_correccion_*`: upsert por (RFC, ClaveProdServ), validación de RFC/ClaveProdServ/categoría/cuenta, tope de 1000 por cliente, roles,
    RLS cross-tenant y escritura directa cerrada;
  - rechazo de una revisión marca `excluido_por_revision` (aprobar no); sin UPDATE directo sobre `invoice`; función del trigger sin EXECUTE;
  - UUID único por cliente: el mismo UUID en dos properties de una organización entra, en la misma property no, la llave vieja ya no existe;
  - configuración por cliente: CHECK del umbral (0.5 a 1), valores por omisión, escritura solo del admin;
  - `invoice_direccion_recalcular`: indeterminado -> emitido/recibido con la ficha, idempotente, roles;
  - pólizas del periodo (solo sistema): candidatos (clasificado, sin revisión pendiente, no cancelado/excluido, sin póliza vigente, periodo abierto),
    registro idempotente con actor NULL, periodo cerrado/cancelado/excluido/pendiente/sin catálogo, siembra del catálogo base, descuadre y cuentas
    fuera de catálogo, núcleo sin EXECUTE, regresión de la vía de staff;
  - portal: el cliente ve solo sus CFDI, token expirado/inexistente/mal formado, contexto del autoaceptado (bandera, umbral, ficha, existe, periodo
    cerrado, EFOS, correcciones), aceptar (atómico, property del documento, ya existía, periodo cerrado, bandera apagada, no XML);
  - postura de catálogo: ninguna función nueva ejecutable por anon/PUBLIC, todas definer con `search_path` fijo, tablas sin escritura directa.
- `run.sh`: lo mismo contra un Postgres efímero local (`initdb`/`pg_ctl`).
- No llama al SAT ni a ningún PAC: son filas ficticias de la propia verificación (RFC, folios y correos de ejemplo).
