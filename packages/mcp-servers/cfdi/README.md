# @atiende/mcp-cfdi

Transporte PAC (timbrado CFDI 4.0) del vertical hoteles — Fase 5 (fraude interno +
CFDI de hospedaje), portado de `hoteles/packages/mcp-servers/cfdi`.

`CfdiPort` (`src/port.ts`) es el contrato: timbrar/cancelar/consultar
estado/verificar webhook. `DualPacCfdiPort` (`src/adapters/dual-pac-cfdi-port.ts`)
envuelve dos `CfdiPort` (primario/secundario) y conmuta al secundario si el
primario falla al timbrar — mitigación explícita de "CFDI mal timbrado" con dos PAC
intercambiables.

`FinkokAdapter`/`SwSapienAdapter` (`src/adapters/*-adapter.ts`) son esqueletos
HONESTOS de los proveedores reales de ejemplo: sin las variables de entorno de
credenciales/CSD correspondientes, `status()` reporta `unavailable` y CUALQUIER
llamada real lanza `PortUnavailableError` — nunca fabrican un timbrado ni hablan
con la red sin credenciales verificadas. La elección final de PAC queda pendiente
del fundador.

`FakeFinkokAdapter`/`FakeSwSapienAdapter` (`src/adapters/fake-pac-adapter.ts`) son
los adaptadores de prueba/desarrollo: SIEMPRE responden (idempotentes por folio,
con conflicto explícito si el mismo folio se timbra con datos distintos). Toda la
suite de pruebas de CFDI de hospedaje (unitarias y de integración) corre sobre
estos, nunca requiere una API key real de un PAC.

`src/shared.ts` porta, ESCOPADO a lo que este puerto necesita (HMAC + replay
guard, idempotencia en memoria, chequeo de credenciales por variable de entorno,
errores base), las utilidades de `hoteles/packages/mcp-servers/shared` — ese
paquete genérico (`@atiende/mcp-shared`) todavía no existe en atiende-fusion (sirve
también a PMS/WhatsApp/pagos, fuera del alcance de esta fase); portarlo completo
solo para este paquete pequeño habría sido alcance ajeno a Fase 5.
