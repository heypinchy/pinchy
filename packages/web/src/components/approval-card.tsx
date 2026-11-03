"use client";

import { Fragment, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { PendingApproval } from "@/lib/approvals/client";
import {
  FULL_VIEW_KEYS,
  displayScalar,
  drawnText,
  inStoredOrder,
  modelText,
  previewEndsInside,
  previewOf,
  previewed,
  quoted,
  readNode,
  secretText,
  textWindow,
  type SummaryNode,
  type SummaryNote,
  type TextWindow,
} from "@/lib/approvals/display";

/**
 * `text` drawn in the order it was sent (`inStoredOrder`): each line held in
 * order by `<bdo dir="ltr">`, each right-to-left word in a `<bdi dir="ltr">`
 * of its own, so it still reads. Text with no right-to-left character is
 * drawn as it is.
 */
function StoredOrder({ text }: { text: string }) {
  const lines = inStoredOrder(text);
  if (!lines) return text;
  return lines.map((pieces, line) => (
    <Fragment key={line}>
      {line > 0 && "\n"}
      <bdo dir="ltr">
        {pieces.map((piece, index) =>
          piece.word ? (
            <bdi key={index} dir="ltr">
              {piece.text}
            </bdi>
          ) : (
            <Fragment key={index}>{piece.text}</Fragment>
          )
        )}
      </bdo>
    </Fragment>
  ));
}

/**
 * What is drawn, hidden from assistive technology, and what is read in its
 * place. The dashed label that sets an annotation apart from a value, and the
 * element boundary that sets one value apart from the next, are seen, not
 * read: a screen reader got `record reference res.partner #7 "Acme GmbH"` for
 * a real record reference and for a string of those words alike. So the card says it in words, as the prompt does: a string
 * is read `quoted()`, its own `"` escaped, and an annotation as a note that
 * says it is Pinchy's. The read copy can't be selected, so a copied value is
 * still the drawn one, and it is held left to right in one override: left to
 * the bidi algorithm, 8,192 alternating Hebrew letters and digits took
 * Chromium another 60 ms to lay out, unseen. The order a screen reader reads
 * in is the stored one either way.
 */
function Spoken({ drawn, spoken }: { drawn: ReactNode; spoken: string }) {
  return (
    <>
      <span aria-hidden="true">{drawn}</span>
      <bdo dir="ltr" className="sr-only select-none">
        {spoken}
      </bdo>
    </>
  );
}

/**
 * What the card says where a part is cut inside one character (`textWindow`):
 * its two pieces draw differently than the whole character, so the approver
 * is told they are pieces.
 */
function splitNote({ startsInside, endsInside }: TextWindow): string {
  const notes = [
    startsInside && "the first character shown may begin in the previous part",
    endsInside && "the last character shown may go on in the next part",
  ].filter(Boolean);
  return notes.length > 0 ? `; ${notes.join(", and ")}` : "";
}

/**
 * A string value as the summary stored it: whitespace kept (`pre-wrap`), a
 * string that would read as a literal shown quoted (`displayScalar`), and a
 * long text previewed — unless `full`, for the fields that say who an action
 * reaches or where it lands, which are short and are the decision, or unless
 * the value itself is an email address or a URL, at any key: its host is the
 * decision too, and it sits at the END of an address, exactly where a preview
 * cuts. Those are drawn whole up to WHOLE_MAX. Whether a value is previewed is
 * `previewed`'s answer, the one the summary asks too: wherever it says yes to
 * a URL or an address, the summary has named its host in a note beside it.
 *
 * "Show full text" reveals the rest one part at a time (`textWindow`), each
 * costing no more to draw than a target drawn whole, and only one part is on
 * the card at once: drawn whole, a 200,000-character value froze the tab for
 * as long as 28 s, and again on every relayout. Every character is a few
 * clicks away, and the card says which of them are shown.
 *
 * Everything in `text` is the value's own: the card reads no marker out of it.
 * The gate refuses any call the summary would have to cut, so a value that
 * ends in "… [truncated: …]" typed it, and it is drawn and read as the rest of
 * the value is — inside it, inside its quotes.
 */
function TextValue({ text, full }: { text: string; full: boolean }) {
  // Where each part shown since "Show full text" starts, the one on screen
  // last; `null` while the value is collapsed to its preview.
  const [starts, setStarts] = useState<number[] | null>(null);
  const shown = displayScalar(text);
  if (!previewed(text, full)) {
    return (
      <span className="break-words">
        <Spoken
          drawn={
            <span className="whitespace-pre-wrap">
              <StoredOrder text={shown} />
            </span>
          }
          spoken={quoted(text)}
        />
      </span>
    );
  }
  const toggle = (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto p-0 align-baseline text-xs"
      aria-expanded={starts !== null}
      onClick={() => setStarts(starts ? null : [0])}
    >
      {starts ? "Show less" : "Show full text"}
    </Button>
  );
  if (!starts) {
    // Cut between two characters as a person reads them (`previewOf`), so the
    // preview never ends in half a flag or a letter without its accent — and
    // where it cannot be, the card says so, as it does for a part.
    const preview = drawnText(text, full);
    return (
      <span className="break-words">
        <Spoken
          drawn={
            <span className="whitespace-pre-wrap">
              <StoredOrder text={`${preview}…`} />
            </span>
          }
          spoken={`${quoted(previewOf(text))}…`}
        />
        <span className="text-muted-foreground">
          {" "}
          ({[...shown].length - [...preview].length} more characters hidden
          {previewEndsInside(shown) && "; the last character shown may go on past the preview"})
        </span>{" "}
        {toggle}
      </span>
    );
  }
  const part = textWindow(text, starts[starts.length - 1]);
  const before = part.start > 0 ? "…" : "";
  const after = part.end < text.length ? "…" : "";
  const whole = !before && !after;
  const step = (label: string, disabled: boolean, onClick: () => void) => (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto p-0 align-baseline text-xs"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  return (
    <span className="break-words">
      <Spoken
        drawn={
          <span className="whitespace-pre-wrap">
            <StoredOrder text={`${before}${part.drawn}${after}`} />
          </span>
        }
        spoken={`${before}${quoted(text.slice(part.start, part.end))}${after}`}
      />
      {!whole && (
        <>
          <span className="text-muted-foreground">
            {" "}
            (characters {part.first.toLocaleString("en-US")}–{part.last.toLocaleString("en-US")} of{" "}
            {part.total.toLocaleString("en-US")}
            {splitNote(part)})
          </span>{" "}
          {step("Show previous part", !before, () => setStarts(starts.slice(0, -1)))}{" "}
          {step("Show next part", !after, () => setStarts([...starts, part.end]))}
        </>
      )}{" "}
      {toggle}
    </span>
  );
}

/**
 * What Pinchy says about a value, as an element of its own beside it: never
 * part of the value's text run, never inside its preview. Written into the
 * text, `boss@fіrma.at (xn--frma-l9d.at)` read exactly like a value typed with
 * those characters, and past the preview bound the note sat behind "Show full
 * text". A value's text can't draw this element.
 * Nor can it be read as one: it is a `note`, read as Pinchy's, while a value
 * is read in quotes (`Spoken`).
 */
function Annotation({ kind, children }: { kind: string; children: ReactNode }) {
  return (
    <span role="note">
      <span className="sr-only select-none"> Pinchy note: </span>
      <span
        data-annotation={kind}
        className="ml-1 inline-block rounded border border-dashed px-1 font-sans text-xs text-muted-foreground"
      >
        {children}
      </span>
    </span>
  );
}

function Note({ note, full }: { note: SummaryNote; full: boolean }) {
  switch (note.kind) {
    case "host":
      return (
        <Annotation kind="host">
          host <span className="font-mono">{note.host}</span>
        </Annotation>
      );
    case "name":
      return (
        <Annotation kind="name">
          name <TextValue text={note.name} full={full} />
        </Annotation>
      );
    case "not-a-url":
      return <Annotation kind="not-a-url">not a valid URL</Annotation>;
    case "not-a-domain":
      return <Annotation kind="not-a-domain">not a valid domain name</Annotation>;
  }
}

/** A value the summary annotated (`SummaryNode`). */
function NodeValue({ node, full }: { node: SummaryNode; full: boolean }) {
  switch (node["@"]) {
    case "ref":
      return (
        <Annotation kind="ref">
          {/* The label is Odoo's display name, which anyone who can name a
              partner writes: quoted and escaped, like the prompt's, so
              `x" — res.partner #12 "Acme` can't close it early. */}
          record reference <span className="font-mono">{modelText(node.model)}</span> #{node.id}{" "}
          <StoredOrder text={quoted(node.label)} />
          {node.labelCut > 0 && ` … (label cut: ${node.labelCut} more characters not shown)`}
        </Annotation>
      );
    case "secret":
      return <Annotation kind="secret">{secretText(node)}</Annotation>;
    case "noted":
      return (
        <span>
          <TextValue text={node.text} full={full} />
          {node.notes.map((note, index) => (
            <Note key={index} note={note} full={full} />
          ))}
        </span>
      );
  }
}

/**
 * An empty list or object, drawn as the prompt prints it — `[]`, `{}` — and
 * read in words. Both used to be "(none)", so `values: []` and `values: {}`
 * were one card; and a string can't draw either, since `"[]"` reads as a
 * literal and is drawn quoted (`displayScalar`).
 */
function Empty({ list }: { list: boolean }) {
  return (
    <Spoken
      drawn={<span className="font-mono text-muted-foreground">{list ? "[]" : "{}"}</span>}
      spoken={list ? "empty list" : "empty object"}
    />
  );
}

/**
 * Renders the tool's arguments as the stored summary holds them: every value,
 * arrays one entry per line, objects as labelled fields. Nothing is collapsed
 * to a count — the person approving has to see what will run. Non-string
 * values print as their literal (`false`, `1`, `null`), so a string "false"
 * (shown `"false"`) cannot pass for the boolean.
 */
function ArgValue({ value, full }: { value: unknown; full: boolean }) {
  if (typeof value === "string") return <TextValue text={value} full={full} />;
  const node = readNode(value);
  if (node === "unreadable") {
    return (
      <Annotation kind="unreadable">
        a value this version of Pinchy cannot show — deny, then ask the agent again
      </Annotation>
    );
  }
  if (node) return <NodeValue node={node} full={full} />;
  if (Array.isArray(value)) {
    if (value.length === 0) return <Empty list />;
    return (
      <ul className="list-disc space-y-0.5 pl-4">
        {value.map((item, index) => (
          <li key={index}>
            <ArgValue value={item} full={full} />
          </li>
        ))}
      </ul>
    );
  }
  if (value !== null && typeof value === "object") {
    return <ArgFields fields={value as Record<string, unknown>} full={full} />;
  }
  return <span className="font-mono">{displayScalar(value)}</span>;
}

/**
 * Who a call reaches and where it lands come first. The summary renders them
 * first too, but Postgres stores a jsonb object with its keys re-sorted, so
 * that order does not survive the round trip — it is restored here.
 */
function ArgFields({ fields, full }: { fields: Record<string, unknown>; full: boolean }) {
  const entries = Object.entries(fields).sort(
    ([a], [b]) => Number(FULL_VIEW_KEYS.has(b)) - Number(FULL_VIEW_KEYS.has(a))
  );
  if (entries.length === 0) return <Empty list={false} />;
  return (
    <dl className="space-y-1">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt className="font-mono text-xs text-muted-foreground">{key}</dt>
          <dd className="ml-3">
            <ArgValue value={value} full={full || FULL_VIEW_KEYS.has(key)} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** One pending confirmation, rendered the same whether it sits in the thread
 * that raised it or in the corner (#1132). Only the container differs. */
export function ApprovalCard({
  approval,
  busy,
  onDecide,
}: {
  approval: PendingApproval;
  busy: boolean;
  onDecide: (approval: PendingApproval, decision: "approve" | "deny") => void;
}) {
  const hasArgs = approval.argsSummary && Object.keys(approval.argsSummary).length > 0;
  return (
    <div className="rounded-lg border bg-background p-3 shadow-lg">
      <p className="text-sm font-medium">{approval.agentName} needs your confirmation</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Run <span className="font-mono">{approval.toolName}</span>
        {hasArgs ? " with:" : "?"}
      </p>
      {hasArgs ? (
        <div className="mt-2 max-h-64 overflow-y-auto rounded-md bg-muted/50 p-2 text-sm">
          <ArgFields fields={approval.argsSummary as Record<string, unknown>} full={false} />
        </div>
      ) : null}
      <div className="mt-3 flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onDecide(approval, "deny")}
        >
          Deny
        </Button>
        <Button size="sm" disabled={busy} onClick={() => onDecide(approval, "approve")}>
          Approve
        </Button>
      </div>
    </div>
  );
}
