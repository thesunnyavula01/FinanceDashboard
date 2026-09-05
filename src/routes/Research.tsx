import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { DataGrid, type Column } from "@/components/terminal/DataGrid";
import { Panel } from "@/components/terminal/Panel";
import { SymbolSearch } from "@/components/terminal/SymbolSearch";
import { Value } from "@/components/terminal/Value";
import { useQuotes, useSecurities } from "@/hooks/useQuotes";
import { useResearch } from "@/hooks/useResearch";
import type {
  DiscussionPost, EarningsQuarter, Filing, NewsItem, NewsTier, ResearchSource, SymbolMatch,
} from "@/lib/api";
import { money, moneySigned, percent, shares, stampET } from "@/lib/format";
import { classify, formatContract, isTradableSymbol, normalise, underlyingOf } from "@/lib/symbols";

const MODES = ["EQUITY", "CRYPTO"] as const;
type ResearchMode = (typeof MODES)[number];
const TIERS = ["ALL", "WIRE", "WEB"] as const;
const REPORT_TABS = [{ id: "earnings", label: "Earnings" }, { id: "filings", label: "Filings" }];
const SOURCE_NAMES: Record<ResearchSource, string> = {
  alpaca: "Alpaca", finnhub: "Finnhub", gdelt: "GDELT", edgar: "SEC", hackernews: "Hacker News",
};
const names = (sources: ResearchSource[]) => sources.map((source) => SOURCE_NAMES[source]).join(" · ");

function age(value: string): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (24 * 60))}d`;
}

function Age({ at }: { at: string }) {
  return <time dateTime={at} title={`${stampET(at)} ET`} className="num whitespace-nowrap text-ink-faint">{age(at)}</time>;
}

function ExternalLink({ url, children, title }: { url: string; children: ReactNode; title?: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" title={title} className="research-link text-ink hover:text-accent">
      {children}
    </a>
  );
}

/** A new F1 link remounts the form, just as a new order prefill remounts F2. */
export function Research() {
  const location = useLocation();
  const symbol = new URLSearchParams(location.search).get("symbol") ?? "";
  return <ResearchScreen key={location.key} initialSymbol={symbol} />;
}

/**
 * F4 asks about the asset. Every container, numeric and mode control is the
 * existing terminal's; the distinction this screen adds is wire versus web,
 * because a ticker match and a company-name search are different claims.
 */
function ResearchScreen({ initialSymbol }: { initialSymbol: string }) {
  const initial = normalise(initialSymbol);
  const [draft, setDraft] = useState(initial);
  const [symbol, setSymbol] = useState(isTradableSymbol(initial) ? initial : "");
  const [mode, setMode] = useState<ResearchMode>(classify(initial) === "CRYPTO" ? "CRYPTO" : "EQUITY");
  const [tier, setTier] = useState<"ALL" | NewsTier>("ALL");
  const [report, setReport] = useState("earnings");
  const [inputError, setInputError] = useState<string | null>(null);
  const underlying = underlyingOf(symbol);
  const researched = underlying ?? symbol;
  const activeSymbols = researched ? [researched] : [];
  const { quotes, isLoading: quoteLoading, isError: quoteError } = useQuotes(activeSymbols);
  const { securities } = useSecurities(activeSymbols);
  const { research, isLoading, isFetching, isError, error, refetch } = useResearch(symbol);
  const quote = quotes[researched];
  const security = securities[researched];
  const company = security?.name ?? research?.name ?? researched;
  const sources = research?.sources ?? [];
  const missing = research?.missing ?? [];
  // Finnhub's equity feed is ticker matched; its crypto category is keyword
  // filtered. An empty WEB view must not blame an unavailable wire provider.
  const headlineProviders: ResearchSource[] = tier === "ALL"
    ? ["alpaca", "finnhub", "gdelt"]
    : tier === "WIRE"
      ? mode === "CRYPTO" ? ["alpaca"] : ["alpaca", "finnhub"]
      : mode === "CRYPTO" ? ["finnhub", "gdelt"] : ["gdelt"];
  const headlineMissing = (research?.sectionMissing.headlines ?? [])
    .filter((source) => headlineProviders.includes(source));
  const reportMissing = research?.sectionMissing[report === "filings" ? "filings" : "earnings"] ?? [];
  const discussionMissing = research?.sectionMissing.discussion ?? [];
  const sourceText = sources.length > 0 ? names(sources) : "";
  const sourceStatus = [sourceText && `Sources: ${sourceText}`, missing.length > 0 && `Unavailable: ${names(missing)}`]
    .filter(Boolean).join(" · ");

  // The server orders the merge too. Keep free coverage first on equal dates
  // even when the member switches tiers; paywalled stories remain readable.
  const headlines = useMemo(() => (research?.headlines ?? [])
    .filter((item) => tier === "ALL" || item.tier === tier)
    .toSorted((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || Number(a.paywalled) - Number(b.paywalled)),
  [research, tier]);

  function commit(match?: SymbolMatch | null) {
    const next = normalise(match?.symbol ?? draft);
    if (!isTradableSymbol(next)) {
      setInputError("Enter a US ticker, a crypto pair such as BTC/USD, or an option symbol.");
      return;
    }
    setDraft(next);
    setSymbol(next);
    setMode(classify(next) === "CRYPTO" ? "CRYPTO" : "EQUITY");
    setInputError(null);
    setTier("ALL");
  }

  function switchMode(next: ResearchMode) {
    if (mode === next) return;
    setMode(next);
    setDraft("");
    setSymbol("");
    setInputError(null);
  }

  function onModeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = mode === "EQUITY" ? "CRYPTO" : "EQUITY";
    switchMode(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus();
  }

  function empty(label: string, unavailable: ResearchSource[]): ReactNode {
    if (!symbol) return "Enter a symbol to load research.";
    if (isLoading) return <span className="label pulse-dot">Loading {label}</span>;
    if (isError && !research) return "Research unavailable. Retry above.";
    if (unavailable.length > 0) return `No ${label} returned. ${names(unavailable)} unavailable.`;
    return `No ${label} returned for ${researched}.`;
  }

  const headlineColumns: Column<NewsItem>[] = [
    { key: "age", header: "Age", width: "3.5rem", hideOnMobile: true, sortValue: (item) => Date.parse(item.publishedAt), render: (item) => <Age at={item.publishedAt} /> },
    { key: "source", header: "Source", width: "8rem", hideOnMobile: true, sortValue: (item) => item.source,
      render: (item) => <span className="text-ink-dim">{item.source}</span> },
    { key: "headline", header: "Headline", render: (item) => (
      <div className="py-1 [overflow-wrap:anywhere]">
        <ExternalLink url={item.url} title={item.summary ?? undefined}>{item.headline}</ExternalLink>
        {item.paywalled && <span className="label ml-1.5 text-ink-faint" title="This publisher may require a subscription">Paywall</span>}
        {/* Keep provenance and recency beside the story when their columns go. */}
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-ink-dim md:hidden">
          <span>{item.source}</span>
          <Age at={item.publishedAt} />
          <span className="label text-ink-faint">{item.tier}</span>
        </div>
      </div>
    ) },
    { key: "tier", header: "Tier", width: "4rem", hideOnMobile: true,
      render: (item) => <span className="label text-ink-faint" title={item.tier === "WIRE" ? "Ticker coverage from financial wire sources" : "Keyword coverage matched by company name"}>{item.tier}</span> },
  ];

  const earningsColumns: Column<EarningsQuarter>[] = [
    { key: "quarter", header: "Quarter", render: (item) => <span className="num whitespace-nowrap">{item.quarter && item.year ? `Q${item.quarter} ${item.year}` : item.period}</span> },
    { key: "estimate", header: "Est EPS", align: "right", render: (item) => <Value dim>{item.estimate === null ? "—" : money(item.estimate)}</Value> },
    { key: "actual", header: "Act EPS", align: "right", render: (item) => <Value>{item.actual === null ? "—" : money(item.actual)}</Value> },
    { key: "surprise", header: "Surprise", align: "right", hideOnMobile: true,
      render: (item) => <Value>{item.surprisePercent === null ? "—" : percent(item.surprisePercent)}</Value> },
  ];

  const filingColumns: Column<Filing>[] = [
    { key: "form", header: "Form", width: "4rem", render: (item) => <span className="num whitespace-nowrap">{item.form}</span> },
    { key: "date", header: "Filed", width: "6rem", hideOnMobile: true, render: (item) => <time dateTime={item.filedAt} className="num whitespace-nowrap text-ink-dim">{item.filedAt.slice(0, 10)}</time> },
    { key: "filing", header: "Document", render: (item) => (
      <div className="py-1 [overflow-wrap:anywhere] md:py-0">
        <ExternalLink url={item.url}>{item.title}</ExternalLink>
        <time dateTime={item.filedAt} className="num block text-ink-dim md:hidden">{item.filedAt.slice(0, 10)}</time>
      </div>
    ) },
  ];

  const discussionColumns: Column<DiscussionPost>[] = [
    { key: "score", header: "Score", width: "4rem", align: "right", sortValue: (item) => item.score ?? -1,
      render: (item) => <Value>{item.score === null ? "—" : shares(item.score)}</Value> },
    { key: "age", header: "Age", width: "3.5rem", hideOnMobile: true, sortValue: (item) => Date.parse(item.publishedAt), render: (item) => <Age at={item.publishedAt} /> },
    { key: "title", header: "Title", render: (item) => (
      <div className="py-1 [overflow-wrap:anywhere]">
        <ExternalLink url={item.url}>{item.title}</ExternalLink>
        {/* Comments lose their column on a phone, but the discussion must
            remain reachable when the title leads to the original article. */}
        <div className="flex flex-wrap items-center gap-x-3 md:hidden">
          <Age at={item.publishedAt} />
          <ExternalLink url={item.commentsUrl} title={`Read the discussion of ${item.title}`}>
            <span className="label text-ink-dim">Discuss{item.comments === null ? "" : ` · ${shares(item.comments)}`}</span>
          </ExternalLink>
        </div>
      </div>
    ) },
    { key: "comments", header: "Comments", width: "4.5rem", align: "right", hideOnMobile: true,
      render: (item) => <ExternalLink url={item.commentsUrl} title={`Read the discussion of ${item.title}`}><span className="num">{item.comments === null ? "—" : shares(item.comments)}</span></ExternalLink> },
  ];

  const secEarnings = research?.earnings.some((item) => item.source === "edgar");
  return (
    <div className="research-screen flex min-h-full min-w-0 flex-col xl:h-full">
      <div className="shrink-0 border-b border-line px-2.5 py-2">
        <form className="max-w-lg" onSubmit={(event) => { event.preventDefault(); commit(); }}>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <h1 className="label">Research</h1>
            <div role="radiogroup" aria-label="Instrument" onKeyDown={onModeKeyDown} className="flex items-baseline gap-2">
              {MODES.map((candidate) => {
                const selected = candidate === mode;
                return (
                  <button key={candidate} type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1}
                    data-mode={candidate} onClick={() => switchMode(candidate)}
                    className={`research-control label cursor-pointer border-b pb-0.5 transition-colors ${selected ? "border-accent text-accent" : "border-transparent text-ink-faint hover:text-ink-dim"} disabled:cursor-not-allowed`}>
                    {candidate}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="research-symbol" className="label sr-only sm:not-sr-only">Symbol</label>
            <div className="min-w-0 flex-1">
              <SymbolSearch id="research-symbol" value={draft === symbol ? formatContract(draft) : draft}
                onChange={(next) => { setDraft(next); setInputError(null); }} onCommit={commit}
                placeholder={mode === "CRYPTO" ? "BTC/USD" : "TSLA"} assetClass={mode} showTradingConstraints={false} />
            </div>
            <button type="submit" className="research-control keycap" aria-label="Load research">GO</button>
          </div>
        </form>
        {inputError && <p role="alert" className="mt-1 text-loss">{inputError}</p>}
        {underlying && <p className="mt-1 text-ink-dim">{formatContract(symbol)} · Researching underlying {underlying}</p>}
        {sourceStatus && <p className="mt-1 text-ink-faint" title={sourceStatus}>{sourceStatus}</p>}
        {isError && <p role="status" className="mt-1 text-ink-dim">
          {research ? `Refresh unavailable. Showing research from ${stampET(research.asOf)} ET.` : error instanceof Error ? error.message : "Research unavailable."}
          <button type="button" onClick={() => void refetch()} disabled={isFetching} className="research-control keycap ml-2">Retry</button>
        </p>}
      </div>

      {/* Auto-sized stacked panels below xl; at xl only the list bodies scroll.
          The crypto card takes one short row, leaving more height for news. */}
      <div className="grid grid-cols-1 flex-1 gap-2.5 p-2.5 xl:min-h-0 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,28rem)] xl:grid-rows-[auto_minmax(14rem,1fr)]">
        <Panel title={company || "Asset"} meta={security?.sector ?? (symbol ? mode : undefined)} className={mode === "CRYPTO" ? "xl:col-span-2" : ""}>
          {symbol ? <>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="num text-lede">{researched}</span>
              <div><span className="label mr-2">{quote?.source === "bar" || quote?.source === "prev-bar" ? "Close USD" : "Last USD"}</span>
                <Value value={quote?.price} flash className="text-lede">{quote ? money(quote.price) : "—"}</Value></div>
              <Value value={quote?.dayChange} colorBySign>{quote?.dayChange == null ? "—" : moneySigned(quote.dayChange)}</Value>
              <Value value={quote?.dayChangePercent} colorBySign>{quote?.dayChangePercent == null ? "—" : percent(quote.dayChangePercent)}</Value>
            </div>
            {security?.industry && <p className="mt-1 text-ink-dim">{security.industry}</p>}
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-4">
              <div><dt className="label">Previous close</dt><dd className="num mt-0.5">{quote?.prevClose == null ? "—" : money(quote.prevClose)}</dd></div>
              <div><dt className="label">Day low</dt><dd className="num mt-0.5">{quote?.dayLow == null ? "—" : money(quote.dayLow)}</dd></div>
              <div><dt className="label">Day high</dt><dd className="num mt-0.5">{quote?.dayHigh == null ? "—" : money(quote.dayHigh)}</dd></div>
              <div><dt className="label">Volume</dt><dd className="num mt-0.5">{quote?.dayVolume == null ? "—" : shares(quote.dayVolume)}</dd></div>
            </dl>
            {(quoteError || (!quoteLoading && !quote)) && <p className="mt-2 text-ink-faint">Price unavailable.</p>}
          </> : <p className="py-5 text-ink-faint">Enter a symbol to see its price, coverage and company reports.</p>}
        </Panel>

        {mode !== "CRYPTO" && <Panel title="Company reports" tabs={REPORT_TABS} activeTab={report} onTabChange={setReport}
          meta={<span title={reportMissing.length ? `Unavailable: ${names(reportMissing)}` : undefined}>
            {report === "filings" ? "SEC EDGAR" : secEarnings ? "SEC XBRL · actual EPS only" : "Finnhub · EPS"}
            {reportMissing.length > 0 && ` · Missing ${names(reportMissing)}`}
          </span>} className="max-h-60" flush>
          {report === "earnings" ? <>
            {secEarnings && <p className="border-b border-line px-2 py-1 text-ink-faint">SEC reported diluted EPS. Analyst estimates are unavailable.</p>}
            <DataGrid columns={earningsColumns} rows={research?.earnings ?? []}
              rowKey={(item) => `${item.period}:${item.source}`} empty={empty("earnings", reportMissing)} />
          </>
            : <DataGrid columns={filingColumns} rows={research?.filings ?? []} rowKey={(item) => item.url} empty={empty("filings", reportMissing)} />}
        </Panel>}

        <Panel title="Headlines" meta={<span className="flex items-center gap-3">
          <span className="flex items-center gap-2" role="group" aria-label="Headline coverage">
            {TIERS.map((candidate) => <button key={candidate} type="button" aria-pressed={tier === candidate}
              onClick={() => setTier(candidate)} title={candidate === "WEB" ? "Keyword coverage matched by company name" : candidate === "WIRE" ? "Ticker coverage from financial wire sources" : "All coverage"}
              className={`label cursor-pointer border-b pb-0.5 ${tier === candidate ? "border-accent text-accent" : "border-transparent text-ink-faint hover:text-ink-dim"}`}>{candidate}</button>)}
          </span>
          <span className="num text-ink-dim">{headlines.length}</span>
          <span className="hidden lg:inline" title={sourceStatus}>{headlineMissing.length ? `Missing ${names(headlineMissing)}` : names(sources.filter((source) => headlineProviders.includes(source)))}</span>
        </span>} className="min-h-48 xl:min-h-0" flush>
          <DataGrid columns={headlineColumns} rows={headlines} rowKey={(item) => item.url} empty={empty(tier === "ALL" ? "headlines" : `${tier.toLowerCase()} headlines`, headlineMissing)} />
        </Panel>

        <Panel title="Discussion" meta={discussionMissing.length ? `Missing ${names(discussionMissing)}` : "Hacker News · keyword"} className="min-h-48 xl:min-h-0" flush>
          <DataGrid columns={discussionColumns} rows={research?.discussion ?? []} rowKey={(item) => item.id} empty={empty("discussion", discussionMissing)} />
        </Panel>
      </div>
    </div>
  );
}
