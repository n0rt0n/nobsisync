/** Сверка MD5 с node:crypto. Основной риск — паддинг на границах блоков. */
const crypto = require("crypto");
const { md5 } = require("./.build/md5.js");
const { makeAsserter } = require("./fakes.cjs");

const { state, eq } = makeAsserter();
const check = (buf, label) =>
  eq(md5(new Uint8Array(buf)), crypto.createHash("md5").update(buf).digest("hex"), label);

// Канонические векторы RFC 1321
for (const v of [
  "",
  "a",
  "abc",
  "message digest",
  "abcdefghijklmnopqrstuvwxyz",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  "1234567890".repeat(8),
]) {
  check(Buffer.from(v, "utf8"), `вектор ${JSON.stringify(v.slice(0, 20))}`);
}

// Границы блока и паддинга: 55/56 и 63/64 ломают наивные реализации
for (let n = 0; n <= 200; n++) {
  check(Buffer.alloc(n, 0xab), `однобайтовая заливка длиной ${n}`);
  check(crypto.randomBytes(n), `случайные ${n} байт`);
}

for (const n of [1023, 1024, 1025, 4096, 65535, 65536, 1024 * 1024 + 7]) {
  check(crypto.randomBytes(n), `случайные ${n} байт`);
}

check(Buffer.from("Заметка про синхронизацию — ёжик 🦔", "utf8"), "utf8 с кириллицей и эмодзи");

// Подмассив с ненулевым byteOffset: частый источник ошибок в реализациях на DataView
const big = crypto.randomBytes(500);
eq(
  md5(new Uint8Array(big.buffer, big.byteOffset + 100, 300)),
  crypto.createHash("md5").update(big.subarray(100, 400)).digest("hex"),
  "подмассив с ненулевым byteOffset"
);

console.log(`  проверок: ${state.total}, провалов: ${state.fail}`);
process.exit(state.fail ? 1 : 0);
