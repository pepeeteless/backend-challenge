# Decisões de arquitetura — implementação incremental

Este documento registra a implementação atual, não declara o desafio concluído.
O README original continua sendo a fonte dos requisitos.

## Organização e fluxo financeiro

`WageringController -> ProcessTransaction -> WagerTransaction + Wallet -> PostgreSQL`.

- Controller adapta HTTP: recebe body/header e escolhe o status da resposta.
- ProcessTransaction valida o contrato compartilhável e coordena a transação SQL.
- WagerTransaction decide se as cinco operações podem ser aplicadas; Wallet faz a aritmética e
  produz o lançamento. Essas classes não importam Nest nem ORM.
- WalletRepository carrega/reidrata e salva carteiras; LedgerRepository apenas
  acrescenta lançamentos; WagerTransactionRepository consulta identidades, reserva
  transações pendentes e grava resultados. Todos usam o MESMO EntityManager
  fornecido pelo bloco transactional, sem abrir transações independentes.
- As tabelas têm EntitySchema. Leituras usam find/findOne; gravações comuns
  usam create/persist/flush e alterações em registros gerenciados. A reserva
  idempotente usa QueryBuilder.insert().onConflict().ignore().returning(), que
  gera INSERT ON CONFLICT DO NOTHING, sem sobrescrever transações existentes.
- SQL manual no fluxo da aplicação fica em SET LOCAL lock_timeout no
  WalletRepository e na agregação de reconciliação no LedgerRepository.
  SQL também permanece nas migrações e nos testes que
  precisam inspecionar o banco independentemente dos repositórios.
- ProcessTransaction e OpenWallet ainda dependem de EntityManager para delimitar
  a transação SQL. Não introduzimos interfaces genéricas nem um framework de
  repositórios: cada classe tem métodos específicos do caso de uso.
- Os mapeamentos cobrem todas as colunas, mas não reproduzem todas as FKs,
  constraints, índices parciais e triggers das migrações. A geração automática
  de diferenças exige revisão; não aplicar schema update para substituir migrations.

## Precisão monetária

Money usa decimal.js, com precisão 21, e retorna novos valores nas operações.
Entradas têm exatamente duas casas e nunca são convertidas para number.
Limite: 999999999999999999.99; PostgreSQL usa numeric(20,2), lido como string.
O dígito adicional permite somar dois valores no limite antes de rejeitar overflow.
O esquema verifica também os limites, a não-negatividade e a aritmética do ledger.

## Atomicidade e concorrência

ProcessTransaction usa EntityManager.transactional e SELECT FOR UPDATE, via
LockMode.PESSIMISTIC_WRITE, na linha da carteira. O bloqueio pertence ao PostgreSQL,
não à memória do processo, e termina no commit/rollback. Wallets diferentes podem
prosseguir em paralelo. READ COMMITTED é o isolamento padrão utilizado.

Duas BET de 80 contra saldo 100: a primeira lê 100 e confirma 20; a segunda obtém
o lock depois e lê 20, ficando REJECTED/INSUFFICIENT_FUNDS. Apenas a primeira gera
ledger e incrementa versão. O lock tem espera máxima de 5 segundos; conflito
transitório resulta em 503 para reenvio com a mesma chave.

Saldo, versão, BET, ledger e resposta de replay são confirmados juntos. Falhar
ao gravar o ledger desfaz as outras alterações. Não se captura erro de banco
dentro da transação para continuar trabalhando numa transação abortada.

Inbox (na entrada SQS) e outbox participam desse mesmo commit. O publisher
consulta somente eventos confirmados; falhas de gravação desfazem o conjunto.

## Idempotência

- Header Idempotency-Key obrigatório; sem fallback silencioso para outro campo.
- Chave única global no banco. Também UNIQUE(provider_id, external_transaction_id).
- Mesma identidade externa com chave diferente é conflito, mesmo com payload igual.
- Body estrito: campos desconhecidos são rejeitados. As cinco operações são aceitas; OPENING continua interna.
- Canonicalização: validar campos, normalizar UUIDs para minúsculas, serializar
  amount com Money.toJSON, ordenar recursivamente as chaves e calcular SHA-256
  do JSON UTF-8. Participam providerId, externalTransactionId, playerId, walletId,
  roundId, gameId, kind, money e referenceExternalTransactionId quando presente.
  Header/metadados de transporte não participam.
- Zeros à esquerda em amount são normalizados: 080.00 e 80.00 são equivalentes.
- INSERT ON CONFLICT DO NOTHING, gerado pelo QueryBuilder, deixa as constraints arbitrarem concorrência.
  Se outra execução ganhou, reler e comparar chave/hash antes de devolver replay.
- Resposta JSON persistida na mesma transação. Reenvio devolve transactionId,
  status, saldo original e failureCode originais; só idempotentReplay muda para true.
- Uma queda antes do commit permite tentar novamente. Depois do commit, o resultado
  persistido permite replay inclusive com um novo processo. Recuperação SQS foi
  verificada com morte do consumidor após commit e antes do ack.

## Estados e rejeições

Transições: PENDING -> PROCESSED, REJECTED, PENDING_REFERENCE ou FAILED.
Retries podem sair de PENDING_REFERENCE para PROCESSED/REJECTED. FAILED é
registrado na auditoria de falhas esgotadas, conforme descrito ao final.
PROCESSED/REJECTED/FAILED são terminais; o domínio impede reaplicação e um trigger
impede UPDATE/DELETE de registros terminais no banco, inclusive OPENING.

BET zero é rejeitada com INVALID_AMOUNT (decisão de escopo: débito deve ser positivo).
Saldo insuficiente: INSUFFICIENT_FUNDS. Jogador divergente: PLAYER_MISMATCH.
Moeda divergente: CURRENCY_MISMATCH. Rejeições ficam persistidas e não geram ledger.
LOSS marca o resultado como PROCESSED sem chamar debit/credit, sem alterar versão
e sem gerar ledger. O estado da transação determina o resultado, não a existência
de lançamento. O money recebido é registrado, mas não descontado novamente.
Abertura HTTP continua limitada a BRL; BET permite códigos de três letras para
testar conflitos. Validação completa do catálogo ISO-4217 continua pendente.

A FK da transação financeira passou a referenciar wallet_id, permitindo auditar
rejeições em outra moeda. Transações PROCESSED têm a moeda conferida por trigger;
as duas FKs compostas do ledger continuam exigindo moeda/valor compatíveis.

Carteira ausente é erro de consulta 404, antes de aceitar/persistir uma BET, pois
não existe wallet para vincular. Payload inválido e conflito de identidade também
não criam outra transação. Essa distinção é uma decisão explícita do contrato.

## HTTP implementado

- POST /wallets: 201; duplicidade jogador/moeda: 409.
- GET /wallets/:walletId: 200, UUID inválido: 400, inexistente: 404.
- POST /wagering/transactions: operação aplicada ou replay aplicado: 200; pendência de referência: 202;
  rejeição/replay rejeitado: 422; payload/header inválido: 400;
  conflito de idempotência: 409; wallet ausente: 404;
  falhas transitórias de conexão/lock identificadas: 503.
- GET /health/live: 200. GET /health/ready: 200 ou 503 conforme PostgreSQL e SQS.

Erros inesperados continuam 500: não são convertidos silenciosamente em rejeição
de negócio. Respostas transitórias não são persistidas como resultado final.

## Referências, reversões e reprocessamento

- REFUND exige BET PROCESSED e credita o valor integral. ROLLBACK aceita BET
  (crédito inverso), WIN ou REFUND (débito inverso). Referência em estado terminal
  não processado é rejeitada. WIN pode ter uma BET como referência opcional e o
  prêmio não precisa ser igual à aposta.
- Resolver sempre por providerId + referenceExternalTransactionId. Em seguida
  validar jogador, carteira, moeda, rodada, tipo, estado e valor para reversões.
  gameId não é exigido igual: o README exige a mesma rodada, não o mesmo jogo.
- REFUND e ROLLBACK têm unicidade separada por referência/tipo, conforme texto
  do README. Portanto uma BET pode receber um REFUND e um ROLLBACK, mas não dois
  REFUND nem dois ROLLBACK. Essa interpretação precisa ser destacada na apresentação.
- O registro original e seu ledger nunca são alterados: a reversão produz outro
  registro e outro lançamento. Reversão de crédito gasto é REJECTED com
  REVERSAL_INSUFFICIENT_FUNDS; crédito acima do limite é BALANCE_LIMIT_EXCEEDED.
- Payload sem referência obrigatória, autorreferência ou referência em BET/LOSS
  é 400. Referência em WIN é opcional. A referência faz parte do hash canônico;
  ausência do campo mantém os hashes das operações antigas sem referência.
- Referência ausente ou ainda não terminal produz PENDING_REFERENCE, sem ledger.
  A resposta 202 é persistida. Reenvios não aceleram o agendamento: devolvem o
  resultado atual. Depois da conclusão, o resultado terminal fica congelado
  e seus replays preservam o saldo observado na conclusão.
- ReferenceRetryWorker consulta até 25 operações vencidas a cada segundo. Usa
  ProcessTransaction.retryPending, que reaproveita a mesma aplicação de regras
  e persistência de execute. Pode ser desativado com REFERENCE_WORKER_ENABLED=false.
- Contagem e próxima data ficam no PostgreSQL. São 10 avaliações de referência
  indisponível, incluindo a primeira entrega. Esperas de 1, 2, 4, 8, 16, 32, 60,
  60 e 60 segundos (aproximadamente 4 minutos sem indisponibilidade do banco).
  Esse limite curto facilita demonstrar recuperação no desafio; produção exigiria
  uma janela alinhada ao atraso máximo acordado com o provedor.
- No limite: REFERENCE_NOT_FOUND se a referência não existe, REFERENCE_NOT_READY
  se ainda está pendente. Não há ressurreição depois de REJECTED, mesmo se a
  referência chegar mais tarde. Falhas de infraestrutura desfazem a tentativa e
  não consomem essa contagem de negócio.
- Workers concorrentes bloqueiam primeiro a carteira, depois releem estado/data.
  Um worker que esperou o lock não reaplica trabalho já concluído ou reagendado.
  A parada do Nest aguarda o lote em andamento antes de fechar o ORM.
- Migration202610160002 adiciona FK para a referência, agenda persistente,
  índice de busca de pendências, índice único parcial de reversões processadas e
  trigger que valida contexto/tipo/valor da referência ao concluir. O down remove
  essas estruturas e metadados; seu teste ocorre apenas em banco descartável.

Eventos de processamento, rejeição e pendência são gravados na outbox junto com
o estado financeiro. Reavaliações ainda pendentes não repetem o evento de pendência;
a conclusão ou rejeição final gera seu evento correspondente.

## Migrações e testes

Migrações são versionadas e executadas pela API oficial do MikroORM. A nova
Migration202610160001 preserva as OPENING existentes e adiciona identidade,
resposta persistente, constraints e trigger de proteção.

O down restaura o schema anterior e remove as novas colunas. Se existirem rejeições
em moeda diferente, a FK antiga não pode ser restaurada: PostgreSQL aborta o down
inteiro. Isso evita apagar/reescrever auditoria silenciosamente. Downgrades com
dados incompatíveis requerem plano específico; não executar down no banco de
trabalho para testar. O teste de up/down usa banco descartável compatível.

Os novos testes criam um banco wager_test_<UUID> separado, aplicam migrations e
fazem commits reais para testar concorrência entre conexões/processos. Depois
removem somente esse banco. O usuário local pepe precisa de CREATEDB (o Compose
atual cria um superuser de desenvolvimento). Nunca executar esses testes em produção.

## Estado da entrega

Três servidores Nest em containers e demonstração de reinício foram verificados
com scripts/verify-cluster.ts; detalhes de execução estão ao final deste documento.
Autenticação foi adiada conforme a seção 2 do README. O ponto de extensão
ProviderAuthGuard está conectado às rotas HTTP; o desenho está descrito abaixo.
Não há autorização por provedor nesta etapa.

O usuário de migrações local é superuser: triggers não protegem contra intervenção
administrativa. As APIs no Compose usam um papel restrito, descrito ao final.

## Inbox, outbox e SQS

- LocalStack 4.14.0 com SQS; SDK oficial @aws-sdk/client-sqs. Setup explícito via
  bun run queues:setup. Filas FIFO exigidas mais wager-events.fifo para saída.
- HTTP e SQS chamam ProcessTransaction.execute. O transporte SQS fornece
  consumerName e messageId. INSERT ON CONFLICT reserva a inbox na mesma transação
  SQL que saldo, ledger, resultado e outbox. Colisão concorrente aguarda o commit;
  rollback libera a reserva. A chave primária é (consumer_name, message_id).
- Hash da inbox: SHA-256 de [hash financeiro canônico, idempotencyKey]. Mudanças
  só em occurredAt/ID do transporte não alteram a operação. Reutilizar messageId
  com conteúdo/chave diferente é conflito permanente, enviado à DLQ.
- Inbox armazena a resposta da entrega concluída. Um pending já confirmado por
  SQS não precisa ser reaplicado: worker de referências é responsável por avançar
  seu estado. Consulta/replay HTTP pode observar a conclusão posterior.
- Consumer confirma com DeleteMessage apenas depois de execute resolver o commit.
  PROCESSED, REJECTED e PENDING_REFERENCE recebem ack. Envelope/payload inválido,
  wallet inexistente e conflitos de identidade seguem imediatamente para DLQ.
  Wallet inexistente é interpretada como erro de entrada; somente referências
  entre operações possuem espera automática no contrato atual.
- Outros erros recebem até cinco entregas: esperas 2, 4, 8, 16 segundos antes
  da quinta tentativa, depois DLQ. A fila também tem redrive maxReceiveCount=5
  como proteção para processos que morrem sem tratar o erro. Envia-se para DLQ
  antes de remover a origem, evitando perda; duplicatas na DLQ ainda são possíveis.
- Visibilidade de 30s, renovada a cada 10s enquanto processa. SIGTERM para de
  buscar novos trabalhos e aguarda os atuais; morte abrupta permite redelivery
  após expirar a visibilidade. Não depende de liberação manual de locks.
- Outbox usa SELECT FOR UPDATE SKIP LOCKED pelo MikroORM (PESSIMISTIC_PARTIAL_WRITE).
  Cada publisher bloqueia somente seu evento, envia com timeout e marca publicado
  na mesma transação curta da outbox. Nenhuma linha de wallet fica bloqueada
  durante chamadas ao broker. Essa estratégia ocupa uma conexão durante o envio;
  foi escolhida por simplicidade em vez de introduzir leases e recuperação de leases.
- Falhas de publicação incrementam attempts e persistem nextAttemptAt com backoff
  2, 4, 8, 16, 32, 60s, teto 60. Outbox não descarta eventos por limite de tentativas:
  eventos financeiros confirmados precisam continuar disponíveis para publicação.
- Queda após envio e antes de marcar publishedAt pode republicar. eventId e payload
  permanecem iguais; MessageDeduplicationId=eventId reduz duplicatas no broker,
  mas não substitui deduplicação persistente do consumidor downstream por eventId.
  Não existe consumidor de negócio de eventos de saída neste desafio. O teste
  mostra um consumidor de exemplo com recibo SQL único, fora da janela lógica
  de proteção FIFO, para documentar esse contrato de integração.
- Publishers podem entregar eventos de uma wallet fora de ordem. Cada evento
  WalletBalanceChanged inclui walletVersion; consumidores de projeção precisam
  considerar versão/deduplicação. FIFO não é a garantia financeira.
- Eventos usam classe abstrata e subclasses concretas; dados são copiados e
  congelados recursivamente, datas serializadas em ISO e dinheiro em MoneyProps.
  correlationId é o UUID da transação financeira; causationId, quando disponível,
  é o messageId recebido. OPENING positiva emite processamento e mudança de saldo;
  LOSS apenas processamento; rejeição não emite mudança de saldo.
- Migration202610160003 cria tabelas, unicidade da inbox, checks e índice parcial
  de eventos pendentes. Down remove inbox/outbox: testar reversibilidade apenas
  em banco descartável, pois remover essas tabelas descarta auditoria/eventos.
- Variáveis opcionais: SQS_ENDPOINT, AWS_REGION, AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY, SQS_QUEUE_PREFIX. Defaults locais test/test em us-east-1.
  MESSAGING_WORKER_ENABLED=false desabilita consumidor, publisher e auditor da DLQ.
- LocalStack não persiste filas nesta configuração mínima. Recriar o container
  exige setup e não restaura mensagens já publicadas. Isso é limitação do ambiente
  local, não uma garantia de recuperação contra perda do armazenamento do broker.

Referências: [visibilidade e recuperação SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/designing-for-outage-recovery-scenarios.html),
[DLQ](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html),
[SQS no LocalStack](https://docs.localstack.cloud/aws/services/sqs/).

## Consultas, paginação e reconciliação

- As consultas por UUID e (providerId, externalTransactionId) compartilham o
  mesmo formato: identidade, estado, MoneyProps, referência, failureCode, datas
  e result com a resposta persistida. Não expõem payloadHash/idempotencyKey.
  OPENING é consultável por UUID; não tem identidade externa nem response,
  portanto esses campos são null. Consulta de operação rejeitada é 200 com seu
  status REJECTED; apenas a submissão dessa rejeição usa 422.
- UUID/parâmetros inválidos retornam 400, recurso inexistente 404. O filtro
  DatabaseHttpFilter preserva erros HTTP explícitos, converte falhas transitórias
  conhecidas do banco em 503 e oculta detalhes internos de erros inesperados (500).
- Ledger retorna {items, nextCursor}. Limit padrão 50, mínimo 1, máximo 100;
  busca limit+1 para saber se existe outra página. Ordenação por sequence crescente.
  Migration202610160004 adiciona bigserial e índice único (wallet_id, sequence),
  sem mudar identidade ou conteúdo financeiro de lançamentos existentes.
  O backfill dos registros históricos não promete ordem cronológica; a sequência
  serve como ordem estável de paginação. Novos lançamentos recebem sequência no
  INSERT, sob o lock da carteira já usado pelo processamento financeiro.
- Cursor v1 em base64url contém walletId, último sequence e limite superior da
  primeira página. Não usa offset nem depende da precisão de Date do JavaScript.
  Sequence é string/BigInt, nunca convertido para number. Novos lançamentos
  após a primeira página ficam fora dessa navegação; iniciar nova consulta os inclui.
  Essa estabilidade pressupõe que todos os escritores respeitem o lock por wallet.
- Cursor é opaco como contrato de API, não criptografado/assinado. Formato,
  versão, limites bigint e pertencimento à wallet são validados. Ele não é uma
  credencial nem substitui autorização. Escrita administrativa direta é fora
  da garantia de paginação; aplicação não altera nem exclui lançamentos.
- Reconciliação executa uma única consulta SQL parametrizada pelo EntityManager.
  PostgreSQL lê wallet e ledger no mesmo snapshot, evitando comparar saldo antes
  de um commit com ledger depois dele. Não bloqueia movimentações da carteira.
  Soma CREDIT e subtrai DEBIT, incluindo OPENING; não usa balanceAfter como fonte.
- A agregação e a diferença usam numeric no banco, devolvidos como strings.
  Isso também permite diagnosticar saldo calculado negativo ou acima do limite
  de Money sem truncar/recusar o relatório. Não carregamos todo o histórico em RAM
  nem somamos créditos separados usando um Money limitado ao saldo máximo.
  SQL está centralizado no repositório; consultas/paginação comuns usam ORM.
- difference = storedBalance - calculatedBalance. HTTP 200 significa que a
  verificação foi realizada; consistent=false sinaliza divergência, sem reparo.
  A API registra log JSON com correlationId/walletId, sem valores financeiros,
  e incrementa reconciliation_divergences_total. Repetir a verificação conta
  outra observação, não uma nova divergência única.
- GET /metrics expõe reconciliation_checks_total e reconciliation_divergences_total
  no formato de texto Prometheus. São contadores por processo que reiniciam com
  ele; monitoramento deve coletar cada instância. O bloco de observabilidade
  acrescenta as demais métricas descritas abaixo. Métricas não são usadas para idempotência.
- Testes HTTP/PostgreSQL cobrem as consultas, namespaces de provedor, pendência
  concluída, páginas sob novas inserções, validação, centavos grandes, histórico
  acumulado acima do limite, corrupção administrativa detectada sem reparo,
  reconciliação concorrente com apostas e resposta 503 para lock timeout real.

## Observabilidade e saúde

- GET /health/live não acessa dependências. GET /health/ready faz SELECT 1 via ORM
  e consulta URLs/atributos das três filas (entrada, DLQ e eventos). Retorna 200
  com dependencies up/down ou 503 se qualquer dependência estiver indisponível.
  Não cria recursos nem publica/consome mensagens no health check.
- Checks de PostgreSQL e SQS rodam em paralelo. Conexão/pool PostgreSQL têm
  connectionTimeoutMillis=2500 no driver pg; a consulta de saúde usa statement_timeout
  de 2s local à transação. SQS usa AbortSignal de 2.5s para todo o check de filas.
  São limites de conexão/consulta, não uma garantia contra toda falha de rede/SO.
- Logs da aplicação usam logEvent e lista permitida de campos. Sempre incluem
  timestamp, level, event, correlationId, messageId, transactionId, walletId e
  providerId. Campos desconhecidos/não aplicáveis são null; não inventamos IDs
  de transações que sofreram rollback. ID de correlação usa transação, mensagem
  ou UUID novo nessa ordem, salvo correlação explícita de evento de saída.
- Conclusões HTTP/SQS são logadas depois que a transação SQL resolve. Replays
  apontam para o mesmo UUID. Falhas logam apenas código técnico sanitizado, sem
  Error/stack/query/headers/body. Nest não usa seu logger textual no bootstrap;
  diagnósticos internos do ORM na aplicação são reduzidos ao evento orm_diagnostic.
  CLI de migrations e fixtures de teste mantêm sua saída própria.
- Métricas usam nomes/labels fixos, nunca walletId, messageId ou providerId como
  labels. Isso impede crescimento ilimitado da quantidade de séries temporais.
  Nenhuma informação monetária entra nas métricas.
- wager_transactions{status} é gauge calculado no PostgreSQL, incluindo OPENING.
  Não incrementamos contadores financeiros antes do commit: um rollback não aparece
  como operação concluída. Replays não aumentam esse gauge. PENDING_REFERENCE que
  conclui sai de um estado e entra no outro. FAILED conta falhas terminais
  registradas pelo auditor da DLQ.
- Duplicatas e latência são observações locais. Latência inclui validação, espera
  por lock e processamento/commit, inclusive falhas e replays. Histograma cumulativo
  em segundos, fontes http/sqs/reference, buckets até 10s e +Inf, com count/sum.
  Retry de referências conta invocações de retryPending, inclusive quando outro
  worker já concluiu. Retry de SQS conta reagendamentos de visibilidade confirmados;
  outbox conta falhas de envio que provocam tentativa de reagendamento.
- database_lock_conflicts_total cobre 55P03, 40P01 e 40001 observados no caso de
  uso/filtro HTTP. WeakSet evita contar o mesmo objeto de erro duas vezes ao
  atravessar camadas; não é cache de idempotência financeira.
- sqs_dlq_sent_total conta envios confirmados, não mensagens únicas. A quantidade
  aproximada atual da DLQ é sqs_dlq_messages, soma visível/em processamento lida
  no SQS. Assim redrive automático também fica observável. Se a leitura falhar,
  expomos sqs_metrics_up=0 e omitimos a quantidade desconhecida (não reportamos zero).
- Outbox pending/lag vêm do PostgreSQL, incluindo eventos em backoff. Lag é idade
  do evento pendente mais antigo, em segundos; fila vazia retorna zero. Essa leitura
  também funciona depois de reiniciar a aplicação. Scrapes são observações, não
  snapshots globais de PostgreSQL+SQS. As agregações são simples e podem ficar
  custosas com muito histórico; para este desafio evitamos cache/agregador extra.
- Cada instância expõe seus contadores locais (zeram ao reiniciar). Gauges do
  banco/broker refletem recursos compartilhados e não devem ser somados entre
  instâncias. Monitoramento deve coletar cada instância separadamente. Não incluímos
  servidor Prometheus, dashboard ou OpenTelemetry, que são opcionais.
- /metrics depende do PostgreSQL: indisponibilidade conhecida retorna 503, sem
  fingir que contagens são zero. Falha apenas no SQS preserva as métricas locais/SQL
  e sinaliza sqs_metrics_up=0. Saúde e métricas não exigem autenticação nesta etapa.
- Testes com dependências reais verificam estado saudável, fila inexistente,
  recuperação, endpoint SQS inacessível, PostgreSQL inacessível, gauges de status e
  outbox, duplicatas, conteúdo dos logs e ausência de dados financeiros. As falhas
  usam endpoints/bancos de teste sem parar os containers de desenvolvimento.

## Falhas terminais e arquivo da DLQ

Depois de cinco tentativas de consumo sem sucesso, a mensagem segue para a DLQ.
O auditor da DLQ roda junto aos outros workers e registra FAILED, com código
INFRASTRUCTURE_RETRY_EXHAUSTED, quando o comando é válido e ainda não tem resultado.
Esgotar tentativas é nossa definição operacional de falha permanente; não significa
que a infraestrutura nunca voltará. FAILED é terminal e não é reaplicado automaticamente.

Na mesma transação PostgreSQL, salva FAILED, resposta original, inbox, evento
WagerTransactionFailed na outbox e corpo original em dead_letter_messages.
Não altera saldo, versão ou ledger. Só depois do commit remove a mensagem da DLQ.
Se o banco estiver indisponível, a mensagem permanece na DLQ para nova tentativa,
inclusive quando chegou ali pelo redrive automático do SQS. A retenção da fila
continua sendo um limite: isso não garante recuperação após indisponibilidade infinita.

Se já existir uma operação, preserva seu resultado, inclusive PENDING_REFERENCE:
o worker de referências continua responsável por ela. Payload inválido, carteira
inexistente ou identidade conflitante são arquivados com o código do erro, sem
inventar uma transação financeira. Savepoint na chamada aninhada permite desfazer
uma reserva de inbox com conflito e ainda arquivar a mensagem na transação externa.

O arquivo é imutável por trigger (UPDATE/DELETE); privilégios administrativos
continuam fora dessa proteção. Guarda o corpo original para investigação, nunca
nos logs. A migração Migration202610160005 tem down, que remove esse histórico;
reversibilidade destrutiva deve ser testada somente em banco descartável.

GET de transação permite consultar FAILED. Repetir POST com a mesma identidade e
payload retorna o resultado original com HTTP 500 e código terminal explícito;
503 continua indicando indisponibilidade temporária. A métrica dead_letter_archived
conta registros persistidos; sqs_dlq_messages mede apenas mensagens ainda na fila.

## Autenticação adiada e ponto de extensão

Priorizamos correção financeira dentro do prazo. ProviderAuthGuard, em
src/auth/provider-auth.guard.ts, é um guard no-op: o Nest o executa antes dos
controllers de carteiras, transações, consultas e métricas, mas ele retorna true.
Isso permite acesso anônimo; não é autenticação implementada. HealthController
não usa esse guard. O consumidor SQS chama o caso de uso diretamente e continua
sujeito às validações de provider, player, wallet, moeda e rodada do domínio.

Em uma integração futura, usaríamos um IdP externo compatível com OIDC, como
Keycloak. O guard validaria assinatura do access token contra as chaves públicas
do IdP, emissor, audiência e validade, sem armazenar senhas ou criar usuários aqui.
A identidade verificada seria anexada ao request. Uma política de autorização
compararia o providerId permitido pelo token com o providerId do comando/consulta;
não confiaríamos no providerId informado pelo cliente como prova de identidade.
Rotas por UUID também exigiriam checagem de acesso ao recurso, e criação de
carteiras, reconciliação e métricas teriam permissões próprias. Token inválido
retornaria 401; identidade válida sem permissão, 403. Health permaneceria público.

Esse desenho futuro não está implementado nem validado por estes testes. O guard
atual marca explicitamente onde integrar essa responsabilidade, mantendo a lógica
financeira reutilizável por HTTP e SQS.

## Execução em três containers e permissões

compose.yaml mantém somente as dependências para estudo. compose.app.yaml adiciona
setup e três APIs com workers, compartilhando PostgreSQL e SQS. setup é uma tarefa
finita: migrations -> permissões -> filas; APIs aguardam sua conclusão. O Dockerfile
usa Bun 1.4.3, lockfile congelado e usuário de sistema não-root. Portas publicadas
ficam limitadas a 127.0.0.1. Reinício não depende de memória para idempotência.

DB_HOST, DB_NAME, DB_USER e DB_PASSWORD permitem trocar a conexão sem editar código.
Defaults continuam locais para os comandos de estudo/testes. Nos containers, o host
é postgres (nome do serviço); localhost apontaria para a própria API.

scripts/setup-runtime-role.ts configura o papel local wager_app após as migrations.
Ele permite SELECT/INSERT/UPDATE nas tabelas operacionais e somente SELECT/INSERT
em ledger e arquivo da DLQ. Não concede DELETE, TRUNCATE, DDL nem acesso à tabela
de controle de migrations. Constraints/triggers continuam ativos. O papel não é
dono das tabelas nem superuser; não pode desabilitar os triggers. O setup pode ser
repetido e reaplica grants explícitos, sem conceder privilégios a futuras tabelas.
As credenciais fixas pertencem somente ao ambiente local. O administrador pepe
continua capaz de intervir; as restrições visam o processo normal da aplicação.

O Compose usa healthchecks reais e 45 segundos para desligamento das APIs. SQS
local continua sem persistência configurada: recriar LocalStack apaga suas filas;
reexecute setup para recriá-las, mas eventos já marcados publicados não são
republicados automaticamente. Reiniciar APIs não recria LocalStack nem apaga filas.

## Taxonomia de falhas financeiras

Todos os códigos abaixo são terminais quando associados a REJECTED ou FAILED.
Reenviar a mesma identidade não reavalia a regra: devolve o resultado persistido.
Corrigir uma operação exige outra identidade e uma decisão consciente do provedor,
nunca gerar chaves novas automaticamente para contornar uma rejeição.

| failureCode | Significado |
|---|---|
| INSUFFICIENT_FUNDS | BET maior que o saldo disponível. |
| REVERSAL_INSUFFICIENT_FUNDS | Reversão debitaria mais que o saldo disponível. |
| CURRENCY_MISMATCH | Moeda da operação difere da carteira. |
| PLAYER_MISMATCH | Jogador informado não é o da carteira. |
| INVALID_AMOUNT | Operação com efeito financeiro exige valor positivo. |
| BALANCE_LIMIT_EXCEEDED | Crédito excederia o limite monetário suportado. |
| REFERENCE_MISMATCH | Contexto da referência não coincide com o da operação. |
| REFERENCE_KIND_INVALID | Tipo da operação referenciada não é permitido. |
| REFERENCE_NOT_PROCESSED | Referência terminou rejeitada ou com falha. |
| REFERENCE_AMOUNT_MISMATCH | Reversão não tem o valor integral da referência. |
| REFERENCE_ALREADY_REVERSED | Já existe reversão processada desse tipo para a referência. |
| REFERENCE_NOT_FOUND | Limite de avaliações atingido sem encontrar a referência. |
| REFERENCE_NOT_READY | Limite atingido com a referência ainda pendente. |
| INFRASTRUCTURE_RETRY_EXHAUSTED | Falha técnica esgotou entregas e foi auditada como FAILED. |

Erros de entrada não são rejeições financeiras: INVALID_PAYLOAD (400),
WALLET_NOT_FOUND (404) e IDEMPOTENCY_CONFLICT (409) não criam outra transação.
Falhas temporárias identificadas retornam 503 e permitem reenvio com a MESMA
identidade. Na fila, erros temporários usam backoff; entradas inválidas seguem
para a DLQ e seu arquivo auditável.
