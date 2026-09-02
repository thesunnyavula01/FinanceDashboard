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
function bodyOf(sql: string, name: string): string | null {
  const start = sql.indexOf(`create or replace function ${name}(`);
  if (start === -1) return null;

  const next = sql.indexOf("create or replace function ", start + 1);
  return sql.slice(start, next === -1 ? undefined : next);
}

/**
 * The definition that is actually live: the last one, reading the migrations in
 * order, since a later file replaces an earlier one.
 *
 * Reading a fixed filename was fine while each function was defined once. The
 * moment 0006 recreated place_order() it stopped being fine — the drift alarm
 * would have gone on watching a definition the database no longer runs, which
 * is worse than no alarm because it reports green.
 */
function liveBodyOf(name: string): string {
  let found: string | null = null;

  for (const file of FILES) {
    const body = bodyOf(readFileSync(MIGRATIONS_DIR + file, "utf8"), name);
    if (body) found = body;
  }

  assert.ok(found, `${name}() is not defined in any migration`);
  return found;
}

/**
 * Which way each order side moves cash, read out of a function body.
 *
 * `sides` is passed in because the two functions do not carry the same set:
 * only the replay knows about EXPIRE, since nothing places an expiry as an
 * order.
 */
function cashDirections(body: string, sides: readonly string[]): Record<string, string> {
  const markers = sides
    .map((side) => ({
      side,
      // COVER is always the trailing `else`, so it has no test of its own to
      // search for.
      at: side === "COVER" ? body.search(/else\s*--\s*COVER/) : body.search(new RegExp(`=\\s*'${side}'`)),
    }))
    .sort((a, b) => a.at - b.at);

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
  const ORDER_SIDES = ["BUY", "SELL", "SHORT", "COVER"] as const;

  const live = cashDirections(liveBodyOf("place_order"), ORDER_SIDES);
  const replay = cashDirections(liveBodyOf("rebuild_portfolio"), [...ORDER_SIDES, "EXPIRE"]);

  // Buying and covering pay out; selling and shorting take in.
  assert.deepEqual(live, { BUY: "-", SELL: "+", SHORT: "+", COVER: "-" });

  for (const side of ORDER_SIDES) {
    assert.equal(replay[side], live[side], `the replay moves cash the other way on ${side}`);
  }

  // Settlement is a sale at intrinsic value, so it pays in like one. A worthless
  // contract settles at zero, which moves cash by zero rather than not at all —
  // the direction is still the direction.
  assert.equal(replay.EXPIRE, "+");
});

test("the replay starts from the portfolio's own baseline, not the season's", () => {
  const replay = liveBodyOf("rebuild_portfolio");

  // Reading the season's starting cash here would re-fund every member at
  // whatever an officer last typed into the console, which is exactly the bug
  // portfolios.starting_cash exists to prevent.
  assert.match(replay, /v_cash\s*:=\s*v_portfolio\.starting_cash/);
  assert.doesNotMatch(replay, /v_season\.starting_cash/);
});

test("signup stamps the baseline onto the portfolio it creates", () => {
  // A portfolio with no baseline cannot report a return, and the column is
  // NOT NULL, so this is also what stops signup failing outright.
  assert.match(
    liveBodyOf("bootstrap_member"),
    /insert into portfolios \(season_id, user_id, cash, starting_cash\)/,
  );
});

/**
 * The contract multiplier, checked everywhere money is made out of a quantity.
 *
 * An option is a hundred shares. Every product below was `qty * price` before
 * 0006 and is right for a stock either way, so a missed one is invisible until
 * somebody trades a contract — and then it is wrong by two orders of magnitude
 * in a column nobody re-derives.
 */
test("every notional the SQL computes carries the contract multiplier", () => {
  const sites: { fn: string; pattern: RegExp }[] = [
    // The four fills, plus the replay's single shared expression.
    { fn: "place_order", pattern: /v_notional\s*:=\s*round\(p_qty \* v_multiplier \* p_price, 2\)/ },
    {
      fn: "rebuild_portfolio",
      pattern: /v_notional\s*:=\s*round\(v_trade\.qty \* v_mult \* v_trade\.price, 2\)/,
    },
    {
      fn: "settle_option_expiry",
      pattern: /v_notional\s*:=\s*round\(v_position\.qty \* v_position\.multiplier \* p_intrinsic, 2\)/,
    },
  ];

  for (const site of sites) {
    assert.match(liveBodyOf(site.fn), site.pattern, `${site.fn}() lost the multiplier`);
  }

  // place_order() writes four notionals, one per side, and every one of them
  // has to carry it — three out of four is the worst possible outcome.
  const fills = liveBodyOf("place_order").match(/v_notional\s*:=\s*round\(/g) ?? [];
  const multiplied = liveBodyOf("place_order").match(/v_notional\s*:=\s*round\(p_qty \* v_multiplier/g) ?? [];
  assert.equal(fills.length, 4, "place_order() should compute exactly one notional per side");
  assert.equal(multiplied.length, 4, "a side is computing its notional without the multiplier");
});

test("every market value the SQL sums carries the contract multiplier", () => {
  // A book holding stock and contracts is valued in one pass, so the multiplier
  // has to come off the position rather than off the caller.
  assert.match(liveBodyOf("place_order"), /sum\(post\.qty \* post\.mult \* post\.mark\)/);
  assert.match(liveBodyOf("place_order"), /sum\(-post\.qty \* post\.mult \* post\.mark\)/);

  for (const fn of ["queue_order", "cancel_pending_order"]) {
    assert.match(
      liveBodyOf(fn),
      /sum\(abs\(pos\.qty\) \* pos\.multiplier \* pos\.avg_cost\)/,
      `${fn}() sizes margin without the multiplier`,
    );
  }
});

test("realised profit is money, so it carries the multiplier too", () => {
  const live = liveBodyOf("place_order");
  // SELL and COVER are the only two sides that realise anything.
  assert.match(live, /v_realized\s*:=\s*round\(\(p_price - v_prev_avg\) \* p_qty \* v_multiplier, 2\)/);
  assert.match(live, /v_realized\s*:=\s*round\(\(v_prev_avg - p_price\) \* p_qty \* v_multiplier, 2\)/);

  const replay = liveBodyOf("rebuild_portfolio");
  assert.equal(
    (replay.match(/v_realized\s*:=\s*round\([^;]*\* v_mult, 2\)/g) ?? []).length,
    3,
    "SELL, EXPIRE and COVER each realise, and each needs the multiplier",
  );
});

/**
 * The SQL mirror of allowsShort() in worker/market/symbols.ts.
 *
 * The Worker refuses a short on a contract or a coin first and with a better
 * sentence. This is the line underneath it, at the level that actually moves
 * money — and it is only worth having if it agrees with the classifier it
 * mirrors.
 */
test("the SQL knows which symbols can be sold short, and both order paths ask", () => {
  const guard = liveBodyOf("symbol_allows_short");

  assert.match(guard, /not like '%\/%'/, "a slash means a crypto pair");
  assert.match(
    guard,
    /\^\[A-Z\]\[A-Z0-9\]\{0,5\}\[0-9\]\{6\}\[CP\]\[0-9\]\{8\}\$/,
    "the OCC tail is what marks an option contract",
  );

  for (const fn of ["place_order", "queue_order"]) {
    assert.match(
      liveBodyOf(fn),
      /v_side in \('SHORT', 'COVER'\) and not symbol_allows_short\(v_symbol\)/,
      `${fn}() would let a member short a contract`,
    );
  }
});

test("expiry settles a long position and releases what it was holding", () => {
  const settle = liveBodyOf("settle_option_expiry");

  // Same lock, same order as place_order(), or the two deadlock against each
  // other the first time a member trades during their own expiry.
  assert.match(settle, /from portfolios where id = v_owner for update/);
  assert.match(settle, /from positions where id = p_position_id for update/);

  // A short option cannot exist here, and settling one would book the profit
  // backwards rather than fail.
  assert.match(settle, /if v_position\.qty <= 0 then/);

  // A working order against a contract that no longer exists would hold its
  // reservation forever.
  assert.match(settle, /update pending_orders[\s\S]*?reserved_cash = 0,\s*reserved_qty = 0/);
});
