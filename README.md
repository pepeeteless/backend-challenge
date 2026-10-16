# Como rodar o projeto

Olá! Para facilitar a avaliação, deixei o ambiente preparado com Docker Compose.
Você vai precisar do **Docker Desktop rodando**. Para executar os testes localmente, também precisa do **Bun 1.x**.

## Subindo a aplicação

Na raiz do projeto, execute:

docker compose -f compose.yaml -f compose.app.yaml up -d --build

Esse comando sobe o PostgreSQL, o LocalStack e três instâncias da API. Também aplica as migrações e cria as filas automaticamente. A primeira execução pode demorar um pouco por causa do download das imagens.

As APIs ficam disponíveis nas portas **3001, 3002 e 3003**. Para conferir se está tudo pronto, acesse:

http://localhost:3001/health/ready

O resultado esperado é `status: "ok"`, com PostgreSQL e SQS como `"up"`.

## Executando os testes

Com os serviços rodando, copie `.env.example` para `.env`, caso ainda não tenha esse arquivo. Depois rode.

bun install --frozen-lockfile
bun run typecheck
bun run test

Os testes de integração usam PostgreSQL e LocalStack reais.

## Testando a API

Você pode usar Insomnia ou Postman, com a base `http://localhost:3001`. As principais rotas são:

- `POST /wallets` — criar carteira.
- `GET /wallets/:id` — consultar saldo.
- `POST /wagering/transactions` — enviar operações, incluindo o header `Idempotency-Key`.
- `GET /wallets/:id/ledger` — consultar o extrato.
- `POST /wallets/:id/reconciliation` — conferir o saldo com o extrato.

Substitua `:id` pelo identificador da carteira. Os valores monetários devem ser enviados como texto, com duas casas decimais, por exemplo: `"80.00"`.

Para finalizar todo o teste rode.

docker compose -f compose.yaml -f compose.app.yaml down

Esse comando encerra os serviços.
