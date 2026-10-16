# Decisões de arquitetura — implementação incremental

Este documento registra a implementação atual, não declara o desafio concluído.
O README original continua sendo a fonte dos requisitos.

## Organização e fluxo de BET

`WageringController -> ProcessBet -> WagerTransaction + Wallet -> PostgreSQL`.

- Controller adapta HTTP: recebe body/header e escolhe o status da resposta.
- ProcessBet valida o contrato compartilhável e coordena a transação SQL.
- WagerTransaction decide se a BET pode ser aplicada; Wallet faz a aritmética e
  produz o lançamento. Essas classes não importam Nest nem ORM.
- MikroORM gerencia conexão, transação, leitura com lock e atualização de Wallet.
  Transações financeiras e ledger ainda usam SQL parametrizado no mesmo
  EntityManager. Esses mapeamentos completos continuam pendentes; não usar
  geração automática de migrations sem revisar diferenças contra tabelas não mapeadas.

## Precisão monetária

Money usa decimal.js, com precisão 21, e retorna novos valores nas operações.
Entradas têm exatamente duas casas e nunca são convertidas para number.
Limite: 999999999999999999.99; PostgreSQL usa numeric(20,2), lido como string.
O dígito adicional permite somar dois valores no limite antes de rejeitar overflow.
O esquema verifica também os limites, a não-negatividade e a aritmética do ledger.

## Atomicidade e concorrência

ProcessBet usa EntityManager.transactional e SELECT FOR UPDATE, via
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

**Limitação atual:** ainda não há outbox/inbox. Portanto a atomicidade completa
exigida pelo README e a entrega de eventos após falhas NÃO estão concluídas.

## Idempotência

- Header Idempotency-Key obrigatório; sem fallback silencioso para outro campo.
- Chave única global no banco. Também UNIQUE(provider_id, external_transaction_id).
- Mesma identidade externa com chave diferente é conflito, mesmo com payload igual.
- Body estrito: campos desconhecidos são rejeitados. Nesta etapa somente BET é aceita.
- Canonicalização: validar campos, normalizar UUIDs para minúsculas, serializar
  amount com Money.toJSON, ordenar recursivamente as chaves e calcular SHA-256
  do JSON UTF-8. Participam providerId, externalTransactionId, playerId, walletId,
  roundId, gameId, kind e money. Header/metadados de transporte não participam.
- Zeros à esquerda em amount são normalizados: 080.00 e 80.00 são equivalentes.
- INSERT ON CONFLICT DO NOTHING deixa as constraints arbitrarem concorrência.
  Se outra execução ganhou, reler e comparar chave/hash antes de devolver replay.
- Resposta JSON persistida na mesma transação. Reenvio devolve transactionId,
  status, saldo original e failureCode originais; só idempotentReplay muda para true.
- Uma queda antes do commit permite tentar novamente. Depois do commit, o resultado
  persistido permite replay inclusive com um novo processo. Recuperação SQS ainda pendente.

## Estados e rejeições

Neste incremento: PENDING -> PROCESSED ou REJECTED. Os demais estados do README
estão reservados, mas seus fluxos ainda não foram implementados.
PROCESSED/REJECTED/FAILED são terminais; o domínio impede reaplicação e um trigger
impede UPDATE/DELETE de registros terminais no banco, inclusive OPENING.

BET zero é rejeitada com INVALID_AMOUNT (decisão de escopo: débito deve ser positivo).
Saldo insuficiente: INSUFFICIENT_FUNDS. Jogador divergente: PLAYER_MISMATCH.
Moeda divergente: CURRENCY_MISMATCH. Rejeições ficam persistidas e não geram ledger.
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
- POST /wagering/transactions: BET aplicada/replay aplicado: 200;
  rejeição/replay rejeitado: 422; payload/header inválido: 400;
  conflito de idempotência: 409; wallet ausente: 404;
  falhas transitórias de conexão/lock identificadas: 503.
- GET /health/live: 200. Readiness ainda pendente.

Erros inesperados continuam 500: não são convertidos silenciosamente em rejeição
de negócio. Respostas transitórias não são persistidas como resultado final.

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

## Pendências obrigatórias

WIN/LOSS/REFUND/ROLLBACK; referências e reprocessamento; SQS/LocalStack;
inbox/outbox/eventos; retries/DLQ e desligamento; consultas de transações/ledger;
reconciliação HTTP; logs JSON/métricas/readiness; testes de falhas da mensageria.
Autenticação foi adiada: desenho com IdP externo e ponto de extensão no código
ainda precisam ser adicionados. Não há autorização por provedor nesta etapa.

O usuário local é superuser: triggers não protegem contra intervenção administrativa
nem TRUNCATE. Separação de papéis/permissões continua pendente.
