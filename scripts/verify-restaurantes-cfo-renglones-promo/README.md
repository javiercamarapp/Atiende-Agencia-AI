# verify-restaurantes-cfo-renglones-promo

Verifica contra un Postgres efimero REAL (puerto 55701) la migracion `086_cfo_renglones_precio_de_lista` (prefijo 20240101000397): con la regla D12 los renglones regalados por
la promocion (cortesia o 2x1) se guardan a `price` 0 con `listPrice`, y el CFO (`cfo_renglones` -> `cfo_ventas_diarias`, `cfo_productos`, `cfo_pedidos_detalle`) conserva la venta bruta,
el descuento de promocion y la neta de antes: 2x1 de 4 tacos ($200/$100), nachos + 2 aguas ($152/$62), cortesia de cantidad 1, mixto, kilo con propina, pedido anterior sin `listPrice`
y `listPrice` mal formado. Aplica la migracion una segunda vez (idempotencia) y comprueba que la funcion sigue cerrada a `authenticated`.

Uso: `scripts/verify-restaurantes-cfo-renglones-promo/run.sh` (opt-in; el gate de CI lo descubre solo con `run-gate.mjs`).
