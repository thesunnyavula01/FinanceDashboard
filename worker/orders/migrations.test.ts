import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Static checks over the SQL migrations.
 *
 * These exist because of a bug that got all the way to the database. This RAISE
 * looked fine:
 *
 *   raise exception '... and you have $%%.', a, b, c, d, e
 *
 * but `%%` is PL/pgSQL's escape for a literal percent sign, so it swallowed both
 * characters and left three placeholders for five arguments. Postgres rejects
 * that at CREATE FUNCTION time — which is the worst moment to find out, because
 * the migration is already being pasted into a live project and the whole
 * transaction rolls back on the last statement.
 *
 * `npm test` has no Postgres, so it cannot compile plpgsql. It can, however,
 * count. The check below is the compile error we already hit, moved to where it
 * costs nothing.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));

const FILES = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

/**
 * Read a single-quoted SQL string starting at `start` (the opening quote).
 * Doubled quotes ('') are an escaped quote, not a terminator.
 */
function readQuoted(sql: string, start: number): { value: string; end: number } | null {
  if (sql[start] !== "'") return null;

  let value = "";
  let i = start + 1;

  while (i < sql.length) {
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") {
        value += "'";
        i += 2;
        continue;
      }
      return { value, end: i + 1 };
    }
    value += sql[i];
    i += 1;
  }
  return null;
}

/** Placeholders in a RAISE format string. `%%` is a literal percent, not a slot. */
function countPlaceholders(format: string): number {
  let count = 0;
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== "%") continue;
    if (format[i + 1] === "%") {
      i += 1; // an escaped literal percent consumes both characters
      continue;
    }
    count += 1;
  }
  return count;
}

/**
 * Split the argument list that follows a RAISE format string, stopping at
 * `using` or the statement's semicolon. Commas inside parentheses belong to a
 * function call, not to the argument list, so the split is depth-aware.
 */
function countArguments(sql: string, from: number): number {
  let depth = 0;
  let i = from;
  let current = "";
  const args: string[] = [];

  while (i < sql.length) {
    const char = sql[i]!;

    if (char === "'") {
      const quoted = readQuoted(sql, i);
      if (!quoted) break;
      current += `'${quoted.value}'`;
      i = quoted.end;
      continue;
    }

    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;

    if (depth === 0) {
      // `using errcode = ...` ends the arguments, as does the statement itself.
      if (char === ";") break;
      if (/\s/.test(char) && /(^|\s)using$/i.test(current.trimEnd())) {
        args.push(current.replace(/\s*using$/i, ""));
        // Cleared before breaking, or the flush after the loop counts it twice.
        current = "";
        break;
      }
      if (char === ",") {
        args.push(current);
        current = "";
        i += 1;
        continue;
      }
    }

    current += char;
    i += 1;
  }

  if (current.trim() !== "") args.push(current);
  return args.filter((arg) => arg.trim() !== "").length;
}

interface RaiseStatement {
  file: string;
  format: string;
  placeholders: number;
  args: number;
  line: number;
}

function collectRaises(file: string, sql: string): RaiseStatement[] {
  const found: RaiseStatement[] = [];
  const pattern = /raise\s+exception\s+/gi;

  for (const match of sql.matchAll(pattern)) {
    const quoteAt = match.index! + match[0].length;
    const quoted = readQuoted(sql, quoteAt);
    if (!quoted) continue;

    // The comma between the format string and its first argument.
    let after = quoted.end;
    while (after < sql.length && /\s/.test(sql[after]!)) after += 1;
    const args = sql[after] === "," ? countArguments(sql, after + 1) : 0;

    found.push({
      file,
      format: quoted.value,
      placeholders: countPlaceholders(quoted.value),
      args,
      line: sql.slice(0, match.index!).split("\n").length,
    });
  }

  return found;
}

const RAISES = FILES.flatMap((name) =>
  collectRaises(name, readFileSync(MIGRATIONS_DIR + name, "utf8")),
);

test("the migrations contain RAISE statements to check", () => {
  // Guards the parser itself: a regex that silently stops matching would make
  // every assertion below vacuously true.
  assert.ok(RAISES.length > 15, `expected plenty of raises, found ${RAISES.length}`);
});

test("every RAISE has exactly as many placeholders as arguments", () => {
  const wrong = RAISES.filter((raise) => raise.placeholders !== raise.args);

  assert.deepEqual(
    wrong.map((r) => `${r.file}:${r.line} — ${r.placeholders} placeholders, ${r.args} args`),
    [],
    "Postgres rejects these at CREATE FUNCTION time, mid-migration",
  );
});

test("no RAISE puts two substitutions back to back", () => {
  // `$%%` is the exact shape that caused the outage: it reads as an escaped
  // percent, not as two values. Separating them with any literal character is
  // enough, and the placeholder count above would catch it anyway — this names
  // the specific trap so the next person sees why.
  const adjacent = RAISES.filter((raise) => /%%/.test(raise.format) && raise.args > 0);

  assert.deepEqual(
    adjacent.map((r) => `${r.file}:${r.line} — ${r.format}`),
    [],
    "%% is a literal percent sign; separate the two placeholders",
  );
});

test("every raised errcode is one the Worker knows how to map", () => {
  // An unmapped SQLSTATE reaches a member as a generic 500 rather than the
  // sentence the message was written to be.
  const known = new Set([
    // Order rejections — worker/routes/orders.ts.
    "FC001",
    "FC002",
    "FC003",
    "FC004",
    "FC005",
    "FC006",
    // Admin refusals — worker/routes/admin.ts.
    "FC010",
    "FC011",
    "FC012",
    "FC013",
    // Signup, before there is a season — worker/routes/auth.ts.
    "P0002",
  ]);
  const used = new Set<string>();

  for (const name of FILES) {
    const sql = readFileSync(MIGRATIONS_DIR + name, "utf8");
    for (const match of sql.matchAll(/errcode\s*=\s*'([^']+)'/g)) used.add(match[1]!);
  }

  assert.deepEqual([...used].filter((code) => !known.has(code)), []);
});

/**
 * Non-negotiable rule 2, checked at the database level.
 *
 * `security definer` means the function runs as its owner and ignores RLS, so
 * one that a browser session can execute is a hole straight through every
 * policy in the schema. Every one of them is revoked; this asserts that the
 * next one will be too.
 */
test("every security-definer function is revoked from anon and authenticated", () => {
  const defined: { file: string; name: string }[] = [];
  const revoked = new Set<string>();

  for (const name of FILES) {
    const sql = readFileSync(MIGRATIONS_DIR + name, "utf8");

    for (const match of sql.matchAll(/create\s+or\s+replace\s+function\s+(\w+)\s*\(/g)) {
      // Bounded to this function's own header. A lazy match across the whole
      // file would find the *next* function's `security definer` and report
      // every immutable helper above it as one.
      const start = match.index!;
      const next = sql.indexOf("create or replace function ", start + 1);
      const header = sql.slice(start, next === -1 ? undefined : next).split(/\bas\s+\$/)[0]!;

      if (/security\s+definer/.test(header)) defined.push({ file: name, name: match[1]! });
    }

    for (const match of sql.matchAll(/revoke\s+all\s+on\s+function\s+(\w+)\s*\(/g)) {
      revoked.add(match[1]!);
    }
  }

  assert.ok(defined.length > 5, `expected several definer functions, found ${defined.length}`);

  assert.deepEqual(
    defined.filter((fn) => !revoked.has(fn.name)).map((fn) => `${fn.file} — ${fn.name}()`),
    [],
  );
});

/** The body of a function, from its CREATE to the start of the next one. */
function bodyOf(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function ${name}(`);
  assert.notEqual(start, -1, `${name}() not found`);

  const next = sql.indexOf("create or replace function ", start + 1);
  return sql.slice(start, next === -1 ? undefined : next);
}

/** Which way each order side moves cash, read out of a function body. */
function cashDirections(body: string): Record<string, string> {
  const markers = [
    { side: "BUY", at: body.search(/=\s*'BUY'/) },
    { side: "SELL", at: body.search(/=\s*'SELL'/) },
    { side: "SHORT", at: body.search(/=\s*'SHORT'/) },
    { side: "COVER", at: body.search(/else\s*--\s*COVER/) },
  ].sort((a, b) => a.at - b.at);

  const directions: Record<string, string> = {};

  for (const [i, marker] of markers.entries()) {
    assert.notEqual(marker.at, -1, `no ${marker.side} branch`);
    const segment = body.slice(marker.at, markers[i + 1]?.at);
    const move = segment.match(/v_cash\s*:=[^;]*?([+-])\s*v_notional/);
    assert.ok(move, `no cash movement in the ${marker.side} branch`);
    directions[marker.side] = move[1]!;
  }

  return directions;
}

/**
 * rebuild_portfolio() restates place_order()'s arithmetic so a void or a
 * correction can replay a season without a price feed. Duplication is the
 * point — the live path must not depend on the correction path — but the two
 * drifting apart would mean a corrected portfolio quietly stops matching the
 * one the member actually traded into.
 */
test("the replay and place_order agree on which way each side moves cash", () => {
  const trading = readFileSync(MIGRATIONS_DIR + "0003_resting_orders.sql", "utf8");
  const adminSql = readFileSync(MIGRATIONS_DIR + "0005_admin.sql", "utf8");

  const live = cashDirections(bodyOf(trading, "place_order"));
  const replay = cashDirections(bodyOf(adminSql, "rebuild_portfolio"));

  // Buying and covering pay out; selling and shorting take in.
  assert.deepEqual(live, { BUY: "-", SELL: "+", SHORT: "+", COVER: "-" });
  assert.deepEqual(replay, live);
});

test("the replay starts from the portfolio's own baseline, not the season's", () => {
  const adminSql = readFileSync(MIGRATIONS_DIR + "0005_admin.sql", "utf8");
  const replay = bodyOf(adminSql, "rebuild_portfolio");

  // Reading the season's starting cash here would re-fund every member at
  // whatever an officer last typed into the console, which is exactly the bug
  // portfolios.starting_cash exists to prevent.
  assert.match(replay, /v_cash\s*:=\s*v_portfolio\.starting_cash/);
  assert.doesNotMatch(replay, /v_season\.starting_cash/);
});

test("signup stamps the baseline onto the portfolio it creates", () => {
  const adminSql = readFileSync(MIGRATIONS_DIR + "0005_admin.sql", "utf8");
  const bootstrap = bodyOf(adminSql, "bootstrap_member");

  // A portfolio with no baseline cannot report a return, and the column is
  // NOT NULL, so this is also what stops signup failing outright.
  assert.match(bootstrap, /insert into portfolios \(season_id, user_id, cash, starting_cash\)/);
});
