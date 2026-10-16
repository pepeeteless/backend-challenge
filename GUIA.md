# Guia do projeto e ponto de retomada

Atualizado em 16/10/2026. O README original é a fonte dos requisitos.
As decisões e limitações detalhadas estão em ARCHITECTURE.md.

Validação deste incremento: typecheck e 58 testes passaram (39 unitários e
19 de integração). A quarta migração já foi aplicada ao banco local pepe.

## O que funciona agora

- Money exato e imutável; Wallet com crédito/débito; lançamento auditável.
- PostgreSQL via Docker Compose e quatro migrações versionadas.
- POST /wallets: criação com OPENING + ledger para saldo inicial positivo.
- GET /wallets/:walletId: consulta, validação do UUID e resposta 404.
- GET /health/live: processo vivo.
- POST /wagering/transactions: somente BET neste incremento.
- BET com bloqueio por carteira no PostgreSQL, saldo/ledger/resultado atômicos.
- Idempotência persistente, conflito de payload e replay da resposta original.
- Rejeições por saldo, moeda, jogador e valor zero, sem débito nem ledger.
- Proteção contra alteração/exclusão de transações terminais no banco.

## Fluxo para estudar

HTTP -> WageringController -> ProcessBet -> WagerTransaction + Wallet -> PostgreSQL.

1. O controller recebe JSON e Idempotency-Key.
2. ProcessBet valida a entrada e calcula o hash canônico dos campos de negócio.
3. Dentro da transação SQL, procura uma execução anterior e devolve replay se existir.
4. Bloqueia somente a linha da carteira com SELECT FOR UPDATE.
5. Insere a BET pendente; constraints únicas arbitram duplicatas concorrentes.
6. WagerTransaction verifica jogador, moeda, valor e saldo.
7. Se aceita, Wallet.debit reduz saldo, incrementa versão e produz ledger.
8. ProcessBet grava saldo, ledger, estado final e resposta no mesmo commit.
9. O controller responde 200 para aplicada ou 422 para rejeição de negócio.

O saldo da resposta fica salvo: outra movimentação não altera um replay antigo.
Uma falha antes do commit desfaz o conjunto. SQS e publicação de eventos ainda
não estão implementados; essa recuperação completa continua pendente.

## Onde procurar

- src/main.ts: inicia Nest; src/app.module.ts: registra controllers e banco.
- src/database/database.service.ts: abre/fecha ORM e fornece EntityManager.
- src/database/orm.config.ts: conexão, WalletSchema e lista de migrações.
- src/database/migrations/: histórico SQL; não alterar migrações já aplicadas.
- src/wallets/: Money, Wallet, ledger, abertura, controller e mapeamento da carteira.
- src/wagering/bet-input.ts: validação compartilhável e hash canônico.
- src/wagering/wager-transaction.ts: regras de BET e proteção de estado terminal.
- src/wagering/process-bet.ts: coordenação do banco, lock, deduplicação e persistência.
- src/wagering/wagering.controller.ts: adaptação HTTP.
- src/wagering/process-bet.integration.test.ts: testes com banco temporário real.
- src/wagering/bet-process.fixture.ts: auxiliar dos testes com três processos Bun.

Migrations mudam a estrutura; WalletSchema mapeia colunas; rehydrate reconstrói
objetos de domínio. Não são três implementações da mesma responsabilidade.

## Comandos no PowerShell

Diretório: C:\Users\pepee\Desktop\Dev\jungleGaming\backend-challenge

```powershell
bun run services:up
bun run migrate:up
bun run typecheck
bun run test
bun run start:dev
```

Deixe o servidor rodando em um terminal e faça os pedidos em outro.
Não use migrate:down no banco de trabalho como verificação: ele remove estrutura.
Os novos testes fazem up/down em banco temporário e apagam somente esse banco.
O PostgreSQL precisa estar disponível; os testes anteriores usam o banco pepe
com rollback. Os testes novos usam commits reais em wager_test_<UUID>.

## Demonstração manual de BET e replay

```powershell
$playerId = [guid]::NewGuid().ToString()
$walletPayload = @{
  playerId = $playerId
  initialBalance = @{ amount = "100.00"; currency = "BRL" }
} | ConvertTo-Json

$wallet = Invoke-RestMethod -Method Post -Uri http://localhost:3000/wallets `
  -ContentType "application/json" -Body $walletPayload

$externalId = [guid]::NewGuid().ToString()
$headers = @{ "Idempotency-Key" = "provider-a:$externalId" }
$betPayload = @{
  providerId = "provider-a"
  externalTransactionId = $externalId
  playerId = $playerId
  walletId = $wallet.id
  roundId = "round-1"
  gameId = "game-1"
  kind = "BET"
  money = @{ amount = "80.00"; currency = "BRL" }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri http://localhost:3000/wagering/transactions `
  -Headers $headers -ContentType "application/json" -Body $betPayload |
  ConvertTo-Json -Depth 5
```

Esperado: PROCESSED, saldo 20.00, idempotentReplay false.
Repita apenas o último Invoke-RestMethod, sem gerar outra chave/payload.
Esperado: mesmo transactionId e saldo, idempotentReplay true.
A criação de wallet não tem esse contrato de idempotência: repetir o jogador/moeda
na abertura continua retornando 409, conforme README.

## Testes do bloco BET

- Duas apostas de 80 contra 100: uma aceita, outra rejeitada, saldo 20.
- 50 reenvios em paralelo: um débito.
- Três processos Bun independentes: mesma BET não duplica.
- Replay depois de outra aposta: saldo original preservado.
- Payload divergente, troca de chave e colisão entre wallets: conflito.
- Moeda divergente: rejeição persistida sem movimentação.
- Falha no ledger depois de atualizar saldo: rollback completo; retry funciona.
- Uma carteira bloqueada não impede outra carteira.
- Transações terminais protegidas por trigger.
- HTTP real e migração up/down no banco descartável.

Esses testes não equivalem aos testes de três servidores completos com SQS.
Não há simulação de queda após commit/antes de ack ainda.

## Próximos blocos obrigatórios

1. WIN/LOSS/REFUND/ROLLBACK e referências fora de ordem.
2. Outbox e eventos na mesma transação; inbox e consumidor SQS compartilhando o caso de uso.
3. LocalStack, retries, DLQ, recuperação e testes de queda/reinício.
4. Consultas restantes, reconciliação, métricas, logs JSON e readiness.
5. Ponto de extensão de autenticação, permissões do banco e documentação final.

## Acordo de trabalho

O usuário autorizou gerar código para agilizar e perguntará quando precisar.
Implementar um bloco coerente por vez, testar e explicar o fluxo principal.
Não declarar requisitos futuros concluídos. O bloco atual ainda não cobre a
atomicidade completa com inbox/outbox exigida pelo README.
