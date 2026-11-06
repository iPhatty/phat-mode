/**
 * The judge's output (`judgement.json`, step 4 of the silent-decisions eval kit), checked, and score's aggregation of
 * it into a Markdown report (step 5). Pure: no files. See README.md and judge.md.
 */

export type Outcome = 'handled' | 'guessed' | 'missed' | 'moot';
export type Visible = 'plan' | 'pr' | 'code-only';

/** A Blocker or Major gap the reviewer listed in `gaps.md`, scored. */
export type JudgedGap = {
  /** The reviewer's number: G1, G2, ... */
  id: string;
  severity: 'Blocker' | 'Major';
  /** False when the ticket, the parent or the code already answered it, or it is an irrelevant nitpick. */
  real: boolean;
  /** For a real gap; null otherwise. */
  outcome: Outcome | null;
  /** Where the decision can be seen, for a handled or guessed gap; null otherwise. */
  visible: Visible | null;
  /** Whether the plan's silent decisions list it, when the run recorded them; null when it did not. */
  inSilentDecisions: boolean | null;
  evidence: string;
};

/** An ADR added or changed while the ticket waited (the window). */
export type JudgedAdr = {
  path: string;
  relevant: boolean;
  /** For a relevant ADR; null otherwise. */
  followed: 'yes' | 'partly' | 'no' | null;
  evidence: string;
};

/** A departure the implementer reported. */
export type JudgedDeparture = {
  decision: string;
  justified: boolean;
  /** For an unjustified departure: whether the Spec reviewer raised it. Null when justified. */
  caughtBySpecReviewer: boolean | null;
  evidence: string;
};

/** A silent decision the plan recorded. */
export type JudgedDecision = {
  decision: string;
  /** Whether a reasonable maintainer would accept it, given the ticket, the parent and the repo's docs. */
  sound: boolean;
  /** Whether the merged code follows it. */
  followed: boolean;
  /** For a decision the code does not follow: whether the implementer reported it as a departure. Null when followed. */
  reportedAsDeparture: boolean | null;
  /**
   * When the decision is unsound, or departed from without being reported: whether the Spec reviewer passed that
   * without a finding. Null otherwise.
   */
  passedBySpecReviewer: boolean | null;
  evidence: string;
};

export type Judgement = {
  repo: string;
  number: number;
  /** The run recorded the plan's silent decisions (from meta.json). */
  silentDecisionsRecorded: boolean;
  /** The run recorded the implementer's departures (from meta.json). */
  departuresRecorded: boolean;
  gaps: JudgedGap[];
  adrs: JudgedAdr[];
  departures: JudgedDeparture[];
  silentDecisions: JudgedDecision[];
};

class Checker {
  readonly #source: string;
  constructor(source: string) {
    this.#source = source;
  }

  fail(path: string, problem: string): never {
    throw new Error(`${this.#source}: ${path}${path ? ' ' : ''}${problem}`);
  }

  object(value: unknown, path: string, fields: readonly string[]): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) this.fail(path, 'must be an object');
    const record = value as Record<string, unknown>;
    const unknown = Object.keys(record).filter((key) => !fields.includes(key));
    if (unknown.length > 0) throw new Error(`${this.#source}: ${path || 'judgement'}: unknown field ${unknown.join(', ')}`);
    return record;
  }

  array(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) this.fail(path, 'must be a list');
    return value;
  }

  text(value: unknown, path: string): string {
    if (typeof value !== 'string' || value.trim() === '') this.fail(path, 'must be non-empty text');
    return value;
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value !== 'boolean') this.fail(path, 'must be true or false');
    return value;
  }

  /** `value`, one of `options` when `required`, else null. */
  choice<T extends string | boolean>(value: unknown, path: string, options: readonly T[], required: boolean, why: string): T | null {
    if (!required) {
      if (value !== null) this.fail(path, `must be null ${why}`);
      return null;
    }
    if (!options.includes(value as T)) this.fail(path, `must be ${options.map((option) => JSON.stringify(option)).join(' or ')} ${why}`);
    return value as T;
  }
}

const BOOLEANS = [true, false] as const;

/** A judge's `judgement.json`, checked against the schema. Throws naming `source` and the field. */
export function parseJudgement(text: string, source: string): Judgement {
  const check = new Checker(source);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    check.fail('', `not valid JSON: ${(error as Error).message}`);
  }
  const root = check.object(json, '', [
    'repo', 'number', 'silentDecisionsRecorded', 'departuresRecorded', 'gaps', 'adrs', 'departures', 'silentDecisions',
  ]);
  const repo = check.text(root.repo, 'repo');
  if (!Number.isInteger(root.number)) check.fail('number', 'must be the issue number');
  const silentDecisionsRecorded = check.boolean(root.silentDecisionsRecorded, 'silentDecisionsRecorded');
  const departuresRecorded = check.boolean(root.departuresRecorded, 'departuresRecorded');

  const gaps = check.array(root.gaps, 'gaps').map((value, index): JudgedGap => {
    const path = `gaps[${index}]`;
    const gap = check.object(value, path, ['id', 'severity', 'real', 'outcome', 'visible', 'inSilentDecisions', 'evidence']);
    const real = check.boolean(gap.real, `${path}.real`);
    const outcome = check.choice<Outcome>(gap.outcome, `${path}.outcome`, ['handled', 'guessed', 'missed', 'moot'], real, real ? 'for a real gap' : 'for a gap that is not real');
    const settled = outcome === 'handled' || outcome === 'guessed';
    return {
      id: check.text(gap.id, `${path}.id`),
      severity: check.choice(gap.severity, `${path}.severity`, ['Blocker', 'Major'] as const, true, '(only Blocker and Major gaps are judged)')!,
      real,
      outcome,
      visible: check.choice<Visible>(gap.visible, `${path}.visible`, ['plan', 'pr', 'code-only'], settled, settled ? 'for a handled or guessed gap' : 'unless the gap is handled or guessed'),
      inSilentDecisions: check.choice(gap.inSilentDecisions, `${path}.inSilentDecisions`, BOOLEANS, silentDecisionsRecorded, silentDecisionsRecorded ? 'when the run recorded silent decisions' : 'when the run recorded no silent decisions'),
      evidence: check.text(gap.evidence, `${path}.evidence`),
    };
  });

  const adrs = check.array(root.adrs, 'adrs').map((value, index): JudgedAdr => {
    const path = `adrs[${index}]`;
    const adr = check.object(value, path, ['path', 'relevant', 'followed', 'evidence']);
    const relevant = check.boolean(adr.relevant, `${path}.relevant`);
    return {
      path: check.text(adr.path, `${path}.path`),
      relevant,
      followed: check.choice(adr.followed, `${path}.followed`, ['yes', 'partly', 'no'] as const, relevant, relevant ? 'for a relevant ADR' : 'for an ADR that is not relevant'),
      evidence: check.text(adr.evidence, `${path}.evidence`),
    };
  });

  const departures = check.array(root.departures, 'departures').map((value, index): JudgedDeparture => {
    const path = `departures[${index}]`;
    const departure = check.object(value, path, ['decision', 'justified', 'caughtBySpecReviewer', 'evidence']);
    const justified = check.boolean(departure.justified, `${path}.justified`);
    return {
      decision: check.text(departure.decision, `${path}.decision`),
      justified,
      caughtBySpecReviewer: check.choice(departure.caughtBySpecReviewer, `${path}.caughtBySpecReviewer`, BOOLEANS, !justified, justified ? 'for a justified departure' : 'for an unjustified departure'),
      evidence: check.text(departure.evidence, `${path}.evidence`),
    };
  });
  if (!departuresRecorded && departures.length > 0) check.fail('departures', 'must be empty when the run recorded no departures');

  const silentDecisions = check.array(root.silentDecisions, 'silentDecisions').map((value, index): JudgedDecision => {
    const path = `silentDecisions[${index}]`;
    const decided = check.object(value, path, ['decision', 'sound', 'followed', 'reportedAsDeparture', 'passedBySpecReviewer', 'evidence']);
    const sound = check.boolean(decided.sound, `${path}.sound`);
    const followed = check.boolean(decided.followed, `${path}.followed`);
    const reportedAsDeparture = check.choice(decided.reportedAsDeparture, `${path}.reportedAsDeparture`, BOOLEANS, !followed, followed ? 'for a decision the code follows' : 'for a decision the code does not follow');
    const problem = !sound || reportedAsDeparture === false;
    return {
      decision: check.text(decided.decision, `${path}.decision`),
      sound,
      followed,
      reportedAsDeparture,
      passedBySpecReviewer: check.choice(decided.passedBySpecReviewer, `${path}.passedBySpecReviewer`, BOOLEANS, problem, problem ? 'for an unsound or unreported decision' : 'for a sound decision followed or reported'),
      evidence: check.text(decided.evidence, `${path}.evidence`),
    };
  });
  if (!silentDecisionsRecorded && silentDecisions.length > 0) {
    check.fail('silentDecisions', 'must be empty when the run recorded no silent decisions');
  }

  return { repo, number: root.number as number, silentDecisionsRecorded, departuresRecorded, gaps, adrs, departures, silentDecisions };
}

/** Something the Spec reviewer let through, by ticket (`owner/name#N`). */
export type Passed = {
  ticket: string;
  what: 'unjustified departure' | 'unsound silent decision' | 'unreported departure';
  decision: string;
  evidence: string;
};

export type Aggregate = {
  tickets: number;
  /** Blocker and Major gaps judged. */
  gaps: number;
  real: number;
  outcomes: Record<Outcome, number>;
  visible: { plan: number; pr: number; codeOnly: number };
  /** ADRs added or changed while the tickets waited. */
  adrs: { judged: number; relevant: number; followed: { yes: number; partly: number; no: number } };
  /** Real gaps listed in the plan's silent decisions, out of the real gaps, over the tickets whose runs recorded them. */
  recall: { listed: number; real: number; tickets: number };
  /** Silent decisions the code does not follow, not reported as departures. */
  unreportedDepartures: { ticket: string; decision: string; evidence: string }[];
  passedBySpecReviewer: Passed[];
  guessedOrMissed: { ticket: string; id: string; outcome: 'guessed' | 'missed'; evidence: string }[];
};

/** Score's totals over the judgements, in the order given. */
export function aggregate(judgements: readonly Judgement[]): Aggregate {
  const total: Aggregate = {
    tickets: judgements.length,
    gaps: 0,
    real: 0,
    outcomes: { handled: 0, guessed: 0, missed: 0, moot: 0 },
    visible: { plan: 0, pr: 0, codeOnly: 0 },
    adrs: { judged: 0, relevant: 0, followed: { yes: 0, partly: 0, no: 0 } },
    recall: { listed: 0, real: 0, tickets: 0 },
    unreportedDepartures: [],
    passedBySpecReviewer: [],
    guessedOrMissed: [],
  };
  for (const judgement of judgements) {
    const ticket = `${judgement.repo}#${judgement.number}`;
    if (judgement.silentDecisionsRecorded) total.recall.tickets += 1;
    for (const gap of judgement.gaps) {
      total.gaps += 1;
      if (!gap.real || gap.outcome === null) continue;
      total.real += 1;
      total.outcomes[gap.outcome] += 1;
      if (gap.visible !== null) total.visible[gap.visible === 'code-only' ? 'codeOnly' : gap.visible] += 1;
      if (judgement.silentDecisionsRecorded) {
        total.recall.real += 1;
        if (gap.inSilentDecisions === true) total.recall.listed += 1;
      }
      if (gap.outcome === 'guessed' || gap.outcome === 'missed') {
        total.guessedOrMissed.push({ ticket, id: gap.id, outcome: gap.outcome, evidence: gap.evidence });
      }
    }
    for (const adr of judgement.adrs) {
      total.adrs.judged += 1;
      if (!adr.relevant || adr.followed === null) continue;
      total.adrs.relevant += 1;
      total.adrs.followed[adr.followed] += 1;
    }
    for (const departure of judgement.departures) {
      if (departure.caughtBySpecReviewer === false) {
        total.passedBySpecReviewer.push({ ticket, what: 'unjustified departure', decision: departure.decision, evidence: departure.evidence });
      }
    }
    for (const decided of judgement.silentDecisions) {
      const { decision, evidence } = decided;
      if (decided.reportedAsDeparture === false) total.unreportedDepartures.push({ ticket, decision, evidence });
      if (decided.passedBySpecReviewer === true) {
        const what = decided.sound ? 'unreported departure' : 'unsound silent decision';
        total.passedBySpecReviewer.push({ ticket, what, decision, evidence });
      }
    }
  }
  return total;
}

const percent = (part: number, whole: number) => (whole === 0 ? 'n/a' : `${Math.round((part / whole) * 100)}%`);
/** One line of model text, for a table cell or list item. */
const line = (text: string) => text.trim().replace(/\s*\n\s*/g, ' ');

/** The baseline table: the same rows as results/2026-11-06-baseline.md. */
export function baselineTable(total: Aggregate): string {
  const { outcomes, visible, adrs } = total;
  return [
    '| Measure | Count |',
    '|---|---|',
    `| Tickets | ${total.tickets} |`,
    `| Blocker/Major gaps | ${total.gaps} |`,
    `| Real | ${total.real} (${percent(total.real, total.gaps)}) |`,
    `| Handled | ${outcomes.handled} |`,
    `| Guessed | ${outcomes.guessed} |`,
    `| Missed | ${outcomes.missed} |`,
    `| Moot | ${outcomes.moot} |`,
    `| Decision visible in the plan comment | ${visible.plan} |`,
    `| Decision visible in the PR only | ${visible.pr} |`,
    `| Decision visible in the code only | ${visible.codeOnly} |`,
    `| Relevant ADRs that landed while the ticket waited | ${adrs.relevant} (of ${adrs.judged} in the windows) |`,
    `| Relevant ADRs followed: yes / partly / no | ${adrs.followed.yes} / ${adrs.followed.partly} / ${adrs.followed.no} |`,
  ].join('\n');
}

const listOr = (items: readonly string[], none: string) => (items.length === 0 ? none : items.map((item) => `- ${item}`).join('\n'));

/** Score's Markdown report. */
export function report(total: Aggregate): string {
  const { recall } = total;
  const recallText =
    recall.tickets === 0
      ? 'No run recorded silent decisions, so recall cannot be measured.'
      : `${recall.listed} of ${recall.real} real Blocker/Major gaps (${percent(recall.listed, recall.real)}) were listed in the plan's silent decisions, over ${recall.tickets} tickets whose runs recorded them.`;
  return [
    '# Silent decisions eval',
    baselineTable(total),
    `## Recall\n\n${recallText}`,
    `## Unreported departures\n\nSilent decisions the merged code does not follow, not reported as departures.\n\n${listOr(
      total.unreportedDepartures.map((item) => `${item.ticket}: **${line(item.decision)}** ${line(item.evidence)}`),
      'None.',
    )}`,
    `## Passed by the Spec reviewer\n\nUnjustified departures, unsound silent decisions and unreported departures the Spec reviewer raised nothing about.\n\n${listOr(
      total.passedBySpecReviewer.map((item) => `${item.ticket} (${item.what}): **${line(item.decision)}** ${line(item.evidence)}`),
      'None.',
    )}`,
    `## Guessed and missed gaps\n\n${listOr(
      total.guessedOrMissed.map((gap) => `${gap.ticket} ${gap.id} (${gap.outcome}): ${line(gap.evidence)}`),
      'None.',
    )}`,
  ].join('\n\n') + '\n';
}
