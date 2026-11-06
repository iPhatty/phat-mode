import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { aggregate, type Judgement, parseJudgement, report } from '../judgement.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'judgements');
const fixtureText = (ticket: string) => readFile(join(FIXTURES, ticket, 'judgement.json'), 'utf8');

/** The fixture judgement of o/r#1, with `change` applied to its parsed JSON, as text again. */
async function changed(change: (json: any) => void): Promise<string> {
  const json = JSON.parse(await fixtureText('o__r-1'));
  change(json);
  return JSON.stringify(json);
}

describe('parseJudgement', () => {
  test('accepts a judgement in the schema', async () => {
    const judgement = parseJudgement(await fixtureText('o__r-1'), 'o__r-1/judgement.json');
    assert.deepEqual([judgement.repo, judgement.number, judgement.gaps.length], ['o/r', 1, 4]);
  });

  const rejected: [string, (json: any) => void, RegExp][] = [
    ['not JSON', () => {}, /x\/judgement\.json: not valid JSON/],
    ['a Nit gap', (json) => (json.gaps[0].severity = 'Nit'), /gaps\[0\]\.severity/],
    ['an unknown outcome', (json) => (json.gaps[0].outcome = 'partly'), /gaps\[0\]\.outcome/],
    ['an outcome for a gap that is not real', (json) => (json.gaps[3].outcome = 'handled'), /gaps\[3\]\.outcome/],
    ['no visibility for a handled gap', (json) => (json.gaps[0].visible = null), /gaps\[0\]\.visible/],
    ['a visibility for a missed gap', (json) => (json.gaps[0].outcome = 'missed'), /gaps\[0\]\.visible/],
    ['inSilentDecisions missing where they were recorded', (json) => delete json.gaps[1].inSilentDecisions, /gaps\[1\]\.inSilentDecisions/],
    ['inSilentDecisions where none were recorded', (json) => (json.silentDecisionsRecorded = false), /gaps\[0\]\.inSilentDecisions/],
    ['no evidence', (json) => (json.gaps[2].evidence = ' '), /gaps\[2\]\.evidence/],
    ['a relevant ADR without followed', (json) => (json.adrs[0].followed = null), /adrs\[0\]\.followed/],
    ['an unjustified departure without caughtBySpecReviewer', (json) => (json.departures[1].caughtBySpecReviewer = null), /departures\[1\]\.caughtBySpecReviewer/],
    ['a departure not followed without reportedAsDeparture', (json) => (json.silentDecisions[1].reportedAsDeparture = null), /silentDecisions\[1\]\.reportedAsDeparture/],
    ['an unsound decision without passedBySpecReviewer', (json) => (json.silentDecisions[2].passedBySpecReviewer = null), /silentDecisions\[2\]\.passedBySpecReviewer/],
    ['an unknown field', (json) => (json.gaps[0].confidence = 'high'), /gaps\[0\]: unknown field confidence/],
  ];
  for (const [name, change, message] of rejected) {
    test(`rejects ${name}, naming the file and field`, async () => {
      const text = name === 'not JSON' ? '{' : await changed(change);
      assert.throws(() => parseJudgement(text, 'x/judgement.json'), (error: Error) => {
        assert.match(error.message, /^x\/judgement\.json: /);
        assert.match(error.message, message);
        return true;
      });
    });
  }
});

const fixtures = async (): Promise<Judgement[]> =>
  Promise.all(['o__r-1', 'o__r-2', 'o__s-5'].map(async (ticket) => parseJudgement(await fixtureText(ticket), ticket)));

describe('aggregate', () => {
  test("counts the baseline table's gaps, outcomes, visibility and ADRs over every ticket", async () => {
    const { tickets, gaps, real, outcomes, visible, adrs } = aggregate(await fixtures());
    assert.deepEqual(
      { tickets, gaps, real, outcomes, visible, adrs },
      {
        tickets: 3,
        gaps: 10,
        real: 9,
        outcomes: { handled: 5, guessed: 1, missed: 2, moot: 1 },
        visible: { plan: 4, pr: 1, codeOnly: 1 },
        adrs: { judged: 3, relevant: 2, followed: { yes: 1, partly: 1, no: 0 } },
      },
    );
  });

  test('recall counts only the runs that recorded silent decisions', async () => {
    assert.deepEqual(aggregate(await fixtures()).recall, { listed: 3, real: 6, tickets: 2 });
  });

  test('lists the silent decisions departed from without a report', async () => {
    assert.deepEqual(
      aggregate(await fixtures()).unreportedDepartures.map(({ ticket, decision }) => [ticket, decision]),
      [
        ['o/r#1', 'Log every request.'],
        ['o/s#5', 'Keep the old column.'],
      ],
    );
  });

  test('lists the unjustified departures, bad decisions and unreported departures the Spec reviewer passed', async () => {
    assert.deepEqual(
      aggregate(await fixtures()).passedBySpecReviewer.map(({ ticket, what, decision }) => [ticket, what, decision]),
      [
        ['o/r#1', 'unjustified departure', 'Retry three times.'],
        ['o/r#1', 'unsound silent decision', 'Store tokens in plain text.'],
        ['o/s#5', 'unreported departure', 'Keep the old column.'],
      ],
    );
  });

  test('lists the guessed and missed gaps', async () => {
    assert.deepEqual(
      aggregate(await fixtures()).guessedOrMissed.map(({ ticket, id, outcome }) => [ticket, id, outcome]),
      [
        ['o/r#1', 'G3', 'guessed'],
        ['o/r#2', 'G1', 'missed'],
        ['o/s#5', 'G3', 'missed'],
      ],
    );
  });
});

describe('report', () => {
  test("has the baseline table's counts", async () => {
    const markdown = report(aggregate(await fixtures()));
    for (const row of ['| Tickets | 3 |', '| Blocker/Major gaps | 10 |', '| Real | 9 (90%) |', '| Handled | 5 |', '| Guessed | 1 |', '| Missed | 2 |', '| Moot | 1 |']) {
      assert.ok(markdown.includes(row), `missing ${row} in:\n${markdown}`);
    }
  });

  test('gives recall over the runs that recorded silent decisions', async () => {
    assert.match(report(aggregate(await fixtures())), /3 of 6 real Blocker\/Major gaps \(50%\).*2 tickets/);
  });

  test('says so when no run recorded silent decisions', async () => {
    const [, old] = await fixtures();
    assert.match(report(aggregate([old!])), /No run recorded silent decisions/);
  });

  test('lists unreported departures, what the Spec reviewer passed, and the guessed and missed gaps, by ticket', async () => {
    const markdown = report(aggregate(await fixtures()));
    const section = (heading: string) => markdown.split(`## ${heading}`)[1]?.split('\n## ')[0] ?? '';
    assert.match(section('Unreported departures'), /o\/s#5.*Keep the old column\./);
    assert.match(section('Passed by the Spec reviewer'), /o\/r#1.*unjustified departure.*Retry three times\./);
    assert.match(section('Guessed and missed gaps'), /o\/r#2 G1.*missed.*Errors are swallowed\./);
  });
});
