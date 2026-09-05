import type { ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Panel } from "@/components/terminal/Panel";
import { useAuth } from "@/lib/auth";

/**
 * The two documents, behind one address and no function key.
 *
 * This is the one screen in the app that is a document rather than an
 * instrument, and it is the only place where density loses an argument: a
 * clause set at the grid's 1.35 leading across the full panel width runs to two
 * hundred characters a line and nobody reads it. So the prose gets a measure
 * and leading, and nothing else about the terminal changes — same panel, same
 * hairlines, same amber-is-interface rule, and no green or red anywhere,
 * because nothing on this screen is a gain or a loss.
 *
 * The two tables are the point. "What is held about me" and "who else touches
 * it" are the only questions anyone opens a privacy policy with, and this app
 * answers every other question in a grid already.
 */

const DOCS = ["terms", "privacy"] as const;
type Doc = (typeof DOCS)[number];

/** Bump this whenever a clause below changes. It is the date on the screen. */
const UPDATED_ISO = "2026-09-05";
const UPDATED_LABEL = "5 September 2026";

/**
 * Who to ask. The club runs no support inbox, so this is deliberately a person
 * and not an address — swap it for a real one the day that changes.
 */
const CONTACT = "a club officer";

function isDoc(value: string | undefined): value is Doc {
  return DOCS.includes(value as Doc);
}

/**
 * One numbered clause. Legal text is one of the few things in this app that is
 * genuinely a numbered sequence — an officer has to be able to say "clause 5"
 * — so the number sits in the gutter, monospaced, like every other identifier
 * in this terminal.
 */
function Clause({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="flex gap-3 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <span className="num w-4 shrink-0 pt-px text-right text-accent-dim" aria-hidden="true">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[0.875rem] leading-snug font-semibold text-ink">{title}</h3>
        <div className="mt-1.5 space-y-2 text-[0.8125rem] leading-[1.7] text-ink-dim">
          {children}
        </div>
      </div>
    </section>
  );
}

/** A list with no bullet glyphs — the hairline does that job everywhere else. */
function Points({ children }: { children: ReactNode }) {
  return <ul className="space-y-1.5 border-l border-line pl-3">{children}</ul>;
}

/**
 * A literal database table. Mono means "this is an identifier the machine
 * owns" everywhere else in the app, so it is spent on the two table names and
 * not on the sentences around them.
 */
function Table({ children }: { children: string }) {
  return <span className="num text-ink">{children}</span>;
}

interface FactsProps {
  columns: [string, string, string];
  rows: Array<[ReactNode, ReactNode, ReactNode]>;
}

/** The grid a privacy policy should have been all along. */
function Facts({ columns, rows }: FactsProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[24rem] border-collapse border border-line text-left">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" className="label border-b border-line px-2 py-1.5">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t border-line align-top">
              <td className="px-2 py-1.5 text-ink">{row[0]}</td>
              <td className="px-2 py-1.5 text-ink-dim">{row[1]}</td>
              <td className="px-2 py-1.5 text-ink-dim">{row[2]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Terms() {
  return (
    <>
      <Clause n={1} title="What this is">
        <p>
          The Finance Club Terminal is a paper-trading simulation the club runs for its members.
          Every dollar in it is a number in a database. No stock, coin or contract is ever bought
          or sold, no money moves, and nothing here is a brokerage account. The club is not a
          broker-dealer, an investment adviser or a bank, and no screen in this app is an offer
          to trade anything real.
        </p>
      </Clause>

      <Clause n={2} title="It is not investment advice">
        <p>
          Nothing here recommends buying or selling anything. The prices, the P/L, the
          leaderboard and the sector map exist to teach how a market behaves. What you do with
          real money is yours alone, and belongs with a licensed adviser rather than with a club
          project.
        </p>
      </Clause>

      <Clause n={3} title="Who can use it">
        <p>
          You need an invite code from an officer, and it is meant for you: one account per
          member, and neither your password nor the code is yours to pass on. A code that reaches
          a group chat gets rotated, and the old one stops working the moment it does.
        </p>
        <p>
          You must be at least 13 to hold an account. If you are under 18, use it with the
          permission of a parent or guardian and of the club's faculty advisor.
        </p>
      </Clause>

      <Clause n={4} title="The prices are close, not exact">
        <p>Market data comes from Alpaca and Finnhub, on their free plans.</p>
        <Points>
          <li>
            A stock's last-trade price is IEX only — one exchange out of many — so a thinly
            traded name can sit slightly behind the consolidated tape.
          </li>
          <li>
            Daily closes and historical bars are the full consolidated data, and are accurate.
          </li>
          <li>
            Option quotes come from the indicative feed, and option prints lag by fifteen
            minutes. There are no greeks and no implied volatility on this feed at all.
          </li>
          <li>
            Every fill is simulated. The server prices your order itself, at the market, at the
            moment it runs — a real order the same size might fill elsewhere, or not at all.
          </li>
        </Points>
        <p>
          Treat every figure on these screens as a teaching approximation, and never as a reason
          to move real money.
        </p>
      </Clause>

      <Clause n={5} title="The rules of a season">
        <p>
          The club sets them and the app enforces them: US market hours for stocks and options,
          around the clock for crypto, Reg T margin at 1.5x on a short, long options only, and
          cash settlement at expiry. An order outside those rules is refused with the reason.
        </p>
        <p>
          An officer can lock trading, void or amend a fill, and reset a season. A correction
          replays your portfolio from its starting cash, which rewrites the average cost and the
          realised P/L of every later trade in that symbol — so your history and your rank can
          change after the fact. That is what a correction is, not a fault.
        </p>
      </Clause>

      <Clause n={6} title="Fair play">
        <p>
          Trade the simulation, not the software. Do not automate order entry, script the API, or
          drive it faster than a person can type. Do not probe or work around the checks, your
          own or anybody else's. If you find a hole, tell an officer — being the member who
          reported it is worth more here than any score farmed with it. Officers can reset a
          portfolio, void trades, or close an account over this.
        </p>
      </Clause>

      <Clause n={7} title="Seasons end, and the data goes with them">
        <p>
          There is no uptime promise. Screens go down, market data goes stale, and an officer can
          reset or wipe a season at any time — that is what resetting a season means. Keep your
          own copy of anything you want to hang on to.
        </p>
      </Clause>

      <Clause n={8} title="Provided as it is">
        <p>
          The club, its officers, its faculty advisor and the school run this as a student
          project and provide it as it is, with no warranty of any kind. As far as the law
          allows, none of them is liable for anything that follows from using it or from being
          unable to. No real money is at stake here by design, which is the strongest guarantee
          on this page.
        </p>
      </Clause>

      <Clause n={9} title="Changes">
        <p>
          These terms change when the app does, and the date above is when they last did.
          Carrying on using the terminal is how you accept the version that is on it.
        </p>
      </Clause>

      <Clause n={10} title="Questions">
        <p>Ask {CONTACT}.</p>
      </Clause>
    </>
  );
}

function Privacy() {
  return (
    <>
      <Clause n={1} title="The short version">
        <p>
          An account needs an email address, a password and a display name. Your trading is
          visible to the rest of the club on purpose — that is what a club leaderboard is.
          Nothing is sold, nothing is advertised, and there is no analytics or tracking of any
          kind in this app.
        </p>
      </Clause>

      <Clause n={2} title="What the terminal holds about you">
        <Facts
          columns={["What", "Where it lives", "Who can see it"]}
          rows={[
            ["Email address", "Supabase Auth", "You, and an officer with database access"],
            ["Password", "Supabase Auth, hashed", "Nobody — officers included"],
            ["Display name", <Table>profiles</Table>, "Every member. It is the leaderboard"],
            ["Role: member or officer", <Table>profiles</Table>, "Every member"],
            ["Cash, positions and fills", "Supabase Postgres", "Every member in the season"],
            ["Resting orders", <Table>pending_orders</Table>, "You, and an officer"],
            ["Your sign-in session", "Your browser", "You, on that device"],
            [
              "IP address and request time",
              "Cloudflare logs",
              "Cloudflare, and officers with dashboard access",
            ],
          ]}
        />
        <p>
          That is the whole list. There is no phone number, no address, no school record and no
          payment detail anywhere in this app, because it never needed one.
        </p>
      </Clause>

      <Clause n={3} title="Why the whole club can see your trades">
        <p>
          This is a learning club, and half of what a member gets out of a season is seeing what
          everyone else bought and how it went. Positions, fills and returns are open across the
          active season deliberately.
        </p>
        <p>
          Two things are never open. Your email address, which only you and an officer with
          database access ever see. And your resting orders, which are intent rather than history
          — publishing those would invite the rest of the club to trade in front of you.
        </p>
      </Clause>

      <Clause n={4} title="Who else touches it">
        <Facts
          columns={["Service", "Its one job", "What it receives"]}
          rows={[
            [
              "Supabase",
              "Database and sign-in",
              "Everything in the table above except the request logs",
            ],
            [
              "Cloudflare",
              "Hosting and the server",
              "Ordinary web request logs: IP address, time, path",
            ],
            ["Alpaca", "Prices and news", "Ticker symbols. Never a member, never a portfolio"],
            ["Finnhub", "Company profiles, news and earnings", "Ticker symbols or the crypto news category"],
            ["GDELT", "Web headlines", "A company or asset name"],
            ["SEC EDGAR", "Filings and reported earnings", "A ticker or company identifier, and the club's public contact"],
            ["Hacker News / Algolia", "Community discussion", "A company or asset name"],
          ]}
        />
        <p>
          No advertising networks, no analytics, no data brokers, and nobody is paid in your
          data. Even the fonts ship inside the app rather than loading from Google, so opening
          the terminal makes no request to anyone outside this table.
        </p>
        <p>
          Prices are fetched in batches and research results are cached across the club. These
          server requests contain no member identity or portfolio. Opening an article, filing
          or discussion link visits that publisher's site, which has its own privacy practices.
        </p>
      </Clause>

      <Clause n={5} title="Cookies, and what your browser keeps">
        <p>
          No advertising or analytics cookies — none at all, rather than "essential only". The
          single thing kept in your browser is your sign-in session, in local storage, so a
          refresh does not throw you back to the login screen. Clearing this site's data signs
          you out and leaves nothing behind.
        </p>
      </Clause>

      <Clause n={6} title="How it is kept safe">
        <Points>
          <li>
            Your password is hashed by Supabase. It is not stored anywhere in a form anyone can
            read it back from, officers included.
          </li>
          <li>
            The browser can only read. Every write — every order, every correction — goes through
            the server, which checks who you are first.
          </li>
          <li>
            Row-level security applies the same rules inside the database, as a second line
            underneath that.
          </li>
          <li>
            The keys that could bypass all of it stay on the server and are never shipped to the
            browser. The build fails if one ever is.
          </li>
        </Points>
        <p>
          This is still a student project and not a bank. Use a password you do not use anywhere
          else — it is the single most useful thing you can do on this page.
        </p>
      </Clause>

      <Clause n={7} title="How long it is kept">
        <p>
          As long as the club keeps the season. Resetting a season clears its portfolios,
          positions and trades, and officers may wipe accounts at the end of a school year.
        </p>
        <p>
          You can ask {CONTACT} to delete your account and portfolio at any time, and they can do
          it in a minute. Mid-season that also takes you off the leaderboard, and it cannot be
          undone.
        </p>
      </Clause>

      <Clause n={8} title="If you are under 18">
        <p>
          Nothing above changes and nothing extra is collected. No member's data is sold, used
          for advertising, or shared beyond the services listed. A parent, guardian or the
          faculty advisor can ask an officer what is held about a member and have it deleted.
        </p>
      </Clause>

      <Clause n={9} title="Changes and questions">
        <p>The date above is when this last changed. Anything else, ask {CONTACT}.</p>
      </Clause>
    </>
  );
}

const LEDE: Record<Doc, string> = {
  terms: "What the terminal is, what it is not, and what the club expects while you use it.",
  privacy: "What the terminal knows about you, who can see it, and what leaves this app.",
};

/**
 * `/legal`, `/legal/terms` and `/legal/privacy`.
 *
 * Two paths rather than one screen with a hidden tab, because a legal document
 * is the one thing in this app somebody genuinely needs to link to — an officer
 * pasting "read the privacy policy" into the club chat wants the link to land
 * on the privacy policy. Everything else the terminal keeps in component state
 * stays there.
 *
 * It renders signed out as well as signed in, since the terms have to be
 * readable before there is an account to agree to them with.
 */
export function Legal() {
  const { doc } = useParams<{ doc?: string }>();
  const navigate = useNavigate();
  const { session } = useAuth();

  // An unknown slug shows the terms rather than a 404. A legal address that
  // answers "no such screen" is the one dead link worth going out of the way
  // to avoid, because it is the one somebody else pasted.
  const active: Doc = isDoc(doc) ? doc : "terms";

  return (
    // The panel hugs the measure rather than running the width of the screen.
    // A 68-character line is the whole reason this screen exists, and a panel
    // wider than its own prose reads as a layout that failed rather than as a
    // document.
    <div className="h-full overflow-auto bg-canvas p-2.5">
      <div className="mx-auto max-w-[34rem]">
        {!session && (
          <h1 className="mb-3 text-[0.6875rem] font-semibold tracking-[0.18em] text-accent uppercase">
            Finance Club Terminal
          </h1>
        )}

        <Panel
          title="Legal"
          tabs={[
            { id: "terms", label: "Terms of use" },
            { id: "privacy", label: "Privacy policy" },
          ]}
          activeTab={active}
          onTabChange={(id) => navigate(`/legal/${id}`)}
          meta={
            <>
              Updated <time dateTime={UPDATED_ISO}>{UPDATED_LABEL}</time>
            </>
          }
        >
          <div>
            <p className="mb-4 text-[0.8125rem] leading-[1.7] text-ink">{LEDE[active]}</p>

            <div className="space-y-3">{active === "terms" ? <Terms /> : <Privacy />}</div>

            <p className="mt-5 border-t border-line pt-3 text-ink-faint">
              {active === "terms" ? (
                <>
                  How your data is handled is in the{" "}
                  <Link to="/legal/privacy" className="text-accent underline underline-offset-2">
                    privacy policy
                  </Link>
                  .
                </>
              ) : (
                <>
                  The rules of the simulation itself are in the{" "}
                  <Link to="/legal/terms" className="text-accent underline underline-offset-2">
                    terms of use
                  </Link>
                  .
                </>
              )}
            </p>

            <Link to="/" className="mt-3 inline-block text-accent underline underline-offset-2">
              {session ? "Back to positions" : "Back to sign in"}
            </Link>
          </div>
        </Panel>
      </div>
    </div>
  );
}
