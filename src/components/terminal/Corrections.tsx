import { useState } from "react";
import { Panel } from "./Panel";
import { DataGrid, type Column } from "./DataGrid";
import { Value } from "./Value";
import { ActionButton, ArmedButton, Feedback, type Outcome } from "./AdminControls";
import { useAdminTrades, useAmendTrade, useVoidTrade } from "@/hooks/useAdmin";
import { ApiError, type AdminTrade } from "@/lib/api";
import { money, moneySigned, shares, stampET } from "@/lib/format";

/**
 * Correcting a bad fill.
 *
 * Neither of these actions edits a balance. Voiding removes the fill and
 * amending changes it, and in both cases the database then replays that
 * member's whole blotter from their starting cash — which is the only way the
 * average cost of what they still hold, and every realised figure booked after
 * the change, stay true. See rebuild_portfolio() in migration 0005.
 *
 * That also means a correction can be refused. Voiding the BUY that a later
 * SELL sold out of would leave the member selling shares nobody owned, so the
 * replay stops and says which fill to deal with first. Nothing is changed when
 * it does — the whole correction is one transaction.
 */
export function Corrections({ portfolios }: { portfolios: { id: string; name: string }[] }) {
  const [symbol, setSymbol] = useState("");
  const [portfolio, setPortfolio] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ qty: string; price: string }>({ qty: "", price: "" });
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const { trades, isLoading, isError } = useAdminTrades({
    symbol: symbol || undefined,
    portfolio: portfolio || undefined,
  });

  const voidTrade = useVoidTrade();
  const amendTrade = useAmendTrade();

  function report(err: unknown, fallback: string) {
    setOutcome({
      tone: "error",
      text: err instanceof ApiError ? err.message : fallback,
    });
  }

  function runVoid(trade: AdminTrade) {
    setOutcome(null);
    voidTrade.mutate(trade.id, {
      onSuccess: (result) =>
        setOutcome({
          tone: "ok",
          text: `Voided ${trade.side} ${shares(trade.qty)} ${trade.symbol}. ${
            trade.member
          } replayed to ${money(result.cash ?? 0)} cash across ${result.trades} fill${
            result.trades === 1 ? "" : "s"
          }.`,
        }),
      onError: (err) => report(err, "Could not void that fill."),
    });
  }

  function runAmend(trade: AdminTrade) {
    const qty = draft.qty.trim() === "" ? undefined : Number(draft.qty);
    const price = draft.price.trim() === "" ? undefined : Number(draft.price);

    if (qty === undefined && price === undefined) {
      setOutcome({ tone: "error", text: "Change the quantity, the price, or both." });
      return;
    }

    setOutcome(null);
    amendTrade.mutate(
      { id: trade.id, qty, price },
      {
        onSuccess: (result) => {
          setEditing(null);
          setOutcome({
            tone: "ok",
            text: `Corrected ${trade.symbol}. ${trade.member} replayed to ${money(
              result.cash ?? 0,
            )} cash and ${result.positions} position${result.positions === 1 ? "" : "s"}.`,
          });
        },
        onError: (err) => report(err, "Could not correct that fill."),
      },
    );
  }

  function startEditing(trade: AdminTrade) {
    setEditing(trade.id);
    setOutcome(null);
    // Pre-filled with what is there, so an officer changing only the price does
    // not have to retype a six-decimal quantity to keep it.
    setDraft({ qty: String(Number(trade.qty)), price: String(Number(trade.price)) });
  }

  const columns: Column<AdminTrade>[] = [
    {
      key: "executedAt",
      header: "Time",
      width: "7rem",
      sortValue: (t) => t.executedAt,
      render: (t) => <span className="num text-ink-faint">{stampET(t.executedAt)}</span>,
    },
    {
      key: "member",
      header: "Member",
      width: "11rem",
      sortValue: (t) => t.member,
      render: (t) => <span className="truncate text-ink-dim">{t.member}</span>,
    },
    {
      key: "side",
      header: "Side",
      width: "4.5rem",
      sortValue: (t) => t.side,
      render: (t) => <span className="num text-ink">{t.side}</span>,
    },
    {
      key: "symbol",
      header: "Sym",
      width: "5rem",
      sortValue: (t) => t.symbol,
      render: (t) => <span className="num text-ink">{t.symbol}</span>,
    },
    {
      key: "qty",
      header: "Qty",
      align: "right",
      width: "7rem",
      sortValue: (t) => Number(t.qty),
      render: (t) =>
        editing === t.id ? (
          <CellInput
            label={`Quantity for ${t.symbol}`}
            value={draft.qty}
            onChange={(qty) => setDraft((d) => ({ ...d, qty }))}
          />
        ) : (
          <Value value={t.qty}>{shares(t.qty)}</Value>
        ),
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      width: "7rem",
      sortValue: (t) => Number(t.price),
      render: (t) =>
        editing === t.id ? (
          <CellInput
            label={`Price for ${t.symbol}`}
            value={draft.price}
            onChange={(price) => setDraft((d) => ({ ...d, price }))}
          />
        ) : (
          <Value value={t.price}>{money(t.price)}</Value>
        ),
    },
    {
      key: "notional",
      header: "Notional",
      align: "right",
      width: "7.5rem",
      sortValue: (t) => Number(t.notional),
      render: (t) => (
        <Value value={t.notional} dim>
          {money(t.notional)}
        </Value>
      ),
    },
    {
      key: "realizedPnl",
      header: "Realized",
      align: "right",
      width: "6.5rem",
      sortValue: (t) => Number(t.realizedPnl),
      render: (t) =>
        Number(t.realizedPnl) === 0 ? (
          <span className="text-ink-faint">—</span>
        ) : (
          <Value value={t.realizedPnl} colorBySign>
            {moneySigned(t.realizedPnl)}
          </Value>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "14rem",
      render: (t) => (
        <span className="flex items-center justify-end gap-1.5">
          {editing === t.id ? (
            <>
              <ActionButton
                tone="accent"
                onClick={() => runAmend(t)}
                pending={amendTrade.isPending}
              >
                Save
              </ActionButton>
              <ActionButton onClick={() => setEditing(null)}>Cancel</ActionButton>
            </>
          ) : (
            <>
              <ActionButton onClick={() => startEditing(t)}>Correct</ActionButton>
              <ArmedButton
                label="Void"
                armedLabel="Void it"
                onConfirm={() => runVoid(t)}
                pending={voidTrade.isPending}
              />
            </>
          )}
        </span>
      ),
    },
  ];

  return (
    <Panel
      title="Corrections"
      meta={
        <span className="text-ink-dim">
          {isLoading ? "Loading" : `${trades.length} fill${trades.length === 1 ? "" : "s"}`}
        </span>
      }
      flush
    >
      {/*
        Filters and results sit under the header rather than in it. The panel's
        meta slot is styled as a label, which uppercases — right for a count,
        wrong for a member's name in a dropdown or for a sentence.
      */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-2.5 py-1">
        <select
          value={portfolio}
          onChange={(event) => setPortfolio(event.target.value)}
          aria-label="Filter by member"
          className="border border-line bg-canvas px-1.5 py-0.5 text-ink focus:border-accent focus:outline-none"
        >
          <option value="">All members</option>
          {portfolios.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <input
          value={symbol}
          onChange={(event) =>
            setSymbol(event.target.value.toUpperCase().replace(/[^A-Z.-]/g, ""))
          }
          placeholder="TICKER"
          aria-label="Filter by ticker"
          className="num w-24 border border-line bg-canvas px-1.5 py-0.5 uppercase text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />

        <Feedback outcome={outcome} />
      </div>

      {isError ? (
        <div className="flex h-24 items-center justify-center text-loss">
          Could not load the club's fills.
        </div>
      ) : isLoading ? (
        <div className="flex h-24 items-center justify-center">
          <span className="label pulse-dot">Loading fills</span>
        </div>
      ) : (
        <DataGrid
          columns={columns}
          rows={trades}
          rowKey={(t) => t.id}
          defaultSort="executedAt"
          empty={
            symbol || portfolio
              ? "No fills match that filter."
              : "Nobody has traded in this season yet."
          }
        />
      )}
    </Panel>
  );
}

/** An input sized to sit inside a grid cell without changing the row height. */
function CellInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      value={value}
      aria-label={label}
      onChange={(event) => onChange(event.target.value.replace(/[^0-9.]/g, ""))}
      inputMode="decimal"
      autoComplete="off"
      className="num w-full border border-accent-dim bg-canvas px-1 py-0.5 text-right text-ink focus:border-accent focus:outline-none"
    />
  );
}
