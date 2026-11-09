# verify-restaurantes-aviso-en-camino

Verificación contra Postgres real (RLS, GRANT y `auth.uid()` reales) de
`packages/domain-restaurantes/migrations/107_aviso_en_camino.sql`: el aviso «su pedido va en camino».

- **A. `aviso_en_camino_contexto`**: interruptor encendido sin fila; ventana de 23 h calculada con las huellas del teléfono del pedido
  (formatos `+52` y `+521` de Meta), solo de la misma organización; consentimiento de la 091 (vigente, revocado por BAJA); plantilla aprobada
  solo del evento `order.en_camino` y de la misma organización. Lo leen el sistema, el gestor con alcance a la sucursal y el chofer asignado;
  chofer ajeno, staff de otra sucursal, otro tenant y anon no (42501). Cross-tenant: el pedido de otra organización es `null`.
- **B. `aviso_en_camino_marcar`**: registra el estado; un aviso ya encolado no se pisa (una vez por pedido); un omitido sí se reintenta;
  estado inválido 22023; ajenos 42501.
- **C. Interruptor**: solo owner/admin de toda la organización lo cambia; ni staff, ni admin acotado, ni otro tenant, ni la sesión de sistema;
  la tabla no se lee ni se escribe directo.

Uso local: `scripts/verify-restaurantes-aviso-en-camino/run.sh` (requiere `initdb`/`pg_ctl`/`psql` en `PATH`). En CI lo corre
`postgres-real-gate.yml` (autodescubierto).
