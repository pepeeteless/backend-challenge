# Tutorial completo do projeto: do pedido até a auditoria

Este material descreve o código construído neste repositório. A ideia é você
conseguir seguir uma operação, reconhecer a responsabilidade de cada arquivo e
explicar por que as proteções existem. Leia em ordem na primeira vez; depois use
o sumário para voltar a uma dúvida. Não precisa memorizar nomes de métodos.

Os exemplos com IDs curtos, como `wallet-A`, são ilustrativos: a API real exige
UUID válido nos campos de carteira e jogador.

## Sumário

1. [O problema e as peças](#1-o-problema-e-as-peças)
2. [Quem faz o quê na stack](#2-quem-faz-o-quê-na-stack)
3. [Como a aplicação começa](#3-como-a-aplicação-começa)
4. [NestJS explicado pelo nosso código](#4-nestjs-explicado-pelo-nosso-código)
5. [Money, Wallet e ledger](#5-money-wallet-e-ledger)
6. [Banco, ORM, migrations e reidratação](#6-banco-orm-migrations-e-reidratação)
7. [Criação de uma carteira](#7-criação-de-uma-carteira)
8. [Uma BET HTTP do começo ao fim](#8-uma-bet-http-do-começo-ao-fim)
9. [Todas as camadas de validação](#9-todas-as-camadas-de-validação)
10. [Concorrência: duas apostas de 80](#10-concorrência-duas-apostas-de-80)
11. [Idempotência e resultado original](#11-idempotência-e-resultado-original)
12. [WIN, LOSS, REFUND e ROLLBACK](#12-win-loss-refund-e-rollback)
13. [Referências fora de ordem](#13-referências-fora-de-ordem)
14. [SQS, mensagens e inbox](#14-sqs-mensagens-e-inbox)
15. [Outbox e publicação de eventos](#15-outbox-e-publicação-de-eventos)
16. [Retries, DLQ e FAILED](#16-retries-dlq-e-failed)
17. [Quedas e desligamento](#17-quedas-e-desligamento)
18. [Consultas, paginação e reconciliação](#18-consultas-paginação-e-reconciliação)
19. [Logs, métricas e saúde](#19-logs-métricas-e-saúde)
20. [Docker, três instâncias e permissões](#20-docker-três-instâncias-e-permissões)
21. [Testes e exercícios práticos](#21-testes-e-exercícios-práticos)
22. [Mapa de arquivos e ordem de estudo](#22-mapa-de-arquivos-e-ordem-de-estudo)
23. [Limites e perguntas de entrevista](#23-limites-e-perguntas-de-entrevista)

## 1. O problema e as peças

Um provedor de jogos envia: “o jogador apostou 80”. Precisamos decidir se a operação
pode acontecer, atualizar o saldo, guardar o histórico e avisar outros sistemas.

O difícil é que o pedido pode chegar duas vezes, chegar junto de outro ou ser
interrompido por uma queda. Por isso este projeto tem mais peças que um CRUD.

Há quatro registros diferentes que vale separar desde já:

| Peça | Pergunta que responde | Exemplo |
|---|---|---|
| Wallet | Quanto existe agora? | Saldo 20 BRL, versão 2. |
| WagerTransaction | O que foi solicitado e qual foi o resultado? | BET de 80, PROCESSED. |
| Ledger | Qual movimento financeiro efetivamente aconteceu? | DEBIT de 80, saldo 100 → 20. |
| Evento | O que outros sistemas precisam saber? | WalletBalanceChanged. |

Uma aposta rejeitada existe em WagerTransaction, mas não gera ledger de débito.
Isso permite auditar tanto os movimentos quanto as tentativas rejeitadas.

**A palavra “transação” aparece com dois sentidos:**

- **Transação de negócio:** uma aposta, prêmio ou reversão. É um registro do domínio.
- **Transação SQL:** um conjunto de gravações que o PostgreSQL confirma ou desfaz junto.

Dentro de uma transação SQL podemos gravar a transação de negócio, a carteira,
o lançamento, a inbox e os eventos de outbox.

Uma **invariante** é uma condição que precisa continuar verdadeira. Exemplo:
saldo nunca negativo. Nosso desenho e nossos testes existem para manter essas condições.

## 2. Quem faz o quê na stack

| Tecnologia | Papel concreto neste projeto |
|---|---|
| Bun | Executa TypeScript, instala dependências e roda testes. |
| TypeScript estrito | Aponta incompatibilidades de tipos antes da execução. |
| NestJS | Organiza HTTP, criação de serviços e ciclo de vida da aplicação. |
| Zod | Valida dados reais que chegaram em JSON. |
| decimal.js | Faz as operações monetárias com representação decimal. |
| MikroORM | Mapeia registros, executa consultas e gerencia transações/conexões. |
| PostgreSQL | Persiste dados, aplica constraints e coordena concorrência. |
| SQS | Transporta pedidos e eventos de forma assíncrona. |
| LocalStack | Disponibiliza uma implementação local da API SQS para desenvolvimento. |
| Docker Compose | Inicia e conecta banco, LocalStack e instâncias da aplicação. |

**TypeScript não valida JSON recebido.** Os tipos ajudam quem escreve código,
mas uma requisição externa pode conter qualquer coisa. É por isso que o body entra
como `unknown` e passa pelo Zod antes de ser usado.

`unknown` significa “ainda não sei o tipo”. Você precisa verificar antes de acessar.
`strict: true` reúne verificações mais rigorosas, incluindo tratamento de `null`
e `undefined`. Se a busca puder retornar `Wallet | null`, o compilador exige lidar
com a ausência da carteira antes de chamar seus métodos.

`bun run typecheck` executa `tsc`. Com `noEmit`, confere tipos sem gerar JavaScript.
Não imprimir erros significa que a checagem terminou bem; não comprova sozinho
que as regras financeiras funcionam. Para isso temos testes.

## 3. Como a aplicação começa

Arquivos: `src/main.ts`, `src/app.module.ts`, `src/database/database.service.ts`.

1. Bun executa `main.ts`.
2. O import de `reflect-metadata` prepara suporte aos metadados usados pelo Nest.
3. `NestFactory.create(AppModule)` cria a aplicação a partir do módulo principal.
4. O Nest instancia os serviços registrados e resolve suas dependências.
5. `DatabaseService.onModuleInit()` inicializa o MikroORM com `orm.config.ts`.
6. Na inicialização, os workers registram seus agendamentos.
7. `app.listen(3000, "0.0.0.0")` abre o servidor HTTP.

Um **worker** é uma rotina que executa trabalho em segundo plano. Aqui ele não é
necessariamente outro programa: cada processo Nest contém HTTP e seus workers.

O AppModule registra os controllers de carteiras, transações, consultas, métricas
e health, além dos serviços e workers. Não existe descoberta mágica de toda classe
do projeto. Os objetos de domínio e vários repositórios são criados explicitamente
com `new` pelo caso de uso.

**Iniciar a API não executa migrations automaticamente.** No Compose completo,
o serviço `setup` faz isso antes. No modo de estudo, você executa o comando de migration.

## 4. NestJS explicado pelo nosso código

O problema: alguém precisa receber HTTP, escolher qual método chamar, fornecer
serviços e transformar o resultado em resposta. Essa parte é responsabilidade do Nest.

### Controller: a entrada HTTP

Um **decorator** é uma anotação como `@Controller` que associa informações à classe
ou ao método. O Nest lê essas informações para montar o comportamento HTTP.

```ts
@Controller("wagering/transactions")
export class WageringController {
  @Post()
  async submit(/* ... */) { /* ... */ }
}
```

O prefixo da classe e o método `@Post()` formam `POST /wagering/transactions`.
`@Body()` entrega o JSON do corpo; `@Headers("idempotency-key")` entrega o header;
`@Param()` entrega um trecho da URL; `@Query()` entrega parâmetros após `?`.

O controller de apostas recebe a requisição, chama `ProcessTransaction.execute`
e seleciona o status HTTP. Ele não calcula saldo.

### Injeção de dependência

```ts
constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}
```

O controller precisa de um DatabaseService. Em vez de abrir uma conexão nova por
conta própria, pede ao Nest o serviço registrado no módulo. Isso é **injeção de
dependência**: receber o colaborador necessário para trabalhar.

`@Injectable()` marca um serviço para o mecanismo de criação de dependências.
Ele ainda precisa ser registrado ou disponibilizado pelo módulo apropriado.

### Guard, pipe e filtro

| Peça | Problema que resolve | Nosso exemplo |
|---|---|---|
| Guard | Decidir se a requisição pode prosseguir. | ProviderAuthGuard permite tudo por enquanto. |
| Pipe | Validar/transformar um argumento da rota. | ParseUUIDPipe rejeita UUID malformado. |
| Filtro de exceção | Transformar erro em resposta HTTP. | DatabaseHttpFilter distingue erro temporário de erro inesperado. |

Ordem útil para acompanhar uma rota: HTTP → guard → pipes dos argumentos → método
do controller → caso de uso. Se uma exceção escapar, o filtro pode tratar a resposta.
Validação Zod acontece onde foi escrita: no controller da carteira ou no caso de
uso das apostas. Ela não é automaticamente inserida pelo Nest.

O guard atual é um **no-op**, isto é, retorna `true` sem autenticar. É o ponto para
integrar um provedor externo de identidade no futuro. Health não usa esse guard.
SQS entra diretamente pelo caso de uso. Não há login ou autorização por provedor implementados.

## 5. Money, Wallet e ledger

### Money: um valor com regras

Problema: se cada arquivo representar dinheiro de um jeito, surgirão conversões,
moedas misturadas e cálculos inconsistentes. Money centraliza essas regras.

```ts
const saldo = Money.from({ amount: "100.00", currency: "BRL" });
const aposta = Money.from({ amount: "80.00", currency: "BRL" });
const restante = saldo.subtract(aposta);
```

`saldo` continua 100; `restante` é outro Money com 20. Isso é **imutabilidade**.
O método não modifica o valor original.

`from` significa “criar a partir de”. Não é palavra especial do TypeScript.
`static` permite chamar `Money.from(...)` na classe. O construtor privado impede
que outros arquivos criem Money diretamente, pulando a factory. Uma **factory** é
um método que concentra a construção válida do objeto.

O caminho de `Money.from` é:

1. Exigir string.
2. Exigir dígitos, ponto e exatamente duas casas decimais.
3. Criar o decimal com precisão configurada.
4. Conferir valor finito e limite de magnitude.
5. Congelar o objeto externo.

Exemplos rejeitados: `""`, `"NaN"`, `"Infinity"`, `"1e2"`, `"-1.00"`, `"1.999"`,
`"25"`, `"25.0"`, número `25`. O projeto rejeita casas excedentes, não arredonda a entrada.

As operações usam decimal.js com precisão 21. O limite monetário é
`999999999999999999.99`, correspondente a `numeric(20,2)` no PostgreSQL:
20 algarismos totais, sendo dois decimais. O dígito adicional no cálculo ajuda a
detectar soma acima do limite sem perder centavos antes da rejeição.

`toJSON()` devolve `{ amount: "20.00", currency: "BRL" }`. Ao serializar um Money,
esse método fornece o contrato externo, sem expor o objeto Decimal interno.

Money compara moedas antes de somar, subtrair ou comparar dois valores. Ele não
consulta um catálogo ISO de moedas. A entrada HTTP impõe BRL na abertura e formato
de três letras nas operações; o domínio verifica a compatibilidade com a carteira.

Uma distinção importante: a entrada pública não aceita valores negativos, mas
`subtract` e `negate` podem produzir Money negativo internamente. Quem impede
saldo negativo é Wallet, com reforço do schema do banco.

### Wallet: controla a mudança de saldo

Wallet concentra identidade, jogador, moeda, saldo, versão e datas. O saldo privado
não tem setter público: o código precisa usar `debit` ou `credit`.

`Wallet.open` valida saldo inicial não negativo e começa na versão 1.
`Wallet.rehydrate` reconstrói uma carteira já existente, preservando versão e datas.
Reidratar não significa abrir outra carteira nem repetir os efeitos da abertura.

Em `debit`, a ordem é:

1. Conferir moeda.
2. Conferir que o valor é positivo.
3. Conferir saldo suficiente.
4. Calcular o próximo Money.
5. Construir e validar o lançamento do ledger.
6. Só então substituir o saldo, incrementar versão e atualizar a data.
7. Devolver o lançamento ao caso de uso.

Por que criar o lançamento antes de mudar o objeto? Se a construção do lançamento
falhar, a carteira em memória ainda fica no estado original.

Em `credit` acontece a mesma estrutura, usando adição. Overflow é rejeitado antes
de alterar a carteira. `WagerTransaction.apply` também antecipa essa verificação
para produzir um failureCode de negócio compreensível.

Money é imutável; Wallet muda seu próprio estado por métodos controlados. As duas
coisas coexistem: Wallet troca a referência de um Money por outro.

**Versão:** abertura 1 → BET aceita 2 → LOSS continua 2 → WIN aceita 3.
Ela muda quando há mudança de saldo. Neste projeto, não é ela que resolve a
concorrência; o lock do PostgreSQL faz isso. A versão também acompanha eventos
para consumidores reconhecerem a evolução da carteira.

### Ledger: o histórico financeiro

O saldo diz “tenho 20”. O ledger explica “entrou 100 e saiu 80”.

| Movimento | Direção | Valor | Antes | Depois |
|---|---|---|---|---|
| Abertura | CREDIT | 100.00 | 0.00 | 100.00 |
| BET | DEBIT | 80.00 | 100.00 | 20.00 |
| WIN posterior | CREDIT | 10.00 | 20.00 | 30.00 |

`WalletLedgerEntry.create` valida direção, ausência de valores negativos e conta
fechando: antes − valor = depois no débito; antes + valor = depois no crédito.
As comparações de Money também impedem misturar moedas. O objeto é congelado.

Detalhe do código atual: a factory do ledger rejeita negativos, mas não proíbe
explicitamente valor zero. Os caminhos de Wallet exigem valor positivo e o banco
também exige `amount > 0`. Não atribua a uma camada uma validação que está em outra.

Um lançamento confirmado não é editado nem apagado pela aplicação. Para devolver
uma aposta, criamos outra operação e outro lançamento. O histórico explica ambos.
Este ledger é por movimentos da carteira; não implementamos partidas dobradas.

## 6. Banco, ORM, migrations e reidratação

### Três responsabilidades distintas

| Elemento | Faz o quê? | Não faz o quê? |
|---|---|---|
| Migration | Cria/altera tabelas, constraints, índices e triggers. | Não abre carteira para um jogador. |
| EntitySchema | Mapeia propriedades do registro para colunas SQL. | Não substitui a aplicação de migrations. |
| rehydrate | Reconstrói um objeto de domínio a partir de dados persistidos. | Não cria tabela nem confirma gravação. |

Exemplo: a migration cria a coluna `balance numeric(20,2)`; WalletSchema ensina o
ORM a lê-la como string; WalletRepository usa `Money.from` e `Wallet.rehydrate`
para obter novamente um objeto com métodos como `debit`.

O **ORM** faz a ponte entre código e banco. Ainda é PostgreSQL que persiste,
bloqueia linhas e executa SQL. Não existe um segundo banco dentro do ORM.

### EntityManager, fork e registros gerenciados

O **EntityManager**, abreviado `em`, é o objeto pelo qual fazemos consultas e
gravações. `DatabaseService.createEntityManager()` chama `fork()`: cria um contexto
de gerenciamento separado, sem iniciar outro servidor PostgreSQL.

O **Identity Map** mantém a identidade dos registros carregados naquele contexto.
A **Unit of Work** acompanha as mudanças e prepara gravações no `flush`.
Não usamos essas estruturas em memória como garantia de idempotência financeira.

No repositório, o registro ORM e o objeto Wallet são objetos diferentes.
O repositório reconstrói Wallet para usar o domínio, depois copia seu novo estado
para o registro gerenciado ao salvar. `refresh: true` força releitura em caminhos
nos quais não queremos depender de estado previamente carregado.

### persist, flush, commit e rollback

```ts
em.persist(record);
await em.flush();
```

`persist` registra a intenção de persistir. `flush` envia as mudanças ao banco.
**Nos nossos blocos `transactional`, flush não encerra a transação externa.**

```ts
return em.transactional(async transactionEm => {
  // todas as gravacoes usam transactionEm
});
```

Se o bloco termina corretamente, o ORM confirma a transação: **commit**.
Se uma exceção escapa, ele desfaz: **rollback**.

Rollback não significa “o ORM nunca enviou SQL”. SQL pode ter sido enviado e
executado; o banco desfaz as mudanças não confirmadas. Essa diferença explica
por que um teste pode inserir, consultar o registro e terminar sem deixá-lo salvo.

Rollback do PostgreSQL também não desfaz magicamente mutações de objetos JavaScript.
O fluxo abandona os objetos daquela tentativa; uma nova tentativa relê o banco.

### As tabelas

| Tabela | Conteúdo |
|---|---|
| wallets | Saldo materializado, moeda, jogador, versão e datas. |
| wager_transactions | Identidade financeira, operação, resultado, referência e agenda. |
| wallet_ledger_entries | Movimentos imutáveis com antes/depois e sequência para paginação. |
| inbox_messages | Entregas SQS aceitas e sua resposta persistida. |
| outbox_messages | Eventos confirmados a publicar e controle de publicação/retry. |
| dead_letter_messages | Arquivo imutável das mensagens retiradas da DLQ. |

“Saldo materializado” significa saldo atual já calculado e armazenado para leitura
rápida. O histórico permite recalculá-lo e comparar depois.

### Defesas do schema

Uma **constraint** é uma regra que o próprio banco verifica. Uma **foreign key**
(FK) exige que um registro referenciado exista e corresponda às colunas indicadas.
Um **índice** ajuda a localizar registros; um índice único também impede duplicação.
Um **trigger** executa uma função automaticamente numa escrita.

| Defesa | Exemplo concreto |
|---|---|
| UNIQUE | Uma wallet por jogador/moeda; chave idempotente única. |
| CHECK | Saldo não negativo; direção válida; conta do ledger correta. |
| FK composta | Ledger corresponde à carteira, moeda, valor e transação relacionados. |
| Índice único parcial | Apenas uma reversão processada por referência e tipo. |
| Trigger | Impedir editar/apagar ledger e transações terminais. |
| Permissões | Usuário da API não pode UPDATE/DELETE/TRUNCATE no ledger. |

A soma completa do ledger versus saldo é coordenada pelo caso de uso atômico e
conferida pela reconciliação. Não há um trigger genérico que transforme qualquer
SQL administrativo arbitrário em movimento financeiro correto. Por isso usamos
os caminhos da aplicação e distinguimos administrador de usuário restrito.

### Histórico das oito migrations

| Arquivo | Principal mudança |
|---|---|
| Migration202610140001 | Wallets e suas constraints. |
| Migration202610140002 | Ledger, vínculo com carteira e proteção de imutabilidade. |
| Migration202610150001 | Transações financeiras, OPENING e vínculo do ledger. |
| Migration202610160001 | Identidade idempotente, resposta persistida e estados terminais. |
| Migration202610160002 | Referências, reversões, tentativas e agendamento. |
| Migration202610160003 | Inbox e outbox. |
| Migration202610160004 | Sequência estável para paginação do ledger. |
| Migration202610160005 | Arquivo das mensagens da DLQ. |

`up` aplica; `down` reverte a alteração de estrutura. Um down que remove tabela
também pode remover dados. Reversível não significa inofensivo. Testamos em banco
descartável; não use down no banco de trabalho como exercício.

O MikroORM pode auxiliar a gerar migrations, mas seus metadados não representam
todas as regras SQL especiais que usamos. Aqui as migrations explícitas dão
controle sobre constraints e triggers. Elas são executadas pelo migrador do ORM.

## 7. Criação de uma carteira

Pedido: `POST /wallets` com jogador e saldo inicial `100.00 BRL`.

1. ProviderAuthGuard permite o pedido.
2. `WalletsController.open` valida o JSON com Zod: jogador UUID, amount string,
   moeda BRL e valor aceito por Money.
3. Cria um EntityManager e chama `OpenWallet.execute`.
4. O caso de uso cria Money e Wallet em memória; versão começa em 1.
5. Abre a transação SQL e insere a carteira.
6. Como o saldo é positivo, cria a transação interna OPENING já processada.
7. Cria o crédito de abertura no ledger: 0 → 100.
8. Salva dois eventos na outbox: processamento e mudança de saldo.
9. Confirma tudo junto; responde HTTP 201.

Com saldo inicial zero, cria a carteira, mas não cria OPENING, ledger nem esses
eventos. A versão permanece 1. OPENING não pode ser enviada pela API ou SQS:
o contrato externo só aceita os cinco tipos de operação do provedor.

Criar novamente carteira para o mesmo jogador/moeda encontra a constraint UNIQUE
e vira HTTP 409/WALLET_CONFLICT. Não há contrato de idempotency key na abertura.

## 8. Uma BET HTTP do começo ao fim

Vamos acompanhar a primeira aposta de 80 numa carteira com 100. Os nomes de método
abaixo são os do código, para você conseguir encontrar cada etapa.

### A. Chegada e validação do contrato

`WageringController.submit` extrai body e header. O body permanece `unknown`.
Passa ambos para `new ProcessTransaction(em).execute(body, key)`.

`execute` mede duração e prepara os campos seguros de log. Sua primeira validação
serve para extrair IDs conhecidos; a decisão de aceitar a entrada ocorre em
`executeTransaction`.

`executeTransaction` valida body e chave. Se inválidos, lança INVALID_PAYLOAD,
que o controller transforma em HTTP 400. Ainda não começou a transação SQL.

Depois normaliza os campos e calcula `payloadHash`, explicado na seção 11.

### B. Início do bloco SQL e identidade

Entra em `em.transactional`. HTTP não cria inbox: não existe contexto de mensagem.
Cria os repositórios usando o **mesmo** `em` recebido pelo bloco.

`findExisting` procura pela chave ou pelo par provedor/ID externo.
Se já existe, `replay` compara identidade e hash. Devolve a resposta persistida
ou acusa conflito. Não debita nem cria eventos de novo.

### C. Carteira bloqueada e reserva da operação

Se não existe resultado anterior, `wallets.findForUpdate`:

- configura espera de lock de cinco segundos para aquela transação SQL;
- consulta a carteira com `PESSIMISTIC_WRITE`, que usa bloqueio de escrita na linha;
- reconstrói Wallet e Money a partir do registro.

Carteira inexistente: 404. Não temos uma carteira à qual vincular a operação.

`WagerTransaction.create` cria uma operação PENDING em memória, com UUID interno,
identidades externas, Money e regras básicas de referência.

`tryInsertPending` tenta inserir a reserva com `ON CONFLICT DO NOTHING`.
Se outra execução ganhou uma identidade única enquanto trabalhávamos, a inserção
não sobrescreve nada. Relê o resultado e executa a mesma comparação de replay.

Consultar antes é uma otimização útil; **a constraint é que arbitra a corrida**.

### D. Aplicação das regras financeiras

`applyAndSave` busca uma referência se o pedido tiver uma e verifica se já houve
reversão processada daquele tipo. Chama `transaction.apply(wallet, ...)`.

Para esta BET sem referência, `apply` verifica:

1. Foi carregada a wallet indicada? Divergência aqui é erro de programação.
2. O jogador pertence à wallet?
3. A moeda da operação coincide com a carteira?
4. O valor é positivo?
5. Há saldo para o débito?

Então chama `wallet.debit`. A carteira constrói um lançamento, passa de 100 para
20 e de versão 1 para 2. A transação de negócio passa para PROCESSED.

### E. Gravações e resultado

O lançamento retornado indica que houve mudança de saldo. `applyAndSave` salva
a wallet e acrescenta o ledger. Monta o resultado:

```json
{
  "transactionId": "UUID-INTERNO",
  "status": "PROCESSED",
  "balance": { "amount": "20.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

`saveOutcome` atualiza o registro da operação, incluindo resposta, estado, datas,
código de falha e campos de agendamento quando aplicáveis.

Grava WagerTransactionProcessed na outbox e, porque houve lançamento,
WalletBalanceChanged. **Até aqui não publicou no SQS.**

O callback termina; o ORM confirma o commit. Só depois `execute` registra a
conclusão e o controller responde 200. O publisher encontrará os eventos confirmados.

### E se não houver saldo?

`apply` muda a operação para REJECTED/INSUFFICIENT_FUNDS. Não chama `debit`, não
retorna ledger e não muda wallet/versão. O caso de uso salva a rejeição, sua resposta
e WagerTransactionRejected na outbox; confirma e responde 422.

**Rejeição é um resultado confirmado. Erro técnico com rollback é outra coisa.**

## 9. Todas as camadas de validação

Validações em camadas não têm todas a mesma finalidade.

| Camada | Pergunta | Exemplos |
|---|---|---|
| TypeScript | Nosso código usa os tipos corretamente? | Não chamar método de wallet possivelmente null. |
| Transporte/contrato | O pedido tem um formato que entendemos? | UUID, header, kind aceito, string monetária. |
| Domínio | Essa operação faz sentido para essa carteira? | Mesmo jogador/moeda, saldo, referência e reversão. |
| PostgreSQL | O estado persistido respeita regras estruturais? | UNIQUE, FK, CHECK, proteção de terminais. |

`transactionInputSchema` é estrito: rejeita campos desconhecidos. UUIDs são
normalizados para minúsculas. Identificadores como providerId têm tamanho limitado.
amount passa por Money; currency exige três letras maiúsculas.

As regras de referência no contrato são: REFUND/ROLLBACK precisam de referência;
BET/LOSS não a aceitam; WIN aceita opcional; operação não pode referenciar a si mesma.

Abertura usa um schema próprio no WalletsController. Não é exatamente a mesma
política de parsing: ele não tem `.strict()` e o Zod remove campos desconhecidos.
Não confunda o contrato de criação de wallet com o de submissão de apostas.

Depois, `WagerTransaction.create` protege a construção e `apply` verifica as regras
que dependem da carteira/referência. Wallet protege seus próprios métodos, mesmo
que outro caso de uso os invoque no futuro. O banco acrescenta proteção concorrente.

| Resposta HTTP | Significado neste projeto |
|---|---|
| 201 | Wallet criada. |
| 200 | Operação processada/replay ou consulta bem-sucedida. |
| 202 | Operação aceita, aguardando referência. |
| 400 | Contrato/parâmetro inválido. |
| 404 | Recurso não encontrado. |
| 409 | Identidade conflitante ou wallet duplicada. |
| 422 | Rejeição de negócio persistida. |
| 503 | Falha transitória identificada; reenviar mesma identidade depois. |
| 500 | Erro inesperado ou replay de FAILED com código terminal explícito. |

Consultar uma operação rejeitada retorna 200 com status REJECTED no corpo.
422 é a resposta da submissão rejeitada, não a resposta de toda leitura desse registro.

O DatabaseHttpFilter preserva HttpException e converte erros técnicos conhecidos
em 503. Erros inesperados viram 500 sem expor SQL, credenciais ou stack ao cliente.
Não transforma indisponibilidade do banco em “saldo insuficiente”.

## 10. Concorrência: duas apostas de 80

Sem coordenação, A e B poderiam ler 100 ao mesmo tempo, calcular 20 e confirmar
duas apostas. Um saldo final aparentemente válido esconderia dois débitos incorretos.
Essa perda de atualização é chamada de **lost update**.

Nosso fluxo usa lock por carteira:

| Momento | Instância A | Instância B |
|---|---|---|
| 1 | Bloqueia wallet e lê 100. | Tenta bloquear a mesma wallet; espera. |
| 2 | Aplica BET 80; prepara saldo 20 e ledger. | Continua esperando. |
| 3 | Faz commit e libera lock. | Obtém lock e lê o saldo confirmado: 20. |
| 4 | Responde PROCESSED. | Rejeita BET 80; confirma rejeição. |

Se A falhar antes do commit, PostgreSQL desfaz o débito e B poderá ler 100 e ganhar.
Não há garantia de qual aposta vence; há garantia de que as duas não gastam o mesmo saldo.

O lock vive no PostgreSQL e funciona para três processos, três containers ou mais.
Uma carteira diferente bloqueia outra linha e pode avançar em paralelo.

`READ COMMITTED` é o isolamento usado: não lemos alterações não confirmadas de
outras transações. A leitura bloqueada coordena o caso específico de atualização
da carteira. Isso não equivale a bloquear toda consulta de saldo: um GET comum
pode ler o último estado confirmado enquanto outra operação está em andamento.

Esperar por lock indefinidamente seria ruim. O timeout local de cinco segundos
gera erro transitório; o cliente repete com a mesma chave, preservando idempotência.

## 11. Idempotência e resultado original

Problema: a API processou, mas a resposta se perdeu. O provedor não sabe se a aposta
aconteceu. Ele deve poder reenviar sem apostar outra vez.

**Idempotência** aqui significa: repetir a mesma operação não repete seu efeito
financeiro e retorna o resultado já armazenado.

Há duas identidades únicas no banco:

- `idempotencyKey`, recebida obrigatoriamente no header HTTP;
- `(providerId, externalTransactionId)`, identidade da operação no provedor.

O UUID `transactionId` é gerado internamente. Não é a mesma coisa que o ID externo.

### Para que serve o hash?

Mesma chave com BET de 80 e depois BET de 90 não é uma repetição válida.
Calculamos uma impressão digital, o **hash**, dos campos de negócio.

Antes de SHA-256, fazemos JSON **canônico**, com uma organização estável:

1. Validar e normalizar valores.
2. Normalizar UUIDs e serializar amount com duas casas.
3. Ordenar recursivamente as chaves dos objetos.
4. Incluir referência quando presente.
5. Calcular SHA-256 sobre o texto UTF-8.

Assim, mudar a ordem das chaves JSON não cria conflito. `"080.00"` e `"80.00"`
viram o mesmo valor normalizado. O header e metadados do envelope não entram no
hash financeiro. Hash não criptografa o pedido nem autentica o provedor.

| Situação | Resultado |
|---|---|
| Mesma identidade, chave e hash | Replay. |
| Mesma chave, payload diferente | 409. |
| Mesmo provedor/ID externo, chave diferente | 409, por decisão do contrato. |
| Chave colide com uma operação e ID externo com outra | 409. |

O primeiro `findExisting` pode não encontrar nada em duas requisições concorrentes.
Por isso o INSERT tem proteção única e não sobrescreve. Quem perde a corrida relê
o que foi confirmado. Um rollback do concorrente libera a possibilidade de inserir.

### Por que persistir a resposta inteira?

BET deixou saldo 20. Depois WIN deixou saldo 50. O replay da BET precisa devolver
20, porque esse foi seu resultado original. Consultar a wallet atual devolveria
50 e mudaria a resposta histórica.

`replay` usa `response` persistida e só muda `idempotentReplay` para true.
Não cria nova transação, ledger ou evento.

Uma operação PENDING_REFERENCE pode evoluir para resultado terminal. Enquanto
pendente, HTTP consulta seu resultado atual; ao concluir, o resultado terminal
fica preservado. Uma entrega já concluída da inbox conserva sua resposta daquela
entrega, mesmo que a operação pendente avance depois pelo worker.

## 12. WIN, LOSS, REFUND e ROLLBACK

Todas entram no mesmo ProcessTransaction. O `kind` seleciona a regra no domínio.

| Operação | Efeito | Exemplo |
|---|---|---|
| BET | Debita. | 100 − 80 = 20. |
| WIN | Credita. | 20 + 50 = 70. |
| LOSS | Registra resultado sem movimentar. | A aposta já foi debitada; não debitar de novo. |
| REFUND | Devolve uma BET processada. | BET 80 → crédito de 80. |
| ROLLBACK | Faz o movimento inverso da referência permitida. | WIN 50 → débito de 50. |

WIN pode referenciar BET da mesma rodada; seu prêmio não precisa ser igual ao
valor apostado. LOSS não gera ledger, não muda saldo e não incrementa versão.
Seu money fica registrado como dado da operação.

REFUND precisa referenciar BET. ROLLBACK pode referenciar BET, WIN ou REFUND.
Não permitimos reversão parcial: o valor precisa coincidir com o da referência.

A busca é por provedor + ID externo da referência. Depois o domínio verifica
provedor/ID, wallet, jogador, moeda e rodada. gameId não precisa coincidir porque
essa igualdade não foi exigida pelo README.

Também verifica tipo permitido e se a referência está PROCESSED. Referência
terminal rejeitada/falha não pode ser revertida. Referência ainda pendente pode
ser aguardada, desde que os outros critérios sejam válidos.

Uma referência só pode ser revertida uma vez **por tipo**, conforme interpretação
documentada: uma BET pode ter um REFUND e um ROLLBACK, mas não dois de cada.
Consulta de domínio e índice único parcial no banco reforçam a proteção.

Se o prêmio já foi gasto e seu ROLLBACK deixaria saldo negativo, a resposta é
REJECTED/REVERSAL_INSUFFICIENT_FUNDS. Não é o mesmo código da BET sem saldo.
O registro original fica intacto; a reversão rejeitada também fica auditável.

## 13. Referências fora de ordem

Problema: REFUND de 80 chega antes da BET de 80. Rejeitar imediatamente perderia
uma operação válida apenas porque a rede inverteu a ordem de entrega.

O fluxo é:

1. REFUND não encontra referência → PENDING_REFERENCE.
2. Salva resultado 202, tentativa 1, próxima data e evento de pendência.
3. Não movimenta saldo e encerra a transação SQL.
4. A BET chega depois e é processada normalmente.
5. ReferenceRetryWorker encontra a pendência vencida.
6. `retryPending` bloqueia a carteira e relê estado/data.
7. Encontra a BET processada, aplica REFUND e salva o resultado terminal.

O worker roda a cada segundo e busca até 25 pendências vencidas. As esperas
crescem: 1, 2, 4, 8, 16, 32, 60, 60 e 60 segundos. São dez avaliações contando
a inicial. Esse aumento de espera é chamado **backoff exponencial**, com teto.

Tentativas e datas ficam no banco: reiniciar o processo não zera a agenda.
Dois workers podem selecionar o mesmo candidato; após obter o lock, cada um relê
se ainda precisa trabalhar. O segundo não reaplica o que o primeiro já concluiu.

Ao esgotar: REFERENCE_NOT_FOUND se ausente; REFERENCE_NOT_READY se ainda pendente.
Rejeição terminal não é reaberta quando a referência chega tarde. Uma falha de
infraestrutura desfaz a tentativa SQL e não consome uma avaliação confirmada.

Reenviar HTTP não força o retry. A responsabilidade de avançar a pendência é do
worker. Novas avaliações ainda pendentes não emitem repetidamente o evento inicial.

## 14. SQS, mensagens e inbox

HTTP espera uma resposta direta. SQS permite guardar um pedido para processamento
assíncrono: o produtor envia e o consumidor busca quando puder.

Usamos três filas locais:

| Fila | Uso |
|---|---|
| wager-transactions.fifo | Pedidos de operações. |
| wager-transactions-dlq.fifo | Pedidos que precisam de tratamento de falha. |
| wager-events.fifo | Eventos publicados a partir da outbox. |

FIFO organiza grupos e ajuda a deduplicar envios, mas não substitui as garantias
do banco. Trabalhamos assumindo entrega **ao menos uma vez**: pode haver repetição.

### Envelope e IDs diferentes

O envelope contém messageId, type, occurredAt e data. `data` contém a operação
mais idempotencyKey. `parseWagerEnvelope` valida o envelope; depois o mesmo schema
de ProcessTransaction valida os dados financeiros.

Não misture estes IDs:

- `message.MessageId`: ID de transporte fornecido pelo SQS.
- `envelope.messageId`: ID do pedido lógico da mensagem; usado na inbox.
- `externalTransactionId`: ID financeiro no provedor.
- `transactionId`: UUID financeiro interno.
- `eventId`: ID de um evento de saída.

`ReceiptHandle` é o comprovante daquela recepção, usado para confirmar/remover
a mensagem. Não é a identidade financeira da aposta.

### Caminho do consumidor

`MessagingWorker` agenda `SqsConsumer.consumeOnce`. Ele recebe uma mensagem,
valida o envelope e chama `process`. Esse método separa idempotencyKey dos dados
e chama o mesmo `ProcessTransaction.execute`, passando também consumerName e messageId.

O caso de uso não passa por controller HTTP. As regras financeiras continuam iguais.
SQS não recebe status HTTP; recebe confirmação após resultado persistido.

### Inbox: recibo persistente da entrega

Sem inbox, o consumidor poderia esquecer que já concluiu uma mensagem após reiniciar.
`MessageRepository.receive` tenta reservar `(consumerName, messageId)` dentro da
mesma transação SQL da operação financeira.

O hash da inbox combina hash financeiro e idempotencyKey. Se o mesmo messageId
vier com chave/conteúdo diferente, ocorre INBOX_PAYLOAD_CONFLICT.

Se é novo, processa. Se já existe e coincide, devolve a resposta salva. Ao terminar
uma entrega nova, `complete` marca data e resposta. Tudo é confirmado junto.

Inbox protege a entrega. A identidade financeira protege a operação mesmo quando
ela chega por HTTP ou em outra mensagem com outro messageId. Precisamos das duas.

### Ack e visibilidade

**Ack** é a confirmação de processamento; aqui é `DeleteMessage` no SQS.
Ele acontece somente depois de o caso de uso resolver o commit.

Ao receber, a mensagem fica temporariamente invisível por 30 segundos. Não foi
apagada: se o consumidor morrer, ela pode reaparecer. Enquanto processa a entrada,
o consumidor renova a visibilidade a cada dez segundos.

PROCESSED, REJECTED e PENDING_REFERENCE são resultados persistidos e recebem ack.
A pendência de referência já está sob responsabilidade do worker do banco.

## 15. Outbox e publicação de eventos

Problema: se fizermos commit do saldo e só depois tentarmos publicar diretamente,
uma queda entre os dois passos pode deixar uma aposta sem evento para sempre.

Solução: salvar o evento pendente na tabela outbox **dentro do commit financeiro**.
Não precisamos que PostgreSQL e SQS confirmem uma transação distribuída conjunta.

**Comando** pede algo: WagerTransactionRequested. **Evento** informa algo ocorrido:
WagerTransactionProcessed, por exemplo.

| Evento | Quando é gravado |
|---|---|
| WagerTransactionProcessed | Operação aplicada, inclusive LOSS e OPENING positiva. |
| WalletBalanceChanged | Houve movimento de saldo e ledger. |
| WagerTransactionRejected | Rejeição financeira, inclusive referência esgotada. |
| WagerTransactionPendingReference | Primeira avaliação que ficou pendente. |
| WagerTransactionFailed | Auditoria de falha técnica terminal. |

IntegrationEvent é a classe abstrata que reúne o envelope comum. Cada subclasse
concreta define o tipo do evento. Os dados são copiados e congelados; valores
monetários são MoneyProps, datas são texto ISO e a versão do envelope começa em 1.

`aggregateId` é a wallet; `correlationId` é o UUID da transação de negócio;
`causationId`, quando disponível, identifica a mensagem que causou o evento.

### Como o publisher trabalha

1. Abre uma transação SQL própria, separada da financeira.
2. Busca evento não publicado cuja próxima tentativa já venceu.
3. Bloqueia a linha usando `FOR UPDATE SKIP LOCKED` via MikroORM.
4. Publica no SQS com ID de deduplicação igual a eventId.
5. Marca publishedAt; confirma a transação da outbox.

**SKIP LOCKED** significa pular linhas já bloqueadas. Assim, outro publisher pega
outro evento em vez de ambos trabalharem no mesmo simultaneamente.
Não há lock de wallet durante esse envio. Há uma conexão/transação de outbox
ocupada enquanto espera o SQS: é um custo assumido para manter a solução simples.

Se enviar falhar, agenda nova tentativa com espera 2, 4, 8, 16, 32 e teto 60 segundos.
Outbox não descarta eventos financeiros por número de tentativas.

Se enviar funcionar e o processo cair antes de marcar publicado, poderá enviar
novamente. O eventId é o mesmo. Um consumidor de eventos deve guardar deduplicação
persistente por esse ID. Não prometemos entrega exatamente uma vez no transporte.

Publishers concorrentes podem publicar eventos de uma mesma wallet fora de ordem.
WalletBalanceChanged inclui walletVersion para ajudar consumidores de projeção.
A ordenação de chegada do evento não é usada para calcular nosso saldo financeiro.

## 16. Retries, DLQ e FAILED

**Retry** significa tentar novamente. Há três agendas diferentes:

| Agenda | Onde fica | Limite |
|---|---|---|
| Erro ao consumir SQS | Recebimentos e visibilidade da mensagem. | Cinco entregas; depois DLQ. |
| Referência pendente | Campos da transação no PostgreSQL. | Dez avaliações; depois REJECTED. |
| Falha de publicação | Campos da outbox no PostgreSQL. | Continua tentando, com espera máxima de 60s. |

Falta de saldo é rejeição de negócio: salvar e confirmar, não tentar até o saldo mudar.
Banco temporariamente indisponível é erro técnico: repetir com backoff.
Envelope inválido, carteira inexistente e conflito de identidade vão à DLQ sem
esperar cinco tentativas inúteis.

**DLQ**, dead-letter queue, é a fila de mensagens cujo processamento falhou.
O consumidor envia à DLQ antes de remover da origem. Uma queda no meio pode gerar
duplicata, mas evita remover da origem antes de preservar a mensagem.
A fila de entrada também configura redrive automático após cinco recebimentos.

### Arquivo e estado FAILED

DeadLetterConsumer é um terceiro trabalho de mensageria. Recebe da DLQ e abre uma
transação SQL para guardar o corpo original em dead_letter_messages.

Para um pedido válido sem resultado anterior e com carteira existente, chama
`ProcessTransaction.recordFailure`: usa as mesmas proteções de identidade, mas
registra FAILED/INFRASTRUCTURE_RETRY_EXHAUSTED sem aplicar a operação à carteira.
Grava resposta, inbox e evento de falha junto com o arquivo.

Se a operação já foi processada, preserva o resultado. Um problema de ack não
transforma uma aposta aprovada em FAILED. Pendências também não são sobrescritas.
Mensagem inválida é arquivada com seu código, sem inventar transação financeira.

Essa chamada aninhada usa um **savepoint**, um ponto de retorno dentro da mesma
transação SQL. Permite desfazer uma tentativa interna com conflito e ainda salvar
o arquivo externo. Não é um commit financeiro independente.

Só remove da DLQ depois do commit da auditoria. Se o banco estiver fora do ar,
a mensagem permanece para outra tentativa. A retenção configurada da DLQ é 14 dias:
não é uma garantia de conservação infinita durante indisponibilidade.

FAILED é terminal. “Permanente” aqui significa que esgotou nossa política de
tentativas; não significa que o banco nunca voltará. Repetir a mesma identidade
devolve a falha original, sem tentar apostar novamente.

## 17. Quedas e desligamento

| Ponto da queda | O que permanece | Como recupera |
|---|---|---|
| Antes do commit financeiro | Nada daquela tentativa fica confirmado. | Reenvio/redisponibilização executa novamente. |
| Depois do commit, antes da resposta HTTP | Resultado, saldo, ledger e outbox. | Mesma identidade devolve replay. |
| Depois do commit, antes do ack SQS | Inbox e efeito financeiro confirmados. | Redelivery encontra inbox; não debita de novo. |
| Depois do commit, antes de publicar evento | Evento pendente na outbox. | Outra instância publica. |
| Depois de publicar, antes de marcar outbox | Evento pode ter chegado; outbox ainda pendente. | Republica com mesmo eventId; consumidor deduplica. |
| Durante gravação da auditoria da DLQ | Se falhou, rollback do conjunto. | Mensagem reaparece e outro auditor tenta. |

O broker não desfaz o banco, e rollback do banco não desfaz um envio ao broker.
Inbox/outbox organizam justamente essas fronteiras.

`enableShutdownHooks` permite ao Nest reagir ao encerramento normal. Os workers
param os agendamentos e aguardam trabalhos em andamento; depois conexões fecham.
O Compose oferece 45 segundos de tolerância. Uma morte abrupta não executa hooks:
a recuperação depende do banco e da visibilidade da fila, não de limpeza perfeita.

## 18. Consultas, paginação e reconciliação

### Consultas simples

GET da wallet valida UUID, consulta via repositório, reidrata e devolve saldo/versão.
Não faz débito nem adquire o lock financeiro de escrita.

TransactionQueriesController consulta por UUID interno ou por provedor/ID externo.
Devolve estado, valores, referência, falha e resultado, sem expor hash/chave idempotente.
OPENING existe internamente e pode ser consultada por UUID.

### Extrato estável

Se usamos offset (“pule dez registros”), inserções concorrentes podem deslocar
resultados. O extrato usa um **cursor**, um marcador de continuação.

Cada lançamento tem sequence. A primeira página escolhe um limite superior; o
cursor guarda walletId, último sequence lido e esse limite. As próximas páginas
lêem somente dentro da mesma faixa. Novos lançamentos aparecem numa nova navegação.

Limite padrão: 50; máximo: 100. A consulta pede um registro a mais para descobrir
se existe próxima página. nextCursor null significa fim.

O cursor é codificado em base64url e validado; não é criptografado nem uma permissão
de acesso. Sequence usa string/BigInt, evitando perda de precisão de inteiros grandes.
O preenchimento dos lançamentos históricos garante ordem estável, não promete sua
ordem cronológica original.

### Reconciliação

É a conferência entre saldo salvo e saldo reconstruído:

```text
100 de abertura - 80 de BET + 10 de WIN = 30 calculado
saldo salvo = 30
diferença = saldo salvo - calculado = 0
```

LedgerRepository executa a agregação e comparação numa única consulta PostgreSQL.
Isso evita ler o saldo antes de um commit e o ledger depois dele, produzindo um
alarme falso. A aritmética permanece numeric e os resultados monetários são strings.

Se alguém alterar administrativamente o saldo para 29.99 sem ledger, retorna
consistent=false e diferença -0.01. Registra log/métrica. Não conserta em silêncio:
precisamos investigar qual dado está errado antes de intervir.

## 19. Logs, métricas e saúde

O problema operacional: se algo falhar, precisamos descobrir o quê sem imprimir
payloads financeiros inteiros nem confundir sistema vivo com sistema disponível.

**Log** descreve um acontecimento específico. `logEvent` escreve JSON com campos
permitidos, como evento, IDs, estado e código. IDs indisponíveis ficam null.
correlationId ajuda a relacionar mensagens da mesma operação. Valores financeiros,
headers, SQL bruto e stack não são incluídos pelo logger da aplicação.

**Métrica** resume observações. Exemplos:

- wager_transactions: quantidade por estado, consultada no banco.
- wager_duplicates_total: replays observados naquele processo.
- worker_retries_total: tentativas por tipo de worker.
- outbox_pending/outbox_lag_seconds: quantidade e idade do evento pendente mais antigo.
- sqs_dlq_messages/dead_letter_archived: fila atual e arquivo persistido.
- database_lock_conflicts_total: conflitos técnicos de locks observados.
- transaction_processing_seconds: distribuição de duração.
- reconciliation_divergences_total: divergências encontradas.

Um **contador** acumula ocorrências; um **gauge** mostra uma medida atual; um
**histograma** conta quantas observações caem em faixas, como até 0,1s ou até 1s.
Os contadores locais reiniciam com o processo. Métricas do banco refletem estado
compartilhado e não devem ser somadas como se cada instância tivesse dados próprios.

GET /metrics devolve texto compatível com Prometheus; não instalamos um servidor
Prometheus nem dashboard. Falha ao ler SQS sinaliza sqs_metrics_up=0 e omite a
quantidade desconhecida. Não finge que uma dependência indisponível está vazia.

**Liveness**, GET /health/live: o processo responde? Não consulta dependências.
**Readiness**, GET /health/ready: consegue acessar PostgreSQL e as filas necessárias?
Testa essas dependências em paralelo com limites de tempo e retorna 200 ou 503.

Uma API pode estar viva e sem condições de atender. Health não cria filas nem
envia apostas. Esses endpoints ficam abertos.

## 20. Docker, três instâncias e permissões

Uma **imagem** é o pacote para executar o programa; um **container** é uma execução
desse pacote. Dockerfile descreve a imagem; Compose descreve serviços e conexões.

O Dockerfile usa Bun 1.4.3, instala com lockfile congelado, copia código e executa
como usuário de sistema `bun`, não root. O lockfile fixa as versões resolvidas.

compose.yaml tem PostgreSQL e LocalStack. compose.app.yaml acrescenta setup e
três aplicações. Usar dois arquivos mantém o modo simples de estudo disponível.

```text
setup: migrations -> papel restrito -> filas
                            |
                    termina com sucesso
                            |
             app1          app2          app3
             :3001         :3002         :3003
                 \          |          /
                   PostgreSQL + SQS
```

Cada app contém HTTP e workers. Dentro do container, a porta é 3000; no Windows,
publicamos 3001/3002/3003. Não há balanceador. O script distribui os pedidos.

Dentro do container, localhost é o próprio container. Por isso DB_HOST=postgres
e SQS_ENDPOINT=http://localstack:4566 usam nomes dos serviços na rede do Compose.

O volume postgres_data guarda o banco mesmo quando o container é recriado.
LocalStack está sem persistência configurada: recriar seu container perde filas
e mensagens. Recriar filas não recupera eventos já marcados como publicados.
Reiniciar apenas uma API não apaga nenhum desses serviços.

### Dois usuários de banco

O setup usa pepe, administrador local, para criar estruturas. As APIs usam
wager_app, sem superuser/createdb/createrole. Esse papel tem leitura/escrita necessária
nas tabelas operacionais e apenas SELECT/INSERT no ledger e arquivo da DLQ.

Ele não recebe permissão para apagar/truncar ledger ou modificar migrations.
Uma aplicação defeituosa encontra mais uma barreira. O administrador continua
poderoso; não afirmamos que triggers impedem toda intervenção administrativa.

As credenciais fixas são de desenvolvimento local. A execução Bun fora do Docker
usa defaults administrativos se DB_USER/DB_PASSWORD não forem configurados.
Os testes que criam bancos temporários precisam do usuário de desenvolvimento.

## 21. Testes e exercícios práticos

### O que cada tipo comprova

**Unitário:** chama domínio sem infraestrutura para verificar regras específicas.
Exemplo: Money mantém centavos; Wallet não muda depois de um débito recusado.

**Integração:** executa junto com PostgreSQL/LocalStack reais. Exemplo: uma falha
na outbox desfaz também saldo, ledger e inbox.

**Concorrência:** operações se sobrepõem de verdade, inclusive processos distintos.
Exemplo: 50 pedidos iguais produzem um efeito; wallet bloqueada não impede outra.

Teste passando não prova todos os cenários possíveis. A evidência registrada é
144 testes e a demonstração adicional das três APIs. Os arquivos documentam quais
falhas, estados e concorrências foram exercitados.

### Comandos: sempre na raiz do repositório

No seu PowerShell:

```powershell
Set-Location 'C:\Users\pepee\Desktop\Dev\jungleGaming\backend-challenge'
```

Para subir a aplicação completa:

```powershell
docker compose -f compose.yaml -f compose.app.yaml up -d --build
docker compose -f compose.yaml -f compose.app.yaml ps
```

O primeiro constrói/inicia; o segundo mostra estado. Espere as APIs healthy.
Para verificar tipos e regras:

```powershell
bun run typecheck
bun test
```

Os testes usam infraestrutura local, criam bancos/filas temporários e os removem;
alguns testes de persistência anteriores usam rollback no banco local. Não aponte
essa suíte para produção. Migrations da configuração local precisam estar aplicadas.

Para a demonstração de três APIs:

```powershell
bun run scripts/verify-cluster.ts
```

Cria wallet de 100, disputa duas BET de 80, reenvia a vencedora 50 vezes, reinicia
app1 e verifica reconciliação/ledger nas três. Esperado: result=ok, balance=20.00,
um débito. Mantém a carteira para inspeção. Executá-lo novamente cria outra wallet.

### Exercício pequeno: observar as camadas

Com app1 pronta, na mesma raiz:

```powershell
Invoke-RestMethod http://localhost:3001/health/live
Invoke-RestMethod http://localhost:3001/health/ready | ConvertTo-Json -Depth 5
```

Esperado: live ok; ready com dependências up. Primeiro explique por que as duas
rotas existem, depois abra HealthController e ReadinessService para conferir.

Use o walletId impresso pelo verify-cluster:

```powershell
$walletId = 'COLE-O-UUID-DA-DEMONSTRACAO'
Invoke-RestMethod "http://localhost:3001/wallets/$walletId" | ConvertTo-Json -Depth 5
Invoke-RestMethod "http://localhost:3001/wallets/$walletId/ledger?limit=1" | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method Post "http://localhost:3001/wallets/$walletId/reconciliation" | ConvertTo-Json -Depth 5
```

Espere saldo 20, versão 2, página com cursor e reconciliação consistente.
Antes de executar, tente prever qual arquivo será chamado por cada rota.

### Como ler um teste

Separe preparação, ação e verificação. Por exemplo:

```text
Preparação: criar wallet com 100.
Ação: enviar duas BET de 80 em paralelo.
Verificação: uma aprovada, uma rejeitada, saldo 20, um débito, reconciliação correta.
```

Olhar apenas status HTTP seria insuficiente. Precisamos verificar o efeito real
no banco e o vínculo com o histórico. Testes de falhas também conferem o que NÃO
ficou gravado depois de um rollback.

## 22. Mapa de arquivos e ordem de estudo

Os caminhos abaixo partem da raiz do projeto. Leia funções pequenas e acompanhe
as chamadas, em vez de tentar memorizar um arquivo inteiro.

| Grupo | Arquivos e responsabilidade |
|---|---|
| Inicialização | main.ts abre Nest; app.module.ts registra componentes. |
| Autenticação | auth/provider-auth.guard.ts marca o ponto futuro de validação HTTP. |
| Conexão | database/database.service.ts inicia ORM e fornece fork; orm.config.ts lista conexão, schemas e migrations. |
| Erros HTTP | database/database-http.filter.ts traduz exceções técnicas. |
| Dinheiro | wallets/money.ts representa valor/moeda e operações exatas. |
| Carteira | wallets/wallet.ts controla saldo/versão; wallet-ledger-entry.ts constrói o movimento. |
| Entrada de wallet | wallets/wallets.controller.ts valida e adapta rotas; open-wallet.ts coordena abertura. |
| Persistência de wallet | wallet.repository.ts mapeia/bloqueia/salva; wallet.schema.ts descreve colunas. |
| Histórico | ledger.repository.ts insere, pagina e reconcilia; ledger-cursor.ts codifica/valida cursor; wallet-ledger-entry.schema.ts mapeia. |
| Entrada de operações | wagering/wagering.controller.ts adapta POST; transaction-input.ts valida e calcula hash. |
| Coordenação financeira | wagering/process-transaction.ts cuida de execução, replay, referências e gravação conjunta. |
| Regras da operação | wagering/wager-transaction.ts aplica regras e transições de estado. |
| Persistência de operação | wager-transaction.repository.ts consulta/reserva/salva; wager-transaction.schema.ts mapeia; transaction-result.ts tipa resposta. |
| Consultas | wagering/transaction-queries.controller.ts apresenta operações existentes. |
| Referências | reference-retry.worker.ts agenda; reference-retry-policy.ts define espera e limite. |
| Conexão SQS | messaging/sqs.ts configura cliente, filas e envio. |
| Consumo | sqs.consumer.ts recebe/processa/confirma; wager-envelope.ts valida envelope. |
| Inbox/outbox | message.repository.ts persiste; inbox-message.ts e outbox-message.ts controlam estados; message.schema.ts mapeia. |
| Eventos | integration-event.ts define envelope e subclasses. |
| Publicação | outbox.publisher.ts bloqueia evento, envia e registra resultado. |
| Agenda de mensageria | messaging.worker.ts executa consumidor, publisher e auditor, sem sobrepor a mesma tarefa local. |
| Auditoria de DLQ | dead-letter.consumer.ts arquiva/coordena FAILED; dead-letter.schema.ts mapeia arquivo. |
| Saúde | health/health.controller.ts expõe rotas; readiness.service.ts consulta dependências. |
| Observabilidade | observability/logger.ts seleciona campos; metrics.ts acumula observações; metrics.controller.ts expõe medições. |
| Estrutura SQL | database/migrations contém as oito mudanças versionadas. |

Em `scripts`: migrate.ts aplica/reverte; check-connection.ts testa conexão;
setup-queues.ts cria filas; send-transaction.ts envia envelope de arquivo;
setup-runtime-role.ts configura permissões locais; verify-cluster.ts demonstra
concorrência/replay/reinício nas três APIs.

Arquivos `.schema.ts` representam persistência, não os schemas Zod de entrada.
Arquivos `.fixture.ts` dentro de testes ajudam a executar cenários/processos de
teste; não são servidores adicionais exigidos para usar a aplicação.

Ordem sugerida para ler código:

1. Money e seu teste de soma.
2. Wallet.debit e WalletLedgerEntry.create.
3. OpenWallet.execute e WalletRepository.
4. WageringController.submit e ProcessTransaction.executeTransaction.
5. WagerTransaction.apply e ProcessTransaction.applyAndSave.
6. Replay, reserva idempotente e testes de concorrência.
7. SqsConsumer → MessageRepository → OutboxPublisher.
8. Referências, DLQ, consultas e observabilidade.

## 23. Limites e perguntas de entrevista

Você não precisa afirmar que dominou toda a stack. Precisa conseguir explicar o
fluxo implementado, as garantias que escolheu e as limitações conhecidas.

- Não implementamos autenticação efetiva; o ponto de extensão está conectado.
- BRL reduz escopo; testes de conflito preservam o modelo com moeda.
- Não existe consumidor de negócio de saída; a deduplicação por eventId é um
  contrato e há exemplo testado com recibo persistente.
- LocalStack sem persistência não protege contra apagar o armazenamento do broker.
- Prazos de retry são curtos para demonstração, sem estudo de carga/SLA.
- Migrations geradas automaticamente exigiriam revisão das regras especiais.
- A própria aplicação usa transações/locks; acesso administrativo arbitrário ao
  banco não é um caminho financeiro autorizado pelo desenho.
- Não implementamos balanceador, double-entry, painel ou teste de carga.

### Perguntas para responder sem olhar

1. Money é imutável; como Wallet consegue mudar o saldo?
2. Por que `flush` não significa que tudo já foi confirmado?
3. Se a migration criou wallets, por que a tabela ainda está vazia?
4. Qual diferença entre registro ORM e Wallet reidratada?
5. Onde a segunda BET de 80 espera e qual saldo ela lê depois?
6. Por que verificar existência antes do INSERT não basta para idempotência?
7. Por que replay devolve o saldo original e não o saldo atual?
8. Qual problema a inbox resolve que a outbox não resolve?
9. Em qual ponto uma queda pode causar publicação duplicada?
10. Por que LOSS não gera outro débito?
11. O que acontece com REFUND que chega antes da BET?
12. Por que uma rejeição pode receber commit e ack?
13. O que a reconciliação faz ao encontrar diferença?
14. Uma API viva pode estar indisponível para operar? Como sabemos?
15. O que mudou ao executar três containers, e por que o lock continuou funcionando?

Se você consegue desenhar a BET aceita, a BET rejeitada e o reenvio após queda,
já consegue explicar o núcleo do sistema. Depois acrescente referências e eventos,
sempre conectando cada peça ao problema concreto que ela resolve.
