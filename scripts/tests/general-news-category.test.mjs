import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGeneralNewsCategory as classify } from '../lib/general-news-category.mjs';

const samples = [
  ['LA mayor candidates set for forum as city struggles with homelessness, Hollywood job losses', 'Film and entertainment jobs are a part of the discussion.', 'entertainment', 'politics'],
  ['WATCH: Schmitt suggests Jack Smith perjured himself about a basketball game, but mixes up 2 teams', 'Senate questioning', 'sports', 'politics'],
  ['Eric Schmitt seems to confuse basketball teams in attempt to link Jack Smith, Fani Willis', '', 'sports', 'politics'],
  ['The U.S. is pulling its last troops out of Iraq. How will it affect the Middle East', 'Regional military withdrawal.', 'technology', 'politics'],
  ["Negotiator of 2015 Iran nuclear deal discusses Trump rejecting Iran's latest proposal", '', 'technology', 'politics'],
  ["Self-regulation 'not enough' for AI safety, Gary Marcus says", '', 'business', 'technology'],
  ['Cruz blocks push by Democrats to unanimously pass AI safety bill', '', 'technology', 'politics'],
  ['Can a chatbot fix the government maze? The White House is about to find out', '', 'us', 'technology'],
  ['Trump says top tech firms have signed accord to self-police AI development', '', 'politics', 'technology'],
  ['Who Attended Trump’s AI Luncheon, and Who Sat Where', '', 'entertainment', 'technology'],
  ['OpenAI DevDay 2026: biggest news and announcements', '', 'technology', 'technology'],
  ['Wizards’ big three aims to change the narrative as training camp commences', '', 'sports', 'sports'],
  ["Here’s What Fans Paid for Harry Styles Tickets at M.S.G.", '', 'entertainment', 'entertainment'],
  ['U.S. and China release product lists for tariff cuts after Trump-Xi meeting', '', 'us', 'business'],
  ['Travel plans? Here is what to know as measles exposures reach trains and games', '', 'sports', 'us'],
  ['British men released on bail after suspected terror plot', '', 'entertainment', 'us'],
  ['Carnegie Mellon nets $3 billion gift, most ever given to a university', '', 'us', 'us'],
  ['NBA playoffs begin this weekend', 'Senator attends a basketball game.', 'sports', 'sports'],
  ['New film wins Oscar for best picture', 'The prime minister sent congratulations.', 'entertainment', 'entertainment'],
  ['Court blocks administration effort to withhold federal grants', '', 'us', 'politics'],
  ['Company reports quarterly earnings and revenue', 'Administration comments on stock market.', 'business', 'business'],
  ['Hollywood actor announces starring role in upcoming movie', '', 'us', 'entertainment'],
  ['Oscars ceremony reveals new film nominees', '', 'us', 'entertainment'],
  ['Celebrity walks the red carpet at Los Angeles premiere', '', 'us', 'entertainment'],
  ['Actor announces new television series on streaming service', '', 'us', 'entertainment'],
  ['LA mayor candidates debate Hollywood job losses', '', 'entertainment', 'politics'],
  ['Unknown topic', 'A single incidental tech mention.', 'sports', 'sports'],
  ['', '', 'entertainment', 'entertainment'],
];
for (const [title, desc, source, expected] of samples) {
  test(`${title || '(untitled)'} -> ${expected}`, () => assert.equal(classify(title, desc, source), expected));
}

test('Raskin / Schmitt / Jack Smith hearing criticism is politics even with basketball reference', () => {
  const h = 'Raskin rips Schmitt questioning of Jack Smith: He is basically disgraced himself';
  const d = 'Rep. Raskin criticised Sen. Eric Schmitt at a hearing over a basketball-team mix-up.';
  assert.equal(classify(h, d, 'sports'), 'politics');
});
