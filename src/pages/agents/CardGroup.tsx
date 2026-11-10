import { useState } from "react";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { Button, RelativeTime, Tag } from "../../ui";
import { agentsApi, type Proposal } from "./api";
import { ProposalCard } from "./ProposalCard";

/*
 * Cards that say the same thing, under one head (sweep 2026-11-10). An agent on a schedule leaves
 * the same "needs you to look" card on every run until someone answers it: the owner's server
 * showed 28 look-alikes, each with its own Done. Cards from one agent, of one kind, with the same
 * title and reason are drawn as one row that says how many and how recent, opens to the cards
 * themselves, and can be answered together.
 *
 * Only cards with nothing to run are grouped. A plan's steps are each staged and approved by a
 * person, and two plans that read alike may still carry different parameters: every plan stays its
 * own card.
 */

export interface CardGroupOf { key: string; cards: Proposal[] }

/** Whether a card is only words: a question or an escalation with no step to stage. */
const onlyWords = (proposal: Proposal) => (proposal.kind ?? "plan") !== "plan" && proposal.steps.length === 0;

/** Open cards in the order given, those that share agent, kind, title and reason gathered where the first of them stood. */
export function groupCards(open: Proposal[]): CardGroupOf[] {
  const groups: CardGroupOf[] = [];
  const byKey = new Map<string, CardGroupOf>();
  for (const proposal of open) {
    if (!onlyWords(proposal)) { groups.push({ key: proposal.id, cards: [proposal] }); continue; }
    const key = JSON.stringify([proposal.source, proposal.agentId ?? proposal.agentName, proposal.kind, proposal.title, proposal.reason, proposal.question ?? ""]);
    const held = byKey.get(key);
    if (held) { held.cards.push(proposal); continue; }
    const group = { key, cards: [proposal] };
    byKey.set(key, group);
    groups.push(group);
  }
  return groups;
}

const kindWords = { plan: "plan", question: "question", escalation: "needs you" } as const;

export interface CardGroupProps {
  cards: Proposal[];
  csrfToken: string;
  role: string;
  now: number;
  onStage: (operation: PendingOperation) => void;
  onDecided: (proposal: Proposal) => void;
  onOpenRun?: (agentId: string, runId: string) => void;
  /** How many of "Mark all done" the server refused: the list says it, since this head goes once one card is left. */
  onAllDone: (failed: number) => void;
}

/** Several cards that read alike: one head, the cards under it when opened, and one answer for them all. */
export function CardGroup({ cards, csrfToken, role, now, onStage, onDecided, onOpenRun, onAllDone }: CardGroupProps) {
  const [shown, setShown] = useState(false);
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const first = cards[0];
  const kind = first.kind ?? "plan";
  const newest = cards.reduce((latest, card) => (Date.parse(card.createdAt) > Date.parse(latest) ? card.createdAt : latest), first.createdAt);
  const count = cards.length;

  /** One at a time: each card is its own request, and a card that would not change is counted, not hidden. */
  const doneWithAll = async () => {
    const batch = [...cards];
    let refused = 0;
    onAllDone(0);
    setProgress({ done: 0, of: batch.length });
    for (const [index, card] of batch.entries()) {
      try {
        onDecided(await agentsApi.decide(csrfToken, card.id, "dismissed"));
      } catch {
        refused += 1;
      }
      setProgress({ done: index + 1, of: batch.length });
    }
    setProgress(null);
    onAllDone(refused);
  };

  return (
    <section className="agents-cardgroup" aria-label={`${count} cards: ${first.title}`}>
      <header className="agents-cardgroup__head">
        <Tag tone={kind === "question" ? "info" : "warning"}>{kindWords[kind]}</Tag>
        <h3 className="agents-card__title">{first.title}</h3>
        <span className="agents-card__from">{first.source === "runtime" ? "from BoxPilot" : `from ${first.agentName}`}</span>
        <span className="agents-cardgroup__count"><b>{count}</b> cards, newest <RelativeTime at={newest} now={now} fallback="just now" /></span>
      </header>
      <p className="agents-card__reason">{first.reason}</p>
      <footer className="agents-cardgroup__foot">
        <Button variant="ghost" aria-expanded={shown} onClick={() => setShown((value) => !value)}>{shown ? "Hide the cards" : `Show all ${count}`}</Button>
        <Button busy={progress !== null} onClick={() => void doneWithAll()}>
          {progress ? `Marking done, ${progress.done} of ${progress.of}` : `Mark all ${count} done`}
        </Button>
      </footer>
      {shown && (
        <div className="agents-cardgroup__cards">
          {cards.map((card) => <ProposalCard key={card.id} proposal={card} csrfToken={csrfToken} role={role} now={now} onStage={onStage} onDecided={onDecided} onOpenRun={onOpenRun} />)}
        </div>
      )}
    </section>
  );
}
