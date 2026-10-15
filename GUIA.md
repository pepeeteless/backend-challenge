# Guia do projeto e ponto de retomada

Atualizado em 15/10/2026. O README original continua sendo a fonte dos requisitos.
Este guia descreve o que existe hoje, sem apresentar etapas futuras como prontas.

## 1. Onde procurar cada coisa

```text
src/
  main.ts                         inicia o servidor Nest
  app.module.ts                   registra o controller existente
  health/
    health.controller.ts          GET /health/live
  wallets/
    money.ts                      calculos monetarios e validacao
    wallet.ts                     estado e regras da carteira
    wallet-ledger-entry.ts        um lancamento imutavel em memoria
    open-wallet.ts                coordena a abertura no banco
    wallet.schema.ts              mapeia a tabela wallets para objetos
    *.unit.test.ts                testes sem banco
    *.integration.test.ts         testes com PostgreSQL real
  database/
    orm.config.ts                 conexao, mapeamentos e lista de migracoes
    migrations/                   historico de alteracoes das tabelas
scripts/
  migrate.ts                      aplica/reverte migracoes com a API do ORM
  check-connection.ts             consulta carteiras para diagnostico local
  verify-wallet-constraints.sql   exercicio SQL das constraints, com rollback
compose.yaml                      inicia PostgreSQL e preserva seus dados
```

Os arquivos de carteira ficaram juntos para evitar navegar por varias camadas.
Isso nao mistura suas responsabilidades: Money e Wallet nao importam Nest nem ORM.
OpenWallet coordena o dominio e a persistencia; por enquanto depende diretamente
do MikroORM. Nao foi criada uma pasta vazia de wagering para funcionalidade futura.

## 2. O que realmente atende HTTP hoje

```text
bun run start:dev
  -> src/main.ts cria a aplicacao Nest
  -> AppModule registra HealthController
  -> servidor escuta na porta 3000

GET /health/live
  -> HealthController.live()
  -> retorna { status: "ok" }
  -> Nest responde JSON
```

Um controller associa uma rota HTTP a um metodo. O modulo informa ao Nest quais
componentes usar. O main e o ponto de entrada que liga o servidor.

Este endpoint nao acessa PostgreSQL. Atualmente nao existe POST /wallets,
WalletsController nem um servico de banco conectado ao modulo Nest.
O arquivo database.service.ts estava vazio e foi removido na reorganizacao.
Zod esta instalado, mas ainda nao e usado por uma rota.

## 3. A abertura da carteira ja existe, mas e chamada pelos testes

Leia src/wallets/open-wallet.ts junto de
src/wallets/open-wallet.integration.test.ts.

O teste cria um gerenciador do ORM e chama new OpenWallet(em).execute(...).
Para um saldo inicial de "100.00" BRL, o fluxo e:

1. Money.from valida a string e cria um valor decimal exato com moeda.
2. Wallet.open cria um objeto em memoria com saldo 100.00, versao 1 e datas.
3. em.transactional inicia o bloco de trabalho transacional.
4. WalletSchema ensina ao ORM como transformar os campos em colunas da wallets.
5. persist registra o objeto; flush envia sua insercao ao banco, sem confirmar
   a transacao SQL que ainda esta aberta.
6. Como o saldo e positivo, criamos uma operacao interna OPENING, PROCESSED.
7. WalletLedgerEntry.create verifica o credito: 0.00 + 100.00 = 100.00.
8. Inserimos a operacao e o lancamento. Essas duas tabelas ainda usam SQL
   parametrizado pelo EntityManager, na mesma transacao da carteira.
9. Sem erro, transactional confirma sua unidade de trabalho. Se uma gravacao
   lancar erro, ela e desfeita junto das outras gravacoes dessa unidade.

Saldo zero cria apenas a carteira. OPENING e ledger nao sao gerados nesse caso.
Nao chamamos wallet.credit na abertura: Wallet.open ja recebeu o saldo inicial,
e um novo credito duplicaria o valor e incrementaria indevidamente a versao.

No teste existe uma transacao externa. A chamada transactional ocorre dentro
dela, e o rollback externo final remove os dados de teste. Isso nao e uma
simulacao do banco: as instrucoes foram executadas no PostgreSQL real.
Ainda falta um teste especifico de falha entre gravacoes e de confirmacao duravel.

## 4. As tres tabelas respondem perguntas diferentes

| Tabela | Pergunta | Exemplo de abertura |
|---|---|---|
| wallets | Quanto a carteira tem agora? | Saldo 100.00 BRL, versao 1 |
| wager_transactions | Qual operacao aconteceu? | OPENING de 100.00, PROCESSED |
| wallet_ledger_entries | Como essa operacao movimentou o saldo? | CREDIT de 100.00, antes 0.00, depois 100.00 |

Uma transacao financeira e uma operacao do negocio, como OPENING ou BET.
Uma transacao SQL agrupa gravacoes para confirmar todas ou desfazer todas.
O mesmo nome aparece nos dois contextos, mas nao significa a mesma coisa.

As chaves estrangeiras exigem que a carteira exista antes da operacao, e que a
operacao exista antes do lancamento. Tambem vinculam moeda e valor conforme a
constraint correspondente. Nao e necessario fazer commit entre essas insercoes.

## 5. Migracao, schema e reidratacao

| Peca | Responsabilidade |
|---|---|
| Migracao | Executa SQL para criar ou alterar a estrutura do banco |
| WalletSchema | Descreve ao ORM como ler e gravar a tabela existente |
| WalletRecord | Tipo TypeScript dos dados representados pelo mapeamento |
| Wallet.rehydrate | Reconstroi uma Wallet a partir do estado persistido |

Exemplo: playerId no codigo corresponde a player_id no banco. O DecimalType em
modo string evita converter o saldo para number. Depois de ler um WalletRecord,
Money.from reconstroi o valor e Wallet.rehydrate preserva saldo, versao e datas.

Wallet.open significa criar uma carteira nova. Wallet.rehydrate significa carregar
uma carteira existente. Ambos criam objetos na memoria; nenhum grava sozinho.
Da mesma forma, wallet.debit e wallet.credit alteram o objeto e devolvem um
lancamento em memoria. A persistencia dessas movimentacoes ainda nao foi ligada.

As migracoes atuais:

| Arquivo | Mudanca |
|---|---|
| Migration202610140001 | wallets, unicidade jogador/moeda e checks |
| Migration202610140002 | ledger, aritmetica, referencias e trigger contra UPDATE/DELETE |
| Migration202610150001 | wager_transactions e referencia do ledger a transacao |

Os nomes, a ordem e o SQL foram preservados na reorganizacao. Apenas os caminhos
mudaram; nao se deve recriar o banco nem reaplicar migracoes ja registradas.
Cada arquivo tem up e down; o caminho down ainda nao foi exercitado neste projeto.

O MikroORM tambem oferece geracao automatica: migration:create gera uma migracao;
migration:up aplica e migration:down reverte. Nossos scripts atuais usam a API
programatica para aplicar/reverter, e nao incluem a CLI de geracao.
Antes de adotar geracao automatica, precisamos completar os mapeamentos: hoje
somente wallets esta mapeada, e seu mapeamento ainda nao inclui a chave unica
adicionada na segunda migracao. Uma diferenca gerada deve ser revisada para nao
remover tabelas ou constraints que existem apenas nas migracoes manuais.

## 6. Comandos no PowerShell

Execute na raiz C:\Users\pepee\Desktop\Dev\jungleGaming\backend-challenge.

| Comando | Efeito |
|---|---|
| bun install | Instala as dependencias registradas |
| bun run services:up | Inicia PostgreSQL pelo Compose |
| bun run migrate:up | Aplica migracoes pendentes; requer banco pronto |
| bun run typecheck | Verifica tipos de src e scripts |
| bun run test:unit | Executa os 32 testes que nao precisam de banco |
| bun run test:integration | Executa os 6 testes que precisam de banco e migracoes |
| bun run test | Executa todos os 38 testes |
| bun run start:dev | Inicia Nest e reinicia ao editar arquivos |
| bun run db:check | Consulta e imprime as carteiras existentes, para diagnostico local |

Para consultar a unica rota atual, use outro terminal:

```powershell
Invoke-RestMethod http://localhost:3000/health/live
```

bun run migrate:down reverte a ultima migracao. Nossas reversoes removem tabelas
e seus dados: nao e um comando para executar durante uma verificacao comum.
O antigo exercicio SQL agora fica em scripts/verify-wallet-constraints.sql.

## 7. Estado para retomar em outro chat

- Preferencia: usuario escreve os proximos incrementos, com explicacao logica e
  uma etapa verificavel por vez. A edicao automatica foi autorizada para esta
  reorganizacao, nao para completar o desafio inteiro.
- Stack: Bun 1.4.3, TypeScript estrito, Nest 11, MikroORM 7.2.5, PostgreSQL 17.11.
- PostgreSQL local: banco e usuario pepe, credenciais de desenvolvimento no
  Compose e na configuracao do ORM; separacao de permissoes ainda pendente.
- Verificacao da reorganizacao: typecheck, 32 testes unitarios e 6 testes de
  integracao passando. Os testes de integracao usam rollback.
- HTTP: apenas liveness. OpenWallet funciona nos testes e ainda nao e uma rota.
- Decisoes atuais: entrada monetaria com exatamente duas casas; numeric(20,2);
  precisao decimal 21 para soma/subtracao do intervalo aceito; credito/debito
  estritamente positivos. Sao decisoes a documentar na arquitetura final.
- Nao implementado: API financeira, modelo completo de WagerTransaction,
  idempotencia, concorrencia por wallet, referencias, SQS/LocalStack, inbox,
  outbox, reconciliacao HTTP, metricas, readiness, testes com tres instancias.
- Detalhes pendentes: moeda ISO valida, erros de dominio, datas/rehydrate do
  ledger, ponto de extensao de autenticacao e documentacao final.
- As constraints atuais NAO garantem sozinhas saldo igual a soma do ledger, nem
  todas as regras de estados/reversoes. Ter 38 testes passando nao conclui o README.
- Proximo passo didatico: compreender main -> AppModule -> HealthController e
  OpenWallet -> ORM -> banco. Depois conectar POST /wallets em um bloco explicado,
  com validacao e teste HTTP, sem refazer o dominio existente.

## 8. O que mudou nesta reorganizacao

- Codigo de carteira antes espalhado por domain, app e infra/database reunido em
  src/wallets, com testes proximos dos arquivos testados.
- Configuracao e migracoes em src/database; comandos auxiliares em scripts.
- Controller em src/health; rota escrita em minusculas conforme o README.
- Imports e comandos ajustados; scripts incluidos na verificacao de tipos.
- Import explicito de reflect-metadata no ponto de entrada.
- Removido somente o arquivo vazio database.service.ts, sem implementacao.
- Regras financeiras e SQL das migracoes preservados. README original e arquivo
  .snapshot-pepe.json nao editados por esta reorganizacao.
