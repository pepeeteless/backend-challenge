BEGIN;

-- Carteira temporária para esta verificação.
INSERT INTO wallets (id, player_id, currency, balance)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  'BRL',
  0.00
);

DO $$
BEGIN
  BEGIN
    UPDATE wallets
    SET balance = -1.00
    WHERE id = '00000000-0000-4000-8000-000000000001';

    RAISE EXCEPTION 'FALHA: o banco permitiu saldo negativo';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'OK: saldo negativo rejeitado';
  END;

  BEGIN
    INSERT INTO wallets (id, player_id, currency, balance)
    VALUES (
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000002',
      'BRL',
      0.00
    );

    RAISE EXCEPTION 'FALHA: o banco permitiu carteira duplicada';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'OK: carteira duplicada rejeitada';
  END;
END;
$$;

ROLLBACK;