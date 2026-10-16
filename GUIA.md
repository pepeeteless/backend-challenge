# Guia do projeto e ponto de retomada

Atualizado em 16/10/2026. O README original é a fonte dos requisitos.
As decisões e limitações detalhadas estão em ARCHITECTURE.md.
O tutorial completo do código e dos fluxos está em [TUTORIAL.md](TUTORIAL.md).
Ponto de estudo atual: acompanhar uma BET HTTP e distinguir validacao de contrato,
regras do dominio, protecoes do banco, flush e commit.

Persistência com repositórios MikroORM; oito migrações aplicadas ao banco local pepe.
O bloco atual conclui execução em três containers e permissões. Testes de concorrência e
mensageria usam bancos temporários e filas isoladas, removidos ao final.
Validação atual: 144 testes cadastrados, incluindo sete casos novos de FAILED.
Typecheck passou. Regressão final: 144 testes passaram, zero falhas, 629 asserções.
O cenário adicional verify-cluster.ts passou com três APIs e reinício real.
Os testes usam PostgreSQL e LocalStack reais. Migration202610160005
aplicada e filas locais criadas. Recuperação após morte do consumidor, publishers
concorrentes, rollback conjunto, retries/DLQ e ciclo de vida do worker verificados.

## O que funciona agora

- Money exato e imutável; Wallet com crédito/débito; lançamento auditável.
- PostgreSQL e LocalStack via Docker Compose e oito migrações versionadas.
- POST /wallets: criação com OPENING + ledger para saldo inicial positivo.
- GET /wallets/:walletId: consulta, validação do UUID e resposta 404.
- GET /wallets/:walletId/ledger: extrato paginado com cursor estável e opaco.
- GET /wagering/transactions/:transactionId: consulta de operação pelo UUID.
- GET /providers/:providerId/wagering/transactions/:externalTransactionId: consulta pela identidade no provedor.
- POST /wallets/:walletId/reconciliation: compara saldo com créditos menos débitos.
- GET /metrics: status de transações, duplicatas, retries, DLQ, locks, outbox e latência, além da reconciliação.
- GET /health/live: processo vivo.
- GET /health/ready: PostgreSQL e as três filas SQS acessíveis; 503 quando indisponíveis.
- POST /wagering/transactions: BET, WIN, LOSS, REFUND e ROLLBACK.
- LOSS registra o resultado sem novo débito, sem ledger e sem mudar a versão.
- BET com bloqueio por carteira no PostgreSQL, saldo/ledger/resultado atômicos.
- Idempotência persistente, conflito de payload e replay da resposta original.
- Rejeições por saldo, moeda, jogador e valor zero, sem débito nem ledger.
- Proteção contra alteração/exclusão de transações terminais no banco.
- SQS com inbox persistente, confirmação após commit, backoff e DLQ.
- Eventos gravados com a operação financeira e publicados por outbox concorrente.

## Fluxo para estudar

HTTP -> WageringController -> ProcessTransaction -> domínio + repositórios -> MikroORM -> PostgreSQL.

1. O controller recebe JSON e Idempotency-Key.
2. ProcessTransaction valida a entrada e calcula o hash canônico dos campos de negócio.
3. Dentro da transação SQL, procura uma execução anterior e devolve replay se existir.
4. Bloqueia somente a linha da carteira com SELECT FOR UPDATE.
5. Insere a transação pendente via QueryBuilder; constraints únicas arbitram duplicatas concorrentes.
6. WagerTransaction verifica jogador, moeda, valor e saldo.
7. BET aceita chama Wallet.debit; LOSS aceita apenas registra o resultado da rodada.
8. Os repositórios gravam saldo, ledger quando necessário, estado final e resposta no mesmo commit.
9. O controller responde 200 para aplicada ou 422 para rejeição de negócio.

O saldo da resposta fica salvo: outra movimentação não altera um replay antigo.
Uma falha antes do commit desfaz o conjunto, inclusive inbox e outbox.
SQS chama o mesmo ProcessTransaction; os eventos só saem depois do commit.

## Onde procurar

Os testes ficam em `src/wallets/tests/`, `src/wagering/tests/` e `src/messaging/tests/`.
O auxiliar que inicia os processos de teste fica junto dos testes de wagering.
Os comandos test, test:unit e test:integration continuam iguais.

- src/main.ts: inicia Nest; src/app.module.ts: registra controllers e banco.
- src/database/database.service.ts: abre/fecha ORM e fornece EntityManager.
- src/database/orm.config.ts: conexão, mapeamentos e lista de migrações.
- src/database/migrations/: histórico SQL; não alterar migrações já aplicadas.
- src/wallets/: Money, Wallet, ledger, abertura, controller e mapeamento da carteira.
- src/wagering/transaction-input.ts: validação compartilhável e hash canônico.
- src/wagering/wager-transaction.ts: regras das cinco operações e referências e proteção de estado terminal.
- src/wagering/process-transaction.ts: coordena processamento e transação SQL, sem SQL manual.
- src/wagering/transaction-result.ts: formato da resposta persistida e devolvida pela API.
- src/wagering/wager-transaction.schema.ts: mapeamento de transações financeiras.
- src/wagering/wager-transaction.repository.ts: consulta, reserva idempotente e conclusão.
- src/wallets/wallet.repository.ts: leitura, bloqueio, reidratação e gravação da carteira.
- src/wallets/wallet-ledger-entry.schema.ts: mapeamento de lançamentos.
- src/wallets/ledger.repository.ts: inserção de lançamentos, sem métodos de alteração/exclusão.
- src/wagering/wagering.controller.ts: adaptação HTTP.
- src/wagering/tests/process-transaction.integration.test.ts: testes com banco temporário real.
- src/wagering/tests/transaction-process.fixture.ts: auxiliar dos testes com três processos Bun.

Migrations mudam a estrutura; WalletSchema mapeia colunas; rehydrate reconstrói
objetos de domínio. Não são três implementações da mesma responsabilidade.

Exemplo do código atual, dentro da mesma transação SQL:

```ts
if (entry) {
  await wallets.save(wallet);
  await ledger.append(entry);
}
await transactions.saveOutcome(transaction, result, attempts, nextAttemptAt);
```

flush envia as alterações ao banco; o commit continua sendo responsabilidade de
transactional. A troca por repositórios não divide a operação em vários commits.
Ainda há SQL nas migrações e testes de integridade. Na aplicação, SQL explícito
configura timeouts e calcula a reconciliação; o restante usa os repositórios ORM.

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
- LOSS persistida e repetida sem lançamento nem mudança de saldo/versão.
- Leitura ORM de valores grandes, centavos, datas e resposta JSON preservados.

Esses testes não equivalem aos testes de três servidores Nest completos com SQS.
O bloco de mensageria acrescentou morte real de um consumidor após commit/antes do ack.

## Próximos passos para entrega

1. Revisar as decisões e limitações documentadas para a entrevista.
2. Conferir o diff e preparar commit/entrega quando solicitado.

Compose com três APIs, ponto de extensão de autenticação e permissões do banco
foram implementados. O teste scripts/verify-cluster.ts confirmou disputa de saldo,
50 replays entre três APIs, reinício de app1 e reconciliação final com saldo 20.00.
As três APIs ficaram saudáveis e todos os eventos da demonstração foram publicados.

## Bloco de referências e reversões — 16/10/2026

REFUND, ROLLBACK e WIN com referência estão implementados. O campo de entrada é
referenceExternalTransactionId e aponta para o ID do provedor, nunca o UUID interno.
REFUND só referencia BET; ROLLBACK referencia BET/WIN/REFUND; WIN referencia BET.
Os contextos devem coincidir e reversões devem ter o mesmo valor da referência.

Exemplo: REFUND de 80 chega antes da BET de 80. O saldo continua 100, a resposta
é 202/PENDING_REFERENCE. A BET chega e reduz para 20. O worker encontra a
referência e credita 80, deixando 100. São dois lançamentos além da abertura.

Arquivos para estudar:

- wager-transaction.ts: valida a referência e determina crédito/débito.
- process-transaction.ts: execute e retryPending usam applyAndSave.
- wager-transaction.repository.ts: busca referência, duplicidade e agenda vencida.
- reference-retry-policy.ts: dez avaliações e espera exponencial com teto de 60s.
- reference-retry.worker.ts: consulta a agenda a cada segundo e aguarda o lote no shutdown.
- tests/references.*.test.ts: regras, concorrência, fora de ordem, prazo e PostgreSQL real.

Repetir uma operação pendente apenas consulta seu resultado atual; não força retry.
Ao esgotar tentativas a rejeição é definitiva e gera WagerTransactionRejected na outbox.

## Acordo de trabalho

O usuário autorizou edição automática para a reorganização, referências/reversões
e os blocos de mensageria, consultas/reconciliação e observabilidade. Manter incrementos pequenos e explicar o que mudou.
Explicar um bloco coerente por vez, com objetivo, motivo, ação e verificação.
Não declarar requisitos futuros concluídos; consultar a lista acima ao retomar.

## Mensageria: executar e entender

Na raiz do repositório, PowerShell:

```powershell
docker compose up -d
bun run migrate:up
bun run queues:setup
bun run start
```

Os três primeiros comandos preparam containers, tabelas e filas. O último inicia
HTTP, consumidor SQS, publisher da outbox e worker de referências. Se o Nest já
estava aberto sem watch, reinicie-o para carregar o código novo.

Fluxo: SQS -> SqsConsumer -> ProcessTransaction -> commit conjunto -> delete no SQS.
Separadamente: OutboxPublisher -> lê evento confirmado -> envia ao SQS -> marca publicado.

- inbox-message.ts: controla a conclusão de uma mensagem recebida.
- message.repository.ts: reserva a inbox pela chave única e grava eventos usando ORM.
- integration-event.ts: classe abstrata e os quatro tipos concretos de evento.
- outbox-message.ts: controla publicação e próximo retry.
- sqs.consumer.ts: recebe, processa, confirma ou encaminha para retry/DLQ.
- outbox.publisher.ts: seleciona evento com lock, publica e salva o resultado.
- messaging.worker.ts: agenda consumidor, publisher e auditor da DLQ; aguarda trabalho ao encerrar.

Exemplo: salvar BET e cair antes do ack deixa a mensagem reaparecer. A inbox
informa que ela foi concluída; o saldo não é debitado novamente. Cair antes de
publicar deixa o evento na outbox para outro publisher assumir.

Para experimentar, salve o envelope da seção 10 do README em um JSON, usando
playerId/walletId reais. Na raiz rode `bun run sqs:send .\message.json`.
Repetir o mesmo arquivo força nova entrega no broker, mas a inbox impede novo efeito.
Consulte a carteira por GET /wallets/:walletId. O script não cria carteiras.

Filas: wager-transactions.fifo, wager-transactions-dlq.fifo e wager-events.fifo.
As duas primeiras recebem operações e falhas; a terceira recebe eventos de saída.
Executar `bun run queues:setup` novamente é seguro com a mesma configuração.
LocalStack está sem persistência de filas: se recriar seu container, execute setup
novamente. Não usar isso como simulação de durabilidade do serviço gerenciado AWS.
Eventos já marcados publicados não são republicados automaticamente se o broker
local for apagado. O banco conserva os envelopes para auditoria/reenvio operacional.

## Consultas e reconciliação

Exemplo: abertura de 100, BET de 80 e WIN de 10 produzem três lançamentos.
A reconciliação calcula 100 - 80 + 10 = 30 e compara com o saldo salvo de 30.
Se alguém alterasse o saldo para 29.99 sem ledger, retornaria consistent=false
e difference=-0.01. A API registra a divergência, mas não a corrige.

Na raiz do repositório, com o Nest reiniciado, use um UUID de carteira existente:

```powershell
$walletId = "SUBSTITUA-PELO-UUID-DA-CARTEIRA"
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/wallets/$walletId/reconciliation" | ConvertTo-Json -Depth 5
$page = Invoke-RestMethod "http://localhost:3000/wallets/$walletId/ledger?limit=2"
$page | ConvertTo-Json -Depth 5
if ($page.nextCursor) {
  Invoke-RestMethod "http://localhost:3000/wallets/$walletId/ledger?limit=2&cursor=$($page.nextCursor)" | ConvertTo-Json -Depth 5
}
```

Esperado: consistent=true e difference.amount="0.00". O extrato devolve items
e nextCursor; null indica fim. Novos lançamentos exigem iniciar nova consulta.
O cursor é um marcador para continuar a leitura; o cliente só o devolve à API.

Onde estudar: WalletsController recebe parâmetros; LedgerRepository consulta
o extrato e calcula a reconciliação. TransactionQueriesController expõe as duas
consultas de operações. DatabaseHttpFilter uniformiza erros temporários como 503.
A migração Migration202610160004 acrescenta somente sequência de paginação e índice.
ReconciliationMetrics conta verificações/divergências por processo; o bloco de
observabilidade acrescenta as demais métricas abaixo.

## Observabilidade: sinais para diagnosticar o sistema

Liveness responde "o processo está vivo?". Readiness responde "ele consegue
acessar suas dependências?". Se SQS cair, live continua 200 e ready passa a 503.
Não precisamos derrubar o processo para indicar indisponibilidade.

Com o Nest atualizado e os containers rodando, em qualquer pasta do PowerShell:

```powershell
Invoke-RestMethod http://localhost:3000/health/live
Invoke-RestMethod http://localhost:3000/health/ready | ConvertTo-Json -Depth 5
(Invoke-WebRequest http://localhost:3000/metrics -UseBasicParsing).Content
```

Esperado: ready retorna status=ok e dependencies.postgres/sqs=up. Metrics usa
texto Prometheus: cada nome identifica uma medição e cada linha traz seu valor.

- wager_transactions{status="PROCESSED"}: operações nesse estado no banco, incluindo OPENING.
- wager_duplicates_total: replays detectados pelo processo.
- worker_retries_total: retries separados entre sqs, outbox e reference.
- sqs_dlq_sent_total: envios à DLQ confirmados pelo SDK neste processo.
- sqs_dlq_messages: quantidade aproximada na DLQ consultada no broker, incluindo redrive automático.
- sqs_metrics_up: 0 quando não foi possível ler a DLQ; nesse caso sua quantidade é omitida.
- database_lock_conflicts_total: erros de lock/deadlock/serialização observados.
- outbox_pending e outbox_lag_seconds: quantidade pendente e idade do evento pendente mais antigo.
- transaction_processing_seconds: histograma de duração, separado entre http, sqs e reference.
- reconciliation_checks_total e reconciliation_divergences_total: verificações e divergências.

Logs são linhas JSON com identificadores para relacionar os acontecimentos.
Quando existe transação, correlationId é seu UUID. Campos não disponíveis ficam
null. A lista de campos permitidos exclui dinheiro, payload, headers e erros brutos.
Arquivos principais: observability/logger.ts, metrics.ts, metrics.controller.ts
e health/readiness.service.ts. Nenhuma migração nova foi necessária neste bloco.

Contadores locais reiniciam com cada processo; estados no banco e contagem do
broker são consultados novamente. Nenhuma métrica garante idempotência financeira.

## Falha técnica definitiva: o que acontece com a mensagem?

Imagine que uma aposta não conseguiu ser salva após cinco tentativas. Ela vai
para a DLQ, a fila que recebe mensagens cujo processamento falhou. Um worker
arquiva essa mensagem no PostgreSQL e registra FAILED, sem debitar a carteira.
Só depois de salvar tudo confirma a remoção da fila. Se a gravação falhar,
nada fica parcialmente salvo e a mensagem pode ser recebida novamente.

Uma aposta já processada nunca vira FAILED só porque reapareceu na DLQ.
Repetir um comando FAILED devolve sua falha original: não tenta apostar de novo.
Mensagens inválidas também ficam arquivadas, mas sem criar transações fictícias.

Arquivos para acompanhar o fluxo: messaging/dead-letter.consumer.ts recebe e
arquiva; wagering/process-transaction.ts registra a falha usando a mesma proteção
de identidade das apostas; Migration202610160005 cria dead_letter_messages.
A métrica dead_letter_archived mostra quantas mensagens foram arquivadas.

## Ponto de extensão de autenticação concluído

Um guard é uma verificação que o Nest executa antes de chamar o controller.
Fluxo HTTP atual: requisição -> ProviderAuthGuard -> controller -> caso de uso.
O nosso guard retorna true, permitindo acesso sem login, conforme a decisão de
escopo. No futuro ele poderá validar um token de um provedor externo de identidade.
Health fica fora dessa verificação; SQS continua chamando o caso de uso diretamente.
Não confundir esse ponto de extensão com segurança implementada.

## Como retomar após o bloco de entrega

Os containers app1, app2 e app3 estão nas portas 3001, 3002 e 3003. O setup executa
as migrations e configura as filas e o papel restrito antes de iniciar essas APIs.
Para reproduzir, execute na raiz do projeto:

```powershell
docker compose -f compose.yaml -f compose.app.yaml up -d --build
bun run scripts/verify-cluster.ts
```

O script deixa uma carteira de demonstração no banco. A primeira validação deste
bloco usou a carteira 04a4adf7-ed45-4e62-ac07-27d0313a0dcc: saldo final 20.00,
um crédito de abertura e um débito de aposta. A versão final é 2.

Para explicar na entrevista: três APIs recebem trabalho, mas o PostgreSQL decide
quem pode alterar uma carteira por vez. A instância não guarda a garantia em
memória. Por isso reiniciar app1 não faz esquecer uma aposta nem aplicar seu débito
novamente. O usuário restrito acrescenta uma barreira: a aplicação pode inserir
lançamentos, mas não editar, excluir ou truncar o ledger.

## Preparação da apresentação

[APRESENTACAO.md](APRESENTACAO.md) reúne o fluxo, os comandos da demonstração,
as decisões para defender e as limitações conhecidas. A última revisão corrigiu
textos antigos sobre inbox/outbox, campos do hash canônico e workers da DLQ.
A taxonomia completa de failureCode está em ARCHITECTURE.md.

Próximo exercício: explicar o replay após commit seguido de queda antes da resposta.
As alterações continuam locais: ainda não houve commit ou publicação nesta etapa.
