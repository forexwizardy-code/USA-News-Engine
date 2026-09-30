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
