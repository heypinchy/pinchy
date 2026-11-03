"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "@/components/ui/button";
import type { PendingApproval } from "@/lib/approvals/client";
import {
  FULL_VIEW_KEYS,
  displayScalar,
  inStoredOrder,
  modelText,
  partOf,
  previewOf,
  quoted,
  readNode,
  readShown,
  secretText,
  type Previewed,
  type Shown,
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
 * read: without words for them, a screen reader would read `record reference
 * res.partner #7 "Acme GmbH"` for a real record reference and for a string of
 * those words alike. So the card says it in words, as the prompt does: a
 * string is read `quoted()`, its own `"` escaped, and an annotation as a note
 * that says it is Pinchy's. The read copy can't be selected, so a copied value
 * is still the drawn one, and it is held left to right in one override: left
 * to the bidi algorithm, 8,192 alternating Hebrew letters and digits take
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
 * What the card says where a part is cut inside one character (`Previewed.inside`):
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
 * A string value as the summary stored it (`Shown`): whitespace kept
 * (`pre-wrap`), a string that would read as a literal shown quoted
 * (`displayScalar`). A plain string is drawn whole; a `Previewed` one as its
 * preview, with "Show full text" revealing the rest one part at a time, and
 * only one part on the card at once — every cut where the summary made it and
 * charged for it. The card decides none of them: asked again here, in the
 * approver's browser, each difference between its URL parser or segmenter and
 * the server's would be a value drawn larger than the summary charged.
 *
 * What is read to assistive technology is the same stretch of the value as
 * what is drawn, quoted (`Spoken`).
 *
 * Everything in the text is the value's own: the card reads no marker out of
 * it. The gate refuses any call the summary would have to cut, so a value
 * that ends in "… [truncated: …]" typed it, and it is drawn and read as the
 * rest of the value is — inside it, inside its quotes.
 */
function TextValue({ shown }: { shown: Shown }) {
  if (typeof shown === "string") {
    return (
      <span className="break-words">
        <Spoken
          drawn={
            <span className="whitespace-pre-wrap">
              <StoredOrder text={displayScalar(shown)} />
            </span>
          }
          spoken={quoted(shown)}
        />
      </span>
    );
  }
  return <PreviewedValue node={shown} />;
}

function PreviewedValue({ node }: { node: Previewed }) {
  // The part on screen since "Show full text"; `null` while the value is
  // collapsed to its preview.
  const [index, setIndex] = useState<number | null>(null);
  const toggle = (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto p-0 align-baseline text-xs"
      aria-expanded={index !== null}
      onClick={() => setIndex(index === null ? 0 : null)}
    >
      {index === null ? "Show full text" : "Show less"}
    </Button>
  );
  if (index === null) {
    const preview = previewOf(node);
    return (
      <span className="break-words">
        <Spoken
          drawn={
            <span className="whitespace-pre-wrap">
              <StoredOrder text={`${preview.drawn}…`} />
            </span>
          }
          spoken={`${quoted(node.text.slice(0, node.preview))}…`}
        />
        <span className="text-muted-foreground">
          {" "}
          ({preview.hidden} more characters hidden
          {preview.endsInside && "; the last character shown may go on past the preview"})
        </span>{" "}
        {toggle}
      </span>
    );
  }
  const part = partOf(node, index);
  const before = index > 0 ? "…" : "";
  const after = index < node.parts.length - 1 ? "…" : "";
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
        spoken={`${before}${quoted(node.text.slice(part.start, part.end))}${after}`}
      />
      {node.parts.length > 1 && (
        <>
          <span className="text-muted-foreground">
            {" "}
            (characters {part.first.toLocaleString("en-US")}–{part.last.toLocaleString("en-US")} of{" "}
            {part.total.toLocaleString("en-US")}
            {splitNote(part)})
          </span>{" "}
          {step("Show previous part", !before, () => setIndex(index - 1))}{" "}
          {step("Show next part", !after, () => setIndex(index + 1))}
        </>
      )}{" "}
      {toggle}
    </span>
  );
}

/**
 * What Pinchy says about a value, as an element of its own beside it: never
 * part of the value's text run, never inside its preview. Written into the
 * text, `boss@fіrma.at (xn--frma-l9d.at)` would read exactly like a value
 * typed with those characters, and past the preview bound the note would sit
 * behind "Show full text". A value's text can't draw this element. Nor can it
 * be read as one: it is a `note`, read as Pinchy's, while a value is read in
 * quotes (`Spoken`).
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

/** What the card says where it cannot read a value: it is not guessed at. */
function Unreadable() {
  return (
    <Annotation kind="unreadable">
      a value this version of Pinchy cannot show — deny, then ask the agent again
    </Annotation>
  );
}

/** A summary string, or a value said to be one, as the card can show it. */
function StoredText({ value }: { value: unknown }) {
  const shown = readShown(value);
  return shown === null ? <Unreadable /> : <TextValue shown={shown} />;
}

function Note({ note }: { note: SummaryNote }) {
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
          name <TextValue shown={note.name} />
        </Annotation>
      );
    case "not-a-domain":
      return <Annotation kind="not-a-domain">not a valid domain name</Annotation>;
  }
}

/** A value the summary annotated, or previewed (`SummaryNode`). */
function NodeValue({ node }: { node: SummaryNode }) {
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
    case "previewed":
      return <TextValue shown={node} />;
    case "noted":
      return (
        <span>
          <TextValue shown={node.text} />
          {node.notes.map((note, index) => (
            <Note key={index} note={note} />
          ))}
        </span>
      );
  }
}

/**
 * An empty list or object, drawn as the prompt prints it — `[]`, `{}` — and
 * read in words, so `values: []` and `values: {}` are two cards; and a string
 * can't draw either, since `"[]"` reads as a literal and is drawn quoted
 * (`displayScalar`).
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
function ArgValue({ value }: { value: unknown }) {
  if (typeof value === "string") return <StoredText value={value} />;
  const node = readNode(value);
  if (node === "unreadable") return <Unreadable />;
  if (node) return <NodeValue node={node} />;
  if (Array.isArray(value)) {
    if (value.length === 0) return <Empty list />;
    return (
      <ul className="list-disc space-y-0.5 pl-4">
        {value.map((item, index) => (
          <li key={index}>
            <ArgValue value={item} />
          </li>
        ))}
      </ul>
    );
  }
  if (value !== null && typeof value === "object") {
    return <ArgFields fields={value as Record<string, unknown>} />;
  }
  return <span className="font-mono">{displayScalar(value)}</span>;
}

/**
 * Who a call reaches and where it lands come first. The summary renders them
 * first too, but Postgres stores a jsonb object with its keys re-sorted, so
 * that order does not survive the round trip — it is restored here.
 */
function ArgFields({ fields }: { fields: Record<string, unknown> }) {
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
            <ArgValue value={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * How long Approve and Deny stay in one place on screen before they act.
 * A pointer or a finger rests where the person aimed it, and a button can
 * arrive under it: in the corner the stack is anchored to the bottom, so a
 * card that opens grows upward and its Approve lands on the pixels its Review
 * button just held, and a card below the open one that leaves — expired, or
 * answered in another tab — drops the open card onto that card's Review; in
 * the thread a card arriving above pushes the open one down. Whatever moved
 * them, the click aimed at what was there must not approve. Operating systems
 * take two clicks up to 500 ms apart as a double click by default.
 */
export const ARM_MS = 1000;

/**
 * Whether `element` has stayed where it is on screen for `ARM_MS`, as state
 * for drawing, and as a check to make at the moment it is pressed. The
 * position is read every frame rather than worked out from what might move
 * it, because anything can: a card leaving, one arriving, a scroll, a resize.
 * The check reads it once more, so a press in the same frame as a move — before
 * any frame has seen it — still finds it moved.
 */
function useStill(element: RefObject<HTMLElement | null>): [boolean, () => boolean] {
  const [still, setStill] = useState(false);
  // Where the element was last seen, and since when it has been there.
  const seen = useRef<{ at: string; since: number } | null>(null);

  const check = useCallback(() => {
    const box = element.current?.getBoundingClientRect();
    const at = box ? `${box.left} ${box.top} ${box.width} ${box.height}` : "";
    const now = performance.now();
    if (seen.current?.at !== at) seen.current = { at, since: now };
    const result = now - seen.current.since >= ARM_MS;
    setStill(result);
    return result;
  }, [element]);

  useEffect(() => {
    let frame = requestAnimationFrame(function watch() {
      check();
      frame = requestAnimationFrame(watch);
    });
    return () => cancelAnimationFrame(frame);
  }, [check]);

  return [still, check];
}

/** A closed card's Review button, which is where focus goes next. */
const REVIEW = "[data-approval-review]";

/**
 * One pending confirmation, rendered the same whether it sits in the thread
 * that raised it or in the corner (#1132). Only the container differs.
 *
 * Closed (`open={false}`), it names the agent and the tool and offers to
 * review it, and draws none of the arguments and neither Approve nor Deny:
 * the screen draws one card's arguments at a time (`openId` in
 * `use-pending-approvals`), and only the person opens one.
 */
export function ApprovalCard({
  approval,
  busy,
  onDecide,
  open = true,
  onOpen,
}: {
  approval: PendingApproval;
  busy: boolean;
  onDecide: (approval: PendingApproval, decision: "approve" | "deny") => void;
  open?: boolean;
  onOpen?: () => void;
}) {
  const detailsId = useId();
  // Focus follows a card the person opened, not one drawn open — say, the
  // open card moving from the corner into its thread when they navigate there.
  const [reviewed, setReviewed] = useState(false);
  if (!open) {
    return (
      <div className="rounded-lg border bg-background p-3 shadow-lg">
        <p className="text-sm font-medium">{approval.agentName} needs your confirmation</p>
        <div className="mt-1 flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            Run <span className="font-mono">{approval.toolName}</span>
          </p>
          <Button
            size="sm"
            variant="outline"
            aria-label={`Review the request to run ${approval.toolName} for ${approval.agentName}`}
            aria-expanded={false}
            aria-controls={detailsId}
            data-approval-review=""
            onClick={() => {
              setReviewed(true);
              onOpen?.();
            }}
          >
            Review
          </Button>
        </div>
      </div>
    );
  }
  return (
    <OpenCard
      approval={approval}
      busy={busy}
      onDecide={onDecide}
      detailsId={detailsId}
      takeFocus={reviewed}
    />
  );
}

/**
 * The open card: its details, and Approve and Deny once those have stayed in
 * one place for `ARM_MS` (`useStill`). Mounted afresh each time the card
 * opens, so every opening waits again, and every move waits again too.
 *
 * While they wait, the two buttons stay in the tab order — disabled, they
 * would drop out of it, and a Tab right after Review would land on the next
 * card's Review — and say they will be available in a moment. The note keeps
 * its place when it is hidden: if it took its line with it, the buttons would
 * move, and wait again.
 */
function OpenCard({
  approval,
  busy,
  onDecide,
  detailsId,
  takeFocus,
}: {
  approval: PendingApproval;
  busy: boolean;
  onDecide: (approval: PendingApproval, decision: "approve" | "deny") => void;
  detailsId: string;
  takeFocus: boolean;
}) {
  const hasArgs = approval.argsSummary && Object.keys(approval.argsSummary).length > 0;
  const card = useRef<HTMLDivElement>(null);
  const details = useRef<HTMLDivElement>(null);
  const buttons = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const [armed, stillNow] = useStill(buttons);
  const decide = (decision: "approve" | "deny") => {
    if (!busy && stillNow()) onDecide(approval, decision);
  };
  const waiting = {
    size: "sm",
    className: "aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
    "aria-disabled": busy || !armed || undefined,
    "aria-describedby": armed ? undefined : hintId,
  } as const;

  // Review unmounts with the closed card, so the focus it held moves to what
  // it opened instead of falling to the page.
  useEffect(() => {
    if (takeFocus) details.current?.focus();
  }, [takeFocus]);

  // The card leaves once decided — here or in another tab — and with it the
  // focus on its button, if it was there. Hand it to the next card's Review,
  // in this list first, rather than to the page. Layout cleanup runs while
  // the card is still in the document, so it can still see where focus is.
  useLayoutEffect(() => {
    const root = card.current;
    return () => {
      const focused = document.activeElement;
      if (focused && focused !== document.body && !root?.contains(focused)) return;
      const list = root?.closest("[role=region]");
      const next =
        list?.querySelector<HTMLElement>(REVIEW) ?? document.querySelector<HTMLElement>(REVIEW);
      next?.focus();
    };
  }, []);

  return (
    <div ref={card} className="rounded-lg border bg-background p-3 shadow-lg">
      <p className="text-sm font-medium">{approval.agentName} needs your confirmation</p>
      <div
        ref={details}
        id={detailsId}
        role="group"
        aria-label={`Request to run ${approval.toolName} for ${approval.agentName}`}
        tabIndex={-1}
        className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <p className="mt-1 text-sm text-muted-foreground">
          Run <span className="font-mono">{approval.toolName}</span>
          {hasArgs ? " with:" : "?"}
        </p>
        {hasArgs ? (
          <div className="mt-2 max-h-64 overflow-y-auto rounded-md bg-muted/50 p-2 text-sm">
            <ArgFields fields={approval.argsSummary as Record<string, unknown>} />
          </div>
        ) : null}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <p
          id={hintId}
          className="mr-auto text-xs text-muted-foreground"
          style={armed ? { visibility: "hidden" } : undefined}
        >
          Available in a moment
        </p>
        <div ref={buttons} className="flex gap-2">
          <Button variant="outline" {...waiting} onClick={() => decide("deny")}>
            Deny
          </Button>
          <Button {...waiting} onClick={() => decide("approve")}>
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}
