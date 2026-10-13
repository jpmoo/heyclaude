// Arithmetic, done exactly. The model is not left to do sums: asked for 17
// percent of 3,480 it said 626.4. It writes the sum out and this works it.
//
// Numbers (commas allowed), + - * / ^, brackets, "17% of 3480", a trailing %
// for "per cent", and the functions and constants listed below.

const FUNCTIONS = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  ln: Math.log, log: Math.log10, exp: Math.exp, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  min: Math.min, max: Math.max,
  average: (...values) => values.reduce((sum, value) => sum + value, 0) / values.length,
  sum: (...values) => values.reduce((total, value) => total + value, 0),
};
const CONSTANTS = { pi: Math.PI, e: Math.E };

export function calculate(expression) {
  const text = String(expression).toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, "$1") // 3,480
    .replace(/×|\bx\b|\btimes\b/g, "*").replace(/÷|\bdivided by\b|\bover\b/g, "/")
    .replace(/\bplus\b/g, "+").replace(/\bminus\b/g, "-").replace(/\*\*/g, "^")
    .replace(/\bpercent\b|\bper cent\b/g, "%").replace(/\bof\b/g, "*");
  const tokens = text.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[a-z]+|[-+*/^%(),]/g) ?? [];
  if (tokens.join("") !== text.replace(/\s+/g, "")) throw new Error("there is something in it that is not arithmetic");
  let at = 0;
  const peek = () => tokens[at];
  const take = (wanted) => {
    if (wanted && tokens[at] !== wanted) throw new Error(`expected ${wanted}`);
    return tokens[at++];
  };
  const sum = () => {
    let value = product();
    while (peek() === "+" || peek() === "-") {
      const plus = take() === "+";
      const from = at;
      let term = product();
      // "100 minus 15%" is fifteen per cent off the hundred, as on a calculator.
      if (at - from === 2 && tokens[at - 1] === "%") term *= value;
      value = plus ? value + term : value - term;
    }
    return value;
  };
  const product = () => {
    let value = power();
    for (;;) {
      if (peek() === "*") { take(); value *= power(); }
      else if (peek() === "/") { take(); value /= power(); }
      else return value;
    }
  };
  const power = () => {
    const base = unary();
    if (peek() !== "^") return base;
    take();
    return base ** power();
  };
  const unary = () => {
    if (peek() === "-") { take(); return -unary(); }
    if (peek() === "+") { take(); return unary(); }
    let value = atom();
    // 17% is seventeen hundredths.
    while (peek() === "%") { take(); value /= 100; }
    return value;
  };
  const atom = () => {
    const token = take();
    if (token === undefined) throw new Error("it stops short");
    if (token === "(") { const value = sum(); take(")"); return value; }
    if (/^[\d.]/.test(token)) return Number(token);
    if (token in CONSTANTS) return CONSTANTS[token];
    if (token in FUNCTIONS) {
      take("(");
      const values = [sum()];
      while (peek() === ",") { take(); values.push(sum()); }
      take(")");
      return FUNCTIONS[token](...values);
    }
    throw new Error(`"${token}" is not something that can be worked out`);
  };
  const value = sum();
  if (at < tokens.length) throw new Error(`"${tokens[at]}" was not expected there`);
  if (!Number.isFinite(value)) throw new Error("it does not come to a number");
  // Twelve significant figures, without the tail binary fractions leave.
  return String(Number(value.toPrecision(12)));
}
