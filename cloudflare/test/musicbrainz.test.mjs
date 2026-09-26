import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMusicBrainzQuery,
  normalizeMusicBrainzRelease
} from "../src/musicbrainz.js";

test("MusicBrainz Hunter search uses exact barcode when present", () => {
  const q = buildMusicBrainzQuery("4988000000000");
  assert.equal(q.kind, "barcode");
  assert.equal(q.barcode, "4988000000000");
  assert.equal(q.query, 'barcode:"4988000000000"');
});

test("MusicBrainz Hunter search spans artist and release fields", () => {
  const q = buildMusicBrainzQuery("Pampas Field Ass Kickers");
  assert.equal(q.kind, "text");
  assert.match(q.query, /artist:"Pampas Field Ass Kickers"/);
  assert.match(q.query, /release:"Pampas Field Ass Kickers"/);
});

test("MusicBrainz catalog-like query also targets catno", () => {
  const q = buildMusicBrainzQuery("SLR-001");
  assert.equal(q.kind, "catalog");
  assert.match(q.query, /catno:"SLR\\-001"/);
});

test("MusicBrainz release normalization yields Hunter-compatible item", () => {
  const item = normalizeMusicBrainzRelease({
    id: "383be31c-37a0-4e08-8cda-cbcbbc587ae5",
    score: 100,
    title: "Light!",
    date: "2012",
    country: "JP",
    barcode: "4988000000000",
    "artist-credit": [{
      name: "Pampas Field Ass Kickers",
      artist: { name: "Pampas Field Ass Kickers" }
    }],
    "label-info": [{
      "catalog-number": "SLR-001",
      label: { name: "Seventh Leaf Records" }
    }],
    media: [{ format: "CD" }],
    "release-group": { "primary-type": "EP" }
  });

  assert.equal(item.provider, "MUSICBRAINZ");
  assert.equal(item.title, "Pampas Field Ass Kickers - Light!");
  assert.equal(item.catno, "SLR-001");
  assert.equal(item.format, "CD");
  assert.equal(item.score, 100);
  assert.match(item.uri, /musicbrainz\.org\/release\/383be31c/);
});
