import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGeneralPhotoContext as check } from '../lib/general-image-context.mjs';
const title = 'Raskin rips Schmitt questioning of Jack Smith: He is basically disgraced himself';

test('rejects Apollo 17 Harrison Schmitt panorama', () => {
  assert.equal(check(title, {title: 'File:An Astronauts Snapshot of the Moon.jpg', description:'Apollo 17 astronaut Jack Schmitt at Taurus-Littrow valley lunar rover'}).ok, false);
});
test('rejects Schmitt Pal Hungarian news photograph', () => {
  assert.equal(check(title, {title:'Schmitt Pál Budapest 2014',description:'Kossuth tér, Budapest'}).ok, false);
});
test('rejects photo with only Schmitt surname and no identifying context', () => {
  assert.equal(check(title, {title:'Schmitt speaking on stage'}).ok, false);
});
test('permits photo explicitly identified as Eric Schmitt', () => {
  assert.equal(check(title, {title:'Senator Eric Schmitt, official hearing image'}).ok, true);
});
test('permits photo explicitly identified as Jack Smith', () => {
  assert.equal(check(title, {title:'Jack Smith at a hearing'}).ok, true);
});
test('permits neutral courthouse or Capitol photo without namesake conflict', () => {
  assert.equal(check(title, {title:'United States Capitol building, Washington DC'}).ok, true);
});
test('does not interfere with unrelated NASA/space desk stories', () => {
  assert.equal(check('Apollo 17 crew explores Taurus-Littrow valley', {title:'Harrison Schmitt Apollo 17 lunar mission'}).ok, true);
});


test('rejects butterfly for measles coverage when strict context is enabled', () => {
  assert.equal(check(
    'Travel plans? What to know as measles exposures reach trains and games',
    { title: 'Blue pansy butterfly', description: 'Junonia orithya in Dubai desert' },
    'Measles outbreaks and exposures are affecting travelers.'
  ).ok, false);
});

test('rejects ancient Korea map for Washington Wizards basketball story', () => {
  assert.equal(check(
    'Wizards big three aims to change the narrative as training camp commences',
    { title: 'Ancient Korea Map Byeonhan.png', description: 'Map of ancient Korea' },
    'Washington Wizards veterans and a No. 1 pick begin NBA training camp.'
  ).ok, false);
});

test('rejects Cornell collection item that is not about Cornell University', () => {
  assert.equal(check(
    'New York prosecutors reopen investigation into alleged rape at Cornell University',
    { title: 'Mortier Situation du Paradise Terrestre 1700 Cornell CUL', description: 'Historic map' },
    'The investigation concerns Cornell University and a 2024 allegation.'
  ).ok, false);
});

test('rejects Marcus Mason image for Gary Marcus AI story', () => {
  assert.equal(check(
    'Self-regulation not enough for AI safety, Gary Marcus says',
    { title: 'Marcus Mason Gary Guyton', description: 'Football players on field' },
    'AI researcher Gary Marcus called for stronger safeguards.'
  ).ok, false);
});

test('rejects Darwin Australia court for U.S. Supreme Court story', () => {
  assert.equal(check(
    'Supreme Court allows third-country deportations for now',
    { title: 'Supreme Court Darwin Australia', description: 'Northern Territory courthouse' },
    'The U.S. Supreme Court acted on a Trump administration policy.'
  ).ok, false);
});

test('accepts clearly relevant Carnegie Mellon campus image in strict mode', () => {
  assert.equal(check(
    'Carnegie Mellon nets $3 billion gift',
    { title: 'Carnegie Mellon University campus', description: 'Carnegie Mellon University in Pittsburgh' },
    'The gift was made to Carnegie Mellon University.'
  ).ok, true);
});
