"use client";

import { Fragment, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { PendingApproval } from "@/lib/approvals/client";
import {
  FULL_VIEW_KEYS,
  displayScalar,
  inStoredOrder,
  isAddressShaped,
  modelText,
  quoted,
  readNode,
  secretText,
  splitTruncation,
  type SummaryNode,
  type SummaryNote,
  WHOLE_MAX,
} from "@/lib/approvals/display";

/** Texts longer than this show a preview first, with the full text on demand. */
const PREVIEW_LEN = 200;

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
 * a real record reference and for a string of those words alike (fifteenth
 * review of #1242). So the card says it in words, as the prompt does: a string
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
 * A string value as the summary stored it: whitespace kept (`pre-wrap`), a
 * string that would read as a literal shown quoted (`displayScalar`), and a
 * long text previewed — unless `full`, for the fields that say who an action
 * reaches or where it lands, which are short and are the decision, or unless
 * the value itself is an email address or a URL, at any key: its host is the
 * decision too, and it sits at the END of an address, exactly where a preview
 * cuts (fourth review of #1242). Those are drawn whole up to WHOLE_MAX; past
 * it, the summary names the host in a note beside the preview.
 *
 * The truncation marker the summary appends to a value it cut is shown
 * OUTSIDE the preview: inside it, it sat in exactly the part the preview
 * collapses (second review of #1242).
 */
function TextValue({ text, full }: { text: string; full: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const split = splitTruncation(text);
  const shown = displayScalar(split.text);
  const marker = split.marker ? (
    <span className="text-muted-foreground"> {split.marker}</span>
  ) : null;
  // Counted and cut by code point, so the preview never ends in half an emoji.
  const chars = [...shown];
  const decision = full || isAddressShaped(split.text);
  if (chars.length <= PREVIEW_LEN || (decision && chars.length <= WHOLE_MAX)) {
    return (
      <span className="break-words">
        <Spoken
          drawn={
            <span className="whitespace-pre-wrap">
              <StoredOrder text={shown} />
            </span>
          }
          spoken={quoted(split.text)}
        />
        {marker}
      </span>
    );
  }
  return (
    <span className="break-words">
      <Spoken
        drawn={
          <span className="whitespace-pre-wrap">
            <StoredOrder text={expanded ? shown : `${chars.slice(0, PREVIEW_LEN).join("")}…`} />
          </span>
        }
        spoken={
          expanded
            ? quoted(split.text)
            : `${quoted([...split.text].slice(0, PREVIEW_LEN).join(""))}…`
        }
      />
      {!expanded && (
        <span className="text-muted-foreground">
          {" "}
          ({chars.length - PREVIEW_LEN} more characters hidden)
        </span>
      )}
      {marker}{" "}
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0 align-baseline text-xs"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        {expanded ? "Show less" : "Show full text"}
      </Button>
    </span>
  );
}

/**
 * What Pinchy says about a value, as an element of its own beside it: never
 * part of the value's text run, never inside its preview. Written into the
 * text, `boss@fіrma.at (xn--frma-l9d.at)` read exactly like a value typed with
 * those characters, and past the preview bound the note sat behind "Show full
 * text" (fourteenth review of #1242). A value's text can't draw this element.
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
              `x" — res.partner #12 "Acme` can't close it early (fifteenth
              review of #1242). */}
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
    if (value.length === 0) return <span className="text-muted-foreground">(none)</span>;
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
  if (entries.length === 0) return <span className="text-muted-foreground">(none)</span>;
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
