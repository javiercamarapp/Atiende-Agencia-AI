# SoftRestaurant: puerto, adaptador falso, contrato y outbox de comandas

Los Tacos de PM toman pedidos por telefono y WhatsApp. El cuestionario pide que la
comanda se cree **en SoftRestaurant (el POS) antes de cobrar**, que salga tambien a la
impresora de cocina y que el historial por telefono alimente "lo de siempre". La API
real de SoftRestaurant **aun no existe para nosotros** (la dara el distribuidor,
`pm/brechas.md` A3). Este modulo construye todo lo demas para que el adaptador real se
enchufe **sin tocar dominio ni rutas**.

Importar: `@atiende/domain-restaurantes/softrestaurant` (subpath; no se toca el index del
paquete). La suite de contrato esta en `@atiende/domain-restaurantes/softrestaurant/contract`
(importa `vitest`: solo para archivos de prueba).

## Piezas

| Archivo | Que es |
|---|---|
| `types.ts` | `SoftRestaurantPort`, `ComandaInput`/`ComandaResultado`, catalogo, historial, estado, salud y `validarComandaInput` |
| `catalog-map.ts` | Mapeo producto <-> codigo POS (`MapaProductoCodigo`, `construirMapaDesdeCatalogo`). Un producto sin codigo nunca se inventa |
| `fake-adapter.ts` | `FakeSoftRestaurantAdapter` (determinista, fallas inyectables) y `SoftRestaurantNoConfiguradoPort` |
| `contract.ts` | `runSoftRestaurantPortContract`: la suite que TODO adaptador debe pasar |
| `outbox-state.ts` | Maquina de estados pura, backoff, `respuestaAgenteComanda` |
| `outbox-store.ts`, `outbox-memory-store.ts`, `outbox-postgres-store.ts` | Persistencia del outbox y de la bandera |
| `outbox-service.ts` | `encolarComandaParaPedido`, `procesarFilaReclamada`, `drenarComandas`, alerta de captura manual |

Migracion: `packages/domain-restaurantes/migrations/024_softrestaurant_comanda_outbox.sql`
(espejo `supabase/migrations/20240101000197_024_softrestaurant_comanda_outbox.sql`).
Verificacion contra Postgres real: `scripts/verify-restaurantes-softrestaurant-outbox/`.

## El contrato (`SoftRestaurantPort`)

```ts
syncCatalog(sucursal): Promise<CatalogoPos>                       // codigos, modificadores, precios
crearComanda(input: ComandaInput): Promise<ComandaResultado>      // idempotente por idempotencyKey, SIN cobrar
obtenerHistorialPorTelefono({ telefono, limite }): Promise<PedidoHistorialPos[]>
obtenerEstadoComanda({ sucursal, folio }): Promise<ConsultaEstadoComanda>
salud(): Promise<SaludPos>
```

`ComandaInput`: sucursal `T1..T8`, tipo `domicilio | recoger`, cliente, direccion con
referencias (obligatoria en domicilio), forma de pago `efectivo | tarjeta`, propina
(**solo con tarjeta**), items con `codigo` y `modificadores`. No hay campo de "pagado": la
comanda **nunca cobra**; el cobro lo hace caja o el repartidor.

Reglas del contrato que el adaptador real debe respetar:

1. `crearComanda` **no lanza** por fallas del POS. Devuelve `creada` (con `folio`),
   `rechazada` (el POS respondio que no; reintentar igual no sirve) o `no_disponible`
   (timeout, 5xx, red; reintentar si sirve).
2. Es **idempotente por `idempotencyKey`**: la misma llave devuelve la misma comanda
   (`duplicada: true`, mismo `folio`), nunca una segunda. Esto es lo que hace seguro
   reintentar cuando la respuesta se perdio despues de crear.
3. `creada` implica que el POS devolvio un folio real. El folio nunca lo inventa Atiende.
4. Los metodos de lectura lanzan `SoftRestaurantNoDisponibleError` si no se pudo hablar con el POS.
5. `CatalogoPos.sintetico` es `false` en un adaptador real.

## Bandera por organizacion y modos

`restaurantes.softrestaurant_config.modo` (un valor por organizacion):

- `apagado` (**default**; tambien si no hay fila o no esta la migracion): el comportamiento
  actual queda intacto. No se encola nada ni se toca el POS.
- `sombra`: la comanda se encola **en paralelo** y nunca bloquea el pedido ni cambia lo que
  dice el agente. Sirve para comparar contra lo que capturan en caja antes de depender del POS.
- `activo`: se encola y se intenta **una vez en linea** (timeout 4 s). El agente solo puede
  decir lo que devuelve `respuestaAgenteComanda`.

Prender `sombra`/`activo` desde `PUT .../admin/softrestaurant/config` exige un adaptador
**real** (`port.esReal`); hoy responde 409. Es un interruptor de emergencia: poner `apagado`
detiene de inmediato el envio de lo ya encolado (el reclamo respeta la bandera).

## Regla dura: nunca un folio inventado

Solo el estado `confirmada` (el POS devolvio `creada` con folio) produce folio. En cualquier
otro caso el agente dice "pendiente de confirmar" y **nunca** un folio:

> Su pedido quedo registrado y la sucursal lo esta capturando; le llamamos si hay cualquier detalle.

La base lo refuerza: `CHECK (folio is null or estado = 'confirmada')` y una confirmada exige folio.

## Maquina de estados del outbox

```
pendiente -> enviada -> confirmada
                |-> fallida (backoff) -> enviada ...        (POS no respondio, quedan intentos)
                |-> captura_manual                          (POS rechazo, o intentos agotados)
captura_manual / fallida / pendiente -> capturada_manual     (el staff la capturo a mano; corta reintentos)
```

- Backoff: 30 s, 60 s, 120 s ... tope 15 min. Intentos maximos: 5 (se persiste por fila).
- Una fila `enviada` cuyo proceso murio vuelve a ser reclamable al vencer el lease (120 s); si
  era su ultimo intento pasa a `captura_manual`.
- `rechazada`, comanda invalida, producto sin codigo POS o sucursal sin clave T# van a
  `captura_manual` **sin reintentar y sin inventar codigos**.
- Al entrar a `captura_manual` se alerta al staff por la bandeja existente de notificaciones
  (evento `order.problema`) y queda en `GET .../admin/softrestaurant/comandas`.

## Rutas de staff

| Ruta | Quien | Que hace |
|---|---|---|
| `GET /v1/restaurantes/:propertyId/admin/softrestaurant/config` | owner/admin/staff | modo efectivo y adaptador |
| `PUT .../config` `{ modo }` | owner/admin | cambia la bandera (bitacora `configuracion`) |
| `GET .../comandas?estado=&branchId=&limit=&offset=` | owner/admin/staff | por defecto captura_manual, fallida, pendiente, enviada; con la comanda para capturarla a mano |
| `POST .../comandas/:comandaId/capturada` `{ nota? }` | owner/admin/staff con acceso a la sucursal | marca capturada (bitacora `pedido`/`comanda.captura_manual`) |
| `GET .../estados?orderIds=a,b,c` | owner/admin/staff | estado de la comanda de cada pedido (insignia de Pedidos), hasta 100 ids |
| `PUT .../umbral-captura-manual` `{ branchId, minutos }` | owner/admin | minutos (1..240, 5 por omision) que una comanda puede esperar captura manual antes de avisar al staff (migracion 054; bitacora `configuracion`) |
| `GET/POST /internal/restaurantes/softrestaurant-dispatch` | secreto de cron | drena el outbox; 503 sin adaptador real |

## Captura asistida y alerta (migracion 054)

Mientras no haya adaptador real, el pedido entra por voz, WhatsApp o web y alguien lo teclea en SoftRestaurant: la pantalla
`/restaurantes/:orgSlug/comandas-pos` (apps/web, `pages/ComandasPos.tsx`) es esa cola (filtros por estado y sucursal, «Copiar para POS» con los codigos POS,
«Marcar capturada» con el folio del POS opcional). Una comanda en `captura_manual` que pasa el umbral de su sucursal sin capturarse emite la notificacion
`restaurantes.comanda.captura_manual_vencida` (una por comanda, sin PII) desde el tick `/internal/restaurantes/softrestaurant-dispatch`, **antes** de
revisar el adaptador real (la captura asistida es justo el caso de "sin POS"); la logica vive en `alerta-vencida.ts` y los candidatos los decide la base
(`restaurantes.pos_comandas_captura_manual_vencidas`, solo sistema).

## Compatibilidad con la base sin migrar

Todo acceso del store corre dentro de `runWithSavepointFallback` (SAVEPOINT / ROLLBACK TO
SAVEPOINT) porque la sesion es una sola transaccion por request. Sin la migracion 024: la
bandera efectiva es `apagado`, encolar/reclamar no hacen nada y las lecturas responden
`disponible: false` con lista vacia. Cubierto por `AbortAwareFakeSession` en
`tests/softrestaurant-outbox-postgres-savepoint.spec.ts`.

## Como implementar el adaptador real cuando llegue la API

1. Crear `SoftRestaurantHttpAdapter implements SoftRestaurantPort` (p. ej. en
   `apps/api/src/production/softrestaurant-http-adapter.ts`). Mapear timeout/5xx/red a
   `{ status: "no_disponible", causa }` y respuestas 4xx de negocio a `rechazada`. Si la
   integracion es un agente local por sucursal, el adaptador habla con ese agente; el contrato
   no cambia. `esReal` debe ser `true`.
2. **Pasar la suite de contrato** contra un sandbox o POS de prueba:
   ```ts
   import { runSoftRestaurantPortContract } from "@atiende/domain-restaurantes/softrestaurant/contract";
   runSoftRestaurantPortContract("SoftRestaurantHttpAdapter (sandbox)", async () => ({
     port: new SoftRestaurantHttpAdapter(cfgSandbox),
     codigoValido: { producto: "<codigo de prueba>", modificador: "<opcional>" },
     // fallas: { timeout, http5xx, duplicado, productoInexistente } solo si el sandbox sabe provocarlas
   }));
   ```
3. Inyectarlo: `softRestaurantPort` en `AppDeps` (`apps/api/src/production/deps.ts`).
4. Cargar el mapeo: producto -> codigo (`construirMapaDesdeCatalogo` con `syncCatalog`; revisar
   `sinCodigo` con el dueño) y sucursal -> `T1..T8` (`crearResolverSucursalPos`). Inyectarlos
   como `softRestaurantMapeo`. Hoy no hay tabla de mapeo persistida (ver huecos).
5. Programar `/internal/restaurantes/softrestaurant-dispatch` (cron o scheduler externo).
6. Aplicar la migracion 024 en la base real **antes** de prender nada.
7. Prender `sombra` en una sucursal, comparar folios contra lo que captura caja, y solo despues `activo`.
   Confirmar con el distribuidor que crear la cuenta imprime en cocina (`impresaEnCocina`).

## Huecos conocidos

- La API real de SoftRestaurant no existe aun: solo hay adaptador falso y "no configurado".
- El mapeo producto->codigo y sucursal->T# vive en memoria (inyectado); falta su tabla y el sync.
- El enganche cubre `POST /v1/restaurantes/:orgSlug/orders` (voz y web). El agente de WhatsApp
  (`whatsapp/llm-turn-handler.ts`) crea pedidos por otra ruta y aun no llama a
  `encolarComandaParaPedido` (lo modifica otra rama; el punto de enganche ya esta listo).
- Canal (`domicilio|recoger`), colonia y propina salen del modelo PM (migracion 023) y se pasan al
  enganche; si el pedido no declara canal, el tipo se deduce de la direccion, y si no declara forma
  de pago se asume efectivo (la comanda no cobra).
- Si el request que creo el pedido hace rollback despues de un envio en linea, el POS puede quedar
  con una comanda sin pedido en Atiende (raro; el staff la ve en caja).
