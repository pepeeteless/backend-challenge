# Roteiro para apresentar e defender a solução

Use como guia de estudo, não como texto para decorar. A demonstração é local;
não equivale a um sistema pronto para produção.

## 1. Explique o problema em um minuto

“Uma aposta pode chegar repetida, fora de ordem ou junto de outra aposta na mesma
carteira. A solução precisa impedir débito duplicado e saldo negativo, mesmo com
mais de uma instância e com quedas do processo.”

Mostre o exemplo principal: duas apostas de 80 disputam saldo de 100. Uma passa,
a outra é rejeitada; saldo final 20 e um único débito.

## 2. Mostre o caminho de uma aposta

```text
HTTP -> guard no-op -> controller --+
                                  +-> ProcessTransaction -> PostgreSQL
SQS  -> consumidor ---------------+          |
                                            +-> domínio: WagerTransaction + Wallet + Money

Commit: resultado + saldo + ledger + inbox (se SQS) + outbox
Depois: publisher lê outbox -> SQS de eventos
```

Controller traduz HTTP. Caso de uso coordena a operação. Domínio decide se ela é
permitida. Repositórios traduzem objetos para persistência. O ORM controla a
conexão e a transação SQL, mas não inventa as regras financeiras.

## 3. Demonstre em cerca de três minutos

No PowerShell, na raiz do repositório:

```powershell
docker compose -f compose.yaml -f compose.app.yaml up -d --build
docker compose -f compose.yaml -f compose.app.yaml ps
bun run scripts/verify-cluster.ts
```

O primeiro comando pode demorar ao baixar imagens. Prepare o ambiente antes da
entrevista. Aguarde as três APIs saudáveis antes de rodar o script.

O script verifica a disputa de saldo, 50 replays distribuídos por três APIs,
reinício real de app1 e reconciliação. Ele cria uma carteira nova e mantém sua
auditoria no banco. Resultado esperado: result=ok e balance=20.00.

Use o walletId impresso para mostrar a auditoria:

```powershell
$walletId = "COLE-O-ID-IMPRESSO"
Invoke-RestMethod "http://localhost:3001/wallets/$walletId/ledger" | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method Post "http://localhost:3001/wallets/$walletId/reconciliation" | ConvertTo-Json -Depth 5
```

Explique os dois lançamentos: abertura de 100 e débito de 80. A rejeição não tem
lançamento. Reconciliação soma o histórico e compara com o saldo salvo, sem repará-lo.

## 4. Decisões que você precisa defender

| Pergunta | Resposta que deve conseguir explicar |
|---|---|
| Por que string e decimal.js? | O contrato não perde centavos ao passar por ponto flutuante; o banco guarda numeric e o ORM lê como string. |
| O que torna Money imutável? | Somar/subtrair produz outro Money; não altera o valor usado anteriormente. |
| Por que lock no PostgreSQL? | Um lock em memória protegeria apenas uma instância. O lock na linha da carteira coordena todas elas. |
| E carteiras diferentes? | Cada carteira tem sua própria linha bloqueada; não há um lock global. |
| Para que serve version? | Registra mudanças de saldo e ajuda consumidores de eventos a reconhecer versões. Nesta solução, a concorrência é controlada pelo lock, não pela versão. |
| Por que chave e hash? | A chave identifica a tentativa lógica; o hash detecta se alguém reutilizou essa identidade com conteúdo diferente. |
| Por que salvar a resposta? | Um replay precisa devolver o saldo original, mesmo que a carteira já tenha recebido outras operações. |
| Inbox e idempotência são iguais? | Inbox identifica a entrega por consumidor/messageId; a identidade financeira também deduplica entre HTTP e SQS e entre diferentes mensagens. |
| Por que outbox? | Salvar saldo e depois publicar diretamente deixaria uma janela de perda se o processo caísse. O evento pendente é salvo no mesmo commit. |
| A publicação ocorre exatamente uma vez? | Não. Pode repetir após envio seguido de queda antes da marcação. O consumidor de saída deve deduplicar por eventId. |
| Por que ainda há SQL? | Constraints e triggers pertencem ao banco; agregação de reconciliação precisa de uma leitura consistente. ORM organiza persistência, não elimina todo SQL. |
| Migration e EntitySchema são a mesma coisa? | Migration altera a estrutura real; EntitySchema informa ao ORM como mapear os dados. rehydrate reconstrói o objeto de domínio. |

## 5. Explique três quedas

Antes do commit: PostgreSQL desfaz tudo. O reenvio pode executar a operação.

Depois do commit, antes do ack (confirmação à fila): a mensagem volta; inbox e
identidade persistentes impedem novo efeito financeiro.

Depois de publicar um evento, antes de marcar sua outbox: o evento pode sair de
novo com o mesmo eventId. Não prometemos ausência de duplicatas no transporte.

Referência ausente é outro caso: persiste PENDING_REFERENCE. O worker agendado
reavalia com espera crescente. Após dez avaliações sem resolução, rejeita de forma
auditável. Não mantém uma transação SQL aberta esperando a referência chegar.

## 6. Evidências disponíveis

| Garantia | Onde conferir |
|---|---|
| Aritmética e regras de domínio | src/wallets/tests e src/wagering/tests: arquivos unit.test.ts |
| Atomicidade, idempotência e processos concorrentes | src/wagering/tests/process-transaction.integration.test.ts |
| Inbox, outbox, DLQ e queda antes do ack | src/messaging/tests/messaging.integration.test.ts |
| Extrato estável e reconciliação | src/wallets/tests/queries.integration.test.ts |
| Health, métricas e logs | src/observability/tests |
| Três APIs em containers e reinício | scripts/verify-cluster.ts |

Última execução registrada: 144 testes, zero falhas, 629 asserções; typecheck passou.
O script de três containers é uma verificação adicional. Consulte GUIA.md para
atualizar esses números se modificar o projeto.

## 7. Limitações e escolhas explícitas

- Autenticação foi adiada conforme permitido; o guard permite acesso anônimo.
  A integração futura com IdP e a autorização por provedor estão desenhadas,
  mas não implementadas.
- BRL na abertura; modelo suporta moeda e rejeita conflitos. Não há catálogo ISO completo.
- REFUND e ROLLBACK têm unicidade por tipo: uma BET pode receber um de cada,
  conforme a interpretação documentada da regra 7.4. Destaque essa escolha.
- O ambiente LocalStack não preserva filas quando o container é recriado.
  Reiniciar APIs foi testado; perder o armazenamento do broker é outra situação.
- Os prazos de retry são curtos para a demonstração, sem estudo de carga ou SLA.
- O usuário da aplicação é restrito; o administrador do banco ainda pode alterar dados.
- Não há balanceador, autenticação efetiva, double-entry, dashboard ou teste de carga.

## Exercício de compreensão

Sem olhar o código, explique: se a aposta foi confirmada no PostgreSQL e a API
caiu antes de responder, o que acontece quando o provedor envia de novo a mesma
chave e o mesmo payload? Por que consultar apenas o saldo atual seria errado?
