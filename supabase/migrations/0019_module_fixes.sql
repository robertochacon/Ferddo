-- ═══ Ferddo · 0019 · Compras implican cuentas por pagar ═══
--
-- Por qué: la 0013 sembró tipos de negocio (colmado, tienda de ropa,
-- cafetería…) con `purchases` pero sin `payables`. Recibir una compra crea su
-- cuenta por pagar, así que esos negocios acababan con deudas que no podían
-- saldar desde la app. Lo detectó supabase/tests/erp_integration.sql.
update public.business_types
   set modules = modules || array['payables']
 where 'purchases' = any (modules) and not ('payables' = any (modules));

-- Las empresas ya creadas con esa configuración se corrigen igual.
update public.tenants
   set modules = modules || array['payables']
 where 'purchases' = any (modules) and not ('payables' = any (modules));
