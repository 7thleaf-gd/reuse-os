import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeVisionAnnotation,
  suggestVisionQuery,
  buildVisionQueryCandidates
} from "../src/vision.js";

test("Vision normalization keeps best guesses, entities, OCR and logos", () => {
  const result = normalizeVisionAnnotation({
    webDetection: {
      bestGuessLabels: [{ label: "Pampas Field Ass Kickers Light" }],
      webEntities: [
        { description: "Pampas Field Ass Kickers", score: 0.92 },
        { description: "Light!", score: 0.88 }
      ],
      pagesWithMatchingImages: [
        { url: "https://example.test/page", pageTitle: "Example" }
      ]
    },
    fullTextAnnotation: {
      text: "PAMPAS FIELD ASS KICKERS\nLIGHT!\nSLR-001"
    },
    logoAnnotations: [{ description: "Seventh Leaf Records", score: 0.7 }]
  });

  assert.deepEqual(result.best_guess_labels, ["Pampas Field Ass Kickers Light"]);
  assert.equal(result.web_entities[0].description, "Pampas Field Ass Kickers");
  assert.equal(result.ocr_lines[2], "SLR-001");
  assert.equal(result.logos[0].description, "Seventh Leaf Records");
  assert.equal(result.matching_pages[0].url, "https://example.test/page");
});

test("Vision query suggestion prefers combined identity signals", () => {
  assert.equal(
    suggestVisionQuery({
      best_guess_labels: ["Artist Album"],
      web_entities: [{ description: "Artist", score: 1 }],
      ocr_lines: ["Artist", "Album"]
    }),
    "Artist Album"
  );

  assert.equal(
    suggestVisionQuery({
      best_guess_labels: [],
      web_entities: [
        { description: "Artist", score: 0.9 },
        { description: "Album", score: 0.8 }
      ],
      ocr_lines: []
    }),
    "Artist Album"
  );

  assert.equal(
    suggestVisionQuery({
      best_guess_labels: [],
      web_entities: [],
      ocr_lines: ["ARTIST", "ALBUM", "CAT-001"]
    }),
    "ARTIST ALBUM CAT-001"
  );
});


test("Vision candidates avoid generic best guess when stronger identity exists", () => {
  const candidates = buildVisionQueryCandidates({
    best_guess_labels: ["Still Life"],
    web_entities: [
      { description: "Van Der Graaf Generator", score: 0.91 },
      { description: "Still Life", score: 0.88 }
    ],
    ocr_lines: ["VAN DER GRAAF GENERATOR", "STILL LIFE", "CAS 1116"],
    matching_pages: [
      { page_title: "Van Der Graaf Generator - Still Life | Discogs", url: "https://www.discogs.com/release/1" }
    ]
  });

  assert.equal(candidates[0], "Van Der Graaf Generator - Still Life");
  assert.ok(candidates.some((q) => /Van Der Graaf Generator.*Still Life/i.test(q)));
  assert.notEqual(candidates[0], "Still Life");
});

test("Vision candidates combine artist-like OCR with generic visual guess", () => {
  const candidates = buildVisionQueryCandidates({
    best_guess_labels: ["Still Life"],
    web_entities: [],
    ocr_lines: ["OPETH", "STILL LIFE", "CDVILED183X"],
    matching_pages: []
  });

  assert.equal(candidates[0], "OPETH Still Life");
});
