import test from 'node:test';
import assert from 'node:assert/strict';
import { compareEventHeadlines, findEventDuplicate } from '../lib/general-event-duplicate.mjs';
const date = '2026-09-30T08:00:00Z';
const row = (title, hours = 0, extra = {}) => ({title, publishedAt: new Date(Date.parse(date) + hours * 3600000).toISOString(), ...extra});

test('different sources with closely reworded same-event headline are guarded', () => {
  const a = row('Trump says tech firms signed AI self-regulation accord');
  const b = row('Tech companies signed AI self-policing accord Trump says', 2);
  assert.equal(compareEventHeadlines(a, b)?.status, 'duplicate');
});
test('request versus subsequent signed agreement remains separate', () => {
  const a = row('Trump asks tech firms to self-regulate AI development');
  const b = row('Trump says tech firms signed self-regulation AI accord', 2);
  assert.equal(compareEventHeadlines(a, b), null);
});
test('a guest list is not automatically conflated with the meeting itself', () => {
  const a = row('Who Attended Trump’s AI Luncheon, and Who Sat Where');
  const b = row('Trump Hosts A.I. Executives at the White House', 1);
  assert.equal(compareEventHeadlines(a, b), null);
});
test('shared AI subject alone cannot block different developments', () => {
  const a = row('Meta launches its AI glasses at developer event');
  const b = row('Microsoft signs AI safety research deal with universities', 1);
  assert.equal(compareEventHeadlines(a, b), null);
});
test('same names with opposite court developments remain separate', () => {
  const a = row('Appeals court blocks company merger after federal lawsuit');
  const b = row('Appeals court reverses block on company merger after lawsuit', 1);
  assert.equal(compareEventHeadlines(a, b), null);
});
test('different numerical figures are not silently conflated', () => {
  const a = row('Company announces 4 billion investment at Michigan facility');
  const b = row('Company announces 9 billion investment at Michigan facility', 1);
  assert.equal(compareEventHeadlines(a, b), null);
});
test('old event outside 96 hours is not blocked by lexical similarity', () => {
  const a = row('Trump says tech firms signed AI self-regulation accord');
  const b = row('Tech companies signed AI self-policing accord Trump says', 120);
  assert.equal(compareEventHeadlines(a, b), null);
});
test('a close but imperfect headline match is held for review', () => {
  const a = row('Senate committee approves new national rail safety bill');
  const b = row('Senate committee approves rail safety bill after months of hearings', 1);
  assert.equal(compareEventHeadlines(a, b)?.status, 'review');
});
test('finding best result prefers duplicate to review', () => {
  const candidate = row('Trump says tech firms signed AI self-regulation accord');
  const older = [
    row('Trump says tech firms signed self-regulation AI accord after talks', 1),
    row('Tech companies signed AI self-policing accord Trump says', 2),
  ];
  assert.equal(findEventDuplicate(candidate, older)?.status, 'duplicate');
});
test('missing titles never produce a false match', () => {
  assert.equal(compareEventHeadlines({}, row('Something happened')), null);
});
