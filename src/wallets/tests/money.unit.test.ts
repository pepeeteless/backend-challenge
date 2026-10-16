import { expect, test } from "bun:test";
import { Money } from "../money";

test("soma valores exatos sem alterar os originais", () => {
  const primeiro = Money.from({ amount: "0.10", currency: "BRL" });
  const segundo = Money.from({ amount: "0.20", currency: "BRL" });

  const resultado = primeiro.add(segundo);

  expect(resultado.toJSON()).toEqual({
    amount: "0.30",
    currency: "BRL",
  });

  expect(primeiro.toJSON().amount).toBe("0.10");
  expect(segundo.toJSON().amount).toBe("0.20");
  expect(resultado).not.toBe(primeiro);
  expect(resultado).not.toBe(segundo);
});

test.each([
  "",
  "NaN",
  "Infinity",
  "1e2",
  "-1.00",
  "1.999",
  "25",
  "25.0",
  " 25.00 ",
])("rejeita valor monetário inválido: %s", (amount) => {
  expect(() => Money.from({ amount, currency: "BRL" })).toThrow();
});

test("preserva valores grandes sem converter para number", () => {
  const money = Money.from({
    amount: "9007199254740993.01",
    currency: "BRL",
  });

  expect(money.toJSON().amount).toBe("9007199254740993.01");
});

test("rejeita soma entre moedas diferentes", () => {
  const reais = Money.from({ amount: "10.00", currency: "BRL" });
  const dolares = Money.from({ amount: "10.00", currency: "USD" });

  expect(() => reais.add(dolares)).toThrow();
});

test("subtrai e permite resultado negativo sem alterar a origem", () => {
  const saldo = Money.from({ amount: "100.00", currency: "BRL" });
  const valor = Money.from({ amount: "160.00", currency: "BRL" });

  const resultado = saldo.subtract(valor);

  expect(resultado.toJSON().amount).toBe("-60.00");
  expect(resultado.isNegative()).toBe(true);
  expect(saldo.toJSON().amount).toBe("100.00");
});

test("compara saldo e valor de uma aposta", () => {
  const saldo = Money.from({ amount: "100.00", currency: "BRL" });
  const aposta = Money.from({ amount: "80.00", currency: "BRL" });

  expect(saldo.isLessThan(aposta)).toBe(false);
  expect(saldo.subtract(aposta).isLessThan(aposta)).toBe(true);
  expect(aposta.isPositive()).toBe(true);
});

test("inverte o sinal e reconhece zero", () => {
  const valor = Money.from({ amount: "80.00", currency: "BRL" });
  const zero = Money.zero("BRL");

  expect(valor.negate().toJSON().amount).toBe("-80.00");
  expect(valor.add(valor.negate()).equals(zero)).toBe(true);
  expect(zero.isZero()).toBe(true);
  expect(zero.isPositive()).toBe(false);
  expect(zero.isNegative()).toBe(false);
});

test("rejeita subtração e comparações entre moedas diferentes", () => {
  const brl = Money.from({ amount: "10.00", currency: "BRL" });
  const usd = Money.from({ amount: "10.00", currency: "USD" });

  expect(() => brl.subtract(usd)).toThrow();
  expect(() => brl.isLessThan(usd)).toThrow();
  expect(() => brl.equals(usd)).toThrow();
});

test("preserva centavos ao somar valores próximos do limite", () => {
  const valor = Money.from({
    amount: "999999999999999999.98",
    currency: "BRL",
  });
  const centavo = Money.from({ amount: "0.01", currency: "BRL" });

  expect(valor.add(centavo).toJSON().amount).toBe("999999999999999999.99");
});

test("rejeita entrada acima do limite", () => {
  expect(() =>
    Money.from({
      amount: "1000000000000000000.00",
      currency: "BRL",
    }),
  ).toThrow();
});

test("rejeita soma acima do limite sem alterar o original", () => {
  const maximo = Money.from({
    amount: "999999999999999999.99",
    currency: "BRL",
  });
  const centavo = Money.from({ amount: "0.01", currency: "BRL" });

  expect(() => maximo.add(centavo)).toThrow();
  expect(maximo.toJSON().amount).toBe("999999999999999999.99");
});
